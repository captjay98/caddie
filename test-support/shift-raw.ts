/**
 * TEMP (not committed): print the RAW previous/current rects for every layout
 * shift plus a 100ms trail of the elements involved, so a vanishing element can
 * be told apart from a moving one.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/shift-raw.ts <path>
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
await page.addInitScript(() => {
	(window as any).__raw = [];
	// Stamp every status-card node with a sequence number the instant it enters
	// the document, so a shift entry can be read as "same node moved" (same seq)
	// or "node replaced" (new seq / not connected).
	let seq = 0;
	const stamp = (root: ParentNode) => {
		const cards = (root as HTMLElement).matches?.('[data-testid=workflow-summary]')
			? [root as HTMLElement]
			: [...(root as HTMLElement).querySelectorAll?.('[data-testid=workflow-summary]') ?? []];
		for (const card of cards) (card as any).__seq = ++seq;
	};
	new MutationObserver((records) => {
		for (const r of records) for (const n of [...r.addedNodes]) if (n.nodeType === 1) stamp(n as HTMLElement);
	}).observe(document, { childList: true, subtree: true });
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (entry.hadRecentInput) continue;
			(window as any).__raw.push({
				value: Number(entry.value.toFixed(5)),
				atMs: Math.round(entry.startTime),
				sources: (entry.sources ?? []).map((s: any) => ({
					node: `${s.node?.nodeName ?? '?'}#${String(s.node?.className ?? '').slice(0, 50)}`,
					prev: [s.previousRect.x, s.previousRect.y, s.previousRect.width, s.previousRect.height].map(Math.round),
					curr: [s.currentRect.x, s.currentRect.y, s.currentRect.width, s.currentRect.height].map(Math.round),
					parent: `${s.node?.parentElement?.tagName?.toLowerCase()}.${String(s.node?.parentElement?.className ?? '').slice(0, 40)}`,
					seq: (s.node as any)?.__seq ?? 'unstamped',
					connected: (s.node as any)?.isConnected ?? null,
				})),
			});
		}
	}).observe({ type: 'layout-shift', buffered: true });
});
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
const trail: string[] = [];
for (let at = 0; at <= 2000; at += 100) {
	trail.push(`--- ${at}ms ` + await page.evaluate(() => {
		const box = (n: Element | null) => { if (!n) return 'absent'; const r = n.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`; };
		const cards = [...document.querySelectorAll('[data-testid=workflow-summary]')];
		const transcript = document.querySelector('.transcript');
		return [
			`cards=${cards.length}[${cards.map(box).join(' | ')}]`,
			`transcript=${box(transcript)} n=${transcript ? transcript.children.length : -1} txt="${(transcript?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 45)}"`,
			`dock=${box(document.querySelector('.shell-right'))}`,
			`head=${box(document.querySelector('.project-head'))} steps=${box(document.querySelector('.project-steps'))} urgent=${box(document.querySelector('.project-head-urgent'))}`,
			`pheadTxt="${(document.querySelector('.project-head')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 90)}"`,
			`window=${box(document.querySelector('.app-preview-window'))}`,
		].join('  ');
	}));
	await page.waitForTimeout(100);
}
console.log(trail.join('\n'));
const raw = await page.evaluate(() => (window as any).__raw);
console.log(`CLS=${raw.reduce((s: number, i: { value: number }) => s + i.value, 0).toFixed(5)} shifts=${raw.length}`);
for (const item of raw) console.log(JSON.stringify(item));
await browser.close();
