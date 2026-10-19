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
import type { Scope } from '@caddie/contracts';
import { judgeIdentityFrom } from '../apps/app/src/server/judge-access.ts';
import {
	JUDGE_MAX_BUILDS_PER_DAY_DEFAULT,
	JUDGE_MAX_DISCOVERY_PER_DAY_DEFAULT,
	JUDGE_MAX_MESSAGES_PER_DAY_DEFAULT,
	JUDGE_MAX_PROJECTS_DEFAULT,
	admitJudgeBuildStart,
	admitJudgeDiscovery,
	admitJudgeMessage,
	admitJudgeProject,
	countJudgeProjects,
	countJudgeUsage,
	judgeLimits,
} from '../apps/app/src/server/judge-limits.ts';
import { createDiscoveryRouter } from '../apps/app/src/server/routes/discovery.ts';
import { createLocalSeedAdapter, listCandidates, runDiscoveryFeed, seedCandidates } from '../apps/app/src/server/discovery.ts';
import { paidDiscoveryTools } from '../apps/app/src/server/judge-paid-tools.ts';
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

function seedUsage(sqlite: BunDatabase, userId: string, kind: 'build' | 'message' | 'discovery', rows: number, at = new Date().toISOString()): void {
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
	test('the D4 defaults apply when an override is absent or unparseable', () => {
		const defaults = {
			projects: JUDGE_MAX_PROJECTS_DEFAULT,
			buildsPerDay: JUDGE_MAX_BUILDS_PER_DAY_DEFAULT,
			messagesPerDay: JUDGE_MAX_MESSAGES_PER_DAY_DEFAULT,
			discoveryPerDay: JUDGE_MAX_DISCOVERY_PER_DAY_DEFAULT,
		};
		expect(judgeLimits(undefined)).toEqual(defaults);
		expect(judgeLimits({})).toEqual(defaults);
		// Every value a typo can produce reads as the default — never more
		// permissive than D4.
		expect(
			judgeLimits({
				JUDGE_MAX_PROJECTS: 'abc',
				JUDGE_MAX_BUILDS_PER_DAY: 'many',
				JUDGE_MAX_MESSAGES_PER_DAY: '-5',
				JUDGE_MAX_DISCOVERY_PER_DAY: '2.5',
			}),
		).toEqual(defaults);
		expect(
			judgeLimits({
				JUDGE_MAX_PROJECTS: '',
				JUDGE_MAX_BUILDS_PER_DAY: '-1',
				JUDGE_MAX_MESSAGES_PER_DAY: '   ',
				JUDGE_MAX_DISCOVERY_PER_DAY: '',
			}),
		).toEqual(defaults);
	});

	test('0 is a real limit meaning NONE, not the default', () => {
		expect(
			judgeLimits({
				JUDGE_MAX_PROJECTS: '0',
				JUDGE_MAX_BUILDS_PER_DAY: 0,
				JUDGE_MAX_MESSAGES_PER_DAY: '0',
				JUDGE_MAX_DISCOVERY_PER_DAY: ' 0 ',
			}),
		).toEqual({ projects: 0, buildsPerDay: 0, messagesPerDay: 0, discoveryPerDay: 0 });
	});

	test('valid overrides are honored, including trimming', () => {
		expect(
			judgeLimits({
				JUDGE_MAX_PROJECTS: '5',
				JUDGE_MAX_BUILDS_PER_DAY: 2,
				JUDGE_MAX_MESSAGES_PER_DAY: ' 40 ',
				JUDGE_MAX_DISCOVERY_PER_DAY: 7,
			}),
		).toEqual({ projects: 5, buildsPerDay: 2, messagesPerDay: 40, discoveryPerDay: 7 });
	});
});

