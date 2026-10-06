import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * P15b live Laravel + React/Inertia journey — the REAL template flow behind
 * explicit toolchain gates:
 *
 *   1. CADDIE_LIVE_AUTHORIZED=1 (composer install fetches from the network —
 *      an external effect plain `bun test` never triggers),
 *   2. composer + php + npm present on PATH (the toolchains are never
 *      installed by this suite; a missing tool is a named BLOCKED),
 *
 * and only then the recipe commands for real: composer install →
 * php artisan test (disposable sqlite :memory: via RefreshDatabase — the
 * template never migrates anything durable) → npm run build →
 * php artisan serve, asserting the served Inertia page and the /up health
 * route. A phase failure fails here; nothing is mocked or simulated.
 */

const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';
const REPO = join(import.meta.dir, '..', '..', '..');
const TEMPLATE = join(REPO, 'stacks', 'laravel-inertia', 'template');
const PORT = 8798;

function missingTools(): string[] {
	const missing: string[] = [];
	for (const tool of ['composer', 'php', 'npm']) {
		if (!Bun.which(tool)) missing.push(tool);
	}
	return missing;
}

function run(argv: string[], cwd: string): { code: number; output: string } {
	const proc = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
	return { code: proc.status ?? 1, output: `${proc.stdout}${proc.stderr}` };
}

async function waitForServer(url: string, timeoutMs: number): Promise<Response> {
	const deadline = Date.now() + timeoutMs;
	let lastError = 'no attempt';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.status < 500) return res;
			lastError = `status ${res.status}`;
		} catch (error) {
			lastError = String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`php artisan serve never answered on ${url}: ${lastError}`);
}

describe('P15b live Laravel + Inertia journey (BLOCKED without toolchain/authorization)', () => {
	test('live authorization is explicit', () => {
		if (!authorized) {
			throw new Error(
				'BLOCKED: the P15b Laravel journey requires CADDIE_LIVE_AUTHORIZED=1 (composer install ' +
					'is a network effect). When authorized it probes composer/php/npm, then drives the REAL ' +
					'recipe flow (composer install, php artisan test against the disposable sqlite test DB, ' +
					'npm run build, php artisan serve). No toolchain is installed by this suite and nothing is mocked.',
			);
		}
		expect(authorized).toBe(true);
	});

	test(
		'the template installs, tests, builds and serves green (real PHP toolchain)',
		async () => {
			if (!authorized) return; // gated above
			const missing = missingTools();
			if (missing.length > 0) {
				throw new Error(
					`BLOCKED: the P15b Laravel journey needs ${missing.join(', ')} on PATH ` +
						'(or the contree sandbox image that carries them). Toolchains are never auto-installed.',
				);
			}

			const dir = mkdtempSync(join(tmpdir(), 'p15b-laravel-'));
			try {
				cpSync(TEMPLATE, dir, { recursive: true });

				const install = run(['composer', 'install', '--no-interaction'], dir);
				expect(install.code, install.output.slice(-1500)).toBe(0);
				expect(existsSync(join(dir, 'composer.lock')), 'composer.lock committed from the real install').toBe(true);

				cpSync(join(TEMPLATE, '.env.example'), join(dir, '.env'));
				expect(run(['php', 'artisan', 'key:generate'], dir).code).toBe(0);

				const tests = run(['php', 'artisan', 'test'], dir);
				expect(tests.code, tests.output.slice(-2500)).toBe(0);
				expect(tests.output).toMatch(/OK \(/); // phpunit summary line

				const clientInstall = run(['npm', 'install'], dir);
				expect(clientInstall.code, clientInstall.output.slice(-1500)).toBe(0);
				const build = run(['npm', 'run', 'build'], dir);
				expect(build.code, build.output.slice(-1500)).toBe(0);
				expect(existsSync(join(dir, 'public', 'build', 'manifest.json')), 'vite manifest for the inertia page').toBe(true);

				let server: ChildProcess | null = null;
				try {
					server = spawn('php', ['artisan', 'serve', '--port', String(PORT)], { cwd: dir, stdio: 'ignore' });
					const home = await waitForServer(`http://127.0.0.1:${PORT}/`, 30_000);
					expect(home.status).toBe(200);
					const html = await home.text();
					expect(html).toContain('data-page='); // Inertia's JSON page payload
					expect(html).toContain('Forge App');

					const up = await fetch(`http://127.0.0.1:${PORT}/up`);
					expect(up.status).toBe(200); // the framework health route
				} finally {
					server?.kill();
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		900_000,
	);
});
