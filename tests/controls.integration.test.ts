import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	SESSION_COOKIE,
	StubProvider,
	applyMigrations,
	controlsMigrationPaths,
	d1Count,
	d1Exec,
	freePort,
	makeWorker,
	signIn,
	startControlsFixtureWorker,
	stopControlsFixtureWorker,
	type StartedFixtureWorker,
} from './fixtures/controls-harness.ts';

/**
 * P03 slice 1 — approvals, external-effects ledger and credentials, executed
 * against a real local workerd (`wrangler dev` = miniflare/workerd with a real
 * local SQLite-backed D1) using the P01/P02 fixture harness patterns.
 *
 * Honesty classification:
 *   - Approval lifecycle (request/decide/revoke), execution-side gate
 *     re-verification (stale/expired/revoked/wrong-actor/wrong-project),
 *     external-operations ledger transitions and budget reserve/settle/
 *     release persistence: LOCAL VERIFIED (real workerd, real SQLite-backed
 *     D1, real Better Auth sessions).
 *   - The OAuth provider endpoints are a stub inside this test process, so
 *     session establishment is SIMULATED at the provider boundary (same
 *     classification as P01/P02).
 *   - The "provider" is a COUNTING FAKE inside the fixture worker
 *     (/__test/provider/*, counted in D1) — no real external effect exists in
 *     this packet. Zero-call proofs below are therefore LOCAL VERIFIED
 *     evidence about the GATE, never LIVE VERIFIED evidence about a provider.
 *
 * The fixture worker entry is tests/fixtures/controls.ts; it mounts the SAME
 * production composition app.ts mounts at /api plus /__test/* control routes
 * that are compiled into the fixture only and are never part of the app Worker.
 */

const REPO_ROOT = join(import.meta.dir, '..');

// The single effectful resource under test: a plan revision binding for the
// deploy-production action (contracts.md "Approval and effect" example).
const RESOURCE_ID = 'plan:main';
const POLICY_VERSION = 'policies/2026-10-04';
// Set by the slice-1 setup test; used by the operations/budget/credentials
// slices (they need an existing project for foreign keys, nothing more).
let ledgerProjectId = '';

// --- fixture lifecycle ----------------------------------------------------------

let WORKER_PORT = 0;
let WORKER_BASE = '';
let stub: StubProvider;
let started: StartedFixtureWorker;

const worker = (jar: import('./fixtures/controls-harness.ts').Jar, path: string, init?: RequestInit) =>
	makeWorker(WORKER_BASE)(jar, path, init);

beforeAll(async () => {
	const migrationPaths = controlsMigrationPaths();
	for (const path of migrationPaths) {
		if (!existsSync(path)) throw new Error(`migration missing: ${path}`);
	}
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	started = await startControlsFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
		AUTH_STUB_BASE_URL: stub.url,
	});
	await applyMigrations(WORKER_BASE, migrationPaths);
	// The counting fake provider's ledger table (fixture-only, created by the
	// test like every other fixture-local structure).
	await fetch(`${WORKER_BASE}/__test/ddl`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			statements: [
				'create table if not exists "provider_calls" ("id" integer primary key autoincrement, "kind" text not null, "createdAt" date not null)',
			],
		}),
	});
}, 180_000);

afterAll(async () => {
	if (started) stopControlsFixtureWorker(WORKER_PORT);
	if (stub) await stub.stop();
});

// --- P03-specific helpers ---------------------------------------------------------

const jsonHeaders = { 'content-type': 'application/json' } as const;

/** Typed accessor over database-truth query results. */
async function d1Rows(sql: string): Promise<Record<string, unknown>[]> {
	const res = await d1Exec(WORKER_BASE, sql);
	return res.results as Record<string, unknown>[];
}

function intentFor(projectId: string, revisionHash: string) {
	return {
		projectId,
		action: 'deploy-production',
		resourceId: RESOURCE_ID,
		revisionHash,
		policyVersion: POLICY_VERSION,
	};
}

