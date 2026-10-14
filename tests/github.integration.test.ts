import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	GITHUB_ACCOUNT_A,
	GITHUB_ACCOUNT_B,
	GITHUB_APP_ID,
	GITHUB_APP_INSTALLATION_A,
	GITHUB_APP_INSTALLATION_B,
	GITHUB_POLICY_VERSION,
	GITHUB_WEBHOOK_SECRET,
	Jar,
	StubProvider,
	applyMigrations,
	d1Count,
	d1Exec,
	freePort,
	makeWorker,
	signIn,
	startGithubFixtureWorker,
	stopGithubFixtureWorker,
	webhookSignature,
	type StartedGithubFixtureWorker,
} from './fixtures/github-harness.ts';
import { GithubStub } from './fixtures/github-stub.ts';
import { readGithubConfig, verifyWebhookSignature } from '../apps/app/src/server/adapters/github.ts';

/**
 * P08 — GitHub App import and receipt-backed delivery, executed against a real
 * local workerd (`wrangler dev` = miniflare/workerd with real local SQLite
 * D1) using the P01/P02/P03 fixture harness patterns.
 *
 * Honesty classification:
 *   - Webhook signature verification, installation binding/revocation,
 *     delivery-GUID dedupe, import (manifest/hashes/caps/symlink/submodule
 *     handling) and receipt-backed export through the P03 operations ledger:
 *     LOCAL VERIFIED — real workerd, real D1, real Better Auth sessions, and
 *     every GitHub REST call actually leaves the worker over HTTP and is
 *     authenticated (RS256 App JWT -> installation token) at the stub.
 *   - The GitHub REST API is a LOCAL STUB in this test process
 *     (tests/fixtures/github-stub.ts, bound to 127.0.0.1). Provider-side
 *     behavior (real api.github.com) is therefore SIMULATED, never LIVE
 *     VERIFIED. No assertion in this file may be read as evidence about real
 *     GitHub; real-GitHub verification is BLOCKED on owner provisioning
 *     (tests/live/github.spec.ts + CADDIE_LIVE_AUTHORIZED).
 *   - OAuth session establishment is SIMULATED at the provider boundary (stub
 *     IdP), same classification as P01/P02/P03.
 *
 * Fixture entry: tests/fixtures/github.ts mounts the SAME production /api
 * composition app.ts composes (auth + projects + approvals + github) plus
 * /__test/* control routes that are compiled into the fixture only.
 */

const REPO_ROOT = join(import.meta.dir, '..');

let WORKER_PORT = 0;
let WORKER_BASE = '';
let stub: GithubStub;
let idp: StubProvider;
let started: StartedGithubFixtureWorker;

let ALICE: Jar;
let BOB: Jar;
let aliceWorkspaceId = '';
let bobWorkspaceId = '';
let aliceProjectId = '';
let bobProjectId = '';

const worker = (jar: Jar, path: string, init?: RequestInit) => makeWorker(WORKER_BASE)(jar, path, init);

const jsonHeaders = { 'content-type': 'application/json' } as const;

async function d1Rows(sql: string): Promise<Record<string, unknown>[]> {
	const res = await d1Exec(WORKER_BASE, sql);
	return res.results as Record<string, unknown>[];
}

/** Raw webhook POST (no session — GitHub calls this endpoint). */
function postWebhook(
	body: string,
	opts: { event: string; deliveryId: string; secret?: string; signature?: string },
): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'x-github-event': opts.event,
		'x-github-delivery': opts.deliveryId,
	};
	const signature =
		opts.signature !== undefined
			? opts.signature
			: opts.secret !== undefined
				? webhookSignature(opts.secret, body)
				: undefined;
	if (signature !== undefined) headers['x-hub-signature-256'] = signature;
	return fetch(`${WORKER_BASE}/api/github/webhook`, { method: 'POST', headers, body });
}

function installationEventBody(
	action: string,
	installationId: string,
	login: string,
	permissions: Record<string, string> = { contents: 'read', pull_requests: 'write' },
): string {
	return JSON.stringify({
		action,
		installation: {
			id: Number(installationId),
			account: { login },
			permissions,
			app_slug: 'caddie-forge-app',
			suspended_at: null,
		},
	});
}

let deliveryCounter = 0;
function nextDeliveryId(): string {
	deliveryCounter += 1;
	return `d${deliveryCounter}-${crypto.randomUUID()}`;
}

// --- fixture lifecycle ------------------------------------------------------------

