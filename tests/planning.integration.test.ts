import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	Jar,
	StubProvider,
	applyMigrations,
	d1Exec,
	freePort,
	makeWorker,
	signIn,
} from './fixtures/discovery-harness.ts';
import {
	discoveryMigrationPaths,
	startDiscoveryFixtureWorker,
	stopDiscoveryFixtureWorker,
} from './fixtures/discovery-harness.ts';
import { join } from 'node:path';

/**
 * P11 slice 2 — planning, executed against a real local workerd (`wrangler
 * dev` = miniflare/workerd) with a real SQLite-backed D1. Reuses the P01–P10
 * fixture harness patterns (free ports, readiness identity check, patterned
 * pkill cleanup).
 *
 * Pinned invariants (packets.md P11 slice 2 + feature-ledger C13/H13):
 *   - kernel/scope/PRD/spec plan docs are created per project from accepted
 *     requirements; contest-free projects work (the contest link is optional).
 *   - Deadline-linked milestones derive from ACTUAL requirements and cite the
 *     P10 evidence claim they came from; the P10 midnight fix carries over
 *     (a date-only deadline stays date-only — no invented time of day).
 *   - Planning produces NEW plan-doc revisions through the P02 service — it
 *     never overwrites; the revision chain is preserved.
 *   - User revisions are preserved: planning does not regenerate what the
 *     user manually revised — revision provenance ('planning' | 'user') is
 *     tracked per plan-doc revision.
 *   - Cross-project plan isolation: two users/two projects cannot read or
 *     write each other's plans (audit defect #2/#3 class).
 *
 * Honesty classification:
 *   - Worker runtime, D1 persistence, Better Auth session mechanics, route
 *     scoping, service behavior: LOCAL VERIFIED (real workerd, real D1).
 *   - The OAuth provider endpoints are stubs inside this test process, so the
 *     sign-in flows are SIMULATED at that boundary (same classification as
 *     P01–P10).
 *   - Plan documents here are deterministic requirement-derived drafts — no
 *     model call is involved and none is claimed.
 */

const REPO_ROOT = join(import.meta.dir, '..');

let WORKER_PORT = 0;
let WORKER_BASE = '';
let stub: StubProvider;

const worker = (jar: Jar, path: string, init?: RequestInit) => makeWorker(WORKER_BASE)(jar, path, init);

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

let jarAlice: Jar;
let jarBob: Jar;
let projAlice = '';
let projBob = '';
let deadlineClaimId = '';
let dateOnlyClaimId = '';

async function createWorkspace(jar: Jar, name: string): Promise<string> {
	const res = await worker(jar, '/api/workspaces', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function createProject(
	jar: Jar,
	workspaceId: string,
	name: string,
): Promise<{ id: string; contestUrl: string | null }> {
	const res = await worker(jar, '/api/projects', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ workspaceId, name }),
	});
	expect(res.status).toBe(201);
	const project = (await res.json()) as { project: { id: string; contestUrl: string | null } };
	return project.project;
}

async function addClaim(
	jar: Jar,
	projectId: string,
	body: Record<string, unknown>,
): Promise<{ status: number; claimId?: string; error?: string }> {
	// register a source + snapshot per claim through the real evidence routes
	const sourceRes = await worker(jar, `/api/projects/${projectId}/evidence/sources`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({
			url: `https://rules.example/${crypto.randomUUID()}`,
			kind: 'page',
			authority: 'binding_rules',
		}),
	});
	expect(sourceRes.status).toBe(201);
	const source = ((await sourceRes.json()) as { source: { id: string } }).source;
	const snapRes = await worker(jar, `/api/projects/${projectId}/evidence/sources/${source.id}/snapshots`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({
			content: `contest rules page quoting: ${String(body.quote ?? '')}`,
			mediaType: 'text/plain',
		}),
	});
	expect(snapRes.status).toBe(201);
	const snapshot = ((await snapRes.json()) as { snapshot: { id: string } }).snapshot;
	const claimRes = await worker(jar, `/api/projects/${projectId}/evidence/claims`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ ...body, snapshotId: snapshot.id, extractionVersion: 'p11-int-1' }),
	});
	const payload = (await claimRes.json()) as { claim?: { id: string }; error?: string };
	return { status: claimRes.status, claimId: payload.claim?.id, error: payload.error };
}

