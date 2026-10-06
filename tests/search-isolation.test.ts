import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SearchResponse } from '../apps/app/src/server/search.ts';
import {
	Jar,
	applyMigrations,
	d1Exec,
	freePort,
	makeWorker,
	signInAs,
	startProfileFixture,
	stopProfileFixture,
	StubProvider,
} from './fixtures/profile-harness.ts';

/**
 * P14 — search isolation (feature-ledger audit defect: "search must not leak
 * across projects"), executed against a real local workerd with real
 * SQLite-backed D1.
 *
 * Honesty classification: LOCAL VERIFIED for worker runtime, D1 persistence
 * and isolation behavior; sign-in flows are SIMULATED at the stub OAuth
 * provider boundary (same classification as P01/P02).
 *
 * The invariant under test: a user's search results (items AND counts) cover
 * exactly the content they can access — their projects (via workspace
 * membership), plan-doc revisions and task titles of those projects, and
 * memory facts (their personal ones plus facts of projects they belong to).
 * Content of a non-member's project never appears, not even when the search
 * string matches, and no count leaks the existence of inaccessible matches.
 *
 * Note on "task titles": this build has no dedicated tasks table yet, so task
 * titles are the first lines of plan-doc revisions with kind='tasks' — the
 * same structure planning uses to record task lists. When a tasks table
 * arrives, it joins this module's section list without changing the
 * permission model.
 */

let WORKER_PORT = 0;
let WORKER_BASE = '';
let stub: StubProvider;

const worker = (jar: Jar, path: string, init?: RequestInit) => makeWorker(WORKER_BASE)(jar, path, init);

