import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Caddie's /app as an installable phone app, on the real composed build in
 * local workerd (Track 2 of docs/plans/2026-10-19-pwa-flutter-apk-monetization-plan.md).
 *
 * What runs here: the files the browser installs from, the service worker in
 * Chromium (offline launch, /api never answered from a cache), and the share
 * target pre-filling the composer. What cannot run here: installing on a real
 * Android or iOS device, and the iOS status bar. Signed-in state is stubbed
 * the way shell-v2.spec.ts stubs it; that is UI evidence, not auth evidence.
 *
 * playwright.config.ts blocks service workers for every other spec (their
 * route stubs must see each request); the offline block here turns them on.
 */

// The root tsconfig omits the "dom" lib; these callbacks run in the browser.
declare const navigator: {
	serviceWorker: {
		ready: Promise<unknown>;
		controller: unknown;
		getRegistration(scope: string): Promise<{ scope: string } | undefined>;
	};
};
declare function fetch(url: string): Promise<unknown>;

const NOW = '2026-10-10T10:00:00.000Z';
const HOME = {
	id: 'home-1',
	workspaceId: 'ws-1',
	name: 'Home',
	description: null,
	contestId: null,
	contestUrl: null,
	status: 'active',
	kind: 'home',
	createdAt: NOW,
	updatedAt: NOW,
};

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** A signed-in account with only its Home conversation (mirrors shell-v2.spec.ts). */
async function stubAccount(context: BrowserContext) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada Lovelace', email: 'ada@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME] }));
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		return json(route, 200, {});
	});
}

/** Count every message POST to the conversation agent; none may happen on a share. */
async function countSends(context: BrowserContext): Promise<{ count: number }> {
	const sends = { count: 0 };
	await context.route('**/agents/**', (route) => {
		if (route.request().method() === 'POST') sends.count += 1;
		return route.fallback();
	});
	return sends;
}

const composer = (page: Page) => page.locator('textarea[aria-label="Message Caddie"]:visible');

async function shot(page: Page, name: string) {
	if (!process.env.CADDIE_SHOTS) return;
	await page.screenshot({ path: join(process.env.CADDIE_SHOTS, `${name}.png`), fullPage: false });
}

test.describe('install files', () => {
	test('the manifest is served as a manifest and every icon it names is a PNG', async ({ request }) => {
		const response = await request.get('/manifest.webmanifest');
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toMatch(/application\/(manifest\+)?json/);
		const manifest = (await response.json()) as { scope: string; icons: { src: string }[] };
		expect(manifest.scope).toBe('/app/');
		for (const src of [...manifest.icons.map((icon) => icon.src), '/apple-touch-icon.png']) {
			const icon = await request.get(src);
			expect({ src, status: icon.status(), type: icon.headers()['content-type'] }).toEqual({ src, status: 200, type: 'image/png' });
		}
	});

	test('the app shell links the manifest and fills the screen on phones', async ({ request }) => {
		const shell = await (await request.get('/app/')).text();
		expect(shell).toContain('viewport-fit=cover');
		expect(shell).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
		expect(shell).toContain('<meta name="theme-color" content="#090b10" />');
	});

	test('the service worker is stamped with this build', async ({ request }) => {
		const worker = await request.get('/sw.js');
		expect(worker.status()).toBe(200);
		expect(worker.headers()['content-type']).toContain('javascript');
		const source = await worker.text();
		expect(source).not.toContain('__CADDIE_BUILD__');
		const shell = await (await request.get('/app/')).body();
		const stamp = createHash('sha256').update(shell).digest('hex').slice(0, 12);
		expect(source).toContain(`'${stamp}'`);
	});
});

