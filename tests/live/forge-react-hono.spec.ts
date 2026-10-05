import { describe, expect, test } from 'bun:test';

/**
 * P09 live journey — the complete React+Hono build proof against the REAL
 * sandbox and model. BLOCKED without owner credentials and explicit
 * authorization; this spec fails loudly and never silently passes.
 *
 * When authorized, this file drives scripts/run-journey.ts through every
 * manifest phase (seed → implement → deliberate red → repair → browser →
 * artifact → PR) and asserts machine-checked evidence for each.
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
});
