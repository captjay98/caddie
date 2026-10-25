import { expect, test } from '@playwright/test';

/**
 * Landing acceptance — 2026-10-25 redo for first-time, non-technical builders.
 *
 * Runs against the COMPOSED build (`bun run build` first): Astro landing at /,
 * React SPA at /app/, served by local workerd on 127.0.0.1:4173.
 *
 * Contract: the page says what you get without jargon, every product image is
 * a real screenshot (or an obvious "Screenshot coming" slot — never a fake
 * mockup), and the static, accessible, no-external-fetch invariants hold.
 */

// The root tsconfig intentionally omits the "dom" lib; declare the minimal
// surface the page.evaluate callbacks touch.
declare const document: {
	documentElement: { scrollWidth: number; clientWidth: number };
	activeElement: { className: string } | null;
	querySelectorAll(selectors: string): Array<{
		id: string;
		className: string;
		getBoundingClientRect(): { right: number };
	}>;
	getAnimations(): unknown[];
};
declare function getComputedStyle(element: object): { outlineStyle: string };

/** Words a first-timer should not meet before they understand the product. */
const JARGON = ['repo', 'sandbox', 'gate', 'delta', 'artifact', 'receipt', 'stack', 'deploy', 'api'];

test.describe('landing — first-timer page', () => {
	test('/ returns 200 and serves meaningful content in raw HTML (no JS required)', async ({ request }) => {
		const res = await request.get('/');
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('text/html');
		const html = await res.text();
		expect(html).toContain('class="pb"');
		expect(html).toContain('pb-hero-h');
		expect(html).toContain('Caddie builds the app');
		expect(html).toContain("You don't need to know how to code");
		// Inline scripts only: theme pre-paint + toggle.
		const scripts = [...html.matchAll(/<script\b/g)];
		expect(scripts.length).toBe(2);
	});

	test('topbar: wordmark and four plain-language section links', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('.topbar .wordmark')).toHaveText('Caddie');
		const nav = page.locator('.topbar nav a');
		await expect(nav).toHaveCount(4);
		const hrefs = await nav.evaluateAll((links) => links.map((a) => (a as unknown as { getAttribute(n: string): string }).getAttribute('href')));
		expect(hrefs).toEqual(['#how', '#hackathons', '#tech', '#judges']);
		for (const id of ['how', 'hackathons', 'tech', 'judges']) await expect(page.locator(`#${id}`)).toBeVisible();
	});

	test('hero: one primary "Start building" into the app, judge path beside it', async ({ page, request }) => {
		await page.goto('/');
		await expect(page.locator('#pb-hero-h')).toBeVisible();
		const key = page.locator('.hero-cta .btn-key');
		await expect(key).toHaveCount(1);
		await expect(key).toHaveText('Start building');
		await expect(key).toHaveAttribute('href', '/app/');
		const judge = page.locator('.hero-cta .btn-line');
		await expect(judge).toContainText('access code');
		await expect(judge).toHaveAttribute('href', '/app/');
		expect((await request.get('/app/')).status()).toBe(200);
	});

	test('the first screens a newcomer reads carry no technical jargon', async ({ page }) => {
		await page.goto('/');
		for (const selector of ['.hero', '#how', '#promise', '#hackathons']) {
			const text = (await page.locator(selector).innerText()).toLowerCase();
			for (const word of JARGON) expect(text, `${selector} contains "${word}"`).not.toMatch(new RegExp(`\\b${word}s?\\b`));
		}
	});

	test('how it works: four steps in order, each with a screenshot slot', async ({ page }) => {
		await page.goto('/');
		const steps = page.locator('#how .step');
		await expect(steps).toHaveCount(4);
		expect(await steps.evaluateAll((els) => els.map((el) => (el as unknown as { getAttribute(n: string): string }).getAttribute('data-step')))).toEqual(['01', '02', '03', '04']);
		await expect(page.locator('#how .step [data-shot]')).toHaveCount(4);
	});

	test('every product image is a real screenshot or an obvious pending slot — never a mockup', async ({ page }) => {
		await page.goto('/');
		const slots = page.locator('[data-shot]');
		expect(await slots.count()).toBeGreaterThanOrEqual(6);
		for (const slot of await slots.all()) {
			const state = await slot.getAttribute('data-shot-state');
			expect(['real', 'pending']).toContain(state);
			if (state === 'real') {
				await expect(slot.locator('figcaption')).toContainText('Real app');
				for (const src of await slot.locator('img').evaluateAll((imgs) => imgs.map((i) => (i as unknown as { getAttribute(n: string): string }).getAttribute('src')))) {
					expect(src).toMatch(/^\/shots\/[a-z-]+-(desktop|phone)-(light|dark)\.webp$/);
				}
			} else {
				await expect(slot).toContainText('Screenshot coming');
				await expect(slot.locator('img')).toHaveCount(0);
			}
		}
		// The example section only exists once a real capture backs it.
		const example = page.locator('#example');
		if (await example.count()) await expect(example.locator('[data-shot-state="real"]')).toHaveCount(1);
	});

	test('promises and under-the-hood render; judges are told where the code is', async ({ page, request }) => {
		await page.goto('/');
		await expect(page.locator('#promise .promises li')).toHaveCount(4);
		await expect(page.locator('#tech')).toContainText('Nemotron');
		await expect(page.locator('#tech')).toContainText('Token Factory');
		await expect(page.locator('#tech')).toContainText('Tavily');
		await expect(page.locator('#judges')).toContainText('Devpost testing instructions');
		// The access code itself is never on the page.
		expect(await (await request.get('/')).text()).not.toMatch(/access code[:\s]+[A-Z0-9-]{6,}/);
	});

	test('closing: one primary, plus an honest invite-only note with a request link', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('#pb-start .btn-key')).toHaveCount(1);
		await expect(page.locator('#pb-start')).toContainText('invite-only');
		await expect(page.locator('#pb-start a[href^="mailto:"]')).toHaveCount(1);
	});
});

