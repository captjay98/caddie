import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
const BASE = 'http://localhost:5176';
const signed = `${process.env.SESSION_TOKEN}.${createHmac('sha256', process.env.BETTER_AUTH_SECRET!).update(process.env.SESSION_TOKEN!).digest('base64')}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960`, { waitUntil: 'domcontentloaded' });
for (let at = 0; at <= 2000; at += 150) {
	console.log(`--- ${at}ms ` + await page.evaluate(() => {
		const sel = ['.preview-bar', '.preview-bar h1', '.preview-bar .row-actions', '[data-testid=ask-for-change]', '.app-preview-window', '.preview-window-toolbar', '.preview-window-toolbar .row-actions', '.preview-device-switch', '.app-preview-window iframe', '.state-panel'];
		return sel.map((s) => { const n = document.querySelector(s) as HTMLElement | null; if (!n) return `${s}|absent`; const b = n.getBoundingClientRect(); return `${s}|${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`; }).join('  ');
	}));
	await page.waitForTimeout(150);
}
await browser.close();
