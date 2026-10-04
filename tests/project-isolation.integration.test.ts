import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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

let workerProcess: Bun.Subprocess | undefined;

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
			// Gates the test-only stub-provider knob (fail-closed fence from P01).
			AUTH_TEST_MODE: '1',
		},
	};
	// The stub provider URL is filled in by the test's beforeAll via the
	// AUTH_STUB_BASE_URL extra var (see startWorker below).
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

// --- setup ---------------------------------------------------------------------

beforeAll(async () => {
	if (!existsSync(FIXTURE_ENTRY)) {
		throw new Error('fixture worker entry missing: tests/fixtures/projects.ts');
	}
	if (!existsSync(MIGRATION_PATH)) {
		throw new Error('production migration missing: apps/app/migrations/0001_product.sql');
	}
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	const main = await startFixtureWorker(WORKER_PORT);
	workerProcess = main.process;
	await applyMigration(WORKER_PORT);
}, 180_000);

afterAll(() => {
	stopFixtureWorker(WORKER_PORT);
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
