import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * P01 — Better Auth 1.7.7 on Cloudflare Workers + D1, executed against a real
 * local workerd (`wrangler dev` = miniflare/workerd with a real local SQLite
 * D1 database) and a stub OAuth provider running in this test process.
 *
 * Honesty classification:
 *   - Worker runtime, D1 persistence, Better Auth state/cookie/session
 *     mechanics: LOCAL VERIFIED (real workerd, real SQLite-backed D1).
 *   - The OAuth provider endpoints are a stub inside this test process, so
 *     every OAuth interaction here is SIMULATED at the provider boundary.
 *     Real Google/GitHub callback verification needs staging credentials and
 *     stays BLOCKED for this packet (see docs/setup/auth.md).
 *
 * The fixture worker entry is tests/fixtures/auth.ts; it mounts the SAME
 * production composition (createAuthApp: apps/app/src/server/auth.ts +
 * routes/auth.ts) plus /__test/* control routes that are compiled into the
 * fixture only and are never part of the app Worker.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const FIXTURE_ENTRY = join(REPO_ROOT, 'tests', 'fixtures', 'auth.ts');
const DDL_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'auth-schema.sql');

const INVITED_EMAIL = 'invited@example.com';
const LINKED_EMAIL = 'linked@example.com';
const REPLAY_EMAIL = 'replay@example.com';
const LOGOUT_EMAIL = 'logout@example.com';
const SESSION_COOKIE = 'better-auth.session_token';

// --- small helpers -----------------------------------------------------------

/**
 * A currently-free loopback port. Ports are allocated per run (instead of
 * derived from the pid) so a leaked workerd from an earlier run can never be
 * mistaken for this run's fixture.
 */
