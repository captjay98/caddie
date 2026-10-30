/** TEMP (not committed): which request fails when the in-app preview opens. */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;
const base = process.env.CADDIE_DEV_BASE ?? 'http://127.0.0.1:4173';
const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: new URL(base).hostname, path: '/' }]);
const page = await context.newPage();
page.on('response', (response) => {
	if (response.status() >= 400) {
		const body = response.request().method();
		console.log(`${response.status()} ${body} ${response.url().replace(/\?.*/, '').slice(0, 150)}`);
	}
});
await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await browser.close();
