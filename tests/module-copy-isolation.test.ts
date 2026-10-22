import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	InMemorySandboxPersistence,
	SandboxDriver,
} from '../apps/app/src/server/adapters/sandbox.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject, createPlanDocRevision } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import { resolveModuleBuilderContext, resolveCoordinatorContext, type CoordinatorEnvironment } from '../apps/app/src/server/coordinator-host.ts';
import { openModuleWorkingCopy } from '../apps/app/src/server/modules.ts';
import { getModule, seedModules } from '../apps/app/src/server/module-slots.ts';
import type { ArchitectureBlock, Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';

/**
 * Lane 12 (part P) — gaps 1 and 2 from the lead review.
 *
 * GAP 1 (a module's copy is its own): openModuleWorkingCopy opens the module's
 * own session key `module:<runId>:<moduleId>` directly from the module row's
 * start save point, and NEVER reads or writes the project-level
 * `build_sandbox_sessions` pointer. Proven over the REAL SandboxDriver + the
 * local contree stub (the P04/P05 contract transport): the main host and two
 * module hosts keep three distinct sessions, a file in the start image is in
 * each module copy, and the project's pointer stays empty.
 *
 * GAP 2 (a module stopping stops the whole build): in module scope a repair
 * pause and report_blocker stop ONLY that module (stopModule/failModule, slot
 * freed) and the build phase stays `building`. Proven through the REAL
 * module-scoped host context (resolveModuleBuilderContext → blockBuild), which
 * does the DB-only stop without touching the sandbox.
 *
 * LOCAL VERIFIED for the driver↔contree transport and the DB-backed flow; never
 * evidence about the live sandbox or a real model turn. Each test names the
 * MUTATION (the key line that, reverted, flips the outcome); the reverts were
 * run under the lane's copy-revert-cmp protocol.
 */

const TOKEN = 'stub-token-local-only-not-a-secret';
const IMAGE_TAG = 'tag:base:1';
const WORKSPACE_ROOT = '/workspace';
const BUILD_SEQ = 0;

const SMALL_BLOCK: ArchitectureBlock = {
	version: 2,
	signIn: 'required',
	team: null,
	modules: [{ id: 'app', plain: 'The app', dependsOn: [] }],
	tables: [],
	routes: [],
	screens: [],
	services: [],
	ai: [],
	payments: null,
	emails: [],
	jobs: [],
	screenOnly: [],
};

async function seedProject(opts: { teamMode?: boolean; bigApps?: boolean } = {}): Promise<{
	sqlite: Database;
	db: D1Database;
	scope: Scope;
	projectId: string;
	root: string;
	runId: string;
	conversationId: string;
}> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Farm' });
	const scope = await projectScopeForUser(db, 'alice', project.id);
	const runId = `run_${project.id}`;
	const conversationId = `conv_${project.id}`;
	const design = ['# Design', '```caddie-architecture', JSON.stringify(SMALL_BLOCK), '```'].join('\n');
	const revision = await createPlanDocRevision(db, scope, { kind: 'design', body: design });
	const now = new Date().toISOString();
	await db
		.prepare(
			'insert into "run_bindings" ("runId","projectId","conversationId","submissionId","planRevision","stackId","payerId","modelRouteId","pricingVersion","createdBy","createdAt") ' +
				'values (?,?,?,?,?,?,?,?,?,?,?)',
		)
		.bind(runId, project.id, conversationId, `sub_${project.id}`, revision.id, 'react-hono', 'alice', 'route', 'v1', 'alice', now)
		.run();
	await db
		.prepare(
			'insert into "build_workflows" ("projectId","runId","conversationId","intakeKey","brief","phase","updatedAt","teamMode","bigApps","approvedDesignRevisionId") ' +
				'values (?,?,?,?,?,?,?,?,?,?)',
		)
		.bind(project.id, runId, conversationId, `intake_${project.id}`, 'brief', 'building', now, opts.teamMode ? 1 : 0, opts.bigApps ? 1 : 0, revision.id)
		.run();
	return { sqlite, db, scope, projectId: project.id, root: `${WORKSPACE_ROOT}/${project.id}`, runId, conversationId };
}

/** Rows of the project-level session pointer the module path must never touch. */
async function sandboxSessionRows(db: D1Database, projectId: string): Promise<unknown[]> {
	const res = await db
		.prepare('select * from "build_sandbox_sessions" where "projectId" = ?')
		.bind(projectId)
		.all<Record<string, unknown>>();
	return res.results ?? [];
}