async function search(
	jar: Jar,
	query: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<{ status: number; body: SearchResponse | { error?: string; message?: string } }> {
	const params = new URLSearchParams({ q: query });
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	if (opts.offset !== undefined) params.set('offset', String(opts.offset));
	const res = await worker(jar, `/api/search?${params.toString()}`);
	return { status: res.status, body: (await res.json().catch(() => null)) as never };
}

interface Seeded {
	alice: Jar;
	bob: Jar;
	carol: Jar;
	aliceProjectId: string;
	bobProjectId: string;
	alicePlanDocId: string;
	aliceTaskDocId: string;
	aliceMemoryFactId: string;
	alicePersonalFactId: string;
	bobPlanDocId: string;
	bobMemoryFactId: string;
}

let seeded: Seeded;

beforeAll(async () => {
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	await startProfileFixture(WORKER_PORT, {
		AUTH_STUB_BASE_URL: stub.url,
		INVITE_ALLOWLIST: 'alice@example.com,bob@example.com,carol@example.com',
	});
	await applyMigrations(WORKER_PORT);

	const alice = await signInAs(worker, stub, 'alice@example.com', 'p14-search-alice', 'Alice Search');
	const bob = await signInAs(worker, stub, 'bob@example.com', 'p14-search-bob', 'Bob Search');
	const carol = await signInAs(worker, stub, 'carol@example.com', 'p14-search-carol', 'Carol Search');

	async function post(jar: Jar, path: string, body: unknown): Promise<Record<string, any>> {
		const res = await worker(jar, path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const parsed = (await res.json().catch(() => null)) as never;
		if (res.status !== 200 && res.status !== 201) {
			throw new Error(`POST ${path} failed (${res.status}): ${JSON.stringify(parsed)}`);
		}
		return parsed;
	}

	// Alice's world: workspace + project "Alpha Rocket" with plan + tasks docs
	const aliceWs = await post(alice, '/api/workspaces', { name: 'Search ws Alice' });
	const aliceProject = await post(alice, '/api/projects', {
		workspaceId: aliceWs.workspace.id,
		name: 'Alpha Rocket',
		description: 'alpha telemetry stack for the orbital contest',
	});
	const alicePlan = await post(alice, `/api/projects/${aliceProject.project.id}/plan-docs`, {
		kind: 'plan',
		body: 'Alpha rocket plan\nBuild the alpha telemetry pipeline first.',
	});
	const aliceTask = await post(alice, `/api/projects/${aliceProject.project.id}/plan-docs`, {
		kind: 'tasks',
		body: 'Fix the alpha injector\nThen calibrate the alpha pump',
	});

	// Bob's world: a project whose name ALSO matches "alpha" — alice must
	// never see it and vice versa
	const bobWs = await post(bob, '/api/workspaces', { name: 'Search ws Bob' });
	const bobProject = await post(bob, '/api/projects', {
		workspaceId: bobWs.workspace.id,
		name: 'Alpha Secret',
		description: "bob's private alpha plans",
	});
	const bobPlan = await post(bob, `/api/projects/${bobProject.project.id}/plan-docs`, {
		kind: 'plan',
		body: 'Secret alpha roadmap\nKeep the alpha budget hidden.',
	});

	// Memory on both sides
	const aliceFact = await post(alice, '/api/memory', {
		projectId: aliceProject.project.id,
		kind: 'fact',
		content: 'The alpha pipeline runs nightly',
	});
	const alicePersonalFact = await post(alice, '/api/memory', {
		kind: 'preference',
		content: 'Prefers alpha shorthand in reports',
	});
	const bobFact = await post(bob, '/api/memory', {
		projectId: bobProject.project.id,
		kind: 'fact',
		content: 'Bob hides the alpha budget',
	});

	// Carol becomes a member of ALICE's workspace (fixture D1 control route)
	await d1Exec(
		WORKER_BASE,
		`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
		 select 'p14-search-carol', '${aliceWs.workspace.id}', (select "id" from "user" where email = 'carol@example.com'), 'member', '2026-10-05T00:00:00.000Z'`,
	);

	seeded = {
		alice,
		bob,
		carol,
		aliceProjectId: aliceProject.project.id,
		bobProjectId: bobProject.project.id,
		alicePlanDocId: alicePlan.revision.id,
		aliceTaskDocId: aliceTask.revision.id,
		aliceMemoryFactId: aliceFact.fact.id,
		alicePersonalFactId: alicePersonalFact.fact.id,
		bobPlanDocId: bobPlan.revision.id,
		bobMemoryFactId: bobFact.fact.id,
	};
}, 180_000);

afterAll(async () => {
	stopProfileFixture(WORKER_PORT);
	await stub.stop();
});

// --- helpers ---------------------------------------------------------------------

function ids(section: { items: { id: string }[] }): string[] {
	return section.items.map((i) => i.id).sort();
}

// --- the isolation matrix ----------------------------------------------------------

describe('P14 search: isolation matrix — results and counts cover exactly the accessible set', () => {
	test('alice searching "alpha" sees exactly her own content, never bob\u2019s', async () => {
		const { status, body } = await search(seeded.alice, 'alpha');
		expect(status).toBe(200);
		const r = body as SearchResponse;

		// EXACT result sets (not just "contains"): projects
		expect(ids(r.sections.projects)).toEqual([seeded.aliceProjectId]);
		// both of her plan-doc revisions mention alpha (plan + tasks doc)
		expect(ids(r.sections.planDocs)).toEqual([seeded.alicePlanDocId, seeded.aliceTaskDocId].sort());
		// the tasks section picks the kind='tasks' revision
		expect(ids(r.sections.tasks)).toEqual([seeded.aliceTaskDocId]);
		// memory: her project fact AND her personal fact, not bob's
		expect(ids(r.sections.memory)).toEqual([seeded.aliceMemoryFactId, seeded.alicePersonalFactId].sort());

		// no bob content anywhere, in titles or snippets
		const serialized = JSON.stringify(r);
		expect(serialized).not.toContain('Alpha Secret');
		expect(serialized).not.toContain("bob's private alpha plans");
		expect(serialized).not.toContain('Secret alpha roadmap');

		// totals agree with the exact sets — no hidden inaccessible matches
		expect(r.sections.projects.total).toBe(1);
		expect(r.sections.planDocs.total).toBe(2);
		expect(r.sections.tasks.total).toBe(1);
		expect(r.sections.memory.total).toBe(2);
		expect(r.total).toBe(6);
	});

	test('bob searching "alpha" sees exactly his own content, never alice\u2019s', async () => {
		const { status, body } = await search(seeded.bob, 'alpha');
		expect(status).toBe(200);
		const r = body as SearchResponse;

		expect(ids(r.sections.projects)).toEqual([seeded.bobProjectId]);
		expect(ids(r.sections.planDocs)).toEqual([seeded.bobPlanDocId]);
		expect(ids(r.sections.tasks)).toEqual([]);
		expect(ids(r.sections.memory)).toEqual([seeded.bobMemoryFactId]);

		const serialized = JSON.stringify(r);
		expect(serialized).not.toContain('Alpha Rocket');
		expect(serialized).not.toContain('alpha telemetry stack');
		expect(serialized).not.toContain('The alpha pipeline runs nightly');
		expect(r.total).toBe(3); // his project + his plan doc + his memory fact
	});

	test('a member of alice\u2019s workspace (carol) sees alice\u2019s project content but NOT alice\u2019s personal memory', async () => {
		const { status, body } = await search(seeded.carol, 'alpha');
		expect(status).toBe(200);
		const r = body as SearchResponse;

		expect(ids(r.sections.projects)).toEqual([seeded.aliceProjectId]);
		expect(ids(r.sections.planDocs)).toEqual([seeded.alicePlanDocId, seeded.aliceTaskDocId].sort());
		expect(ids(r.sections.tasks)).toEqual([seeded.aliceTaskDocId]);
		// the shared project fact is visible to her; alice's PERSONAL fact is not
		expect(ids(r.sections.memory)).toEqual([seeded.aliceMemoryFactId]);

		const serialized = JSON.stringify(r);
		expect(serialized).not.toContain('Alpha Secret');
		expect(serialized).not.toContain('Prefers alpha shorthand');
	});

	test('searching for content that exists ONLY in the other user\u2019s project returns nothing (no echo, no counts)', async () => {
		const { status, body } = await search(seeded.alice, 'roadmap');
		expect(status).toBe(200);
		const r = body as SearchResponse;
		expect(r.total).toBe(0);
		for (const section of Object.values(r.sections)) {
			expect(section.items).toEqual([]);
			expect(section.total).toBe(0);
		}
	});

	test('unauthenticated search is rejected (401, fail-closed)', async () => {
		const { status } = await search(new Jar(), 'alpha');
		expect(status).toBe(401);
	});
});

// --- behavior details ----------------------------------------------------------------

describe('P14 search: deletion, matching and caps', () => {
	test('retracted (deleted) memory is excluded from search results and counts', async () => {
		// create + retract a matching fact as alice
		const created = (await (
			await worker(seeded.alice, '/api/memory', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'fact', content: 'alpha retract probe' }),
			})
		).json()) as { fact: { id: string } };
		await worker(seeded.alice, `/api/memory/${created.fact.id}/retract`, { method: 'POST' });

		const { body } = await search(seeded.alice, 'retract probe');
		const r = body as SearchResponse;
		expect(r.total).toBe(0);
		expect(JSON.stringify(r)).not.toContain('alpha retract probe');
	});

	test('proposed (unconfirmed) facts are not searchable until the user confirms them', async () => {
		// an agent-proposed fact matching the query must be invisible to search
		const proposed = (await (
			await worker(seeded.alice, '/api/memory/proposals', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: 'fact',
					content: 'unconfirmed secret sauce preference',
					sourceRunId: 'run-p14-search-probe',
				}),
			})
		).json()) as { fact: { id: string } };

		const before = (await search(seeded.alice, 'secret sauce')).body as SearchResponse;
		expect(before.total).toBe(0);
		// (sections only — the echoed `query` field naturally repeats the string)
		expect(JSON.stringify(before.sections)).not.toContain('secret sauce');

		// after the user confirms, the same fact becomes searchable
		await worker(seeded.alice, `/api/memory/${proposed.fact.id}/confirm`, { method: 'POST' });
		const after = (await search(seeded.alice, 'secret sauce')).body as SearchResponse;
		expect(after.total).toBe(1);
		expect(ids(after.sections.memory)).toEqual([proposed.fact.id]);
	});

	test('LIKE wildcards in the query are matched literally (no wildcard injection)', async () => {
		// "%" alone must not match everything
		const { body } = await search(seeded.alice, '%');
		const r = body as SearchResponse;
		expect(r.total).toBe(0);

		// a query containing an underscore matches nothing rather than acting as a wildcard
		const { body: underscore } = await search(seeded.alice, 'alpha_rocket');
		expect((underscore as SearchResponse).total).toBe(0);
	});

	test('empty and oversized queries are rejected (400)', async () => {
		expect((await search(seeded.alice, '')).status).toBe(400);
		expect((await search(seeded.alice, '   ')).status).toBe(400);
		expect((await search(seeded.alice, 'x'.repeat(201))).status).toBe(400);
	});

	test('result caps and pagination: limit bounds each section, offset pages within it, totals stay exact', async () => {
		// seed 6 additional matching personal facts for alice (total memory hits: 1 personal + 6 = 7)
		for (let i = 0; i < 6; i++) {
			await worker(seeded.alice, '/api/memory', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'preference', content: `paging probe alpha ${i}` }),
			});
		}
		const page1 = (await search(seeded.alice, 'paging probe alpha', { limit: 2 })).body as SearchResponse;
		expect(page1.sections.memory.items).toHaveLength(2);
		expect(page1.sections.memory.total).toBe(6); // exact count of accessible matches
		const page2 = (await search(seeded.alice, 'paging probe alpha', { limit: 2, offset: 2 })).body as SearchResponse;
		expect(page2.sections.memory.items).toHaveLength(2);
		// pages do not overlap
		const p1 = ids(page1.sections.memory);
		const p2 = ids(page2.sections.memory);
		expect(p1.filter((id) => p2.includes(id))).toEqual([]);
		const page4 = (await search(seeded.alice, 'paging probe alpha', { limit: 2, offset: 6 })).body as SearchResponse;
		expect(page4.sections.memory.items).toEqual([]);
		expect(page4.sections.memory.total).toBe(6);
	});

	test('the query is matched case-insensitively across sections (SQLite LIKE semantics)', async () => {
		const { body } = await search(seeded.alice, 'ALPHA ROCKET');
		const r = body as SearchResponse;
		expect(ids(r.sections.projects)).toEqual([seeded.aliceProjectId]);
	});
});
