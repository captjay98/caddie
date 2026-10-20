import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P00 routing acceptance, executed against the real built artifact in local
 * workerd (`vite preview` runs the Flue-generated Worker under miniflare).
 *
 * Requires `bun run build` first: the Worker bundle, the composed assets
 * tree, and the composition manifest. A missing artifact fails the run —
 * it is never treated as a pass.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const DIST_DIR = join(APP_DIR, 'dist');
const CLIENT_DIR = join(DIST_DIR, 'client');
const MANIFEST_PATH = join(DIST_DIR, 'composition-manifest.json');

/**
 * The PIDs listening on a TCP port, if any. `lsof -ti -sTCP:LISTEN tcp:N`
 * (the spelling this used to use) is a usage error on macOS lsof 4.91: it
 * writes to stderr and reports nothing on stdout, so it always looked free.
 */
function portOwners(port: number): string[] {
	const owner = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
	return owner.stdout.toString().trim().split('\n').filter(Boolean);
}

/**
 * The first port nothing is listening on, from a PID-derived base that keeps
 * separate runs apart. A crashed run's leftover listener — or another gate
 * running at the same time — is walked past, never killed.
 */
function freePort(from: number): number {
	for (let port = from; port < from + 50; port++) {
		if (portOwners(port).length === 0) return port;
	}
	throw new Error(`no free preview port in ${from}..${from + 49}`);
}

const PORT = freePort(9400 + (process.pid % 300));
const BASE = `http://127.0.0.1:${PORT}`;
const PREVIEW_LOG = `/tmp/caddie-p00-preview-${PORT}.log`;

let preview: Bun.Subprocess;

