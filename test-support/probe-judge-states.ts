import { chromium } from '@playwright/test';
const base = process.env.BASE ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch();
for (const width of [390, 1280]) {
	const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 2 });
	const page = await context.newPage();
	await page.goto(`${base}/app/`, { waitUntil: 'networkidle' });
	await page.getByTestId('sign-in-panel').waitFor({ state: 'visible' });
	await page.getByTestId('judge-link').click();
	await page.getByTestId('judge-panel').waitFor({ state: 'visible' });
	await page.waitForTimeout(250);
	await page.screenshot({ path: `test-support/judge-first-${width}.png` });
	await page.getByTestId('judge-returning-link').click();
	await page.getByTestId('judge-sign-in-form').waitFor({ state: 'visible' });
	await page.waitForTimeout(250);
	await page.screenshot({ path: `test-support/judge-returning-${width}.png` });
	const box = await page.getByTestId('judge-panel').boundingBox();
	console.log(width, 'panel', box);
	await context.close();
}
await browser.close();