describe('judge limits: 0 means none at every limit', () => {
	let sqlite: BunDatabase;
	afterEach(() => sqlite?.close());

	test('a judge is refused the FIRST project at 0 and no usage row is written', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		const message = await rejectsCode(
			createProject(world.db, world.wsScope, { workspaceId: world.workspace.id, name: 'First' }, { JUDGE_MAX_PROJECTS: '0' }),
			'JUDGE_LIMIT_PROJECTS',
		);
		expect(message).toBe('Judges can have 0 projects. Everything else works the same.');
		expect(count(sqlite, 'select count(*) as n from "projects"')).toBe(0);
		expect(count(sqlite, 'select count(*) as n from "judge_usage_events"')).toBe(0);
		// The admit helper agrees at the same limit.
		await rejectsCode(admitJudgeProject(world.db, JUDGE_ID, { JUDGE_MAX_PROJECTS: '0' }), 'JUDGE_LIMIT_PROJECTS');
	});

	test('a judge is refused the FIRST build start at 0 and writes no usage row', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		const message = await rejectsCode(
			admitJudgeBuildStart(world.db, JUDGE_ID, { JUDGE_MAX_BUILDS_PER_DAY: '0' }),
			'JUDGE_LIMIT_BUILDS',
		);
		expect(message).toBe('Judges can start 0 builds in 24 hours. Everything else works the same.');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(0);
		expect(count(sqlite, 'select count(*) as n from "judge_usage_events"')).toBe(0);
	});

	test('a judge is refused the FIRST message at 0 and writes no usage row', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		const message = await rejectsCode(
			admitJudgeMessage(world.db, JUDGE_ID, { JUDGE_MAX_MESSAGES_PER_DAY: '0' }),
			'JUDGE_LIMIT_MESSAGES',
		);
		expect(message).toBe('Judges can send 0 Caddie messages in 24 hours. Everything else works the same.');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'message')).toBe(0);
		expect(count(sqlite, 'select count(*) as n from "judge_usage_events"')).toBe(0);
	});

	test('a non-judge is never refused, even with every limit set to 0', async () => {
		const { sqlite: local, db } = migratedDatabase();
		sqlite = local;
		const OWNER = 'owner-1';
		addUser(sqlite, OWNER, 'owner@example.com');
		const env = {
			JUDGE_MAX_PROJECTS: '0',
			JUDGE_MAX_BUILDS_PER_DAY: '0',
			JUDGE_MAX_MESSAGES_PER_DAY: '0',
			JUDGE_MAX_DISCOVERY_PER_DAY: '0',
		};
		expect(await admitJudgeProject(db, OWNER, env)).toBe(false);
		expect(await admitJudgeBuildStart(db, OWNER, env)).toBe(false);
		expect(await admitJudgeMessage(db, OWNER, env)).toBe(false);
		expect(await admitJudgeDiscovery(db, OWNER, env)).toBe(false);
		expect(count(sqlite, 'select count(*) as n from "judge_usage_events"')).toBe(0);
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

	test('simultaneous creates never pass the cap: at 2 of 3, five at once through both paths leave exactly 3', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		for (const name of ['One', 'Two']) {
			await createProject(world.db, world.wsScope, { workspaceId: world.workspace.id, name });
		}
		const home = await ensureHomeProject(world.db, JUDGE_ID);
		const homeScope = await projectScopeForUser(world.db, JUDGE_ID, home.id);
		const homeRun = await createRun(world.db, homeScope, {
			modelRouteId: 'nemotron-3-super',
			payerId: JUDGE_ID,
			conversationId: `conv-home-${crypto.randomUUID()}`,
		});
		const chat = (name: string) =>
			startProjectFromChat(world.db, homeScope, {
				name,
				brief: `Build ${name}. Show me the plan first.`,
				operationKey: `create-${crypto.randomUUID()}`,
				sourceConversationId: homeRun.conversationId,
			});
		const direct = (name: string) => createProject(world.db, world.wsScope, { workspaceId: world.workspace.id, name });

		const settled = await Promise.allSettled([direct('Direct A'), chat('Chat A'), direct('Direct B'), chat('Chat B'), direct('Direct C')]);
		expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		for (const outcome of settled) {
			if (outcome.status === 'rejected') expect((outcome.reason as ScopeError).code).toBe('JUDGE_LIMIT_PROJECTS');
		}
		expect(await countJudgeProjects(world.db, JUDGE_ID)).toBe(3);
		// A refused chat create leaves no run or workflow behind.
		const chatCreated = [settled[1], settled[3]].filter((outcome) => outcome!.status === 'fulfilled').length;
		expect(count(sqlite, 'select count(*) as n from "build_workflows"')).toBe(chatCreated);
		expect(count(sqlite, 'select count(*) as n from "run_bindings"')).toBe(1 + chatCreated);
	});
});

