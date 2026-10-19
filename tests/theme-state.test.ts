import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DEFAULT_THEME,
	PALETTE_KEY,
	PALETTE_META,
	PALETTES,
	THEME_KEY,
	applyTheme,
	currentTheme,
	readStoredTheme,
	saveThemeChoice,
	themeCanvas,
	type ThemeChoice,
	type ThemeStorage,
} from '../apps/app/src/client/theme.ts';

/**
 * Theme state (apps/app/src/client/theme.ts) and its pre-paint twin, the
 * inline script in apps/app/index.html. Both must read the same storage the
 * same way; loading never writes; a pick writes only the key that changed.
 */

const ROOT = join(import.meta.dir, '..');

class MemoryStorage implements ThemeStorage {
	readonly data = new Map<string, string>();
	writes: string[] = [];
	constructor(seed: Record<string, string> = {}) {
		for (const [key, value] of Object.entries(seed)) this.data.set(key, value);
	}
	getItem(key: string) {
		return this.data.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.writes.push(key);
		this.data.set(key, value);
	}
}

class ThrowingStorage implements ThemeStorage {
	getItem(): string | null {
		throw new Error('SecurityError');
	}
	setItem(): void {
		throw new Error('SecurityError');
	}
}

/** Attribute bag standing in for <html>. */
class FakeRoot {
	readonly attrs = new Map<string, string>();
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
}

const CASES: { name: string; seed: Record<string, string>; expected: ThemeChoice }[] = [
	{ name: 'nothing saved -> Caddie dark', seed: {}, expected: { palette: 'caddie', mode: 'dark' } },
	{ name: 'legacy light (pre-palette key) -> Caddie light', seed: { [THEME_KEY]: 'light' }, expected: { palette: 'caddie', mode: 'light' } },
	{ name: 'legacy dark -> Caddie dark', seed: { [THEME_KEY]: 'dark' }, expected: { palette: 'caddie', mode: 'dark' } },
	{ name: 'palette + light', seed: { [THEME_KEY]: 'light', [PALETTE_KEY]: 'onesecos' }, expected: { palette: 'onesecos', mode: 'light' } },
	{ name: 'palette alone keeps dark', seed: { [PALETTE_KEY]: 'farmhand' }, expected: { palette: 'farmhand', mode: 'dark' } },
	{ name: 'clearcut', seed: { [PALETTE_KEY]: 'clearcut', [THEME_KEY]: 'dark' }, expected: { palette: 'clearcut', mode: 'dark' } },
	{ name: 'unknown palette -> Caddie', seed: { [PALETTE_KEY]: 'solarized', [THEME_KEY]: 'light' }, expected: { palette: 'caddie', mode: 'light' } },
	{ name: 'junk mode -> dark', seed: { [THEME_KEY]: 'clearcut-light' }, expected: { palette: 'caddie', mode: 'dark' } },
];

/** The <head> meta tags the theme recolours (theme-color, the iOS status bar). */
class FakeHead {
	readonly metas = new Map<string, FakeRoot>([
		['theme-color', new FakeRoot()],
		['apple-mobile-web-app-status-bar-style', new FakeRoot()],
	]);
	querySelector(selector: string) {
		const name = selector.match(/^meta\[name="([^"]+)"\]$/)?.[1];
		return (name && this.metas.get(name)) || null;
	}
	content(name: string) {
		return this.metas.get(name)?.getAttribute('content') ?? null;
	}
}

/** Run the real inline script from index.html against a storage + fake <html>. */
function runBootScript(storage: ThemeStorage, head: FakeHead = new FakeHead()): FakeRoot {
	const html = readFileSync(join(ROOT, 'apps', 'app', 'index.html'), 'utf8');
	const script = html.match(/<script data-theme-boot>([\s\S]*?)<\/script>/)?.[1];
	if (!script) throw new Error('index.html has no <script data-theme-boot>');
	const root = new FakeRoot();
	new Function('localStorage', 'document', script)(storage, { documentElement: root, querySelector: (s: string) => head.querySelector(s) });
	return root;
}

describe('readStoredTheme', () => {
	for (const { name, seed, expected } of CASES) {
		test(name, () => {
			const storage = new MemoryStorage(seed);
			expect(readStoredTheme(storage)).toEqual(expected);
			expect(storage.writes).toEqual([]);
		});
	}

	test('storage that throws, or none at all, reads as the default', () => {
		expect(readStoredTheme(new ThrowingStorage())).toEqual(DEFAULT_THEME);
		expect(readStoredTheme(null)).toEqual(DEFAULT_THEME);
	});
});