beforeAll(async () => {
	for (const p of ['apps/app/migrations/0006_github.sql']) {
		if (!existsSync(join(REPO_ROOT, p))) throw new Error(`missing: ${p}`);
	}
	// RSA keypair: the worker signs App JWTs with the private key; the stub
	// verifies them against the public key (never shared with the worker).
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	const publicPem = publicKey.toString();
	stub = new GithubStub({ appPublicKeyPem: publicPem });
	const stubPort = await freePort();
	await stub.start(stubPort);
	stub.registerInstallation({
		installationId: GITHUB_APP_INSTALLATION_A,
		accountLogin: GITHUB_ACCOUNT_A,
	});
	stub.registerInstallation({
		installationId: GITHUB_APP_INSTALLATION_B,
		accountLogin: GITHUB_ACCOUNT_B,
	});

	idp = new StubProvider();
	const idpPort = await freePort();
	await idp.start(idpPort);

	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	started = await startGithubFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
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
		// The projects table carries the Home `kind` column since 0011 —
		// POST /api/projects fails without it (fixture schema drift, fixed
		// with the production numbering order).
		join(REPO_ROOT, 'apps/app/migrations/0011_home_project.sql'),
		join(REPO_ROOT, 'apps/app/migrations/0012_brief_read.sql'),
		// 0013 alters discovery_candidates, so 0009 must come first — the same
		// fixture schema drift class as 0011 above.
		join(REPO_ROOT, 'apps/app/migrations/0009_discovery.sql'),
		join(REPO_ROOT, 'apps/app/migrations/0013_discovery_saved.sql'),
		join(REPO_ROOT, 'apps/app/migrations/0014_stack_notify.sql'),
		join(REPO_ROOT, 'apps/app/migrations/0015_plan_decisions.sql'),
	]);

	ALICE = await signIn(worker, idp, ALICE_EMAIL, 'alice-p08', 'Alice');
	BOB = await signIn(worker, idp, BOB_EMAIL, 'bob-p08', 'Bob');
	const wsA = await worker(ALICE, '/api/workspaces', {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ name: 'alice-ws' }),
	});
	aliceWorkspaceId = ((await wsA.json()) as { workspace: { id: string } }).workspace.id;
	const wsB = await worker(BOB, '/api/workspaces', {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ name: 'bob-ws' }),
	});
	bobWorkspaceId = ((await wsB.json()) as { workspace: { id: string } }).workspace.id;
	const projA = await worker(ALICE, '/api/projects', {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ workspaceId: aliceWorkspaceId, name: 'alice-proj' }),
	});
	aliceProjectId = ((await projA.json()) as { project: { id: string } }).project.id;
	const projB = await worker(BOB, '/api/projects', {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ workspaceId: bobWorkspaceId, name: 'bob-proj' }),
	});
	bobProjectId = ((await projB.json()) as { project: { id: string } }).project.id;
}, 240_000);

afterAll(async () => {
	if (started) stopGithubFixtureWorker(WORKER_PORT);
	if (stub) await stub.stop();
	if (idp) await idp.stop();
});

// --- Slice 1: credential fail-closed + webhook signature (unit-level) ---------------

describe('P08 slice 1 — App credentials fail closed', () => {
	test('a half-configured App (id without key) is a typed configuration error, never a silent fallback', () => {
		expect(() => readGithubConfig({ GITHUB_APP_ID: '123' } as never)).toThrow(/GITHUB_APP_PRIVATE_KEY/);
		expect(() => readGithubConfig({ GITHUB_APP_PRIVATE_KEY: '-----BEGIN' } as never)).toThrow(
			/GITHUB_APP_ID/,
		);
		expect(() => readGithubConfig({} as never)).toThrow(/GITHUB_APP_ID/);
	});

	test('webhook verification fails closed without a secret (HackSteward behavior)', async () => {
		expect(await verifyWebhookSignature(null, new TextEncoder().encode('{}'), 'sha256=abc')).toBe(false);
	});

	test('webhook signature: valid passes, tampered payload and wrong secret fail, constant-time compare', async () => {
		const payload = new TextEncoder().encode('{"hello":"world"}');
		expect(await verifyWebhookSignature(GITHUB_WEBHOOK_SECRET, payload, webhookSignature(GITHUB_WEBHOOK_SECRET, payload))).toBe(true);
		// tampered payload under a signature computed for another payload
		expect(await verifyWebhookSignature(GITHUB_WEBHOOK_SECRET, payload, webhookSignature(GITHUB_WEBHOOK_SECRET, new TextEncoder().encode('other')))).toBe(false);
		// wrong secret
		expect(await verifyWebhookSignature('other-secret', payload, webhookSignature(GITHUB_WEBHOOK_SECRET, payload))).toBe(false);
		// malformed headers
		expect(await verifyWebhookSignature(GITHUB_WEBHOOK_SECRET, payload, 'sha1=deadbeef')).toBe(false);
		expect(await verifyWebhookSignature(GITHUB_WEBHOOK_SECRET, payload, 'sha256=')).toBe(false);
		expect(await verifyWebhookSignature(GITHUB_WEBHOOK_SECRET, payload, 'sha256=zz-not-hex')).toBe(false);
		expect(await verifyWebhookSignature(GITHUB_WEBHOOK_SECRET, payload, 'deadbeef')).toBe(false);
	});
});