describe('judge limits: build starts', () => {
	let sqlite: BunDatabase;
	afterEach(() => sqlite?.close());

	test('plan approval starts no build: at the build limit it still goes through, and design approval is refused before any write', async () => {
		const world = await buildWorld();
		sqlite = world.sqlite;
		seedUsage(sqlite, JUDGE_ID, 'build', 3);
		const env = { JUDGE_MAX_BUILDS_PER_DAY: '3' };
		const before = await projectExperience(world.db, world.scope);
		expect(before.stage).toBe('review');

		// Approving the plan only starts the design step: no sandbox, no build.
		const applied = await approvePlan(
			world.db,
			world.scope,
			{
				projectId: world.scope.projectId,
				planRevisionId: world.plan.id,
				expectedVersion: before.version,
				idempotencyKey: 'approve-at-limit-1',
			},
			env,
		);
		expect(applied.outcome).toBe('applied');
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('design');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(3);

		// Approving the design is the build start, and it is refused before any write.
		const design = await createPlanDocRevision(world.db, world.scope, {
			kind: 'design',
			body: '# Design brief\n\nOne screen; loading, empty and error states defined.',
		});
		await workflowSnapshot(world.db, world.scope);
		const message = await rejectsCode(
			decideDesign(world.db, world.scope, { designId: design.id, decision: 'approved' }, env),
			'JUDGE_LIMIT_BUILDS',
		);
		expect(message).toBe('Judges can start 3 builds in 24 hours. Everything else works the same.');
		const refused = await workflowSnapshot(world.db, world.scope);
		expect(refused.workflow?.phase).toBe('design-review');
		expect(refused.designApproval).toBeNull();
		expect(count(sqlite, 'select count(*) as n from "plan_decisions" where "planRevisionId" = ?', design.id)).toBe(0);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(3);

		// The same three events, now older than 24h, free the place.
		sqlite.prepare('update "judge_usage_events" set "createdAt" = ? where "kind" = \'build\'').run(OLD());
		await decideDesign(world.db, world.scope, { designId: design.id, decision: 'approved' }, env);
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('building');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(1);
	});

	test('a whole build is one start (design approval), each Retry one more, and the 4th start is refused before any effect', async () => {
		const world = await buildWorld();
		sqlite = world.sqlite;
		const env = { JUDGE_MAX_BUILDS_PER_DAY: '3' };

		await decideWorkflow(world.db, world.scope, { planId: world.plan.id, decision: 'approved' }, env);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(0);
		const design = await createPlanDocRevision(world.db, world.scope, {
			kind: 'design',
			body: '# Design brief\n\nOne screen; loading, empty and error states defined.',
		});
		await workflowSnapshot(world.db, world.scope);
		await decideDesign(world.db, world.scope, { designId: design.id, decision: 'approved' }, env);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(1);

		// Two Retries are the second and third starts.
		await setWorkflowBlocker(world.db, world.scope, 'Sandbox unavailable');
		await retryWorkflow(world.db, world.scope, 'retry-key-1', undefined, env);
		await setWorkflowBlocker(world.db, world.scope, 'Sandbox unavailable again');
		await retryWorkflow(world.db, world.scope, 'retry-key-2', undefined, env);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(3);
		const resumesBefore = count(sqlite, 'select count(*) as n from "workflow_resumes"');
		const pendingBefore = (await workflowSnapshot(world.db, world.scope)).workflow?.pendingKey;

		// The 4th start is refused before the phase change and the resume row.
		await setWorkflowBlocker(world.db, world.scope, 'Sandbox unavailable a third time');
		const message = await rejectsCode(
			retryWorkflow(world.db, world.scope, 'retry-key-3', undefined, env),
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
		await retryWorkflow(world.db, world.scope, 'retry-key-3', undefined, env);
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

describe('judge limits: discovery lookups', () => {
	let sqlite: BunDatabase;
	afterEach(() => sqlite?.close());

	test('a judge is admitted up to the cap then refused 403, one discovery row per admit', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		const env = { JUDGE_MAX_DISCOVERY_PER_DAY: '2' };
		expect(await admitJudgeDiscovery(world.db, JUDGE_ID, env)).toBe(true);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'discovery')).toBe(1);
		expect(await admitJudgeDiscovery(world.db, JUDGE_ID, env)).toBe(true);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'discovery')).toBe(2);

		const message = await rejectsCode(admitJudgeDiscovery(world.db, JUDGE_ID, env), 'JUDGE_LIMIT_DISCOVERY');
		expect(message).toBe('Judges can run 2 discovery lookups in 24 hours. Everything else works the same.');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'discovery')).toBe(2);
		expect(count(sqlite, 'select count(*) as n from "judge_usage_events" where "kind" = \'discovery\'')).toBe(2);
	});

	test('JUDGE_MAX_DISCOVERY_PER_DAY=0 refuses the first lookup and writes no row', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		const message = await rejectsCode(
			admitJudgeDiscovery(world.db, JUDGE_ID, { JUDGE_MAX_DISCOVERY_PER_DAY: '0' }),
			'JUDGE_LIMIT_DISCOVERY',
		);
		expect(message).toBe('Judges can run 0 discovery lookups in 24 hours. Everything else works the same.');
		expect(count(sqlite, 'select count(*) as n from "judge_usage_events"')).toBe(0);
	});

	test('the default cap is 20: the 21st lookup in the window is refused', async () => {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		seedUsage(sqlite, JUDGE_ID, 'discovery', 20);
		await rejectsCode(admitJudgeDiscovery(world.db, JUDGE_ID), 'JUDGE_LIMIT_DISCOVERY');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'discovery')).toBe(20);
	});

	test('a user without an active judge row is never limited on discovery', async () => {
		const { sqlite: local, db } = migratedDatabase();
		sqlite = local;
		addUser(sqlite, 'owner-1', 'owner@example.com');
		expect(await admitJudgeDiscovery(db, 'owner-1', { JUDGE_MAX_DISCOVERY_PER_DAY: '0' })).toBe(false);
		expect(count(sqlite, 'select count(*) as n from "judge_usage_events"')).toBe(0);
	});
});

