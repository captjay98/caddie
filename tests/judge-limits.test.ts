import { afterEach, describe, expect, test } from 'bun:test';
import type { Database as BunDatabase } from 'bun:sqlite';
import type { AuthEnv, D1Database } from '../apps/app/src/server/auth.ts';
import { getAuth } from '../apps/app/src/server/auth.ts';
import {
	createPlanDocRevision,
	createProject,
	createWorkspace,
	ensureHomeProject,
} from '../apps/app/src/server/projects.ts';
import { createRun } from '../apps/app/src/server/runs.ts';
import {
	decideDesign,
	decideWorkflow,
	retryWorkflow,
	setWorkflowBlocker,
	startProjectFromChat,
	workflowSnapshot,
} from '../apps/app/src/server/build-workflow.ts';
import { approvePlan, projectExperience } from '../apps/app/src/server/project-experience.ts';
import { projectScopeForUser, ScopeError, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { judgeIdentityFrom } from '../apps/app/src/server/judge-access.ts';
import {
	JUDGE_MAX_BUILDS_PER_DAY_DEFAULT,
	JUDGE_MAX_MESSAGES_PER_DAY_DEFAULT,
	JUDGE_MAX_PROJECTS_DEFAULT,
	admitJudgeBuildStart,
	admitJudgeMessage,
	countJudgeProjects,
	countJudgeUsage,
	judgeLimits,
} from '../apps/app/src/server/judge-limits.ts';
import { conversationGuard } from '../apps/app/src/server/routes/runs.ts';
import { INTERNAL_DISPATCH_HEADER, internalDispatchSignature, isInternalDispatch } from '../apps/app/src/server/internal-dispatch.ts';
import { workerSelfDeliver } from '../apps/app/src/server/workflow-dispatch.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * S07 judge limits. LOCAL VERIFIED in-process over the real migrations:
 * projects and build starts run the real services, and messages run the real
 * conversation guard behind a real Better Auth session. No model, sandbox or
 * network work happens in any of these paths.
 */

const ORIGIN = 'http://127.0.0.1:8787';
const SECRET = 'judge-limits-test-secret-0123456789abcdef';
const JUDGE_ID = 'judge-1';
const JUDGE_EMAIL = 'judge-one@judges.caddie.invalid';
const PASSWORD = 'a-long-enough-password';

/**
 * Better Auth's schema self-check reads rows from `batch(...)`, which the
 * shared fixture's batch discards. Restore real D1's per-statement rows for
 * the tests that exercise a session (same harness as tests/judge-access.test.ts).
 */
function withRealD1Batch(db: D1Database): D1Database {
	return {
		...db,
		batch: (statements: { all(): unknown }[]) => Promise.all(statements.map((statement) => statement.all())),
	} as unknown as D1Database;
}

function count(sqlite: BunDatabase, sql: string, ...args: unknown[]): number {
	return Number((sqlite.query(sql).get(...(args as never[])) as { n?: number } | null)?.n ?? 0);
}

function seedJudge(sqlite: BunDatabase, userId = JUDGE_ID, name = 'judge-one'): void {
	sqlite
		.prepare('insert into "judge_accounts" ("judgeName","userId","state","createdAt","lastSignInAt") values (?,?,?,?,null)')
		.run(name, userId, 'active', new Date().toISOString());
}

function seedUsage(sqlite: BunDatabase, userId: string, kind: 'build' | 'message', rows: number, at = new Date().toISOString()): void {
	for (let i = 0; i < rows; i++) {
		sqlite
			.prepare('insert into "judge_usage_events" ("id","userId","kind","createdAt") values (?,?,?,?)')
			.run(`ju_${kind}_${crypto.randomUUID()}`, userId, kind, at);
	}
}

async function rejectsCode(task: Promise<unknown>, code: string): Promise<string> {
	try {
		await task;
	} catch (error) {
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).code).toBe(code);
		return (error as ScopeError).message;
	}
	throw new Error(`expected ${code}, but the call succeeded`);
}

const OLD = () => new Date(Date.now() - 25 * 60 * 60_000).toISOString();

/** Judge project/build fixture: no auth session needed, real services only. */
async function serviceWorld() {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, JUDGE_ID, JUDGE_EMAIL);
	seedJudge(sqlite);
	const workspace = await createWorkspace(db, JUDGE_ID, { name: 'Judge workspace' });
	const wsScope = await workspaceScopeForUser(db, JUDGE_ID, workspace.id);
	return { sqlite, db, workspace, wsScope };
}

