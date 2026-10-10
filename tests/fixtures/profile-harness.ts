import { createServer, type Server } from 'node:http';
import { splitSqlStatements } from './controls-harness.ts';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Shared local workerd fixture harness for P14 (profile / memory / search),
 * reusing the P01/P02 fixture patterns verbatim: free loopback ports,
 * readiness identity check, patterned pkill cleanup, temp dirs, stub OAuth
 * provider, cookie jar.
 *
 * The fixture worker is tests/fixtures/profile.ts — it mounts the same
 * production composition app.ts will mount (createProfileApp) plus /__test
 * control routes that exist only in the fixture.
 */

export const REPO_ROOT = join(import.meta.dir, '..', '..');
export const FIXTURE_ENTRY = join(REPO_ROOT, 'tests', 'fixtures', 'profile.ts');
export const IDENTITY_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0001_product.sql');
export const PROFILE_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0008_profile.sql');
export const SCHEDULES_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0007_schedules.sql');
export const DISCOVERY_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0009_discovery.sql');
export const HOME_PROJECT_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0011_home_project.sql');
export const BRIEF_READ_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0012_brief_read.sql');
export const DISCOVERY_SAVED_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0013_discovery_saved.sql');
export const STACK_NOTIFY_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0014_stack_notify.sql');
export const PLAN_DECISIONS_MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0015_plan_decisions.sql');

export const ALICE_EMAIL = 'alice@example.com';
export const BOB_EMAIL = 'bob@example.com';

/**
 * A currently-free loopback port (per-run allocation so a leaked workerd from
 * an earlier run can never be mistaken for this run's fixture).
 */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		// Minimal structural typing: bun-types' net Server does not re-declare
		// the node EventEmitter methods this probe uses.
		const srv = net.createServer() as unknown as {
			listen(port: number, host: string, cb: () => void): void;
			close(cb?: () => void): void;
			on(event: string, listener: () => void): void;
			address(): { port: number } | string | null;
		};
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close();
				reject(new Error('no port'));
			}
		});
		srv.on('error', reject);
	});
}

export function waitFor(url: string, timeoutMs: number): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	let lastError = '';
	const tick = async (): Promise<string | undefined> => {
		while (Date.now() < deadline) {
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
				if (res.status < 599) return undefined;
				lastError = `status ${res.status}`;
			} catch (error) {
				lastError = String(error);
			}
			await Bun.sleep(300);
		}
		return `not ready within ${timeoutMs}ms: ${lastError}`;
	};
	return tick();
}

export interface StartedFixture {
	process: Bun.Subprocess;
	cleanup: () => void;
}

export async function startProfileFixture(
	port: number,
	extraVars: Record<string, string> = {},
): Promise<StartedFixture> {
	const tmp = mkdtempSync(join(tmpdir(), 'caddie-p14-'));
	const config = {
		name: 'caddie-p14-profile-fixture',
		main: FIXTURE_ENTRY,
		compatibility_date: '2026-06-01',
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: false },
		d1_databases: [
			{
				binding: 'DB',
				database_name: 'caddie-profile-fixture',
				database_id: 'fixture-local',
			},
		],
		vars: {
			BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
			BETTER_AUTH_SECRET: 'fixture-only-secret-0123456789abcdef0123456789abcdef',
			INVITE_ALLOWLIST: [ALICE_EMAIL, BOB_EMAIL].join(','),
			// Gates the test-only knobs above (fail-closed fence from P01).
			AUTH_TEST_MODE: '1',
			...extraVars,
		},
	};
	const configPath = join(tmp, 'profile.wrangler.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const logFile = `/tmp/caddie-p14-profile-worker-${port}.log`;
	const persistDir = join(tmp, 'state');
	const cli = wranglerCliPath();
	if (!existsSync(cli)) throw new Error(`wrangler CLI not found at ${cli}`);
	// Detached through a shell own-session (P00 lesson): a directly spawned
	// wrangler child hangs at startup via inherited FDs, and the CLI must run
	// under node (P01 lesson).
	const proc = Bun.spawn(
		[
			'/bin/bash',
			'-c',
			`exec node '${cli}' dev --config '${configPath}' --port ${port} --ip 127.0.0.1 --persist-to '${persistDir}' > '${logFile}' 2>&1`,
		],
		{
			cwd: REPO_ROOT,
			stdout: 'ignore',
			stderr: 'ignore',
			env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
		},
	);
	const notReady = await waitFor(`http://127.0.0.1:${port}/__test/health`, 90_000);
	if (notReady) {
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(no log)';
		throw new Error(`fixture worker failed to start: ${notReady}\nlog:\n${log}`);
	}
	// Confirm the fixture itself answers — with THIS run's identity.
	const health = await fetch(`http://127.0.0.1:${port}/__test/health`, {
		signal: AbortSignal.timeout(5000),
	});
	const healthBody = (await health.json()) as { ok?: boolean; d1?: boolean; betterAuthUrl?: string };
	const expectedBase = `http://127.0.0.1:${port}`;
	if (!healthBody.ok || !healthBody.d1 || healthBody.betterAuthUrl !== expectedBase) {
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(no log)';
		throw new Error(
			`fixture worker identity check failed (got ${JSON.stringify(healthBody)}, want ok+d1+betterAuthUrl=${expectedBase})\nlog:\n${log}`,
		);
	}
	const cleanup = () => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// best effort
		}
	};
	return { process: proc, cleanup };
}

