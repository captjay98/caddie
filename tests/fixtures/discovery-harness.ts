import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	Jar,
	StubProvider,
	applyMigrations,
	d1Exec,
	makeWorker,
	signIn,
	freePort,
} from './controls-harness.ts';

/**
 * P11 test-side harness: reuses the shared P03 harness primitives (free
 * ports, stub OAuth provider, cookie jar, D1 helpers) but owns its OWN
 * fixture worker entry (tests/fixtures/discovery.ts) and process-name
 * patterns, so cleanup can never touch another suite's workerd.
 *
 * Test-side ONLY — nothing here is part of the app Worker.
 */

const DISCOVERY_FIXTURE_ENTRY = join(import.meta.dir, 'discovery.ts');

export function discoveryMigrationPaths(): string[] {
	const root = join(import.meta.dir, '..', '..');
	return [
		join(root, 'apps', 'app', 'migrations', '0001_product.sql'),
		join(root, 'apps', 'app', 'migrations', '0004_evidence.sql'),
		join(root, 'apps', 'app', 'migrations', '0009_discovery.sql'),
	];
}

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

export interface StartedDiscoveryWorker {
	port: number;
	base: string;
	cleanup: () => void;
}

export async function startDiscoveryFixtureWorker(
	repoRoot: string,
	port: number,
	emails: string[],
	extraVars: Record<string, string> = {},
): Promise<StartedDiscoveryWorker> {
	if (!existsSync(DISCOVERY_FIXTURE_ENTRY)) {
		throw new Error('discovery fixture worker entry missing: tests/fixtures/discovery.ts');
	}
	const tmp = mkdtempSync(join(tmpdir(), 'caddie-p11-'));
	const config = {
		name: 'caddie-discovery-fixture',
		main: DISCOVERY_FIXTURE_ENTRY,
		compatibility_date: '2026-06-01',
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: false },
		d1_databases: [
			{
				binding: 'DB',
				database_name: 'caddie-discovery-fixture',
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
	const configPath = join(tmp, 'discovery.wrangler.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const logFile = `/tmp/caddie-p11-discovery-worker-${port}.log`;
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

export function stopDiscoveryFixtureWorker(port: number) {
	// Pattern-based cleanup only: matches this suite's own processes (unique
	// temp config dir + workerd bound to exactly this run's fixture port).
	for (const signal of ['-15', '-9']) {
		Bun.spawnSync(['pkill', signal, '-f', `caddie-p11-.*discovery.wrangler.json --port ${port} `]);
		Bun.spawnSync(['pkill', signal, '-f', `workerd.*entry=127.0.0.1:${port} `]);
		Bun.sleepSync(300);
	}
	rmSync(`/tmp/caddie-p11-discovery-worker-${port}.log`, { force: true });
}

export {
	ALICE_EMAIL,
	BOB_EMAIL,
	Jar,
	StubProvider,
	applyMigrations,
	d1Exec,
	makeWorker,
	signIn,
	freePort,
};
