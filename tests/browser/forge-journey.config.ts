import { defineConfig } from '@playwright/test';

/**
 * Dedicated Playwright config for the P09 journey browser phase.
 *
 * The ROOT config (playwright.config.ts) boots the COMPOSED Caddie app's
 * preview server — irrelevant for this phase, which exercises the seeded
 * FIXTURE app (Hono API + React client). This config boots nothing: the spec
 * itself resolves the fixture server (JOURNEY_BASE_URL set by
 * scripts/run-journey.ts, an already-running instance, or self-started).
 *
 * Invoked by scripts/run-journey.ts:
 *   bunx playwright test --config tests/browser/forge-journey.config.ts \
 *     tests/browser/forge-journey.spec.ts
 */
export default defineConfig({
	// Resolved relative to THIS config file's directory (tests/browser/).
	testDir: '.',
	timeout: 60_000,
	testMatch: /forge-journey\.spec\.ts/,
	use: {
		baseURL: process.env.JOURNEY_BASE_URL ?? 'http://127.0.0.1:8791',
	},
});
