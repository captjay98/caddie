import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const cookieDomain = new URL(BASE).hostname;
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch();
for (const width of [390, 1280]) {
	const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 2 });
	await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: cookieDomain, path: '/' }]);
	const page = await context.newPage();
	await page.goto(`${BASE}/app/onboarding`, { waitUntil: 'networkidle' });
	const intro = page.getByTestId('welcome-intro');
	if (await intro.count()) {
		await intro.waitFor({ state: 'visible' });
		await page.waitForTimeout(300);
		await page.screenshot({ path: `test-support/welcome-intro-${width}.png` });
		await page.getByRole('radio', { name: 'I have an idea' }).check();
		await page.getByTestId('welcome-next').click();
		await page.getByTestId('welcome-name').waitFor({ state: 'visible' });
		await page.waitForTimeout(300);
		await page.screenshot({ path: `test-support/welcome-name-${width}.png` });
		console.log(width, 'ok', await page.url());
	} else {
		console.log(width, 'not on welcome intro:', page.url());
	}
	await context.close();
}
await browser.close();