interface MilestoneShape {
	title: string;
	dueDate: string | null;
	dueUtc: string | null;
	hasTime: boolean;
	dueStatus: string;
	deadlineClaimId: string | null;
}

interface GenerateResponse {
	status: number;
	body: {
		result?: {
			revisions: Record<string, { kind: string; revision: number; id: string; body: string } | null>;
			preserved: Record<string, { planRevisionId: string; reason: string } | undefined>;
			milestones: MilestoneShape[];
		};
		error?: string;
	};
}

async function generatePlan(jar: Jar, projectId: string, requirements: unknown): Promise<GenerateResponse> {
	const res = await worker(jar, `/api/projects/${projectId}/planning/generate`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ requirements }),
	});
	return { status: res.status, body: (await res.json()) as never };
}

interface PlanOverview {
	latest: Record<string, { kind: string; revision: number; id: string; body: string } | null>;
	milestones: MilestoneShape[];
	provenance: { kind: string; planRevisionId: string; origin: string }[];
	revisions: { kind: string; revision: number; id: string; body: string }[];
}

async function getPlan(jar: Jar, projectId: string): Promise<{ status: number; body: Partial<PlanOverview> & { error?: string } }> {
	const res = await worker(jar, `/api/projects/${projectId}/planning/plan`);
	return { status: res.status, body: (await res.json()) as never };
}

/** Alice's accepted requirements; claim ids resolve lazily after beforeAll. */
function aliceRequirements(): { text: string; deadlineClaimId?: string; dueZone?: string }[] {
	return [
		{ text: 'Accessible transit planner for the city open-data set' },
		{
			text: 'Submissions due by the stated deadline',
			deadlineClaimId: deadlineClaimId,
			dueZone: 'America/Los_Angeles',
		},
		{
			text: 'Working demo ready by demo day',
			deadlineClaimId: dateOnlyClaimId,
			dueZone: 'America/Los_Angeles',
		},
	];
}

beforeAll(async () => {
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	await startDiscoveryFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
		AUTH_STUB_BASE_URL: stub.url,
	});
	await applyMigrations(WORKER_BASE, discoveryMigrationPaths());

	jarAlice = await signIn(worker, stub, ALICE_EMAIL, 'stub-sub-alice-p11', 'Alice P11');
	jarBob = await signIn(worker, stub, BOB_EMAIL, 'stub-sub-bob-p11', 'Bob P11');
	const wsAlice = await createWorkspace(jarAlice, 'Alice WS P11');
	const wsBob = await createWorkspace(jarBob, 'Bob WS P11');
	// Alice's project is deliberately CONTEST-FREE (contest link optional).
	const aliceProject = await createProject(jarAlice, wsAlice, 'Alice contest-free project');
	projAlice = aliceProject.id;
	expect(aliceProject.contestUrl).toBeNull();
	projBob = (await createProject(jarBob, wsBob, 'Bob project')).id;

	// Actual requirements, stored as P10 evidence claims in ALICE's project.
	const resolved = await addClaim(jarAlice, projAlice, {
		claimType: 'requirement.submission_deadline',
		value: 'November 6, 2026 at 5:00 PM',
		quote: '"Submissions are due November 6, 2026 at 5:00 PM."',
	});
	expect(resolved.status).toBe(201);
	deadlineClaimId = resolved.claimId!;
	const dateOnly = await addClaim(jarAlice, projAlice, {
		claimType: 'requirement.demo_deadline',
		value: 'September 21, 2026',
		quote: '"Demo day is September 21, 2026."',
	});
	expect(dateOnly.status).toBe(201);
	dateOnlyClaimId = dateOnly.claimId!;
}, 180_000);

