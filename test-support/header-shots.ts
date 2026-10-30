/**
 * TEMP (not committed): screenshots of the project header before and after the
 * event record lands, so the reserved deadline line can be checked by eye at
 * both widths. Secrets stay in the environment and are never printed.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/header-shots.ts <path> <outPrefix>
 */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const out = process.argv[3] ?? '/tmp/caddie-header';
const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) { console.error('need SESSION_TOKEN and BETTER_AUTH_SECRET'); process.exit(3); }
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch({ headless: true });
for (const width of [1280, 390]) {
	const context = await browser.newContext({ viewport: { width, height: 900 } });
	await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
	const page = await context.newPage();
	await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('[data-testid=project-tabs]', { timeout: 30_000 });
	await page.screenshot({ path: `${out}-${width}-early.png` });
	await page.waitForTimeout(3000);
	await page.screenshot({ path: `${out}-${width}-settled.png` });
	console.log(`${width}px rail ${JSON.stringify(await page.evaluate(() => { const n = document.querySelector('[data-testid=project-tabs]')!.getBoundingClientRect(); const band = document.querySelector('.project-head-urgent'); return { y: Math.round(n.y), h: Math.round(n.height), band: band ? `${Math.round(band.getBoundingClientRect().height)}px ${band.dataset.tone} ${(band.textContent ?? '').trim()}` : 'none' }; }))}`);
	await context.close();
}
await browser.close();