/** A judge with a home conversation, one project, and its PRD awaiting review. */
async function buildWorld() {
	const world = await serviceWorld();
	const home = await ensureHomeProject(world.db, JUDGE_ID);
	const homeScope = await projectScopeForUser(world.db, JUDGE_ID, home.id);
	const homeRun = await createRun(world.db, homeScope, {
		modelRouteId: 'nemotron-3-super',
		payerId: JUDGE_ID,
		conversationId: `conv-home-${crypto.randomUUID()}`,
	});
	const started = await startProjectFromChat(world.db, homeScope, {
		name: 'Todo app',
		brief: 'Build a minimal todo app with saved tasks. Show me the plan first.',
		operationKey: `create-${crypto.randomUUID()}`,
		sourceConversationId: homeRun.conversationId,
	});
	const scope = await projectScopeForUser(world.db, JUDGE_ID, started.project.id);
	const plan = await createPlanDocRevision(world.db, scope, { kind: 'prd', body: '# Todo app\n\nAdd, complete and persist tasks.' });
	await workflowSnapshot(world.db, scope);
	return { ...world, home, homeScope, homeRun, scope, plan };
}

function cookieHeader(headers: Headers): string {
	const raw =
		typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
			? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
			: [headers.get('set-cookie')].filter((value): value is string => Boolean(value));
	return raw.map((cookie) => cookie.split(';')[0]).join('; ');
}

/**
 * Message fixture: a real Better Auth user + session, a bound conversation and
 * the real conversation guard in front of a stub coordinator route. The
 * session always comes through the S06 judge start (a real signed cookie);
 * `judge: false` then clears the judge row, which is exactly what makes an
 * account "not a judge" to every limit check.
 */
async function guardWorld(options: { judge?: boolean; limits?: Record<string, string> } = {}) {
	const { sqlite, db } = migratedDatabase();
	const real = withRealD1Batch(db);
	const env = {
		DB: real,
		BETTER_AUTH_SECRET: SECRET,
		BETTER_AUTH_URL: ORIGIN,
		INVITE_ALLOWLIST: 'owner@example.com',
		...(options.limits ?? {}),
	} as AuthEnv;
	const auth = getAuth(env);
	const identity = judgeIdentityFrom(auth);
	const now = new Date().toISOString();
	// The invite gate admits a judge address only while its 'starting' row is
	// fresh (the ticket S06's start writes).
	sqlite
		.prepare('insert into "judge_accounts" ("judgeName","state","createdAt","lastSignInAt") values (?,?,?,null)')
		.run('judge-one', 'starting', now);
	const user = await identity.createUser({ email: JUDGE_EMAIL, name: 'Judge-One' });
	await identity.setPassword(user.id, PASSWORD);
	const cookie = cookieHeader(await identity.signIn({ email: JUDGE_EMAIL, password: PASSWORD }));
	if (options.judge === false) {
		sqlite.prepare('delete from "judge_accounts" where "judgeName" = ?').run('judge-one');
	} else {
		sqlite.prepare('update "judge_accounts" set "state" = \'active\', "userId" = ? where "judgeName" = ?').run(user.id, 'judge-one');
	}

	const workspace = await createWorkspace(real, user.id, { name: 'Workspace' });
	const wsScope = await workspaceScopeForUser(real, user.id, workspace.id);
	const project = await createProject(real, wsScope, { workspaceId: workspace.id, name: 'Todo app' });
	const scope = await projectScopeForUser(real, user.id, project.id);
	const conversationId = 'conv-judge-1';
	await createRun(real, scope, { modelRouteId: 'nemotron-3-super', payerId: user.id, conversationId });

	const app = conversationGuard();
	app.post('/coordinator/:conversationId', (c) => c.json({ ok: true }));
	app.get('/coordinator/:conversationId', (c) => c.json({ ok: true }));
	app.post('/coordinator/:conversationId/abort', (c) => c.json({ ok: true }));

	// The guard is mounted at /agents in app.ts; here it is exercised directly,
	// so a self-delivery's /agents prefix is stripped exactly as mounting does.
	const mounted = {
		fetch(request: Request, requestEnv?: AuthEnv, ctx?: unknown) {
			const inner = new URL(request.url);
			inner.pathname = inner.pathname.replace(/^\/agents/, '');
			return app.fetch(new Request(inner.href, request), requestEnv, ctx as never);
		},
	};

	const postMessage = (extraHeaders: Record<string, string> = {}) =>
		app.request(
			`${ORIGIN}/coordinator/${conversationId}`,
			{
				method: 'POST',
				headers: { cookie, 'content-type': 'application/json', ...extraHeaders },
				body: JSON.stringify({ idempotencyKey: `msg-${crypto.randomUUID()}`, kind: 'user', body: 'hello' }),
			},
			env,
		);

	return { sqlite, db: real, env, app, mounted, user, workspace, wsScope, project, scope, conversationId, cookie, postMessage };
}

