/**
 * TEMP (not committed): follow the SHELL shape through the first seconds of a
 * page — when the chat dock appears, when its transcript node is replaced, and
 * what the left column's width does about it.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/shell-trail.ts <path>
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
	const t0 = performance.now();
	const stamp = () => `${Math.round(performance.now() - t0)}ms`;
	const id = new WeakMap<Element, number>();
	let next = 0;
	const tag = (el: Element | null) => {
		if (!el) return 'none';
		if (!id.has(el)) id.set(el, ++next);
		return `#${id.get(el)}`;
	};
	(new MutationObserver((records) => {
		for (const r of records) {
			const touched = [r.target, ...[...r.addedNodes] as Element[], ...[...r.removedNodes] as Element[]];
			for (const el of touched) {
				if (!(el instanceof Element)) continue;
				if (el.matches('.channel-pane')) console.log(`${stamp()} PANE ${r.type === 'childList' ? [...r.removedNodes].includes(el) ? 'REMOVED' : 'ADDED' : 'ATTR'} ${tag(el)}`);
				if (el.matches('.transcript')) console.log(`${stamp()} TRANSCRIPT ${r.type === 'childList' ? [...r.removedNodes].includes(el) ? 'REMOVED' : 'ADDED' : 'ATTR'} ${tag(el)} in ${tag(el.parentElement)}`);
				if (el.matches('.shell-main')) console.log(`${stamp()} MAIN ${tag(el)} ${Math.round(el.getBoundingClientRect().width)}w`);
				if (el.matches('[data-testid=workflow-summary]')) console.log(`${stamp()} CARD ${r.type === 'childList' ? [...r.removedNodes].includes(el) ? 'REMOVED' : 'ADDED' : 'ATTR'} in ${tag(el.parentElement)}`);
			}
		}
	})).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-conv-state', 'data-transport-status', 'class'] });
});
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
const rows: string[] = [];
for (let at = 0; at <= 1200; at += 20) {
	rows.push(at + 'ms ' + await page.evaluate(() => {
		const w = (s: string) => { const n = document.querySelector(s); if (!n) return 'absent'; const r = n.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.width)}w`; };
		const card = document.querySelector('[data-testid=workflow-summary]');
		const tr = document.querySelector('.transcript') as HTMLElement | null;
		const cs = card ? getComputedStyle(card) : null;
		const pane = document.querySelector('.channel-pane') as HTMLElement | null;
		return `main=${w('.shell-main')} dock=${w('.shell-right')} card=${card ? `${Math.round(card.getBoundingClientRect().y)}y${Math.round(card.getBoundingClientRect().height)}h` : 'none'}` +
			` cardDisp=${cs?.display ?? '-'} cardVis=${cs?.visibility ?? '-'} paneDisp=${pane ? getComputedStyle(pane).display : '-'} paneHidden=${pane?.dataset.hidden ?? '-'}` +
			` trScroll=${tr ? Math.round(tr.scrollTop) : '-'} trH=${tr ? Math.round(tr.scrollHeight) : '-'} rows=${tr?.children.length ?? '-'} conv=${document.querySelector('[data-testid=app-split]')?.getAttribute('data-conv-state') ?? '?'}`;
	}));
	await page.waitForTimeout(20);
}
let prev = '';
console.log(rows.filter((r) => { const key = r.replace(/^\d+ms /, '').slice(0, 260); const shown = key !== prev; prev = key; return shown; }).join('\n'));
console.log(`samples=${rows.length}`);
await browser.close();
