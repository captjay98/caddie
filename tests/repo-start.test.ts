import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { GithubRestClient } from '../apps/app/src/server/adapters/github.ts';
import { LocalCodeStore, listCodeVersions, readVersionFiles } from '../apps/app/src/server/code-versions.ts';
import { createProject, createWorkspace, getProject } from '../apps/app/src/server/projects.ts';
import { bindInstallation, importRepoSnapshot, processGithubWebhook } from '../apps/app/src/server/repositories.ts';
import { checkCaddieApp, startFromImport } from '../apps/app/src/server/repo-start.ts';
import { readImportPreview } from '../apps/app/src/server/import-preview.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { SCAFFOLD_FILES, SCAFFOLD_PACKAGE } from '../stacks/react-hono/scaffold.ts';
import { freePort } from './fixtures/controls-harness.ts';
import { GithubStub } from './fixtures/github-stub.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * "Start from my GitHub repo": the real GitHub REST client against the local
 * GitHub stand-in (SIMULATED GitHub), the real import and the real code store
 * on the real migrations (LOCAL VERIFIED).
 */

const INSTALLATION = '7200001';
const ACCOUNT = 'octo-farm';
const caddiePackage = JSON.stringify({ ...SCAFFOLD_PACKAGE, dependencies: { ...SCAFFOLD_PACKAGE.dependencies } }, null, 2);
const CADDIE_APP = {
	'package.json': caddiePackage,
	'bun.lock': '{ "lockfileVersion": 1 }\n',
	'src/main.tsx': 'import "./App";\n',
	'src/App.tsx': 'export function App() { return <h1>Farm log</h1>; }\n',
	'src/server.ts': 'export default {};\n',
	'caddie/d1.ts': '// an older copy of the D1 types\n',
	'.env': 'NEBIUS_API_KEY=never-copy-me\n',
	'.env.example': 'NEBIUS_API_KEY=\n',
	'node_modules/react/index.js': 'module.exports = {};\n',
	'dist/main.js': 'built();\n',
};

let sqlite: Database;
let db: D1Database;
let github: GithubStub;
let client: GithubRestClient;
let workspaceScope: Awaited<ReturnType<typeof workspaceScopeForUser>>;
let workspaceId = '';

async function newProject(name: string): Promise<Scope> {
	const project = await createProject(db, workspaceScope, { workspaceId, name, description: 'Imported from GitHub to keep improving it.' });
	return projectScopeForUser(db, 'alice', project.id);
}

const copy = (scope: Scope, repo: string) => importRepoSnapshot(db, client, scope, { installationId: INSTALLATION, repoFullName: `${ACCOUNT}/${repo}` });

beforeAll(async () => {
	({ sqlite, db } = migratedDatabase());
	addUser(sqlite, 'alice', 'alice@example.com');
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	github = new GithubStub({ appPublicKeyPem: publicKey.toString() });
	await github.start(await freePort());
	github.registerInstallation({ installationId: INSTALLATION, accountLogin: ACCOUNT, permissions: { contents: 'read', pull_requests: 'write' } });
	github.seedRepo({ fullName: `${ACCOUNT}/farm-log`, files: CADDIE_APP, accessInstallationId: INSTALLATION });
	github.seedRepo({
		fullName: `${ACCOUNT}/vite-app`,
		files: { 'package.json': JSON.stringify({ name: 'my-vite-app', dependencies: { react: '19.0.0', 'react-dom': '19.0.0' } }), 'src/main.tsx': 'x\n' },
		accessInstallationId: INSTALLATION,
	});
	const { 'bun.lock': _lock, ...noLock } = CADDIE_APP;
	github.seedRepo({ fullName: `${ACCOUNT}/half-app`, files: noLock, accessInstallationId: INSTALLATION });
	client = new GithubRestClient({ appId: '424242', privateKeyPem: privateKey.toString(), webhookSecret: null, baseUrl: github.url });

	const workspace = await createWorkspace(db, 'alice', { name: 'Alice' });
	workspaceId = workspace.id;
	workspaceScope = await workspaceScopeForUser(db, 'alice', workspace.id);
	await processGithubWebhook(db, {
		event: 'installation',
		deliveryId: 'start-install-1',
		payload: { action: 'created', installation: { id: Number(INSTALLATION), account: { login: ACCOUNT }, permissions: { contents: 'read', pull_requests: 'write' }, app_slug: 'caddie-forge-app', suspended_at: null } },
	});
	await bindInstallation(db, client, workspaceScope, INSTALLATION);
	await processGithubWebhook(db, {
		event: 'installation_repositories',
		deliveryId: 'start-select-1',
		payload: {
			action: 'added',
			installation: { id: Number(INSTALLATION) },
			repositories_added: ['farm-log', 'vite-app', 'half-app'].map((name) => ({ full_name: `${ACCOUNT}/${name}` })),
			repositories_removed: [],
		},
	});
}, 60_000);

