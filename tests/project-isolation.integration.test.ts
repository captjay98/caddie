import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeParse } from 'valibot';
import {
	ArtifactRevisionSchema,
	PlanDocRevisionSchema,
	ProjectSchema,
	RunBindingRecordSchema,
	WorkspaceSchema,
} from '../packages/contracts/src/projects.ts';
import { RunBindingSchema } from '../packages/contracts/src/index.ts';
import type { AuthEnv, D1Database } from '../apps/app/src/server/auth.ts';
import {
	projectScopeForUser,
	requireProjectScope,
	requireWorkspaceScope,
	ScopeError,
	workspaceScopeForUser,
} from '../apps/app/src/server/scope.ts';
import * as projectsService from '../apps/app/src/server/projects.ts';

/**
 * P02 — Projects, scoped persistence and artifacts, executed against a real
 * local workerd (`wrangler dev` = miniflare/workerd with a real local
 * SQLite-backed D1 database). Reuses the P01 fixture harness pattern
 * (free ports, readiness identity check, patterned pkill cleanup, temp dirs).
 *
 * Honesty classification:
 *   - Worker runtime, D1 persistence (schema + constraint + isolation
 *     behavior), Better Auth session mechanics via the stub provider:
 *     LOCAL VERIFIED (real workerd, real SQLite-backed D1).
 *   - The OAuth provider endpoints are a stub inside this test process, so
 *     the sign-in flows used to obtain session cookies are SIMULATED at the
 *     provider boundary (same classification as P01).
 *
 * The fixture worker entry is tests/fixtures/projects.ts; it mounts the SAME
 * production composition app.ts mounts at /api plus /__test/* control routes
 * that are compiled into the fixture only and are never part of the app
 * Worker.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const FIXTURE_ENTRY = join(REPO_ROOT, 'tests', 'fixtures', 'projects.ts');
const MIGRATION_PATH = join(REPO_ROOT, 'apps', 'app', 'migrations', '0001_product.sql');

const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';
const SESSION_COOKIE = 'better-auth.session_token';

// --- small helpers -----------------------------------------------------------

/**
 * A currently-free loopback port (per-run allocation so a leaked workerd from
 * an earlier run can never be mistaken for this run's fixture).
 */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
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

// --- fixture worker lifecycle ---------------------------------------------------

let WORKER_PORT = 0;
let WORKER_BASE = '';


