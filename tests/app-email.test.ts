import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { APP_EMAIL_LIMITS, clearTestEmails, listTestEmails, sendAppEmail, type AppEmailDeps } from '../apps/app/src/server/app-email.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * Emails from apps (plan part K, host side). Every email is STORED in the test
 * inbox and nothing is sent; the limits; a bad address is refused; one project
 * can't read another's inbox. LOCAL VERIFIED on the real migrations.
 */

const NOW = new Date('2026-10-22T12:00:00.000Z');

describe('emails from apps', () => {
	let sqlite: Database;
	let db: D1Database;
	let projectId: string;
	let deps: AppEmailDeps;

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		projectId = (await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Farm log', description: 'x' })).id;
		deps = { now: () => NOW };
	});

	afterEach(() => sqlite.close());

	const send = (request: unknown, mode: 'preview' | 'live' = 'preview', d: AppEmailDeps = deps) => sendAppEmail(db, d, { projectId, mode, request });
	const good = (over: Record<string, unknown> = {}) => ({ to: 'ada@example.com', subject: 'Welcome', text: 'Hello there.', ...over });

	test('an email is stored in the test inbox and nothing is ever sent', async () => {
		expect(await send(good())).toEqual({ ok: true, delivered: 'test-inbox' });
		expect(await send(good({ to: 'bo@example.com', subject: 'Receipt', text: 'Paid', template: 'receipt' }), 'live', { now: () => new Date(NOW.getTime() + 1000) })).toEqual({
			ok: true,
			delivered: 'test-inbox',
		});
		const scope = await projectScopeForUser(db, 'owner-1', projectId);
		expect(await listTestEmails(db, scope)).toEqual([
			{ to: 'bo@example.com', subject: 'Receipt', text: 'Paid', template: 'receipt', mode: 'live', createdAt: new Date(NOW.getTime() + 1000).toISOString() },
			{ to: 'ada@example.com', subject: 'Welcome', text: 'Hello there.', template: null, mode: 'preview', createdAt: NOW.toISOString() },
		]);
		// Nothing left any "sent" trace: the only record of an email is the inbox row.
		expect(sqlite.prepare('select count(*) as n from app_test_emails').get()).toEqual({ n: 2 });
		await clearTestEmails(db, projectId);
		expect(await listTestEmails(db, scope)).toEqual([]);
	});

	test('the inbox keeps the newest 50 per app', async () => {
		for (let i = 0; i < APP_EMAIL_LIMITS.inboxKeep + 5; i++) {
			const at = new Date(NOW.getTime() - (APP_EMAIL_LIMITS.inboxKeep + 5 - i) * 61 * 60_000);
			expect((await send(good({ subject: `n${i}` }), 'preview', { now: () => at })).ok).toBe(true);
		}
		const scope = await projectScopeForUser(db, 'owner-1', projectId);
		const inbox = await listTestEmails(db, scope, 100);
		expect(inbox).toHaveLength(APP_EMAIL_LIMITS.inboxKeep);
		expect(inbox[0]!.subject).toBe(`n${APP_EMAIL_LIMITS.inboxKeep + 4}`);
		expect(sqlite.prepare('select count(*) as n from app_test_emails').get()).toEqual({ n: APP_EMAIL_LIMITS.inboxKeep });
	});

	test('at most 20 emails per app per hour', async () => {
		for (let i = 0; i < APP_EMAIL_LIMITS.perAppPerHour; i++) expect((await send(good({ subject: `s${i}` }))).ok).toBe(true);
		expect(await send(good({ subject: 'one too many' }))).toMatchObject({ ok: false, reason: 'busy', message: expect.stringContaining('last hour') });
		// An hour later the window has rolled and it works again.
		const later = { now: () => new Date(NOW.getTime() + 61 * 60_000) };
		expect((await send(good({ subject: 'later' }), 'preview', later)).ok).toBe(true);
	});

	test('P2: concurrent sends at the cap never exceed the hourly limit (atomic admission)', async () => {
		// Fill to one below the cap, then fire many sends at once. A count-then-
		// insert would let several pass against the same stale count and overshoot;
		// the atomic insert admits exactly one more.
		for (let i = 0; i < APP_EMAIL_LIMITS.perAppPerHour - 1; i++) expect((await send(good({ subject: `pre${i}` }))).ok).toBe(true);
		const results = await Promise.all(Array.from({ length: 8 }, (_, i) => send(good({ subject: `race${i}` }))));
		const accepted = results.filter((r) => r.ok).length;
		expect(accepted).toBe(1); // only the one remaining slot
		// The stored inbox never exceeds the cap.
		const stored = await listTestEmails(db, await projectScopeForUser(db, 'owner-1', projectId), 100);
		expect(stored.length).toBeLessThanOrEqual(APP_EMAIL_LIMITS.perAppPerHour);
	});

	test('a bad address, a list of addresses, and oversize fields are refused before anything is stored', async () => {
		for (const request of [
			null,
			{},
			good({ to: 'not-an-email' }),
			good({ to: 'ada@example.com, bo@example.com' }),
			good({ to: 'ada@example.com; bo@example.com' }),
			good({ to: 'ada@example.com bo@example.com' }),
			good({ to: `${'a'.repeat(250)}@x.io` }),
			good({ subject: '' }),
			good({ text: '   ' }),
		]) {
			expect(await send(request)).toMatchObject({ ok: false, reason: 'invalid_request' });
		}
		expect(await send(good({ subject: 'a'.repeat(APP_EMAIL_LIMITS.maxSubject + 1) }))).toMatchObject({ ok: false, reason: 'too_long' });
		expect(await send(good({ text: 'a'.repeat(APP_EMAIL_LIMITS.maxText + 1) }))).toMatchObject({ ok: false, reason: 'too_long' });
		expect(sqlite.prepare('select count(*) as n from app_test_emails').get()).toEqual({ n: 0 });
	});

	test("one project can't read another's inbox", async () => {
		expect((await send(good())).ok).toBe(true);
		addUser(sqlite, 'owner-2', 'two@example.com');
		const ws2 = await createWorkspace(db, 'owner-2', { name: 'W2' });
		const other = (await createProject(db, await workspaceScopeForUser(db, 'owner-2', ws2.id), { workspaceId: ws2.id, name: 'Other', description: 'y' })).id;
		const scope2 = await projectScopeForUser(db, 'owner-2', other);
		expect(await listTestEmails(db, scope2)).toEqual([]);
		// And owner-2 can't get a scope for owner-1's project at all.
		await expect(projectScopeForUser(db, 'owner-2', projectId)).rejects.toThrow();
	});
});
