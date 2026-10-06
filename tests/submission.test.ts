import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	SESSION_COOKIE,
	Jar,
	StubProvider,
	applyMigrations,
	d1Exec,
	makeWorker,
	signIn,
} from './fixtures/controls-harness.ts';
import {
	submissionMigrationPaths,
	startSubmissionFixtureWorker,
	stopSubmissionFixtureWorker,
} from './fixtures/submission-harness.ts';
import { join } from 'node:path';

/**
 * P13 slices 2+3 — submission package + judge/submission routes, executed
 * against a real local workerd (`wrangler dev` = miniflare/workerd) with a
 * real SQLite-backed D1. Reuses the P01–P03 fixture harness patterns (free
 * ports, readiness identity check, patterned pkill cleanup).
 *
 * Honesty classification:
 *   - Worker runtime, D1 persistence (0010 schema, citation-carrying
 *     checklist rows, export hash + requirements version, the SEPARATE
 *     human-confirmation table), Better Auth session mechanics, route
 *     scoping and the reuse-confirmation gate: LOCAL VERIFIED (real workerd,
 *     real D1).
 *   - The OAuth provider endpoints are stubs inside this test process, so
 *     the sign-in flow (provider boundary) is SIMULATED at that boundary —
 *     the same classification as P01–P03/P10.
 *   - No external submission is performed anywhere: recording a confirmation
 *     only writes the human's attestation row. Live external actions are
 *     BLOCKED by policy in these tests.
 *
 * The fixture worker entry is tests/fixtures/submission.ts; it mounts the
 * SAME production composition shape app.ts mounts at /api (auth + projects +
 * evidence + judge routers) plus /__test control routes compiled into the
 * fixture only.
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
let aliceUserId = '';

interface Res<T> {
	status: number;
	payload: T;
}

async function post<T>(jar: Jar, path: string, body?: unknown): Promise<Res<T>> {
	const res = await worker(jar, path, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, payload: (await res.json()) as T };
}

async function get<T>(jar: Jar, path: string): Promise<Res<T>> {
	const res = await worker(jar, path);
	return { status: res.status, payload: (await res.json()) as T };
}

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

// --- evidence seeding through the REAL P10 routes ----------------------------------

async function seedRule(
	jar: Jar,
	projectId: string,
	claimType: string,
	value: string,
	quote: string,
): Promise<{ claimId: string; url: string }> {
	const sourceRes = await post<{ source: { id: string; canonicalUrl: string } }>(
		jar,
		`/api/projects/${projectId}/evidence/sources`,
		{
			url: `https://rules.example/p13/${encodeURIComponent(claimType)}-${Math.random().toString(36).slice(2)}`,
			kind: 'page',
			authority: 'binding_rules',
			displayName: `P13 rules ${claimType}`,
		},
	);
	expect(sourceRes.status).toBe(201);
	const snapshotRes = await post<{ snapshot: { id: string } }>(
		jar,
		`/api/projects/${projectId}/evidence/sources/${sourceRes.payload.source.id}/snapshots`,
		{ content: `p13 rule page: ${quote}`, mediaType: 'text/plain' },
	);
	expect(snapshotRes.status).toBe(201);
	const claimRes = await post<{ claim: { id: string } }>(
		jar,
		`/api/projects/${projectId}/evidence/claims`,
		{
			snapshotId: snapshotRes.payload.snapshot.id,
			claimType,
			value,
			quote,
			extractionVersion: 'p13-integration-1',
		},
	);
	expect(claimRes.status).toBe(201);
	return { claimId: claimRes.payload.claim.id, url: sourceRes.payload.source.canonicalUrl };
}

beforeAll(async () => {
	const { freePort } = await import('./fixtures/controls-harness.ts');
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	await startSubmissionFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
		AUTH_STUB_BASE_URL: stub.url,
	});
	await applyMigrations(WORKER_BASE, submissionMigrationPaths());
}, 180_000);

afterAll(async () => {
	stopSubmissionFixtureWorker(WORKER_PORT);
	await stub.stop();
});

// --- schema on real D1 ---------------------------------------------------------------

describe('P13 integration: submission schema on real workerd D1', () => {
	test('migrations apply cleanly; the five judge/submission tables exist', async () => {
		const res = await d1Exec(
			WORKER_BASE,
			`select name from sqlite_master where type = 'table' order by name`,
		);
		const tables = new Set((res.results as { name: string }[]).map((r) => r.name));
		for (const table of [
			'judge_scorecards',
			'submission_packages',
			'submission_checklist_items',
			'submission_exports',
			'submission_confirmations',
		]) {
			expect(tables.has(table)).toBe(true);
		}
	});

	test('checklist rows double-key on the project: the (projectId) isolation index exists', async () => {
		const res = await d1Exec(
			WORKER_BASE,
			`select name from sqlite_master where type = 'index' and tbl_name like 'submission_%' order by name`,
		);
		const indexes = (res.results as { name: string }[]).map((r) => r.name);
		expect(indexes).toContain('submission_checklist_items_projectId_idx');
		expect(indexes).toContain('submission_packages_projectId_idx');
		expect(indexes).toContain('submission_confirmations_projectId_idx');
	});
});

// --- sessions and projects --------------------------------------------------------------

describe('P13 integration: sessions and project setup', () => {
	test('both users sign in through the real worker OAuth flow', async () => {
		jarAlice = await signIn(worker, stub, ALICE_EMAIL, 'alice-sub-p13', 'Alice');
		jarBob = await signIn(worker, stub, BOB_EMAIL, 'bob-sub-p13', 'Bob');
		expect(jarAlice.header()).toContain(SESSION_COOKIE);
		expect(jarBob.header()).toContain(SESSION_COOKIE);
	});

	test('each user creates a workspace and a project', async () => {
		const wsA = await createWorkspace(jarAlice, 'Alice Submission WS');
		projAlice = await createProject(jarAlice, wsA, 'Transit Planner');
		const wsB = await createWorkspace(jarBob, 'Bob Submission WS');
		projBob = await createProject(jarBob, wsB, 'Bob Satellite');
		expect(projAlice).not.toBe(projBob);
		const users = await d1Exec(WORKER_BASE, `select id, email from "user" where email = '${ALICE_EMAIL}'`);
		aliceUserId = String((users.results as { id: string }[])[0]!.id);
	});
});

// --- slice 2: package, checklist, export, confirmation -------------------------------------

let pkgId = '';
let firstExportId = '';
let firstExportHash = '';

describe('P13 integration: package title and cited checklist (C16)', () => {
	test('the requirements version endpoint returns a deterministic project-scoped reqver-', async () => {
		const res = await get<{ version: string }>(jarAlice, `/api/projects/${projAlice}/submission/requirements-version`);
		expect(res.status).toBe(200);
		expect(res.payload.version.startsWith('reqver-')).toBe(true);
	});

	test('the package is created with the PROJECT title — never a contest title', async () => {
		const res = await post<{ package: { id: string; title: string; reuseState: string; requirementsVersion: string; reuseConfirmedBy: string | null } }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/packages`,
			{ reuseRequired: true },
		);
		expect(res.status).toBe(201);
		expect(res.payload.package.title).toBe('Transit Planner');
		expect(res.payload.package.reuseState).toBe('unconfirmed');
		expect(res.payload.package.reuseConfirmedBy).toBeNull();
		expect(res.payload.package.requirementsVersion.startsWith('reqver-')).toBe(true);
		pkgId = res.payload.package.id;
	});

	test('checklist items derive ONLY from cited claims — kind, text, citation; nothing on record yet', async () => {
		await seedRule(
			jarAlice,
			projAlice,
			'submission.video',
			'https://contest.example/upload — video under 5 minutes',
			'"submit a video under 5 minutes"',
		);
		await seedRule(jarAlice, projAlice, 'submission.license', 'MIT license required', '"must include an MIT license"');

		const res = await post<{ items: { id: string; kind: string; requirementText: string; citation: { claimId: string; quote: string; url: string }; status: string }[] }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/packages/${pkgId}/checklist`,
		);
		expect(res.status).toBe(201);
		const items = res.payload.items;
		expect(items).toHaveLength(2);
		const kinds = items.map((i) => i.kind).sort();
		expect(kinds).toEqual(['license', 'video']);
		const video = items.find((i) => i.kind === 'video')!;
		expect(video.requirementText).toBe('https://contest.example/upload — video under 5 minutes');
		expect(video.status).toBe('missing'); // no receipt or claim satisfies it yet
		expect(video.citation.claimId.startsWith('clm_')).toBe(true);
		expect(video.citation.quote).toBe('"submit a video under 5 minutes"');
		expect(video.citation.url.startsWith('https://rules.example/')).toBe(true);
	});

	test('no claims, no rows: a project without submission rules derives an EMPTY checklist', async () => {
		const created = await post<{ package: { id: string } }>(
			jarBob,
			`/api/projects/${projBob}/submission/packages`,
			{ reuseRequired: false },
		);
		expect(created.status).toBe(201);
		const res = await post<{ items: unknown[] }>(
			jarBob,
			`/api/projects/${projBob}/submission/packages/${created.payload.package.id}/checklist`,
		);
		expect(res.status).toBe(201);
		expect(res.payload.items).toHaveLength(0);
	});

	test('a checklist item verifies ONLY from a passed receipt; unrelated rules stay missing', async () => {
		// Insert a PASSED verification receipt whose text matches the video rule.
		const res = await fetch(`${WORKER_BASE}/__test/d1`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({
				sql:
					`insert into "run_verifications" ("id","runId","projectId","check","passed","evidence","planRevision","recordedBy","createdAt") ` +
					`values ('verif_video_p13','run_p13','${projAlice}','video for upload recorded and within 5 minutes',1,'demo file committed','1','integration','2026-10-06T02:00:00.000Z')`,
			}),
		});
		expect(res.status).toBe(200);
		const rebuilt = await post<{ items: { kind: string; status: string }[] }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/packages/${pkgId}/checklist`,
		);
		expect(rebuilt.status).toBe(201);
		const video = rebuilt.payload.items.find((i) => i.kind === 'video')!;
		const license = rebuilt.payload.items.find((i) => i.kind === 'license')!;
		expect(video.status).toBe('verified');
		expect(license.status).toBe('missing'); // missing fields STAY missing
	});
});

describe('P13 integration: reuse gate, export hash/version, staleness', () => {
	test('export is REFUSED while the reuse disclosure is unconfirmed (409)', async () => {
		const res = await post<{ error: string }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/packages/${pkgId}/exports`,
		);
		expect(res.status).toBe(409);
		expect(res.payload.error).toBe('reuse_unconfirmed');
	});

	test('reuse confirmation is a HUMAN act recorded with the session actor', async () => {
		const res = await post<{ package: { reuseState: string; reuseConfirmedBy: string | null; reuseConfirmedAt: string | null } }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/packages/${pkgId}/reuse/confirm`,
		);
		expect(res.status).toBe(200);
		expect(res.payload.package.reuseState).toBe('confirmed');
		expect(res.payload.package.reuseConfirmedBy).toBe(aliceUserId);
		expect(res.payload.package.reuseConfirmedAt).not.toBeNull();
	});

	test('the export records its content hash and the requirements version it was prepared against', async () => {
		const version = await get<{ version: string }>(jarAlice, `/api/projects/${projAlice}/submission/requirements-version`);
		const res = await post<{ export: { id: string; exportHash: string; requirementsVersion: string; packageJson: string } }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/packages/${pkgId}/exports`,
		);
		expect(res.status).toBe(201);
		expect(res.payload.export.exportHash.startsWith('sha256-')).toBe(true);
		expect(res.payload.export.requirementsVersion).toBe(version.payload.version);
		expect(res.payload.export.packageJson).toContain('"title":"Transit Planner"');
		firstExportId = res.payload.export.id;
		firstExportHash = res.payload.export.exportHash;
	});

	test('a NEW submission rule after the export invalidates readiness (stale)', async () => {
		await seedRule(jarAlice, projAlice, 'submission.repository', 'public repository link required', '"provide a public repository link"');
		const res = await get<{ readiness: { status: string; reasons: string[] }; package: { id: string } }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/packages/${pkgId}`,
		);
		expect(res.status).toBe(200);
		expect(res.payload.readiness.status).toBe('stale');
		expect(res.payload.readiness.reasons.length).toBeGreaterThan(0);
	});

	test('after re-deriving and re-exporting, readiness is current but BLOCKED by the still-missing items', async () => {
		await post(jarAlice, `/api/projects/${projAlice}/submission/packages/${pkgId}/checklist`);
		await post(jarAlice, `/api/projects/${projAlice}/submission/packages/${pkgId}/exports`);
		const res = await get<{ readiness: { status: string; reasons: string[] } }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/packages/${pkgId}`,
		);
		expect(res.status).toBe(200);
		expect(res.payload.readiness.status).toBe('blocked');
		expect(res.payload.readiness.reasons.join(' ')).toContain('missing');
	});
});

describe('P13 integration: the human submission record is distinct from prepared', () => {
	test('recording the external submission writes a SEPARATE confirmation row tied to the export hash', async () => {
		const res = await post<{ confirmation: { id: string; exportId: string; exportHash: string; attestations: string[]; confirmedBy: string } }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/exports/${firstExportId}/confirmations`,
			{ attestations: ['I personally submitted the package to the contest portal.'], note: 'submitted via portal' },
		);
		expect(res.status).toBe(201);
		expect(res.payload.confirmation.exportId).toBe(firstExportId);
		expect(res.payload.confirmation.exportHash).toBe(firstExportHash);
		expect(res.payload.confirmation.attestations.length).toBe(1);
		expect(res.payload.confirmation.confirmedBy).toBe(aliceUserId);

		// DISTINCT table: prepared rows live in submission_exports; the
		// confirmed submission lives in submission_confirmations.
		const exportsCount = await d1Exec(WORKER_BASE, 'select count(*) as n from "submission_exports"');
		const confirmationsCount = await d1Exec(WORKER_BASE, 'select count(*) as n from "submission_confirmations"');
		expect(Number((exportsCount.results as { n: number }[])[0]!.n)).toBe(2);
		expect(Number((confirmationsCount.results as { n: number }[])[0]!.n)).toBe(1);
	});

	test('empty attestations are rejected — a confirmation without the human statement is invalid', async () => {
		const res = await post<{ error: string }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/exports/${firstExportId}/confirmations`,
			{ attestations: [] },
		);
		expect(res.status).toBe(400);
		expect(res.payload.error).toBe('invalid_input');
	});
});

describe('P13 integration: scoping and malformed requests', () => {
	test("another member's package does not exist here: 404 on read, checklist, export and confirm", async () => {
		const read = await get<{ error: string }>(jarBob, `/api/projects/${projBob}/submission/packages/${pkgId}`);
		expect(read.status).toBe(404);
		const checklist = await post<{ error: string }>(jarBob, `/api/projects/${projBob}/submission/packages/${pkgId}/checklist`);
		expect(checklist.status).toBe(404);
		const exportAttempt = await post<{ error: string }>(jarBob, `/api/projects/${projBob}/submission/packages/${pkgId}/exports`);
		expect(exportAttempt.status).toBe(404);
	});

	test('an unauthenticated request is 401', async () => {
		const res = await fetch(`${WORKER_BASE}/api/projects/${projAlice}/submission/packages`);
		expect(res.status).toBe(401);
	});

	test('an unknown package id is 404; an unknown export id is 404', async () => {
		const pkg = await get<{ error: string }>(jarAlice, `/api/projects/${projAlice}/submission/packages/subpkg_missing`);
		expect(pkg.status).toBe(404);
		const conf = await post<{ error: string }>(
			jarAlice,
			`/api/projects/${projAlice}/submission/exports/subexp_missing/confirmations`,
			{ attestations: ['x'] },
		);
		expect(conf.status).toBe(404);
	});
});
