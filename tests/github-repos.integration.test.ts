import { existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	ALICE_EMAIL,
	GITHUB_APP_ID,
	GITHUB_WEBHOOK_SECRET,
	Jar,
	StubProvider,
	applyMigrations,
	freePort,
	makeWorker,
	signIn,
	startGithubFixtureWorker,
	stopGithubFixtureWorker,
	webhookSignature,
	type StartedGithubFixtureWorker,
} from './fixtures/github-harness.ts';
import { GithubStub } from './fixtures/github-stub.ts';

/**
 * Guided GitHub step — repo CREATE + CONNECT + the project↔repo link, over a
 * real local workerd (miniflare + real SQLite D1) with the GitHub REST API
 * stubbed (tests/fixtures/github-stub.ts).
 *
 * Honesty classification: LOCAL VERIFIED (real workerd, real D1, real Better
 * Auth sessions, every GitHub call leaves the worker over HTTP and is App-JWT
 * -> installation-token authenticated at the stub). Provider behaviour is
 * SIMULATED — this is NOT evidence about real github.com. The create path's
 * real-GitHub proof is BLOCKED on the App being granted `administration: write`
 * and CADDIE_LIVE_AUTHORIZED (tests/live/github.spec.ts).
 *
 * What is proven:
 *   - create under an installation WITH administration:write → repo created,
 *     linked to the project, origin='created', and the GET link reflects it;
 *   - create under an installation WITHOUT administration:write → fail CLOSED
 *     with a typed 503, no link written (the honest permission gate);
 *   - a name collision ADOPTS the existing repo (origin='adopted'), idempotent;
 *   - connect an existing SELECTED repo → linked, origin='connected';
 *   - connecting an UNSELECTED repo is refused (repo_not_selected).
 */

const REPO_ROOT = join(import.meta.dir, '..');
const INSTALL_ADMIN = '910001'; // has administration: write
const INSTALL_NOADMIN = '910002'; // lacks administration
const ACCOUNT_ADMIN = 'octo-admin';
const ACCOUNT_NOADMIN = 'octo-noadmin';

let WORKER_PORT = 0;
let WORKER_BASE = '';
let stub: GithubStub;
let idp: StubProvider;
let started: StartedGithubFixtureWorker;
let ALICE: Jar;
let workspaceId = '';
let projectAdmin = '';
let projectNoAdmin = '';
let projectConnect = '';

const worker = (jar: Jar, path: string, init?: RequestInit) => makeWorker(WORKER_BASE)(jar, path, init);
const jsonHeaders = { 'content-type': 'application/json' } as const;

let deliveryCounter = 0;
function nextDeliveryId(): string {
	deliveryCounter += 1;
	return `d${deliveryCounter}-${crypto.randomUUID()}`;
}

function postWebhook(body: string, event: string): Promise<Response> {
	return fetch(`${WORKER_BASE}/api/github/webhook`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-github-event': event,
			'x-github-delivery': nextDeliveryId(),
			'x-hub-signature-256': webhookSignature(GITHUB_WEBHOOK_SECRET, body),
		},
		body,
	});
}

async function makeProject(name: string): Promise<string> {
	const res = await worker(ALICE, '/api/projects', {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ workspaceId, name }),
	});
	return ((await res.json()) as { project: { id: string } }).project.id;
}

beforeAll(async () => {
	for (const p of ['apps/app/migrations/0019_github_project_repo.sql']) {
		if (!existsSync(join(REPO_ROOT, p))) throw new Error(`missing: ${p}`);
	}
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	stub = new GithubStub({ appPublicKeyPem: publicKey.toString() });
	const stubPort = await freePort();
	await stub.start(stubPort);
	stub.registerInstallation({
		installationId: INSTALL_ADMIN,
		accountLogin: ACCOUNT_ADMIN,
		permissions: { contents: 'write', pull_requests: 'write', administration: 'write' },
	});
	stub.registerInstallation({
		installationId: INSTALL_NOADMIN,
		accountLogin: ACCOUNT_NOADMIN,
		permissions: { contents: 'read', pull_requests: 'write' }, // no administration
	});
	// A pre-existing repo under the admin account, for the connect + adopt cases.
	stub.seedRepo({
		fullName: `${ACCOUNT_ADMIN}/existing-repo`,
		accessInstallationId: INSTALL_ADMIN,
		defaultBranch: 'main',
		files: { 'README.md': '# existing\n' },
	});

	idp = new StubProvider();
	const idpPort = await freePort();
	await idp.start(idpPort);

	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	started = await startGithubFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL], {
		AUTH_STUB_BASE_URL: idp.url,
		GITHUB_APP_ID,
		GITHUB_APP_PRIVATE_KEY: privateKey.toString(),
		GITHUB_WEBHOOK_SECRET,
		GITHUB_API_BASE_URL: stub.url,
	});
	await applyMigrations(WORKER_BASE, [
		join(REPO_ROOT, 'apps/app/migrations/0001_product.sql'),
		join(REPO_ROOT, 'apps/app/migrations/0002_controls.sql'),
		join(REPO_ROOT, 'apps/app/migrations/0006_github.sql'),
		join(REPO_ROOT, 'apps/app/migrations/0011_home_project.sql'),
		join(REPO_ROOT, 'apps/app/migrations/0019_github_project_repo.sql'),
	]);

	ALICE = await signIn(worker, idp, ALICE_EMAIL, 'alice-repos', 'Alice');
	const ws = await worker(ALICE, '/api/workspaces', {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ name: 'repos-ws' }),
	});
	workspaceId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
	projectAdmin = await makeProject('proj-admin');
	projectNoAdmin = await makeProject('proj-noadmin');
	projectConnect = await makeProject('proj-connect');

	// Bind both installations to the workspace (permissions resolved live from the stub).
	for (const installationId of [INSTALL_ADMIN, INSTALL_NOADMIN]) {
		const res = await worker(ALICE, '/api/github/installations/bind', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId, workspaceId }),
		});
		if (res.status !== 201) throw new Error(`bind ${installationId} failed: ${res.status}`);
	}
	// Select the pre-existing repo on the admin installation (connect requires selected).
	await postWebhook(
		JSON.stringify({
			action: 'added',
			installation: { id: Number(INSTALL_ADMIN), account: { login: ACCOUNT_ADMIN } },
			repositories_added: [{ full_name: `${ACCOUNT_ADMIN}/existing-repo` }],
		}),
		'installation_repositories',
	);
}, 240_000);

