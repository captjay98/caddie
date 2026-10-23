import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { clearTestEmails, listTestEmails, sendAppEmail } from '../apps/app/src/server/app-email.ts';
import { clearTestInbox, listTestInbox, sendAppSignInCode, type AppSignInDeps } from '../apps/app/src/server/app-sign-in.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * The test inbox (plan part K, lane 1's route change). The route returns the
 * sign-in codes AND the emails together, and "Reset test data" empties both.
 * One project can't read another's inbox. This exercises the two service calls
 * the GET /workflow/test-inbox route composes (listTestInbox + listTestEmails)
 * and the reset (clearTestInbox + clearTestEmails); the HTTP wrapper and its
 * auth are SIMULATED here (covered by typecheck), verified LIVE by the P02
 * integration harness elsewhere.
 */

const NOW = new Date('2026-10-22T12:00:00.000Z');

describe('the test inbox returns codes and emails together', () => {
	let sqlite: Database;
	let db: D1Database;
	let projectId: string;
	let signInDeps: AppSignInDeps;

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		projectId = (await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Shop', description: 'x' })).id;
		signInDeps = { mailer: { name: 'resend', send: async () => ({ ok: true }) }, appsDomain: 'caddieapps.com', caddieOrigin: null, now: () => NOW };
	});

	afterEach(() => sqlite.close());

	// The two reads the test-inbox route composes, for one scope.
	const inboxPayload = async (userId: string, pid: string) => {
		const scope = await projectScopeForUser(db, userId, pid);
		const [messages, emails] = await Promise.all([listTestInbox(db, scope), listTestEmails(db, scope)]);
		return { messages, emails };
	};

	test('both a code and an email show up, each keyed to the same project', async () => {
		expect(await sendAppSignInCode(db, signInDeps, { projectId, mode: 'preview', request: { email: 'ada@example.com', code: '123456' } })).toEqual({ ok: true });
		expect(await sendAppEmail(db, { now: () => NOW }, { projectId, mode: 'preview', request: { to: 'bo@example.com', subject: 'Receipt', text: 'Paid' } })).toEqual({
			ok: true,
			delivered: 'test-inbox',
		});
		const payload = await inboxPayload('owner-1', projectId);
		expect(payload.messages).toEqual([{ to: 'ada@example.com', code: '123456', createdAt: NOW.toISOString() }]);
		expect(payload.emails).toEqual([{ to: 'bo@example.com', subject: 'Receipt', text: 'Paid', template: null, mode: 'preview', createdAt: NOW.toISOString() }]);
	});

	test('Reset test data empties both the codes and the emails', async () => {
		await sendAppSignInCode(db, signInDeps, { projectId, mode: 'preview', request: { email: 'ada@example.com', code: '123456' } });
		await sendAppEmail(db, { now: () => NOW }, { projectId, mode: 'preview', request: { to: 'bo@example.com', subject: 'Hi', text: 'There' } });
		await clearTestInbox(db, projectId);
		await clearTestEmails(db, projectId);
		const payload = await inboxPayload('owner-1', projectId);
		expect(payload).toEqual({ messages: [], emails: [] });
	});

	test("one project can't read another's inbox", async () => {
		await sendAppEmail(db, { now: () => NOW }, { projectId, mode: 'preview', request: { to: 'bo@example.com', subject: 'Hi', text: 'There' } });
		addUser(sqlite, 'owner-2', 'two@example.com');
		const ws2 = await createWorkspace(db, 'owner-2', { name: 'W2' });
		const other = (await createProject(db, await workspaceScopeForUser(db, 'owner-2', ws2.id), { workspaceId: ws2.id, name: 'Other', description: 'y' })).id;
		expect(await inboxPayload('owner-2', other)).toEqual({ messages: [], emails: [] });
		await expect(projectScopeForUser(db, 'owner-2', projectId)).rejects.toThrow();
	});
});