function wranglerCliPath(): string {
	// wrangler is a devDependency of apps/app; resolve without registry access.
	const resolved = Bun.resolveSync('wrangler', join(REPO_ROOT, 'apps', 'app'));
	return resolved.replace(/wrangler-dist\/[^/]+\.js$/, 'wrangler-dist/cli.js');
}

export function stopProfileFixture(port: number) {
	// Pattern-based cleanup only (P01 lesson): matches only this suite's own
	// processes — the wrangler CLI started with our unique temp config dir,
	// and the workerd bound to exactly this run's fixture port.
	for (const signal of ['-15', '-9']) {
		Bun.spawnSync(['pkill', signal, '-f', `caddie-p14-.*profile.wrangler.json --port ${port} `]);
		Bun.spawnSync(['pkill', signal, '-f', `workerd.*entry=127.0.0.1:${port} `]);
		Bun.sleepSync(300);
	}
	rmSync(`/tmp/caddie-p14-profile-worker-${port}.log`, { force: true });
}

/** Apply the production migrations P14 depends on: identity+product, then P14. */
export async function applyMigrations(port: number): Promise<void> {
	for (const path of [IDENTITY_MIGRATION_PATH, SCHEDULES_MIGRATION_PATH, PROFILE_MIGRATION_PATH, DISCOVERY_MIGRATION_PATH, HOME_PROJECT_MIGRATION_PATH, BRIEF_READ_MIGRATION_PATH, DISCOVERY_SAVED_MIGRATION_PATH, STACK_NOTIFY_MIGRATION_PATH, PLAN_DECISIONS_MIGRATION_PATH]) {
		const ddl = readFileSync(path, 'utf8');
		// The proper splitter (controls-harness) skips comment lines and
		// trigger bodies — the naive ';' split emits comment-only chunks that
		// D1 rejects ("did not contain a statement").
		const statements = splitSqlStatements(ddl);
		const res = await fetch(`http://127.0.0.1:${port}/__test/ddl`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ statements }),
		});
		if (res.status !== 200) {
			throw new Error(`migration apply failed for ${path} (${res.status}): ${await res.text()}`);
		}
	}
}

export async function d1Exec(base: string, sql: string): Promise<{ results: unknown[] }> {
	const res = await fetch(`${base}/__test/d1`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sql }),
	});
	if (res.status !== 200) throw new Error(`d1 exec failed (${res.status}): ${await res.text()}`);
	return (await res.json()) as { results: unknown[] };
}