describe('judge limits: configuration', () => {
	test('the D4 defaults apply when an override is absent, unparseable or zero', () => {
		expect(judgeLimits(undefined)).toEqual({
			projects: JUDGE_MAX_PROJECTS_DEFAULT,
			buildsPerDay: JUDGE_MAX_BUILDS_PER_DAY_DEFAULT,
			messagesPerDay: JUDGE_MAX_MESSAGES_PER_DAY_DEFAULT,
		});
		const defaults = judgeLimits({ JUDGE_MAX_PROJECTS: '0', JUDGE_MAX_BUILDS_PER_DAY: 'many', JUDGE_MAX_MESSAGES_PER_DAY: '-5' });
		expect(defaults).toEqual({
			projects: JUDGE_MAX_PROJECTS_DEFAULT,
			buildsPerDay: JUDGE_MAX_BUILDS_PER_DAY_DEFAULT,
			messagesPerDay: JUDGE_MAX_MESSAGES_PER_DAY_DEFAULT,
		});
		expect(judgeLimits({ JUDGE_MAX_PROJECTS: '5', JUDGE_MAX_BUILDS_PER_DAY: 2, JUDGE_MAX_MESSAGES_PER_DAY: ' 40 ' })).toEqual({
			projects: 5,
			buildsPerDay: 2,
			messagesPerDay: 40,
		});
	});
});

describe('judge limits: projects', () => {
	let sqlite: BunDatabase;
	afterEach(() => sqlite?.close());

	test('the 4th project is refused with the exact sentence and creates nothing', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		for (const name of ['One', 'Two', 'Three']) {
			await createProject(world.db, world.wsScope, { workspaceId: world.workspace.id, name });
		}
		expect(await countJudgeProjects(world.db, JUDGE_ID)).toBe(3);

		const message = await rejectsCode(
			createProject(world.db, world.wsScope, { workspaceId: world.workspace.id, name: 'Four' }),
			'JUDGE_LIMIT_PROJECTS',
		);
		expect(message).toBe('Judges can have 3 projects. Everything else works the same.');
		expect(await countJudgeProjects(world.db, JUDGE_ID)).toBe(3);
		expect(count(sqlite, 'select count(*) as n from "projects"')).toBe(3);
	});

	test('the chat create path is refused too, before a project, run or intake is written', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		for (const name of ['One', 'Two', 'Three']) {
			await createProject(world.db, world.wsScope, { workspaceId: world.workspace.id, name });
		}
		const home = await ensureHomeProject(world.db, JUDGE_ID);
		const homeScope = await projectScopeForUser(world.db, JUDGE_ID, home.id);
		const homeRun = await createRun(world.db, homeScope, {
			modelRouteId: 'nemotron-3-super',
			payerId: JUDGE_ID,
			conversationId: `conv-home-${crypto.randomUUID()}`,
		});
		const runsBefore = count(sqlite, 'select count(*) as n from "run_bindings"');

		const message = await rejectsCode(
			startProjectFromChat(world.db, homeScope, {
				name: 'Four',
				brief: 'Build a fourth app. Show me the plan first.',
				operationKey: `create-${crypto.randomUUID()}`,
				sourceConversationId: homeRun.conversationId,
			}),
			'JUDGE_LIMIT_PROJECTS',
		);
		expect(message).toBe('Judges can have 3 projects. Everything else works the same.');
		expect(count(sqlite, 'select count(*) as n from "projects" where "kind" <> \'home\'')).toBe(3);
		expect(count(sqlite, 'select count(*) as n from "run_bindings"')).toBe(runsBefore);
		expect(count(sqlite, 'select count(*) as n from "build_workflows"')).toBe(0);
	});

	test('the home project is neither counted nor refused', async () => {
		const { sqlite: local, db } = migratedDatabase();
		sqlite = local;
		addUser(sqlite, JUDGE_ID, JUDGE_EMAIL);
		seedJudge(sqlite);
		const workspace = await createWorkspace(db, JUDGE_ID, { name: 'Judge workspace' });
		const wsScope = await workspaceScopeForUser(db, JUDGE_ID, workspace.id);
		for (const name of ['One', 'Two', 'Three']) {
			await createProject(db, wsScope, { workspaceId: workspace.id, name });
		}
		// The lazy Home conversation is created at the limit and must succeed.
		const home = await ensureHomeProject(db, JUDGE_ID);
		expect(home.kind).toBe('home');
		expect(await countJudgeProjects(db, JUDGE_ID)).toBe(3);
		// ...and it does not buy a 4th counted project.
		await rejectsCode(createProject(db, wsScope, { workspaceId: workspace.id, name: 'Four' }), 'JUDGE_LIMIT_PROJECTS');
	});
});

