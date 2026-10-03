import { expect, test } from '@playwright/test';

/**
 * P16 landing acceptance — runs against the COMPOSED build (`bun run build`
 * first): Astro landing at /, React SPA at /app/, served by local workerd on
 * 127.0.0.1:4173. Copy assertions intentionally mirror docs/feature-ledger.md
 * availability: no testimonials, no metrics, no build-success claims.
 */

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