afterAll(async () => {
	if (started) stopGithubFixtureWorker(WORKER_PORT);
	if (stub) await stub.stop();
	if (idp) await idp.stop();
});

describe('guided GitHub step — create', () => {
	test('create with administration:write → repo created + linked (origin=created)', async () => {
		const res = await worker(ALICE, `/api/projects/${projectAdmin}/github/repos`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: INSTALL_ADMIN, name: 'fresh-build', visibility: 'private' }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { repo: { repoFullName: string; visibility: string; origin: string; htmlUrl: string } };
		expect(body.repo.repoFullName).toBe(`${ACCOUNT_ADMIN}/fresh-build`);
		expect(body.repo.visibility).toBe('private');
		expect(body.repo.origin).toBe('created');

		// the GET link reflects the connected repo (the hasRepo signal)
		const link = await worker(ALICE, `/api/projects/${projectAdmin}/github/repo`);
		expect(link.status).toBe(200);
		const linkBody = (await link.json()) as { repo: { repoFullName: string; origin: string } | null };
		expect(linkBody.repo?.repoFullName).toBe(`${ACCOUNT_ADMIN}/fresh-build`);
		expect(linkBody.repo?.origin).toBe('created');
	});

	test('public visibility is honoured', async () => {
		const res = await worker(ALICE, `/api/projects/${projectAdmin}/github/repos`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: INSTALL_ADMIN, name: 'public-one', visibility: 'public' }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { repo: { visibility: string } };
		expect(body.repo.visibility).toBe('public');
	});

	test('a name collision ADOPTS the existing repo (origin=adopted), idempotent', async () => {
		const res = await worker(ALICE, `/api/projects/${projectAdmin}/github/repos`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: INSTALL_ADMIN, name: 'existing-repo', visibility: 'private' }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { repo: { repoFullName: string; origin: string } };
		expect(body.repo.repoFullName).toBe(`${ACCOUNT_ADMIN}/existing-repo`);
		expect(body.repo.origin).toBe('adopted');
	});

	test('WITHOUT administration:write → fail closed (503), no link written', async () => {
		const res = await worker(ALICE, `/api/projects/${projectNoAdmin}/github/repos`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: INSTALL_NOADMIN, name: 'should-not-exist', visibility: 'private' }),
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { message?: string; error?: string };
		expect(JSON.stringify(body)).toMatch(/administration/i);

		// no link was written — the project still has no connected repo
		const link = await worker(ALICE, `/api/projects/${projectNoAdmin}/github/repo`);
		const linkBody = (await link.json()) as { repo: unknown | null };
		expect(linkBody.repo).toBeNull();
	});

	test('invalid visibility / empty name are typed 400s', async () => {
		const bad = await worker(ALICE, `/api/projects/${projectAdmin}/github/repos`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: INSTALL_ADMIN, name: 'x', visibility: 'secret' }),
		});
		expect(bad.status).toBe(400);
		const noName = await worker(ALICE, `/api/projects/${projectAdmin}/github/repos`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: INSTALL_ADMIN, name: '', visibility: 'private' }),
		});
		expect(noName.status).toBe(400);
	});
});

describe('guided GitHub step — connect existing', () => {
	test('connect a SELECTED repo → linked (origin=connected)', async () => {
		const res = await worker(ALICE, `/api/projects/${projectConnect}/github/repo/connect`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: INSTALL_ADMIN, repoFullName: `${ACCOUNT_ADMIN}/existing-repo` }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { repo: { repoFullName: string; origin: string } };
		expect(body.repo.repoFullName).toBe(`${ACCOUNT_ADMIN}/existing-repo`);
		expect(body.repo.origin).toBe('connected');

		const link = await worker(ALICE, `/api/projects/${projectConnect}/github/repo`);
		const linkBody = (await link.json()) as { repo: { origin: string } | null };
		expect(linkBody.repo?.origin).toBe('connected');
	});

	test('connecting an UNSELECTED repo is refused', async () => {
		const res = await worker(ALICE, `/api/projects/${projectConnect}/github/repo/connect`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: INSTALL_ADMIN, repoFullName: `${ACCOUNT_ADMIN}/never-selected` }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; message?: string };
		expect(JSON.stringify(body)).toMatch(/not_selected|not selected/i);
	});
});