export async function d1Count(base: string, table: string, where = '1=1'): Promise<number> {
	const res = await d1Exec(base, `select count(*) as n from ${table} where ${where}`);
	const rows = res.results as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

// --- authenticated-session helpers (P01 fixture pattern) ------------------------

export class Jar {
	private map = new Map<string, string>();
	absorb(res: Response) {
		for (const cookie of res.headers.getSetCookie()) {
			const pair = cookie.split(';')[0] ?? '';
			const eq = pair.indexOf('=');
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			const expired = /max-age=0|expires=Thu, 01 Jan 1970/i.test(cookie);
			if (expired || value === '') this.map.delete(name);
			else this.map.set(name, value);
		}
	}
	header(): string {
		return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
	}
	set(name: string, value: string) {
		this.map.set(name, value);
	}
}

export interface StubProfile {
	sub: string;
	email: string;
	name: string;
	email_verified: boolean;
}

/** Stub OAuth2 provider (authorization endpoint, token endpoint, userinfo). */
export class StubProvider {
	profile: StubProfile = {
		sub: 'stub-sub-initial',
		email: ALICE_EMAIL,
		name: 'Stub User',
		email_verified: true,
	};
	private codes = new Map<
		string,
		{ challenge: string; redirectUri: string; scope: string; profile: StubProfile }
	>();
	private tokens = new Map<string, StubProfile>();
	private server: Server | undefined;
	url = '';

	setProfile(p: StubProfile) {
		this.profile = p;
	}

	start(port: number): Promise<void> {
		const server = createServer((req, res) => {
			const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
			if (u.pathname === '/authorize') {
				const state = u.searchParams.get('state');
				const redirectUri = u.searchParams.get('redirect_uri');
				const challenge = u.searchParams.get('code_challenge');
				if (!state || !redirectUri || !challenge) {
					res.writeHead(400, { 'content-type': 'text/plain' });
					res.end('stub provider: missing state/redirect_uri/code_challenge');
					return;
				}
				const code = randomBytes(16).toString('hex');
				this.codes.set(code, {
					challenge,
					redirectUri,
					scope: u.searchParams.get('scope') ?? '',
					profile: { ...this.profile },
				});
				const target = new URL(redirectUri);
				target.searchParams.set('code', code);
				target.searchParams.set('state', state);
				res.writeHead(302, { location: target.toString() });
				res.end();
				return;
			}
			if (u.pathname === '/token' && req.method === 'POST') {
				let body = '';
				req.on('data', (chunk: Buffer) => (body += chunk));
				req.on('end', () => {
					const params = new URLSearchParams(body);
					const issued = this.codes.get(params.get('code') ?? '');
					const verifier = params.get('code_verifier') ?? '';
					if (
						!issued ||
						params.get('client_id') !== 'stub-client-id' ||
						params.get('redirect_uri') !== issued.redirectUri
					) {
						res.writeHead(400, { 'content-type': 'application/json' });
						res.end(JSON.stringify({ error: 'invalid_grant' }));
						return;
					}
					const expected = createHash('sha256').update(verifier).digest('base64url');
					if (expected !== issued.challenge) {
						res.writeHead(400, { 'content-type': 'application/json' });
						res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'pkce mismatch' }));
						return;
					}
					this.codes.delete(params.get('code') ?? '');
					const token = randomBytes(24).toString('hex');
					this.tokens.set(token, issued.profile);
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(
						JSON.stringify({
							access_token: token,
							token_type: 'Bearer',
							expires_in: 3600,
							scope: issued.scope,
						}),
					);
				});
				return;
			}
			if (u.pathname === '/userinfo') {
				const auth = req.headers.authorization ?? '';
				const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
				const profile = this.tokens.get(token);
				if (!profile) {
					res.writeHead(401, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: 'invalid_token' }));
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ...profile, id: profile.sub }));
				return;
			}
			res.writeHead(404, { 'content-type': 'text/plain' });
			res.end('stub provider: unknown path');
		});
		this.server = server;
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				this.url = `http://127.0.0.1:${port}`;
				resolve();
			});
		});
	}

	stop() {
		return new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}
}

export function makeWorker(base: string) {
	return async (jar: Jar, path: string, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		if (jar.header()) headers.set('cookie', jar.header());
		const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${base}${path}`;
		const res = await fetch(url, { ...init, headers, redirect: 'manual' });
		jar.absorb(res);
		return res;
	};
}

/**
 * Drive the OAuth round trip exactly like a browser would (SIMULATED at the
 * provider boundary; everything after it is the real worker + real D1).
 * The stub provider is passed explicitly so each sign-in targets its own
 * identity — a stale provider profile must never leak into another user.
 */
export async function driveOAuth(
	worker: ReturnType<typeof makeWorker>,
	jar: Jar,
	stub: StubProvider,
	provider: string,
	profile: StubProfile,
) {
	stub.setProfile(profile);
	const start = await worker(jar, '/api/auth/sign-in/social', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ provider, callbackURL: '/' }),
	});
	const startBody = (await start.json()) as { url?: string };
	if (!startBody.url) throw new Error(`sign-in did not return an authorization url: ${start.status}`);
	const providerRes = await fetch(startBody.url, { redirect: 'manual' });
	const callbackUrl = providerRes.headers.get('location');
	if (!callbackUrl) throw new Error('stub provider did not redirect back');
	await worker(jar, callbackUrl);
}

/** Sign in as a fresh user with the given email; returns the cookie jar. */
export async function signInAs(
	worker: ReturnType<typeof makeWorker>,
	stub: StubProvider,
	email: string,
	sub: string,
	name: string,
): Promise<Jar> {
	const jar = new Jar();
	await driveOAuth(worker, jar, stub, 'google', { sub, email, name, email_verified: true });
	return jar;
}

export function sessionCookieHeader(jar: Jar): string {
	return jar.header();
}