describe('judge limits: the POST feed route spends the discovery budget first', () => {
	let sqlite: BunDatabase;
	afterEach(() => sqlite?.close());

	test('at 0 the route refuses before any paid sweep runs', async () => {
		const world = await guardWorld({ judge: true, limits: { JUDGE_MAX_DISCOVERY_PER_DAY: '0' } });
		sqlite = world.sqlite;
		const router = createDiscoveryRouter();
		const refused = await router.request(
			`${ORIGIN}/projects/${world.project.id}/discovery/feed`,
			{ method: 'POST', headers: { cookie: world.cookie } },
			world.env,
		);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({
			error: 'JUDGE_LIMIT_DISCOVERY',
			message: 'Judges can run 0 discovery lookups in 24 hours. Everything else works the same.',
		});
		// The refusal lands BEFORE discoverForActor: no feed run, no admitted event.
		expect(count(sqlite, 'select count(*) as n from "discovery_feed_runs"')).toBe(0);
		expect(await countJudgeUsage(world.db, world.user.id, 'discovery')).toBe(0);
	});
});

/** One stored hackathon in `scope`, with no cached digest. No network: the local seed adapter. */
async function seedOneCandidate(db: D1Database, scope: Scope) {
	await seedCandidates(db, [
		{
			source: 'local-seed',
			url: 'https://devpost.com/software/judge-quota-probe',
			title: 'Quota probe',
			summary: 'A hackathon used to probe the discovery quota.',
		},
	]);
	await runDiscoveryFeed(db, scope, { adapters: [createLocalSeedAdapter(db)] });
	return (await listCandidates(db, scope))[0]!;
}

