/**
 * TEMP (not committed): follow one shifting element through the first seconds
 * of a page: where it lives in the DOM, how many siblings the chat transcript
 * has, and what the page reflows around.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/shift-locator.ts <path>
 */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview';
const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) { console.error('need SESSION_TOKEN and BETTER_AUTH_SECRET'); process.exit(3); }
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
for (let at = 0; at <= 3000; at += 200) {
	const snapshot = await page.evaluate(() => {
		const cards = [...document.querySelectorAll('[data-testid=workflow-summary]')];
		const box = (node: Element | null) => {
			if (!node) return 'absent';
			const r = node.getBoundingClientRect();
			const chain: string[] = [];
			let parent = (node as HTMLElement).parentElement;
			while (parent && chain.length < 5) { chain.push(`${parent.tagName.toLowerCase()}.${String(parent.className ?? '').split(' ').slice(0, 2).join('.')}`); parent = parent.parentElement; }
			return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)} in ${chain.join(' < ')}`;
		};
		const transcript = document.querySelector('.transcript');
		return {
			cards: cards.map((card) => box(card)),
			cardTexts: cards.map((card) => (card.textContent ?? '').replace(/\s+/g, ' ').slice(0, 70)),
			transcriptChildren: transcript ? transcript.children.length : -1,
			transcriptBox: box(transcript),
			headBox: box(document.querySelector('.project-head')),
			headText: (document.querySelector('.project-head')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
			windowBox: box(document.querySelector('.app-preview-window')),
		};
	});
	console.log(`--- ${at}ms cards=${snapshot.cards.length}`);
	snapshot.cards.forEach((card, index) => console.log(`    #${index} ${card} :: ${snapshot.cardTexts[index]}`));
	console.log(`    transcript n=${snapshot.transcriptChildren} ${snapshot.transcriptBox}`);
	console.log(`    head ${snapshot.headBox} :: ${snapshot.headText}`);
	console.log(`    previewWindow ${snapshot.windowBox}`);
	await page.waitForTimeout(200);
}
await browser.close();