describe('gap 1 — a module builder opens its OWN copy, never the project pointer', () => {
	let stub: SandboxStub;
	beforeAll(async () => {
		stub = new SandboxStub({ expectedToken: TOKEN });
		stub.seedImage(IMAGE_TAG);
		await stub.start();
	});
	afterAll(async () => {
		await stub.stop();
	});

	function makeDriver(): SandboxDriver {
		return new SandboxDriver(
			{
				contree: { baseUrl: stub.url, apiToken: TOKEN, platformProjectId: 'platform-project-test' },
				quotas: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 64 * 1024, maxCommandTimeoutMs: 30_000 },
				workspaceRoot: WORKSPACE_ROOT,
				pollIntervalMs: 5,
				dispatchTimeoutMs: 2_000,
			},
			new InMemorySandboxPersistence(),
		);
	}

	test('three distinct sessions; the start-image file is in each module copy; the project pointer is untouched', async () => {
		const { sqlite, db, scope, projectId, root, runId } = await seedProject({ teamMode: true, bigApps: true });
		const driver = makeDriver();

		// The MAIN build's session, with a file committed into its image — this
		// image becomes the modules' start save point (the latest merged save).
		const { sessionId: mainSession } = await driver.ensureSession({ sessionKey: `session:${runId}`, image: IMAGE_TAG, projectId, runId });
		await driver.writeFile(mainSession, `${root}/src/App.tsx`, Buffer.from('export const App = () => "foundation";', 'utf8').toString('base64'));
		const startImage = (await driver.checkpoint(mainSession)).checkpointRef;

		// Two module rows, each restored from that start save point (checkpointRef).
		await seedModules(db, scope, {
			buildSeq: BUILD_SEQ,
			payerId: 'build:run1:1',
			modules: [{ moduleId: 'feed', dependsOn: [] }, { moduleId: 'tasks', dependsOn: [] }],
		});
		for (const m of ['feed', 'tasks']) {
			await db
				.prepare('update "build_modules" set "checkpointRef" = ? where "projectId" = ? and "buildSeq" = ? and "moduleId" = ?')
				.bind(startImage, projectId, BUILD_SEQ, m)
				.run();
		}

		// Open each module's own copy. MUTATION: if openModuleWorkingCopy read
		// `build_sandbox_sessions` or the main `session:<runId>` key instead of
		// `module:<runId>:<moduleId>`, the three session keys would not be distinct.
		const feedSession = await openModuleWorkingCopy({
			db, driver, scope, runId, buildSeq: BUILD_SEQ, moduleId: 'feed', sessionKey: `module:${runId}:feed`, baseImage: IMAGE_TAG,
		});
		const tasksSession = await openModuleWorkingCopy({
			db, driver, scope, runId, buildSeq: BUILD_SEQ, moduleId: 'tasks', sessionKey: `module:${runId}:tasks`, baseImage: IMAGE_TAG,
		});

		// Three distinct sessions.
		expect(new Set([mainSession, feedSession, tasksSession]).size).toBe(3);
		expect(feedSession).toBe(`module:${runId}:feed`);
		expect(tasksSession).toBe(`module:${runId}:tasks`);

		// The start-image file is present in each module's own copy.
		for (const session of [feedSession, tasksSession]) {
			const read = await driver.readFile(session, `${root}/src/App.tsx`);
			expect(Buffer.from(read.contentBase64, 'base64').toString('utf8')).toContain('foundation');
		}

		// The project's pointer was NEVER written by the module path.
		expect(await sandboxSessionRows(db, projectId)).toHaveLength(0);
		sqlite.close();
	});

	test('a module with no build_modules row is refused (never silently handed a session)', async () => {
		const { sqlite, db, scope, projectId, runId } = await seedProject({ teamMode: true, bigApps: true });
		const driver = makeDriver();
		await expect(
			openModuleWorkingCopy({ db, driver, scope, runId, buildSeq: BUILD_SEQ, moduleId: 'ghost', sessionKey: `module:${runId}:ghost`, baseImage: IMAGE_TAG }),
		).rejects.toThrow(/MODULE_NOT_FOUND|No build module/);
		expect(await sandboxSessionRows(db, projectId)).toHaveLength(0);
		sqlite.close();
	});
});

describe('gap 2 — a module stopping does not stop the whole build', () => {
	/** A CoordinatorEnvironment with only DB (no CONTREE): construction and
	 *  blockBuild need no sandbox; the tools that would are never called. */
	function envFor(db: D1Database): CoordinatorEnvironment {
		return { DB: db } as unknown as CoordinatorEnvironment;
	}

	async function workflowPhase(db: D1Database, projectId: string): Promise<string> {
		const res = await db.prepare('select "phase" from "build_workflows" where "projectId" = ?').bind(projectId).all<{ phase: string }>();
		return String(res.results?.[0]?.phase);
	}

	test('report_blocker in module scope stops ONLY that module; the build phase stays building and the sibling is untouched', async () => {
		const { sqlite, db, scope, projectId, conversationId } = await seedProject({ teamMode: true, bigApps: true });
		await seedModules(db, scope, {
			buildSeq: BUILD_SEQ,
			payerId: 'build:run1:1',
			modules: [{ moduleId: 'feed', dependsOn: [] }, { moduleId: 'tasks', dependsOn: [] }],
		});
		// Both modules are building (the stop DB path does not need a slot row).
		await db.prepare('update "build_modules" set "status" = \'building\' where "projectId" = ?').bind(projectId).run();

		// The module-scoped host context for `feed`. report_blocker → blockBuild.
		const feedCtx = await resolveModuleBuilderContext(envFor(db), {
			conversationId, moduleId: 'feed', buildSeq: BUILD_SEQ, features: ['feed-feature'],
		});
		// MUTATION: route blockBuild to setWorkflowBlocker (today's build-wide
		// behaviour) instead of blockOrStop→stopModule, and the workflow phase
		// would flip to 'blocked' and feed would stay 'building'.
		await feedCtx.blockBuild('a real prerequisite is missing for feed');

		expect(await workflowPhase(db, projectId)).toBe('building'); // the BUILD keeps going
		const feed = await getModule(db, projectId, BUILD_SEQ, 'feed');
		const tasks = await getModule(db, projectId, BUILD_SEQ, 'tasks');
		expect(feed?.status).toBe('stopped'); // only feed stopped
		expect(tasks?.status).toBe('building'); // the sibling is untouched
		sqlite.close();
	});

	test('a module in the coordinator (no module scope) blocks the whole build, as before', async () => {
		const { sqlite, db, projectId, conversationId } = await seedProject({ teamMode: true, bigApps: false });
		// No module scope: the coordinator path. blockBuild must block the whole
		// workflow (today's behaviour), proving the seam is module-only.
		const ctx = await resolveCoordinatorContext(envFor(db), conversationId);
		await ctx.blockBuild('a build-wide blocker');
		expect(await workflowPhase(db, projectId)).toBe('blocked');
		sqlite.close();
	});
});
