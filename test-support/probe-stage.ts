/**
 * TEMP (not committed): what inside the standalone preview window changes
 * height while it opens, so the area can reserve it.
 */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const signed = `${process.env.SESSION_TOKEN}.${createHmac('sha256', process.env.BETTER_AUTH_SECRET!).update(process.env.SESSION_TOKEN!).digest('base64')}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
for (let at = 0; at <= 2600; at += 100) {
	console.log(`${String(at).padStart(4)}ms ` + await page.evaluate(() => {
		const box = (selector: string) => { const node = document.querySelector(selector) as HTMLElement | null; if (!node) return '-'; const b = node.getBoundingClientRect(); return `${Math.round(b.y)}/${Math.round(b.height)}`; };
		const text = (selector: string) => { const node = document.querySelector(selector); return node ? (node.textContent ?? '').trim().slice(0, 22) : ''; };
		return [
			`panel ${box('.app-preview-window .artifact-panel')}`,
			`toolbar ${box('.preview-window-toolbar')}`,
			`stage ${box('.app-preview-window iframe') || '-'}`,
			`status ${box('.app-preview-window [role=status]')}`,
			`alert ${box('.app-preview-window [role=alert]')}`,
			`note ${box('[data-testid=preview-test-data-note]')}`,
			`actions ${box('.app-preview-window .row-actions')}`,
			`win ${box('.app-preview-window')}`,
			`| "${text('[role=status]')}${text('[role=alert]')}"`,
		].join('  ');
	}));
	await page.waitForTimeout(100);
}
await browser.close();
