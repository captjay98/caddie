import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Theme palettes (packages/ui/src/tokens.css). Two attributes on <html>:
 * `data-theme` = mode (dark default | light), `data-palette` = palette
 * (caddie default | clearcut | onesecos | farmhand). A palette block may set
 * only seeds, both of a palette's blocks must set the same full seed list (so
 * nothing falls through to Caddie's seeds), and every palette x mode must
 * clear the WCAG 4.5:1 floor on the pairs the app actually renders.
 */

const CSS = readFileSync(join(import.meta.dir, '..', 'packages', 'ui', 'src', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const blocks = new Map<string, Map<string, string>>();
for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
	const selector = match[1]!.trim();
	const decls = new Map<string, string>();
	for (const decl of match[2]!.split(';')) {
		const at = decl.indexOf(':');
		if (at > 0) decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
	}
	blocks.set(selector, decls);
}

const PALETTES = ['clearcut', 'onesecos', 'farmhand'] as const;
const modeSelectors = (palette: string) => palette === 'caddie'
	? { dark: ':root', light: ':root[data-theme="light"]' }
	: { dark: `:root[data-palette="${palette}"]`, light: `:root[data-palette="${palette}"][data-theme="light"]` };

/** Seeds a palette must own: every :root seed except the shared radius. */
const PALETTE_SEEDS = [...blocks.get(':root')!.keys()].filter((key) => key.startsWith('--seed-') && key !== '--seed-radius').sort();

/** Resolved seeds for one palette x mode, following the real cascade order. */
function seedsFor(palette: string, mode: 'dark' | 'light'): Record<string, string> {
	const chain = [':root'];
	if (mode === 'light') chain.push(':root[data-theme="light"]');
	if (palette !== 'caddie') {
		chain.push(`:root[data-palette="${palette}"]`);
		if (mode === 'light') chain.push(`:root[data-palette="${palette}"][data-theme="light"]`);
	}
	const out: Record<string, string> = {};
	for (const selector of chain) for (const [key, value] of blocks.get(selector)!) out[key] = value;
	return out;
}

const luminance = (hex: string): number => {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
};

describe('theme palettes', () => {
	test('each palette has a dark block and a compound light block', () => {
		for (const palette of PALETTES) {
			const { dark, light } = modeSelectors(palette);
			expect(blocks.has(dark)).toBe(true);
			expect(blocks.has(light)).toBe(true);
		}
	});

	test('palette blocks set only seeds, and both modes set the full seed list', () => {
		for (const palette of ['caddie', ...PALETTES]) {
			for (const selector of Object.values(modeSelectors(palette))) {
				const keys = [...blocks.get(selector)!.keys()];
				const seeds = keys.filter((key) => key.startsWith('--seed-') && key !== '--seed-radius').sort();
				expect({ selector, seeds }).toEqual({ selector, seeds: PALETTE_SEEDS });
				if (selector !== ':root') {
					expect({ selector, nonSeed: keys.filter((key) => !key.startsWith('--seed-')) }).toEqual({ selector, nonSeed: [] });
				}
			}
		}
	});

	test('the derived layer is declared once and reads only seeds', () => {
		const derived = [...blocks.get(':root')!].filter(([key]) => key.startsWith('--color-'));
		expect(derived.length).toBeGreaterThan(10);
		for (const [key, value] of derived) expect({ key, value: /#[0-9a-f]{3,8}\b/i.test(value) }).toEqual({ key, value: false });
		expect(blocks.get(':root')!.get('--card-gradient')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});

	test('every palette x mode clears 4.5:1 on the rendered pairs', () => {
		const failures: string[] = [];
		for (const palette of ['caddie', ...PALETTES]) {
			for (const mode of ['dark', 'light'] as const) {
				const s = seedsFor(palette, mode);
				const seed = (name: string) => {
					const value = s[`--seed-${name}`]!;
					expect(value).toMatch(/^#[0-9a-f]{6}$/i);
					return value;
				};
				const pairs: [string, string, string][] = [];
				for (const ground of ['bg', 'surface', 'raised', 'lift']) for (const text of ['fg', 'muted']) pairs.push([text, ground, `${text}/${ground}`]);
				for (const ground of ['bg', 'surface']) for (const text of ['primary', 'accent', 'ok', 'danger']) pairs.push([text, ground, `${text}/${ground}`]);
				// Filled actions: --color-ink label on the action -> action-deep gradient.
				pairs.push(['bg', 'primary', 'ink-label/primary'], ['bg', 'primary-deep', 'ink-label/primary-deep']);
				for (const [a, b, label] of pairs) {
					const ratio = contrast(seed(a), seed(b));
					if (ratio < 4.5) failures.push(`${palette}-${mode} ${label} ${ratio.toFixed(2)}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test('Caddie stays the default: unattributed :root keeps the shipped seeds', () => {
		const dark = seedsFor('caddie', 'dark');
		const light = seedsFor('caddie', 'light');
		expect([dark['--seed-bg'], dark['--seed-primary']]).toEqual(['#090b10', '#4d9fff']);
		expect([light['--seed-bg'], light['--seed-primary']]).toEqual(['#f6f8fc', '#155fbe']);
	});
});
