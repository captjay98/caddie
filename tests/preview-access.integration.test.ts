import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	applyMigrations,
	d1Count,
	d1Exec,
	freePort,
	Jar,
	makeWorker,
	previewsMigrationPaths,
	startPreviewsFixtureWorker,
	stopPreviewsFixtureWorker,
	StubProvider,
	signIn,
} from './fixtures/previews-harness.ts';
import { diffLines } from '../apps/app/src/server/artifacts.ts';

/**
 * P07 — versioned (content-addressed) artifacts and the private preview
 * gateway, executed against a real local workerd (`wrangler dev` = miniflare/
 * workerd with a real local SQLite-backed D1 database). Reuses the P01–P10
 * fixture harness pattern (free ports, readiness identity check, patterned
 * pkill cleanup, temp dirs).
 *
 * Honesty classification:
 *   - Worker runtime, D1 persistence (schema, constraints, dedupe, staleness
 *     flips, token hashing, access log), Better Auth session mechanics via
 *     the stub provider, scope enforcement over real HTTP sessions:
 *     LOCAL VERIFIED (real workerd, real SQLite-backed D1).
 *   - The OAuth provider endpoints are a stub inside this test process, so
 *     the sign-in flows used to obtain session cookies are SIMULATED at the
 *     provider boundary (same classification as P01/P02/P10).
 *
 * The fixture worker entry is tests/fixtures/previews.ts; it mounts the SAME
 * production /api composition app.ts will mount (auth + projects + artifacts
 * + previews routers) plus /__test/* control routes that are compiled into
 * the fixture only and are never part of the app Worker.
 *
 * Cookie hygiene: every resolve call below is a bare fetch with NO cookie
 * jar — the preview gateway must be token-only (a separate origin cannot
 * carry Caddie's session cookies).
 */

const REPO_ROOT = join(import.meta.dir, '..');
const MIGRATIONS = previewsMigrationPaths();

const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';
const SESSION_COOKIE = 'better-auth.session_token';

// --- small helpers -----------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

// --- fixture worker lifecycle ---------------------------------------------------

let WORKER_PORT = 0;
let WORKER_BASE = '';
let workerCleanup: (() => void) | null = null;
let stub: StubProvider;

const worker = (jar: Jar, path: string, init?: RequestInit) => makeWorker(WORKER_BASE)(jar, path, init);

beforeAll(async () => {
	for (const path of MIGRATIONS) {
		if (!existsSync(path)) throw new Error(`migration missing: ${path}`);
	}
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	const started = await startPreviewsFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
		AUTH_STUB_BASE_URL: stub.url,
	});
	workerCleanup = started.cleanup;
	await applyMigrations(WORKER_BASE, MIGRATIONS);
}, 180_000);

afterAll(async () => {
	stopPreviewsFixtureWorker(WORKER_PORT);
	await stub.stop();
	workerCleanup?.();
});

// --- shared slice-1 session state (populated in declaration order) --------------

let jarA: Jar;
// bob signs in ONCE per suite (same email + different subject would trip the
// explicit-linking-only account policy — one identity per email)
let jarB: Jar;
let wsA = '';
let projA = '';

async function createWorkspaceAndProject(jar: Jar, name: string): Promise<{ wsId: string; projectId: string }> {
	const wsRes = await worker(jar, '/api/workspaces', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	expect(wsRes.status).toBe(201);
	const wsId = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;
	const projRes = await worker(jar, '/api/projects', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ workspaceId: wsId, name: `${name} project` }),
	});
	expect(projRes.status).toBe(201);
	const projectId = ((await projRes.json()) as { project: { id: string } }).project.id;
	return { wsId, projectId };
}

interface ArtifactPayload {
	id: string;
	kind: string;
	planRevision: number;
	sha256: string;
	size: number;
	contentType: string;
	filename: string;
	status: string;
}

