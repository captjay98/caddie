import { chromium } from '@playwright/test';

const base = process.env.BASE ?? 'http://localhost:5176';

const browser = await chromium.launch();
for (const width of [1280, 390]) {
	const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 2 });
	const page = await context.newPage();
	await page.goto(`${base}/app/`, { waitUntil: 'networkidle' });
	await page.getByTestId('sign-in-panel').waitFor({ state: 'visible', timeout: 15000 });
	const info = await page.evaluate(() => {
		const header = document.querySelector('.capsule-nav-unauth') as HTMLElement;
		const wordmark = header.querySelector('.capsule-wordmark') as HTMLElement;
		const link = header.querySelector('[data-testid="back-to-landing"]') as HTMLElement;
		const toggle = header.querySelector('[data-testid="theme-toggle"]') as HTMLElement;
		const card = document.querySelector('.signin-col') as HTMLElement;
		const screen = document.querySelector('.signin-screen') as HTMLElement;
		const cs = getComputedStyle(header);
		const r = (el: Element) => {
			const b = el.getBoundingClientRect();
			return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
		};
		const dot = wordmark.querySelector('b');
		return {
			header: r(header),
			headerStyle: {
				position: cs.position,
				background: cs.backgroundColor,
				border: cs.borderTopWidth,
				radius: cs.borderRadius,
				shadow: cs.boxShadow,
				padding: cs.padding,
			},
			wordmark: r(wordmark),
			wordmarkText: wordmark.textContent,
			dotDisplay: dot ? getComputedStyle(dot).display : null,
			home: r(link),
			toggle: r(toggle),
			card: r(card),
			screen: r(screen),
			scrolls: document.documentElement.scrollHeight > window.innerHeight,
		};
	});
	console.log(width, JSON.stringify(info, null, 2));
	await page.screenshot({ path: `test-support/unauth-header-${width}.png` });
	await context.close();
}
await browser.close();
