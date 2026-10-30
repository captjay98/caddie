/**
 * TEMP (not committed): header parts at a phone width, second by second.
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/probe-head.ts <path>
 */
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
for (let at = 0; at <= 1800; at += 100) {
	console.log(`${String(at).padStart(4)}ms ` + await page.evaluate(() => {
		const box = (selector: string) => { const node = document.querySelector(selector) as HTMLElement | null; if (!node) return '-'; const b = node.getBoundingClientRect(); return `${Math.round(b.y)}/${Math.round(b.height)}`; };
		return [
			`head ${box('.project-head')}`,
			`title ${box('.project-head-title')}`,
			`band ${box('.project-head-urgent')}`,
			`rail ${box('[data-testid=project-tabs]')}`,
			`plan ${box('[data-testid=project-tab-plan]')}`,
			`submit ${box('[data-testid=project-tab-submission]')}`,
			`prev ${box('[data-testid=project-tab-preview]')}`,
			`bar ${box('.preview-bar')}`,
			`stage ${box('.preview-stage')}`,
			`actions ${box('.app-preview-window > .artifact-panel > .row-actions')}`,
		].join('  ');
	}));
	await page.waitForTimeout(100);
}
await browser.close();