describe('pre-paint script in index.html', () => {
	for (const { name, seed, expected } of CASES) {
		test(`matches readStoredTheme: ${name}`, () => {
			const storage = new MemoryStorage(seed);
			const root = runBootScript(storage);
			expect({ mode: root.getAttribute('data-theme'), palette: root.getAttribute('data-palette') }).toEqual(expected);
			expect(storage.writes).toEqual([]);
		});
	}

	test('throwing storage still applies the default', () => {
		const root = runBootScript(new ThrowingStorage());
		expect([root.getAttribute('data-theme'), root.getAttribute('data-palette')]).toEqual(['dark', 'caddie']);
	});

	test('knows every shipped palette', () => {
		for (const palette of PALETTES) {
			const root = runBootScript(new MemoryStorage({ [PALETTE_KEY]: palette }));
			expect(root.getAttribute('data-palette')).toBe(palette);
		}
	});

	test('colours the phone status bar with the saved canvas, for every palette x mode', () => {
		for (const palette of PALETTES) {
			for (const mode of ['dark', 'light'] as const) {
				const head = new FakeHead();
				runBootScript(new MemoryStorage({ [PALETTE_KEY]: palette, [THEME_KEY]: mode }), head);
				expect({ palette, mode, color: head.content('theme-color') }).toEqual({ palette, mode, color: themeCanvas({ palette, mode }) });
				// Light text over a light canvas is unreadable: light mode asks iOS for its own bar.
				expect({ palette, mode, bar: head.content('apple-mobile-web-app-status-bar-style') }).toEqual({
					palette,
					mode,
					bar: mode === 'light' ? 'default' : 'black-translucent',
				});
			}
		}
	});

	test('a page without the meta tags still gets its theme', () => {
		const root = new FakeRoot();
		const script = readFileSync(join(ROOT, 'apps', 'app', 'index.html'), 'utf8').match(/<script data-theme-boot>([\s\S]*?)<\/script>/)![1]!;
		new Function('localStorage', 'document', script)(new MemoryStorage({ [THEME_KEY]: 'light' }), { documentElement: root });
		expect(root.getAttribute('data-theme')).toBe('light');
	});
});

describe('theme-color', () => {
	test('is the palette canvas (the swatch the picker shows, kept equal to tokens.css below)', () => {
		for (const palette of PALETTES) {
			expect(themeCanvas({ palette, mode: 'dark' })).toBe(PALETTE_META[palette].swatch.dark[0]);
			expect(themeCanvas({ palette, mode: 'light' })).toBe(PALETTE_META[palette].swatch.light[0]);
		}
	});

	test('applyTheme recolours it when the user picks a theme', () => {
		const head = new FakeHead();
		const root = Object.assign(new FakeRoot(), { ownerDocument: head });
		applyTheme({ palette: 'farmhand', mode: 'light' }, root as unknown as Element);
		expect(head.content('theme-color')).toBe(PALETTE_META.farmhand.swatch.light[0]);
		// No document (a harness root): attributes only, nothing thrown.
		expect(() => applyTheme(DEFAULT_THEME, new FakeRoot() as unknown as Element)).not.toThrow();
	});
});

describe('apply + save', () => {
	test('applyTheme sets both attributes; currentTheme reads them back', () => {
		const root = new FakeRoot();
		applyTheme({ palette: 'clearcut', mode: 'light' }, root as unknown as Element);
		expect(root.attrs.get('data-theme')).toBe('light');
		expect(root.attrs.get('data-palette')).toBe('clearcut');
		expect(currentTheme(root as unknown as Element)).toEqual({ palette: 'clearcut', mode: 'light' });
	});

	test('currentTheme tolerates a bare <html> (no attributes yet)', () => {
		expect(currentTheme(new FakeRoot() as unknown as Element)).toEqual(DEFAULT_THEME);
	});

	test('flipping the mode writes only caddie-theme, so no palette gets pinned', () => {
		const storage = new MemoryStorage();
		saveThemeChoice(storage, { palette: 'caddie', mode: 'light' }, DEFAULT_THEME);
		expect(storage.writes).toEqual([THEME_KEY]);
		expect(storage.data.get(THEME_KEY)).toBe('light');
		expect(storage.data.has(PALETTE_KEY)).toBe(false);
	});

	test('picking a palette writes only caddie-palette', () => {
		const storage = new MemoryStorage({ [THEME_KEY]: 'light' });
		saveThemeChoice(storage, { palette: 'farmhand', mode: 'light' }, { palette: 'caddie', mode: 'light' });
		expect(storage.writes).toEqual([PALETTE_KEY]);
		expect(readStoredTheme(storage)).toEqual({ palette: 'farmhand', mode: 'light' });
	});

	test('re-picking the current choice writes nothing; throwing storage is swallowed', () => {
		const storage = new MemoryStorage();
		saveThemeChoice(storage, DEFAULT_THEME, DEFAULT_THEME);
		expect(storage.writes).toEqual([]);
		expect(() => saveThemeChoice(new ThrowingStorage(), { palette: 'onesecos', mode: 'dark' }, DEFAULT_THEME)).not.toThrow();
	});
});

describe('picker swatches', () => {
	test('match the canvas + primary seeds in tokens.css for every palette x mode', () => {
		const css = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const seed = (selector: string, name: string) => {
			const start = css.indexOf(`${selector} {`);
			if (start < 0) throw new Error(`no block ${selector}`);
			const body = css.slice(start, css.indexOf('}', start));
			return body.match(new RegExp(`--seed-${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase();
		};
		for (const palette of PALETTES) {
			const dark = palette === 'caddie' ? ':root' : `:root[data-palette="${palette}"]`;
			const light = palette === 'caddie' ? ':root[data-theme="light"]' : `:root[data-palette="${palette}"][data-theme="light"]`;
			const { swatch } = PALETTE_META[palette];
			expect({ palette, dark: [...swatch.dark] }).toEqual({ palette, dark: [seed(dark, 'bg'), seed(dark, 'primary')] as string[] });
			expect({ palette, light: [...swatch.light] }).toEqual({ palette, light: [seed(light, 'bg'), seed(light, 'primary')] as string[] });
		}
	});
});
