import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import {
	driveOAuth,
	freePort,
	type Jar,
	type StubProvider,
} from './controls-harness.ts';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../../apps/app/src/server/auth.ts';

/**
 * P12 test-side harness: reuses the shared P03 harness primitives (free
 * ports, stub OAuth provider, cookie jar, D1 helpers) but owns its OWN fixture
 * worker entry (tests/fixtures/schedules.ts) and process-name patterns, so
 * cleanup can never touch another suite's workerd.
 *
 * It also carries the P12 UNIT world helpers (in-memory SQLite wrapped into
 * the real D1Database shape, same wrap pattern as tests/evidence.test.ts) so
 * the sentinel and schedules services can be exercised against the real DDL
 * without a workerd process.
 *
 * Test-side ONLY — nothing here is part of the app Worker.
 */

const SCHEDULES_FIXTURE_ENTRY = join(import.meta.dir, 'schedules.ts');

/** Migrations for the workerd fixture (0006 is the GitHub packet's slot; unused here). */
export function schedulesMigrationPaths(): string[] {
	const root = join(import.meta.dir, '..', '..');
	return [
		join(root, 'apps', 'app', 'migrations', '0001_product.sql'),
		join(root, 'apps', 'app', 'migrations', '0002_controls.sql'),
		join(root, 'apps', 'app', 'migrations', '0004_evidence.sql'),
		join(root, 'apps', 'app', 'migrations', '0005_runs.sql'),
		join(root, 'apps', 'app', 'migrations', '0007_schedules.sql'),
	];
}

/** Migrations for the in-memory unit world: product + evidence + P12 tables. */
export function schedulesUnitMigrationPaths(): string[] {
	const root = join(import.meta.dir, '..', '..');
	return [
		join(root, 'apps', 'app', 'migrations', '0001_product.sql'),
		join(root, 'apps', 'app', 'migrations', '0004_evidence.sql'),
		join(root, 'apps', 'app', 'migrations', '0007_schedules.sql'),
	];
}

// --- in-memory D1 (D1Database-shaped; meta.changes like real workerd D1) ----------

/**
 * Wrap bun:sqlite as the D1Database the services expect. The `run()` result
 * carries `meta.changes` exactly like real workerd D1 — the P12 occurrence
 * election reads `meta.changes` off `insert or ignore`, so the wrapper must
 * reproduce that shape, not bun's bare RunResult.
 */
