/**
 * Theme state: a PALETTE (keys caddie/clearcut/onesecos/farmhand/kirocrew,
 * shown as Azure/Amber/Indigo/Fern/KiroCrew) and a MODE
 * (dark, light), applied as two independent attributes on <html>:
 *
 *   data-theme   = mode     ('dark' | 'light')       -- unchanged contract
 *   data-palette = palette  ('caddie' | 'clearcut' | 'onesecos' | 'farmhand' | 'kirocrew')
 *
 * packages/ui/src/tokens.css keys the seed blocks off exactly these two
 * attributes, so switching either one recolours every derived token.
 *
 * Storage. Two keys, written ONLY when the user picks (loading a page never
 * writes; shell-v2 §3.9):
 *   - `caddie-theme`   keeps its shipped meaning ('light' | 'dark') and stays
 *     shared with the landing page, so nothing stored before palettes existed
 *     needs migrating: an old 'light'/'dark' value IS the mode.
 *   - `caddie-palette` is new; absent means Caddie.
 * Anything unrecognised in either key (a hand-edited value, a palette this
 * build no longer ships) reads as the default rather than breaking the page.
 *
 * The pre-paint copy of `readStoredTheme` + `applyTheme` is the inline script
 * in apps/app/index.html; tests/theme-state.test.ts runs both against the same
 * storage cases so they cannot drift.
 */

export const THEME_KEY = 'caddie-theme';
export const PALETTE_KEY = 'caddie-palette';

export const PALETTES = ['caddie', 'clearcut', 'onesecos', 'farmhand', 'kirocrew'] as const;
export type Palette = (typeof PALETTES)[number];
export type ThemeMode = 'dark' | 'light';

export interface ThemeChoice {
	readonly palette: Palette;
	readonly mode: ThemeMode;
}

export const DEFAULT_THEME: ThemeChoice = { palette: 'caddie', mode: 'dark' };

/** Human label + the swatch colours the picker shows (canvas, accent) per mode. */
export const PALETTE_META: Readonly<Record<Palette, { readonly label: string; readonly swatch: Readonly<Record<ThemeMode, readonly [string, string]>> }>> = {
	caddie: { label: 'Azure', swatch: { dark: ['#090b10', '#4d9fff'], light: ['#f6f8fc', '#155fbe'] } },
	clearcut: { label: 'Amber', swatch: { dark: ['#14161b', '#e8a33d'], light: ['#f6f3ea', '#8a5a00'] } },
	onesecos: { label: 'Indigo', swatch: { dark: ['#0b0f14', '#6684fb'], light: ['#f7f5ec', '#3244c5'] } },
	farmhand: { label: 'Fern', swatch: { dark: ['#0f1318', '#3da35e'], light: ['#f7f5ee', '#18412c'] } },
	kirocrew: { label: 'KiroCrew', swatch: { dark: ['#0f1117', '#a06bff'], light: ['#f7f5fc', '#6a28c9'] } },
};

export function isPalette(value: unknown): value is Palette {
	return typeof value === 'string' && (PALETTES as readonly string[]).includes(value);
}

/** Minimal storage surface, so tests can pass a Map-backed fake. */
export interface ThemeStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** The saved choice, or the default for anything missing/unreadable. Never writes. */
export function readStoredTheme(storage: ThemeStorage | null): ThemeChoice {
	if (!storage) return DEFAULT_THEME;
	try {
		const mode = storage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
		const palette = storage.getItem(PALETTE_KEY);
		return { palette: isPalette(palette) ? palette : DEFAULT_THEME.palette, mode };
	} catch {
		// private mode / storage disabled: render the default, persist nothing
		return DEFAULT_THEME;
	}
}

/** Put a choice on <html>. Both attributes are always set, so CSS and tests can read them. */
export function applyTheme(choice: ThemeChoice, root: Element = document.documentElement): void {
	root.setAttribute('data-theme', choice.mode);
	root.setAttribute('data-palette', choice.palette);
}

/** The choice currently on <html> (what the pre-paint script applied). */
export function currentTheme(root: Element = document.documentElement): ThemeChoice {
	const palette = root.getAttribute('data-palette');
	return {
		palette: isPalette(palette) ? palette : DEFAULT_THEME.palette,
		mode: root.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
	};
}

/**
 * Persist an explicit user pick. Only the key that changed is written, so
 * flipping the mode never pins a palette (and vice versa).
 */
export function saveThemeChoice(storage: ThemeStorage | null, next: ThemeChoice, previous: ThemeChoice): void {
	if (!storage) return;
	try {
		if (next.mode !== previous.mode) storage.setItem(THEME_KEY, next.mode);
		if (next.palette !== previous.palette) storage.setItem(PALETTE_KEY, next.palette);
	} catch {
		// private mode: the choice stays session-only
	}
}

/** `localStorage`, or null where touching it throws (sandboxed iframes, some private modes). */
export function browserStorage(): ThemeStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}
