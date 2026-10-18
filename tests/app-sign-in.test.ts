import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { APP_SIGN_IN_LIMITS, appAuthSecret, clearTestInbox, listTestInbox, sendAppSignInCode, type AppSignInDeps } from '../apps/app/src/server/app-sign-in.ts';
import type { MailMessage, Mailer } from '../apps/app/src/server/notifications.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * Sign-in codes for apps' own users: the preview's test inbox, the live email
 * (a fake mailer — no email is sent), and the caps. LOCAL VERIFIED on the real
 * migrations; the live email provider itself is not exercised.
 */

const NOW = new Date('2026-10-18T12:00:00.000Z');

function fakeMailer(ok = true): Mailer & { sent: MailMessage[] } {
	const sent: MailMessage[] = [];
	return { name: 'resend', sent, send: async (message) => { sent.push(message); return ok ? { ok: true } : { ok: false, error: 'provider said no' }; } };
}

describe('sign-in codes for apps', () => {
	let sqlite: Database;
	let db: D1Database;
	let projectId: string;
	let deps: AppSignInDeps & { mailer: ReturnType<typeof fakeMailer> };

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		projectId = (await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Farm log', description: 'x' })).id;
		deps = { mailer: fakeMailer(), appsDomain: 'caddieapps.com', caddieOrigin: 'https://caddie.example.com', now: () => NOW };
	});

	afterEach(() => sqlite.close());

	const send = (request: unknown, mode: 'preview' | 'live' = 'preview', d: AppSignInDeps = deps) => sendAppSignInCode(db, d, { projectId, mode, request });
	const publish = (status = 'live') =>
		sqlite.prepare("insert into app_publications (projectId, slug, script, status, createdAt, updatedAt) values (?, 'farm-log', 'app-x-1', ?, ?, ?)").run(projectId, status, NOW.toISOString(), NOW.toISOString());

	test('in the preview the code lands in the test inbox and nothing is emailed; Reset test data empties it', async () => {
		expect(await send({ email: ' Ada@Example.com ', code: '123456' })).toEqual({ ok: true });
		expect(await send({ email: 'bo@example.com', code: '654321' }, 'preview', { ...deps, now: () => new Date(NOW.getTime() + 1000) })).toEqual({ ok: true });
		const scope = await projectScopeForUser(db, 'owner-1', projectId);
		expect(await listTestInbox(db, scope)).toEqual([
			{ to: 'bo@example.com', code: '654321', createdAt: new Date(NOW.getTime() + 1000).toISOString() },
			{ to: 'ada@example.com', code: '123456', createdAt: NOW.toISOString() },
		]);
		expect(deps.mailer.sent).toEqual([]);
		// The rate records never keep the address.
		expect(JSON.stringify(sqlite.prepare('select * from app_sign_in_emails').all())).not.toContain('example.com');
		await clearTestInbox(db, projectId);
		expect(await listTestInbox(db, scope)).toEqual([]);
	});

	test('the inbox keeps the newest codes only', async () => {
		for (let i = 0; i < APP_SIGN_IN_LIMITS.inboxKeep + 3; i++) {
			const at = new Date(NOW.getTime() - (APP_SIGN_IN_LIMITS.inboxKeep + 3 - i) * 61 * 60_000);
			expect(await send({ email: `p${i}@example.com`, code: String(100000 + i) }, 'preview', { ...deps, now: () => at })).toEqual({ ok: true });
		}
		const scope = await projectScopeForUser(db, 'owner-1', projectId);
		const inbox = await listTestInbox(db, scope, 100);
		expect(inbox).toHaveLength(APP_SIGN_IN_LIMITS.inboxKeep);
		expect(inbox[0]!.to).toBe(`p${APP_SIGN_IN_LIMITS.inboxKeep + 2}@example.com`);
	});

	test('codes are capped per person and per app each hour', async () => {
		for (let i = 0; i < APP_SIGN_IN_LIMITS.perPersonPerHour; i++) expect((await send({ email: 'ada@example.com', code: '111111' })).ok).toBe(true);
		expect(await send({ email: 'ada@example.com', code: '111111' })).toMatchObject({ ok: false, reason: 'busy' });
		expect((await send({ email: 'someone-else@example.com', code: '111111' })).ok).toBe(true);
		for (let i = 0; i < APP_SIGN_IN_LIMITS.perAppPerHour.preview; i++) await send({ email: `x${i}@example.com`, code: '222222' });
		expect(await send({ email: 'new@example.com', code: '333333' })).toMatchObject({ ok: false, reason: 'busy', message: expect.stringContaining('last hour') });
		const later = { ...deps, now: () => new Date(NOW.getTime() + 61 * 60_000) };
		expect((await send({ email: 'ada@example.com', code: '444444' }, 'preview', later)).ok).toBe(true);
	});

	test('a published app emails a fixed text naming its own address, only while it is live', async () => {
		expect(await send({ email: 'ada@example.com', code: '123456' }, 'live')).toMatchObject({ ok: false, reason: 'unavailable', message: "This app isn't published right now." });
		publish('live');
		expect(await send({ email: 'ada@example.com', code: '123456' }, 'live')).toEqual({ ok: true });
		expect(deps.mailer.sent).toEqual([
			{
				to: 'ada@example.com',
				subject: 'Your sign-in code for farm-log.caddieapps.com',
				textBody: [
					'Your code for farm-log.caddieapps.com is 123456',
					'',
					"It expires in 10 minutes. If you didn't try to sign in to farm-log.caddieapps.com, you can ignore this email.",
					'',
					'https://farm-log.caddieapps.com/ is an app made with Caddie.',
					'Report a problem with this app: https://caddie.example.com/report?app=farm-log',
				].join('\n'),
			},
		]);
		expect(sqlite.prepare("select mode, status from app_sign_in_emails").all()).toEqual([{ mode: 'live', status: 'sent' }]);
		// The test inbox is for previews only.
		expect(sqlite.prepare('select count(*) as n from app_test_inbox').get()).toEqual({ n: 0 });

		const failing = { ...deps, mailer: fakeMailer(false) };
		expect(await send({ email: 'bo@example.com', code: '123456' }, 'live', failing)).toMatchObject({ ok: false, reason: 'failed' });
		const noMailer: AppSignInDeps = { ...deps, mailer: { name: 'noop', send: async () => ({ ok: false, error: 'none' }) } };
		expect(await send({ email: 'bo@example.com', code: '123456' }, 'live', noMailer)).toMatchObject({ ok: false, reason: 'unavailable', message: "Sign-in emails aren't set up on this Caddie server yet." });
		sqlite.prepare("update app_publications set status = 'blocked'").run();
		expect(await send({ email: 'bo@example.com', code: '123456' }, 'live')).toMatchObject({ ok: false, reason: 'unavailable' });
	});

	test('bad requests are refused before anything is recorded', async () => {
		for (const request of [null, {}, { email: 'not-an-email', code: '123456' }, { email: 'ada@example.com', code: '12345' }, { email: 'ada@example.com', code: 'abcdef' }, { email: `${'a'.repeat(250)}@x.io`, code: '123456' }]) {
			expect(await send(request)).toMatchObject({ ok: false, reason: 'invalid_request' });
		}
		expect(sqlite.prepare('select count(*) as n from app_sign_in_emails').get()).toEqual({ n: 0 });
	});

	test("each app's sign-in secret is derived per project and mode, never stored", async () => {
		const a = await appAuthSecret('caddie-master-secret-0123456789', 'proj-a', 'preview');
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await appAuthSecret('caddie-master-secret-0123456789', 'proj-a', 'preview')).toBe(a);
		expect(await appAuthSecret('caddie-master-secret-0123456789', 'proj-a', 'live')).not.toBe(a);
		expect(await appAuthSecret('caddie-master-secret-0123456789', 'proj-b', 'preview')).not.toBe(a);
		expect(await appAuthSecret(undefined, 'proj-a', 'preview')).toBeNull();
		expect(await appAuthSecret('short', 'proj-a', 'preview')).toBeNull();
	});
});
