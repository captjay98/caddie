import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	Jar,
	StubProvider,
	applyMigrations,
	discoveryMigrationPaths,
	d1Exec,
	freePort,
	makeWorker,
	signIn,
	startDiscoveryFixtureWorker,
	stopDiscoveryFixtureWorker,
} from './fixtures/discovery-harness.ts';

/**
 * B04 — plan content and stored decisions
 * (docs/design/2026-10-10-v2/PACKETS.md).
 *
 * Proven against the real workerd + D1 fixture:
 *   - Plan decisions persist per revision, linked to the approval id that
 *     carried the effect.
 *   - A decision is bound to ONE revision: a newer revision needs a new
 *     decision — nothing is inherited across revisions.
 *   - Re-deciding the same revision stores the latest decision (the
 *     decision trail is append-only per record; the newest is authoritative).
 *   - Cross-project isolation: bob can neither read nor write alice's
 *     plan decisions.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const WORKER_PORT_FREE = await freePort();
const WORKER_PORT = WORKER_PORT_FREE;
const WORKER_BASE = `http://127.0.0.1:${WORKER_PORT_FREE}`;
const worker = makeWorker(WORKER_BASE);
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

let stub: StubProvider;
let jarAlice: Jar;
let jarBob: Jar;
let projAlice = '';
let projBob = '';
let revisionA1 = '';
let revisionA2 = '';

async function createWorkspace(jar: Jar, name: string): Promise<string> {
	const res = await worker(jar, '/api/workspaces', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function createProject(jar: Jar, workspaceId: string, name: string): Promise<string> {
	const res = await worker(jar, '/api/projects', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ workspaceId, name }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { project: { id: string } }).project.id;
}

beforeAll(async () => {
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	await startDiscoveryFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
		AUTH_STUB_BASE_URL: stub.url,
	});
	// 0015 rides the standard migration list (the 0011 drift lesson).
	await applyMigrations(WORKER_BASE, discoveryMigrationPaths());

	jarAlice = await signIn(worker, stub, ALICE_EMAIL, 'stub-b04-alice', 'Alice B04');
	jarBob = await signIn(worker, stub, BOB_EMAIL, 'stub-b04-bob', 'Bob B04');
	const wsAlice = await createWorkspace(jarAlice, 'Alice WS B04');
	const wsBob = await createWorkspace(jarBob, 'Bob WS B04');
	projAlice = await createProject(jarAlice, wsAlice, 'Alice decisions');
	projBob = await createProject(jarBob, wsBob, 'Bob decisions');

	// Two revisions of alice's plan doc.
	const r1 = await worker(jarAlice, `/api/projects/${projAlice}/plan-docs`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ kind: 'plan', body: 'Version 1 — the dashboard.' }),
	});
	expect(r1.status).toBe(201);
	revisionA1 = ((await r1.json()) as { revision: { id: string } }).revision.id;
	const r2 = await worker(jarAlice, `/api/projects/${projAlice}/plan-docs`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ kind: 'plan', body: 'Version 2 — adds dark mode.' }),
	});
	expect(r2.status).toBe(201);
	revisionA2 = ((await r2.json()) as { revision: { id: string } }).revision.id;
}, 180_000);

afterAll(async () => {
	stopDiscoveryFixtureWorker(WORKER_PORT);
	await stub.stop();
});

describe('B04 integration: plan decisions', () => {
	test('an approve decision persists per revision, linked to the approval id', async () => {
		const res = await worker(jarAlice, `/api/projects/${projAlice}/plan-docs/${revisionA1}/decision`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ decision: 'approved', approvalId: 'apr-b04-1', note: null }),
		});
		expect(res.status).toBe(201);
		const decision = (await res.json()) as {
			decision: { decision: string; approvalId: string | null; planRevisionId: string };
		};
		expect(decision.decision.decision).toBe('approved');
		expect(decision.decision.approvalId).toBe('apr-b04-1');
		expect(decision.decision.planRevisionId).toBe(revisionA1);

		// Durable: the row is really in D1.
		const rows = await d1Exec(WORKER_BASE, `select count(*) as n from "plan_decisions" where "id" like 'pdec_%' and "projectId" = '${projAlice}'`);
		expect((rows.results as { n: number }[])[0]!.n).toBe(1);
	});

	test('a decision is bound to one revision: the newer version has no decision until one is made', async () => {
		const v1 = await worker(jarAlice, `/api/projects/${projAlice}/plan-docs/${revisionA1}/decision`);
		const v2 = await worker(jarAlice, `/api/projects/${projAlice}/plan-docs/${revisionA2}/decision`);
		expect(((await v1.json()) as { decisions: unknown[] }).decisions).toHaveLength(1);
		expect(((await v2.json()) as { decisions: unknown[] }).decisions).toHaveLength(0);

		// Suggest-a-change on v2 is its own decision record.
		const res = await worker(jarAlice, `/api/projects/${projAlice}/plan-docs/${revisionA2}/decision`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ decision: 'changes', note: 'Please add a dark mode toggle' }),
		});
		expect(res.status).toBe(201);
		const decision = (await res.json()) as { decision: { decision: string; note: string | null; approvalId: string | null } };
		expect(decision.decision.decision).toBe('changes');
		expect(decision.decision.note).toBe('Please add a dark mode toggle');
		expect(decision.decision.approvalId).toBeNull(); // changes need no approval id
	});

	test('re-deciding the same revision appends; the newest record is authoritative', async () => {
		await worker(jarAlice, `/api/projects/${projAlice}/plan-docs/${revisionA1}/decision`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ decision: 'changes', note: 'Actually, add a chart first' }),
		});
		const list = (await (
			await worker(jarAlice, `/api/projects/${projAlice}/plan-docs/${revisionA1}/decision`)
		).json()) as { decisions: { decision: string }[] };
		expect(list.decisions.length).toBeGreaterThanOrEqual(2);
		// Newest first: the latest decision is the changes request.
		expect(list.decisions[0]!.decision).toBe('changes');
	});

	test('cross-project isolation: bob cannot read or write alice\u2019s decisions', async () => {
		const read = await worker(jarBob, `/api/projects/${projAlice}/plan-docs/${revisionA1}/decision`);
		expect(read.status).toBe(403); // not a member of alice's workspace

		const write = await worker(jarBob, `/api/projects/${projAlice}/plan-docs/${revisionA1}/decision`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ decision: 'approved' }),
		});
		expect(write.status).toBe(403);
	});

	test('an unknown revision is a typed 404; an invalid decision value is a typed 400', async () => {
		const missing = await worker(jarAlice, `/api/projects/${projAlice}/plan-docs/pdr-nope/decision`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ decision: 'approved' }),
		});
		expect(missing.status).toBe(404);

		const invalid = await worker(jarAlice, `/api/projects/${projAlice}/plan-docs/${revisionA1}/decision`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ decision: 'maybe' }),
		});
		expect(invalid.status).toBe(400);
	});
});