test.describe('landing — mobile, motion, keyboard, metadata', () => {
	test('no horizontal overflow at 390px viewport', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		const overflow = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
			sections: [...document.querySelectorAll('section')].map((el) => ({
				id: el.id || el.className,
				right: el.getBoundingClientRect().right,
			})),
		}));
		expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
		for (const section of overflow.sections) expect(section.right, section.id).toBeLessThanOrEqual(390);
	});

	test('prefers-reduced-motion: reduce disables every CSS animation', async ({ browser }) => {
		const reduce = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
		const pageReduce = await reduce.newPage();
		await pageReduce.goto('/');
		expect(await pageReduce.evaluate(() => document.getAnimations().length)).toBe(0);
		await reduce.close();
		// Control: with motion allowed the page has an animation (the live dot).
		const motion = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 1280, height: 800 } });
		const pageMotion = await motion.newPage();
		await pageMotion.goto('/');
		expect(await pageMotion.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0);
		await motion.close();
	});

	test('keyboard: skip link is first, focus is visible, primary CTA reachable in order', async ({ page }) => {
		await page.goto('/');
		await page.keyboard.press('Tab');
		expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('skip');
		await expect(page.locator('.skip')).toHaveAttribute('href', '#pb-main');
		expect(await page.evaluate(() => (document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : ''))).not.toBe('none');
		let ctaReachable = false;
		for (let i = 0; i < 15; i++) {
			await page.keyboard.press('Tab');
			if (String(await page.evaluate(() => document.activeElement?.className ?? '')).includes('btn-key')) {
				ctaReachable = true;
				break;
			}
		}
		expect(ctaReachable).toBe(true);
	});

	test('metadata: title, description, favicon; no external font or image URLs', async ({ request }) => {
		const html = await (await request.get('/')).text();
		expect(html).toContain('<title>Caddie');
		expect(html).toContain('name="description"');
		expect(html).toMatch(/rel="icon"/);
		const externals = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
		expect(externals).toEqual([]);
	});

	test('theme toggle shares caddie-theme; no saved choice means device default and no write on load', async ({ browser }) => {
		const context = await browser.newContext({ colorScheme: 'light' });
		const page = await context.newPage();
		await page.goto('/');
		expect(await page.evaluate(() => localStorage.getItem('caddie-theme'))).toBeNull();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		const toggle = page.locator('[data-pb-theme]');
		await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');
		await toggle.click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		expect(await page.evaluate(() => localStorage.getItem('caddie-theme'))).toBe('dark');
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await context.close();
	});

	test('at most one primary button per viewport at 390/768/1440', async ({ browser }) => {
		for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]] as const) {
			const context = await browser.newContext({ viewport: { width, height } });
			const page = await context.newPage();
			await page.goto('/');
			expect(await page.locator('.hero-cta .btn-key').count()).toBe(1);
			expect(await page.locator('.close .btn-key').count()).toBe(1);
			expect(await page.locator('.mbar .btn-key').count()).toBe(0);
			await context.close();
		}
	});
});
