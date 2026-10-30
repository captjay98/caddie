/** TEMP (not committed): the four step cards' box, plus how their two lines
 *  sit inside it (top gap / bottom gap), so the card height and the vertical
 *  centring can be read at desktop and phone widths. */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch({ headless: true });
for (const width of [1280, 390, 320]) {
	const context = await browser.newContext({ viewport: { width, height: 900 } });
	await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
	const page = await context.newPage();
	await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('[data-testid=project-tabs] a');
	await page.waitForTimeout(1200);
	console.log(`\n=== ${width}px`);
	for (const row of await page.evaluate(() => {
		const rails = [...document.querySelectorAll('[data-testid=project-tabs]')];
		return rails.flatMap((rail) => [...rail.querySelectorAll('a')].map((node) => {
			const card = node.getBoundingClientRect();
			const children = [...node.children].map((child) => {
				const r = child.getBoundingClientRect();
				return `${child.className}@${Math.round(r.top - card.top)}+${Math.round(r.height)}`;
			});
			const top = node.querySelector(':scope > .step-top')?.getBoundingClientRect() ?? null;
			const state = node.querySelector(':scope > .step-state')?.getBoundingClientRect() ?? null;
			const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
			const last = state ?? top;
			return {
				rails: rails.length,
				text,
				card: `${Math.round(card.width)}x${Math.round(card.height)}`,
				topGap: top ? Math.round(top.top - card.top) : null,
				bottomGap: last ? Math.round(card.bottom - last.bottom) : null,
				lineGap: top && state ? Math.round(state.top - top.bottom) : null,
				children: children.join(' '),
			};
		}));
	})) console.log(JSON.stringify(row));
	await context.close();
}
await browser.close();
