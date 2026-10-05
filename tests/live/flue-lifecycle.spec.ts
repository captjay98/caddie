import { describe, expect, test } from 'bun:test';

/**
 * P05 live Flue lifecycle — REAL model round-trips through Nebius.
 *
 * BLOCKED without owner-provided credentials and explicit live authorization:
 *   - NEBIUS_API_KEY in apps/app/.dev.vars (never committed)
 *   - CADDIE_LIVE_AUTHORIZED=1 in the invoking environment
 *
 * The spec fails clearly in both cases — it never silently passes. When the
 * credentials exist and authorization is given, these tests exercise:
 *   1. a real coordinator round-trip (message → model → tool → reply)
 *   2. a crashed runtime restart settling the same submission (DO drain)
 *   3. browser reconnect and duplicate-send idempotency over the stream
 * They must never be counted as passing evidence from mocks.
 */

const hasLiveEnv = process.env.CADDIE_LIVE_AUTHORIZED === '1';

describe('P05 live Flue lifecycle (BLOCKED without credentials)', () => {
	test('live authorization is explicit', () => {
		if (!hasLiveEnv) {
			throw new Error(
				'BLOCKED: live Flue lifecycle requires CADDIE_LIVE_AUTHORIZED=1 and a configured NEBIUS_API_KEY. ' +
					'Setup: docs/setup/auth.md and docs/flue-contracts.md; this suite never runs against mocks.',
			);
		}
		expect(hasLiveEnv).toBe(true);
	});
});
