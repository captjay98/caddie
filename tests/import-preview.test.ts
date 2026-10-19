import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { buildSandboxFromEnv } from '../apps/app/src/server/build-sandbox.ts';
import { readBuildBundle, readBuildOutput } from '../apps/app/src/server/build-workflow.ts';
import { LocalCodeStore, listCodeVersions, recordCodeVersion } from '../apps/app/src/server/code-versions.ts';
import {
	IMPORT_PREVIEW_DEADLINE_MS,
	IMPORT_PREVIEW_MESSAGES,
	advanceImportPreviews,
	beginImportPreview,
	checkImportedApp,
	importPreviewDepsFromEnv,
	readImportPreview,
	type ImportPreviewDeps,
} from '../apps/app/src/server/import-preview.ts';
import type { WorkerLoaderLike } from '../apps/app/src/server/preview-runtime.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * The copied app's preview ("Start from my GitHub repo"): the real sandbox
 * driver against the local sandbox stand-in (SIMULATED sandbox), the real code
 * store and output records on the real migrations (LOCAL VERIFIED).
 */

const IMAGE = 'tag:import-base:1';
const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const APP_FILES: Record<string, string> = {
	'package.json': '{ "name": "caddie-project" }\n',
	'bun.lock': '{ "lockfileVersion": 1 }\n',
	'src/main.tsx': 'import "./App";\n',
	'src/App.tsx': 'export function App() { return <h1>Farm log</h1>; }\n',
};

let sqlite: Database;
let db: D1Database;
let stub: SandboxStub;
let scope: Scope;
let commitId = '';

const loader = (status: number) =>
	({ get: () => ({ getEntrypoint: () => ({ fetch: async () => new Response(status === 200 ? 'ok' : 'Bun is not defined', { status }) }) }) }) as unknown as WorkerLoaderLike;

function deps(overrides: Partial<ImportPreviewDeps> = {}): ImportPreviewDeps {
	const env = { DB: db, CONTREE_BASE_URL: stub.url, CONTREE_API_TOKEN: 'local-import-token', CONTREE_PROJECT_ID: 'local-project' };
	return { db, store: new LocalCodeStore(db), driver: buildSandboxFromEnv(env), baseImage: IMAGE, ...overrides };
}

/** The sandbox commands the stand-in was asked to run. */
const commands = () =>
	stub.requests
		.map((request) => (request.body as { command?: unknown } | null)?.command)
		.filter((command): command is string => typeof command === 'string' && command.startsWith('bun '));

async function copiedApp(files: Record<string, string> = APP_FILES) {
	const { version } = await recordCodeVersion(db, new LocalCodeStore(db), scope, {
		kind: 'import',
		title: 'Copied from octo-farm/farm-log',
		files: Object.entries(files).map(([path, text]) => ({ path, contentBase64: encode(text) })),
		skipped: [],
		actorId: scope.actorId,
	});
	commitId = version.commitId;
	await beginImportPreview(db, scope, { commitId, versionSeq: version.seq, repoFullName: 'octo-farm/farm-log' });
	return version;
}

const root = () => `/workspace/${scope.projectId}`;
const builds = (writes: Record<string, string>) => stub.setBehavior('bun run build', { stdout: 'built', writes });

beforeEach(async () => {
	({ sqlite, db } = migratedDatabase());
	addUser(sqlite, 'alice', 'alice@example.com');
	const workspace = await createWorkspace(db, 'alice', { name: 'Farm' });
	const workspaceScope = await workspaceScopeForUser(db, 'alice', workspace.id);
	const project = await createProject(db, workspaceScope, { workspaceId: workspace.id, name: 'Farm log', description: 'Copied from GitHub.' });
	scope = await projectScopeForUser(db, 'alice', project.id);
	stub = new SandboxStub({ expectedToken: 'local-import-token' });
	stub.seedImage(IMAGE);
	stub.setBehavior('bun install', { stdout: 'installed' });
	await stub.start();
});
afterEach(async () => {
	await stub.stop();
	sqlite.close();
});

