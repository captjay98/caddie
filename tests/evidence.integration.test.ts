import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	SESSION_COOKIE,
	Jar,
	StubProvider,
	applyMigrations,
	d1Exec,
	d1Count,
	makeWorker,
	signIn,
} from './fixtures/controls-harness.ts';
import {
	evidenceMigrationPaths,
	startEvidenceFixtureWorker,
	stopEvidenceFixtureWorker,
} from './fixtures/evidence-harness.ts';
import { join } from 'node:path';

/**
 * P10 — Source evidence and rule normalization, executed against a real local
 * workerd (`wrangler dev` = miniflare/workerd) with a real SQLite-backed D1.
 * Reuses the P01–P03 fixture harness patterns (free ports, readiness identity
 * check, patterned pkill cleanup).
 *
 * Honesty classification:
 *   - Worker runtime, D1 persistence (schema, check constraints, deterministic
 *     identity dedupe, supersession, conflict retention, isolation), Better
 *     Auth session mechanics, route scoping: LOCAL VERIFIED (real workerd,
 *     real D1).
 *   - The OAuth provider endpoints and the HTTP fetch targets are stubs inside
 *     this test process, so the sign-in flows (provider boundary) are
 *     SIMULATED at that boundary — the same classification as P01–P03.
 *   - Live external fetches are BLOCKED by policy in these tests and asserted
 *     to be blocked; no external network is touched. LIVE VERIFIED evidence
 *     for external retrieval would require explicit owner authorization
 *     (CADDIE_LIVE_AUTHORIZED=1) and is out of scope for this packet.
 *
 * The fixture worker entry is tests/fixtures/evidence.ts; it mounts the SAME
 * production composition shape app.ts mounts at /api (auth router + evidence
 * router) plus /__test control routes compiled into the fixture only.
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

async function registerSource(
	jar: Jar,
	projectId: string,
	body: Record<string, unknown>,
): Promise<{ status: number; payload: { source?: { id: string; authority: string }; error?: string } }> {
	const res = await worker(jar, `/api/projects/${projectId}/evidence/sources`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
	return { status: res.status, payload: (await res.json()) as never };
}

async function capture(
	jar: Jar,
	projectId: string,
	sourceId: string,
	body: Record<string, unknown>,
): Promise<{ status: number; payload: { snapshot?: { id: string; contentHash: string }; outcome?: string; error?: string } }> {
	const res = await worker(jar, `/api/projects/${projectId}/evidence/sources/${sourceId}/snapshots`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
	return { status: res.status, payload: (await res.json()) as never };
}

async function addClaim(
	jar: Jar,
	projectId: string,
	body: Record<string, unknown>,
): Promise<{ status: number; payload: { claim?: { id: string }; error?: string } }> {
	const res = await worker(jar, `/api/projects/${projectId}/evidence/claims`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
	return { status: res.status, payload: (await res.json()) as never };
}

beforeAll(async () => {
	const { freePort } = await import('./fixtures/controls-harness.ts');
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	await startEvidenceFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
		AUTH_STUB_BASE_URL: stub.url,
	});
	await applyMigrations(WORKER_BASE, evidenceMigrationPaths());
}, 180_000);

afterAll(async () => {
	stopEvidenceFixtureWorker(WORKER_PORT);
	await stub.stop();
});

// --- slice 1: schema on real D1 -----------------------------------------------------

describe('P10 integration: evidence schema on real workerd D1', () => {
	test('migrations apply cleanly; evidence tables exist with the shared authority vocabulary in the check constraint', async () => {
		const res = await d1Exec(
			WORKER_BASE,
			`select name, sql from sqlite_master where type = 'table' order by name`,
		);
		const tables = new Map(
			(res.results as { name: string; sql: string }[]).map((r) => [r.name, r.sql]),
		);
		for (const table of ['evidence_sources', 'evidence_snapshots', 'evidence_claims']) {
			expect(tables.has(table)).toBe(true);
		}
		// defect #6 on the storage side: the REAL D1 check constraint enumerates
		// exactly the one shared authority vocabulary
		const sourceDdl = tables.get('evidence_sources') ?? '';
		for (const value of [
			'binding_rules',
			'organizer_message',
			'official_faq',
			'official_overview',
			'sponsor_page',
			'community',
			'unknown',
		]) {
			expect(sourceDdl).toContain(`'${value}'`);
		}
	});

	test('the (sourceId, contentHash) unique index and claim identity constraints exist', async () => {
		const res = await d1Exec(
			WORKER_BASE,
			`select name from sqlite_master where type = 'index' and tbl_name like 'evidence_%' order by name`,
		);
		const indexes = (res.results as { name: string }[]).map((r) => r.name);
		expect(indexes).toContain('evidence_snapshots_source_hash_idx');
		expect(indexes).toContain('evidence_sources_project_url_idx');
		expect(indexes).toContain('evidence_claims_project_type_idx');
	});
});

// --- sessions and projects ------------------------------------------------------------

describe('P10 integration: sessions and project setup', () => {
	test('both users sign in through the real worker OAuth flow', async () => {
		jarAlice = await signIn(worker, stub, ALICE_EMAIL, 'alice-sub-p10', 'Alice');
		jarBob = await signIn(worker, stub, BOB_EMAIL, 'bob-sub-p10', 'Bob');
		expect(jarAlice.header()).toContain(SESSION_COOKIE);
		expect(jarBob.header()).toContain(SESSION_COOKIE);
	});

	test('each user creates a workspace and a project', async () => {
		const wsA = await createWorkspace(jarAlice, 'Alice Evidence WS');
		projAlice = await createProject(jarAlice, wsA, 'Alice Evidence Rocket');
		const wsB = await createWorkspace(jarBob, 'Bob Evidence WS');
		projBob = await createProject(jarBob, wsB, 'Bob Evidence Satellite');
		expect(projAlice).not.toBe(projBob);
	});
});

// --- slice 1: sources + snapshots over HTTP ---------------------------------------------

describe('P10 integration: sources and immutable snapshots (workerd + D1)', () => {
	let rulesSourceId = '';

	test('source registration validates the shared vocabulary and the URL scheme', async () => {
		const badAuthority = await registerSource(jarAlice, projAlice, {
			url: 'https://example.com/rules',
			kind: 'page',
			authority: 'extremely_trusted',
		});
		expect(badAuthority.status).toBe(400);
		expect(badAuthority.payload.error).toBe('invalid_input');

		const badScheme = await registerSource(jarAlice, projAlice, {
			url: 'file:///etc/passwd',
			kind: 'page',
			authority: 'unknown',
		});
		expect(badScheme.status).toBe(400);
		expect(badScheme.payload.error).toBe('unsupported_url');
	});

	test('registering a source is idempotent per canonical URL — tracked links dedupe to the same source', async () => {
		const first = await registerSource(jarAlice, projAlice, {
			url: 'https://example.com/rules',
			kind: 'page',
			authority: 'binding_rules',
		});
		expect(first.status).toBe(201);
		rulesSourceId = first.payload.source!.id;
		const tracked = await registerSource(jarAlice, projAlice, {
			url: 'https://example.com/rules?utm_source=x#deadlines',
			kind: 'page',
			authority: 'community', // the FIRST declared authority wins on dedupe
		});
		expect(tracked.status).toBe(201);
		expect(tracked.payload.source!.id).toBe(rulesSourceId);
		expect(tracked.payload.source!.authority).toBe('binding_rules');
	});

	test('capture stores content + hash; repeated capture returns the SAME snapshot (dedupe by hash)', async () => {
		const content = 'Rules page: teams of up to four. Entries close September 9, 2026.';
		const first = await capture(jarAlice, projAlice, rulesSourceId, {
			content,
			mediaType: 'text/html',
		});
		expect(first.status).toBe(201);
		expect(first.payload.outcome).toBe('created');
		expect(first.payload.snapshot!.contentHash).toMatch(/^[0-9a-f]{64}$/);
		const repeat = await capture(jarAlice, projAlice, rulesSourceId, {
			content,
			mediaType: 'text/html',
		});
		expect(repeat.status).toBe(201);
		expect(repeat.payload.outcome).toBe('unchanged');
		expect(repeat.payload.snapshot!.id).toBe(first.payload.snapshot!.id);
	});

	test('placeholder snapshots are REJECTED over HTTP (a snapshot must have real content + hash)', async () => {
		const result = await capture(jarAlice, projAlice, rulesSourceId, {
			content: '   ',
			mediaType: 'text/html',
		});
		expect(result.status).toBe(400);
		expect(result.payload.error).toBe('snapshot_content_required');
	});

	test('changed content creates a NEW snapshot; history is retained and listed newest-first', async () => {
		const changed = await capture(jarAlice, projAlice, rulesSourceId, {
			content: 'Rules page UPDATED: entries close October 1, 2026.',
			mediaType: 'text/html',
		});
		expect(changed.status).toBe(201);
		expect(changed.payload.outcome).toBe('created');
		const list = await worker(jarAlice, `/api/projects/${projAlice}/evidence/sources/${rulesSourceId}/snapshots`);
		expect(list.status).toBe(200);
		const snapshots = ((await list.json()) as { snapshots: { id: string }[] }).snapshots;
		expect(snapshots).toHaveLength(2);
		expect(snapshots[0]!.id).toBe(changed.payload.snapshot!.id);
	});

	test('snapshot access is PROJECT-SCOPED: no session is 401, non-member is 403, other project finds nothing', async () => {
		const list = await worker(jarAlice, `/api/projects/${projAlice}/evidence/sources/${rulesSourceId}/snapshots`);
		const snapshots = ((await list.json()) as { snapshots: { id: string }[] }).snapshots;
		const snapshotId = snapshots[0]!.id;

		const noSession = await makeWorker(WORKER_BASE)(new Jar(), `/api/projects/${projAlice}/evidence/sources`);
		expect(noSession.status).toBe(401);

		// bob (non-member of alice's workspace) cannot read through alice's project
		const cross = await worker(jarBob, `/api/projects/${projAlice}/evidence/snapshots/${snapshotId}`);
		expect(cross.status).toBe(403);

		// addressing alice's snapshot under BOB's own project finds nothing (404)
		const crossOwn = await worker(jarBob, `/api/projects/${projBob}/evidence/snapshots/${snapshotId}`);
		expect(crossOwn.status).toBe(404);

		// and alice's source list never appears under bob's project listing
		const bobSources = await worker(jarBob, `/api/projects/${projBob}/evidence/sources`);
		expect(bobSources.status).toBe(200);
		expect(JSON.stringify(await bobSources.json())).not.toContain(rulesSourceId);
	});
});

// --- slice 1: claims over HTTP ------------------------------------------------------------

describe('P10 integration: claims bound to the exact snapshot (defect #1)', () => {
	let rulesSourceId = '';
	let rulesSnapshotId = '';

	test('a claim attaches to the EXACT snapshot with a validated quote; repeated extraction lands on ONE row', async () => {
		const sources = await worker(jarAlice, `/api/projects/${projAlice}/evidence/sources`);
		const sourcesBody = (await sources.json()) as { sources: { id: string; authority: string }[] };
		rulesSourceId = sourcesBody.sources[0]!.id;
		const snapshots = await worker(
			jarAlice,
			`/api/projects/${projAlice}/evidence/sources/${rulesSourceId}/snapshots`,
		);
		const snapshotsBody = (await snapshots.json()) as { snapshots: { id: string; capturedAt: string }[] };
		rulesSnapshotId = snapshotsBody.snapshots[0]!.id;

		const claimInput = {
			snapshotId: rulesSnapshotId,
			claimType: 'deadline',
			value: '2026-10-01',
			quote: 'entries close October 1, 2026.',
			locator: 'rules#deadlines',
			extractionVersion: 'p10-evidence-v1',
		};
		const first = await addClaim(jarAlice, projAlice, claimInput);
		expect(first.status).toBe(201);
		const repeat = await addClaim(jarAlice, projAlice, claimInput);
		expect(repeat.status).toBe(201);
		expect(repeat.payload.claim!.id).toBe(first.payload.claim!.id);
		const all = await worker(jarAlice, `/api/projects/${projAlice}/evidence/claims?claimType=deadline`);
		const claims = ((await all.json()) as { claims: { id: string }[] }).claims;
		expect(claims.filter((c) => c.id === first.payload.claim!.id)).toHaveLength(1);
	});

	test('a fabricated quote (not in the snapshot content) is rejected', async () => {
		const result = await addClaim(jarAlice, projAlice, {
			snapshotId: rulesSnapshotId,
			claimType: 'prize',
			value: '$1,000,000',
			quote: 'Grand prize is one million dollars.',
			extractionVersion: 'p10-evidence-v1',
		});
		expect(result.status).toBe(400);
		expect(result.payload.error).toBe('quote_not_in_snapshot');
	});

	test('a claim cannot pin a snapshot from ANOTHER project (no cross-project evidence grafting)', async () => {
		// bob captures a snapshot in HIS project
		const bobSource = await registerSource(jarBob, projBob, {
			url: 'https://example.com/bob-rules',
			kind: 'page',
			authority: 'unknown',
		});
		expect(bobSource.status).toBe(201);
		const bobSnapshot = await capture(jarBob, projBob, bobSource.payload.source!.id, {
			content: 'Bob private rules.',
			mediaType: 'text/plain',
		});
		expect(bobSnapshot.status).toBe(201);
		// alice tries to claim against bob's snapshot id under HER project
		const grafted = await addClaim(jarAlice, projAlice, {
			snapshotId: bobSnapshot.payload.snapshot!.id,
			claimType: 'eligibility',
			value: 'bob only',
			quote: 'Bob private rules.',
			extractionVersion: 'p10-evidence-v1',
		});
		expect(grafted.status).toBe(404);
	});
});

// --- slice 2: reconciliation over HTTP -------------------------------------------------------

describe('P10 integration: authority reconciliation and retained conflicts over HTTP', () => {
	test('higher authority wins (rules over overview); equal-rank disagreement is RETAINED, never auto-resolved', async () => {
		// overview source disagrees with the rules source
		const overview = await registerSource(jarAlice, projAlice, {
			url: 'https://example.com/overview',
			kind: 'page',
			authority: 'official_overview',
		});
		const overviewSnap = await capture(jarAlice, projAlice, overview.payload.source!.id, {
			content: 'Overview: entries close September 10, 2026.',
			mediaType: 'text/plain',
		});
		await addClaim(jarAlice, projAlice, {
			snapshotId: overviewSnap.payload.snapshot!.id,
			claimType: 'deadline',
			value: '2026-09-10',
			quote: 'entries close September 10, 2026.',
			extractionVersion: 'p10-evidence-v1',
		});
		let surveys = await worker(jarAlice, `/api/projects/${projAlice}/evidence/conflicts?claimType=deadline`);
		let body = (await surveys.json()) as {
			surveys: { claimType: string; winner: { value: string } | null; conflict: { claimIds: string[] } | null }[];
		};
		expect(body.surveys[0]!.winner?.value).toBe('2026-10-01'); // rules outrank overview
		expect(body.surveys[0]!.conflict).toBeNull();

		// a same-tier FAQ disagrees with the rules page → retained conflict
		const faq = await registerSource(jarAlice, projAlice, {
			url: 'https://example.com/faq',
			kind: 'page',
			authority: 'official_faq',
		});
		const faqSnap = await capture(jarAlice, projAlice, faq.payload.source!.id, {
			content: 'FAQ: entries close September 14, 2026.',
			mediaType: 'text/plain',
		});
		await addClaim(jarAlice, projAlice, {
			snapshotId: faqSnap.payload.snapshot!.id,
			claimType: 'deadline',
			value: '2026-09-14',
			quote: 'entries close September 14, 2026.',
			extractionVersion: 'p10-evidence-v1',
		});
		surveys = await worker(jarAlice, `/api/projects/${projAlice}/evidence/conflicts?claimType=deadline`);
		body = (await surveys.json()) as never;
		expect(body.surveys[0]!.winner).toBeNull();
		expect(body.surveys[0]!.conflict).not.toBeNull();
		// HackSteward semantics: the retained conflict carries the WHOLE current
		// reading group (rules + faq disagreement AND the outranked overview),
		// so a reader sees the full disagreement picture, not a curated pair
		expect(body.surveys[0]!.conflict!.claimIds.length).toBe(3);

		// retained: the conflicting readings are all still on record
		const claims = await worker(jarAlice, `/api/projects/${projAlice}/evidence/claims?claimType=deadline`);
		const claimsBody = (await claims.json()) as { claims: unknown[] };
		expect(claimsBody.claims.length).toBe(3);

		// bob's project sees none of alice's reconciliation state
		const bobSurveys = await worker(jarBob, `/api/projects/${projBob}/evidence/conflicts?claimType=deadline`);
		expect(bobSurveys.status).toBe(200);
		expect(((await bobSurveys.json()) as { surveys: unknown[] }).surveys).toEqual([]);
	});

	test('deadline normalization: missing timezone is ambiguous; date-only stays date-only (no midnight)', async () => {
		const missing = await worker(jarAlice, `/api/projects/${projAlice}/evidence/deadlines/normalize`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ text: 'Submissions close September 9, 2026 at 5:00 PM.' }),
		});
		expect(missing.status).toBe(200);
		const missingBody = (await missing.json()) as { normalized: { status: string; utc: string | null } };
		expect(missingBody.normalized.status).toBe('ambiguous');
		expect(missingBody.normalized.utc).toBeNull();

		const dateOnly = await worker(jarAlice, `/api/projects/${projAlice}/evidence/deadlines/normalize`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ text: 'September 21, 2026', zone: 'Africa/Lagos' }),
		});
		const dateOnlyBody = (await dateOnly.json()) as {
			normalized: { status: string; date: string | null; utc: string | null; hasTime: boolean };
		};
		expect(dateOnlyBody.normalized.status).toBe('date_only');
		expect(dateOnlyBody.normalized.date).toBe('2026-09-21');
		expect(dateOnlyBody.normalized.utc).toBeNull(); // NO midnight assumption
		expect(dateOnlyBody.normalized.hasTime).toBe(false);

		const zoned = await worker(jarAlice, `/api/projects/${projAlice}/evidence/deadlines/normalize`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({
				text: 'Submissions close September 9, 2026 at 5:00 PM PT.',
				zone: 'America/Los_Angeles',
			}),
		});
		const zonedBody = (await zoned.json()) as { normalized: { status: string; utc: string | null } };
		expect(zonedBody.normalized.status).toBe('resolved');
		expect(zonedBody.normalized.utc).toBe('2026-09-10T00:00:00.000Z');
	});
});

// --- slice 3: fetch policy over HTTP -----------------------------------------------------------

describe('P10 integration: fetch policy through the capture-url route', () => {
	test('a private-network target is REFUSED before any request (loopback is never fetched in production posture)', async () => {
		const source = await registerSource(jarAlice, projAlice, {
			url: 'http://127.0.0.1:9/forbidden',
			kind: 'page',
			authority: 'unknown',
		});
		expect(source.status).toBe(201);
		const res = await worker(
			jarAlice,
			`/api/projects/${projAlice}/evidence/sources/${source.payload.source!.id}/capture-url`,
			{
				method: 'POST',
				headers: JSON_HEADERS,
				body: JSON.stringify({ url: 'http://127.0.0.1:9/forbidden' }),
			},
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe('blocked_private_network');
	});

	test('an external target is BLOCKED without owner authorization (no CADDIE_LIVE_AUTHORIZED in the fixture)', async () => {
		const source = await registerSource(jarAlice, projAlice, {
			url: 'https://example.com/external-rules',
			kind: 'page',
			authority: 'unknown',
		});
		const res = await worker(
			jarAlice,
			`/api/projects/${projAlice}/evidence/sources/${source.payload.source!.id}/capture-url`,
			{
				method: 'POST',
				headers: JSON_HEADERS,
				body: JSON.stringify({ url: 'https://example.com/external-rules' }),
			},
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe('blocked_external_without_authorization');
		// database truth: the refusals were recorded as blocked attempts and
		// never advanced freshness
		const count = await d1Count(
			WORKER_BASE,
			'evidence_sources',
			"lastOutcome = 'blocked' and \"projectId\" = '" + projAlice + "'",
		);
		expect(count).toBe(2);
	});
});