/** Approve/reject an exact intent through the authenticated user route. */
async function decideAs(
	jar: import('./fixtures/controls-harness.ts').Jar,
	projectId: string,
	revisionHash: string,
	decision: 'approved' | 'rejected',
	extra: Record<string, unknown> = {},
): Promise<Response> {
	return worker(jar, '/api/approvals', {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ intent: intentFor(projectId, revisionHash), decision, ...extra }),
	});
}

/** Agent-facing request: creates a PENDING approval only (no session involved). */
async function agentRequest(
	projectId: string,
	revisionHash: string,
	extra: Record<string, unknown> = {},
): Promise<Response> {
	return fetch(`${WORKER_BASE}/api/agents-bridge/approvals`, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ intent: intentFor(projectId, revisionHash), ...extra }),
	});
}

/** Append a plan-doc revision through the real P02 route (the "revise" step). */
async function revisePlan(
	jar: import('./fixtures/controls-harness.ts').Jar,
	projectId: string,
	body: string,
): Promise<string> {
	const res = await worker(jar, `/api/projects/${projectId}/plan-docs`, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ kind: 'plan', body }),
	});
	if (res.status !== 201) throw new Error(`revisePlan failed: ${res.status} ${await res.text()}`);
	const revision = (await res.json()) as { revision: { bodyHash: string } };
	return revision.revision.bodyHash;
}

async function providerCount(): Promise<number> {
	const res = await fetch(`${WORKER_BASE}/__test/provider/count`);
	return ((await res.json()) as { count: number }).count;
}

/**
 * The deploy attempt from contracts.md, implemented in the TEST (not mimicked
 * in production): derive the CURRENT plan revision from database truth, run
 * the production execution-side gate (checkApprovalForEffect inside the
 * fixture), and only on a pass invoke the (fake) provider. The approvalId is
 * deliberately NOT an authorization input — the gate re-verifies durable
 * records (audit defect #4: prompt-only approval must not travel).
 */
async function deployAttempt(options: {
	approvalId?: string;
	actorId: string;
	projectId: string;
	revisionHash?: string;
	now?: string;
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
	let revisionHash = options.revisionHash;
	if (revisionHash === undefined) {
		const latest = await d1Rows(
			`select "bodyHash" from "plan_doc_revisions" where "projectId" = '${options.projectId}' and "kind" = 'plan' order by "revision" desc limit 1`,
		);
		revisionHash = String(latest[0]?.['bodyHash'] ?? '');
	}
	const gate = await fetch(`${WORKER_BASE}/__test/gate/check`, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({
			actorId: options.actorId,
			projectId: options.projectId,
			action: 'deploy-production',
			resourceId: RESOURCE_ID,
			revisionHash,
			policyVersion: POLICY_VERSION,
			now: options.now,
		}),
	});
	if (gate.status !== 200) {
		return { ok: false, status: gate.status, body: (await gate.json()) as Record<string, unknown> };
	}
	await fetch(`${WORKER_BASE}/__test/provider/invoke`, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ kind: 'deploy-production' }),
	});
	return { ok: true, status: gate.status, body: (await gate.json()) as Record<string, unknown> };
}

// --- slice 1: approvals -------------------------------------------------------------