function wranglerCliPath(): string {
	// wrangler is a devDependency of apps/app; resolve without registry access.
	const resolved = Bun.resolveSync('wrangler', join(REPO_ROOT, 'apps', 'app'));
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
	extraVars: Record<string, string> = {},
): Promise<{ process: Bun.Subprocess; cleanup: () => void }> {
	const tmp = mkdtempSync(join(tmpdir(), 'caddie-p02-'));
	const config = {
		name: 'caddie-projects-fixture',
		main: FIXTURE_ENTRY,
		compatibility_date: '2026-06-01',
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: false },
		d1_databases: [
			{
				binding: 'DB',
				database_name: 'caddie-projects-fixture',
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
	const configPath = join(tmp, 'projects.wrangler.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const logFile = `/tmp/caddie-p02-projects-worker-${port}.log`;
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
		{ cwd: REPO_ROOT, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } },
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

function stopFixtureWorker(port: number) {
	// Pattern-based cleanup only (P01 lesson): matches only this suite's own
	// processes — the wrangler CLI started with our unique temp config dir,
	// and the workerd bound to exactly this run's fixture port.
	for (const signal of ['-15', '-9']) {
		Bun.spawnSync(['pkill', signal, '-f', `caddie-p02-.*projects.wrangler.json --port ${port} `]);
		Bun.spawnSync(['pkill', signal, '-f', `workerd.*entry=127.0.0.1:${port} `]);
		Bun.sleepSync(300);
	}
	rmSync(`/tmp/caddie-p02-projects-worker-${port}.log`, { force: true });
}

/** Apply the full production migration (identity + product) to the fixture D1. */
async function applyMigration(port: number): Promise<void> {
	const ddl = readFileSync(MIGRATION_PATH, 'utf8');
	const statements = ddl
		.split(/;\s*(?:\n|$)/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const res = await fetch(`http://127.0.0.1:${port}/__test/ddl`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ statements }),
	});
	if (res.status !== 200) throw new Error(`migration apply failed (${res.status}): ${await res.text()}`);
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

// --- authenticated-session helpers (P01 fixture pattern) ------------------------

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
	header(): string {
		return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
	}
	set(name: string, value: string) {
		this.map.set(name, value);
	}
}

interface StubProfile {
	sub: string;
	email: string;
	name: string;
	email_verified: boolean;
}

/** Stub OAuth2 provider (authorization endpoint, token endpoint, userinfo). */
class StubProvider {
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
	private server: import('node:http').Server | undefined;
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

function makeWorker(base: string) {
	return async (jar: Jar, path: string, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		if (jar.header()) headers.set('cookie', jar.header());
		const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${base}${path}`;
		const res = await fetch(url, { ...init, headers, redirect: 'manual' });
		jar.absorb(res);
		return res;
	};
}

let stub: StubProvider;

/** Worker fetch bound lazily after beforeAll allocates the port. */
const worker = (jar: Jar, path: string, init?: RequestInit) => makeWorker(WORKER_BASE)(jar, path, init);

/**
 * Drive the OAuth round trip exactly like a browser would (SIMULATED at the
 * provider boundary; everything after it is the real worker + real D1).
 */
async function driveOAuth(jar: Jar, provider: string, profile: StubProfile) {
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

async function signIn(email: string, sub: string, name: string): Promise<Jar> {
	const jar = new Jar();
	await driveOAuth(jar, 'google', { sub, email, name, email_verified: true });
	return jar;
}

// --- setup ---------------------------------------------------------------------

beforeAll(async () => {
	if (!existsSync(FIXTURE_ENTRY)) {
		throw new Error('fixture worker entry missing: tests/fixtures/projects.ts');
	}
	if (!existsSync(MIGRATION_PATH)) {
		throw new Error('production migration missing: apps/app/migrations/0001_product.sql');
	}
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	const main = await startFixtureWorker(WORKER_PORT, { AUTH_STUB_BASE_URL: stub.url });
	await applyMigration(WORKER_PORT);
}, 180_000);

afterAll(async () => {
	stopFixtureWorker(WORKER_PORT);
	await stub.stop();
});

// --- slice 1: product data model --------------------------------------------------

describe('P02 slice 1: product data model on real D1', () => {
	test('migration 0001_product.sql applies cleanly and creates every product table in workerd D1', async () => {
		const res = await d1Exec(
			WORKER_BASE,
			`select name from sqlite_master where type = 'table' order by name`,
		);
		const tables = (res.results as { name: string }[]).map((r) => r.name).sort();
		for (const table of [
			'workspaces',
			'workspace_memberships',
			'projects',
			'project_repo_bindings',
			'plan_doc_revisions',
			'run_bindings',
			'artifact_revisions',
		]) {
			expect(tables).toContain(table);
		}
		// the frozen identity tables are still there (same migration applied)
		for (const table of ['user', 'session', 'account', 'verification']) {
			expect(tables).toContain(table);
		}
	});

	test('membership and revision uniqueness constraints hold (one membership per user+workspace, immutable revision sequence)', async () => {
		// seed a user + workspace + membership
		await d1Exec(
			WORKER_BASE,
			`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
			 values ('ddl-user-1','DDL User','ddl-user@example.com',0,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
		);
		await d1Exec(
			WORKER_BASE,
			`insert into "workspaces" ("id","name","createdAt") values ('ddl-ws-1','DDL WS','2026-10-04T00:00:00.000Z')`,
		);
		await d1Exec(
			WORKER_BASE,
			`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
			 values ('ddl-mem-1','ddl-ws-1','ddl-user-1','owner','2026-10-04T00:00:00.000Z')`,
		);
		// duplicate membership for the same user+workspace is rejected
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
				 values ('ddl-mem-2','ddl-ws-1','ddl-user-1','member','2026-10-04T00:00:00.000Z')`,
			),
		).rejects.toThrow();

		await d1Exec(
			WORKER_BASE,
			`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
			 values ('ddl-proj-1','ddl-ws-1','DDL Project','active','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
		);
		await d1Exec(
			WORKER_BASE,
			`insert into "plan_doc_revisions" ("id","projectId","kind","revision","bodyHash","body","createdBy","createdAt")
			 values ('ddl-pdr-1','ddl-proj-1','plan',1,'sha256-abc','v1','ddl-user-1','2026-10-04T00:00:00.000Z')`,
		);
		// the same (project, kind, revision) slot is immutable — a rewrite is rejected
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "plan_doc_revisions" ("id","projectId","kind","revision","bodyHash","body","createdBy","createdAt")
				 values ('ddl-pdr-2','ddl-proj-1','plan',1,'sha256-def','v1-rewritten','ddl-user-1','2026-10-04T00:00:00.000Z')`,
			),
		).rejects.toThrow();
		// but the next revision of the same kind is accepted
		await d1Exec(
			WORKER_BASE,
			`insert into "plan_doc_revisions" ("id","projectId","kind","revision","bodyHash","body","createdBy","createdAt")
			 values ('ddl-pdr-3','ddl-proj-1','plan',2,'sha256-ghi','v2','ddl-user-1','2026-10-04T00:00:00.000Z')`,
		);
		expect(await d1Count(WORKER_BASE, 'plan_doc_revisions', "projectId = 'ddl-proj-1'")).toBe(2);
	});

	test('project repo binding is unique per project and run identity is unique', async () => {
		await d1Exec(
			WORKER_BASE,
			`insert into "project_repo_bindings" ("id","projectId","provider","owner","repo","createdAt")
			 values ('ddl-prb-1','ddl-proj-1','github','alice','rocket','2026-10-04T00:00:00.000Z')`,
		);
		// a second selected repo for the same project is rejected (one per project)
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "project_repo_bindings" ("id","projectId","provider","owner","repo","createdAt")
				 values ('ddl-prb-2','ddl-proj-1','github','alice','other','2026-10-04T00:00:00.000Z')`,
			),
		).rejects.toThrow();

		await d1Exec(
			WORKER_BASE,
			`insert into "run_bindings" ("runId","projectId","conversationId","submissionId","planRevision","stackId","payerId","modelRouteId","pricingVersion","createdBy","createdAt")
			 values ('ddl-run-1','ddl-proj-1','conv-1','sub-1','plan@2','react-hono','ddl-user-1','route-1','2026-10-04','ddl-user-1','2026-10-04T00:00:00.000Z')`,
		);
		// run identity is durable and unique: a second binding with the same runId fails
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "run_bindings" ("runId","projectId","conversationId","submissionId","planRevision","stackId","payerId","modelRouteId","pricingVersion","createdBy","createdAt")
				 values ('ddl-run-1','ddl-proj-1','conv-2','sub-2','plan@2','react-hono','ddl-user-1','route-1','2026-10-04','ddl-user-1','2026-10-04T00:00:00.000Z')`,
			),
		).rejects.toThrow();
		// stackId is constrained to the five contract stacks
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "run_bindings" ("runId","projectId","conversationId","submissionId","planRevision","stackId","payerId","modelRouteId","pricingVersion","createdBy","createdAt")
				 values ('ddl-run-2','ddl-proj-1','conv-3','sub-3','plan@2','nextjs-mystery','ddl-user-1','route-1','2026-10-04','ddl-user-1','2026-10-04T00:00:00.000Z')`,
			),
		).rejects.toThrow();
	});

	test('projects are workspace-owned and foreign keys bind product rows to identity rows', async () => {
		// a project without its workspace row is rejected
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
				 values ('ddl-proj-orphan','ddl-ws-missing','Orphan','active','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
			),
		).rejects.toThrow();
		// a run binding must point at a real project
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "run_bindings" ("runId","projectId","conversationId","submissionId","planRevision","stackId","payerId","modelRouteId","pricingVersion","createdBy","createdAt")
				 values ('ddl-run-orphan','ddl-proj-missing','conv','sub','plan@1','react-hono','ddl-user-1','route','2026-10-04','ddl-user-1','2026-10-04T00:00:00.000Z')`,
			),
		).rejects.toThrow();
		// archived is a status, not a deletion: the column accepts exactly the two states
		await d1Exec(
			WORKER_BASE,
			`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
			 values ('ddl-proj-arch','ddl-ws-1','Archived Project','archived','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
		);
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
				 values ('ddl-proj-bad','ddl-ws-1','Bad Status','deleted-forever','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
			),
		).rejects.toThrow();
	});

	test('every product index on revision/run tables leads with projectId — no latest-per-user access path can return (audit defect #2)', () => {
		const migration = readFileSync(MIGRATION_PATH, 'utf8');
		// product section = everything after the identity DDL boundary marker
		const productSection = migration.split('IDENTITY-DDL-BOUNDARY')[1] ?? '';
		const indexStatements = productSection
			.split('\n')
			.filter((line) => /^\s*create (unique )?index\b/i.test(line))
			.map((line) => line.trim().replace(/;$/, ''));
		expect(indexStatements.length).toBeGreaterThan(0);
		const scopedTables = ['plan_doc_revisions', 'run_bindings', 'artifact_revisions'];
		let checked = 0;
		for (const stmt of indexStatements) {
			const onMatch = /on\s+"([^"]+)"\s*\(([^)]+)\)/i.exec(stmt);
			if (!onMatch) continue;
			const table = onMatch[1]!;
			if (!scopedTables.includes(table)) continue;
			const cols = onMatch[2]!
				.split(',')
				.map((c) => c.trim().replaceAll('"', '').split(/\s+/)[0] ?? '');
			// latest/lookup access paths are per PROJECT (defect #2 must not travel):
			// every explicit index on revision/run tables must lead with projectId
			expect(cols[0]).toBe('projectId');
			checked++;
		}
		expect(checked).toBeGreaterThan(0);
	});
});

