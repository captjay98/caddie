import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * P15a live TanStack Start journey — the REAL template flow on this host's
 * Bun toolchain. This spec is runnable whenever Bun is: it scaffolds
 * stacks/tanstack-start/template into a temp dir and drives the recipe
 * commands for real (bun install → bun test src/ → bun run build →
 * bun run start), then asserts the production server actually serves the
 * SSR HTML. Network use is the package install inside the temp dir only.
 *
 * Still BLOCKED without CADDIE_LIVE_AUTHORIZED=1: an install/build/run is an
 * external effect (network fetches), so plain `bun test` never triggers it —
 * the spec fails loudly below instead. The sandbox-based acceptance phases
 * (private preview auth over the served build) remain the P09-window run.
 *
 * Honesty: every phase asserts the REAL artifact (exit code, emitted server
 * entry, HTTP response body). Nothing is mocked; a phase failure fails here.
 */

const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';
const REPO = join(import.meta.dir, '..', '..', '..');
const TEMPLATE = join(REPO, 'stacks', 'tanstack-start', 'template');
const PORT = 8797;

function run(argv: string[], cwd: string): { code: number; output: string } {
	const proc = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
	return { code: proc.status ?? 1, output: `${proc.stdout}${proc.stderr}` };
}

async function waitForServer(url: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastError = 'no attempt';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return await res.text();
			lastError = `status ${res.status}`;
		} catch (error) {
			lastError = String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`production server never answered 200 on ${url}: ${lastError}`);
}

describe('P15a live TanStack Start journey (BLOCKED without authorization)', () => {
	test('live authorization is explicit', () => {
		if (!authorized) {
			throw new Error(
				'BLOCKED: the P15a TanStack Start journey requires CADDIE_LIVE_AUTHORIZED=1. ' +
					'When authorized it drives the REAL recipe flow (bun install / bun test src/ / ' +
					'bun run build / bun run start) in a temp dir and asserts the production SSR response. ' +
					'This suite never fakes an install or a server.',
			);
		}
		expect(authorized).toBe(true);
	});

	test(
		'the template installs, tests, builds and serves green (real Bun toolchain)',
		async () => {
			if (!authorized) return; // gated above; never runs unauthorized
			const dir = mkdtempSync(join(tmpdir(), 'p15a-tanstack-'));
			try {
				cpSync(TEMPLATE, dir, { recursive: true });

				const install = run(['bun', 'install'], dir);
				expect(install.code, install.output.slice(-1500)).toBe(0);

				const tests = run(['bun', 'test', 'src/'], dir);
				expect(tests.code, tests.output.slice(-1500)).toBe(0);
				expect(tests.output).toMatch(/\d+ pass/);
				expect(tests.output).not.toContain('0 pass');

				const build = run(['bun', 'run', 'build'], dir);
				expect(build.code, build.output.slice(-1500)).toBe(0);
				expect(existsSync(join(dir, 'dist', 'server', 'server.js')), 'built server entry').toBe(true);
				expect(existsSync(join(dir, 'src', 'routeTree.gen.ts')), 'plugin generated the route tree').toBe(true);

				let server: ChildProcess | null = null;
				try {
					server = spawn('bun', ['run', 'start'], {
						cwd: dir,
						env: { ...process.env, PORT: String(PORT) },
						stdio: 'ignore',
					});
					const html = await waitForServer(`http://127.0.0.1:${PORT}/`, 30_000);
					expect(html).toContain('Forge App');
					expect(html).toContain('server says: rendered');
					expect(html).toContain('data-testid="server-state"');
				} finally {
					server?.kill();
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