export function wrapSqliteAsD1(sqlite: Database): D1Database {
	return {
		prepare: (query: string) => {
			const stmt = sqlite.prepare(query);
			const runBound = (...values: unknown[]) => {
				const result = stmt.run(...(values as never[]));
				return {
					meta: { changes: Number((result as { changes?: number }).changes ?? 0) },
				};
			};
			return {
				bind: (...values: unknown[]) => ({
					run: async () => runBound(...values),
					all: async () => ({
						results: stmt.all(...(values as never[])) as unknown[],
						meta: {},
					}),
				}),
				run: async () => runBound(),
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

export interface UnitWorld {
	db: D1Database;
	sqlite: Database;
	aliceScope: Scope;
	bobScope: Scope;
}

/**
 * A fresh in-memory database with the P12 migration set applied and two
 * independent membership-backed projects (alice's and bob's) for scope
 * assertions — the evidence.test.ts world pattern, shared.
 */
export function makeSchedulesUnitWorld(): UnitWorld {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	for (const path of schedulesUnitMigrationPaths()) {
		sqlite.exec(readFileSync(path, 'utf8'));
	}
	const iso = '2026-10-04T00:00:00.000Z';
	sqlite.exec(
		`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 values ('unit-alice','Unit Alice','unit-alice@example.com',0,'${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 values ('unit-bob','Unit Bob','unit-bob@example.com',0,'${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspaces" ("id","name","createdAt") values ('unit-ws-a','Alice WS','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
		 values ('unit-mem-a','unit-ws-a','unit-alice','owner','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspaces" ("id","name","createdAt") values ('unit-ws-b','Bob WS','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
		 values ('unit-mem-b','unit-ws-b','unit-bob','owner','${iso}')`,
	);
	sqlite.exec(
		`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
		 values ('unit-proj-a','unit-ws-a','Alice Project','active','${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
		 values ('unit-proj-b','unit-ws-b','Bob Project','active','${iso}','${iso}')`,
	);
	return {
		sqlite,
		db: wrapSqliteAsD1(sqlite),
		aliceScope: { actorId: 'unit-alice', workspaceId: 'unit-ws-a', projectId: 'unit-proj-a' },
		bobScope: { actorId: 'unit-bob', workspaceId: 'unit-ws-b', projectId: 'unit-proj-b' },
	};
}

async function catchScopeError(run: () => Promise<unknown>): Promise<{ status: number; code: string }> {
	try {
		await run();
	} catch (error) {
		return {
			status: (error as { status?: number }).status ?? 0,
			code: (error as { code?: string }).code ?? '',
		};
	}
	throw new Error('expected the call to throw a ScopeError');
}

export { catchScopeError };

// --- workerd fixture lifecycle ------------------------------------------------------

function wranglerCliPath(repoRoot: string): string {
	// wrangler is a devDependency of apps/app; resolve without registry access.
	const resolved = Bun.resolveSync('wrangler', join(repoRoot, 'apps', 'app'));
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

export interface StartedSchedulesWorker {
	port: number;
	base: string;
	cleanup: () => void;
}

export async function startSchedulesFixtureWorker(
	repoRoot: string,
	port: number,
	emails: string[],
	extraVars: Record<string, string> = {},
): Promise<StartedSchedulesWorker> {
	if (!existsSync(SCHEDULES_FIXTURE_ENTRY)) {
		throw new Error('schedules fixture worker entry missing: tests/fixtures/schedules.ts');
	}
	const tmp = mkdtempSync(join(tmpdir(), 'caddie-p12-'));
	const config = {
		name: 'caddie-schedules-fixture',
		main: SCHEDULES_FIXTURE_ENTRY,
		compatibility_date: '2026-06-01',
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: false },
		d1_databases: [
			{
				binding: 'DB',
				database_name: 'caddie-schedules-fixture',
				database_id: 'fixture-local',
			},
		],
		vars: {
			BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
			BETTER_AUTH_SECRET: 'fixture-only-secret-0123456789abcdef0123456789abcdef',
			INVITE_ALLOWLIST: emails.join(','),
			AUTH_TEST_MODE: '1',
			...extraVars,
		},
	};
	const configPath = join(tmp, 'schedules.wrangler.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const logFile = `/tmp/caddie-p12-schedules-worker-${port}.log`;
	const persistDir = join(tmp, 'state');
	const cli = wranglerCliPath(repoRoot);
	if (!existsSync(cli)) throw new Error(`wrangler CLI not found at ${cli}`);
	// Detached through a shell own-session (P00 lesson); CLI must run under node
	// (P01 lesson).
	const proc = Bun.spawn(
		[
			'/bin/bash',
			'-c',
			`exec node '${cli}' dev --config '${configPath}' --port ${port} --ip 127.0.0.1 --persist-to '${persistDir}' > '${logFile}' 2>&1`,
		],
		{
			cwd: repoRoot,
			stdout: 'ignore',
			stderr: 'ignore',
			env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
		},
	);
	void proc;
	const base = `http://127.0.0.1:${port}`;
	const notReady = await waitFor(`${base}/__test/health`, 90_000);
	if (notReady) {
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(no log)';
		throw new Error(`fixture worker failed to start: ${notReady}\nlog:\n${log}`);
	}
	const health = await fetch(`${base}/__test/health`, { signal: AbortSignal.timeout(5000) });
	const healthBody = (await health.json()) as {
		ok?: boolean;
		d1?: boolean;
		betterAuthUrl?: string;
	};
	if (!healthBody.ok || !healthBody.d1 || healthBody.betterAuthUrl !== base) {
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(no log)';
		throw new Error(
			`fixture worker identity check failed (got ${JSON.stringify(healthBody)}, want ok+d1+betterAuthUrl=${base})\nlog:\n${log}`,
		);
	}
	const cleanup = () => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// best effort
		}
	};
	return { port, base, cleanup };
}

export function stopSchedulesFixtureWorker(port: number) {
	// Pattern-based cleanup only: matches this suite's own processes (unique
	// temp config dir + workerd bound to exactly this run's fixture port).
	for (const signal of ['-15', '-9']) {
		Bun.spawnSync(['pkill', signal, '-f', `caddie-p12-.*schedules.wrangler.json --port ${port} `]);
		Bun.spawnSync(['pkill', signal, '-f', `workerd.*entry=127.0.0.1:${port} `]);
		Bun.sleepSync(300);
	}
	rmSync(`/tmp/caddie-p12-schedules-worker-${port}.log`, { force: true });
}

export { driveOAuth, freePort };
export type { Jar, StubProvider };
