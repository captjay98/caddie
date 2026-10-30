/** TEMP (not committed): watch the step cards' box and their label offset over
 *  the first two seconds at a phone width, to find what moves a label by 7px. */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const width = Number(process.env.CADDIE_WIDTH ?? 390);
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width, height: 844 } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid=project-tabs] a', { timeout: 30_000 });
for (let at = 0; at < 2400; at += 150) {
	const row = await page.evaluate(() => {
		const cards = [...document.querySelectorAll('[data-testid=project-tabs] a')];
		const head = document.querySelector('.project-head')?.getBoundingClientRect();
		return cards.map((card) => {
			const c = card.getBoundingClientRect();
			const top = card.querySelector(':scope > .step-top')!.getBoundingClientRect();
			const state = card.querySelector(':scope > .step-state') as HTMLElement | null;
			const computed = state ? getComputedStyle(state) : null;
			return `${Math.round(c.y)}+${Math.round(c.height)}:${Math.round(top.y - c.y)}${state ? `[state ${computed!.display}/${Math.round(state.getBoundingClientRect().height)}]` : '[no state]'}`;
		}).join(' ') + ` | head ${Math.round(head?.y ?? -1)}+${Math.round(head?.height ?? -1)}`;
	});
	console.log(`+${at}ms ${row}`);
	await page.waitForTimeout(150);
}
await browser.close();