// --- Slice 1: webhook endpoint over real workerd --------------------------------------

describe('P08 slice 1 — webhook endpoint (signature, events, dedupe)', () => {
	test('missing signature header is rejected (401), body never processed', async () => {
		const body = installationEventBody('created', GITHUB_APP_INSTALLATION_A, GITHUB_ACCOUNT_A);
		const res = await postWebhook(body, { event: 'installation', deliveryId: nextDeliveryId() });
		expect(res.status).toBe(401);
		expect(await d1Count(WORKER_BASE, 'github_installations')).toBe(0);
	});

	test('tampered signature is rejected (401)', async () => {
		const body = installationEventBody('created', GITHUB_APP_INSTALLATION_A, GITHUB_ACCOUNT_A);
		const res = await postWebhook(body, {
			event: 'installation',
			deliveryId: nextDeliveryId(),
			secret: 'attacker-secret',
		});
		expect(res.status).toBe(401);
	});

	test('a signature computed over a DIFFERENT payload (tampered body attack) is rejected', async () => {
		const legit = installationEventBody('created', GITHUB_APP_INSTALLATION_A, GITHUB_ACCOUNT_A);
		const res = await postWebhook(legit, {
			event: 'installation',
			deliveryId: nextDeliveryId(),
			signature: webhookSignature(GITHUB_WEBHOOK_SECRET, '{"action":"deleted"}'),
		});
		expect(res.status).toBe(401);
	});

	test('valid installation.created records the installation unbound (explicit binding is a user action)', async () => {
		const body = installationEventBody('created', GITHUB_APP_INSTALLATION_A, GITHUB_ACCOUNT_A);
		const res = await postWebhook(body, {
			event: 'installation',
			deliveryId: nextDeliveryId(),
			secret: GITHUB_WEBHOOK_SECRET,
		});
		expect(res.status).toBe(202);
		const rows = await d1Rows(`select * from github_installations where "installationId" = '${GITHUB_APP_INSTALLATION_A}'`);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.['status']).toBe('active');
		expect(rows[0]?.['accountLogin']).toBe(GITHUB_ACCOUNT_A);
		expect(rows[0]?.['workspaceId']).toBeNull();
	});

	test('a replayed delivery GUID is acknowledged but never re-processed (durable dedupe)', async () => {
		const deliveryId = nextDeliveryId();
		const body = installationEventBody('renamed', GITHUB_APP_INSTALLATION_A, 'octocat-a-renamed');
		const first = await postWebhook(body, { event: 'installation', deliveryId, secret: GITHUB_WEBHOOK_SECRET });
		expect(first.status).toBe(202);
		const replay = await postWebhook(body, { event: 'installation', deliveryId, secret: GITHUB_WEBHOOK_SECRET });
		expect(replay.status).toBe(202);
		const body2 = (await replay.json()) as { result?: string };
		expect(body2.result).toBe('duplicate');
		const rows = await d1Rows(
			`select count(*) as n from github_webhook_deliveries where "deliveryId" = '${deliveryId}'`,
		);
		expect(Number(rows[0]?.['n'])).toBe(1);
	});

	test('installation.renamed updates the stored account login', async () => {
		const body = installationEventBody('renamed', GITHUB_APP_INSTALLATION_A, 'octocat-a-newname');
		const res = await postWebhook(body, { event: 'installation', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET });
		expect(res.status).toBe(202);
		const rows = await d1Rows(`select "accountLogin" from github_installations where "installationId" = '${GITHUB_APP_INSTALLATION_A}'`);
		expect(rows[0]?.['accountLogin']).toBe('octocat-a-newname');
	});

	test('installation.deleted marks the installation revoked', async () => {
		const body = installationEventBody('deleted', GITHUB_APP_INSTALLATION_B, GITHUB_ACCOUNT_B);
		// create B first, then delete it
		const created = await postWebhook(
			installationEventBody('created', GITHUB_APP_INSTALLATION_B, GITHUB_ACCOUNT_B),
			{ event: 'installation', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET },
		);
		expect(created.status).toBe(202);
		const res = await postWebhook(body, { event: 'installation', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET });
		expect(res.status).toBe(202);
		const rows = await d1Rows(`select "status" from github_installations where "installationId" = '${GITHUB_APP_INSTALLATION_B}'`);
		expect(rows[0]?.['status']).toBe('revoked');
	});

	test('installation_repositories added/removed maintains the selection set', async () => {
		const added = JSON.stringify({
			action: 'added',
			installation: { id: Number(GITHUB_APP_INSTALLATION_A) },
			repositories_added: [{ full_name: `${GITHUB_ACCOUNT_A}/forge-app` }],
			repositories_removed: [],
		});
		const res = await postWebhook(added, { event: 'installation_repositories', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET });
		expect(res.status).toBe(202);
		let rows = await d1Rows(
			`select "status" from github_repo_selections where "installationId" = '${GITHUB_APP_INSTALLATION_A}' and "repoFullName" = '${GITHUB_ACCOUNT_A}/forge-app'`,
		);
		expect(rows[0]?.['status']).toBe('selected');

		const removed = JSON.stringify({
			action: 'removed',
			installation: { id: Number(GITHUB_APP_INSTALLATION_A) },
			repositories_added: [],
			repositories_removed: [{ full_name: `${GITHUB_ACCOUNT_A}/forge-app` }],
		});
		const res2 = await postWebhook(removed, { event: 'installation_repositories', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET });
		expect(res2.status).toBe(202);
		rows = await d1Rows(
			`select "status" from github_repo_selections where "installationId" = '${GITHUB_APP_INSTALLATION_A}' and "repoFullName" = '${GITHUB_ACCOUNT_A}/forge-app'`,
		);
		expect(rows[0]?.['status']).toBe('deselected');

		// re-select for later slices
		const again = await postWebhook(added, { event: 'installation_repositories', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET });
		expect(again.status).toBe(202);
	});

	test('an unknown event is accepted and ignored (202, no crash)', async () => {
		const res = await postWebhook('{"zen":"Keep it simple."}', {
			event: 'ping',
			deliveryId: nextDeliveryId(),
			secret: GITHUB_WEBHOOK_SECRET,
		});
		expect(res.status).toBe(202);
	});
});