async function postArtifact(
	jar: Jar,
	projectId: string,
	body: Record<string, unknown>,
): Promise<{ status: number; artifact: ArtifactPayload | null; error?: string }> {
	const res = await worker(jar, `/api/projects/${projectId}/artifact-revisions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as { artifact?: ArtifactPayload; error?: string };
	return { status: res.status, artifact: json.artifact ?? null, error: json.error };
}

// --- slice 1: content-addressed artifacts -----------------------------------------

describe('P07 slice 1: content-addressed artifacts on real workerd D1', () => {
	test('migration 0003_artifacts.sql applies cleanly and creates the artifact content/revision tables', async () => {
		const res = await d1Exec(
			WORKER_BASE,
			`select name from sqlite_master where type = 'table' order by name`,
		);
		const tables = (res.results as { name: string }[]).map((r) => r.name).sort();
		for (const table of ['artifact_content', 'project_artifacts', 'preview_tokens', 'preview_access_log']) {
			expect(tables).toContain(table);
		}
		// earlier migrations are untouched and still present
		for (const table of ['user', 'session', 'projects', 'artifact_revisions']) {
			expect(tables).toContain(table);
		}
	});

	test('alice signs in, creates her workspace and project (session scaffold for the slice)', async () => {
		jarA = await signIn(worker, stub, ALICE_EMAIL, 'alice-sub-p07', 'Alice P07');
		expect(jarA.header()).toContain(SESSION_COOKIE);
		const created = await createWorkspaceAndProject(jarA, 'Alice P07 Hangar');
		wsA = created.wsId;
		projA = created.projectId;
		expect(projA).toBeTruthy();
	});

	test('storing an artifact round-trips the exact bytes, dedupes identical content and records revision metadata', async () => {
		const bytes = utf8('caddie plan v1\nbuilt for the pit wall\n');
		const first = await postArtifact(jarA, projA, {
			kind: 'plan',
			planRevision: 1,
			contentType: 'text/markdown',
			filename: 'plan-v1.md',
			contentBase64: toBase64(bytes),
		});
		expect(first.status).toBe(201);
		expect(first.artifact).toMatchObject({
			kind: 'plan',
			planRevision: 1,
			sha256: sha256Hex(bytes),
			size: bytes.byteLength,
			contentType: 'text/markdown',
			filename: 'plan-v1.md',
			status: 'current',
		});

		// identical payload under a different plan revision: one blob, two revisions
		const second = await postArtifact(jarA, projA, {
			kind: 'plan',
			planRevision: 2,
			contentType: 'text/markdown',
			filename: 'plan-v2.md',
			contentBase64: toBase64(bytes),
		});
		expect(second.status).toBe(201);
		expect(second.artifact?.id).not.toBe(first.artifact?.id);
		expect(second.artifact?.sha256).toBe(first.artifact?.sha256);
		expect(await d1Count(WORKER_BASE, 'artifact_content')).toBe(1);
		expect(await d1Count(WORKER_BASE, 'project_artifacts', `"projectId" = '${projA}'`)).toBe(2);

		// metadata list is project-scoped, newest first
		const list = await worker(jarA, `/api/projects/${projA}/artifact-revisions`);
		expect(list.status).toBe(200);
		const listBody = (await list.json()) as { artifacts: ArtifactPayload[] };
		expect(listBody.artifacts.map((a) => a.id)).toEqual([
			second.artifact!.id,
			first.artifact!.id,
		]);

		// content round-trips byte-for-byte under the owner's session
		const content = await worker(
			jarA,
			`/api/projects/${projA}/artifact-revisions/${first.artifact!.id}/content`,
		);
		expect(content.status).toBe(200);
		expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
		expect(content.headers.get('content-type')).toContain('text/markdown');
		expect(content.headers.get('x-content-type-options')).toBe('nosniff');
		expect(content.headers.get('content-security-policy')).toContain('sandbox');
	});

	test('the size cap and kind vocabulary are enforced before anything is written', async () => {
		const tooBig = new Uint8Array(5 * 1024 * 1024 + 1);
		const oversized = await postArtifact(jarA, projA, {
			kind: 'test-result',
			planRevision: 2,
			contentType: 'text/plain',
			filename: 'huge.log',
			contentBase64: toBase64(tooBig),
		});
		expect(oversized.status).toBe(400);
		expect(oversized.error).toBe('artifact_too_large');
		expect(await d1Count(WORKER_BASE, 'artifact_content', '"size" > 5242880')).toBe(0);

		const badKind = await postArtifact(jarA, projA, {
			kind: 'screenshot',
			planRevision: 2,
			contentType: 'text/plain',
			filename: 'x.txt',
			contentBase64: toBase64(utf8('x')),
		});
		expect(badKind.status).toBe(400);

		const badBase64 = await postArtifact(jarA, projA, {
			kind: 'plan',
			planRevision: 3,
			contentType: 'text/plain',
			filename: 'x.txt',
			contentBase64: 'not!base64!',
		});
		expect(badBase64.status).toBe(400);
	});

	test('the export route streams an attachment with a sanitized filename, sandbox and nosniff headers', async () => {
		const bytes = utf8('export me\n');
		const created = await postArtifact(jarA, projA, {
			kind: 'test-result',
			planRevision: 2,
			contentType: 'text/plain',
			filename: '../../evil "<script>.log',
			contentBase64: toBase64(bytes),
		});
		expect(created.status).toBe(201);
		const download = await worker(
			jarA,
			`/api/projects/${projA}/artifact-revisions/${created.artifact!.id}/download`,
		);
		expect(download.status).toBe(200);
		const disposition = download.headers.get('content-disposition') ?? '';
		// Exact header: the sanitized token (path separators, control chars,
		// quotes and angle brackets replaced) in RFC 6266 quoted-string form.
		expect(disposition).toBe(
			`attachment; filename="evil _script_.log"; filename*=UTF-8''evil%20_script_.log`,
		);
		expect(download.headers.get('content-security-policy')).toContain('sandbox');
		expect(download.headers.get('x-content-type-options')).toBe('nosniff');
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
	});

	test('two users are denied each other’s artifacts: list, content, download and create are membership-checked', async () => {
		// bob has his own session but no membership in alice's workspace
		jarB = await signIn(worker, stub, BOB_EMAIL, 'bob-sub-p07', 'Bob P07');
		await createWorkspaceAndProject(jarB, 'Bob P07 Hangar');

		const aliceArtifactId = (
			(await (
				await worker(jarA, `/api/projects/${projA}/artifact-revisions`)
			).json()) as { artifacts: ArtifactPayload[] }
		).artifacts[0]!.id;

		const crossList = await worker(jarB, `/api/projects/${projA}/artifact-revisions`);
		expect(crossList.status).toBe(403);
		const crossCreate = await postArtifact(jarB, projA, {
			kind: 'plan',
			planRevision: 9,
			contentType: 'text/plain',
			filename: 'intrusion.txt',
			contentBase64: toBase64(utf8('bob was here')),
		});
		expect(crossCreate.status).toBe(403);
		const crossContent = await worker(
			jarB,
			`/api/projects/${projA}/artifact-revisions/${aliceArtifactId}/content`,
		);
		expect(crossContent.status).toBe(403);
		const crossDownload = await worker(
			jarB,
			`/api/projects/${projA}/artifact-revisions/${aliceArtifactId}/download`,
		);
		expect(crossDownload.status).toBe(403);

		// unauthenticated requests are 401, never a silent read
		const anonymous = await fetch(`${WORKER_BASE}/api/projects/${projA}/artifact-revisions`);
		expect(anonymous.status).toBe(401);

		// database truth: bob's denial wrote nothing into alice's project
		expect(
			await d1Count(WORKER_BASE, 'project_artifacts', `"projectId" = '${projA}' and "filename" = 'intrusion.txt'`),
		).toBe(0);
	});

	test('line diff between two revisions of the same kind; refused across kinds or other projects', async () => {
		const v1 = utf8('line one\nline two\nline three\n');
		const v2 = utf8('line one\nline two (changed)\nline three\nline four\n');
		const from = await postArtifact(jarA, projA, {
			kind: 'plan',
			planRevision: 10,
			contentType: 'text/plain',
			filename: 'diff-from.txt',
			contentBase64: toBase64(v1),
		});
		const to = await postArtifact(jarA, projA, {
			kind: 'plan',
			planRevision: 11,
			contentType: 'text/plain',
			filename: 'diff-to.txt',
			contentBase64: toBase64(v2),
		});
		expect(from.status).toBe(201);
		expect(to.status).toBe(201);

		const diffRes = await worker(
			jarA,
			`/api/projects/${projA}/artifact-revisions/${to.artifact!.id}/diff?from=${from.artifact!.id}`,
		);
		expect(diffRes.status).toBe(200);
		const body = (await diffRes.json()) as {
			diff: {
				from: { id: string };
				to: { id: string };
				lines: { type: string; text: string }[];
			};
		};
		const diff = body.diff;
		expect(diff.from.id).toBe(from.artifact!.id);
		expect(diff.to.id).toBe(to.artifact!.id);
		expect(diff.lines).toEqual([
			{ type: 'context', text: 'line one' },
			{ type: 'del', text: 'line two' },
			{ type: 'add', text: 'line two (changed)' },
			{ type: 'context', text: 'line three' },
			{ type: 'add', text: 'line four' },
		]);

		// a diff across different kinds is a client error, never a mixed compare
		const otherKind = await postArtifact(jarA, projA, {
			kind: 'browser-capture',
			planRevision: 11,
			contentType: 'text/plain',
			filename: 'capture.txt',
			contentBase64: toBase64(v1),
		});
		expect(otherKind.status).toBe(201);
		const crossKind = await worker(
			jarA,
			`/api/projects/${projA}/artifact-revisions/${otherKind.artifact!.id}/diff?from=${from.artifact!.id}`,
		);
		expect(crossKind.status).toBe(400);
	});

	test('markStaleForPlan flips artifacts derived from older plan revisions to stale and never deletes them', async () => {
		const r1 = await postArtifact(jarA, projA, {
			kind: 'test-result',
			planRevision: 20,
			contentType: 'text/plain',
			filename: 'results-r20.txt',
			contentBase64: toBase64(utf8('results for plan 20')),
		});
		const r2 = await postArtifact(jarA, projA, {
			kind: 'test-result',
			planRevision: 21,
			contentType: 'text/plain',
			filename: 'results-r21.txt',
			contentBase64: toBase64(utf8('results for plan 21')),
		});
		expect(r1.status).toBe(201);
		expect(r2.status).toBe(201);

		const before = await d1Count(WORKER_BASE, 'project_artifacts', `"projectId" = '${projA}'`);
		const markRes = await fetch(`${WORKER_BASE}/__test/mark-stale`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ projectId: projA, newPlanRevision: 21 }),
		});
		expect(markRes.status).toBe(200);
		const marked = (await markRes.json()) as { marked: number };
		expect(marked.marked).toBeGreaterThanOrEqual(1);

		// the plan-20 artifact is stale, the plan-21 artifact is current, and no
		// row was deleted (staleness is a status flip, history stays)
		const staleRow = await d1Exec(
			WORKER_BASE,
			`select "status" from "project_artifacts" where "id" = '${r1.artifact!.id}'`,
		);
		expect((staleRow.results[0] as { status: string }).status).toBe('stale');
		const currentRow = await d1Exec(
			WORKER_BASE,
			`select "status" from "project_artifacts" where "id" = '${r2.artifact!.id}'`,
		);
		expect((currentRow.results[0] as { status: string }).status).toBe('current');
		expect(await d1Count(WORKER_BASE, 'project_artifacts', `"projectId" = '${projA}'`)).toBe(before);

		// stale content is still downloadable — marked, never erased
		const staleDownload = await worker(
			jarA,
			`/api/projects/${projA}/artifact-revisions/${r1.artifact!.id}/download`,
		);
		expect(staleDownload.status).toBe(200);
		expect(new Uint8Array(await staleDownload.arrayBuffer())).toEqual(utf8('results for plan 20'));
	});

	test('artifact routes require a verified session (no session is 401, nothing is written)', async () => {
		const noCookie = new Jar();
		const res = await worker(noCookie, `/api/projects/${projA}/artifact-revisions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				kind: 'plan',
				planRevision: 99,
				contentType: 'text/plain',
				filename: 'ghost.txt',
				contentBase64: toBase64(utf8('ghost')),
			}),
		});
		expect(res.status).toBe(401);
		expect(await d1Count(WORKER_BASE, 'project_artifacts', `"filename" = 'ghost.txt'`)).toBe(0);
	});
});

