/**
 * TEMP (not committed): the owner's exact complaint — the step rail moves a
 * little when NAVIGATING to the Preview tab, but not on the other tabs.
 *
 * Loads an anchor tab first (so the shared queries are warm, like a real
 * walk), clicks a step, and samples the geometry of the rail and its parts for
 * a few seconds after the click, plus every layout-shift source.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/rail-navigation-probe.ts <from-path> <to-testid> [ms]
 */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const fromPath = process.argv[2] ?? '/app/runs?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const stepTestid = process.argv[3] ?? 'project-tab-preview';
const observeFor = Number(process.argv[4] ?? 5000);
const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) { console.error('need SESSION_TOKEN and BETTER_AUTH_SECRET'); process.exit(3); }
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const SELECTORS = [
	'[data-testid=project-tabs]', '.project-head', '.project-head-title', '.project-head-urgent',
	'[data-testid=project-tab-plan]', '[data-testid=project-tab-build]',
	'[data-testid=project-tab-submission]', '[data-testid=project-tab-preview]',
	'[data-testid=preview-page] > .preview-bar', '[data-testid=preview-page]', '.app-preview-window', '.state-panel',
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: Number(process.env.CADDIE_WIDTH ?? 1280), height: Number(process.env.CADDIE_HEIGHT ?? 900) } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();
await page.addInitScript(() => {
	(window as any).__shifts = [];
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (entry.hadRecentInput) continue;
			(window as any).__shifts.push({
				value: Number(entry.value.toFixed(5)),
				atMs: Math.round(entry.startTime),
				sources: (entry.sources ?? []).map((source: any) => ({
					node: `${source.node?.nodeName ?? '?'}#${source.node?.id ?? ''}.${String(source.node?.className ?? '').slice(0, 70)}`,
					moved: { x: Math.round(source.currentRect.left - source.previousRect.left), y: Math.round(source.currentRect.top - source.previousRect.top), w: Math.round(source.currentRect.width - source.previousRect.width), h: Math.round(source.currentRect.height - source.previousRect.height) },
				})),
			});
		}
	}).observe({ type: 'layout-shift', buffered: true });
});
const sample = () => page.evaluate((list: string[]) => {
	const at = performance.now();
	return list.map((selector) => {
		const node = document.querySelector(selector) as HTMLElement | null;
		if (!node) return `${selector.replace('[data-testid=', '').replace(']', '')}|absent`;
		const box = node.getBoundingClientRect();
		const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
		return `${selector.replace('[data-testid=', '').replace(']', '')}|${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}|${text}`;
	}).join(' @' + Math.round(at) + '\n            ');
}, SELECTORS);

await page.goto(`${BASE}${fromPath}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(`[data-testid=${stepTestid}]`, { timeout: 30_000 });
await page.waitForTimeout(3000);
console.log(`--- anchored at ${fromPath} ` + (await sample()));
await page.evaluate(() => { (window as any).__shifts = []; performance.mark('click'); });
await page.click(`[data-testid=${stepTestid}]`);
for (let at = 0; at < observeFor; at += 200) {
	console.log(`--- +${at}ms ` + (await sample()));
	await page.waitForTimeout(200);
}
const shifts = await page.evaluate(() => (window as any).__shifts as any[]);
console.log(`CLS after navigation=${shifts.reduce((s, i) => s + i.value, 0).toFixed(5)} shifts=${shifts.length}`);
for (const item of shifts.slice(0, 20)) console.log(JSON.stringify(item));
await browser.close();
