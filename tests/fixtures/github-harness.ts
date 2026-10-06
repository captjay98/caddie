import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	applyMigrations,
	d1Count,
	d1Exec,
	driveOAuth,
	freePort,
	Jar,
	makeWorker,
	signIn,
	SESSION_COOKIE,
	StubProvider,
} from './controls-harness.ts';

/**
 * P08 test harness (github suite): the P03 controls-harness pattern (free
 * ports, wrangler dev on a fixture entry, stub OAuth provider, patterned pkill
 * cleanup) with the migration set this packet needs. Test-side ONLY.
 */

export {
	ALICE_EMAIL,
	BOB_EMAIL,
	SESSION_COOKIE,
	applyMigrations,
	d1Count,
	d1Exec,
	driveOAuth,
	freePort,
	Jar,
	makeWorker,
	signIn,
	StubProvider,
} from './controls-harness.ts';

export const GITHUB_WEBHOOK_SECRET = 'p08-whsec-local-stub';
export const GITHUB_APP_ID = '4756418';
export const GITHUB_APP_INSTALLATION_A = '4756419';
export const GITHUB_APP_INSTALLATION_B = '4756420';
export const GITHUB_ACCOUNT_A = 'octocat-a';
export const GITHUB_ACCOUNT_B = 'octocat-b';
export const GITHUB_POLICY_VERSION = 'policies/2026-10-05';

export function githubMigrationPaths(): string[] {
	const root = join(import.meta.dir, '..', '..');
	return [
		join(root, 'apps', 'app', 'migrations', '0001_product.sql'),
		join(root, 'apps', 'app', 'migrations', '0002_controls.sql'),
		join(root, 'apps', 'app', 'migrations', '0006_github.sql'),
	];
}

const FIXTURE_ENTRY = join(import.meta.dir, 'github.ts');

export interface StartedGithubFixtureWorker {
	process: Bun.Subprocess;
	port: number;
	base: string;
	cleanup: () => void;
}

function wranglerCliPath(repoRoot: string): string {
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

export async function startGithubFixtureWorker(
	repoRoot: string,
	port: number,
	emails: string[],
	extraVars: Record<string, string> = {},
): Promise<StartedGithubFixtureWorker> {
	const tmp = mkdtempSync(join(tmpdir(), 'caddie-p08-'));
	const config = {
		name: 'caddie-github-fixture',
		main: FIXTURE_ENTRY,
		compatibility_date: '2026-06-01',
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: false },
		d1_databases: [
			{
				binding: 'DB',
				database_name: 'caddie-github-fixture',
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
	const configPath = join(tmp, 'github.wrangler.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const logFile = `/tmp/caddie-p08-github-worker-${port}.log`;
	const persistDir = join(tmp, 'state');
	const cli = wranglerCliPath(repoRoot);
	if (!existsSync(cli)) throw new Error(`wrangler CLI not found at ${cli}`);
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
	const base = `http://127.0.0.1:${port}`;
	const notReady = await waitFor(`${base}/__test/health`, 90_000);
	if (notReady) {
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(no log)';
		throw new Error(`fixture worker failed to start: ${notReady}\nlog:\n${log}`);
	}
	const cleanup = () => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// best effort
		}
	};
	return { process: proc, port, base, cleanup };
}

export function stopGithubFixtureWorker(port: number) {
	// Pattern-based cleanup only: matches this suite's own processes (unique temp
	// config dir + workerd bound to exactly this run's fixture port). The run's
	// worker log is intentionally KEPT in /tmp for post-run inspection.
	for (const signal of ['-15', '-9']) {
		Bun.spawnSync(['pkill', signal, '-f', `caddie-p08-.*github.wrangler.json --port ${port} `]);
		Bun.spawnSync(['pkill', signal, '-f', `workerd.*entry=127.0.0.1:${port} `]);
		Bun.sleepSync(300);
	}
}

/** Sign a webhook payload exactly the way GitHub computes the signature header. */
export function webhookSignature(secret: string, payload: string | Uint8Array): string {
	const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
	const mac = createHmac('sha256', secret).update(data).digest('hex');
	return `sha256=${mac}`;
}