function freePort(): Promise<number> {
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

class Jar {
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
	set(name: string, value: string) {
		this.map.set(name, value);
	}
	header(): string {
		return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
	}
	has(prefix: string): boolean {
		return [...this.map.keys()].some((k) => k.startsWith(prefix));
	}
	names(): string[] {
		return [...this.map.keys()];
	}
}

interface StubProfile {
	/** OIDC subject (Google-style). Always present in stub profiles. */
	sub: string;
	/** Plain-OAuth numeric id (GitHub-style). Defaults to `sub`. */
	id?: string;
	email: string;
	name: string;
	email_verified: boolean;
}

/** Stub OAuth2 provider (authorization endpoint, token endpoint, userinfo). */
class StubProvider {
	profile: StubProfile = {
		sub: 'stub-sub-initial',
		email: INVITED_EMAIL,
		name: 'Stub User',
		email_verified: true,
	};
	requests: string[] = [];
	private codes = new Map<
		string,
		{ challenge: string; redirectUri: string; scope: string; profile: StubProfile }
	>();
	private tokens = new Map<string, StubProfile>();
	server: Server | undefined;
	url = '';

	setProfile(p: StubProfile) {
		this.profile = p;
	}

	/** Wire representation returned by /userinfo: `sub` and `id` both set. */
	private wireProfile(p: StubProfile) {
		return { ...p, id: p.id ?? p.sub };
	}

	start(port: number): Promise<void> {
		const server = createServer((req, res) => {
			const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
			this.requests.push(u.pathname);
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
				const scope = u.searchParams.get('scope') ?? '';
				this.codes.set(code, { challenge, redirectUri, scope, profile: { ...this.profile } });
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
					const code = params.get('code') ?? '';
					const verifier = params.get('code_verifier') ?? '';
					const clientId = params.get('client_id') ?? '';
					const redirectUri = params.get('redirect_uri') ?? '';
					const issued = this.codes.get(code);
					// single-use authorization code; PKCE S256 proof required
					if (!issued || clientId !== 'stub-client-id' || redirectUri !== issued.redirectUri) {
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
					this.codes.delete(code); // consume: token-endpoint replay fails
					const token = randomBytes(24).toString('hex');
					this.tokens.set(token, issued.profile);
					res.writeHead(200, { 'content-type': 'application/json' });
					// real providers echo the granted scope (RFC 6749: space-delimited)
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
				res.end(JSON.stringify(this.wireProfile(profile)));
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

// --- fixture worker lifecycle -------------------------------------------------

// Ports are allocated dynamically in beforeAll (stub first, then workers);
// each worker's readiness check verifies the fixture's own health payload so
// a stray listener can never stand in for the fixture.
let WORKER_PORT = 0;
let TTL_WORKER_PORT = 0;
let WORKER_BASE = '';
let TTL_WORKER_BASE = '';

let workerProcess: Bun.Subprocess | undefined;
let ttlWorkerProcess: Bun.Subprocess | undefined;
const stub = new StubProvider();

function wranglerCliPath(): string {
	// wrangler is a devDependency of apps/app; resolve without any registry access.
	const resolved = Bun.resolveSync('wrangler', join(REPO_ROOT, 'apps', 'app'));
	// resolved points at the package entry; the CLI lives next to it.
	return resolved.replace(/wrangler-dist\/[^/]+\.js$/, 'wrangler-dist/cli.js');
}

async function waitFor(url: string, timeoutMs: number): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	let lastError = '';
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
}

async function startFixtureWorker(
	port: number,
	extraVars: Record<string, string>,
): Promise<{ process: Bun.Subprocess; cleanup: () => void }> {
	const tmp = mkdtempSync(join(tmpdir(), 'caddie-p01-'));
	const config = {
		name: 'caddie-auth-fixture',
		main: FIXTURE_ENTRY,
		compatibility_date: '2026-06-01',
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: false },
		d1_databases: [
			{
				binding: 'DB',
				database_name: 'caddie-auth-fixture',
				database_id: 'fixture-local',
			},
		],
		vars: {
			BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
			BETTER_AUTH_SECRET: 'fixture-only-secret-0123456789abcdef0123456789abcdef',
			// every email a mechanic test signs up with (each test uses its own
			// email + provider subject so tests stay order-independent)
			INVITE_ALLOWLIST: [INVITED_EMAIL, LINKED_EMAIL, REPLAY_EMAIL, LOGOUT_EMAIL].join(','),
			AUTH_STUB_BASE_URL: stub.url,
			// Gates the test-only knobs above: without it createAuth refuses to
			// start (fail-closed against stray test vars in real deployments).
			AUTH_TEST_MODE: '1',
			...extraVars,
		},
	};
	const configPath = join(tmp, 'wrangler.auth.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const logFile = `/tmp/caddie-p01-auth-worker-${port}.log`;
	const persistDir = join(tmp, 'state');
	const cli = wranglerCliPath();
	if (!existsSync(cli)) throw new Error(`wrangler CLI not found at ${cli}`);
	// Detached through a shell own-session (P00 lesson): a directly spawned
	// wrangler child hangs at startup via inherited FDs. wrangler is spawned
	// under node: its CLI accepts TCP but never dispatches requests when the
	// CLI itself runs under the bun runtime (verified locally, P01).
	const proc = Bun.spawn(
		[
			'/bin/bash',
			'-c',
			`exec node '${cli}' dev --config '${configPath}' --port ${port} --ip 127.0.0.1 --persist-to '${persistDir}' > '${logFile}' 2>&1`,
		],
		{ cwd: REPO_ROOT, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } },
	);
	const notReady = await waitFor(`http://127.0.0.1:${port}/__test/health`, 90_000);
	if (notReady) {
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(no log)';
		throw new Error(`fixture worker failed to start: ${notReady}\nlog:\n${log}`);
	}
	// The readiness probe above accepts any HTTP response; confirm the fixture
	// itself answers — with THIS run's identity, not a leaked older process.
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

function stopFixtureWorker(port: number) {
	// Pattern-based cleanup only: lsof output is not dependable in every
	// environment (sandboxed hosts report unrelated pids), so listeners are
	// never killed by socket scan. Both patterns match only this suite's own
	// processes — the wrangler CLI started with our unique temp config dir,
	// and the workerd bound to exactly this run's fixture port.
	for (const signal of ['-15', '-9']) {
		Bun.spawnSync(['pkill', signal, '-f', `caddie-p01-.*wrangler.auth.json --port ${port} `]);
		Bun.spawnSync(['pkill', signal, '-f', `workerd.*entry=127.0.0.1:${port} `]);
		Bun.sleepSync(300);
	}
	rmSync(`/tmp/caddie-p01-auth-worker-${port}.log`, { force: true });
}

async function applyDdl(port: number): Promise<void> {
	const ddl = readFileSync(DDL_PATH, 'utf8');
	const statements = ddl
		.split(/;\s*(?:\n|$)/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const res = await fetch(`http://127.0.0.1:${port}/__test/ddl`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ statements }),
	});
	if (res.status !== 200) throw new Error(`DDL apply failed (${res.status}): ${await res.text()}`);
}

async function d1Exec(base: string, sql: string): Promise<{ results: unknown[] }> {
	const res = await fetch(`${base}/__test/d1`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sql }),
	});
	if (res.status !== 200) throw new Error(`d1 exec failed (${res.status}): ${await res.text()}`);
	return (await res.json()) as { results: unknown[] };
}