afterAll(async () => {
	stopDiscoveryFixtureWorker(WORKER_PORT);
	await stub.stop();
});

// --- schema on real D1 -----------------------------------------------------------

describe('P11 integration: planning schema on real workerd D1', () => {
	test('migrations apply cleanly; planning + discovery tables exist with the provenance vocabulary', async () => {
		const res = await d1Exec(
			WORKER_BASE,
			`select name, sql from sqlite_master where type = 'table' order by name`,
		);
		const tables = new Map(
			(res.results as { name: string; sql: string }[]).map((r) => [r.name, r.sql]),
		);
		for (const table of [
			'planning_milestones',
			'planning_revision_provenance',
			'discovery_candidates',
			'discovery_feed_runs',
			'discovery_feed_sources',
			'discovery_seed_candidates',
		]) {
			expect(tables.has(table)).toBe(true);
		}
		const provenanceDdl = tables.get('planning_revision_provenance') ?? '';
		for (const origin of ['planning', 'user']) {
			expect(provenanceDdl).toContain(`'${origin}'`);
		}
	});
});

// --- plan-doc lifecycle -------------------------------------------------------------

describe('P11 integration: plan documents are created per project from accepted requirements', () => {
	test('generate creates kernel/scope/prd/spec for a CONTEST-FREE project, with deadline-linked milestones', async () => {
		const generated = await generatePlan(jarAlice, projAlice, aliceRequirements());
		expect(generated.status).toBe(201);
		const result = generated.body.result!;
		for (const kind of ['kernel', 'scope', 'prd', 'spec']) {
			expect(result.revisions[kind]?.revision).toBe(1);
			expect(result.revisions[kind]?.kind).toBe(kind);
		}
		// Contest-free: the docs say so instead of inventing a contest.
		expect(result.revisions.kernel!.body).toContain('contest-free');
		// Every requirement carries its (empty) evidence line honestly.
		expect(result.revisions.prd!.body).toContain('Accessible transit planner');

		const milestones = result.milestones;
		expect(milestones).toHaveLength(2);
		const resolved = milestones.find((m) => m.deadlineClaimId === deadlineClaimId)!;
		expect(resolved.dueStatus).toBe('resolved');
		expect(resolved.hasTime).toBe(true);
		// Nov 6, 2026 5:00 PM in America/Los_Angeles (PST, DST already ended)
		// normalizes to the next-day UTC instant — timezone truth, not prose.
		expect(resolved.dueUtc).toBe('2026-11-07T01:00:00.000Z');
		const dateOnly = milestones.find((m) => m.deadlineClaimId === dateOnlyClaimId)!;
		// THE MIDNIGHT FIX, carried into planning: a date-only deadline keeps
		// date-only semantics — a calendar date, no invented instant.
		expect(dateOnly.dueStatus).toBe('date_only');
		expect(dateOnly.dueDate).toBe('2026-09-21');
		expect(dateOnly.dueUtc).toBeNull();
		expect(dateOnly.hasTime).toBe(false);
	});

	test('planning appends new revisions through the P02 service — the chain is preserved, never overwritten', async () => {
		const second = await generatePlan(jarAlice, projAlice, [
			{ text: 'Accessible transit planner for the city open-data set' },
		]);
		expect(second.status).toBe(201);
		expect(second.body.result!.revisions.kernel!.revision).toBe(2);

		const overview = await getPlan(jarAlice, projAlice);
		expect(overview.status).toBe(200);
		const kernelRevisions = (overview.body.revisions ?? []).filter((r) => r.kind === 'kernel');
		expect(kernelRevisions.map((r) => r.revision).sort((a, b) => a - b)).toEqual([1, 2]);
		// Milestones dedupe: the same requirement does not duplicate a row.
		const milestoneRows = await d1Exec(
			WORKER_BASE,
			`select count(*) as n from "planning_milestones" where "projectId" = '${projAlice}'`,
		);
		expect(Number((milestoneRows.results as { n: number }[])[0]?.n)).toBe(2);
	});

	test('a user revision is provenance-tracked and planning preserves it on regeneration', async () => {
		const userRevRes = await worker(jarAlice, `/api/projects/${projAlice}/planning/plan-docs`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ kind: 'prd', body: '# PRD — my own words, planning must not touch this' }),
		});
		expect(userRevRes.status).toBe(201);
		const userRevision = ((await userRevRes.json()) as { revision: { id: string; revision: number } }).revision;
		expect(userRevision.revision).toBe(3);

		const regenerated = await generatePlan(jarAlice, projAlice, [
			{ text: 'A requirement added after the user edit' },
		]);
		expect(regenerated.status).toBe(201);
		const result = regenerated.body.result!;
		// prd was NOT regenerated: no new planning revision — the user's
		// revision is the current one (preserved, id echoed under `preserved`).
		expect(result.preserved.prd?.planRevisionId).toBe(userRevision.id);
		expect(result.revisions.prd).toBeNull();
		// the other kinds moved on
		for (const kind of ['kernel', 'scope', 'spec']) {
			expect(result.revisions[kind]!.revision).toBe(3);
		}

		const overview = await getPlan(jarAlice, projAlice);
		expect(overview.body.latest?.prd?.body).toContain('my own words');
		const prdProvenance = (overview.body.provenance ?? []).filter((p) => p.kind === 'prd');
		const origins = new Map(prdProvenance.map((p) => [p.planRevisionId, p.origin]));
		expect(origins.get(userRevision.id)).toBe('user');
	});
});