async function waitForServer(timeoutMs: number): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	let lastError = '';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/api/auth/status`, {
				signal: AbortSignal.timeout(1500),
			});
			// Any HTTP response means the preview server is up. Route-level
			// correctness is asserted by the tests below, never here.
			if (res.status < 599) return undefined;
			lastError = `status ${res.status}`;
		} catch (error) {
			lastError = String(error);
		}
		await Bun.sleep(300);
	}
	return `server not ready within ${timeoutMs}ms: ${lastError}`;
}

beforeAll(async () => {
	if (!existsSync(join(DIST_DIR, 'caddie_app', 'index.js'))) {
		throw new Error(
			'Worker bundle missing — run `bun run build` before tests/routing.test.ts',
		);
	}
	// Detach through a shell: a vite/workerd child spawned directly by the
	// test runner hangs at startup (inherited FDs), while an own-session
	// process boots normally. Logs go to a file for failure diagnosis.
	preview = Bun.spawn(
		[
			'/bin/bash',
			'-c',
			`exec bunx vite preview --port ${PORT} --host 127.0.0.1 > '${PREVIEW_LOG}' 2>&1`,
		],
		{ cwd: APP_DIR, stdout: 'ignore', stderr: 'ignore' },
	);
	const notReady = await waitForServer(30_000);
	if (notReady) {
		const log = existsSync(PREVIEW_LOG) ? readFileSync(PREVIEW_LOG, 'utf8') : '(no log)';
		throw new Error(`preview failed to start: ${notReady}\nlog:\n${log}`);
	}
}, 45_000);

afterAll(() => {
	preview?.kill();
	// The detached preview survives its parent; kill whatever still listens
	// on the test's port and verify the port is actually freed, escalating
	// to SIGKILL if a clean TERM did not take.
	try {
		Bun.spawnSync(['pkill', '-f', `vite preview --port ${PORT}`]);
		for (let attempt = 0; attempt < 2; attempt++) {
			const pids = portOwners(PORT);
			if (pids.length === 0) return;
			Bun.spawnSync(['kill', attempt === 0 ? '-15' : '-9', ...pids]);
			Bun.sleepSync(500);
		}
	} catch {
		// best-effort cleanup
	}
});
describe('P00 routing composition', () => {
	test('composition manifest reports a real scan with no collisions', () => {
		expect(existsSync(MANIFEST_PATH)).toBe(true);
		const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
			collisions: string[];
			spa: { relocated: string[]; scanned: number };
			landing: { files: string[]; scanned: number };
		};
		expect(manifest.collisions).toEqual([]);
		expect(manifest.spa.relocated).toContain('app/index.html');
		expect(manifest.landing.files).toContain('index.html');
		// prove a real scan happened (the field is computed, not a constant)
		expect(manifest.spa.scanned).toBeGreaterThan(0);
		expect(manifest.landing.scanned).toBeGreaterThan(0);
	});

	test('landing page is served at / from Astro output', async () => {
		const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		const body = await res.text();
		expect(body).toContain('Caddie');
	});

	test('landing assets resolve (astro output intact)', async () => {
		const landing = await (await fetch(`${BASE}/`)).text();
		const assetRefs = [...landing.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(
			(m) => m[1],
		);
		for (const ref of assetRefs) {
			const res = await fetch(`${BASE}${ref}`, { signal: AbortSignal.timeout(5000) });
			expect(res.status).toBe(200);
		}
		expect(assetRefs.length).toBeGreaterThan(0);
	});

	test('/app redirects to the SPA shell (loop-free)', async () => {
		const res = await fetch(`${BASE}/app`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
		expect(res.status).toBe(307);
		expect(res.headers.get('location')).toBe('/app/');
	});

	test('/app serves the SPA shell', async () => {
		const res = await fetch(`${BASE}/app/`, { signal: AbortSignal.timeout(5000) });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		const body = await res.text();
		expect(body).toContain('id="root"');
	});

	test('/app deep links fall back to the SPA shell', async () => {
		const res = await fetch(`${BASE}/app/projects/some-id/runs/abc`, {
			signal: AbortSignal.timeout(5000),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		const body = await res.text();
		expect(body).toContain('id="root"');
	});

	test('SPA shell script assets resolve after composition', async () => {
		const shell = await (await fetch(`${BASE}/app/`)).text();
		const scripts = [...shell.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
		expect(scripts.length).toBeGreaterThan(0);
		for (const src of scripts) {
			const res = await fetch(`${BASE}${src}`, { signal: AbortSignal.timeout(5000) });
			expect(res.status).toBe(200);
		}
	});

	test('auth composition point responds', async () => {
		const res = await fetch(`${BASE}/api/auth/status`, {
			signal: AbortSignal.timeout(5000),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.json()).toEqual({ authenticated: false });
	});

	test('projects router is composed: unauthenticated list is 401 JSON, not the 404 fallback', async () => {
		const res = await fetch(`${BASE}/api/projects`, {
			signal: AbortSignal.timeout(5000),
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(((await res.json()) as { error?: string }).error).toBe('unauthenticated');
	});

	test('unknown /api path is a JSON 404, never the SPA or landing', async () => {
		const res = await fetch(`${BASE}/api/definitely-not-a-route`, {
			signal: AbortSignal.timeout(5000),
		});
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toContain('application/json');
		const body = (await res.json()) as { error?: string };
		expect(body).toHaveProperty('error');
		expect(body.error).not.toContain('<');
	});

	test('registered agent router is composed (reached handler, no model call)', async () => {
		// A malformed body must reach the Flue agent router and fail there —
		// any structured non-404 response proves composition. The flat
		// {"error":"not_found"} fallback would mean the mount is missing.
		const res = await fetch(`${BASE}/agents/hello/p00-routing-probe`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ bogus: true }),
			signal: AbortSignal.timeout(5000),
		});
		expect(res.status).not.toBe(404);
		if (res.status >= 400) {
			const body = await res.json();
			expect(body).toHaveProperty('error');
		}
	});

	test('unregistered agent path stays 404', async () => {
		const res = await fetch(`${BASE}/agents/nonexistent/p00-probe`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(5000),
		});
		expect(res.status).toBe(404);
	});

	test('astro and SPA index outputs do not shadow each other', async () => {
		const landing = await (await fetch(`${BASE}/`)).text();
		const spa = await (await fetch(`${BASE}/app/`)).text();
		// The landing is the Astro page (no React root); the SPA shell is the
		// React root (not the Astro hero). Each keeps its own document.
		expect(landing).not.toContain('id="root"');
		expect(spa).not.toContain('build with evidence');
	});

	test('the preview port picker walks past a port in use instead of killing its owner', async () => {
		// Another gate running at the same time — or a crashed run's leftover —
		// may hold the derived port. Picking must move on to the next free one,
		// and the listener it walked past must still be alive afterwards.
		const held = freePort(9900);
		const other = Bun.spawn(
			[
				'bun',
				'-e',
				`Bun.serve({ port: ${held}, hostname: '127.0.0.1', fetch: () => new Response('held') });`,
			],
			{ stdout: 'ignore', stderr: 'ignore' },
		);
		try {
			const deadline = Date.now() + 10_000;
			let up = false;
			while (Date.now() < deadline && !up) {
				try {
					up = (await fetch(`http://127.0.0.1:${held}/`)).ok;
				} catch {
					await Bun.sleep(100);
				}
			}
			expect(up).toBe(true);
			expect(freePort(held)).not.toBe(held);
			expect(await (await fetch(`http://127.0.0.1:${held}/`)).text()).toBe('held');
		} finally {
			other.kill();
		}
	});
});
