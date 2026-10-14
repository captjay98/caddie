import { describe, expect, test } from 'bun:test';
import type * as ReactTypes from '../apps/app/node_modules/@types/react/index.d.ts';
import type * as ReactDomServerTypes from '../apps/app/node_modules/@types/react-dom/server.d.ts';
import { ThemePicker } from '../apps/app/src/client/workspace/ThemePicker.tsx';
import { PALETTE_META, PALETTES, type Palette, type ThemeMode } from '../apps/app/src/client/theme.ts';

// The root test project has no React of its own. Load the app's copy (the same
// instance the component uses) at runtime, typed by the app's @types.
const REACT_DOM_SERVER_PATH = '../apps/app/node_modules/react-dom/server.js';
const REACT_PATH = '../apps/app/node_modules/react/index.js';
const { renderToStaticMarkup } = (await import(REACT_DOM_SERVER_PATH)) as typeof ReactDomServerTypes;
const { createElement } = (await import(REACT_PATH)) as typeof ReactTypes;

/**
 * ThemePicker markup: the ARIA shape per host, which option is checked, the
 * roving tabindex in the Settings panel, and swatches previewing the palette
 * in the CURRENT mode. Click/arrow behaviour needs a real DOM and is covered
 * by the Stage 4 browser run.
 */

const render = (variant: 'menu' | 'panel', palette: Palette, mode: ThemeMode) =>
	renderToStaticMarkup(createElement(ThemePicker, { variant, palette, mode, onChange: () => {} }));

/** The opening tag of the element carrying `data-testid="<id>"`. */
const tagFor = (html: string, id: string): string => {
	const match = html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`));
	if (!match) throw new Error(`no element ${id}`);
	return match[0];
};

describe('ThemePicker', () => {
	test('one swatch per palette plus Dark and Light', () => {
		const html = render('menu', 'caddie', 'dark');
		for (const palette of PALETTES) expect(html).toContain(`data-testid="theme-swatch-${palette}"`);
		expect(html).toContain('data-testid="theme-mode-dark"');
		expect(html).toContain('data-testid="theme-mode-light"');
	});

	test('menu host: menuitemradio inside groups, every option a Tab stop', () => {
		const html = render('menu', 'onesecos', 'light');
		expect(html.match(/role="group"/g)?.length).toBe(2);
		expect(html).not.toContain('role="radiogroup"');
		expect(html.match(/role="menuitemradio"/g)?.length).toBe(PALETTES.length + 2);
		expect(html).not.toContain('tabindex=');
		expect(tagFor(html, 'theme-swatch-onesecos')).toContain('aria-checked="true"');
		expect(tagFor(html, 'theme-swatch-caddie')).toContain('aria-checked="false"');
		expect(tagFor(html, 'theme-mode-light')).toContain('aria-checked="true"');
		expect(tagFor(html, 'theme-mode-dark')).toContain('aria-checked="false"');
	});

	test('panel host: radiogroups with a roving tabindex on the checked option', () => {
		const html = render('panel', 'farmhand', 'dark');
		expect(html.match(/role="radiogroup"/g)?.length).toBe(2);
		expect(html.match(/role="radio"/g)?.length).toBe(PALETTES.length + 2);
		for (const palette of PALETTES) {
			expect(tagFor(html, `theme-swatch-${palette}`)).toContain(`tabindex="${palette === 'farmhand' ? 0 : -1}"`);
		}
		expect(tagFor(html, 'theme-mode-dark')).toContain('tabindex="0"');
		expect(tagFor(html, 'theme-mode-light')).toContain('tabindex="-1"');
	});

	test('each option has an accessible name', () => {
		const html = render('panel', 'caddie', 'dark');
		expect(tagFor(html, 'theme-swatch-clearcut')).toContain('aria-label="Amber palette"');
		expect(tagFor(html, 'theme-mode-light')).toContain('aria-label="Light mode"');
	});

	test('swatches preview each palette in the current mode', () => {
		for (const mode of ['dark', 'light'] as const) {
			const html = render('menu', 'caddie', mode);
			for (const palette of PALETTES) {
				const [canvas, accent] = PALETTE_META[palette].swatch[mode];
				expect(html).toContain(`--swatch-canvas:${canvas};--swatch-accent:${accent}`);
			}
		}
	});
});
