import { expect, test } from '@playwright/test';

/**
 * P17 release acceptance — LOCAL-verifiable hosted checks against the real
 * composed build (`bun run build` first): Astro landing at /, React SPA at
 * /app/, local workerd via the preview server on 127.0.0.1:4173.
 *
 * This is the locally-runnable half of P17's "Tests" row; the deployed
 * half (same checks against a hosted origin) is tests/live/release.spec.ts,
 * which stays BLOCKED until an owner-approved deployment exists. Console and
 * page errors are asserted EMPTY on every loaded surface: a release build
 * that ships broken JS or failing fetches cannot pass here.
 */

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function observe(page: {
	on(event: 'console', listener: (message: { type(): string; text(): string }) => void): unknown;
	on(event: 'pageerror', listener: (error: Error) => void): unknown;
}): void {
	// Fresh observation per test: no leakage from an earlier surface.
	consoleErrors.length = 0;
	pageErrors.length = 0;
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => pageErrors.push(String(error)));
}

test.describe('P17 release — landing and SPA over the composed build', () => {
	test('landing returns 200 with the key content', async ({ page }) => {
		observe(page);
		const res = await page.goto('/');
		expect(res?.status()).toBe(200);
		await expect(page.locator('.topbar .wordmark')).toHaveText('Caddie');
		await expect(page.locator('#pb-hero-h')).toBeVisible();
		const html = await page.content();
		expect(html).toContain('LOCKED LINE');
	});

	test('/app/ serves the SPA shell and boots without console or page errors', async ({ page }) => {
		observe(page);
		const res = await page.goto('/app/');
		expect(res?.status()).toBe(200);
		await expect(page.locator('#root')).toHaveCount(1);
		// The SPA mounts real UI (the fail-closed sign-in state signed out).
		await expect(page.locator('#root *').first()).toBeVisible();
		expect(pageErrors, 'uncaught page errors').toEqual([]);
		expect(consoleErrors, 'console errors during boot').toEqual([]);
	});

	test('the auth status endpoint answers fail-closed JSON', async ({ request }) => {
		const res = await request.get('/api/auth/status');
		expect(res.status()).toBe(200);
		expect(await res.json()).toEqual({ authenticated: false });
	});

	test('unknown /api paths answer the JSON 404 fallback (API surface alive)', async ({ request }) => {
		const res = await request.get('/api/definitely-not-a-route-p17');
		expect(res.status()).toBe(404);
		expect(await res.json()).toEqual({ error: 'not_found' });
	});

	test('the landing loads with zero console or page errors too', async ({ page }) => {
		observe(page);
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		expect(pageErrors, 'uncaught page errors').toEqual([]);
		expect(consoleErrors, 'console errors on the landing').toEqual([]);
	});
});
