import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import {
	decideDesign,
	decideWorkflow,
	readBuildOutput,
	readPublishBundle,
	startProjectFromChat,
	storeBuildOutput,
	storeImportedOutput,
	workflowSnapshot,
} from '../apps/app/src/server/build-workflow.ts';
import { LocalCodeStore, listCodeVersions, readVersionFiles, recordCodeVersion, snapshotDigest } from '../apps/app/src/server/code-versions.ts';
import type { CodeStore } from '../apps/app/src/server/code-store.ts';
import { readImportPreview } from '../apps/app/src/server/import-preview.ts';
import { EXAMPLE_DESCRIPTION, exampleProjectName, seedJudgeExample, type JudgeExampleDeps } from '../apps/app/src/server/judge-example.ts';
import { admitJudgeProject, countJudgeProjects } from '../apps/app/src/server/judge-limits.ts';
import { createPlanDocRevision, createProject, ensureHomeProject } from '../apps/app/src/server/projects.ts';
import { createJudgeAccessRouter } from '../apps/app/src/server/routes/judge-access.ts';
import { createRun } from '../apps/app/src/server/runs.ts';
import { ScopeError, projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase, sqliteD1 } from './fixtures/sqlite-d1.ts';

/**
 * S07b: a finished example in every judge's workspace. LOCAL VERIFIED
 * in-process: the real migrations over SQLite, the local (D1) code store, the
 * real output store, and for the start route the real Better Auth 1.7.10 and
 * the real judge router. The demo is a real checked build (storeBuildOutput +
 * the version verify_build records for it), as in versions.test.ts.
 */

const f = (path: string, text: string) => ({ path, contentBase64: Buffer.from(text, 'utf8').toString('base64') });
const DEMO_FILES = [f('package.json', '{ "name": "caddie-project" }\n'), f('src/App.tsx', 'export const App = () => "farm log";\n'), f('src/server.ts', 'export default {};\n')];
const SERVER = 'export default { fetch() { return new Response("ok"); } };';
const MIGRATIONS = [{ name: '0001_feed.sql', sql: 'create table feed (id text);\n' }];

function seedJudge(sqlite: Database, userId: string, name = 'judge-one'): void {
	sqlite
		.prepare('insert into "judge_accounts" ("judgeName","userId","state","createdAt","lastSignInAt") values (?,?,?,?,null)')
		.run(name, userId, 'active', new Date().toISOString());
}

/** The judge's projects (not Home), by name. */
function judgeProjects(sqlite: Database, userId: string): { id: string; name: string; kind: string; description: string | null }[] {
	return sqlite
		.query(
			`select p."id", p."name", p."kind", p."description" from "projects" p
			 join "workspace_memberships" m on m."workspaceId" = p."workspaceId"
			 where m."userId" = ? and p."kind" <> 'home' order by p."createdAt"`,
		)
		.all(userId) as { id: string; name: string; kind: string; description: string | null }[];
}