describe('judge limits: build starts', () => {
	let sqlite: BunDatabase;
	afterEach(() => sqlite?.close());

	test('plan approval is refused before any write; after 24h the same start succeeds', async () => {
		const world = await buildWorld();
		sqlite = world.sqlite;
		seedUsage(sqlite, JUDGE_ID, 'build', 3);
		const before = await projectExperience(world.db, world.scope);
		expect(before.stage).toBe('review');

		const message = await rejectsCode(
			approvePlan(
				world.db,
				world.scope,
				{
					projectId: world.scope.projectId,
					planRevisionId: world.plan.id,
					expectedVersion: before.version,
					idempotencyKey: 'approve-refused-1',
				},
				{ JUDGE_MAX_BUILDS_PER_DAY: '3' },
			),
			'JUDGE_LIMIT_BUILDS',
		);
		expect(message).toBe('Judges can start 3 builds in 24 hours. Everything else works the same.');
		// Nothing moved: no phase change, no approval, no plan decision, no run.
		const refused = await workflowSnapshot(world.db, world.scope);
		expect(refused.workflow?.phase).toBe('review');
		expect(refused.approval).toBeNull();
		expect(count(sqlite, 'select count(*) as n from "plan_decisions"')).toBe(0);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(3);

		// The same three events, now older than 24h, free the place.
		sqlite.prepare('update "judge_usage_events" set "createdAt" = ? where "kind" = \'build\'').run(OLD());
		const after = await projectExperience(world.db, world.scope);
		const applied = await approvePlan(
			world.db,
			world.scope,
			{
				projectId: world.scope.projectId,
				planRevisionId: world.plan.id,
				expectedVersion: after.version,
				idempotencyKey: 'approve-allowed-1',
			},
			{ JUDGE_MAX_BUILDS_PER_DAY: '3' },
		);
		expect(applied.outcome).toBe('applied');
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('design');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(1);
	});

	test('design approval and Retry each count once; the next start in the window is refused before any effect', async () => {
		const world = await buildWorld();
		sqlite = world.sqlite;
		const env = { JUDGE_MAX_BUILDS_PER_DAY: '3' };

		await decideWorkflow(world.db, world.scope, { planId: world.plan.id, decision: 'approved' }, env);
		const design = await createPlanDocRevision(world.db, world.scope, {
			kind: 'design',
			body: '# Design brief\n\nOne screen; loading, empty and error states defined.',
		});
		await workflowSnapshot(world.db, world.scope);
		await decideDesign(world.db, world.scope, { designId: design.id, decision: 'approved' }, env);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(2);

		// Retry is the third start.
		await setWorkflowBlocker(world.db, world.scope, 'Sandbox unavailable');
		await retryWorkflow(world.db, world.scope, 'retry-key-1', undefined, env);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(3);
		const resumesBefore = count(sqlite, 'select count(*) as n from "workflow_resumes"');
		const pendingBefore = (await workflowSnapshot(world.db, world.scope)).workflow?.pendingKey;

		// The 4th start is refused before the phase change and the resume row.
		await setWorkflowBlocker(world.db, world.scope, 'Sandbox unavailable again');
		const message = await rejectsCode(
			retryWorkflow(world.db, world.scope, 'retry-key-2', undefined, env),
			'JUDGE_LIMIT_BUILDS',
		);
		expect(message).toBe('Judges can start 3 builds in 24 hours. Everything else works the same.');
		const blocked = await workflowSnapshot(world.db, world.scope);
		expect(blocked.workflow?.phase).toBe('blocked');
		expect(blocked.workflow?.pendingKey).toBe(pendingBefore);
		expect(count(sqlite, 'select count(*) as n from "workflow_resumes"')).toBe(resumesBefore);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(3);

		// Once the three old events are out of the window, the retry goes through.
		sqlite.prepare('update "judge_usage_events" set "createdAt" = ? where "kind" = \'build\'').run(OLD());
		await retryWorkflow(world.db, world.scope, 'retry-key-2', undefined, env);
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('building');
		expect(count(sqlite, 'select count(*) as n from "workflow_resumes"')).toBe(resumesBefore + 1);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(1);
	});

	test('a non-judge is never limited, even with every limit set to 1', async () => {
		const { sqlite: local, db } = migratedDatabase();
		sqlite = local;
		const OWNER = 'owner-1';
		addUser(sqlite, OWNER, 'owner@example.com');
		const workspace = await createWorkspace(db, OWNER, { name: 'Owner workspace' });
		const wsScope = await workspaceScopeForUser(db, OWNER, workspace.id);
		const env = { JUDGE_MAX_PROJECTS: '1', JUDGE_MAX_BUILDS_PER_DAY: '1' };

		for (const name of ['One', 'Two', 'Three', 'Four']) {
			await createProject(db, wsScope, { workspaceId: workspace.id, name }, env);
		}
		expect(await countJudgeProjects(db, OWNER)).toBe(4);

		const home = await ensureHomeProject(db, OWNER);
		const homeScope = await projectScopeForUser(db, OWNER, home.id);
		const homeRun = await createRun(db, homeScope, { modelRouteId: 'nemotron-3-super', payerId: OWNER, conversationId: `conv-${crypto.randomUUID()}` });
		const started = await startProjectFromChat(
			db,
			homeScope,
			{ name: 'Five', brief: 'Build a fifth app. Show me the plan first.', operationKey: `create-${crypto.randomUUID()}`, sourceConversationId: homeRun.conversationId },
			env,
		);
		const scope = await projectScopeForUser(db, OWNER, started.project.id);
		const plan = await createPlanDocRevision(db, scope, { kind: 'prd', body: '# Five' });
		await workflowSnapshot(db, scope);
		await decideWorkflow(db, scope, { planId: plan.id, decision: 'approved' }, env);
		const design = await createPlanDocRevision(db, scope, { kind: 'design', body: '# Design' });
		await workflowSnapshot(db, scope);
		await decideDesign(db, scope, { designId: design.id, decision: 'approved' }, env);
		await setWorkflowBlocker(db, scope, 'stop');
		await retryWorkflow(db, scope, 'retry-owner-1', undefined, env);
		await setWorkflowBlocker(db, scope, 'stop again');
		await retryWorkflow(db, scope, 'retry-owner-2', undefined, env);
		expect(await countJudgeUsage(db, OWNER, 'build')).toBe(0);
	});

	test('the admit helpers refuse at the limit for a judge and record one row per admitted start', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		const limit = { JUDGE_MAX_BUILDS_PER_DAY: '2' };
		expect(await admitJudgeBuildStart(world.db, JUDGE_ID, limit)).toBe(true);
		expect(await admitJudgeBuildStart(world.db, JUDGE_ID, limit)).toBe(true);
		await rejectsCode(admitJudgeBuildStart(world.db, JUDGE_ID, limit), 'JUDGE_LIMIT_BUILDS');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(2);
	});
});

