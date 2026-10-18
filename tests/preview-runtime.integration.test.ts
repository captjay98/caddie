import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freePort } from './fixtures/controls-harness.ts';
import { AUTH_FILES } from '../stacks/react-hono/auth-files.ts';
import { SERVER_FILES } from '../stacks/react-hono/server-files.ts';

/**
 * Backend previews under REAL workerd (`wrangler dev`, local mode): the app's
 * server bundle runs in a Worker Loader isolate, reaches its per-project
 * PreviewDatabase Durable Object through the RPC gateway as Cloudflare D1's
 * API, and cannot reach the network.
 *
 * Classification: LOCAL VERIFIED (real workerd + local Durable Object
 * storage). Production Worker Loader availability (open beta, Workers Paid)
 * is NOT verified here — that stays BLOCKED on the owner's account.
 */

const repoRoot = join(import.meta.dir, '..');
const appDir = join(repoRoot, 'apps', 'app');
let port = 0;
let base = '';
let tmp = '';
let serverSource = '';
let signInSource = '';

async function bundle(entry: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [entry],
		target: 'browser',
		format: 'esm',
		conditions: ['workerd', 'worker', 'browser'],
		// Same as the template's server build: node: built-ins come from nodejs_compat.
		external: ['cloudflare:*', 'node:*'],
		plugins: [
			{
				// The fixtures live outside apps/app's node_modules.
				name: 'resolve-from-app',
				setup(build) {
					build.onResolve({ filter: /^(hono|better-auth)(\/.*)?$/ }, (args) => ({ path: Bun.resolveSync(args.path, appDir) }));
				},
			},
		],
	});
	if (!result.success) throw new Error(result.logs.map(String).join('\n'));
	return result.outputs[0]!.text();
}

