/**
 * TEMP (not committed): measure layout shifts on a project tab in a real
 * browser, authenticated as the owner with a signed session cookie read
 * read-only from local D1. Secrets stay in the environment and are never
 * printed.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/layout-shift-probe.ts <path> [ms]
 */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const path = process.argv[2] ?? '/app/preview';
const observeFor = Number(process.argv[3] ?? 20000);
const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) {
	console.error('need SESSION_TOKEN and BETTER_AUTH_SECRET');
	process.exit(3);
}
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

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
					node: `${source.node?.nodeName ?? '?'}#${source.node?.id ?? ''}.${String(source.node?.className ?? '').slice(0, 60)}`,
					movedBy: {
						x: Math.round(source.currentRect.left - source.previousRect.left),
						y: Math.round(source.currentRect.top - source.previousRect.top),
						w: Math.round(source.currentRect.width - source.previousRect.width),
						h: Math.round(source.currentRect.height - source.previousRect.height),
					},
				})),
			});
		}
	}).observe({ type: 'layout-shift', buffered: true });
});
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
const selectors = ['[data-testid=workflow-summary]', '[data-testid=project-tabs]', '[data-testid=preview-page]', '.app-preview-window', '.project-head', '.shell-main', '[data-testid=preview-page] header'];
const sample = async () => page.evaluate((list: string[]) => list.map((selector) => {
	const node = document.querySelector(selector) as HTMLElement | null;
	if (!node) return `${selector}|absent`;
	const box = node.getBoundingClientRect();
	const chain: string[] = [];
	let parent = node.parentElement;
	while (parent && chain.length < 4) { chain.push(`${parent.tagName.toLowerCase()}.${String(parent.className ?? '').split(' ').slice(0, 2).join('.')}`); parent = parent.parentElement; }
	return `${selector}|${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}|${chain.join(' < ')}`;
}), selectors);
const timeline: string[] = [];
for (let at = 0; at < 4000; at += 250) {
	timeline.push(`--- ${at}ms ` + (await sample()).join('\n            '));
	await page.waitForTimeout(250);
}
console.log(timeline.join('\n'));
const shifts = await page.evaluate(() => (window as any).__shifts);
const cls = shifts.reduce((sum: number, item: { value: number }) => sum + item.value, 0);
console.log(`path=${path} CLS=${cls.toFixed(5)} shifts=${shifts.length}`);
for (const item of shifts.slice(0, 25)) console.log(JSON.stringify(item));
await browser.close();