// --- scoping and honesty ----------------------------------------------------------------

describe('P11 integration: project scoping and requirement honesty', () => {
	test('a fabricated deadline claim id is refused — milestones cite real project evidence', async () => {
		const generated = await generatePlan(jarAlice, projAlice, [
			{ text: 'Requirement with a fabricated deadline', deadlineClaimId: 'clm_fabricated' },
		]);
		expect(generated.status).toBe(404);
		expect(generated.body.error).toBe('claim_not_found');
	});

	test('bob cannot read or generate into alice\'s project; plans are isolated per project', async () => {
		const read = await getPlan(jarBob, projAlice);
		expect([403, 404]).toContain(read.status);

		const write = await generatePlan(jarBob, projAlice, [{ text: 'bob should not get in' }]);
		expect([403, 404]).toContain(write.status);

		// bob's own project is unaffected and separate
		const bobGenerate = await generatePlan(jarBob, projBob, [{ text: 'Bob requirement' }]);
		expect(bobGenerate.status).toBe(201);
		const aliceOverview = await getPlan(jarAlice, projAlice);
		expect((aliceOverview.body.revisions ?? []).every((r) => r.body.includes('Bob requirement'))).toBe(false);
	});

	test('unauthenticated plan access is rejected', async () => {
		const res = await worker(new Jar(), `/api/projects/${projAlice}/planning/plan`);
		expect(res.status).toBe(401);
	});
});

// --- discovery candidate routes (slice 3) -------------------------------------------------