// --- slice 1 (pure): the line-diff function -----------------------------------------

describe('P07 slice 1: line diff (pure function)', () => {
	test('identical inputs produce only context lines', () => {
		expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([
			{ type: 'context', text: 'a' },
			{ type: 'context', text: 'b' },
		]);
	});

	test('empty-to-text is all additions; text-to-empty is all deletions', () => {
		expect(diffLines('', 'x\ny\n')).toEqual([
			{ type: 'add', text: 'x' },
			{ type: 'add', text: 'y' },
		]);
		expect(diffLines('x\n', '')).toEqual([{ type: 'del', text: 'x' }]);
	});

	test('a middle edit is a minimal del/add pair with surrounding context', () => {
		const diff = diffLines('a\nb\nc\nd\n', 'a\nb\nC\nd\n');
		expect(diff).toEqual([
			{ type: 'context', text: 'a' },
			{ type: 'context', text: 'b' },
			{ type: 'del', text: 'c' },
			{ type: 'add', text: 'C' },
			{ type: 'context', text: 'd' },
		]);
	});
});

// --- slice 2: private preview gateway -------------------------------------------------

/**
 * The preview gateway is TOKEN-ONLY: management routes are session-scoped,
 * but resolution never reads a cookie (a separate isolated origin cannot
 * carry one). Every resolve attempt appends a preview_access_log row.
 */