describe('judge limits: messages at the conversation guard', () => {
	let sqlite: BunDatabase;
	afterEach(() => sqlite?.close());

	test('the 300th message is allowed and the 301st is refused with the plain sentence', async () => {
		const world = await guardWorld({ judge: true });
		sqlite = world.sqlite;
		seedUsage(sqlite, world.user.id, 'message', 299);

		const allowed = await world.postMessage();
		expect(allowed.status).toBe(200);
		expect(await countJudgeUsage(world.db, world.user.id, 'message')).toBe(300);

		const refused = await world.postMessage();
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({
			error: 'JUDGE_LIMIT_MESSAGES',
			message: 'Judges can send 300 Caddie messages in 24 hours. Everything else works the same.',
		});
		expect(await countJudgeUsage(world.db, world.user.id, 'message')).toBe(300);

		// Not-messages cost nothing: history and abort still work at the limit.
		const history = await world.app.request(`${ORIGIN}/coordinator/${world.conversationId}`, { headers: { cookie: world.cookie } }, world.env);
		expect(history.status).toBe(200);
		const abort = await world.app.request(`${ORIGIN}/coordinator/${world.conversationId}/abort`, { method: 'POST', headers: { cookie: world.cookie } }, world.env);
		expect(abort.status).toBe(200);
		expect(await countJudgeUsage(world.db, world.user.id, 'message')).toBe(300);

		// A message after the window reopens the quota.
		sqlite.prepare('update "judge_usage_events" set "createdAt" = ? where "kind" = \'message\'').run(OLD());
		expect((await world.postMessage()).status).toBe(200);
		expect(await countJudgeUsage(world.db, world.user.id, 'message')).toBe(1);
	});

	test('a server-originated dispatch is admitted without consuming quota, and the header cannot be forged', async () => {
		const world = await guardWorld({ judge: true, limits: { JUDGE_MAX_MESSAGES_PER_DAY: '1' } });
		sqlite = world.sqlite;
		seedUsage(sqlite, world.user.id, 'message', 1);

		// The judge is at the limit.
		expect((await world.postMessage()).status).toBe(403);

		// The server's own dispatch carries an HMAC of the conversation id.
		const seen: { signature: string | null } = { signature: null };
		const recording = {
			fetch(request: Request, requestEnv?: AuthEnv, ctx?: unknown) {
				seen.signature = request.headers.get(INTERNAL_DISPATCH_HEADER);
				return world.mounted.fetch(request, requestEnv, ctx);
			},
		};
		const deliver = workerSelfDeliver(recording, ORIGIN, world.cookie, world.env);
		const result = await deliver({ conversationId: world.conversationId, body: 'Prepare a plan', idempotencyKey: 'intake:test' });
		expect(result.delivered).toBe(true);
		expect(seen.signature).toBe(await internalDispatchSignature(SECRET, world.conversationId));
		expect(await countJudgeUsage(world.db, world.user.id, 'message')).toBe(1);

		// A browser can set the header name but cannot compute the value.
		const forged = await world.postMessage({ [INTERNAL_DISPATCH_HEADER]: 'forged' });
		expect(forged.status).toBe(403);
		expect(await countJudgeUsage(world.db, world.user.id, 'message')).toBe(1);
		// A valid signature is bound to its conversation.
		const headers = new Headers({ [INTERNAL_DISPATCH_HEADER]: await internalDispatchSignature(SECRET, 'conv-other') });
		expect(await isInternalDispatch(world.env, headers, world.conversationId)).toBe(false);
		expect(await isInternalDispatch(world.env, new Headers(), world.conversationId)).toBe(false);
	});

	test('a user without an active judge row is never limited on messages', async () => {
		// The same real session, with the judge row cleared: not a judge, so the
		// guard must not count or refuse even with the limit set to 1.
		const world = await guardWorld({ judge: false, limits: { JUDGE_MAX_MESSAGES_PER_DAY: '1' } });
		sqlite = world.sqlite;
		for (let i = 0; i < 3; i++) expect((await world.postMessage()).status).toBe(200);
		expect(await countJudgeUsage(world.db, world.user.id, 'message')).toBe(0);
	});
});

describe('judge limit classifiers', () => {
	test('the message admit helper counts judges and ignores everyone else', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, JUDGE_ID, JUDGE_EMAIL);
		addUser(sqlite, 'owner-1', 'owner@example.com');
		seedJudge(sqlite);
		const limit = { JUDGE_MAX_MESSAGES_PER_DAY: '2' };
		expect(await admitJudgeMessage(db, JUDGE_ID, limit)).toBe(true);
		expect(await admitJudgeMessage(db, JUDGE_ID, limit)).toBe(true);
		await rejectsCode(admitJudgeMessage(db, JUDGE_ID, limit), 'JUDGE_LIMIT_MESSAGES');
		expect(await admitJudgeMessage(db, 'owner-1', limit)).toBe(false);
		expect(await countJudgeUsage(db, JUDGE_ID, 'message')).toBe(2);
		sqlite.close();
	});
});
