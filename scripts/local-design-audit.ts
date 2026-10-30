/** Machine checks on rendered screens (owner 2026-10-29: measure in code, in
 * seconds, instead of asking an AI reviewer). Each state is rendered in an
 * isolated, script-free, network-denied frame at phone and desktop size, and
 * the DOM is measured: text contrast against its real painted background, tap
 * target sizes, and sideways scrolling. Findings are plain sentences.
 */
import type { Browser } from '@playwright/test';
import type { DesignAuditResult } from '../apps/app/src/server/design-audit.ts';

const VIEWPORTS = [
	{ name: 'phone' as const, width: 390, height: 844 },
	{ name: 'desktop' as const, width: 1440, height: 900 },
];

/** Runs inside the rendered frame. Pure DOM; returns findings, never throws. */
function measure(phone: boolean) {
	type Rgba = { r: number; g: number; b: number; a: number };
	const parse = (value: string): Rgba | null => {
		const match = /rgba?\(([^)]+)\)/.exec(value);
		if (!match) return null;
		const parts = match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
		return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
	};
	const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
	const lum = (c: Rgba) => {
		const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
		return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
	};
	const ratio = (a: Rgba, b: Rgba) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
	/** The colour actually painted behind an element, or null under an image/gradient. */
	const backdrop = (element: Element): Rgba | null => {
		const layers: Rgba[] = [];
		for (let node: Element | null = element; node; node = node.parentElement) {
			const style = getComputedStyle(node);
			if (style.backgroundImage && style.backgroundImage !== 'none') return null;
			const colour = parse(style.backgroundColor);
			if (colour && colour.a > 0) { layers.push(colour); if (colour.a >= 1) break; }
		}
		let painted: Rgba = { r: 255, g: 255, b: 255, a: 1 };
		for (const layer of layers.reverse()) painted = over(layer, painted);
		return painted;
	};
	const visible = (element: Element) => {
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
	};
	const label = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || element.getAttribute('aria-label') || element.tagName.toLowerCase();
	const contrast: string[] = [];
	const seen = new Set<string>();
	for (const element of Array.from(document.body.querySelectorAll('*'))) {
		const own = Array.from(element.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? '').trim().length > 0);
		if (!own || !visible(element)) continue;
		const style = getComputedStyle(element);
		const bg = backdrop(element);
		const fg = parse(style.color);
		if (!bg || !fg) continue;
		const size = parseFloat(style.fontSize);
		const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
		const needed = large ? 3 : 4.5;
		const value = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
		const text = label(element);
		if (value + 0.01 < needed && !seen.has(text)) {
			seen.add(text);
			contrast.push(`"${text}" is hard to read: contrast ${value.toFixed(1)}:1, needs ${needed}:1`);
		}
	}
	const targets: string[] = [];
	if (phone) for (const element of Array.from(document.body.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], summary'))) {
		if (!visible(element)) continue;
		const rect = element.getBoundingClientRect();
		const field = /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName);
		const inline = element.tagName === 'A' && getComputedStyle(element).display === 'inline' && element.parentElement?.tagName === 'P';
		if (inline) continue;
		const small = field ? rect.height < 43.5 : rect.height < 43.5 || rect.width < 43.5;
		if (small) targets.push(`"${label(element)}" is ${Math.round(rect.width)}×${Math.round(rect.height)}px; make it at least 44×44`);
	}
	const root = document.scrollingElement ?? document.documentElement;
	const overflow = root.scrollWidth > root.clientWidth + 1;
	return { contrast: contrast.slice(0, 6), targets: targets.slice(0, 6), overflow };
}

export async function openLocalDesignAudit(browser: Browser) {
	return {
		async audit(states: readonly { id: string; document: string }[], signal?: AbortSignal): Promise<DesignAuditResult[]> {
			if (!Array.isArray(states) || states.length === 0 || states.length > 24) throw new Error('Invalid state inventory');
			const results: DesignAuditResult[] = [];
			for (const state of states) for (const viewport of VIEWPORTS) {
				signal?.throwIfAborted();
				if (typeof state.document !== 'string' || state.document.length > 5 * 1024 * 1024) throw new Error('Invalid document');
				const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block' });
				try {
					await context.route('**/*', (route) => route.abort());
					const page = await context.newPage();
					await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe title="Audit"></iframe></body></html>');
					const loaded = page.waitForEvent('framenavigated', { predicate: (frame) => frame.parentFrame() === page.mainFrame() && frame.url() === 'about:srcdoc', timeout: 10_000 });
					await page.locator('iframe').evaluate((frame, html) => { frame.setAttribute('sandbox', ''); (frame as HTMLIFrameElement).srcdoc = html; }, state.document);
					const frame = await loaded;
					await frame.waitForLoadState('load', { timeout: 10_000 });
					const measured = await frame.evaluate(measure, viewport.name === 'phone');
					results.push({ stateId: state.id, viewport: viewport.name, ...measured });
				} finally {
					await context.close();
				}
			}
			return results;
		},
	};
}