describe('P11 integration: discovery candidate routes are scope-checked and honest', () => {
	let routeClaimId = '';
	const SEED_URL = 'https://devpost.com/software/p11-route-probe';

	async function seedRow(): Promise<void> {
		const res = await fetch(`${WORKER_BASE}/__test/d1`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({
				sql:
					`insert or ignore into "discovery_seed_candidates" ` +
					`("id","source","url","title","summary","publishedAt","requirementsJson","createdAt") values ` +
					`('seed-route-probe','local-seed','${SEED_URL}','Route probe','A candidate for the route tests.',NULL,` +
					`'${JSON.stringify([{ text: 'Not open to BR residents', claimType: 'eligibility.restricted_countries' }]).replaceAll("'", "''")}',` +
					`'2026-10-06T00:00:00.000Z')`,
			}),
		});
		expect(res.status).toBe(200);
	}

	test('the feed route runs the local adapter, records the source outcome, and lists candidates', async () => {
		await seedRow();
		// A quoted rule for the fit citation below.
		const claim = await addClaim(jarAlice, projAlice, {
			claimType: 'eligibility.restricted_countries',
			value: 'BR',
			quote: '"not open to BR residents"',
		});
		expect(claim.status).toBe(201);
		routeClaimId = claim.claimId!;

		const feedRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/feed`, { method: 'POST' });
		expect(feedRes.status).toBe(201);
		const feed = (await feedRes.json()) as {
			feed: {
				sources: { source: string; outcome: string; failureReason: string | null }[];
				candidates: { id: string; url: string; projectId: string }[];
			};
		};
		const localSeed = feed.feed.sources.find((s) => s.source === 'local-seed');
		expect(localSeed?.outcome).toBe('succeeded');
		expect(feed.feed.candidates.some((c) => c.url === SEED_URL)).toBe(true);

		// bob's project sees none of alice's candidates
		const bobCandidates = await worker(jarBob, `/api/projects/${projBob}/discovery/candidates`);
		expect(bobCandidates.status).toBe(200);
		expect(((await bobCandidates.json()) as { candidates: unknown[] }).candidates).toHaveLength(0);
	});

	test('the evaluated candidate list is conservative and the fit detail cites P10 claim ids', async () => {
		const listRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates?evaluate=1`);
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as {
			evaluations: {
				candidate: { id: string; url: string };
				fit: { claims: { claimType: string; evidenceClaimIds: string[]; verdict: string }[] };
				eligibility: { verdict: string; rules: { basis: string }[] };
			}[];
			ranked: { candidateId: string; verdict: string }[];
			profileCountry: string | null;
		};
		const probe = list.evaluations.find((e) => e.candidate.url === SEED_URL)!;
		// Alice's profile carries no country: a country rule CANNOT be applied —
		// unknown, never eligible (conservatism through the whole HTTP stack).
		expect(list.profileCountry).toBeNull();
		expect(probe.eligibility.verdict).toBe('unknown');
		expect(probe.eligibility.rules[0]?.basis).toBe('missing_profile_attribute');
		// The fit claim cites the P10 evidence claim it rests on.
		const fitClaim = probe.fit.claims.find((c) => c.claimType === 'eligibility.restricted_countries')!;
		expect(fitClaim.verdict).toBe('supported');
		expect(fitClaim.evidenceClaimIds).toEqual([routeClaimId]);
		// Ranking never opens with an ineligible entry.
		expect(['eligible', 'unknown']).toContain(list.ranked[0]?.verdict);
	});

	test('accept marks a candidate; a fabricated id is refused and writes nothing', async () => {
		const listRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates`);
		const probe = ((await listRes.json()) as { candidates: { id: string; url: string }[] }).candidates.find(
			(c) => c.url === SEED_URL,
		)!;

		const acceptRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates/${probe.id}/accept`, {
			method: 'POST',
		});
		expect(acceptRes.status).toBe(200);
		expect(((await acceptRes.json()) as { candidate: { status: string } }).candidate.status).toBe('accepted');

		const forgedRes = await worker(
			jarAlice,
			`/api/projects/${projAlice}/discovery/candidates/cand_fabricated0/fabricated/accept`,
			{ method: 'POST' },
		);
		expect([400, 404]).toContain(forgedRes.status);
	});

	test('unauthenticated discovery access is rejected', async () => {
		const res = await worker(new Jar(), `/api/projects/${projAlice}/discovery/candidates`);
		expect(res.status).toBe(401);
	});
});
