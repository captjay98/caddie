import { expect, test } from '@playwright/test';

/**
 * P16 landing acceptance — runs against the COMPOSED build (`bun run build`
 * first): Astro landing at /, React SPA at /app/, served by local workerd on
 * 127.0.0.1:4173. Copy assertions intentionally mirror docs/feature-ledger.md
 * availability: no testimonials, no metrics, no build-success claims.
 */

// The root tsconfig intentionally omits the "dom" lib (it typechecks Node and
// bun code). The callbacks below run inside the browser via page.evaluate, so
// declare the minimal surface this spec touches — module-scoped, so it never
// conflicts with a future "dom" lib addition in shared config.
declare const document: {
	documentElement: { scrollWidth: number; clientWidth: number };
	activeElement: { classList: { contains(name: string): boolean } } | null;
	querySelectorAll(selectors: string): Array<{
		getAttribute(name: string): string | null;
	}>;
	getAnimations(): unknown[];
};
declare function getComputedStyle(element: object): { outlineStyle: string };

test.describe('P16 landing — shell', () => {
	test('/ returns 200 and serves meaningful content in raw HTML (no JS required)', async ({
		request,
	}) => {
		const res = await request.get('/');
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('text/html');
		const html = await res.text();

		// Core narrative copy must exist in the served document itself — Astro
		// static output readable with JavaScript disabled.
		expect(html).toContain('Caddie');
		expect(html).toContain('persistent, evidence-backed assistant');

		// Metadata: title and description present.
		expect(html).toContain(
			'<title>Caddie — discover, build, deliver with evidence</title>',
		);
		expect(html).toMatch(/<meta name="description" content="[^"]{20,}"/);
	});

	test('hero headline and lede render with JavaScript disabled', async ({
		browser,
	}) => {
		const context = await browser.newContext({
			javaScriptEnabled: false,
			viewport: { width: 1280, height: 800 },
		});
		const page = await context.newPage();
		await page.goto('/');
		const h1 = page.getByRole('heading', { level: 1 });
		await expect(h1).toBeVisible();
		await expect(h1).toContainText(/deliver with evidence/i);
		await expect(page.locator('.hero .lede')).toContainText(
			'persistent, evidence-backed assistant',
		);
		await context.close();
	});

	test('primary CTA routes to /app/ and the workspace responds in the composed build', async ({
		page,
		request,
	}) => {
		await page.goto('/');
		const cta = page.locator('.hero a.cta-primary');
		await expect(cta).toBeVisible();
		await expect(cta).toHaveAttribute('href', '/app/');
		const res = await request.get('/app/');
		expect(res.status()).toBe(200);
	});
});

test.describe('P16 landing — stories, demo and honest availability', () => {
	test('workspace demo carries the "not a live run" disclosure', async ({
		request,
		page,
	}) => {
		const html = await (await request.get('/')).text();
		expect(html).toContain('not a live run');

		// The disclosure is visible markup, not a hidden comment.
		await page.goto('/');
		const banner = page.locator('.demo-banner');
		await expect(banner).toBeVisible();
		await expect(banner).toContainText('not a live run');
	});

	test('three stories render: discover, build, prepare', async ({ page }) => {
		await page.goto('/');
		const stories = page.locator('#stories article');
		await expect(stories).toHaveCount(3);
		await expect(
			page.getByRole('heading', { name: /discover opportunities/i }),
		).toBeVisible();
		await expect(
			page.getByRole('heading', { name: /build through specialists/i }),
		).toBeVisible();
		await expect(
			page.getByRole('heading', { name: /prepare verifiable submissions/i }),
		).toBeVisible();
	});

	test('stack availability is honest per the feature ledger', async ({
		request,
		page,
	}) => {
		const html = await (await request.get('/')).text();
		expect(html).toContain('proving first');

		await page.goto('/');
		// react-hono is proving first (P09 gate); the other four are planned.
		await expect(page.locator('[data-status="proving-first"]')).toContainText(
			/react \+ hono/i,
		);
		await expect(page.locator('[data-status="planned"]')).toHaveCount(4);
		// No verified label anywhere while gates are open.
		expect(
			await page.locator('[data-status="verified"]').count(),
		).toBe(0);
	});

	test('request access uses an explicit mailto placeholder awaiting the owner address', async ({
		request,
		page,
	}) => {
		const html = await (await request.get('/')).text();
		// Source comment marks the address as a placeholder for the owner.
		expect(html).toMatch(/<!--\s*PLACEHOLDER CONTACT[^>]*hello@example\.com/);

		await page.goto('/');
		const mail = page.locator('a[href^="mailto:hello@example.com"]');
		await expect(mail).toBeVisible();
	});
});

test.describe('P16 landing — mobile, motion and keyboard checks', () => {
	test('no horizontal overflow at 390px viewport', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		const overflow = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
			// body uses overflow-x: clip as a backstop, which hides overflow
			// from scrollWidth — also require every section to fit the
			// viewport so content-loss breakage cannot hide behind the clip.
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
		// Allow any late-animating nodes to attach, then count.
		await pageReduce.waitForTimeout(300);
		expect(
			await pageReduce.evaluate(() => document.getAnimations().length),
		).toBe(0);

		// Control: the same page under "no preference" does run quiet motion,
		// proving the gating is real rather than vacuous.
		const full = await browser.newContext({
			reducedMotion: 'no-preference',
			viewport: { width: 1280, height: 800 },
		});
		const pageFull = await full.newPage();
		await pageFull.goto('/');
		await pageFull.waitForTimeout(300);
		expect(
			await pageFull.evaluate(() => document.getAnimations().length),
		).toBeGreaterThan(0);

		await reduce.close();
		await full.close();
	});

	test('keyboard: skip link is first, focus is visible, primary CTA reachable in order', async ({
		page,
	}) => {
		await page.goto('/');
		await page.keyboard.press('Tab');
		await expect(page.locator('.skip')).toBeFocused();

		// Keyboard focus must produce a visible outline (:focus-visible rule).
		const outline = await page.evaluate(() => {
			const el = document.activeElement;
			if (!el) return 'none';
			return getComputedStyle(el).outlineStyle;
		});
		expect(outline).not.toBe('none');

		// Walk forward: primary CTA becomes the active element within a few
		// stops (nav links interleave), proving a logical, DOM-order tab sequence.
		let focusedPrimary = false;
		for (let i = 0; i < 12 && !focusedPrimary; i++) {
			await page.keyboard.press('Tab');
			focusedPrimary = await page.evaluate(
				() =>
					document.activeElement?.classList.contains('cta-primary') ??
					false,
			);
		}
		expect(focusedPrimary).toBe(true);
	});

	test('links are internal or mailto only; external links would require safe rel', async ({
		page,
	}) => {
		await page.goto('/');
		const hrefs = await page.evaluate(() =>
			[...document.querySelectorAll('a')].map((a) => a.getAttribute('href')),
		);
		expect(hrefs.length).toBeGreaterThan(0);
		for (const href of hrefs) {
			// The page intentionally has no external http(s) links; any future
			// external link must add target="_blank" + rel="noopener noreferrer"
			// and update this assertion.
			expect(href).toMatch(/^(#|\/|mailto:)/);
		}
		const unsafe = await page.evaluate(
			() =>
				[...document.querySelectorAll('a[target="_blank"]')].filter(
					(a) =>
						!(a.getAttribute('rel') ?? '').includes('noopener'),
				).length,
		);
		expect(unsafe).toBe(0);
	});
});
