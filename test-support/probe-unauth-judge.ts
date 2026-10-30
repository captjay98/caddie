import { chromium } from '@playwright/test';
const base = process.env.BASE ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch();
for (const width of [1280, 390]) {
	const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 2 });
	const page = await context.newPage();
	await page.goto(`${base}/app/`, { waitUntil: 'networkidle' });
	await page.getByTestId('sign-in-panel').waitFor({ state: 'visible' });
	await page.getByTestId('judge-link').click();
	await page.getByTestId('judge-panel').waitFor({ state: 'visible' });
	await page.waitForTimeout(200);
	const info = await page.evaluate(() => {
		const h = document.querySelector('.capsule-nav-unauth')!.getBoundingClientRect();
		const scroller = document.querySelector('.shell-left') as HTMLElement;
		return {
			headerTop: Math.round(h.top),
			scrollTop: Math.round(scroller.scrollTop),
			scrollHeight: scroller.scrollHeight,
			clientHeight: scroller.clientHeight,
			overlaps: document.elementFromPoint(200, 40)?.closest('.capsule-nav-unauth') !== null,
		};
	});
	console.log(width, JSON.stringify(info));
	await page.screenshot({ path: `test-support/unauth-judge-${width}.png` });
	await context.close();
}
await browser.close();