describe('a finished example in every judge workspace (S07b)', () => {
	let sqlite: Database;
	let db: D1Database;
	let store: LocalCodeStore;
	let demo: Scope;
	let planId = '';
	let runId = '';

	/** One checked build of the demo: its stored output and the version verify_build records for it. */
	async function checkedBuild(files: ReturnType<typeof f>[], title: string, bundle: { client?: boolean } = {}) {
		sqlite.prepare('update build_workflows set phase = ? where projectId = ?').run('building', demo.projectId);
		const output = await storeBuildOutput(db, demo, {
			html: `<!doctype html><html><body>${title}</body></html>`,
			image: `img-${title}`,
			planId,
			runId,
			bundle: { server: SERVER, migrations: MIGRATIONS, ...(bundle.client === false ? {} : { client: { js: `app("${title}")`, css: 'h1{color:green}' } }) },
		});
		const { version } = await recordCodeVersion(db, store, demo, { kind: 'build', title, files, planId, image: `img-${title}`, outputId: output.outputId, actorId: 'owner' });
		return { outputId: output.outputId, commitId: version.commitId };
	}

	const deps = (overrides: Partial<JudgeExampleDeps> = {}): JudgeExampleDeps => ({ db, store, demoProjectId: demo.projectId, ...overrides });

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		store = new LocalCodeStore(db);
		addUser(sqlite, 'owner', 'owner@example.com');
		addUser(sqlite, 'judge-1', 'judge-one@judges.caddie.invalid');
		seedJudge(sqlite, 'judge-1');
		const home = await ensureHomeProject(db, 'owner');
		const homeScope = await projectScopeForUser(db, 'owner', home.id);
		const homeRun = await createRun(db, homeScope, { modelRouteId: 'nemotron-3-super', payerId: 'owner', conversationId: 'conv-home' });
		const started = await startProjectFromChat(db, homeScope, {
			name: 'Farm Log',
			description: 'Log feed.',
			brief: 'Build a farm log. Show me the plan first.',
			operationKey: 'create-farm',
			sourceConversationId: homeRun.conversationId,
		});
		demo = await projectScopeForUser(db, 'owner', started.project.id);
		runId = started.workflow.runId as string;
		planId = (await createPlanDocRevision(db, demo, { kind: 'prd', body: '# Farm log\n\nLog feed.' })).id;
		await workflowSnapshot(db, demo);
		await decideWorkflow(db, demo, { planId, decision: 'approved' });
		const design = await createPlanDocRevision(db, demo, { kind: 'design', body: '# Design\n\nOne screen.' });
		await workflowSnapshot(db, demo);
		await decideDesign(db, demo, { designId: design.id, decision: 'approved' });
	});

	afterEach(() => sqlite.close());

	test("copies the demo's newest checked version into the judge's workspace, ready to try", async () => {
		await checkedBuild([f('src/App.tsx', 'first')], 'first');
		const newest = await checkedBuild(DEMO_FILES, 'second');
		// A newer version with no checked preview is skipped: only checked code is copied.
		await recordCodeVersion(db, store, demo, { kind: 'feature', title: 'half-done', files: [f('src/App.tsx', 'wip')], actorId: 'owner' });

		const result = await seedJudgeExample(deps(), 'judge-1');
		expect(result).toMatchObject({ status: 'seeded', versionSeq: 1 });
		const [example] = judgeProjects(sqlite, 'judge-1');
		expect(example).toMatchObject({ name: exampleProjectName('Farm Log'), kind: 'standard', description: EXAMPLE_DESCRIPTION });
		// It sits in the judge's own workspace, next to their Home.
		const judgeHome = await ensureHomeProject(db, 'judge-1');
		const scope = await projectScopeForUser(db, 'judge-1', example!.id);
		expect(scope.workspaceId).toBe(judgeHome.workspaceId);

		// Version 1 is exactly the demo's newest checked code, with its preview.
		const [version] = await listCodeVersions(db, scope);
		expect(version).toMatchObject({ seq: 1, kind: 'import', title: 'Example app: Farm Log' });
		const files = await readVersionFiles(store, scope.projectId, version!.commitId);
		expect(await snapshotDigest(files)).toBe(await snapshotDigest(await readVersionFiles(store, demo.projectId, newest.commitId)));

		// The project card shows it ready: the same preview, client files, server and migrations.
		const preview = await readImportPreview(db, scope);
		expect(preview).toMatchObject({ status: 'ready', origin: 'example', repoFullName: 'Farm Log', versionSeq: 1, hasServer: true, message: null });
		expect(version!.outputId).toBe(preview!.outputId);
		expect(new TextDecoder().decode(await readBuildOutput(db, scope, preview!.outputId!))).toContain('second');
		const copied = await readPublishBundle(db, scope, preview!.outputId!);
		const original = await readPublishBundle(db, demo, newest.outputId);
		expect(copied).toEqual(original);

		// The demo is untouched, and the judge cannot reach it.
		expect((await listCodeVersions(db, demo)).map((v) => v.seq)).toEqual([3, 2, 1]);
		await expect(projectScopeForUser(db, 'judge-1', demo.projectId)).rejects.toThrow(ScopeError);
	});

	test("is not one of the judge's own projects: the three-project allowance is untouched", async () => {
		await checkedBuild(DEMO_FILES, 'demo');
		await seedJudgeExample(deps(), 'judge-1');
		expect(await countJudgeProjects(db, 'judge-1')).toBe(0);
		const home = await ensureHomeProject(db, 'judge-1');
		const workspace = await workspaceScopeForUser(db, 'judge-1', home.workspaceId);
		for (const name of ['One', 'Two', 'Three']) await createProject(db, workspace, { workspaceId: home.workspaceId, name }, {});
		expect(await countJudgeProjects(db, 'judge-1')).toBe(3);
		await expect(admitJudgeProject(db, 'judge-1', {})).rejects.toMatchObject({ code: 'JUDGE_LIMIT_PROJECTS' });
		expect(judgeProjects(sqlite, 'judge-1').map((p) => p.name)).toEqual([exampleProjectName('Farm Log'), 'One', 'Two', 'Three']);
	});

	test('runs once per judge', async () => {
		await checkedBuild(DEMO_FILES, 'demo');
		expect((await seedJudgeExample(deps(), 'judge-1')).status).toBe('seeded');
		expect(await seedJudgeExample(deps(), 'judge-1')).toEqual({ status: 'skipped', reason: 'already_seeded' });
		expect(judgeProjects(sqlite, 'judge-1')).toHaveLength(1);
	});

	test('nothing to copy: unset, unknown, Home, no checked version, or checked before client files were kept', async () => {
		expect(await seedJudgeExample(deps({ demoProjectId: undefined }), 'judge-1')).toEqual({ status: 'skipped', reason: 'not_configured' });
		expect(await seedJudgeExample(deps({ demoProjectId: '  ' }), 'judge-1')).toEqual({ status: 'skipped', reason: 'not_configured' });
		expect(await seedJudgeExample(deps({ demoProjectId: 'proj_missing' }), 'judge-1')).toEqual({ status: 'skipped', reason: 'demo_not_found' });
		const ownerHome = await ensureHomeProject(db, 'owner');
		expect(await seedJudgeExample(deps({ demoProjectId: ownerHome.id }), 'judge-1')).toEqual({ status: 'skipped', reason: 'demo_not_found' });
		expect(await seedJudgeExample(deps(), 'judge-1')).toEqual({ status: 'skipped', reason: 'no_checked_version' });
		await checkedBuild(DEMO_FILES, 'old', { client: false });
		expect(await seedJudgeExample(deps(), 'judge-1')).toEqual({ status: 'skipped', reason: 'not_publishable' });
		expect(judgeProjects(sqlite, 'judge-1')).toHaveLength(0);
	});

	test('a failure part way leaves nothing behind', async () => {
		await checkedBuild(DEMO_FILES, 'demo');
		const failing: CodeStore = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
			commit: async () => {
				throw new Error('code store unavailable');
			},
		});
		await expect(seedJudgeExample(deps({ store: failing }), 'judge-1')).rejects.toThrow('code store unavailable');
		expect(judgeProjects(sqlite, 'judge-1')).toHaveLength(0);
		expect(Number((sqlite.query('select count(*) as n from import_previews').get() as { n: number }).n)).toBe(0);
		// The judge can still be given the example on a later try.
		expect((await seedJudgeExample(deps(), 'judge-1')).status).toBe('seeded');
	});
});

