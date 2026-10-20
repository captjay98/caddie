import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { androidApiBase, buildAndroidPackage, androidDownloadView, apkDownloadToken, checkApk, createAndroidAppRouter, saveAndroidApp, verifyApkDownloadToken } from '../apps/app/src/server/android-app.ts';
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
  const apkHash = createHash('sha256').update(APK).digest('hex');
  const manifest = Buffer.from(JSON.stringify({ v: 1, android: { sha256: apkHash, bytes: APK.byteLength } }));
  const manifestHash = createHash('sha256').update(manifest).digest('hex');
  sqlite.prepare('insert into artifact_content (contentHash,bytes,size,createdAt) values (?,?,?,?)').run(manifestHash, manifest, manifest.byteLength, stamp);
  sqlite.prepare('update workflow_outputs set manifestSha256 = ? where id = ?').run(manifestHash, 'out-1');

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
    w.sqlite.prepare('update workflow_outputs set apkSha256 = ? where id = ?').run('replaced-package', 'out-1');
    expect((await router.request(`/a/proj_android/app.apk?t=${encodeURIComponent(token)}`, {}, env(w.db))).status).toBe(404);

	});

  test('a checked output cannot have its Android package replaced', async () => {
    const w = world();
    await saveAndroidApp(w.db, 'proj_android', 'out-1', APK);
    const other = APK.slice(); other[100] = 1;
    await expect(saveAndroidApp(w.db, 'proj_android', 'out-1', other)).rejects.toThrow('cannot be replaced');
    await expect(saveAndroidApp(w.db, 'proj_other', 'out-1', APK)).rejects.toThrow('No such Android build');
  });

	test('without a link, the APK is public only while the app is published', async () => {
		const w = world();
		await saveAndroidApp(w.db, 'proj_android', 'out-1', APK);
		const router = createAndroidAppRouter();
		expect((await router.request('/a/proj_android/app.apk', {}, env(w.db))).status).toBe(404);
		w.sqlite.prepare("insert into app_publications (projectId,slug,script,status,outputId,hasServer,createdAt,updatedAt) values ('proj_android','farm-log','app-1','live','out-1',1,?,?)").run(w.stamp, w.stamp);
		expect((await router.request('/a/proj_android/app.apk', {}, env(w.db))).status).toBe(200);
		expect((await router.request('/a/proj_android/app.apk?v=out-1', {}, env(w.db))).status).toBe(200);
		expect((await router.request('/a/proj_android/app.apk?v=out-old', {}, env(w.db))).status).toBe(404);
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

	test('a malformed apps domain never forwards anywhere', async () => {
		const w = world();
		w.sqlite.prepare("insert into app_publications (projectId,slug,script,status,outputId,hasServer,createdAt,updatedAt) values ('proj_android','farm-log','app-1','live','out-1',1,?,?)").run(w.stamp, w.stamp);
		let called = false;
		const fetchImpl = (async () => {
			called = true;
			return new Response('{}');
		}) as unknown as typeof fetch;
		const response = await createAndroidAppRouter().request('/a/proj_android/api/health', {}, { ...env(w.db, fetchImpl), APPS_DOMAIN: 'caddieapps.com/evil' });
		expect(response.status).toBe(503);
		expect(called).toBe(false);
	});
});

describe('wiring into the running app', () => {
	test('the /a routes sit on the app itself (no Caddie session), before the fallbacks, and run before static files', () => {
		const app = readFileSync(new URL('../apps/app/src/app.ts', import.meta.url), 'utf8');
		expect(app).toContain("import { createAndroidAppRouter } from './server/android-app.ts';");
		const mount = app.indexOf("app.route('/', createAndroidAppRouter());");
		expect(mount).toBeGreaterThan(-1);
		expect(mount).toBeLessThan(app.indexOf('app.notFound('));
		expect(app).not.toContain('api.route(\'/\', createAndroidAppRouter())');
		const wrangler = readFileSync(new URL('../apps/app/wrangler.jsonc', import.meta.url), 'utf8');
		const workerFirst = /"run_worker_first":\s*\[([^\]]*)\]/.exec(wrangler)?.[1] ?? '';
		expect(workerFirst).toContain('"/a/*"');
	});
});


describe('host-owned Android package check', () => {
  const input = { origin: ORIGIN, projectId: 'proj_android', runId: 'run', sessionId: 's', root: '/workspace/proj_android', operationKey: 'apk-check', env: {} };
  const driver = (receipt: Record<string, unknown>, apk = APK) => ({
    execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    checkpoint: async () => ({ checkpointRef: 'apk-image' }),
    getOperationReceipt: async () => ({ inputImage: 'apk-image', projectId: input.projectId, runId: input.runId, sessionId: input.sessionId, operationKey: input.operationKey, command: `flutter build apk --release --target-platform android-arm64 --dart-define=CADDIE_API_BASE=${ORIGIN}/a/proj_android`, cwd: input.root, state: 'succeeded', exitCode: 0, timedOut: false, outputTruncated: false, resultImage: 'apk-image', ...receipt }),
    readFile: async () => ({ contentBase64: Buffer.from(apk).toString('base64') }),
  });
  test('only a matching successful host receipt and APK bytes produce a download', async () => {
    const result = await buildAndroidPackage(driver({}) as never, input);
    expect(result.apk?.length).toBe(APK.length);
    expect(result.image).toBe('apk-image');
    const relative = driver({ cwd: '/workspace/proj_android/app' });
    expect((await buildAndroidPackage(relative as never, { ...input, root: 'app' })).apk?.length).toBe(APK.length);
    const mutation = driver({}); let checkpoints = 0;
    mutation.checkpoint = async () => ({ checkpointRef: ++checkpoints === 1 ? 'apk-image' : 'modified-image' });
    expect((await buildAndroidPackage(mutation as never, input)).apk).toBeNull();
    expect((await buildAndroidPackage(driver({}) as never, { ...input, expectedInputImage: 'browser-image' })).apk).toBeNull();

    for (const bad of [{ exitCode: 1 }, { projectId: 'other' }, { inputImage: 'foreign-image' }, { timedOut: true }, { outputTruncated: true }]) {
      expect((await buildAndroidPackage(driver(bad) as never, input)).apk).toBeNull();
    }
    expect((await buildAndroidPackage(driver({ created: true }, new Uint8Array(1_100_000)) as never, input)).apk).toBeNull();
  });
  test('HTTP local development explains unavailable APK without executing a command', async () => {
    const result = await buildAndroidPackage({ execute: async () => { throw new Error('must not execute'); } } as never, { ...input, origin: 'http://localhost:5176' });
    expect(result.apk).toBeNull();
    expect(result.message).toContain('HTTPS');
  });
});