/** A server made from the template's real sign-in files (caddie/*.ts), as a generated app would mount them. */
async function signInServer(dir: string): Promise<string> {
	const files: Record<string, string> = {
		'caddie/d1.ts': SERVER_FILES['caddie/d1.ts']!,
		'caddie/ai.ts': SERVER_FILES['caddie/ai.ts']!,
		'caddie/platform.ts': AUTH_FILES['caddie/platform.ts']!,
		'caddie/auth.ts': AUTH_FILES['caddie/auth.ts']!,
		'server.ts': [
			'import { Hono } from "hono";',
			'import { mountSignIn, requireUser } from "./caddie/auth";',
			'const app = new Hono<{ Bindings: any }>().basePath("/api");',
			'mountSignIn(app);',
			'app.get("/health", (c) => c.json({ ok: true }));',
			'app.get("/mine", async (c) => c.json({ email: (await requireUser(c)).email }));',
			'export default app;',
			'',
		].join('\n'),
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return bundle(join(dir, 'server.ts'));
}

async function call(path: string, body: unknown): Promise<any> {
	const res = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
	return res.json();
}

const run = (request: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	call('/run', { outputId: 'out-1', projectId: 'proj-a', serverSource, request: { headers: [], body: null, ...request }, ...extra });

beforeAll(async () => {
	serverSource = await bundle(join(import.meta.dir, 'fixtures', 'preview-app', 'server.ts'));
	port = await freePort();
	base = `http://127.0.0.1:${port}`;
	tmp = mkdtempSync(join(tmpdir(), 'caddie-preview-rt-'));
	signInSource = await signInServer(join(tmp, 'sign-in-app'));
	const config = {
		name: 'caddie-preview-runtime-fixture',
		main: join(import.meta.dir, 'fixtures', 'preview-runtime-worker.ts'),
		compatibility_date: '2026-06-01',
		compatibility_flags: ['nodejs_compat'],
		worker_loaders: [{ binding: 'LOADER' }],
		durable_objects: { bindings: [{ name: 'PREVIEW_DB', class_name: 'PreviewDatabase' }] },
		migrations: [{ tag: 'v1', new_sqlite_classes: ['PreviewDatabase'] }],
		vars: { EGRESS_DENY_HOSTS: 'caddie.test' },
	};
	const configPath = join(tmp, 'preview-runtime.wrangler.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const cli = Bun.resolveSync('wrangler', appDir).replace(/wrangler-dist\/[^/]+\.js$/, 'wrangler-dist/cli.js');
	const log = join(tmp, 'worker.log');
	Bun.spawn(
		[
			'/bin/bash',
			'-c',
			`exec node '${cli}' dev --config '${configPath}' --port ${port} --ip 127.0.0.1 --persist-to '${join(tmp, 'state')}' > '${log}' 2>&1`,
		],
		{ cwd: repoRoot, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } },
	);
	const deadline = Date.now() + 90_000;
	for (;;) {
		try {
			const res = await fetch(`${base}/__test/health`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) break;
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) throw new Error(`preview fixture did not start:\n${existsSync(log) ? readFileSync(log, 'utf8') : '(no log)'}`);
		await Bun.sleep(300);
	}
}, 120_000);

afterAll(() => {
	Bun.spawnSync(['pkill', '-f', `preview-runtime.wrangler.json --port ${port} `]);
	Bun.spawnSync(['pkill', '-f', `workerd.*${port}`]);
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('backend preview runtime under workerd', () => {
	test('the bindings exist', async () => {
		const res = await fetch(`${base}/__test/health`);
		expect(await res.json()).toEqual({ ok: true, loader: true, db: true });
	});

	test('the runs-on-Cloudflare check passes a real Hono bundle', async () => {
		expect(await call('/check', { serverSource })).toEqual({ ok: true });
	});

	test('the check fails a server that needs Bun', async () => {
		const bunOnly = 'const version = Bun.version; export default { fetch() { return new Response(version); } };';
		const result = await call('/check', { serverSource: bunOnly });
		expect(result.ok).toBe(false);
		expect(String(result.reason)).toMatch(/Bun/);
	});

	test('migrations, writes and reads go through D1 to the preview database', async () => {
		const migrations = [{ name: '0001_notes.sql', sql: 'create table notes (id integer primary key, body text not null);' }];
		const created = await run(
			{ method: 'POST', path: '/api/notes', headers: [['content-type', 'application/json']], body: btoa('{"body":"plant maize"}') },
			{ migrations },
		);
		expect(created.migrations.applied).toEqual(['0001_notes.sql']);
		expect(created.relayed.status).toBe(201);
		expect(JSON.parse(atob(created.relayed.body))).toEqual({ id: 1 });
		const listed = await run({ method: 'GET', path: '/api/notes' }, { migrations });
		expect(listed.migrations.applied).toEqual([]);
		expect(JSON.parse(atob(listed.relayed.body))).toEqual([{ id: 1, body: 'plant maize' }]);
	});

	test('each project has its own preview database, even for the same output id', async () => {
		// Regression: Worker Loader reuses a warm isolate (and the env it was first
		// loaded with) per id, so the id must include the project.
		const other = await call('/run', {
			outputId: 'out-1',
			projectId: 'proj-b',
			serverSource,
			migrations: [{ name: '0001_notes.sql', sql: 'create table notes (id integer primary key, body text not null);' }],
			request: { method: 'GET', path: '/api/notes', headers: [], body: null },
		});
		expect(JSON.parse(atob(other.relayed.body))).toEqual([]);
	});

	test("the app gets its own keys and no network", async () => {
		const key = await run({ method: 'GET', path: '/api/key' }, { vars: { WEATHER_KEY: 'w-123' } });
		expect(JSON.parse(atob(key.relayed.body))).toEqual({ key: 'w-123' });
		const changed = await run({ method: 'GET', path: '/api/key' }, { vars: { WEATHER_KEY: 'w-456' } });
		expect(JSON.parse(atob(changed.relayed.body))).toEqual({ key: 'w-456' });
		const egress = await run({ method: 'GET', path: '/api/egress' });
		expect(atob(egress.relayed.body)).toBe('blocked');
	});

	test("with the gate, the app's server reaches public services with its key and nothing private", async () => {
		const fetchVia = async (target: string) => {
			const res = await run(
				{ method: 'GET', path: `/api/fetch?url=${encodeURIComponent(target)}` },
				{ vars: { WEATHER_KEY: 'w-789' }, egress: 'gate' },
			);
			return JSON.parse(atob(res.relayed.body));
		};
		expect(await fetchVia('https://api.weather.example.com/forecast?city=Kano')).toEqual({
			status: 200,
			body: 'upstream saw GET https://api.weather.example.com/forecast?city=Kano auth=Bearer w-789',
		});
		for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]:8787/', 'http://localhost:8787/api/projects', 'https://caddie.test/api/projects']) {
			const denied = await fetchVia(target);
			expect(denied.status).toBe(403);
			expect(JSON.parse(denied.body).error).toBe('egress_denied');
		}
		// An allowed site that redirects to a private address is stopped at the hop.
		const bounced = await fetchVia('https://bounce.example.com/');
		expect(bounced.status).toBe(403);
		expect(JSON.parse(bounced.body).reason).toBe('private-address');
	});

	test("env.CADDIE reaches Caddie's platform over RPC, always for the app's own project", async () => {
		const asked = await run({ method: 'GET', path: '/api/ask?q=soup%3F' }, { platform: true });
		expect(JSON.parse(atob(asked.relayed.body))).toEqual({ ok: true, text: 'proj-a asked: soup?' });
		const without = await run({ method: 'GET', path: '/api/ask?q=soup%3F' });
		expect(JSON.parse(atob(without.relayed.body))).toEqual({ ok: false, reason: 'no_platform' });
	});

	test("the template's sign-in works in Cloudflare's runtime: a code, a session cookie, the signed-in user, sign-out", async () => {
		const migrations = [{ name: '0000_caddie_auth.sql', sql: AUTH_FILES['migrations/0000_caddie_auth.sql']! }];
		const vars = { CADDIE_AUTH_SECRET: 'workerd-test-only-secret-0123456789abcdef' };
		const app = (request: Record<string, unknown>) =>
			call('/run', { outputId: 'out-auth', projectId: 'proj-auth', serverSource: signInSource, vars, platform: true, migrations, request: { headers: [], body: null, ...request } });
		const json = (body: unknown, headers: [string, string][] = []) => ({ headers: [['content-type', 'application/json'], ...headers], body: btoa(JSON.stringify(body)) });
		// A server with sign-in still passes the check every build runs.
		expect(await call('/check', { serverSource: signInSource })).toEqual({ ok: true });

		const asked = await app({ method: 'POST', path: '/api/auth/code', ...json({ email: 'ada@example.com' }) });
		expect(asked.relayed.status).toBe(200);
		const { code } = await call('/codes', { projectId: 'proj-auth', email: 'ada@example.com' });
		expect(code).toMatch(/^\d{6}$/);
		const wrong = await app({ method: 'POST', path: '/api/auth/sign-in', ...json({ email: 'ada@example.com', code: code === '000000' ? '111111' : '000000' }) });
		expect(wrong.relayed.status).toBe(400);

		const signed = await app({ method: 'POST', path: '/api/auth/sign-in', ...json({ email: 'ada@example.com', code }) });
		expect(signed.relayed.status).toBe(200);
		const cookies = (signed.relayed.headers as [string, string][]).filter(([name]) => name === 'set-cookie').map(([, value]) => value);
		expect(cookies.some((value) => value.startsWith('__Secure-app.session_token=') && /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value))).toBe(true);
		const cookie = cookies.map((value) => value.split(';')[0]).join('; ');

		const mine = await app({ method: 'GET', path: '/api/mine', headers: [['cookie', cookie]] });
		expect(JSON.parse(atob(mine.relayed.body))).toEqual({ email: 'ada@example.com' });
		expect((await app({ method: 'GET', path: '/api/mine' })).relayed.status).toBe(401);
		await app({ method: 'POST', path: '/api/auth/sign-out', ...json({}, [['cookie', cookie]]) });
		expect((await app({ method: 'GET', path: '/api/mine', headers: [['cookie', cookie]] })).relayed.status).toBe(401);
	});

	test('every Set-Cookie survives the relay', async () => {
		const res = await run({ method: 'GET', path: '/api/cookie' });
		const cookies = res.relayed.headers.filter(([name]: [string]) => name === 'set-cookie').map(([, value]: [string, string]) => value);
		expect(cookies).toEqual(['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/']);
	});

	test('Reset test data empties the project database', async () => {
		await call('/reset', { projectId: 'proj-a' });
		const migrations = [{ name: '0001_notes.sql', sql: 'create table notes (id integer primary key, body text not null);' }];
		const listed = await run({ method: 'GET', path: '/api/notes' }, { migrations });
		expect(listed.migrations.applied).toEqual(['0001_notes.sql']);
		expect(JSON.parse(atob(listed.relayed.body))).toEqual([]);
	});
});