async function d1Count(base: string, table: string, where = '1=1'): Promise<number> {
	const res = await d1Exec(base, `select count(*) as n from ${table} where ${where}`);
	const rows = res.results as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

function makeWorker(base: string) {
	return async (jar: Jar, path: string, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		if (jar.header()) headers.set('cookie', jar.header());
		// Provider redirects hand back absolute callback URLs on the worker's
		// own origin — pass those through untouched.
		const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${base}${path}`;
		const res = await fetch(url, { ...init, headers, redirect: 'manual' });
		jar.absorb(res);
		return res;
	};
}
// Bound lazily: WORKER_BASE is allocated in beforeAll, after module load.
const worker = ((jar: Jar, path: string, init?: RequestInit) =>
	makeWorker(WORKER_BASE)(jar, path, init)) as ReturnType<typeof makeWorker>;

/**
 * Drive the OAuth round trip exactly like a browser would: sign-in request,
 * follow the redirect to the stub provider, then the provider redirects back
 * to the worker callback. Returns every hop for assertions.
 */
async function driveOAuth(
	jar: Jar,
	provider: string,
	profile: StubProfile,
	fetcher: (jar: Jar, path: string, init?: RequestInit) => Promise<Response> = worker,
) {
	stub.setProfile(profile);
	const start = await fetcher(jar, '/api/auth/sign-in/social', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ provider, callbackURL: '/' }),
	});
	const startBody = (await start.json()) as { url?: string; redirect?: boolean; message?: string };
	if (!startBody.url) return { start, startBody, providerRes: undefined, callback: undefined, final: undefined };
	// browser follows the authorization URL (stub provider)
	const providerRes = await fetch(startBody.url, { redirect: 'manual' });
	const callbackUrl = providerRes.headers.get('location');
	if (!callbackUrl) return { start, startBody, providerRes, callback: undefined, final: undefined };
	// browser follows the provider redirect back to the worker callback
	const callback = await fetcher(jar, callbackUrl);
	const finalLocation = callback.headers.get('location');
	const final = finalLocation ? await fetcher(jar, finalLocation) : undefined;
	return { start, startBody, providerRes, callback, final };
}

// --- setup ---------------------------------------------------------------------

const ddlStatements = () =>
	readFileSync(DDL_PATH, 'utf8')
		.split(/;\s*(?:\n|$)/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

beforeAll(async () => {
	if (!existsSync(FIXTURE_ENTRY)) {
		throw new Error('fixture worker entry missing: tests/fixtures/auth.ts');
	}
	if (!existsSync(DDL_PATH)) {
		throw new Error('auth schema fixture missing: tests/fixtures/auth-schema.sql');
	}
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	const main = await startFixtureWorker(WORKER_PORT, {});
	workerProcess = main.process;
	await applyDdl(WORKER_PORT);
	// Second worker with a 2-second session TTL for the real-clock expiry test.
	TTL_WORKER_PORT = await freePort();
	TTL_WORKER_BASE = `http://127.0.0.1:${TTL_WORKER_PORT}`;
	const ttl = await startFixtureWorker(TTL_WORKER_PORT, { AUTH_SESSION_TTL_SECONDS: '2' });
	ttlWorkerProcess = ttl.process;
	await applyDdl(TTL_WORKER_PORT);
}, 240_000);

afterAll(async () => {
	stopFixtureWorker(WORKER_PORT);
	stopFixtureWorker(TTL_WORKER_PORT);
	await stub.stop();
});

// --- slice 1: spike --------------------------------------------------------------

describe('P01 spike: Better Auth on Workers + D1', () => {
	test('better-auth handler serves session introspection from the fixture workerd', async () => {
		const res = await worker(new Jar(), '/api/auth/get-session');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.json()).toBeNull();
	});

	test('built-in google and github providers are registered and github requests no repo scopes', async () => {
		// In-process probe of the production config: URL construction only —
		// no network. Uses the real library code path with dummy client ids.
		// The library's own schema check runs on first API use, so the probe
		// applies the canonical DDL fixture to its in-memory database first.
		const { createAuth } = await import('../apps/app/src/server/auth.ts');
		const { Database } = await import('bun:sqlite');
		const db = new Database(':memory:');
		db.exec(readFileSync(DDL_PATH, 'utf8'));
		const auth = createAuth(
			{
				DB: db as unknown as import('../apps/app/src/server/auth.ts').D1Database,
				BETTER_AUTH_SECRET: 'probe-secret-0123456789abcdef0123456789abcdef',
				BETTER_AUTH_URL: 'http://127.0.0.1:1',
				GOOGLE_CLIENT_ID: 'probe-google-id',
				GOOGLE_CLIENT_SECRET: 'probe-google-secret',
				GITHUB_CLIENT_ID: 'probe-github-id',
				GITHUB_CLIENT_SECRET: 'probe-github-secret',
			} as never,
			{ database: db },
		);
		const google = await auth.api.signInSocial({ body: { provider: 'google', callbackURL: '/' } });
		const github = await auth.api.signInSocial({ body: { provider: 'github', callbackURL: '/' } });
		expect(google.url).toContain('accounts.google.com/o/oauth2/v2/auth');
		expect(github.url).toContain('github.com/login/oauth/authorize');
		const googleScopes = new URL(google.url!).searchParams.get('scope')?.split(' ') ?? [];
		const githubScopes = new URL(github.url!).searchParams.get('scope')?.split(' ') ?? [];
		expect(new Set(googleScopes)).toEqual(new Set(['openid', 'email', 'profile']));
		expect(new Set(githubScopes)).toEqual(new Set(['read:user', 'user:email']));
		for (const scope of githubScopes) {
			expect(scope.startsWith('repo')).toBe(false);
		}
	});

	test('fixture worker runs PKCE S256 against the stub authorization endpoint', async () => {
		// The stub /authorize rejects requests without a code_challenge, so its
		// 302 proves the worker sends PKCE (SIMULATED at the provider boundary,
		// LOCAL VERIFIED in the worker). The flow stops at the provider on
		// purpose — no callback, so no user row is created and later tests see
		// a clean database for their emails.
		const jar = new Jar();
		stub.setProfile({
			sub: 'pkce-probe-sub',
			email: INVITED_EMAIL,
			name: 'PKCE Probe',
			email_verified: true,
		});
		const start = await worker(jar, '/api/auth/sign-in/social', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
		});
		const startBody = (await start.json()) as { url?: string };
		expect(startBody.url).toContain('code_challenge=');
		expect(startBody.url).toContain('code_challenge_method=S256');
		const providerRes = await fetch(startBody.url!, { redirect: 'manual' });
		expect(providerRes.status).toBe(302);
		expect(providerRes.headers.get('location')).toContain('/api/auth/callback/google');
		expect(jar.has(SESSION_COOKIE)).toBe(false);
	});
});