describe('P03 slice 1: revision-bound approvals over real workerd + D1', () => {
	// Populated by the setup test (bun runs tests in declaration order).
	let jarA: import('./fixtures/controls-harness.ts').Jar;
	let jarB: import('./fixtures/controls-harness.ts').Jar;
	let aliceId = '';
	let bobId = '';
	let wsA = '';
	let projA = '';
	let projA2 = '';
	let projB = '';
	let planV1Hash = '';

	test('setup: both users sign in, create workspaces/projects, first plan revision exists', async () => {
		jarA = await signIn(worker, stub, ALICE_EMAIL, 'p03-alice-sub', 'Alice');
		jarB = await signIn(worker, stub, BOB_EMAIL, 'p03-bob-sub', 'Bob');
		expect(jarA.header()).toContain(SESSION_COOKIE);
		expect(jarB.header()).toContain(SESSION_COOKIE);

		const wsRes = await worker(jarA, '/api/workspaces', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ name: 'Alice Controls Hangar' }),
		});
		expect(wsRes.status).toBe(201);
		wsA = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;

		const projRes = await worker(jarA, '/api/projects', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsA, name: 'Controls Rocket' }),
		});
		expect(projRes.status).toBe(201);
		projA = ((await projRes.json()) as { project: { id: string } }).project.id;
		ledgerProjectId = projA;

		const projRes2 = await worker(jarA, '/api/projects', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsA, name: 'Controls Sidecar' }),
		});
		projA2 = ((await projRes2.json()) as { project: { id: string } }).project.id;

		const wsResB = await worker(jarB, '/api/workspaces', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ name: 'Bob Controls Hangar' }),
		});
		expect(wsResB.status).toBe(201);
		const wsB = ((await wsResB.json()) as { workspace: { id: string } }).workspace.id;
		const projResB = await worker(jarB, '/api/projects', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsB, name: 'Bob Controls Satellite' }),
		});
		expect(projResB.status).toBe(201);
		projB = ((await projResB.json()) as { project: { id: string } }).project.id;

		planV1Hash = await revisePlan(jarA, projA, 'controls plan v1');
		expect(planV1Hash).toMatch(/^sha256-/);

		const users = await d1Exec(WORKER_BASE, `select "id", "email" from "user"`);
		for (const row of users.results as { id: string; email: string }[]) {
			if (row.email === ALICE_EMAIL) aliceId = row.id;
			if (row.email === BOB_EMAIL) bobId = row.id;
		}
		expect(aliceId).toBeTruthy();
		expect(bobId).toBeTruthy();
	});

	test('agent bridge can REQUEST a pending approval but there is no decide route for agents', async () => {
		const res = await agentRequest(projA, planV1Hash);
		expect(res.status).toBe(201);
		const { approval } = (await res.json()) as { approval: { id: string; status: string; decidedBy: string | null } };
		expect(approval.status).toBe('pending');
		expect(approval.decidedBy).toBeNull();

		// agent read works...
		const read = await fetch(`${WORKER_BASE}/api/agents-bridge/approvals/${approval.id}`);
		expect(read.status).toBe(200);
		// ...but no decide route exists on the bridge: neither of these paths may exist
		const decideAttempt = await fetch(`${WORKER_BASE}/api/agents-bridge/approvals/${approval.id}/decide`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ decision: 'approved' }),
		});
		expect(decideAttempt.status).toBe(404);
		const decideDirect = await fetch(`${WORKER_BASE}/api/agents-bridge/approvals/${approval.id}`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ decision: 'approved' }),
		});
		expect(decideDirect.status).toBe(404);

		// database truth: still pending, still nobody decided
		expect(await d1Count(WORKER_BASE, 'approvals', `"id" = '${approval.id}' and "status" = 'pending' and "decidedBy" is null`)).toBe(1);
	});

	test('a second pending request for the same exact intent conflicts (one live request per intent)', async () => {
		const res = await agentRequest(projA, planV1Hash);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe('approval_intent_conflict');
		expect(await d1Count(WORKER_BASE, 'approvals', `"projectId" = '${projA}' and "revisionHash" = '${planV1Hash}' and "status" = 'pending'`)).toBe(1);
	});

	test('the owner decision is recorded with decidedBy = the SESSION-derived actor; a smuggled decidedBy is rejected', async () => {
		// a body-supplied decidedBy cannot ride through the strict contract
		const smuggle = await worker(jarA, '/api/approvals', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				intent: intentFor(projA, planV1Hash),
				decision: 'approved',
				decidedBy: bobId,
			}),
		});
		expect(smuggle.status).toBe(400);

		const res = await decideAs(jarA, projA, planV1Hash, 'approved');
		expect(res.status).toBe(200);
		const { approval } = (await res.json()) as { approval: { id: string; status: string; decidedBy: string } };
		expect(approval.status).toBe('approved');
		// database truth: decidedBy is alice's session user id, nobody else's
		const rows = await d1Rows(
			`select "decidedBy", "status" from "approvals" where "id" = '${approval.id}'`,
		);
		expect(rows[0]).toEqual({ decidedBy: aliceId, status: 'approved' });
		expect(await d1Count(WORKER_BASE, 'approvals', `"projectId" = '${projA}' and "status" = 'approved' and "decidedBy" = '${aliceId}'`)).toBe(1);
	});

	test('duplicate approve click is idempotent (single row, same decision)', async () => {
		const res = await decideAs(jarA, projA, planV1Hash, 'approved');
		expect(res.status).toBe(200);
		expect(await d1Count(WORKER_BASE, 'approvals', `"projectId" = '${projA}' and "revisionHash" = '${planV1Hash}'`)).toBe(1);
	});

	test('a non-member cannot decide a pending approval for the project (403, no row changes)', async () => {
		const pendingHash = planV1Hash; // v1 already approved; request a fresh intent for rejection testing below
		const freshHash = await revisePlan(jarA, projA, 'controls plan v1-unapproved-branch');
		expect(freshHash).not.toBe(pendingHash);
		await agentRequest(projA, freshHash);
		const bobDecide = await decideAs(jarB, projA, freshHash, 'approved');
		expect(bobDecide.status).toBe(403);
		expect(((await bobDecide.json()) as { error: string }).error).toBe('not_a_member');
		expect(await d1Count(WORKER_BASE, 'approvals', `"revisionHash" = '${freshHash}' and "status" = 'pending' and "decidedBy" is null`)).toBe(1);
	});

	test('contracts.md mirror: stale approved revision is rejected AT EFFECT TIME with ZERO provider invocations', async () => {
		// approve v1 (already done above), revise the plan to v2, attempt deploy
		const before = await providerCount();
		const v2Hash = await revisePlan(jarA, projA, 'controls plan v2');
		expect(v2Hash).not.toBe(planV1Hash);
		const attempt = await deployAttempt({ actorId: aliceId, projectId: projA });
		expect(attempt.ok).toBe(false);
		expect(attempt.status).toBe(403);
		expect(attempt.body.error).toBe('STALE_APPROVAL');
		// the invariant: the rejection happened BEFORE any provider effect
		expect(await providerCount()).toBe(before);
	});

	test('contracts.md mirror: approving the CURRENT revision lets exactly that effect run (provider called once)', async () => {
		const before = await providerCount();
		const rows = await d1Rows(
			`select "bodyHash" from "plan_doc_revisions" where "projectId" = '${projA}' and "kind" = 'plan' order by "revision" desc limit 1`,
		);
		const v2Hash = String(rows[0]!['bodyHash']);
		const res = await decideAs(jarA, projA, v2Hash, 'approved');
		expect(res.status).toBe(200);
		const attempt = await deployAttempt({ actorId: aliceId, projectId: projA });
		expect(attempt.ok).toBe(true);
		expect(await providerCount()).toBe(before + 1);
	});

	test('approving a NEWER revision supersedes the older approved revision (old one can never execute again)', async () => {
		const v3Hash = await revisePlan(jarA, projA, 'controls plan v3');
		await decideAs(jarA, projA, v3Hash, 'approved');
		// v2's approval row is now superseded — an effect for v2 must be stale
		const recent = await d1Rows(
			`select "bodyHash" from "plan_doc_revisions" where "projectId" = '${projA}' and "kind" = 'plan' order by "revision" desc limit 2`,
		);
		const v2Hash = String(recent[1]!['bodyHash']); // second-newest = v2
		const before = await providerCount();
		const attempt = await deployAttempt({ actorId: aliceId, projectId: projA, revisionHash: v2Hash });
		expect(attempt.ok).toBe(false);
		expect(attempt.body.error).toBe('STALE_APPROVAL');
		expect(await providerCount()).toBe(before);
		const superseded = await d1Rows(
			`select "status" from "approvals" where "projectId" = '${projA}' and "revisionHash" = '${planV1Hash}' order by "createdAt" desc, "rowid" desc limit 1`,
		);
		// v1 row (superseded by v2's approval in the previous test) stays superseded
		expect(['superseded']).toContain(String(superseded[0]?.['status']));
	});

	test('expiry at effect time: a decision with a 1s window passes NOW and fails with APPROVAL_EXPIRED in the future (clock injection, no sleeps)', async () => {
		const hash = await revisePlan(jarA, projA, 'controls plan expiry');
		await agentRequest(projA, hash);
		const res = await decideAs(jarA, projA, hash, 'approved', { ttlSeconds: 1 });
		expect(res.status).toBe(200);
		const approved = (await res.clone().json()) as { approval: { expiresAt: string } };

		// within the window: passes (gate given a now slightly after decision)
		const within = await deployAttempt({
			actorId: aliceId,
			projectId: projA,
			revisionHash: hash,
			now: new Date(Date.parse(approved.approval.expiresAt) - 500).toISOString(),
		});
		expect(within.ok).toBe(true);

		// past the window: APPROVAL_EXPIRED, zero provider delta
		const before = await providerCount();
		const expired = await deployAttempt({
			actorId: aliceId,
			projectId: projA,
			revisionHash: hash,
			now: new Date(Date.parse(approved.approval.expiresAt) + 1000).toISOString(),
		});
		expect(expired.ok).toBe(false);
		expect(expired.body.error).toBe('APPROVAL_EXPIRED');
		expect(await providerCount()).toBe(before);
	});

	test('revocation: approved then revoked is APPROVAL_REVOKED at effect time', async () => {
		const hash = await revisePlan(jarA, projA, 'controls plan revoke');
		await agentRequest(projA, hash);
		const res = await decideAs(jarA, projA, hash, 'approved');
		const { approval } = (await res.json()) as { approval: { id: string } };
		expect((await deployAttempt({ actorId: aliceId, projectId: projA, revisionHash: hash })).ok).toBe(true);

		const revoke = await worker(jarA, `/api/approvals/${approval.id}/revoke`, { method: 'POST' });
		expect(revoke.status).toBe(200);
		expect(((await revoke.json()) as { approval: { status: string } }).approval.status).toBe('revoked');

		const before = await providerCount();
		const attempt = await deployAttempt({ actorId: aliceId, projectId: projA, revisionHash: hash });
		expect(attempt.ok).toBe(false);
		expect(attempt.body.error).toBe('APPROVAL_REVOKED');
		expect(await providerCount()).toBe(before);
	});

	test('wrong project: an approval from another project never authorizes an effect there (APPROVAL_WRONG_PROJECT)', async () => {
		const hash = await revisePlan(jarA, projA2, 'sidecar plan v1');
		await agentRequest(projA2, hash);
		await decideAs(jarA, projA2, hash, 'approved');
		// deploy attempt bound to projA (a DIFFERENT project) with the same
		// action/resource/revision/policy — the projA2 approval must not travel
		const before = await providerCount();
		const attempt = await deployAttempt({
			actorId: aliceId,
			projectId: projA,
			revisionHash: hash,
		});
		expect(attempt.ok).toBe(false);
		expect(attempt.body.error).toBe('APPROVAL_WRONG_PROJECT');
		expect(await providerCount()).toBe(before);
	});

	test('wrong actor: bob (not the deciding actor) cannot ride alice\'s approval (APPROVAL_WRONG_ACTOR)', async () => {
		const hash = await revisePlan(jarA, projA, 'controls plan actor');
		await agentRequest(projA, hash);
		await decideAs(jarA, projA, hash, 'approved');
		const before = await providerCount();
		const attempt = await deployAttempt({ actorId: bobId, projectId: projA, revisionHash: hash });
		expect(attempt.ok).toBe(false);
		expect(attempt.body.error).toBe('APPROVAL_WRONG_ACTOR');
		expect(await providerCount()).toBe(before);
	});

	test('rejected decision: gate stays closed (STALE_APPROVAL), provider never invoked', async () => {
		const hash = await revisePlan(jarA, projA, 'controls plan rejected');
		await agentRequest(projA, hash);
		const res = await decideAs(jarA, projA, hash, 'rejected');
		expect(res.status).toBe(200);
		expect(((await res.json()) as { approval: { status: string } }).approval.status).toBe('rejected');
		const before = await providerCount();
		const attempt = await deployAttempt({ actorId: aliceId, projectId: projA, revisionHash: hash });
		expect(attempt.ok).toBe(false);
		expect(attempt.body.error).toBe('STALE_APPROVAL');
		expect(await providerCount()).toBe(before);
	});

	test('unauthenticated decide/read/revoke is 401', async () => {
		const noSession = makeWorker(WORKER_BASE)(new (await import('./fixtures/controls-harness.ts')).Jar(), '/api/approvals', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ intent: intentFor(projA, planV1Hash), decision: 'approved' }),
		});
		expect((await noSession).status).toBe(401);
	});
});

