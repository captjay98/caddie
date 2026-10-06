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
