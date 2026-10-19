import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { androidApiBase, apkDownloadToken, checkApk, createAndroidAppRouter, saveAndroidApp, verifyApkDownloadToken } from '../apps/app/src/server/android-app.ts';
import { allMigrationPaths } from './fixtures/migrations.ts';

/**
 * Track 3, stage E: the Android app. Its server address is a stable Caddie
 * address that forwards to the published app while it is live, so an APK
 * built before publishing (or before a new address) keeps working.
 */

const SECRET = 'caddie-master-secret-for-tests-0123';
const ORIGIN = 'https://caddie.example.com';
const APK = (() => {
	const bytes = new Uint8Array(1_500_000);
	bytes.set([0x50, 0x4b, 0x03, 0x04]);
	return bytes;
})();

function world() {
	const sqlite = new Database(':memory:');
	for (const path of allMigrationPaths()) sqlite.exec(readFileSync(path, 'utf8'));
	const statement = (sql: string, args: unknown[] = []) => {
		const stmt = sqlite.prepare(sql);
		return {
			bind: (...next: unknown[]) => statement(sql, next),
			all: async () => ({ results: stmt.all(...(args as never[])) }),
			run: async () => ({ meta: { changes: stmt.run(...(args as never[])).changes } }),
			first: async () => stmt.get(...(args as never[])),
			_run: () => stmt.run(...(args as never[])),
		};
	};
	const db = {
		prepare: (sql: string) => statement(sql),
		async batch(statements: { _run(): unknown }[]) {
			return statements.map((s) => s._run());
		},
	} as unknown as D1Database;
	const stamp = '2026-10-19T00:00:00.000Z';
	sqlite.prepare('insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)').run('alice', 'Alice', 'alice@example.com', stamp, stamp);
	sqlite.prepare('insert into workspaces (id,name,createdAt) values (?,?,?)').run('ws-1', 'Alice', stamp);
	sqlite.prepare("insert into projects (id,workspaceId,name,description,status,kind,createdAt,updatedAt) values (?,?,?,?,'active','standard',?,?)").run('proj_android', 'ws-1', 'Farm Log', 'x', stamp, stamp);
	sqlite.prepare("insert into artifact_content (contentHash,bytes,size,createdAt) values ('h', x'00', 1, ?)").run(stamp);
	sqlite.prepare("insert into workflow_outputs (id,projectId,runId,planId,image,sha256,createdAt) values ('out-1','proj_android','run','plan','img','h',?)").run(stamp);
	return { sqlite, db, stamp };
}

describe("the Android app's server address", () => {
	test('a stable Caddie address per project, https only', () => {
		expect(androidApiBase('https://caddie.example.com/', 'proj_android')).toBe('https://caddie.example.com/a/proj_android');
		expect(androidApiBase('http://localhost:5176', 'proj_android')).toBeNull();
		expect(androidApiBase('', 'proj_android')).toBeNull();
	});
});

describe('checking a built APK', () => {
	test('a zip of at least 1 MB passes; anything else is refused plainly', () => {
		expect(checkApk(APK)).toBeNull();
		expect(checkApk(new Uint8Array(2_000_000))).toContain('not an Android app');
		expect(checkApk(APK.subarray(0, 1000))).toContain('too small');
	});
});

describe('download links', () => {
	test('a signed link works until it expires, for that project and version only', async () => {
		const now = Date.parse('2026-10-19T12:00:00Z');
		const token = await apkDownloadToken(SECRET, 'proj_android', 'out-1', now);
		expect(await verifyApkDownloadToken(SECRET, 'proj_android', token, now + 10 * 60_000)).toBe('out-1');
		expect(await verifyApkDownloadToken(SECRET, 'proj_android', token, now + 31 * 60_000)).toBeNull();
		expect(await verifyApkDownloadToken(SECRET, 'proj_other', token, now)).toBeNull();
		expect(await verifyApkDownloadToken('another-secret-entirely-0123456789', 'proj_android', token, now)).toBeNull();
		const [out, exp, sig] = token.split('.');
		expect(await verifyApkDownloadToken(SECRET, 'proj_android', `out-2.${exp}.${sig}`, now)).toBeNull();
		expect(await verifyApkDownloadToken(SECRET, 'proj_android', `${out}.${Number(exp) + 999}.${sig}`, now)).toBeNull();
		expect(await verifyApkDownloadToken(SECRET, 'proj_android', 'garbage', now)).toBeNull();
	});
});