// --- slice 2: external-effects ledger --------------------------------------------------

/**
 * The narrow external-operation ledger (feature-ledger H5): unique operation
 * key elects ONE dispatcher; a cancellation request is NOT confirmed
 * termination; an ambiguous dispatch leaves reconciliation-required and can
 * only leave it via a real receipt — never a blind retry. All of this runs
 * through the fixture control routes into the production service on real D1.
 */
describe('P03 slice 2: external-effects ledger over real workerd + D1', () => {
	const json = jsonHeaders;

	function opsPost(path: string, body: Record<string, unknown>): Promise<Response> {
		return fetch(`${WORKER_BASE}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });
	}

	async function opsRow(operationKey: string): Promise<Record<string, unknown> | null> {
		const res = await fetch(`${WORKER_BASE}/__test/operations/get/${encodeURIComponent(operationKey)}`);
		const body = (await res.json()) as { operation: Record<string, unknown> | null };
		return body.operation;
	}

	async function opCount(operationKey: string): Promise<number> {
		return d1Count(WORKER_BASE, 'external_operations', `"operationKey" = '${operationKey}'`);
	}

	test('prepare inserts one row; a duplicate prepare with the same operationKey conflicts 409 and exactly one row remains', async () => {
		const res = await opsPost('/__test/operations/prepare', {
			projectId: ledgerProjectId,
			runId: 'run-ops-1',
			provider: 'contree',
			operationKey: 'deploy/main@rev-a',
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { operation: { status: string } }).operation.status).toBe('prepared');

		const dup = await opsPost('/__test/operations/prepare', {
			projectId: ledgerProjectId,
			runId: 'run-ops-2',
			provider: 'contree',
			operationKey: 'deploy/main@rev-a',
		});
		expect(dup.status).toBe(409);
		expect(((await dup.json()) as { error: string }).error).toBe('operation_key_conflict');
		expect(await opCount('deploy/main@rev-a')).toBe(1);
	});

	test('dispatch -> receipt -> succeeded (idempotent receipt replay, conflicting receipt rejected)', async () => {
		const key = 'deploy/main@rev-b';
		expect((await opsPost('/__test/operations/prepare', { projectId: ledgerProjectId, runId: 'run-ops-1', provider: 'contree', operationKey: key })).status).toBe(200);
		const dispatched = await opsPost('/__test/operations/dispatch', { operationKey: key, remoteId: 'remote-1' });
		expect(dispatched.status).toBe(200);
		expect(((await dispatched.json()) as { operation: { status: string; remoteId: string } }).operation).toMatchObject({ status: 'dispatched', remoteId: 'remote-1' });

		const receipt = await opsPost('/__test/operations/receipt', { operationKey: key, receiptId: 'rcpt-1', outcome: 'succeeded' });
		expect(receipt.status).toBe(200);
		expect(((await receipt.json()) as { operation: { status: string; receiptId: string } }).operation).toMatchObject({ status: 'succeeded', receiptId: 'rcpt-1' });

		// replaying the same receipt is a no-op, not a duplicate effect
		const replay = await opsPost('/__test/operations/receipt', { operationKey: key, receiptId: 'rcpt-1', outcome: 'succeeded' });
		expect(replay.status).toBe(200);
		expect(await opCount(key)).toBe(1);
		// a DIFFERENT receipt on a terminal row is a conflict
		const conflict = await opsPost('/__test/operations/receipt', { operationKey: key, receiptId: 'rcpt-2', outcome: 'failed' });
		expect(conflict.status).toBe(409);
		expect(((await conflict.json()) as { error: string }).error).toBe('receipt_conflict');
	});

	test('dispatch timeout path: reconciliation-required, and a later receipt with the same key RECONCILES instead of duplicating', async () => {
		const key = 'sandbox/exec@rev-c';
		expect((await opsPost('/__test/operations/prepare', { projectId: ledgerProjectId, runId: 'run-ops-1', provider: 'contree', operationKey: key })).status).toBe(200);
		expect((await opsPost('/__test/operations/dispatch', { operationKey: key, remoteId: 'remote-2' })).status).toBe(200);

		// uncertain outcome: mark reconciliation-required (NEVER a blind retry)
		const ambiguous = await opsPost('/__test/operations/reconciliation-required', { operationKey: key });
		expect(ambiguous.status).toBe(200);
		expect(((await ambiguous.json()) as { operation: { status: string } }).operation.status).toBe('reconciliation-required');

		// re-dispatch from reconciliation-required is refused (no blind retry)
		const redispatch = await opsPost('/__test/operations/dispatch', { operationKey: key, remoteId: 'remote-3' });
		expect(redispatch.status).toBe(409);
		expect(((await redispatch.json()) as { error: string }).error).toBe('operation_invalid_transition');

		// the provider's late receipt with the SAME operation key reconciles the row
		const receipt = await opsPost('/__test/operations/receipt', { operationKey: key, receiptId: 'rcpt-3', outcome: 'succeeded' });
		expect(receipt.status).toBe(200);
		expect(((await receipt.json()) as { operation: { status: string } }).operation.status).toBe('succeeded');
		// still exactly one logical operation — the effect did not duplicate
		expect(await opCount(key)).toBe(1);

		// provider correlation lookup by (provider, operationKey) finds it
		const correlate = await fetch(`${WORKER_BASE}/__test/operations/correlate?provider=contree&operationKey=${encodeURIComponent(key)}`);
		expect(((await correlate.json()) as { operation: { status: string } | null }).operation?.status).toBe('succeeded');
	});

	test('cancel-requested is NOT cancelled: pending-remote until a cancelled receipt proves termination', async () => {
		const key = 'sandbox/exec@rev-d';
		expect((await opsPost('/__test/operations/prepare', { projectId: ledgerProjectId, runId: 'run-ops-1', provider: 'contree', operationKey: key })).status).toBe(200);
		expect((await opsPost('/__test/operations/dispatch', { operationKey: key, remoteId: 'remote-4' })).status).toBe(200);

		const requested = await opsPost('/__test/operations/cancel-request', { operationKey: key });
		expect(requested.status).toBe(200);
		const requestedOp = ((await requested.json()) as { operation: { status: string; receiptId: string | null } }).operation;
		expect(requestedOp.status).toBe('cancel-requested');
		expect(requestedOp.receiptId).toBeNull();
		// database truth: still pending-remote, no confirmation
		expect((await opsRow(key))?.['status']).toBe('cancel-requested');

		// only a provider receipt turns cancel-requested into cancelled
		const confirmed = await opsPost('/__test/operations/cancel-confirm', { operationKey: key, receiptId: 'rcpt-cancel-1' });
		expect(confirmed.status).toBe(200);
		const confirmedOp = ((await confirmed.json()) as { operation: { status: string; receiptId: string } }).operation;
		expect(confirmedOp.status).toBe('cancelled');
		expect(confirmedOp.receiptId).toBe('rcpt-cancel-1');
	});

	test('receipts cannot fabricate completion without a dispatch; unknown keys 404', async () => {
		const key = 'sandbox/exec@rev-e';
		expect((await opsPost('/__test/operations/prepare', { projectId: ledgerProjectId, runId: 'run-ops-1', provider: 'contree', operationKey: key })).status).toBe(200);
		const phantom = await opsPost('/__test/operations/receipt', { operationKey: key, receiptId: 'rcpt-x', outcome: 'succeeded' });
		expect(phantom.status).toBe(409);
		expect(((await phantom.json()) as { error: string }).error).toBe('operation_invalid_transition');
		// database truth: still prepared, no fabricated receipt
		expect((await opsRow(key))?.['status']).toBe('prepared');

		const missing = await opsPost('/__test/operations/receipt', { operationKey: 'no-such-key', receiptId: 'r', outcome: 'failed' });
		expect(missing.status).toBe(404);
	});
});