// --- slice 1b: shared contract schemas ----------------------------------------------

describe('P02 contracts: project domain schemas', () => {
	test('workspace, project, plan revision, run-binding record and artifact revision parse; unknown keys are rejected (strict)', () => {
		const iso = '2026-10-04T00:00:00.000Z';
		const workspace = safeParse(WorkspaceSchema, { id: 'ws_1', name: 'WS', createdAt: iso });
		expect(workspace.success).toBe(true);
		expect(
			safeParse(WorkspaceSchema, { id: 'ws_1', name: 'WS', createdAt: iso, actorId: 'x' }).success,
		).toBe(false);

		const project = safeParse(ProjectSchema, {
			id: 'proj_1',
			workspaceId: 'ws_1',
			name: 'Rocket',
			description: null,
			contestId: null,
			contestUrl: null,
			status: 'active',
			createdAt: iso,
			updatedAt: iso,
		});
		expect(project.success).toBe(true);
		// a project does not require a contest — the nullable link is optional at rest
		// (contestId stays null), and archive state is a first-class value
		expect(
			safeParse(ProjectSchema, {
				id: 'proj_1',
				workspaceId: 'ws_1',
				name: 'Rocket',
				description: null,
				contestId: 'devpost-123',
				contestUrl: 'https://www.devpost.com/software/x',
				status: 'archived',
				createdAt: iso,
				updatedAt: iso,
			}).success,
		).toBe(true);
		expect(
			safeParse(ProjectSchema, {
				id: 'proj_1',
				workspaceId: 'ws_1',
				name: 'Rocket',
				description: null,
				contestId: null,
				contestUrl: null,
				status: 'deleted',
				createdAt: iso,
				updatedAt: iso,
			}).success,
		).toBe(false);

		const planRev = safeParse(PlanDocRevisionSchema, {
			id: 'pdr_1',
			projectId: 'proj_1',
			kind: 'plan',
			revision: 1,
			bodyHash: 'sha256-abc',
			body: 'v1',
			createdBy: 'user_1',
			createdAt: iso,
		});
		expect(planRev.success).toBe(true);
		// revisions are integers
		expect(
			safeParse(PlanDocRevisionSchema, {
				id: 'pdr_1',
				projectId: 'proj_1',
				kind: 'plan',
				revision: 1.5,
				bodyHash: 'sha256-abc',
				body: 'v1',
				createdBy: 'user_1',
				createdAt: iso,
			}).success,
		).toBe(false);

		const binding = {
			runId: 'run_1',
			projectId: 'proj_1',
			conversationId: 'conv_1',
			submissionId: 'sub_1',
			planRevision: 'plan@1',
			stackId: 'react-hono',
			payerId: 'user_1',
			modelRouteId: 'route_1',
			pricingVersion: '2026-10',
		};
		const record = safeParse(RunBindingRecordSchema, {
			...binding,
			createdBy: 'user_1',
			createdAt: iso,
		});
		expect(record.success).toBe(true);
		// the record mirrors the frozen RunBinding contract: every field the
		// contract requires is present with the same shape
		expect(safeParse(RunBindingSchema, binding).success).toBe(true);
		// ...and a run binding without its project link is invalid
		expect(
			safeParse(RunBindingRecordSchema, {
				runId: 'run_1',
				conversationId: 'conv_1',
				submissionId: 'sub_1',
				planRevision: 'plan@1',
				stackId: 'react-hono',
				payerId: 'user_1',
				modelRouteId: 'route_1',
				pricingVersion: '2026-10',
				createdBy: 'user_1',
				createdAt: iso,
			}).success,
		).toBe(false);

		const artifact = safeParse(ArtifactRevisionSchema, {
			id: 'art_1',
			projectId: 'proj_1',
			artifactId: 'artifact_1',
			kind: 'preview',
			revision: 1,
			metadataHash: 'sha256-abc',
			metadata: '{"url":"/preview"}',
			createdBy: 'user_1',
			createdAt: iso,
		});
		expect(artifact.success).toBe(true);
		// strict: no extra authorization-ish fields can ride through a contract
		expect(
			safeParse(ArtifactRevisionSchema, {
				id: 'art_1',
				projectId: 'proj_1',
				artifactId: 'artifact_1',
				kind: 'preview',
				revision: 1,
				metadataHash: 'sha256-abc',
				metadata: '{}',
				createdBy: 'user_1',
				createdAt: iso,
				ownerId: 'user_2',
			}).success,
		).toBe(false);
	});

	test('iso timestamps are validated, free-form strings are rejected', () => {
		expect(
			safeParse(WorkspaceSchema, { id: 'ws_1', name: 'WS', createdAt: 'whenever' }).success,
		).toBe(false);
	});
});

