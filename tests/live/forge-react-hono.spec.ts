import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * P09 live journey — the complete React+Hono build proof against the REAL
 * sandbox. BLOCKED without owner credentials and explicit authorization;
 * this spec fails loudly and never silently passes.
 *
 * When authorized (CADDIE_LIVE_AUTHORIZED=1), this spec drives
 * scripts/run-journey.ts — the runner that executes every acceptance-manifest
 * phase in the live contree sandbox (seed → install → seeded tests → build →
 * deliberate red → repair → server-start → artifact export → browser-check)
 * and asserts machine-checked evidence for each. Model-driven coordinator
 * phases (brief→plan→specialists) require the Flue DO dev-server integration
 * and are recorded by the runner as a limitation, not simulated.
 */

const hasLiveEnv = process.env.CADDIE_LIVE_AUTHORIZED === '1';

describe('P09 live React+Hono journey (BLOCKED without credentials)', () => {
	test('live authorization is explicit', () => {
		if (!hasLiveEnv) {
			throw new Error(
				'BLOCKED: the P09 live journey requires CADDIE_LIVE_AUTHORIZED=1, CONTREE_* sandbox credentials and NEBIUS_API_KEY. ' +
					'The journey runner (scripts/run-journey.ts) executes the acceptance manifest phases; this suite never runs against mocks.',
			);
		}
		expect(hasLiveEnv).toBe(true);
	});

	test(
		'the journey runner completes every manifest phase with real evidence',
		() => {
			if (!hasLiveEnv) return; // gated above; never runs against mocks
			const proc = Bun.spawnSync(['bun', 'run', join('scripts', 'run-journey.ts')], {
				cwd: join(import.meta.dir, '..', '..'),
				stdout: 'pipe',
				stderr: 'pipe',
				env: process.env,
			});
			const output = `${proc.stdout}${proc.stderr}`;
			// The runner exits nonzero on ANY failed phase and prints per-phase
			// receipts; the live gate demands the full PASS with all phases present.
			expect(proc.exitCode, output.slice(-4000)).toBe(0);
			expect(output).toContain('run-journey: PASS');
			for (const phase of [
				'seed',
				'install',
				'seeded-tests-green',
				'build',
				'deliberate-red',
				'server-start',
				'browser-check',
				'artifact',
			]) {
				expect(output).toContain(`] ${phase} `);
			}
			expect(output).not.toContain('SIMULATED');
		},
		900_000,
	);
});
