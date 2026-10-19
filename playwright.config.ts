import { defineConfig } from '@playwright/test';

/**
 * Browser specs (tests/browser/*.spec.ts) run against the real composed
 * build in local workerd. Run `bun run build` first; `bun run test:browser
 * -- Pxx` (scripts/verify-packet.ts) dispatches individual specs here.
 */
export default defineConfig({
	testDir: 'tests/browser',
	timeout: 60_000,
	use: {
		baseURL: 'http://127.0.0.1:4173',
		// The built app registers a service worker (apps/app/public/sw.js).
		// Specs stub /api with context.route, which must see every request, so
		// workers stay off; tests/browser/pwa.spec.ts turns them on to test it.
		serviceWorkers: 'block',
	},
	webServer: {
		command: 'bun --cwd=apps/app run preview -- --port 4173 --host 127.0.0.1',
		port: 4173,
		reuseExistingServer: true,
		timeout: 30_000,
	},
});