describe('the public /a/<project> routes', () => {
	const env = (db: D1Database, fetchImpl?: typeof fetch) => ({ DB: db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: ORIGIN, APPS_DOMAIN: 'caddieapps.com', fetchImpl });

	test('the APK downloads with a valid link, as an Android package, never cached by others', async () => {
		const w = world();
		await saveAndroidApp(w.db, 'proj_android', 'out-1', APK);
		const router = createAndroidAppRouter();
		const token = await apkDownloadToken(SECRET, 'proj_android', 'out-1', Date.now());
		const response = await router.request(`/a/proj_android/app.apk?t=${encodeURIComponent(token)}`, {}, env(w.db));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/vnd.android.package-archive');
		expect(response.headers.get('content-disposition')).toBe('attachment; filename="farm-log.apk"');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(APK.byteLength);
	});

	test('without a link, the APK is public only while the app is published', async () => {
		const w = world();
		await saveAndroidApp(w.db, 'proj_android', 'out-1', APK);
		const router = createAndroidAppRouter();
		expect((await router.request('/a/proj_android/app.apk', {}, env(w.db))).status).toBe(404);
		w.sqlite.prepare("insert into app_publications (projectId,slug,script,status,outputId,hasServer,createdAt,updatedAt) values ('proj_android','farm-log','app-1','live','out-1',1,?,?)").run(w.stamp, w.stamp);
		expect((await router.request('/a/proj_android/app.apk', {}, env(w.db))).status).toBe(200);
		w.sqlite.prepare("update app_publications set status = 'paused'").run();
		expect((await router.request('/a/proj_android/app.apk', {}, env(w.db))).status).toBe(404);
	});

	test("the app's API calls go to the published app while it is live, and get a plain 503 otherwise", async () => {
		const w = world();
		const seen: string[] = [];
		const fetchImpl = (async (input: Request) => {
			seen.push(`${input.method} ${input.url}`);
			return Response.json({ ok: true });
		}) as unknown as typeof fetch;
		const router = createAndroidAppRouter();
		const off = await router.request('/a/proj_android/api/health', {}, env(w.db, fetchImpl));
		expect(off.status).toBe(503);
		expect(await off.json()).toEqual({ error: 'app_not_published', message: "This app's server isn't on the web right now." });
		w.sqlite.prepare("insert into app_publications (projectId,slug,script,status,outputId,hasServer,createdAt,updatedAt) values ('proj_android','farm-log','app-1','live','out-1',1,?,?)").run(w.stamp, w.stamp);
		const on = await router.request('/a/proj_android/api/notes?limit=2', { method: 'POST', body: '{"text":"hi"}', headers: { 'content-type': 'application/json' } }, env(w.db, fetchImpl));
		expect(on.status).toBe(200);
		expect(seen).toEqual(['POST https://farm-log.caddieapps.com/api/notes?limit=2']);
		// Only /api routes forward; nothing else of the app is reachable this way.
		expect((await router.request('/a/proj_android/admin', {}, env(w.db, fetchImpl))).status).toBe(404);
	});

	test("no cookie crosses: Caddie's never reaches the app, and the app's never lands on Caddie", async () => {
		const w = world();
		w.sqlite.prepare("insert into app_publications (projectId,slug,script,status,outputId,hasServer,createdAt,updatedAt) values ('proj_android','farm-log','app-1','live','out-1',1,?,?)").run(w.stamp, w.stamp);
		let sentCookie: string | null = 'unset';
		const fetchImpl = (async (input: Request) => {
			sentCookie = input.headers.get('cookie');
			return new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'session=app; Path=/' } });
		}) as unknown as typeof fetch;
		const response = await createAndroidAppRouter().request('/a/proj_android/api/me', { headers: { cookie: 'caddie.session_token=secret', authorization: 'Bearer app-token' } }, env(w.db, fetchImpl));
		expect(sentCookie).toBeNull();
		expect(response.headers.get('set-cookie')).toBeNull();
	});
});