describe('P07 slice 2: private preview gateway (token-only resolution)', () => {
	let previewWs = '';
	let previewProj = '';
	let previewRevision = '';
	let previewId = '';
	let previewToken = '';

	async function createPreview(
		jar: Jar,
		projectId: string,
		body: Record<string, unknown>,
	): Promise<{ status: number; preview: Record<string, unknown> | null; token?: string; error?: string }> {
		const res = await worker(jar, `/api/projects/${projectId}/previews`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const json = (await res.json()) as {
			preview?: Record<string, unknown>;
			token?: string;
			error?: string;
		};
		return { status: res.status, preview: json.preview ?? null, token: json.token, error: json.error };
	}

	test('scaffold: alice stores one artifact revision for the preview slices', async () => {
		const created = await postArtifact(jarA, projA, {
			kind: 'browser-capture',
			planRevision: 30,
			contentType: 'text/html',
			filename: 'capture.html',
			contentBase64: toBase64(utf8('<!doctype html><p>private preview body</p>')),
		});
		expect(created.status).toBe(201);
		previewRevision = created.artifact!.id;
	});

	test('preview creation returns the secret exactly once and persists only its hash', async () => {
		const created = await createPreview(jarA, projA, { revisionId: previewRevision, ttlSeconds: 3600 });
		expect(created.status).toBe(201);
		expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		previewToken = created.token!;
		previewId = String(created.preview?.id);
		expect(created.preview).toMatchObject({
			projectId: projA,
			revisionId: previewRevision,
			revoked: false,
		});

		// stored form: hex sha256 of the secret, never the secret itself
		const rows = await d1Exec(WORKER_BASE, `select * from "preview_tokens" where "id" = '${previewId}'`);
		const row = rows.results[0] as Record<string, unknown>;
		expect(row['tokenHash']).toBe(sha256Hex(utf8(previewToken)));
		expect(JSON.stringify(row)).not.toContain(previewToken);

		// the management list never carries the secret either
		const list = await worker(jarA, `/api/projects/${projA}/previews`);
		expect(list.status).toBe(200);
		expect(JSON.stringify(await list.json())).not.toContain(previewToken);
	});

	test('resolve serves the artifact content with sandbox headers using the TOKEN ALONE (no cookies) and logs the hit', async () => {
		// bare fetch: no cookie jar, no session — the token IS the credential
		const res = await fetch(`${WORKER_BASE}/api/previews/resolve/${previewToken}`);
		expect(res.status).toBe(200);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(
			utf8('<!doctype html><p>private preview body</p>'),
		);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('cache-control')).toContain('no-store');
		expect(res.headers.get('set-cookie')).toBeNull();

		// the access log row landed with outcome 'served' under the token id
		const served = await d1Exec(
			WORKER_BASE,
			`select "outcome", "tokenId", "projectId" from "preview_access_log" order by "rowid" desc limit 1`,
		);
		expect(served.results[0]).toMatchObject({ outcome: 'served', tokenId: previewId, projectId: projA });
	});

	test('unknown or malformed tokens are a bare 404 that leaks nothing — and the attempts are logged', async () => {
		const unknown = await fetch(`${WORKER_BASE}/api/previews/resolve/${'b'.repeat(43)}`);
		expect(unknown.status).toBe(404);
		const unknownBody = await unknown.text();
		expect(JSON.parse(unknownBody)).toMatchObject({ error: 'not_found' });
		const malformed = await fetch(`${WORKER_BASE}/api/previews/resolve/not-a-token!!`);
		expect(malformed.status).toBe(404);
		// no artifact content, no identity hint, no 401/403 distinction
		expect(unknownBody).not.toContain(projA);

		const logged = await d1Exec(
			WORKER_BASE,
			`select "outcome", "tokenId" from "preview_access_log" order by "rowid" desc limit 2`,
		);
		const outcomes = (logged.results as { outcome: string; tokenId: string }[]).map((r) => r.outcome);
		expect(outcomes).toEqual(['denied', 'denied']);
		// unknown secrets are logged as a non-reversible marker, never the secret
		const tokenIds = (logged.results as { tokenId: string }[]).map((r) => r.tokenId);
		expect(tokenIds.every((id) => !id.includes('b'.repeat(43)))).toBe(true);
	});

	test('expired tokens resolve 410 Gone (logged); extend revives without re-revealing the secret', async () => {
		const created = await createPreview(jarA, projA, { revisionId: previewRevision, ttlSeconds: 3600 });
		const id = String(created.preview?.id);
		const token = created.token!;
		// deterministic expiry: move expiresAt into the past via the control route
		await d1Exec(
			WORKER_BASE,
			`update "preview_tokens" set "expiresAt" = '2026-01-01T00:00:00.000Z' where "id" = '${id}'`,
		);
		const gone = await fetch(`${WORKER_BASE}/api/previews/resolve/${token}`);
		expect(gone.status).toBe(410);
		expect(await gone.json()).toMatchObject({ error: 'preview_gone', reason: 'expired' });
		const goneLog = await d1Exec(
			WORKER_BASE,
			`select "outcome" from "preview_access_log" order by "rowid" desc limit 1`,
		);
		expect((goneLog.results[0] as { outcome: string }).outcome).toBe('gone');

		// extend: owner action, never re-reveals the token, revives resolution
		const extended = await worker(jarA, `/api/projects/${projA}/previews/${id}/extend`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ttlSeconds: 3600 }),
		});
		expect(extended.status).toBe(200);
		const extendedBody = JSON.stringify(await extended.json());
		expect(extendedBody).not.toContain(token);
		const served = await fetch(`${WORKER_BASE}/api/previews/resolve/${token}`);
		expect(served.status).toBe(200);
	});

	test('revoked tokens resolve 410 Gone; revoke and extend are membership-checked', async () => {
		const created = await createPreview(jarA, projA, { revisionId: previewRevision, ttlSeconds: 3600 });
		const id = String(created.preview?.id);
		const token = created.token!;

		// bob (no membership) can neither revoke nor extend alice's preview
		const crossRevoke = await worker(jarB, `/api/projects/${projA}/previews/${id}/revoke`, { method: 'POST' });
		expect(crossRevoke.status).toBe(403);
		const crossExtend = await worker(jarB, `/api/projects/${projA}/previews/${id}/extend`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ttlSeconds: 60 }),
		});
		expect(crossExtend.status).toBe(403);

		// alice revokes through the real route; resolution goes 410 and logs gone
		const revoked = await worker(jarA, `/api/projects/${projA}/previews/${id}/revoke`, { method: 'POST' });
		expect(revoked.status).toBe(200);
		expect(await revoked.json()).toMatchObject({ preview: { id, revoked: true } });
		const gone = await fetch(`${WORKER_BASE}/api/previews/resolve/${token}`);
		expect(gone.status).toBe(410);
		expect(await gone.json()).toMatchObject({ error: 'preview_gone', reason: 'revoked' });
		// a second revoke is a typed conflict, and revocation beats extension
		const again = await worker(jarA, `/api/projects/${projA}/previews/${id}/revoke`, { method: 'POST' });
		expect(again.status).toBe(409);
		const extendRevoked = await worker(jarA, `/api/projects/${projA}/previews/${id}/extend`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ttlSeconds: 60 }),
		});
		expect(extendRevoked.status).toBe(409);
		const goneLog = await d1Exec(
			WORKER_BASE,
			`select "outcome" from "preview_access_log" order by "rowid" desc limit 1`,
		);
		expect((goneLog.results[0] as { outcome: string }).outcome).toBe('gone');
	});

	test('preview management is scope-checked end to end; two users are denied each other’s previews', async () => {
		// bob cannot mint a token for alice's revision in alice's project
		const crossCreate = await createPreview(jarB, projA, { revisionId: previewRevision, ttlSeconds: 60 });
		expect(crossCreate.status).toBe(403);
		// alice cannot mint a token for a revision that does not exist (404)
		const missing = await createPreview(jarA, projA, { revisionId: 'art_missing', ttlSeconds: 60 });
		expect(missing.status).toBe(404);
		// bob cannot list alice's previews
		const crossList = await worker(jarB, `/api/projects/${projA}/previews`);
		expect(crossList.status).toBe(403);
		// and resolution without ANY token is 404 — the gateway never reads cookies
		expect((await fetch(`${WORKER_BASE}/api/previews/resolve/`)).status).toBe(404);
	});
});
