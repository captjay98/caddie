import { expect, test } from '@playwright/test';

/**
 * P16 landing acceptance — pit-board port (plan amendment 3054ee2).
 *
 * The landing ports the existing Caddie design (run-spine composition, halo
 * tokens, amber key actions, mono type) with content updated for the fresh
 * product. Runs against the COMPOSED build (`bun run build` first): Astro
 * landing at /, React SPA at /app/, served by local workerd on 127.0.0.1:4173.
 *
 * Copy assertions intentionally mirror docs/feature-ledger.md availability:
 * no testimonials, no metrics presented as real, no build-success claims,
 * and the synthetic demo never masquerades as a live run.
 */

// The root tsconfig intentionally omits the "dom" lib (it typechecks Node and
// bun code). The callbacks below run inside the browser via page.evaluate, so
// declare the minimal surface this spec touches — module-scoped, so it never
// conflicts with a future "dom" lib addition in shared config.
declare const document: {
	documentElement: { scrollWidth: number; clientWidth: number };
	activeElement: { classList: { contains(name: string): boolean }; className: string } | null;
	querySelectorAll(selectors: string): Array<{
		id: string;
		className: string;
		getBoundingClientRect(): { right: number };
	}>;
	getAnimations(): unknown[];
};
declare function getComputedStyle(element: object): {
	outlineStyle: string;
	backgroundColor: string;
	color: string;
};

test.describe('P16 landing — pit-board shell', () => {
	test('/ returns 200 and serves meaningful content in raw HTML (no JS required)', async ({
		request,
	}) => {
		const res = await request.get('/');
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('text/html');
		const html = await res.text();
		// Static-readable: the pit-board structure ships in the HTML itself.
		expect(html).toContain('class="pb"');
		expect(html).toContain('pb-hero-h');
		expect(html).toContain('spine-rail');
		expect(html).toContain('LOCKED LINE');
		// Zero client scripts — Astro output must stay script-free.
		expect(html).not.toContain('<script');
	});

	test('topbar wordmark and section navigation render', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('.topbar .wordmark')).toHaveText('Caddie');
		const nav = page.locator('.topbar nav a');
		await expect(nav).toHaveCount(5);
		const hrefs = await nav.evaluateAll((links) =>
			links.map((a) => (a as unknown as { getAttribute(name: string): string | null }).getAttribute('href')),
		);
		expect(hrefs).toContain('#pb-discover');
		expect(hrefs).toContain('#pb-honest');
	});

	test('hero headline and both CTAs render; primary routes to /app/', async ({
		page,
	}) => {
		await page.goto('/');
		await expect(page.locator('#pb-hero-h')).toBeVisible();
		const key = page.locator('.hero-cta .btn-key');
		await expect(key).toHaveAttribute('href', '/app/');
		await expect(page.locator('.hero-cta .btn-line')).toHaveAttribute(
			'href',
			'#pb-card',
		);
		const res = await page.request.get('/app/');
		expect(res.status()).toBe(200);
	});

	test('run spine: sticky rail covers the six acts in order', async ({ page }) => {
		await page.goto('/');
		const rail = page.locator('.spine-rail .rail-link');
		await expect(rail).toHaveCount(6);
		const steps = await rail.evaluateAll((links) =>
			links.map((a: unknown) => {
				const spans = (a as { querySelectorAll(selectors: string): { textContent: string | null }[] }).querySelectorAll('span');
				return `${spans[0]?.textContent} ${spans[1]?.textContent}`;
			}),
		);
		expect(steps).toEqual([
			'01 Discover',
			'02 Vet',
			'03 Plan',
			'04 Forge',
			'05 Deliver',
			'06 Prepare',
		]);
		for (const id of [
			'pb-discover',
			'pb-vet',
			'pb-plan',
			'pb-forge',
			'pb-deliver',
			'pb-prepare',
		]) {
			await expect(page.locator(`section.act#${id}`)).toBeVisible();
		}
	});

	test('act step kickers use the amber key color (mono grammar)', async ({
		page,
	}) => {
		await page.goto('/');
		const color = await page
			.locator('#pb-discover .act-step b')
			.evaluate((el) => getComputedStyle(el).color);
		// --pb-warn resolves to rgb(240, 168, 60) in the dark theme (halo port).
		expect(color.replace(/\s/g, '')).toBe('rgb(240,168,60)');
	});

	test('honesty band: four rails, will-not list, locked line', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('#pb-honest .honest > div')).toHaveCount(4);
		const willNot = page.locator('#pb-honest .locked li');
		expect(await willNot.count()).toBeGreaterThanOrEqual(3);
		await expect(page.locator('#pb-honest .lockline')).toContainText(
			'LOCKED LINE',
		);
		// Honest rule: unread rules are never called "clear" — unknown surfaces.
		await expect(page.locator('#pb-honest .locked')).toContainText(
			/unknown/i,
		);
	});

	test('synthetic card demo carries the not-a-live-run disclosure', async ({
		page,
	}) => {
		await page.goto('/');
		const demo = page.locator('#pb-card');
		await expect(demo).toBeVisible();
		await expect(demo).toContainText(/not a live run/i);
		await expect(demo.locator('.stackgrid .frag').first()).toBeVisible();
		// No interactive fakes: the demo uses static tags, not buttons.
		expect(await demo.locator('button').count()).toBe(0);
	});

	test('stack availability is honest: one proving-first, four planned, zero verified', async ({
		page,
	}) => {
		await page.goto('/');
		const stacks = page.locator('#pb-stacks [data-status]');
		expect(await stacks.count()).toBe(5);
		expect(await page.locator('#pb-stacks [data-status="proving-first"]').count()).toBe(1);
		expect(await page.locator('#pb-stacks [data-status="planned"]').count()).toBe(4);
		expect(await page.locator('#pb-stacks [data-status="verified"]').count()).toBe(0);
	});

	test('closing: request access works through the configured mailto (placeholder pending owner)', async ({
		request,
	}) => {
		const res = await request.get('/');
		const html = await res.text();
		expect(html).toContain('href="mailto:hello@example.com');
		// The placeholder must be marked in the shipped HTML, not just the source.
		expect(html).toMatch(/PLACEHOLDER CONTACT/i);
	});
});