afterAll(async () => {
	if (github) await github.stop();
	sqlite?.close();
});

describe('start from my GitHub repo', () => {
	test('the copy never takes dependencies, build output or secrets', async () => {
		const scope = await newProject('Copy rules');
		const imported = await copy(scope, 'farm-log');
		const paths = imported.manifest.map((entry) => entry.path);
		expect(paths).toContain('src/App.tsx');
		expect(paths).toContain('.env.example');
		expect(paths).not.toContain('.env');
		expect(paths.some((path) => path.startsWith('node_modules/') || path.startsWith('dist/'))).toBe(false);
		expect(imported.skipped).toEqual(expect.arrayContaining([{ path: '.env', reason: 'secret' }, { path: 'node_modules/', reason: 'dependencies' }, { path: 'dist/', reason: 'build-output' }]));
		expect(JSON.stringify(sqlite.prepare('select * from github_imports').all())).not.toContain('never-copy-me');
	});

	test("a repo made with Caddie becomes the app's first version, with Caddie's runtime files refreshed", async () => {
		const scope = await newProject('Farm log');
		const imported = await copy(scope, 'farm-log');
		const started = await startFromImport(db, new LocalCodeStore(db), scope, { importId: imported.id });
		expect(started).toMatchObject({ ok: true, repoFullName: `${ACCOUNT}/farm-log`, version: { seq: 1 } });
		const [version] = await listCodeVersions(db, scope);
		expect(version).toMatchObject({ seq: 1, kind: 'import', title: `Copied from ${ACCOUNT}/farm-log`, hasImage: false, outputId: null });
		const utf8 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
		const files = new Map((await readVersionFiles(new LocalCodeStore(db), scope.projectId, version!.commitId)).map((f) => [f.path, utf8(f.contentBase64)]));
		expect(files.get('src/App.tsx')).toBe(CADDIE_APP['src/App.tsx']);
		expect(files.has('.env')).toBe(false);
		expect(files.get('caddie/d1.ts')).toBe(SCAFFOLD_FILES['caddie/d1.ts']);
		expect(files.has('caddie/auth.ts')).toBe(true);
		expect(files.has('migrations/0000_caddie_auth.sql')).toBe(true);
		expect(version!.skipped.map((s) => s.path)).toEqual(expect.arrayContaining(['.env', 'node_modules/', 'dist/']));
		// The planner reads the description: it says the app continues the copied code.
		expect((await getProject(db, scope)).description).toBe(`Imported from GitHub to keep improving it. Its code was copied from GitHub (${ACCOUNT}/farm-log) as version 1; Caddie builds on it.`);
		// The card shows the copied app next: Caddie starts building it right away (import-preview.ts).
		expect(await readImportPreview(db, scope)).toMatchObject({ status: 'checking', versionSeq: 1, repoFullName: `${ACCOUNT}/farm-log` });
		// Only once: the project has its own code now.
		expect(await startFromImport(db, new LocalCodeStore(db), scope, { importId: imported.id })).toMatchObject({ ok: false, reason: 'already_started' });
	});

	test('anything else is refused in plain words, and nothing changes', async () => {
		const vite = await newProject('Vite app');
		const viteStart = await startFromImport(db, new LocalCodeStore(db), vite, { importId: (await copy(vite, 'vite-app')).id });
		expect(viteStart).toEqual({ ok: false, reason: 'not_caddie_app', message: "Caddie can continue apps that were made with Caddie and saved to GitHub. This repo was made another way, so Caddie can't build on it yet." });
		expect(await listCodeVersions(db, vite)).toEqual([]);
		expect(await readImportPreview(db, vite)).toBeNull();

		const half = await newProject('Half app');
		const halfStart = await startFromImport(db, new LocalCodeStore(db), half, { importId: (await copy(half, 'half-app')).id });
		expect(halfStart).toMatchObject({ ok: false, reason: 'missing_parts', missing: ['bun.lock (the exact package versions)'] });
		expect(await listCodeVersions(db, half)).toEqual([]);
		expect((await getProject(db, half)).description).toBe('Imported from GitHub to keep improving it.');
	});

	test('the stack check reads only what the recipe needs', () => {
		const enc = (text: string) => new TextEncoder().encode(text);
		const files = new Map(Object.entries(CADDIE_APP).map(([path, text]) => [path, enc(text)]));
		expect(checkCaddieApp(files)).toEqual({ ok: true });
		files.set('package.json', enc('{ not json'));
		expect(checkCaddieApp(files)).toMatchObject({ ok: false, reason: 'unreadable' });
		files.set('package.json', enc(JSON.stringify({ name: 'caddie-project', dependencies: {} })));
		files.delete('src/main.tsx');
		expect(checkCaddieApp(files)).toMatchObject({
			ok: false,
			reason: 'missing_parts',
			missing: ['src/main.tsx (where the app starts)', 'the build script in package.json', 'React in package.json'],
		});
	});
});
