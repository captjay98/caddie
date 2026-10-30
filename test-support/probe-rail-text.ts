import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const signed = `${process.env.SESSION_TOKEN}.${createHmac('sha256', process.env.BETTER_AUTH_SECRET!).update(process.env.SESSION_TOKEN!).digest('base64')}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
for (const at of [120, 260, 420, 900]) {
	await page.waitForTimeout(at === 120 ? 120 : at - 0);
	console.log(`${at}ms ` + await page.evaluate(() => [...document.querySelectorAll('[data-testid=project-tabs] a')].map((node) => {
		const b = node.getBoundingClientRect();
		return `${(node.textContent ?? '').replace(/\s+/g, ' ').trim()} [${Math.round(b.width)}x${Math.round(b.height)}]`;
	}).join(' | ')));
}
await browser.close();
