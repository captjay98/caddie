/**
 * Shared by capture-today.ts and shoot-mockups.ts (2026-10-21 Projects review).
 *
 * UNCLIP lets the app shell grow to its content so a full-page screenshot
 * shows the whole page (the shell is one window tall and scrolls inside).
 * measure() counts what the eye has to parse: framed boxes in the page,
 * how deeply they nest (the rule from tests/browser/project-v2.spec.ts:
 * bordered on all four sides, rounded >= 6px, at least 120x36, controls
 * excluded), framed boxes in the chat beside the page, the page's length,
 * and the Projects cards' heights and how many fit on the first screen.
 */
import type { Page } from '@playwright/test';

export const UNCLIP = `html, body, #root { height: auto !important; overflow: visible !important; }
.shell { height: auto !important; min-height: 100vh; }
.app-split, .shell-left, .shell-main { overflow: visible !important; max-height: none !important; }
.bottom-nav { position: static !important; transform: none !important; margin-top: 12px; }`;

export interface Measure {
	boxes: number;
	depth: number;
	chatBoxes: number;
	pageHeight: number;
	cardHeights: number[];
	cardsOnFirstScreen: number;
}

export async function measure(page: Page): Promise<Measure> {
	return page.evaluate(() => {
		const isBox = (el: Element): boolean => {
			if (el.closest('button, a, input, textarea, select, summary, iframe, [role="button"]')) return false;
			const s = getComputedStyle(el);
			if (!/^(block|flex|grid|list-item)$/.test(s.display)) return false;
			const framed = ['top', 'right', 'bottom', 'left'].every(
				(side) => parseFloat(s.getPropertyValue(`border-${side}-width`)) >= 1 && s.getPropertyValue(`border-${side}-style`) !== 'none',
			);
			const r = el.getBoundingClientRect();
			return framed && parseFloat(s.borderTopLeftRadius) >= 6 && r.width >= 120 && r.height >= 36;
		};
		const main = document.querySelector('main#main');
		const boxes = main ? Array.from(main.querySelectorAll('*')).filter(isBox) : [];
		let depth = 0;
		for (const box of boxes) {
			let d = 1;
			for (let p = box.parentElement; p && p !== main; p = p.parentElement) if (isBox(p)) d += 1;
			depth = Math.max(depth, d);
		}
		const chat = document.querySelector('aside.shell-right .transcript');
		const chatBoxes = chat ? Array.from(chat.querySelectorAll('*')).filter(isBox).length : 0;
		const cards = Array.from(document.querySelectorAll('main .project-card, main .rv-pcard'));
		const viewport = window.innerHeight;
		return {
			boxes: boxes.length,
			depth,
			chatBoxes,
			pageHeight: Math.round(main?.scrollHeight ?? 0),
			cardHeights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
			cardsOnFirstScreen: cards.filter((c) => c.getBoundingClientRect().bottom <= viewport).length,
		};
	});
}
