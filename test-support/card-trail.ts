/**
 * TEMP (not committed): log every add/remove of the in-chat status card and of
 * the transcript's own children through the first seconds of a page, so a
 * remount can be told from a reflow.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/card-trail.ts <path>
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
	(window as any).__log = [] as string[];
	const t0 = performance.now();
	const stamp = () => `${Math.round(performance.now() - t0)}ms`;
	const describe = (node: Node) => {
		const el = node as HTMLElement;
		const testid = el.getAttribute?.('data-testid');
		return `${el.tagName?.toLowerCase() ?? node.nodeName}.${String(el.className ?? '').split(' ').slice(0, 3).join('.')}${testid ? `[${testid}]` : ''}`;
	};
	const start = () => {
		const transcript = document.querySelector('.transcript');
		if (!transcript) { setTimeout(start, 5); return; }
		console.log(`${stamp()} transcripts=${document.querySelectorAll('.transcript').length} panes=${document.querySelectorAll('.channel-pane').length}`);
		new MutationObserver((records) => {
			for (const r of records) {
				for (const added of [...r.addedNodes]) {
					if (added.nodeType === 1) {
						const hasCard = (added as HTMLElement).matches?.('[data-testid=workflow-summary]') || (added as HTMLElement).querySelector?.('[data-testid=workflow-summary]');
						if (hasCard) {
							const box = (added as HTMLElement).querySelector('[data-testid=workflow-summary]')?.getBoundingClientRect();
							console.log(`${stamp()} CARD ADDED ${describe(added)} at ${Math.round(box?.y ?? -1)},${Math.round(box?.height ?? -1)} h`);
						}
					}
				}
				for (const removed of [...r.removedNodes]) {
					if (removed.nodeType === 1) {
						const hadCard = (removed as HTMLElement).matches?.('[data-testid=workflow-summary]') || (removed as HTMLElement).querySelector?.('[data-testid=workflow-summary]');
						if (hadCard) console.log(`${stamp()} CARD REMOVED ${describe(removed)}`);
					}
				}
				if (r.type === 'attributes') console.log(`${stamp()} ATTR ${describe(r.target)} ${r.attributeName}`);
			}
		}).observe(transcript, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'] });
		console.log(`${stamp()} observing transcript`);
		new MutationObserver((records) => {
			for (const r of records) {
				for (const added of [...r.addedNodes]) {
					const el = added as HTMLElement;
					if (el.matches?.('[data-testid=workflow-summary]')) console.log(`${stamp()} DOC CARD ADDED under ${describe(r.target)}`);
					else if (el.querySelector?.('[data-testid=workflow-summary]')) console.log(`${stamp()} DOC SUBTREE ADDED ${describe(el)} (has card) under ${describe(r.target)}`);
				}
				for (const removed of [...r.removedNodes]) {
					const el = removed as HTMLElement;
					if (el.matches?.('[data-testid=workflow-summary]')) console.log(`${stamp()} DOC CARD REMOVED from ${describe(r.target)}`);
					else if (el.querySelector?.('[data-testid=workflow-summary]')) console.log(`${stamp()} DOC SUBTREE REMOVED ${describe(el)} (had card) from ${describe(r.target)}`);
				}
			}
		}).observe(document.documentElement, { childList: true, subtree: true });
	};
	start();
});
page.on('console', (msg) => { if (msg.type() === 'log') console.log(msg.text()); });
await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const trail = await page.evaluate(() => {
	const box = (n: Element | null) => { if (!n) return 'absent'; const r = n.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`; };
	return {
		cards: [...document.querySelectorAll('[data-testid=workflow-summary]')].map((c) => `${box(c)} :: ${(c.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60)}`),
		transcript: box(document.querySelector('.transcript')),
		children: [...(document.querySelector('.transcript')?.children ?? [])].map(box2),
	};
	function box2(n: Element) { const r = n.getBoundingClientRect(); return `${n.tagName.toLowerCase()}.${String(n.className ?? '').split(' ')[0]}@${Math.round(r.y)}x${Math.round(r.height)}`; }
});
console.log('FINAL', JSON.stringify(trail, null, 1));
await browser.close();