// --- slice 2: identity mechanics ---------------------------------------------------

describe('P01 slice 2: invite allowlist, provider-subject identity, sessions', () => {
	test('uninvited email is denied at sign-up: no user row, no session', async () => {
		const jar = new Jar();
		const result = await driveOAuth(jar, 'google', {
			sub: 'uninvited-sub-1',
			email: 'uninvited@example.com',
			name: 'Uninvited',
			email_verified: true,
		});
		const callbackStatus = result.callback?.status ?? 0;
		const location = result.callback?.headers.get('location') ?? '';
		// The gate must visibly fail the sign-in (error response or error redirect).
		expect(callbackStatus >= 400 || location.includes('error')).toBe(true);
		// Database truth: no user was created for the uninvited email.
		expect(await d1Count(WORKER_BASE, 'user', "email = 'uninvited@example.com'")).toBe(0);
		expect(await d1Count(WORKER_BASE, 'account', "accountId = 'uninvited-sub-1'")).toBe(0);
		// No session may leak to the denied caller.
		expect(jar.has(SESSION_COOKIE)).toBe(false);
	});

	test('invited user signs in: identity is the provider subject, not the email', async () => {
		const jar = new Jar();
		const result = await driveOAuth(jar, 'google', {
			sub: 'subject-alpha',
			email: INVITED_EMAIL,
			name: 'Alpha',
			email_verified: true,
		});
		expect(result.callback?.status).toBe(302);
		expect(jar.has(SESSION_COOKIE)).toBe(true);

		const session = (await (await worker(jar, '/api/auth/get-session')).json()) as {
			user: { id: string; email: string };
		};
		expect(session.user.email).toBe(INVITED_EMAIL);

		// provider-subject identity: the account row is keyed on the provider's
		// immutable subject, exactly as the IdP reported it
		const accounts = await d1Exec(
			WORKER_BASE,
			`select providerId, accountId, userId from account where accountId = 'subject-alpha'`,
		);
		const rows = accounts.results as { providerId: string; accountId: string; userId: string }[];
		expect(rows.length).toBe(1);
		expect(rows[0]!.providerId).toBe('google');
		expect(rows[0]!.accountId).toBe('subject-alpha');
		expect(rows[0]!.userId).toBe(session.user.id);
	});

	test('same provider subject with a changed email resolves to the same user', async () => {
		// Precondition from the previous test: exactly one user behind subject-alpha.
		expect(await d1Count(WORKER_BASE, 'account', "accountId = 'subject-alpha'")).toBe(1);
		const before = (await (await worker(new Jar(), '/api/auth/get-session')).json()) as null;
		expect(before).toBeNull();

		const jar = new Jar();
		const result = await driveOAuth(jar, 'google', {
			sub: 'subject-alpha',
			email: 'renamed-alpha@example.com',
			name: 'Alpha Renamed',
			email_verified: true,
		});
		expect(jar.has(SESSION_COOKIE)).toBe(true);
		const session = (await (await worker(jar, '/api/auth/get-session')).json()) as {
			user: { id: string };
		};
		const original = await d1Exec(
			WORKER_BASE,
			`select userId from account where accountId = 'subject-alpha'`,
		);
		const originalUserId = (original.results as { userId: string }[])[0]!.userId;
		// identity follows the provider subject: same account, same user row
		expect(session.user.id).toBe(originalUserId);
		// and no duplicate user appeared
		expect(await d1Count(WORKER_BASE, 'account', "accountId = 'subject-alpha'")).toBe(1);
	});

	test('same email from a different provider subject is NOT merged (no implicit linking)', async () => {
		// subject-alpha's user exists with INVITED_EMAIL. A different subject
		// claiming the same email must never silently join that account.
		const usersBefore = await d1Count(WORKER_BASE, 'user', `email = '${INVITED_EMAIL}'`);
		expect(usersBefore).toBe(1);

		const jar = new Jar();
		const result = await driveOAuth(jar, 'github', {
			sub: 'subject-beta',
			email: INVITED_EMAIL,
			name: 'Beta Impostor',
			email_verified: true,
		});
		const callbackStatus = result.callback?.status ?? 0;
		const location = result.callback?.headers.get('location') ?? '';
		expect(callbackStatus >= 400 || location.includes('error')).toBe(true);
		// no session was issued to the unlinked subject
		expect(jar.has(SESSION_COOKIE)).toBe(false);
		// the github identity was not attached to the existing user
		expect(await d1Count(WORKER_BASE, 'account', "providerId = 'github' and accountId = 'subject-beta'")).toBe(0);
		// and no second user row exists for that email
		expect(await d1Count(WORKER_BASE, 'user', `email = '${INVITED_EMAIL}'`)).toBe(1);
	});

	test('explicit linking while signed in preserves identity and requests no repo scopes', async () => {
		// 1. fresh invited user signs in via the google stub
		const jar = new Jar();
		const signin = await driveOAuth(jar, 'google', {
			sub: 'link-sub-google',
			email: LINKED_EMAIL,
			name: 'Linker',
			email_verified: true,
		});
		expect(signin.callback?.status).toBe(302);
		expect(jar.has(SESSION_COOKIE)).toBe(true);
		const session = (await (await worker(jar, '/api/auth/get-session')).json()) as {
			user: { id: string };
		};

		// 2. explicit link request for github while authenticated
		const linkStart = await worker(jar, '/api/auth/link-social', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: WORKER_BASE },
			body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
		});
		expect(linkStart.status).toBe(200);
		const linkBody = (await linkStart.json()) as { url?: string };
		expect(linkBody.url).toContain(`${stub.url}/authorize`);

		// 3. complete the provider round trip with the same email
		stub.setProfile({
			sub: 'link-sub-github',
			email: LINKED_EMAIL,
			name: 'Linker',
			email_verified: true,
		});
		const providerRes = await fetch(linkBody.url!, { redirect: 'manual' });
		const callbackUrl = providerRes.headers.get('location');
		expect(callbackUrl).toBeTruthy();
		const callback = await worker(jar, callbackUrl!);
		expect(callback.status).toBe(302);

		// 4. same user id, two provider identities
		const after = (await (await worker(jar, '/api/auth/get-session')).json()) as {
			user: { id: string };
		};
		expect(after.user.id).toBe(session.user.id);
		const accounts = await d1Exec(
			WORKER_BASE,
			`select providerId, accountId, scope from account where userId = '${session.user.id}' order by providerId`,
		);
		const rows = accounts.results as { providerId: string; accountId: string; scope: string | null }[];
		expect(rows.length).toBe(2);
		expect(rows[0]).toMatchObject({ providerId: 'github', accountId: 'link-sub-github' });
		expect(rows[1]).toMatchObject({ providerId: 'google', accountId: 'link-sub-google' });
		// persisted github identity scope: identity only, no repository access
		// (better-auth stores the parsed RFC 6749 scope list comma-joined)
		expect(rows[0]!.scope).toBe('read:user,user:email');
		for (const scope of (rows[0]!.scope ?? '').split(',')) {
			expect(scope.startsWith('repo')).toBe(false);
		}
	});

	test('forged state on the callback endpoint is rejected', async () => {
		const usersBefore = await d1Count(WORKER_BASE, 'user');
		const sessionsBefore = await d1Count(WORKER_BASE, 'session');

		const jar = new Jar();
		const res = await worker(jar, '/api/auth/callback/google?code=forged-code&state=forged-state');
		const location = res.headers.get('location') ?? '';
		expect(res.status >= 400 || location.includes('error')).toBe(true);
		expect(jar.has(SESSION_COOKIE)).toBe(false);
		expect(await d1Count(WORKER_BASE, 'user')).toBe(usersBefore);
		expect(await d1Count(WORKER_BASE, 'session')).toBe(sessionsBefore);
	});

	test('replayed callback is rejected: no second session from a consumed flow', async () => {
		const jar = new Jar();
		const result = await driveOAuth(jar, 'google', {
			sub: 'replay-sub',
			email: REPLAY_EMAIL,
			name: 'Replay',
			email_verified: true,
		});
		expect(jar.has(SESSION_COOKIE)).toBe(true);
		const callbackUrl = result.providerRes?.headers.get('location');
		expect(callbackUrl).toBeTruthy();
		const userIdRows = await d1Exec(
			WORKER_BASE,
			`select userId from account where accountId = 'replay-sub'`,
		);
		const userId = (userIdRows.results as { userId: string }[])[0]!.userId;
		expect(await d1Count(WORKER_BASE, 'session', `userId = '${userId}'`)).toBe(1);

		// replay the exact callback URL from a fresh (cookie-less) client
		const replayJar = new Jar();
		const replay = await worker(replayJar, callbackUrl!);
		const location = replay.headers.get('location') ?? '';
		expect(replay.status >= 400 || location.includes('error')).toBe(true);
		expect(replayJar.has(SESSION_COOKIE)).toBe(false);
		expect(await d1Count(WORKER_BASE, 'session', `userId = '${userId}'`)).toBe(1);
	});

	test('logout revokes the server session for every bearer of the cookie', async () => {
		const jarA = new Jar();
		const result = await driveOAuth(jarA, 'google', {
			sub: 'logout-sub',
			email: LOGOUT_EMAIL,
			name: 'Logout',
			email_verified: true,
		});
		expect(jarA.has(SESSION_COOKIE)).toBe(true);
		const session = (await (await worker(jarA, '/api/auth/get-session')).json()) as {
			user: { id: string };
		};

		// a second client holds a copy of the same cookie
		const tokenPair = jarA.header().split('; ').find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
		const jarB = new Jar();
		jarB.set(SESSION_COOKIE, tokenPair.split('=')[1]!);
		const jarBSession = (await (await worker(jarB, '/api/auth/get-session')).json()) as {
			user: { id: string };
		};
		expect(jarBSession.user.id).toBe(session.user.id);

		// logout from A (JSON content type + same-origin header, as a browser
		// client would send)
		const signOut = await worker(jarA, '/api/auth/sign-out', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: WORKER_BASE },
			body: '{}',
		});
		expect(signOut.status).toBe(200);

		// both bearers are now unauthenticated; the session row is gone
		expect(await (await worker(jarA, '/api/auth/get-session')).json()).toBeNull();
		expect(await (await worker(jarB, '/api/auth/get-session')).json()).toBeNull();
		expect(await d1Count(WORKER_BASE, 'session', `userId = '${session.user.id}'`)).toBe(0);
	});

	test('attacker-chosen session cookies never resolve (no session fixation)', async () => {
		const jar = new Jar();
		jar.set(SESSION_COOKIE, 'attacker-chosen-token-value');
		const res = await worker(jar, '/api/auth/get-session');
		expect(await res.json()).toBeNull();
		expect(await d1Count(WORKER_BASE, 'session', "token = 'attacker-chosen-token-value'")).toBe(0);
	});

	test('sessions expire after the configured TTL (real clock, short-TTL worker)', async () => {
		const ttlWorker = makeWorker(TTL_WORKER_BASE);
		const jar = new Jar();
		const result = await driveOAuth(jar, 'google', {
			sub: 'ttl-sub',
			email: INVITED_EMAIL,
			name: 'Short TTL',
			email_verified: true,
		}, ttlWorker);
		expect(jar.has(SESSION_COOKIE)).toBe(true);
		const fresh = await ttlWorker(jar, '/api/auth/get-session');
		expect(await fresh.json()).not.toBeNull();

		// AUTH_SESSION_TTL_SECONDS=2 on this worker: wait out the real clock.
		await Bun.sleep(2600);
		const expired = await ttlWorker(jar, '/api/auth/get-session');
		expect(await expired.json()).toBeNull();
	});

	test('auth status endpoint stays contract-exact for unauthenticated callers', async () => {
		const res = await worker(new Jar(), '/api/auth/status');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ authenticated: false });
	});

	test('identity DDL in 0001_product.sql never drifts from the fixture', () => {
		// The fixture and the production migration must stay byte-identical at
		// the statement level: the fixture proves the migration's schema, so a
		// divergence would make every test here lie about production D1. Only
		// the identity section is compared — P02 appends product tables after
		// the IDENTITY-DDL-BOUNDARY marker.
		const migration = readFileSync(
			join(import.meta.dir, '..', 'apps', 'app', 'migrations', '0001_product.sql'),
			'utf8',
		);
		const fixture = readFileSync(
			join(import.meta.dir, 'fixtures', 'auth-schema.sql'),
			'utf8',
		);
		const identitySection = migration.split('IDENTITY-DDL-BOUNDARY')[0];
		const statements = (sql: string) =>
			sql
				.split('\n')
				.filter((line) => /^\s*(create|drop|alter)\b/i.test(line))
				.map((line) => line.trim());
		expect(statements(identitySection)).toEqual(statements(fixture));
	});
});
