/** TEMP (not committed): the title row's children at a narrow width over time. */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const width = Number(process.env.CADDIE_WIDTH ?? 320);
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width, height: 780 } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid=project-tabs] a', { timeout: 30_000 });
for (let at = 0; at < 900; at += 100) {
	const row = await page.evaluate(() => {
		const title = document.querySelector('.project-head-title')!;
		const style = getComputedStyle(title);
		const parts = [...title.children].map((child) => {
			const r = child.getBoundingClientRect();
			const cs = getComputedStyle(child);
			return `${child.tagName.toLowerCase()}.${String(child.className).split(' ')[0]}[${(child.textContent ?? '').trim().slice(0, 18)}]@${Math.round(r.y)}+${Math.round(r.height)} w${Math.round(r.width)} lh${cs.lineHeight} fs${cs.fontSize} ws${cs.whiteSpace}`;
		});
		return `h${Math.round(title.getBoundingClientRect().height)} ${style.display}/${style.flexWrap}/${style.alignItems} || ${parts.join(' | ')}`;
	});
	console.log(`+${at}ms ${row}`);
	await page.waitForTimeout(100);
}
await browser.close();