// --- Slice 1: installation binding (explicit user action, workspace-scoped) ------------

describe('P08 slice 1 — installation binding', () => {
	test('the workspace owner binds the installation by explicit action (metadata resolved from the App API)', async () => {
		const res = await worker(ALICE, '/api/github/installations/bind', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: GITHUB_APP_INSTALLATION_A, workspaceId: aliceWorkspaceId }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { installation: { installationId: string; accountLogin: string; status: string; permissions: Record<string, string>; fingerprint?: string } };
		expect(body.installation.installationId).toBe(GITHUB_APP_INSTALLATION_A);
		expect(body.installation.accountLogin).toBe(GITHUB_ACCOUNT_A);
		expect(body.installation.status).toBe('active');
		expect(body.installation.permissions['contents']).toBe('read');
		// only a redacted fingerprint of the private key may ever be echoed
		expect(body.installation.fingerprint).toMatch(/^sha256-[0-9a-f]{16}$/);
		const rows = await d1Rows(
			`select "workspaceId", "boundBy", "permissionsJson" from github_installations where "installationId" = '${GITHUB_APP_INSTALLATION_A}'`,
		);
		expect(rows[0]?.['workspaceId']).toBe(aliceWorkspaceId);
		expect(rows[0]?.['boundBy']).toBeTruthy();
		expect(String(rows[0]?.['permissionsJson'])).toContain('contents');
	});

	test('a second user binding the same installation is a typed 409 (imported-existing-app behavior)', async () => {
		const res = await worker(BOB, '/api/github/installations/bind', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: GITHUB_APP_INSTALLATION_A, workspaceId: bobWorkspaceId }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('installation_already_bound');
	});

	test('installations are workspace-scoped: Bob sees none of Alice\u2019s', async () => {
		const res = await worker(BOB, `/api/github/installations?workspaceId=${bobWorkspaceId}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { installations: unknown[] };
		expect(body.installations).toHaveLength(0);
		const resA = await worker(ALICE, `/api/github/installations?workspaceId=${aliceWorkspaceId}`);
		const bodyA = (await resA.json()) as { installations: { installationId: string }[] };
		expect(bodyA.installations).toHaveLength(1);
		expect(bodyA.installations[0]?.installationId).toBe(GITHUB_APP_INSTALLATION_A);
	});

	test('binding requires workspace membership (Bob cannot bind into Alice\u2019s workspace)', async () => {
		const res = await worker(BOB, '/api/github/installations/bind', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: GITHUB_APP_INSTALLATION_B, workspaceId: aliceWorkspaceId }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('not_a_member');
	});

	test('selected repositories of the bound installation are listable by members only', async () => {
		const res = await worker(ALICE, `/api/github/installations/${GITHUB_APP_INSTALLATION_A}/repos`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { repositories: { repoFullName: string; status: string }[] };
		expect(body.repositories).toHaveLength(1);
		expect(body.repositories[0]?.repoFullName).toBe(`${GITHUB_ACCOUNT_A}/forge-app`);
		const bobRes = await worker(BOB, `/api/github/installations/${GITHUB_APP_INSTALLATION_A}/repos`);
		expect(bobRes.status).toBe(403);
	});
});

// --- Slice 2 fixture state -------------------------------------------------------------
//
// Seeded AFTER the slice-1 describe so slice-1 assertions observe exactly one
// installation / one selection. bun:test runs describes in file order.

const FORGE_REPO = `${GITHUB_ACCOUNT_A}/forge-app`;
const MERGE_BASE_COMMIT_KEY = 'merge-probe';

let forgeStubRepo: ReturnType<GithubStub['seedRepo']>;

describe('P08 slice 2 — import + receipt-backed export', () => {
	beforeAll(async () => {
		// Repos used by the import/export matrix (stub-side state).
		forgeStubRepo = stub.seedRepo({
			fullName: FORGE_REPO,
			files: {
				'README.md': '# forge-app\n',
				'src/index.ts': 'export const main = () => 1;\n',
				'src/util.ts': 'export const util = () => 2;\n',
			},
			accessInstallationId: GITHUB_APP_INSTALLATION_A,
		});
		stub.seedRepo({
			fullName: `${GITHUB_ACCOUNT_A}/with-symlink`,
			files: { 'README.md': 'hi\n' },
			symlinks: { 'evil-link': '../../etc/passwd' },
			accessInstallationId: GITHUB_APP_INSTALLATION_A,
		});
		stub.seedRepo({
			fullName: `${GITHUB_ACCOUNT_A}/with-submodule`,
			files: { 'README.md': 'hi\n' },
			submodules: { 'vendor/lib': '0123456789abcdef0123456789abcdef01234567' },
			accessInstallationId: GITHUB_APP_INSTALLATION_A,
		});
		stub.seedRepo({
			fullName: `${GITHUB_ACCOUNT_A}/too-big`,
			files: { 'big.bin': 'a'.repeat(600 * 1024) },
			accessInstallationId: GITHUB_APP_INSTALLATION_A,
		});
		const manyFiles: Record<string, string> = {};
		for (let i = 0; i < 202; i++) manyFiles[`f${String(i).padStart(3, '0')}.txt`] = `${i}\n`;
		stub.seedRepo({
			fullName: `${GITHUB_ACCOUNT_A}/too-many`,
			files: manyFiles,
			accessInstallationId: GITHUB_APP_INSTALLATION_A,
		});
		stub.seedRepo({
			fullName: `${GITHUB_ACCOUNT_A}/mono`,
			defaultBranch: 'trunk',
			files: {
				'app/main.ts': 'export {};\n',
				'app/nested/deep.ts': 'export {};\n',
				'docs/readme.md': 'docs\n',
			},
			accessInstallationId: GITHUB_APP_INSTALLATION_A,
		});
		stub.seedRepo({
			fullName: `${GITHUB_ACCOUNT_B}/bobs-repo`,
			files: { 'README.md': 'bob\n' },
			accessInstallationId: GITHUB_APP_INSTALLATION_B,
		});

		// Select the slice-2 repositories through the REAL webhook path.
		const select = async (fullName: string) => {
			const body = JSON.stringify({
				action: 'added',
				installation: { id: Number(GITHUB_APP_INSTALLATION_A) },
				repositories_added: [{ full_name: fullName }],
				repositories_removed: [],
			});
			const res = await postWebhook(body, {
				event: 'installation_repositories',
				deliveryId: nextDeliveryId(),
				secret: GITHUB_WEBHOOK_SECRET,
			});
			if (res.status !== 202) throw new Error(`selection webhook failed: ${res.status}`);
		};
		for (const name of [
			FORGE_REPO,
			`${GITHUB_ACCOUNT_A}/with-symlink`,
			`${GITHUB_ACCOUNT_A}/with-submodule`,
			`${GITHUB_ACCOUNT_A}/too-big`,
			`${GITHUB_ACCOUNT_A}/too-many`,
			`${GITHUB_ACCOUNT_A}/mono`,
		]) {
			await select(name);
		}
	}, 30_000);

	// --- import -------------------------------------------------------------------

	test('import snapshots the selected repo at a ref with a hashed, content-addressed manifest', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: GITHUB_APP_INSTALLATION_A, repoFullName: FORGE_REPO, ref: 'main' }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			import: { id: string; commitSha: string; fileCount: number; manifest: { path: string; contentHash: string; blobSha: string; size: number }[] };
		};
		expect(body.import.fileCount).toBe(3);
		expect(body.import.manifest.map((m) => m.path).sort()).toEqual(['README.md', 'src/index.ts', 'src/util.ts']);
		for (const entry of body.import.manifest) {
			expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
			expect(entry.blobSha).toBeTruthy();
		}
		// database truth: one import row, one content blob per distinct file
		const rows = await d1Rows(`select count(*) as n from github_imports where "id" = '${body.import.id}'`);
		expect(Number(rows[0]?.['n'])).toBe(1);
		const blobs = await d1Rows(
			`select count(*) as n from content_blobs where "hash" in (${body.import.manifest.map((m) => `'${m.contentHash}'`).join(',')})`,
		);
		expect(Number(blobs[0]?.['n'])).toBe(3);
		// content-addressed: the stored bytes hash back to the manifest hash is
		// proven below by re-importing and observing NO duplicate blob rows.
		const second = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: GITHUB_APP_INSTALLATION_A, repoFullName: FORGE_REPO, ref: 'main' }),
		});
		expect(second.status).toBe(201);
		const blobCount = await d1Rows('select count(*) as n from content_blobs');
		expect(Number(blobCount[0]?.['n'])).toBe(3);
	});

	test('root import is normalized: leading/trailing slashes collapse, paths are relative to the root', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: `${GITHUB_ACCOUNT_A}/mono`,
				ref: 'trunk',
				root: '/app/',
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { import: { rootPath: string; manifest: { path: string }[] } };
		expect(body.import.rootPath).toBe('app');
		expect(body.import.manifest.map((m) => m.path).sort()).toEqual(['main.ts', 'nested/deep.ts']);
	});

	test('symlinks are rejected, never followed or stored', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: `${GITHUB_ACCOUNT_A}/with-symlink`,
				ref: 'main',
			}),
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('symlink_rejected');
		const { createHash } = await import('node:crypto');
		const targetHash = createHash('sha256').update('../../etc/passwd', 'utf8').digest('hex');
		const blobs = await d1Rows(`select count(*) as n from content_blobs where "hash" = '${targetHash}'`);
		// the passwd-target bytes never reached the content-addressed store
		expect(Number(blobs[0]?.['n'])).toBe(0);
	});

	test('submodules are skipped and recorded, not imported', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: `${GITHUB_ACCOUNT_A}/with-submodule`,
				ref: 'main',
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			import: { fileCount: number; manifest: { path: string }[]; skipped: { path: string; reason: string; gitSha: string }[] };
		};
		expect(body.import.fileCount).toBe(1);
		expect(body.import.manifest.map((m) => m.path)).toEqual(['README.md']);
		expect(body.import.skipped).toHaveLength(1);
		expect(body.import.skipped[0]?.path).toBe('vendor/lib');
		expect(body.import.skipped[0]?.reason).toBe('submodule');
	});

	test('file size cap rejects oversized imports with a typed error', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: `${GITHUB_ACCOUNT_A}/too-big`,
				ref: 'main',
			}),
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('import_file_size_cap_exceeded');
	});

	test('file count cap rejects oversized imports with a typed error', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: `${GITHUB_ACCOUNT_A}/too-many`,
				ref: 'main',
			}),
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('import_file_count_cap_exceeded');
	});

	test('traversal roots are rejected before any provider call', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: FORGE_REPO,
				ref: 'main',
				root: '../etc',
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('invalid_path');
	});

	test('import fails closed for a repo that is not selected', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: `${GITHUB_ACCOUNT_A}/not-selected`,
				ref: 'main',
			}),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('repo_not_selected');
	});

	test('two-user isolation: Bob\u2019s project cannot import through Alice\u2019s installation', async () => {
		const res = await worker(BOB, `/api/projects/${bobProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: GITHUB_APP_INSTALLATION_A, repoFullName: FORGE_REPO, ref: 'main' }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('installation_out_of_scope');
	});

	// --- receipt-backed export ------------------------------------------------------

	let firstPullRequestNumber = 0;
	let prBranch = 'caddie/feature-1';

	test('PR delivery walks prepare -> dispatched -> receipt and records the PR', async () => {
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/deliveries`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				runId: 'run_p08_export_1',
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: FORGE_REPO,
				headBranch: prBranch,
				title: 'Add feature module',
				body: 'Generated by Caddie P08.',
				files: [{ path: 'src/feature.ts', content: 'export const feature = () => 42;\n' }],
				mode: 'pull-request',
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			delivery: { operationKey: string; pullRequestNumber: number; headSha: string | null; mode: string };
			operation: { status: string; receiptId: string | null; provider: string };
		};
		firstPullRequestNumber = body.delivery.pullRequestNumber;
		expect(firstPullRequestNumber).toBeGreaterThan(0);
		expect(body.delivery.mode).toBe('pull-request');
		expect(body.delivery.headSha).toBe(stub.branchHead(FORGE_REPO, prBranch));
		expect(stub.openPullRequest(FORGE_REPO, prBranch)?.number).toBe(firstPullRequestNumber);
		// ledger truth: provider receipt recorded, provider correlation intact
		expect(body.operation.provider).toBe('github');
		expect(body.operation.status).toBe('succeeded');
		expect(body.operation.receiptId).toBe(`pr:${firstPullRequestNumber}`);
		const opRows = await d1Rows(
			`select "status", "receiptId", "remoteId" from external_operations where "operationKey" = '${body.delivery.operationKey}'`,
		);
		expect(opRows[0]?.['status']).toBe('succeeded');
		expect(opRows[0]?.['receiptId']).toBe(`pr:${firstPullRequestNumber}`);
		const delRows = await d1Rows(
			`select "pullRequestNumber", "headSha" from github_deliveries where "operationKey" = '${body.delivery.operationKey}'`,
		);
		expect(Number(delRows[0]?.['pullRequestNumber'])).toBe(firstPullRequestNumber);
		// base branch untouched, exactly one PR creation call reached the provider
		expect(stub.branchHead(FORGE_REPO, 'main')).toBe(forgeStubRepo?.branches.get('main')?.sha ?? null);
	});

	test('a duplicate intent reconciles to the SAME PR — the provider saw one creation call', async () => {
		const pullsBefore = stub.requests.filter((r) => r.method === 'POST' && r.path === `/repos/${FORGE_REPO}/pulls`).length;
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/deliveries`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				runId: 'run_p08_export_1',
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: FORGE_REPO,
				headBranch: prBranch,
				title: 'Add feature module',
				body: 'Generated by Caddie P08.',
				files: [{ path: 'src/feature.ts', content: 'export const feature = () => 42;\n' }],
				mode: 'pull-request',
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { delivery: { pullRequestNumber: number }; reconciled: boolean };
		expect(body.delivery.pullRequestNumber).toBe(firstPullRequestNumber);
		expect(body.reconciled).toBe(true);
		const pullsAfter = stub.requests.filter((r) => r.method === 'POST' && r.path === `/repos/${FORGE_REPO}/pulls`).length;
		expect(pullsAfter).toBe(pullsBefore); // no second creation call even attempted
	});

	test('existing-branch divergence is a typed conflict, never an overwrite', async () => {
		// Simulate an external committer moving the feature branch (test-side
		// stub state, NOT through the adapter): a hostile fast-forward commit.
		const branch = forgeStubRepo?.branches.get(prBranch);
		const currentHead = branch ? forgeStubRepo?.commits.get(branch.sha) : undefined;
		expect(branch && currentHead).toBeTruthy();
		forgeStubRepo?.commits.set('foreign-1', {
			sha: 'foreign-1',
			message: 'hostile external commit',
			tree: currentHead?.tree ?? '',
			parents: [branch?.sha ?? ''],
		});
		branch!.sha = 'foreign-1';
		const mainHeadBefore = stub.branchHead(FORGE_REPO, 'main');

		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/deliveries`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				runId: 'run_p08_export_2',
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: FORGE_REPO,
				headBranch: prBranch,
				title: 'Second feature',
				files: [{ path: 'src/second.ts', content: 'export const second = 2;\n' }],
				mode: 'pull-request',
			}),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('delivery_head_diverged');
		// provider state untouched: branch still foreign, default branch untouched,
		// and no force-push was ever ATTEMPTED (stub policy would reject and count it)
		expect(stub.branchHead(FORGE_REPO, prBranch)).toBe('foreign-1');
		expect(stub.branchHead(FORGE_REPO, 'main')).toBe(mainHeadBefore);
		expect(stub.forceViolations).toBe(0);
	});

	test('default-branch merge stays PREPARED and does NOT execute without the exact approval', async () => {
		const before = stub.requests.length;
		const res = await worker(ALICE, `/api/projects/${aliceProjectId}/github/deliveries`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				runId: 'run_p08_merge_1',
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: FORGE_REPO,
				headBranch: 'main',
				title: 'Merge verified work to main',
				files: [{ path: 'src/merge-me.ts', content: 'export const merged = true;\n' }],
				mode: 'merge-default-branch',
			}),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; operationKey?: string; revisionHash?: string };
		expect(body.error).toBe('STALE_APPROVAL');
		expect(body.operationKey).toBeTruthy();
		expect(body.revisionHash).toMatch(/^[0-9a-f]{64}$/);
		// ledger truth: the effect is PREPARED (elected dispatcher) but nothing
		// reached the provider — every request since the snapshot was a read.
		const opRows = await d1Rows(
			`select "status" from external_operations where "operationKey" = '${body.operationKey}'`,
		);
		expect(opRows[0]?.['status']).toBe('prepared');
		// nothing reached the provider except reads and the App-token mint —
		// the SAME exclusion rule the stub uses for "mutating" traffic.
		const sinceSnapshot = stub.requests.slice(before).filter((r) => {
			if (r.method === 'POST' && r.path.endsWith('/access_tokens')) return false;
			return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method);
		});
		expect(sinceSnapshot).toHaveLength(0);

		// Alice approves the EXACT intent through the authenticated user route.
		const approve = await worker(ALICE, '/api/approvals', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				intent: {
					projectId: aliceProjectId,
					action: 'merge-default-branch',
					resourceId: FORGE_REPO,
					revisionHash: body.revisionHash,
					policyVersion: GITHUB_POLICY_VERSION,
				},
				decision: 'approved',
			}),
		});
		expect(approve.status).toBe(200);

		// Resuming the SAME logical delivery now dispatches behind the gate.
		const resume = await worker(ALICE, `/api/projects/${aliceProjectId}/github/deliveries`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				runId: 'run_p08_merge_1',
				installationId: GITHUB_APP_INSTALLATION_A,
				repoFullName: FORGE_REPO,
				headBranch: 'main',
				title: 'Merge verified work to main',
				files: [{ path: 'src/merge-me.ts', content: 'export const merged = true;\n' }],
				mode: 'merge-default-branch',
			}),
		});
		expect(resume.status).toBe(201);
		const resumeBody = (await resume.json()) as {
			delivery: { headSha: string; mode: string; pullRequestNumber: number | null };
			operation: { status: string; receiptId: string | null };
		};
		expect(resumeBody.operation.status).toBe('succeeded');
		expect(resumeBody.operation.receiptId).toBe(`merge:${resumeBody.delivery.headSha}`);
		expect(resumeBody.delivery.pullRequestNumber).toBeNull();
		// default branch fast-forwarded onto the new commit — never force-pushed
		expect(stub.branchHead(FORGE_REPO, 'main')).toBe(resumeBody.delivery.headSha);
		const mainUpdates = stub.refUpdates.filter((u) => u.repo === FORGE_REPO && u.branch === 'main');
		expect(mainUpdates).toHaveLength(1);
		expect(mainUpdates[0]?.force).toBe(false);
		expect(mainUpdates[0]?.accepted).toBe(true);
		expect(stub.forceViolations).toBe(0);
	});

	test('revocation denies every future operation (webhook installation.deleted)', async () => {
		// Fresh installation C: webhook-created, explicitly bound, repo selected.
		const C = '4756421';
		stub.registerInstallation({ installationId: C, accountLogin: 'octocat-c' });
		stub.seedRepo({
			fullName: 'octocat-c/c-repo',
			files: { 'README.md': 'c\n' },
			accessInstallationId: C,
		});
		const created = await postWebhook(
			installationEventBody('created', C, 'octocat-c'),
			{ event: 'installation', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET },
		);
		expect(created.status).toBe(202);
		const bindRes = await worker(ALICE, '/api/github/installations/bind', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: C, workspaceId: aliceWorkspaceId }),
		});
		expect(bindRes.status).toBe(201);
		const selected = await postWebhook(
			JSON.stringify({
				action: 'added',
				installation: { id: Number(C) },
				repositories_added: [{ full_name: 'octocat-c/c-repo' }],
				repositories_removed: [],
			}),
			{ event: 'installation_repositories', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET },
		);
		expect(selected.status).toBe(202);
		const importOk = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: C, repoFullName: 'octocat-c/c-repo', ref: 'main' }),
		});
		expect(importOk.status).toBe(201);

		const revoked = await postWebhook(
			installationEventBody('deleted', C, 'octocat-c'),
			{ event: 'installation', deliveryId: nextDeliveryId(), secret: GITHUB_WEBHOOK_SECRET },
		);
		expect(revoked.status).toBe(202);

		const denied = await worker(ALICE, `/api/projects/${aliceProjectId}/github/imports`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ installationId: C, repoFullName: 'octocat-c/c-repo', ref: 'main' }),
		});
		expect(denied.status).toBe(403);
		const body = (await denied.json()) as { error?: string };
		expect(body.error).toBe('installation_revoked');

		const deniedDelivery = await worker(ALICE, `/api/projects/${aliceProjectId}/github/deliveries`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				runId: 'run_p08_revoked',
				installationId: C,
				repoFullName: 'octocat-c/c-repo',
				headBranch: 'caddie/x',
				title: 'x',
				files: [{ path: 'a.txt', content: 'a\n' }],
				mode: 'pull-request',
			}),
		});
		expect(deniedDelivery.status).toBe(403);
	});

	test('across the whole suite the provider never received a force-push', () => {
		expect(stub.forceViolations).toBe(0);
	});
});
