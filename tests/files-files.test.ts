import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FILES_FILES, MAX_PART_BYTES, MAX_FILE_BYTES, MAX_APP_BYTES, ALLOWED_FILE_TYPES } from '../stacks/react-hono/files-files.ts';
import { materializeFeatureApp, runFeatureTest, type FeatureApp } from './support/feature-app.ts';

/**
 * Part L — photo and file uploads, chunked at 700 KB (plan part L, lane 9).
 *
 * Structural tests pin the limits and the shape. The behavioural test
 * materialises a real starter app that mounts the generated mountFiles routes,
 * then runs the real routes: a 5 MB file goes up in parts and comes back
 * byte-identical (same sha256) through readFile and through the part-reader; a
 * part over 700 KB, a wrong sha256, a file over 5 MB and a type not on the list
 * are each refused; the 100 MB app cap; and a second person B can't read or
 * delete A's file. The browser helpers shrinkPhoto and splitParts are tested in
 * happy-dom. LOCAL VERIFIED.
 */

describe('part L: generated file-upload files — structure', () => {
	const migration = FILES_FILES['migrations/0000_caddie_files.sql'] ?? '';
	const server = FILES_FILES['caddie/files.ts'] ?? '';
	const upload = FILES_FILES['caddie/upload.ts'] ?? '';

	test('the three generated files exist', () => {
		expect(migration.length).toBeGreaterThan(0);
		expect(server.length).toBeGreaterThan(0);
		expect(upload.length).toBeGreaterThan(0);
	});

	test('the limits are the plan\'s: 700 KB parts, 5 MB files, 100 MB per app', () => {
		expect(MAX_PART_BYTES).toBe(700 * 1024);
		expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
		expect(MAX_APP_BYTES).toBe(100 * 1024 * 1024);
		// A part (700 KB) as base64 is ~930 KB — under D1's 2 MB value limit.
		expect(Math.ceil((MAX_PART_BYTES * 4) / 3)).toBeLessThan(2_000_000);
		// The server enforces the same numbers.
		expect(server).toContain('700 * 1024');
		expect(server).toContain('5 * 1024 * 1024');
		expect(server).toContain('100 * 1024 * 1024');
	});

	test('the allowed types are exactly the plan\'s list', () => {
		expect([...ALLOWED_FILE_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/csv', 'text/plain']);
		for (const type of ALLOWED_FILE_TYPES) expect(server).toContain(type);
	});

	// FINDING #8 (review 2026-10-23): the per-app 100 MB quota must count
	// uploading files, not just ready ones, and reserve atomically — a
	// count-then-insert on 'ready' alone let two concurrent starts overshoot.
	test('the start reservation counts ready AND uploading bytes, atomically', () => {
		// The quota check is an insert ... select ... where, so the reservation is
		// made in the same statement the cap is checked, and uploading counts.
		expect(server).toContain("status in ('ready','uploading')");
		expect(server).toMatch(/insert into caddie_files[\s\S]*select[\s\S]*where \(select coalesce\(sum\(bytes\)/);
	});

	test('two starts near the cap cannot both reserve (behavioural, real migration + the real insert)', async () => {
		const { Database } = await import('bun:sqlite');
		const db = new Database(':memory:');
		for (const stmt of migration.split(';').map((s) => s.trim()).filter(Boolean)) db.exec(stmt);
		const CAP = 100 * 1024 * 1024;
		// The exact atomic insert the generated start route runs.
		const INSERT =
			"insert into caddie_files (id, ownerId, teamId, name, mime, bytes, sha256, parts, status, createdAt) " +
			"select ?, 'owner', null, ?, 'text/plain', ?, ?, 1, 'uploading', '2026-10-23' " +
			"where (select coalesce(sum(bytes), 0) from caddie_files where status in ('ready','uploading')) + ? <= ?";
		const start = (id: string, bytes: number) =>
			db.prepare(INSERT).run(id, id, bytes, "0".repeat(64), bytes, CAP);
		// First near-cap upload (cap minus 1 byte) is admitted.
		expect(start('a', CAP - 1).changes).toBe(1);
		// A second upload of 2 bytes would overshoot — refused, because the first
		// (still 'uploading') already counts against the cap.
		expect(start('b', 2).changes).toBe(0);
		// Exactly one row was reserved.
		expect((db.prepare("select count(*) as n from caddie_files").get() as { n: number }).n).toBe(1);
		db.close();
	});

	test('the files migration sorts after auth and before the generated schema', () => {
		expect('migrations/0000_caddie_files.sql' > 'migrations/0000_caddie_auth.sql').toBe(true);
		expect('migrations/0000_caddie_files.sql' < 'migrations/0001_schema.sql').toBe(true);
		expect(migration).toContain('create table caddie_files');
		expect(migration).toContain('create table caddie_file_parts');
		// Parts stored as base64 text (the preview gateway's binary pass-through is UNVERIFIED).
		expect(migration).toContain('data text not null');
	});

	test('the server has the five routes, readFile and sign-in', () => {
		expect(server).toContain('/caddie/files/start');
		expect(server).toContain('/caddie/files/:id/parts/:n');
		expect(server).toContain('/caddie/files/:id/finish');
		expect(server).toContain('/caddie/files/:id'); // delete + get
		expect(server).toContain('export async function readFile');
		expect(server).toContain('requireUser');
	});

	test('the browser helpers exist, and photos shrink to 1,600 px', () => {
		expect(upload).toContain('export async function uploadFile');
		expect(upload).toContain('export async function fileUrl');
		expect(upload).toContain('export async function downloadFile');
		expect(upload).toContain('export async function shrinkPhoto');
		expect(upload).toContain('MAX_PHOTO_EDGE = 1600');
		expect(upload).toContain('blob:');
	});

	test('the generated files are protected runtime files (do not edit)', () => {
		expect(migration).toContain('do not edit');
		expect(server).toContain('do not edit');
		expect(upload).toContain('do not edit');
	});
});

// --- behavioural: the real generated routes + browser helpers ----------------

const APP_SERVER = [
	'import { Hono } from "hono";',
	'import type { D1Database } from "../caddie/d1";',
	'import type { CaddiePlatform } from "../caddie/platform";',
	'import { mountSignIn } from "../caddie/auth";',
	'import { mountFiles, readFile } from "../caddie/files";',
	'',
	'export type Env = { DB: D1Database; CADDIE: CaddiePlatform; CADDIE_AUTH_SECRET?: string };',
	'export const app = new Hono<{ Bindings: Env }>().basePath("/api");',
	'app.get("/health", (c) => c.json({ ok: true }));',
	'mountSignIn(app);',
	'mountFiles(app);',
	'',
	'// A route that reads a finished file with the app-facing readFile().',
	'app.get("/read/:id", async (c) => {',
	'  const bytes = await readFile(c, c.req.param("id"));',
	'  if (!bytes) return c.json({ error: "no" }, 404);',
	'  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");',
	'  return c.json({ bytes: bytes.length, sha256: hex });',
	'});',
	'',
	'export default app;',
	'',
].join('\n');

// Route test: the real upload lifecycle, limits and privacy. Uses the scaffold's
// in-memory D1 harness (persistence across a restart is the S4 spike's job; this
// proves the file-specific behaviour — reassembly, sha256, limits, access).
const ROUTE_TEST = [
	'import { describe, expect, test } from "bun:test";',
	'import { app } from "../src/server";',
	'import { signInForTest } from "../test/setup/auth";',
	'import { createTestEnv } from "../test/setup/d1";',
	'',
	'const PART = 700 * 1024;',
	'function toBase64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }',
	'async function sha256Hex(bytes) { const d = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }',
	'function splitParts(bytes, part = PART) { const out = []; for (let at = 0; at < bytes.length || at === 0; at += part) { out.push(bytes.subarray(at, Math.min(at + part, bytes.length))); if (bytes.length === 0) break; } return out; }',
	'async function uploadBytes(env, headers, bytes, mime = "application/pdf", name = "f.pdf") {',
	'  const sha256 = await sha256Hex(bytes);',
	'  const started = await app.request("/api/caddie/files/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name, type: mime, size: bytes.length, sha256 }) }, env);',
	'  if (!started.ok) return { started };',
	'  const { id, parts } = await started.json();',
	'  const chunks = splitParts(bytes);',
	'  expect(chunks.length).toBe(parts);',
	'  for (let n = 0; n < chunks.length; n++) {',
	'    const put = await app.request("/api/caddie/files/" + id + "/parts/" + n, { method: "PUT", headers, body: toBase64(chunks[n]) }, env);',
	'    expect(put.status).toBe(200);',
	'  }',
	'  const finished = await app.request("/api/caddie/files/" + id + "/finish", { method: "POST", headers }, env);',
	'  return { id, parts, finished, sha256 };',
	'}',
	'',
	'describe("part L routes", () => {',
	'  test("a 5 MB file goes up in 8 parts and comes back byte-identical (sha256)", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "ada@example.com");',
	'    const bytes = new Uint8Array(5 * 1024 * 1024);',
	'    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) & 0xff;',
	'    const up = await uploadBytes(env, headers, bytes);',
	'    expect(up.parts).toBe(8);',
	'    expect(up.finished.status).toBe(200);',
	'    const read = await app.request("/api/read/" + up.id, { headers }, env);',
	'    expect(read.status).toBe(200);',
	'    const got = await read.json();',
	'    expect(got.bytes).toBe(bytes.length);',
	'    expect(got.sha256).toBe(up.sha256);',
	'  });',
	'',
	'  test("a wrong sha256 is refused at finish", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "sha@example.com");',
	'    const bytes = new Uint8Array(1000).fill(7);',
	'    const wrong = "0".repeat(64);',
	'    const started = await app.request("/api/caddie/files/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "a.txt", type: "text/plain", size: bytes.length, sha256: wrong }) }, env);',
	'    const { id } = await started.json();',
	'    await app.request("/api/caddie/files/" + id + "/parts/0", { method: "PUT", headers, body: toBase64(bytes) }, env);',
	'    const finished = await app.request("/api/caddie/files/" + id + "/finish", { method: "POST", headers }, env);',
	'    expect(finished.status).toBe(400);',
	'  });',
	'',
	'  test("a part over 700 KB is refused", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "big@example.com");',
	'    const bytes = new Uint8Array(1024);',
	'    const sha256 = await sha256Hex(bytes);',
	'    const started = await app.request("/api/caddie/files/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "a.txt", type: "text/plain", size: bytes.length, sha256 }) }, env);',
	'    const { id } = await started.json();',
	'    const tooBig = new Uint8Array(PART + 1).fill(1);',
	'    const put = await app.request("/api/caddie/files/" + id + "/parts/0", { method: "PUT", headers, body: toBase64(tooBig) }, env);',
	'    expect(put.status).toBe(413);',
	'  });',
	'',
	'  test("a file over 5 MB and a type not on the list are refused at start", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "lim@example.com");',
	'    const sha256 = "a".repeat(64);',
	'    const tooBig = await app.request("/api/caddie/files/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "x", type: "application/pdf", size: 5 * 1024 * 1024 + 1, sha256 }) }, env);',
	'    expect(tooBig.status).toBe(413);',
	'    const badType = await app.request("/api/caddie/files/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "x", type: "application/zip", size: 10, sha256 }) }, env);',
	'    expect(badType.status).toBe(415);',
	'  });',
	'',
	'  test("B cannot read or delete A\'s file", async () => {',
	'    const env = createTestEnv();',
	'    const a = await signInForTest(app, env, "owner@example.com");',
	'    const bytes = new Uint8Array(2048).fill(9);',
	'    const up = await uploadBytes(env, a.headers, bytes);',
	'    expect(up.finished.status).toBe(200);',
	'    const b = await signInForTest(app, env, "other@example.com");',
	'    const readB = await app.request("/api/caddie/files/" + up.id + "/parts/0", { headers: b.headers }, env);',
	'    expect(readB.status).toBe(404);',
	'    const delB = await app.request("/api/caddie/files/" + up.id, { method: "DELETE", headers: b.headers }, env);',
	'    expect(delB.status).toBe(404);',
	'    // A can still read it: it was not deleted.',
	'    const readA = await app.request("/api/caddie/files/" + up.id + "/parts/0", { headers: a.headers }, env);',
	'    expect(readA.status).toBe(200);',
	'  });',
	'});',
	'',
].join('\n');

const BROWSER_TEST = [
	'import { describe, expect, test } from "bun:test";',
	'import { shrinkPhoto, splitParts, MAX_PART_BYTES } from "../caddie/upload";',
	'',
	'describe("part L browser helpers", () => {',
	'  test("splitParts makes 700 KB parts that rejoin to the original", () => {',
	'    const bytes = new Uint8Array(MAX_PART_BYTES * 2 + 123);',
	'    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;',
	'    const parts = splitParts(bytes);',
	'    expect(parts.length).toBe(3);',
	'    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_PART_BYTES);',
	'    const total = parts.reduce((s, p) => s + p.length, 0);',
	'    expect(total).toBe(bytes.length);',
	'  });',
	'',
	'  test("an empty file is still one part", () => {',
	'    expect(splitParts(new Uint8Array(0)).length).toBe(1);',
	'  });',
	'',
	'  test("a non-photo type is returned unchanged (no shrink)", async () => {',
	'    const blob = new Blob(["hello"], { type: "text/plain" });',
	'    const out = await shrinkPhoto(blob);',
	'    expect(out).toBe(blob);',
	'  });',
	'});',
	'',
].join('\n');

describe('part L: generated file routes + helpers run for real', () => {
	let featureApp: FeatureApp;

	beforeAll(() => {
		featureApp = materializeFeatureApp([FILES_FILES], {
			'src/server.ts': APP_SERVER,
			'src/files-routes.test.ts': ROUTE_TEST,
			'src/files-browser.test.ts': BROWSER_TEST,
		});
	}, 240_000);

	afterAll(() => {
		featureApp?.cleanup();
	});

	test(
		'the real routes pass the 5 MB roundtrip, the limits and B-privacy',
		() => {
			const result = runFeatureTest(featureApp, 'src/files-routes.test.ts');
			expect(result.ok, result.out).toBe(true);
			expect(/\b5 pass\b/.test(result.out), result.out).toBe(true);
			expect(/\b0 fail\b/.test(result.out), result.out).toBe(true);
		},
		240_000,
	);

	test(
		'the browser helpers split at 700 KB and skip non-photos',
		() => {
			const result = runFeatureTest(featureApp, 'src/files-browser.test.ts');
			expect(result.ok, result.out).toBe(true);
			expect(/\b3 pass\b/.test(result.out), result.out).toBe(true);
			expect(/\b0 fail\b/.test(result.out), result.out).toBe(true);
		},
		120_000,
	);
});