describe('POST /api/judge/start adds the example', () => {
	const ORIGIN = 'http://127.0.0.1:8787';
	const CODE = 'judge-code-0123456789';
	let sqlite: Database;
	let db: D1Database;
	let demoProjectId = '';
	const router = createJudgeAccessRouter();

	/**
	 * Real D1's batch returns each statement's rows AND its meta. The shared
	 * shim returns run() metas only, which Better Auth's schema check cannot
	 * read; judge-access.test.ts swaps in all() results, which the local code
	 * store's compare-and-set cannot read. This route test needs both, so its
	 * batch runs reads with all() and writes with run(), in one transaction.
	 */
	function withFullD1Batch(raw: Database): D1Database {
		const inner = sqliteD1(raw) as unknown as { prepare(sql: string): Record<string, unknown> };
		const wrap = (sql: string, statement: Record<string, unknown>): Record<string, unknown> => ({
			...statement,
			sql,
			bind: (...values: unknown[]) => wrap(sql, (statement['bind'] as (...v: unknown[]) => Record<string, unknown>)(...values)),
		});
		return {
			...(inner as object),
			prepare: (sql: string) => wrap(sql, inner.prepare(sql)),
			batch: (statements: Array<{ sql: string; all(): unknown; run(): unknown }>) =>
				raw.transaction(() => statements.map((statement) => (/^\s*(select|pragma|with)\b/i.test(statement.sql) ? statement.all() : statement.run())))(),
		} as unknown as D1Database;
	}

	const envOf = (overrides: Record<string, unknown> = {}) =>
		({
			DB: db,
			BETTER_AUTH_SECRET: 'judge-test-secret-0123456789abcdef',
			BETTER_AUTH_URL: ORIGIN,
			INVITE_ALLOWLIST: 'owner@example.com',
			JUDGE_ACCESS_CODE: CODE,
			JUDGE_ACCESS_UNTIL: '2099-01-01',
			JUDGE_EXAMPLE_PROJECT_ID: demoProjectId,
			...overrides,
		}) as never;
	const start = (env: never, name = 'judge-one') =>
		router.request(
			`${ORIGIN}/judge/start`,
			{ method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ code: CODE, name, password: 'a-long-enough-password' }) },
			env,
		);
	const judgeUser = (name: string) => String((sqlite.query('select "userId" from "judge_accounts" where "judgeName" = ?').get(name) as { userId: string }).userId);

	beforeEach(async () => {
		const migrated = migratedDatabase();
		sqlite = migrated.sqlite;
		db = withFullD1Batch(sqlite);
		addUser(sqlite, 'owner', 'owner@example.com');
		const store = new LocalCodeStore(db);
		const home = await ensureHomeProject(db, 'owner');
		const workspace = await workspaceScopeForUser(db, 'owner', home.workspaceId);
		const project = await createProject(db, workspace, { workspaceId: home.workspaceId, name: 'Farm Log' }, {});
		demoProjectId = project.id;
		const scope = await projectScopeForUser(db, 'owner', project.id);
		const { version } = await recordCodeVersion(db, store, scope, { kind: 'build', title: 'demo', files: DEMO_FILES, actorId: 'owner' });
		// A checked output for that version (the copied-app preview path needs no workflow).
		const output = await storeImportedOutput(db, scope, {
			html: '<!doctype html><html><body>demo</body></html>',
			image: 'img-demo',
			commitId: version.commitId,
			bundle: { server: null, migrations: [], client: { js: 'app()', css: '' } },
		});
		sqlite.prepare('update "code_versions" set "outputId" = ? where "projectId" = ? and "commitId" = ?').run(output.outputId, project.id, version.commitId);
	});
	afterEach(() => sqlite.close());

	test("a new judge finds the example ready in their workspace", async () => {
		const res = await start(envOf());
		expect(res.status).toBe(200);
		expect(res.headers.get('set-cookie') ?? '').toContain('better-auth.session_token');
		const projects = judgeProjects(sqlite, judgeUser('judge-one'));
		expect(projects.map((p) => p.name)).toEqual([exampleProjectName('Farm Log')]);
		const scope = await projectScopeForUser(db, judgeUser('judge-one'), projects[0]!.id);
		expect(await readImportPreview(db, scope)).toMatchObject({ status: 'ready', origin: 'example', repoFullName: 'Farm Log' });
	});

	test('a judge start never fails because of the example', async () => {
		// The demo's version points at code the store no longer has.
		sqlite.prepare('update "code_versions" set "commitId" = ? where "projectId" = ?').run('missing-commit', demoProjectId);
		const res = await start(envOf());
		expect(res.status).toBe(200);
		expect(judgeProjects(sqlite, judgeUser('judge-one'))).toHaveLength(0);
	});

	test('without JUDGE_EXAMPLE_PROJECT_ID nothing is added', async () => {
		const res = await start(envOf({ JUDGE_EXAMPLE_PROJECT_ID: undefined }));
		expect(res.status).toBe(200);
		expect(judgeProjects(sqlite, judgeUser('judge-one'))).toHaveLength(0);
	});
});