test.describe('P16 landing — mobile, motion and keyboard checks', () => {
	test('no horizontal overflow at 390px viewport', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		const overflow = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
			// scrollWidth alone can miss content clipped by an ancestor
			// overflow rule, so also require every section's right edge to
			// fit the viewport — content-loss breakage cannot hide.
			sections: [...document.querySelectorAll('section')].map((el) => ({
				id: el.id || el.className,
				right: el.getBoundingClientRect().right,
			})),
		}));
		expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
		for (const section of overflow.sections) {
			expect(section.right).toBeLessThanOrEqual(390);
		}
	});

	test('prefers-reduced-motion: reduce disables every CSS animation', async ({
		browser,
	}) => {
		const reduce = await browser.newContext({
			reducedMotion: 'reduce',
			viewport: { width: 1280, height: 800 },
		});
		const pageReduce = await reduce.newPage();
		await pageReduce.goto('/');
		const reduceCount = await pageReduce.evaluate(
			() => document.getAnimations().length,
		);
		expect(reduceCount).toBe(0);
		await reduce.close();

		// Control: with motion allowed the page HAS animations (blink cursor),
		// proving the reduce assertion is not vacuous.
		const motion = await browser.newContext({
			reducedMotion: 'no-preference',
			viewport: { width: 1280, height: 800 },
		});
		const pageMotion = await motion.newPage();
		await pageMotion.goto('/');
		const motionCount = await pageMotion.evaluate(
			() => document.getAnimations().length,
		);
		expect(motionCount).toBeGreaterThan(0);
		await motion.close();
	});

	test('keyboard: skip link is first, focus is visible, primary CTA reachable in order', async ({
		page,
	}) => {
		await page.goto('/');
		await page.keyboard.press('Tab');
		const first = await page.evaluate(() => ({
			cls: document.activeElement?.className ?? '',
		}));
		expect(first.cls).toContain('skip');
		await expect(page.locator('.skip')).toHaveAttribute('href', '#pb-main');
		const focusVisible = await page.evaluate(() =>
			document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : '',
		);
		expect(focusVisible).not.toBe('none');
		let ctaReachable = false;
		for (let i = 0; i < 15; i++) {
			await page.keyboard.press('Tab');
			const cls = await page.evaluate(
				() => document.activeElement?.className ?? '',
			);
			if (String(cls).includes('btn-key')) {
				ctaReachable = true;
				break;
			}
		}
		expect(ctaReachable).toBe(true);
	});

	test('metadata: title, description, favicon; no external font or image URLs', async ({
		request,
	}) => {
		const res = await request.get('/');
		const html = await res.text();
		expect(html).toContain('<title>Caddie');
		expect(html).toContain('name="description"');
		expect(html).toMatch(/rel="icon"/);
		// No external fetches: only the mailto may appear as an absolute URL.
		const externals = [
			...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g),
		].map((m) => m[1]);
		expect(externals).toEqual([]);
	});
});