/** Record every fetch and fail it: provider calls become countable, and nothing leaves the machine. */
function recordFetches(): { calls: string[]; restore(): void } {
	const real = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		calls.push(input instanceof Request ? input.url : String(input));
		throw new Error('network is off in tests');
	}) as unknown as typeof fetch;
	return { calls, restore: () => void (globalThis.fetch = real) };
}

describe('judge limits: a change request is a Caddie message', () => {
	let sqlite: BunDatabase;
	afterEach(() => sqlite?.close());

	test('requesting plan or design changes is refused at 0 before any write, and counted once otherwise', async () => {
		const world = await buildWorld();
		sqlite = world.sqlite;
		const message = await rejectsCode(
			decideWorkflow(world.db, world.scope, { planId: world.plan.id, decision: 'rejected', note: 'Add due dates.' }, { JUDGE_MAX_MESSAGES_PER_DAY: '0' }),
			'JUDGE_LIMIT_MESSAGES',
		);
		expect(message).toBe('Judges can send 0 Caddie messages in 24 hours. Everything else works the same.');
		expect(count(sqlite, 'select count(*) as n from "plan_decisions"')).toBe(0);
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('review');

		const env = { JUDGE_MAX_MESSAGES_PER_DAY: '5' };
		await decideWorkflow(world.db, world.scope, { planId: world.plan.id, decision: 'rejected', note: 'Add due dates.' }, env);
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('planning');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'message')).toBe(1);
		// A re-click dispatches nothing, so it is not counted again.
		await decideWorkflow(world.db, world.scope, { planId: world.plan.id, decision: 'rejected', note: 'Add due dates.' }, env);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'message')).toBe(1);

		// The revised plan is approved (no message, no build), then the design gets a change request.
		const revised = await createPlanDocRevision(world.db, world.scope, { kind: 'prd', body: '# Todo app\n\nTasks with due dates.' });
		await workflowSnapshot(world.db, world.scope);
		await decideWorkflow(world.db, world.scope, { planId: revised.id, decision: 'approved' }, env);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'message')).toBe(1);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(0);
		const design = await createPlanDocRevision(world.db, world.scope, { kind: 'design', body: '# Design brief\n\nOne screen.' });
		await workflowSnapshot(world.db, world.scope);
		await decideDesign(world.db, world.scope, { designId: design.id, decision: 'rejected', note: 'A darker theme.' }, env);
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('design');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'message')).toBe(2);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(0);
	});

	test('resuming a plan that stopped before approval is a Caddie message, refused at 0 before any write', async () => {
		const world = await buildWorld();
		sqlite = world.sqlite;
		await setWorkflowBlocker(world.db, world.scope, 'The plan could not be saved');
		const message = await rejectsCode(
			retryWorkflow(world.db, world.scope, 'resume-plan-1', undefined, { JUDGE_MAX_MESSAGES_PER_DAY: '0' }),
			'JUDGE_LIMIT_MESSAGES',
		);
		expect(message).toBe('Judges can send 0 Caddie messages in 24 hours. Everything else works the same.');
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('blocked');
		expect(count(sqlite, 'select count(*) as n from "workflow_resumes"')).toBe(0);

		await retryWorkflow(world.db, world.scope, 'resume-plan-1', undefined, { JUDGE_MAX_MESSAGES_PER_DAY: '5' });
		expect((await workflowSnapshot(world.db, world.scope)).workflow?.phase).toBe('planning');
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'message')).toBe(1);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'build')).toBe(0);
	});
});

