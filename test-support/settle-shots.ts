/**
 * TEMP (not committed): two screenshots of the same page a second and a half
 * apart, so any remaining jump can be seen rather than only measured.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/settle-shots.ts <path> <outPrefix>
 */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const out = process.argv[3] ?? '/tmp/caddie-settle';
const signed = `${process.env.SESSION_TOKEN}.${createHmac('sha256', process.env.BETTER_AUTH_SECRET!).update(process.env.SESSION_TOKEN!).digest('base64')}`;
const browser = await chromium.launch({ headless: true });
for (const width of [1280, 390]) {
	const context = await browser.newContext({ viewport: { width, height: 900 } });
	await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
	const page = await context.newPage();
	await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(350);
	await page.screenshot({ path: `${out}-${width}-a.png` });
	await page.waitForTimeout(1800);
	await page.screenshot({ path: `${out}-${width}-b.png` });
	await context.close();
}
await browser.close();