describe('the copied app, right after the copy', () => {
	test('is built without AI and becomes version 1 with a preview', async () => {
		await copiedApp();
		expect(await readImportPreview(db, scope)).toMatchObject({ status: 'checking', versionSeq: 1, repoFullName: 'octo-farm/farm-log', outputId: null });
		builds({ [`${root()}/dist/main.js`]: 'console.log("farm log")', [`${root()}/dist/main.css`]: 'h1 { color: green }' });

		const ready = await checkImportedApp(deps(), scope);
		expect(ready).toMatchObject({ status: 'ready', hasServer: false, message: null });
		expect(commands()).toEqual(['bun install --frozen-lockfile', 'bun run build']);
		const html = new TextDecoder().decode(await readBuildOutput(db, scope, ready!.outputId!));
		expect(html).toContain('console.log("farm log")');
		expect(html).toContain('h1 { color: green }');
		// Versions can go back to it later: the imported version now has the preview and a working copy.
		const [version] = await listCodeVersions(db, scope);
		expect(version).toMatchObject({ seq: 1, kind: 'import', outputId: ready!.outputId, hasImage: true });

		// Asking again changes nothing and runs nothing.
		expect(await checkImportedApp(deps(), scope)).toEqual(ready);
		expect(commands()).toHaveLength(2);
	});

	test('an app with a server keeps its server and migrations, and the server must start on Cloudflare', async () => {
		await copiedApp({ ...APP_FILES, 'src/server.ts': 'export default {};\n', 'migrations/0001_notes.sql': 'create table notes (id text);\n' });
		builds({ [`${root()}/dist/main.js`]: 'app()', [`${root()}/dist/server.js`]: 'export default { fetch() { return new Response("ok") } }' });
		const ready = await checkImportedApp(deps({ loader: loader(200) }), scope);
		expect(ready).toMatchObject({ status: 'ready', hasServer: true });
		const bundle = await readBuildBundle(db, scope, ready!.outputId!);
		expect(bundle?.server).toContain('fetch()');
		expect(bundle?.migrations).toEqual([{ name: '0001_notes.sql', sql: 'create table notes (id text);\n' }]);
	});

	test("a server that doesn't start on Cloudflare is reported in plain words, and nothing is shown", async () => {
		await copiedApp({ ...APP_FILES, 'src/server.ts': 'export default {};\n' });
		builds({ [`${root()}/dist/main.js`]: 'app()', [`${root()}/dist/server.js`]: 'Bun.serve({})' });
		const failed = await checkImportedApp(deps({ loader: loader(500) }), scope);
		expect(failed).toMatchObject({ status: 'failed', outputId: null, message: IMPORT_PREVIEW_MESSAGES.serverFailed(1) });
		expect((await listCodeVersions(db, scope))[0]).toMatchObject({ outputId: null });
	});

	test('a build that fails is reported in plain words, and the code stays saved as version 1', async () => {
		await copiedApp();
		stub.setBehavior('bun run build', { exitCode: 1, stderr: 'error: Could not resolve "./Missing"' });
		const failed = await checkImportedApp(deps(), scope);
		expect(failed).toMatchObject({ status: 'failed', outputId: null, message: IMPORT_PREVIEW_MESSAGES.buildFailed(1) });
		expect(failed!.message).not.toContain('Could not resolve');
		// The log tail is kept for diagnosis, never shown.
		expect(String(sqlite.query('select detail from import_previews').get()?.['detail' as never])).toContain('Could not resolve');
		expect(await listCodeVersions(db, scope)).toHaveLength(1);
	});

	test('every pinned package is checked against bun.lock before Bun installs', async () => {
		await copiedApp();
		builds({ [`${root()}/dist/main.js`]: 'app()' });
		expect(await checkImportedApp(deps(), scope)).toMatchObject({ status: 'ready' });
		const spawned = stub.spawnedCommands();
		const check = spawned.findIndex((command) => command.includes('caddie-verified-install'));
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(spawned.indexOf('bun install --frozen-lockfile'));
	});

	test('a package that fails its check is never installed, and nothing is built', async () => {
		await copiedApp();
		stub.setBehavior('caddie-verified-install', {
			exitCode: 1,
			stderr: 'verified-install: 1 package(s) failed, so nothing more was installed:\n  - react-dom@19.2.0: the downloaded tarball does not match the sha512 in bun.lock, so it was not unpacked',
		});
		const failed = await checkImportedApp(deps(), scope);
		expect(failed).toMatchObject({ status: 'failed', outputId: null, message: IMPORT_PREVIEW_MESSAGES.buildFailed(1) });
		expect(commands()).toEqual([]);
		expect(String(sqlite.query('select detail from import_previews').get()?.['detail' as never])).toContain('react-dom@19.2.0');
	});

	test('two calls at once: one builds, the other just reports "checking", and nothing runs twice', async () => {
		await copiedApp();
		stub.setBehavior('bun install', { stdout: 'installed', delayMs: 400 });
		builds({ [`${root()}/dist/main.js`]: 'app()' });
		const [first, second] = await Promise.all([checkImportedApp(deps(), scope), checkImportedApp(deps(), scope)]);
		expect([first!.status, second!.status].sort()).toEqual(['checking', 'ready']);
		expect(commands()).toEqual(['bun install --frozen-lockfile', 'bun run build']);
		// The one that saw "checking" finds it ready next time, without running anything.
		expect((await checkImportedApp(deps(), scope))!.status).toBe('ready');
		expect(commands()).toHaveLength(2);
	});

	test('without a build sandbox, plain words and the code stays saved', async () => {
		await copiedApp();
		expect(await checkImportedApp(deps({ driver: null }), scope)).toMatchObject({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.noSandbox(1) });
	});

	test('a check still unfinished after its deadline is given up on', async () => {
		await copiedApp();
		const later = () => new Date(Date.now() + IMPORT_PREVIEW_DEADLINE_MS + 60_000);
		expect(await checkImportedApp(deps({ now: later }), scope)).toMatchObject({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.gaveUp(1) });
		expect(commands()).toHaveLength(0);
	});

	test('repeated unexplained sandbox errors give up after three tries', async () => {
		await copiedApp();
		const broken = { ...deps().driver!, ensureSession: async () => { throw new Error('sandbox unreachable'); } } as unknown as ImportPreviewDeps['driver'];
		expect((await checkImportedApp(deps({ driver: broken }), scope))!.status).toBe('checking');
		expect((await checkImportedApp(deps({ driver: broken }), scope))!.status).toBe('checking');
		expect(await checkImportedApp(deps({ driver: broken }), scope)).toMatchObject({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.gaveUp(1) });
	});

	test('the 5-minute cron finishes a check nobody has open, and leaves fresh ones alone', async () => {
		await copiedApp();
		builds({ [`${root()}/dist/main.js`]: 'app()' });
		expect(await advanceImportPreviews(deps())).toBe(0);
		expect((await readImportPreview(db, scope))!.status).toBe('checking');
		sqlite.prepare('update import_previews set updatedAt = ?').run(new Date(Date.now() - 10 * 60_000).toISOString());
		expect(await advanceImportPreviews(deps())).toBe(1);
		expect((await readImportPreview(db, scope))!.status).toBe('ready');
	});

	test('the route and the cron read the same setup from the Worker env', () => {
		const bare = importPreviewDepsFromEnv({ DB: db });
		expect(bare.driver).toBeNull();
		expect(bare.store.kind).toBe('local');
		expect(bare.baseImage).toBe('tag:tt-base:1');
		expect(bare.loader).toBeUndefined();
		const full = importPreviewDepsFromEnv({
			DB: db,
			CONTREE_BASE_URL: stub.url,
			CONTREE_API_TOKEN: 'local-import-token',
			CONTREE_PROJECT_ID: 'local-project',
			CONTREE_IMAGE: IMAGE,
			LOADER: loader(200),
		});
		expect(full.driver).not.toBeNull();
		expect(full.baseImage).toBe(IMAGE);
		expect(full.loader).toBeDefined();
	});
});