// --- slice 2: scope enforcement (unit, in-process sqlite) -----------------------------

/**
 * The production migration applied to an in-memory sqlite database (the same
 * schema the fixture proves on real D1 above). Services are exercised directly
 * here so the scope contract — missing scope THROWS, scope is re-verified
 * against D1 — is proven at the unit level, independent of HTTP plumbing.
 */
function wrapSqliteAsD1(sqlite: Database): D1Database {
	return {
		prepare: (query: string) => {
			const stmt = sqlite.prepare(query);
			return {
				bind: (...values: unknown[]) => ({
					run: async () => stmt.run(...(values as never[])),
					// meta mirrors the real D1 shape (better-auth's D1 dialect reads
					// results.meta); changes is only used for optional affected-rows
					// bookkeeping, which these tests never rely on.
					all: async () => ({
						results: stmt.all(...(values as never[])) as unknown[],
						meta: {},
					}),
				}),
				run: async () => stmt.run(),
				all: async () => ({ results: stmt.all() as unknown[], meta: {} }),
			};
		},
		batch: async (statements: unknown[]) => {
			const out: unknown[] = [];
			for (const statement of statements as { run(): unknown }[]) {
				out.push(await statement.run());
			}
			return out;
		},
		exec: async (query: string) => sqlite.exec(query),
	} as unknown as D1Database;
}