test.describe('offline launch (real service worker)', () => {
	test.use({ serviceWorkers: 'allow' });

	test('with no connection the app opens and says it is offline, not "sign in"', async ({ page, context }) => {
		await page.goto('/app/');
		await expect(page.getByTestId('sign-in-gate')).toBeVisible();
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/app/'))?.scope ?? null);
		expect(scope).toMatch(/\/app\/$/);
		await page.reload();
		await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

		await context.setOffline(true);
		let authChecks = 0;
		page.on('request', (request) => {
			if (new URL(request.url()).pathname === '/api/auth/status') authChecks += 1;
		});
		await page.reload();
		await expect(page.getByTestId('offline-launch')).toBeVisible();
		await expect(page.getByTestId('offline-launch')).toContainText('You appear to be offline');
		await expect(page.getByTestId('sign-in-gate')).toHaveCount(0);
		// One failed check, then quiet: no remount loop hammering the server.
		await page.waitForTimeout(1500);
		expect(authChecks).toBeLessThanOrEqual(2);
		// /api is never answered from a cache: the request fails like any offline call.
		const api = await page.evaluate(async () => {
			try {
				await fetch('/api/auth/status');
				return 'answered';
			} catch {
				return 'failed';
			}
		});
		expect(api).toBe('failed');
		await shot(page, 'offline-desktop');
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(page.getByTestId('offline-launch')).toBeVisible();
		await shot(page, 'offline-mobile');

		await context.setOffline(false);
		await page.getByTestId('offline-launch').getByRole('button').click();
		await expect(page.getByTestId('sign-in-gate')).toBeVisible();
		await expect(page.getByTestId('offline-launch')).toHaveCount(0);
	});
});

test.describe('a failed sign-in check', () => {
	test('a server error on the first check is asked once, not in a loop', async ({ page, context }) => {
		let authChecks = 0;
		await context.route('**/api/auth/status', (route) => {
			authChecks += 1;
			return json(route, 500, { error: 'internal_error' });
		});
		await page.goto('/app/');
		await expect(page.getByTestId('sign-in-gate')).toBeVisible();
		await page.waitForTimeout(1500);
		expect(authChecks).toBeLessThanOrEqual(2);
	});
});

test.describe('share into Caddie', () => {
	const SHARED = '/app/?shared_title=Hack%20Week&shared_url=https%3A%2F%2Fdevpost.com%2Fhack-week';

	test('a shared link lands in the composer, unsent, and leaves the address bar', async ({ page, context }) => {
		await stubAccount(context);
		const sends = await countSends(context);
		await page.goto(SHARED);
		await expect(composer(page)).toHaveCount(1);
		await expect(composer(page)).toHaveValue('Hack Week\nhttps://devpost.com/hack-week');
		expect(new URL(page.url()).search).toBe('');
		// Both lines are in view (the field grows), and the label says where it came from.
		expect(await composer(page).evaluate((field) => field.scrollHeight <= field.clientHeight)).toBe(true);
		await expect(page.locator('.composer-hint.draft-note')).toHaveText('Shared to Caddie · not sent yet');
		await page.waitForTimeout(500);
		expect(sends.count).toBe(0);
		await shot(page, 'share-desktop');
		// A reload does not add it again.
		await page.reload();
		await expect(composer(page)).toHaveValue('Hack Week\nhttps://devpost.com/hack-week');
	});

	test('what the user was already typing is kept, with the link on the next line', async ({ page, context }) => {
		await stubAccount(context);
		await page.goto('/app/');
		await composer(page).fill('Is this one a fit for me?');
		await page.goto(SHARED);
		await expect(composer(page)).toHaveValue('Is this one a fit for me?\nHack Week\nhttps://devpost.com/hack-week');
	});

	test('a link shared before signing in waits until the user is signed in', async ({ page, context }) => {
		await page.goto('/app/?shared_url=https%3A%2F%2Fdevpost.com%2Fhw');
		await expect(page.getByTestId('sign-in-gate')).toBeVisible();
		expect(new URL(page.url()).search).toBe('');
		await stubAccount(context);
		await page.goto('/app/');
		await expect(composer(page)).toHaveValue('https://devpost.com/hw');
	});

	test.describe('on a phone', () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test('the conversation opens with the shared link in the composer', async ({ page, context }) => {
			await stubAccount(context);
			const sends = await countSends(context);
			await page.goto(SHARED);
			await expect(composer(page)).toHaveValue('Hack Week\nhttps://devpost.com/hack-week');
			expect(await composer(page).evaluate((field) => field.scrollHeight <= field.clientHeight)).toBe(true);
			expect(sends.count).toBe(0);
			await shot(page, 'share-mobile');
		});

		test('an installed iPhone keeps the header below the status bar (insets simulated)', async ({ page, context }) => {
			await stubAccount(context);
			await page.goto('/app/?pane=brief');
			await page.addStyleTag({ content: ':root { --safe-top: 47px; --safe-bottom: 34px; }' });
			const header = page.getByTestId('mobile-header');
			await expect(header).toBeVisible();
			const box = await header.boundingBox();
			expect(box?.y).toBeGreaterThanOrEqual(47);
			await shot(page, 'safe-area-mobile');
		});
	});
});