describe('judge limits: paid discovery outside the two Discover buttons', () => {
	let sqlite: BunDatabase;
	let network: ReturnType<typeof recordFetches> | null = null;
	afterEach(() => {
		network?.restore();
		network = null;
		sqlite?.close();
	});
	const KEYS = { TAVILY_API_KEY: 'tvly-not-a-key', NEBIUS_API_KEY: 'nb-not-a-key' };
	const NONE_LEFT = 'Judges can run 0 discovery lookups in 24 hours. Everything else works the same.';

	async function judgeProject() {
		const world = await serviceWorld();
		sqlite = world.sqlite;
		const project = await createProject(world.db, world.wsScope, { workspaceId: world.workspace.id, name: 'Todo app' });
		return { ...world, scope: await projectScopeForUser(world.db, JUDGE_ID, project.id) };
	}

	test('chat discovery and research spend the discovery budget first; at 0 they make no provider call', async () => {
		const world = await judgeProject();
		network = recordFetches();
		const none = paidDiscoveryTools({ DB: world.db, ...KEYS, JUDGE_MAX_DISCOVERY_PER_DAY: '0' }, world.scope);
		await rejectsCode(none.discover({ query: 'climate' }), 'JUDGE_LIMIT_DISCOVERY');
		await rejectsCode(none.research({ query: 'climate hackathon' }), 'JUDGE_LIMIT_DISCOVERY');
		expect(network.calls).toEqual([]);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'discovery')).toBe(0);

		// With room, each call is one lookup and then really runs (offline here, so it fails soft or throws).
		const roomy = paidDiscoveryTools({ DB: world.db, ...KEYS, JUDGE_MAX_DISCOVERY_PER_DAY: '5' }, world.scope);
		await roomy.research({ query: 'climate hackathon' }).catch(() => undefined);
		await roomy.discover({ query: 'climate', limit: 3 }).catch(() => undefined);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'discovery')).toBe(2);
	});

	test('hackathon details: a digest cache miss is one lookup; at 0 the rules still come back, with a plain gap and no model call', async () => {
		const world = await judgeProject();
		const candidate = await seedOneCandidate(world.db, world.scope);
		network = recordFetches();
		const none = paidDiscoveryTools({ DB: world.db, ...KEYS, JUDGE_MAX_DISCOVERY_PER_DAY: '0' }, world.scope);
		const detail = (await none.hackathonDetails({ id: candidate.id })) as { found: boolean; digest: unknown; digestGap: string | null };
		expect(detail.found).toBe(true);
		expect(detail.digest).toBeNull();
		expect(detail.digestGap).toBe(NONE_LEFT);
		expect(network.calls).toEqual([]);
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'discovery')).toBe(0);

		const roomy = paidDiscoveryTools({ DB: world.db, ...KEYS, JUDGE_MAX_DISCOVERY_PER_DAY: '5' }, world.scope);
		await roomy.hackathonDetails({ id: candidate.id });
		expect(await countJudgeUsage(world.db, JUDGE_ID, 'discovery')).toBe(1);
	});

	test('the digest route spends a lookup only on a cache miss; at 0 it answers with a plain gap and no model call', async () => {
		const world = await guardWorld({ judge: true, limits: { JUDGE_MAX_DISCOVERY_PER_DAY: '0' } });
		sqlite = world.sqlite;
		const candidate = await seedOneCandidate(world.db, world.scope);
		network = recordFetches();
		const res = await createDiscoveryRouter().request(
			`${ORIGIN}/projects/${world.project.id}/discovery/candidates/${candidate.id}/digest`,
			{ headers: { cookie: world.cookie } },
			{ ...world.env, NEBIUS_API_KEY: 'nb-not-a-key' },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ digest: null, digestGap: NONE_LEFT });
		expect(network.calls).toEqual([]);
		expect(await countJudgeUsage(world.db, world.user.id, 'discovery')).toBe(0);
	});

	test('the scaffold /agents/hello agent refuses judge accounts; everyone else still reaches it', async () => {
		const judge = await guardWorld({ judge: true });
		judge.app.post('/hello/:id', (c) => c.json({ reached: true }));
		const refused = await judge.app.request(
			`${ORIGIN}/hello/probe`,
			{ method: 'POST', headers: { cookie: judge.cookie, 'content-type': 'application/json' }, body: '{}' },
			judge.env,
		);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe('JUDGE_ACCOUNT');
		judge.sqlite.close();

		const other = await guardWorld({ judge: false });
		sqlite = other.sqlite;
		other.app.post('/hello/:id', (c) => c.json({ reached: true }));
		const allowed = await other.app.request(
			`${ORIGIN}/hello/probe`,
			{ method: 'POST', headers: { cookie: other.cookie, 'content-type': 'application/json' }, body: '{}' },
			other.env,
		);
		expect(allowed.status).toBe(200);
	});
});