describe('P02 slice 2: scope enforcement and project services (unit)', () => {
	let sqlite: Database;
	let db: D1Database;
	// Populated by the setup test below; later tests depend on the ordering,
	// which bun preserves within a describe block.
	let unitWsId = '';
	let unitProjectAId = '';
	let unitProjectBId = '';

	const unitEnv: AuthEnv = {
		DB: null as unknown as D1Database,
		BETTER_AUTH_SECRET: 'unit-secret-0123456789abcdef0123456789abcdef',
		BETTER_AUTH_URL: 'http://127.0.0.1:1',
	};

	beforeAll(() => {
		sqlite = new Database(':memory:');
		sqlite.exec('PRAGMA foreign_keys = ON;');
		sqlite.exec(readFileSync(MIGRATION_PATH, 'utf8'));
		db = wrapSqliteAsD1(sqlite);
		unitEnv.DB = db;
		sqlite.exec(
			`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
			 values ('unit-alice','Unit Alice','unit-alice@example.com',0,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
		);
		sqlite.exec(
			`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
			 values ('unit-bob','Unit Bob','unit-bob@example.com',0,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
		);
	});

	test('missing session throws ScopeError 401: no scope may be derived without a verified session', async () => {
		// real better-auth getSession over the production code path, no cookie
		await expect(requireProjectScope(db, unitEnv, new Headers(), 'proj_any')).rejects.toMatchObject(
			{ status: 401, code: 'unauthenticated' },
		);
	}, 20_000);

	test('missing session on the workspace path throws 401 as well', async () => {
		await expect(requireWorkspaceScope(db, unitEnv, new Headers(), 'ws_any')).rejects.toMatchObject(
			{ status: 401, code: 'unauthenticated' },
		);
	});

	test('workspace creation binds the creator as owner; project creation requires a membership-derived scope', async () => {
		const ws = await projectsService.createWorkspace(db, 'unit-alice', { name: 'Unit WS' });
		expect(ws.id).toBeTruthy();
		unitWsId = ws.id;

		const projA = await projectsService.createProject(
			db,
			{ actorId: 'unit-alice', workspaceId: unitWsId },
			{ workspaceId: unitWsId, name: 'Unit Rocket' },
		);
		expect(projA.workspaceId).toBe(unitWsId);
		unitProjectAId = projA.id;

		// creating a project with a scope that does not match the body workspace fails
		await expect(
			projectsService.createProject(
				db,
				{ actorId: 'unit-alice', workspaceId: unitWsId },
				{ workspaceId: 'ws-somewhere-else', name: 'Smuggled' },
			),
		).rejects.toMatchObject({ status: 403 });
	});

	test('membership is required for scope: a non-member actor gets 403 on workspace and project paths', async () => {
		await expect(workspaceScopeForUser(db, 'unit-bob', unitWsId)).rejects.toMatchObject({
			status: 403,
			code: 'not_a_member',
		});
		// bob fabricates a full scope triple for alice's project — the service
		// re-verifies against D1 and rejects the fabricated actor
		await expect(
			projectsService.getProject(db, {
				actorId: 'unit-bob',
				workspaceId: unitWsId,
				projectId: unitProjectAId,
			}),
		).rejects.toMatchObject({ status: 403, code: 'not_a_member' });
		await expect(projectScopeForUser(db, 'unit-bob', unitProjectAId)).rejects.toMatchObject({
			status: 403,
			code: 'not_a_member',
		});
	});

	test('scope is re-verified against D1: unknown projects 404, tampered workspace binding 403', async () => {
		await expect(
			projectsService.getProject(db, {
				actorId: 'unit-alice',
				workspaceId: unitWsId,
				projectId: 'proj_missing',
			}),
		).rejects.toMatchObject({ status: 404, code: 'project_not_found' });
		// scope claims a workspace the project does not live in
		await expect(
			projectsService.getProject(db, {
				actorId: 'unit-alice',
				workspaceId: 'ws_other',
				projectId: unitProjectAId,
			}),
		).rejects.toMatchObject({ status: 403, code: 'project_out_of_scope' });
	});

	test('missing scope arguments THROW — services never silently succeed scope-less', async () => {
		const undefinedScope = undefined as unknown as Parameters<
			typeof projectsService.getProject
		>[1];
		await expect(
			projectsService.getProject(db, undefinedScope),
		).rejects.toMatchObject({ code: 'missing_scope' });
		await expect(
			projectsService.createProject(db, undefinedScope, {
				workspaceId: unitWsId,
				name: 'No Scope',
			}),
		).rejects.toMatchObject({ code: 'missing_scope' });
		await expect(
			projectsService.listProjectsInWorkspace(db, undefinedScope),
		).rejects.toMatchObject({ code: 'missing_scope' });
		await expect(
			projectsService.createPlanDocRevision(db, undefinedScope, { kind: 'plan', body: 'x' }),
		).rejects.toMatchObject({ code: 'missing_scope' });
		await expect(projectsService.archiveProject(db, undefinedScope)).rejects.toMatchObject({
			code: 'missing_scope',
		});
	});

	test('scope derivation takes workspaceId from the PROJECT row, never from caller input', async () => {
		const projB = await projectsService.createProject(
			db,
			{ actorId: 'unit-bob', workspaceId: '' as string },
			// bob creates his own workspace through the service first
			{ workspaceId: '', name: 'ignored' },
		).catch(() => null);
		// the deliberately-invalid create above must have failed, not half-succeeded
		expect(projB).toBeNull();
		const bobWs = await projectsService.createWorkspace(db, 'unit-bob', { name: 'Bob WS' });
		const bobProj = await projectsService.createProject(
			db,
			{ actorId: 'unit-bob', workspaceId: bobWs.id },
			{ workspaceId: bobWs.id, name: 'Bob Satellite' },
		);
		unitProjectBId = bobProj.id;
		const scope = await projectScopeForUser(db, 'unit-bob', unitProjectBId);
		expect(scope).toEqual({
			actorId: 'unit-bob',
			workspaceId: bobWs.id,
			projectId: unitProjectBId,
		});
	});

	test('plan-doc revisions number per (project, kind); latest is per project, never per user', async () => {
		const aliceScope = {
			actorId: 'unit-alice',
			workspaceId: unitWsId,
			projectId: unitProjectAId,
		};
		const a1 = await projectsService.createPlanDocRevision(db, aliceScope, {
			kind: 'plan',
			body: 'A v1',
		});
		const a2 = await projectsService.createPlanDocRevision(db, aliceScope, {
			kind: 'plan',
			body: 'A v2',
		});
		expect(a1.revision).toBe(1);
		expect(a2.revision).toBe(2);

		// bob's project has its own independent sequence
		const bobScope = {
			actorId: 'unit-bob',
			workspaceId: (await projectScopeForUser(db, 'unit-bob', unitProjectBId)).workspaceId,
			projectId: unitProjectBId,
		};
		const b1 = await projectsService.createPlanDocRevision(db, bobScope, {
			kind: 'plan',
			body: 'B v1',
		});
		expect(b1.revision).toBe(1);

		const aliceList = await projectsService.listPlanDocRevisions(db, aliceScope, 'plan');
		expect(aliceList.map((r) => r.body)).toEqual(['A v2', 'A v1']);
		const bobList = await projectsService.listPlanDocRevisions(db, bobScope, 'plan');
		expect(bobList.map((r) => r.body)).toEqual(['B v1']);
		// no cross-project bleed in either direction
		expect(JSON.stringify(aliceList)).not.toContain('B v1');
		expect(JSON.stringify(bobList)).not.toContain('A v');
	});

	test('run bindings store the scope project at creation; lookups go by the stored project', async () => {
		const aliceScope = {
			actorId: 'unit-alice',
			workspaceId: unitWsId,
			projectId: unitProjectAId,
		};
		const record = await projectsService.createRunBinding(db, aliceScope, {
			conversationId: 'conv_unit_1',
			submissionId: 'sub_unit_1',
			planRevision: 'plan@2',
			stackId: 'react-hono',
			payerId: 'unit-alice',
			modelRouteId: 'route_unit',
			pricingVersion: '2026-10',
		});
		// projectId comes from the scope, not from any input (no such input exists)
		expect(record.projectId).toBe(unitProjectAId);
		expect(record.runId).toBeTruthy();

		// lookup under the stored project succeeds for a member...
		expect(await projectsService.getRunBinding(db, aliceScope, record.runId)).toMatchObject({
			runId: record.runId,
		});
		// ...and returns NOTHING when addressed from another project — even the
		// same actor with a different project scope (no active-project inference)
		const aliceOnBobProject = {
			actorId: 'unit-alice',
			workspaceId: unitWsId,
			projectId: unitProjectAId,
		};
		expect(aliceOnBobProject.projectId).toBe(unitProjectAId);
		const bobScope = await projectScopeForUser(db, 'unit-bob', unitProjectBId);
		expect(await projectsService.getRunBinding(db, bobScope, record.runId)).toBeNull();
		// listing a project's runs never shows another project's runs
		expect(await projectsService.listRunBindings(db, bobScope)).toEqual([]);

		// a client-supplied duplicate runId collides into a typed 409 — the
		// unique key elects no second owner and no silent overwrite happens
		const explicit = await projectsService.createRunBinding(db, aliceScope, {
			runId: 'run_explicit_1',
			conversationId: 'conv_unit_2',
			submissionId: 'sub_unit_2',
			planRevision: 'plan@2',
			stackId: 'react-hono',
			payerId: 'unit-alice',
			modelRouteId: 'route_unit',
			pricingVersion: '2026-10',
		});
		expect(explicit.runId).toBe('run_explicit_1');
		let conflict: { status: number; code: string } | null = null;
		try {
			await projectsService.createRunBinding(db, aliceScope, {
				runId: 'run_explicit_1',
				conversationId: 'conv_unit_3',
				submissionId: 'sub_unit_3',
				planRevision: 'plan@2',
				stackId: 'react-hono',
				payerId: 'unit-alice',
				modelRouteId: 'route_unit',
				pricingVersion: '2026-10',
			});
		} catch (error) {
			conflict = {
				status: (error as { status?: number }).status ?? 0,
				code: (error as { code?: string }).code ?? '',
			};
		}
		expect(conflict).toMatchObject({ status: 409, code: 'run_id_conflict' });
	});

	test('artifact revisions are project-scoped and revisioned per artifact', async () => {
		const aliceScope = {
			actorId: 'unit-alice',
			workspaceId: unitWsId,
			projectId: unitProjectAId,
		};
		const artifact = await projectsService.createArtifactRevision(db, aliceScope, {
			kind: 'preview',
			metadata: '{"url":"/preview/unit"}',
		});
		expect(artifact.projectId).toBe(unitProjectAId);
		const again = await projectsService.createArtifactRevision(db, aliceScope, {
			artifactId: artifact.artifactId,
			kind: 'preview',
			metadata: '{"url":"/preview/unit-v2"}',
		});
		expect(again.revision).toBe(2);
		const list = await projectsService.listArtifactRevisions(db, aliceScope, artifact.artifactId);
		expect(list.map((a) => a.revision)).toEqual([2, 1]);
	});

	test('update and archive are project-scoped transitions; workspace ownership is immutable', async () => {
		const aliceScope = {
			actorId: 'unit-alice',
			workspaceId: unitWsId,
			projectId: unitProjectAId,
		};
		const updated = await projectsService.updateProject(db, aliceScope, { name: 'Unit Rocket II' });
		expect(updated.name).toBe('Unit Rocket II');
		expect(updated.workspaceId).toBe(unitWsId);
		// strict input: a workspace move cannot ride through an update
		await expect(
			projectsService.updateProject(db, aliceScope, {
				workspaceId: 'ws_smuggled',
			} as never),
		).rejects.toMatchObject({ status: 400 });
		const archived = await projectsService.archiveProject(db, aliceScope);
		expect(archived.status).toBe('archived');
		// a second archive is idempotent state, still archived
		expect((await projectsService.archiveProject(db, aliceScope)).status).toBe('archived');
	});
});

// --- slice 3: project isolation over real HTTP sessions -------------------------------

/**
 * Every test here drives the REAL production composition in REAL workerd with
 * REAL authenticated sessions (stub OAuth provider = SIMULATED provider
 * boundary, exactly like P01). Acceptance: two users / two projects cannot
 * list, read, update or archive each other's records, artifact metadata or
 * run identifiers; switching projects never mixes latest plan docs; missing
 * scope fails loudly instead of silently succeeding.
 */
describe('P02 slice 3: project isolation over real workerd HTTP sessions', () => {
	// Populated by the setup test (bun runs tests in declaration order).
	let jarA: Jar;
	let jarB: Jar;
	let wsA = '';
	let wsB = '';
	let projA = '';
	let projA2 = '';
	let projB = '';
	let aliceRunId = '';

	const jsonHeaders = { 'content-type': 'application/json' } as const;

	test('both users sign in through the real worker OAuth flow and hold distinct sessions', async () => {
		jarA = await signIn(ALICE_EMAIL, 'alice-sub', 'Alice');
		jarB = await signIn(BOB_EMAIL, 'bob-sub', 'Bob');
		expect(jarA.header()).toContain(SESSION_COOKIE);
		expect(jarB.header()).toContain(SESSION_COOKIE);
		expect(jarA.header()).not.toBe(jarB.header());
	});

	test('each user creates a workspace (owner membership) and projects stay inside it', async () => {
		const resA = await worker(jarA, '/api/workspaces', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ name: 'Alice Hangar' }),
		});
		expect(resA.status).toBe(201);
		wsA = ((await resA.json()) as { workspace: { id: string } }).workspace.id;
		const resB = await worker(jarB, '/api/workspaces', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ name: 'Bob Hangar' }),
		});
		expect(resB.status).toBe(201);
		wsB = ((await resB.json()) as { workspace: { id: string } }).workspace.id;
		expect(wsA).not.toBe(wsB);

		const projRes = await worker(jarA, '/api/projects', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsA, name: 'Alice Rocket' }),
		});
		expect(projRes.status).toBe(201);
		projA = ((await projRes.json()) as { project: { id: string } }).project.id;

		// optional contest link: nullable when absent, settable later
		const projRes2 = await worker(jarA, '/api/projects', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsA, name: 'Alice Sidecar' }),
		});
		projA2 = ((await projRes2.json()) as { project: { id: string } }).project.id;
		const contest = await worker(jarA, `/api/projects/${projA2}`, {
			method: 'PATCH',
			headers: jsonHeaders,
			body: JSON.stringify({ contestId: 'devpost-42', contestUrl: 'https://www.devpost.com/software/sidecar' }),
		});
		expect(contest.status).toBe(200);
		expect(((await contest.json()) as { project: { contestId: string | null } }).project.contestId).toBe(
			'devpost-42',
		);

		const projResB = await worker(jarB, '/api/projects', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsB, name: 'Bob Satellite' }),
		});
		expect(projResB.status).toBe(201);
		projB = ((await projResB.json()) as { project: { id: string } }).project.id;
		expect(projA).not.toBe(projB);
	});

	test('list is scoped to memberships: alice never sees bob rows and vice versa (zero cross rows leaked)', async () => {
		const aliceList = await worker(jarA, '/api/projects');
		expect(aliceList.status).toBe(200);
		const aliceBody = JSON.stringify(await aliceList.json());
		expect(aliceBody).toContain(projA);
		expect(aliceBody).toContain(projA2);
		expect(aliceBody).not.toContain(projB);
		expect(aliceBody).not.toContain('Bob Satellite');
		expect(aliceBody).not.toContain('Bob Hangar');
		expect(aliceBody).not.toContain('DDL Project'); // seed rows have no membership: invisible

		const bobList = await worker(jarB, '/api/projects');
		const bobBody = JSON.stringify(await bobList.json());
		expect(bobBody).toContain(projB);
		expect(bobBody).not.toContain(projA);
		expect(bobBody).not.toContain('Alice Rocket');

		// workspace-scoped listing requires membership of THAT workspace
		const bobOnWsA = await worker(jarB, `/api/projects?workspaceId=${wsA}`);
		expect(bobOnWsA.status).toBe(403);
		const aliceOnWsB = await worker(jarA, `/api/projects?workspaceId=${wsB}`);
		expect(aliceOnWsB.status).toBe(403);
		const aliceOnWsA = await worker(jarA, `/api/projects?workspaceId=${wsA}`);
		expect(aliceOnWsA.status).toBe(200);
		const wsAList = JSON.stringify(await aliceOnWsA.json());
		expect(wsAList).toContain('Alice Rocket');
		expect(wsAList).not.toContain('Bob Satellite');
	});

	test('read is membership-scoped: 403 across users, 200 within, 404 for unknown projects', async () => {
		const cross = await worker(jarB, `/api/projects/${projA}`);
		expect(cross.status).toBe(403);
		const own = await worker(jarA, `/api/projects/${projA}`);
		expect(own.status).toBe(200);
		expect(((await own.json()) as { project: { name: string } }).project.name).toBe('Alice Rocket');
		const missing = await worker(jarA, '/api/projects/proj_does_not_exist');
		expect(missing.status).toBe(404);
	});

	test('update and archive are denied across users and never touch the victim row', async () => {
		const crossUpdate = await worker(jarB, `/api/projects/${projA}`, {
			method: 'PATCH',
			headers: jsonHeaders,
			body: JSON.stringify({ name: 'Bob Was Here' }),
		});
		expect(crossUpdate.status).toBe(403);
		const crossArchive = await worker(jarB, `/api/projects/${projA}/archive`, { method: 'POST' });
		expect(crossArchive.status).toBe(403);

		// database truth: the denied writes changed nothing
		const rows = await d1Exec(WORKER_BASE, `select "name", "status" from "projects" where "id" = '${projA}'`);
		const row = rows.results[0] as { name: string; status: string };
		expect(row.name).toBe('Alice Rocket');
		expect(row.status).toBe('active');

		// a body-supplied workspace move cannot ride through update (strict contract)
		const smuggle = await worker(jarA, `/api/projects/${projA}`, {
			method: 'PATCH',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsB }),
		});
		expect(smuggle.status).toBe(400);

		// own update + own archive work, and archive keeps the row readable
		const ownUpdate = await worker(jarA, `/api/projects/${projA}`, {
			method: 'PATCH',
			headers: jsonHeaders,
			body: JSON.stringify({ description: 'first stage recovery' }),
		});
		expect(ownUpdate.status).toBe(200);
		const ownArchive = await worker(jarA, `/api/projects/${projA2}/archive`, { method: 'POST' });
		expect(ownArchive.status).toBe(200);
		expect(((await ownArchive.json()) as { project: { status: string } }).project.status).toBe('archived');
		const stillReadable = await worker(jarA, `/api/projects/${projA2}`);
		expect(stillReadable.status).toBe(200);
	});

	test('plan-doc revisions: latest is per PROJECT — A/B switching never mixes them', async () => {
		const r1 = await worker(jarA, `/api/projects/${projA}/plan-docs`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ kind: 'plan', body: 'PA plan v1' }),
		});
		expect(r1.status).toBe(201);
		expect(((await r1.json()) as { revision: { revision: number } }).revision.revision).toBe(1);
		const r2 = await worker(jarA, `/api/projects/${projA}/plan-docs`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ kind: 'plan', body: 'PA plan v2' }),
		});
		expect(((await r2.json()) as { revision: { revision: number } }).revision.revision).toBe(2);

		// same actor, her OTHER project: independent sequence and independent latest
		const ra2 = await worker(jarA, `/api/projects/${projA2}/plan-docs`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ kind: 'plan', body: 'PA2 plan v1' }),
		});
		expect(ra2.status).toBe(201);
		// bob's project: independent sequence, starts at 1
		const rb = await worker(jarB, `/api/projects/${projB}/plan-docs`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ kind: 'plan', body: 'PB plan v1' }),
		});
		expect(((await rb.json()) as { revision: { revision: number } }).revision.revision).toBe(1);

		// latest for each project, checked while "switching" between them
		const latestA = await worker(jarA, `/api/projects/${projA}/plan-docs?kind=plan`);
		expect(latestA.status).toBe(200);
		const aPayload = (await latestA.json()) as {
			revisions: { body: string }[];
			latest: { body: string } | null;
		};
		expect(aPayload.latest?.body).toBe('PA plan v2');
		expect(aPayload.revisions.map((r) => r.body)).toEqual(['PA plan v2', 'PA plan v1']);
		expect(JSON.stringify(aPayload)).not.toContain('PB plan v1');

		const latestA2 = await worker(jarA, `/api/projects/${projA2}/plan-docs?kind=plan`);
		const a2Payload = (await latestA2.json()) as { latest: { body: string } | null };
		expect(a2Payload.latest?.body).toBe('PA2 plan v1');

		const latestB = await worker(jarB, `/api/projects/${projB}/plan-docs?kind=plan`);
		const bPayload = (await latestB.json()) as {
			revisions: { body: string }[];
			latest: { body: string } | null;
		};
		expect(bPayload.latest?.body).toBe('PB plan v1');
		expect(JSON.stringify(bPayload)).not.toContain('PA plan');

		// cross-project plan-doc reads are denied outright
		const crossRead = await worker(jarB, `/api/projects/${projA}/plan-docs?kind=plan`);
		expect(crossRead.status).toBe(403);
	});

	test('run identifiers are isolated: bindings store their project and lookups go by the stored project', async () => {
		const created = await worker(jarA, `/api/projects/${projA}/run-bindings`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				conversationId: 'conv-iso-1',
				submissionId: 'sub-iso-1',
				planRevision: 'plan@2',
				stackId: 'react-hono',
				payerId: 'alice',
				modelRouteId: 'route-iso',
				pricingVersion: '2026-10',
			}),
		});
		expect(created.status).toBe(201);
		const record = (await created.json()) as { runBinding: { runId: string; projectId: string } };
		aliceRunId = record.runBinding.runId;
		// projectId is server-derived from the scope — the payload has no such field
		expect(record.runBinding.projectId).toBe(projA);

		// a smuggled projectId key in the body is rejected by the strict contract
		const smuggled = await worker(jarA, `/api/projects/${projA}/run-bindings`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				conversationId: 'conv-smuggle',
				submissionId: 'sub-smuggle',
				planRevision: 'plan@2',
				stackId: 'react-hono',
				payerId: 'alice',
				modelRouteId: 'route-iso',
				pricingVersion: '2026-10',
				projectId: projB,
			}),
		});
		expect(smuggled.status).toBe(400);

		// the owning member finds the run under the stored project
		const ownerRead = await worker(jarA, `/api/projects/${projA}/run-bindings/${aliceRunId}`);
		expect(ownerRead.status).toBe(200);
		// bob cannot see it under HIS project (404: not his project's run) ...
		const crossStored = await worker(jarB, `/api/projects/${projB}/run-bindings/${aliceRunId}`);
		expect(crossStored.status).toBe(404);
		// ...nor under alice's project (403: not his membership)
		const crossDirect = await worker(jarB, `/api/projects/${projA}/run-bindings/${aliceRunId}`);
		expect(crossDirect.status).toBe(403);
		// and bob's run listing never contains alice's run identifier
		const bobRuns = await worker(jarB, `/api/projects/${projB}/run-bindings`);
		expect(bobRuns.status).toBe(200);
		const bobRunBody = JSON.stringify(await bobRuns.json());
		expect(bobRunBody).not.toContain(aliceRunId);
	});

	test('artifact metadata is isolated per project', async () => {
		const bobArtifact = await worker(jarB, `/api/projects/${projB}/artifacts`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ kind: 'preview', metadata: '{"url":"/preview/bob-only"}' }),
		});
		expect(bobArtifact.status).toBe(201);
		const bobRecord = (await bobArtifact.json()) as { artifact: { artifactId: string; projectId: string } };
		expect(bobRecord.artifact.projectId).toBe(projB);

		// alice's project shows no bob artifact rows at all
		const aliceArtifacts = await worker(jarA, `/api/projects/${projA}/artifacts`);
		expect(aliceArtifacts.status).toBe(200);
		const aliceArtifactBody = JSON.stringify(await aliceArtifacts.json());
		expect(aliceArtifactBody).not.toContain(bobRecord.artifact.artifactId);
		expect(aliceArtifactBody).not.toContain('/preview/bob-only');
		// direct read of bob's artifact metadata is denied
		const crossRead = await worker(jarA, `/api/projects/${projB}/artifacts`);
		expect(crossRead.status).toBe(403);
		// bob still sees his own artifact
		const bobList = await worker(jarB, `/api/projects/${projB}/artifacts`);
		expect(JSON.stringify(await bobList.json())).toContain(bobRecord.artifact.artifactId);
	});

	test('missing scope fails loudly at the route: no session is 401, never silent success', async () => {
		const noCookieJar = new Jar();
		const createNoSession = await worker(noCookieJar, '/api/projects', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsA, name: 'Ghost Project' }),
		});
		expect(createNoSession.status).toBe(401);
		const createBody = (await createNoSession.json()) as { error?: string };
		expect(createBody.error).toBe('unauthenticated');
		// database truth: nothing was written without a scope
		expect(await d1Count(WORKER_BASE, 'projects', "name = 'Ghost Project'")).toBe(0);

		const garbageCookieJar = new Jar();
		garbageCookieJar.set(SESSION_COOKIE, 'forged-token-value');
		const garbage = await worker(garbageCookieJar, '/api/projects');
		expect(garbage.status).toBe(401);

		const readNoSession = await worker(noCookieJar, `/api/projects/${projA}`);
		expect(readNoSession.status).toBe(401);
		const workspaceNoSession = await worker(noCookieJar, '/api/workspaces', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ name: 'Ghost WS' }),
		});
		expect(workspaceNoSession.status).toBe(401);
		expect(await d1Count(WORKER_BASE, 'workspaces', "name = 'Ghost WS'")).toBe(0);

		// membership of another workspace is 403, not 404 — and leaks no rows
		const bobOnAProject = await worker(jarB, `/api/projects/${projA}`);
		expect(bobOnAProject.status).toBe(403);
	});
});
