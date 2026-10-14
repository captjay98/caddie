import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Theme-picker browser click-through — the LIVE verification that
 * tests/theme-picker.test.ts (component / jsdom) and tests/theme-tokens.test.ts
 * (CSS seeds) cannot give: the REAL ThemePicker (variant="panel") driven in a
 * real Chromium with real clicks and real arrow keys, wired to the REAL
 * theme.ts helpers exactly as the shell's setThemeChoice wires them
 * (tests/fixtures/theme-harness/main.tsx). It proves end to end that:
 *   - clicking a palette swatch sets <html data-palette> and persists
 *     caddie-palette; clicking a mode sets <html data-theme> and persists
 *     caddie-theme — each key written only when its own axis changes;
 *   - the WAI-ARIA roving radio pattern works under the keyboard: arrows move
 *     + select and roll around, Home/End jump, and aria-checked tracks;
 *   - the choice actually RECOLOURS the page (computed canvas colour changes
 *     across palettes), so the picker drives real styles, not just attributes.
 *
 * Served exactly like tests/browser/settings.spec.ts: the real component
 * sources are bundled with Bun and served by this spec's own local HTTP server
 * with the real tokens.css + workspace.css. No /api traffic exists here.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'theme-harness');
const TOKENS_CSS = join(REPO_ROOT, 'packages', 'ui', 'src', 'tokens.css');
const WORKSPACE_CSS = join(REPO_ROOT, 'apps', 'app', 'src', 'client', 'workspace.css');
const PORT = 4190;
const BASE = `http://127.0.0.1:${PORT}`;

let server: Server | null = null;
let buildDir: string | null = null;
let linkCreated = false;

async function startHarness(): Promise<void> {
	// Same node_modules bridge the settings harness uses: Bun resolves bare
	// imports by walking up from the entry, which never reaches apps/app's
	// node_modules. Link them in for the run (node_modules is gitignored).
	const link = join(HARNESS_DIR, 'node_modules');
	const target = join(REPO_ROOT, 'apps', 'app', 'node_modules');
	rmSync(link, { force: true, recursive: true });
	symlinkSync(target, link, 'dir');
	linkCreated = true;

	buildDir = mkdtempSync(join(tmpdir(), 'theme-harness-'));
	execFileSync('bun', [
		'build',
		join(HARNESS_DIR, 'main.tsx'),
		'--outdir',
		buildDir,
		'--target',
		'browser',
		'--format',
		'esm',
		'--define',
		'process.env.NODE_ENV="development"',
	], { cwd: REPO_ROOT, stdio: 'pipe' });
	if (!existsSync(join(buildDir, 'main.js'))) {
		throw new Error('theme harness bundle did not produce main.js');
	}

	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', BASE);
		const send = (body: string, type: string) => {
			res.writeHead(200, { 'content-type': type });
			res.end(body);
		};
		if (url.pathname === '/' || url.pathname === '/index.html') {
			send(readFileSync(join(HARNESS_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
			return;
		}
		if (url.pathname === '/main.js') {
			send(readFileSync(join(buildDir!, 'main.js'), 'utf8'), 'text/javascript; charset=utf-8');
			return;
		}
		if (url.pathname === '/tokens.css') {
			send(readFileSync(TOKENS_CSS, 'utf8'), 'text/css; charset=utf-8');
			return;
		}
		if (url.pathname === '/workspace.css') {
			send(readFileSync(WORKSPACE_CSS, 'utf8'), 'text/css; charset=utf-8');
			return;
		}
		send(readFileSync(join(HARNESS_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
	});
	await new Promise<void>((resolve, reject) => {
		server!.once('error', reject);
		server!.listen(PORT, '127.0.0.1', () => resolve());
	});
}

test.beforeAll(async () => {
	if (!existsSync(join(HARNESS_DIR, 'main.tsx'))) {
		throw new Error('harness entry missing: tests/fixtures/theme-harness/main.tsx');
	}
	await startHarness();
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	if (buildDir) rmSync(buildDir, { recursive: true, force: true });
	if (linkCreated) rmSync(join(HARNESS_DIR, 'node_modules'), { force: true, recursive: true });
});

const PALETTES = ['caddie', 'clearcut', 'onesecos', 'farmhand'] as const;

function htmlAttr(page: import('@playwright/test').Page, name: string) {
	return page.evaluate((n) => document.documentElement.getAttribute(n), name);
}
function storageValue(page: import('@playwright/test').Page, key: string) {
	return page.evaluate((k) => localStorage.getItem(k), key);
}

test.describe('ThemePicker live click-through (real component + real theme.ts)', () => {
	test.beforeEach(async ({ page }) => {
		// Fresh storage every test so persistence assertions start clean, and
		// land on the harness baseline (caddie / dark) applied pre-paint.
		await page.addInitScript(() => localStorage.clear());
		await page.goto(`${BASE}/`);
		await expect(page.getByTestId('theme-picker-panel')).toBeVisible();
		expect(await htmlAttr(page, 'data-palette')).toBe('caddie');
		expect(await htmlAttr(page, 'data-theme')).toBe('dark');
	});

	test('clicking a palette swatch sets data-palette and persists only caddie-palette', async ({ page }) => {
		await page.getByTestId('theme-swatch-onesecos').click();

		expect(await htmlAttr(page, 'data-palette')).toBe('onesecos');
		expect(await htmlAttr(page, 'data-theme')).toBe('dark'); // mode untouched
		expect(await storageValue(page, 'caddie-palette')).toBe('onesecos');
		// mode key is NOT written when only the palette changed (saveThemeChoice contract)
		expect(await storageValue(page, 'caddie-theme')).toBeNull();

		// aria-checked follows selection; exactly one swatch checked
		await expect(page.getByTestId('theme-swatch-onesecos')).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByTestId('theme-swatch-caddie')).toHaveAttribute('aria-checked', 'false');
	});

	test('clicking Light sets data-theme and persists only caddie-theme', async ({ page }) => {
		await page.getByTestId('theme-mode-light').click();

		expect(await htmlAttr(page, 'data-theme')).toBe('light');
		expect(await htmlAttr(page, 'data-palette')).toBe('caddie'); // palette untouched
		expect(await storageValue(page, 'caddie-theme')).toBe('light');
		expect(await storageValue(page, 'caddie-palette')).toBeNull();

		await expect(page.getByTestId('theme-mode-light')).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByTestId('theme-mode-dark')).toHaveAttribute('aria-checked', 'false');
	});

	test('palette and mode are independent and both persist when both change', async ({ page }) => {
		await page.getByTestId('theme-swatch-farmhand').click();
		await page.getByTestId('theme-mode-light').click();

		expect(await htmlAttr(page, 'data-palette')).toBe('farmhand');
		expect(await htmlAttr(page, 'data-theme')).toBe('light');
		expect(await storageValue(page, 'caddie-palette')).toBe('farmhand');
		expect(await storageValue(page, 'caddie-theme')).toBe('light');
	});

	test('keyboard: roving radiogroup moves + selects with arrows, rolls around, Home/End jump', async ({ page }) => {
		// Tab into the palette group — it enters on the checked option (caddie, index 0).
		const caddie = page.getByTestId('theme-swatch-caddie');
		await caddie.focus();
		await expect(caddie).toBeFocused();

		// ArrowRight selects + focuses the next palette, and so on round the row.
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('theme-swatch-clearcut')).toBeFocused();
		expect(await htmlAttr(page, 'data-palette')).toBe('clearcut');

		await page.keyboard.press('ArrowRight');
		expect(await htmlAttr(page, 'data-palette')).toBe('onesecos');
		await page.keyboard.press('ArrowRight');
		expect(await htmlAttr(page, 'data-palette')).toBe('farmhand');

		// rolls around to the first
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('theme-swatch-caddie')).toBeFocused();
		expect(await htmlAttr(page, 'data-palette')).toBe('caddie');

		// ArrowLeft wraps backwards to the last
		await page.keyboard.press('ArrowLeft');
		expect(await htmlAttr(page, 'data-palette')).toBe('farmhand');

		// End jumps to last, Home to first
		await page.keyboard.press('Home');
		expect(await htmlAttr(page, 'data-palette')).toBe('caddie');
		await page.keyboard.press('End');
		expect(await htmlAttr(page, 'data-palette')).toBe('farmhand');

		// the mode group is an independent roving group
		await page.getByTestId('theme-mode-dark').focus();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('theme-mode-light')).toBeFocused();
		expect(await htmlAttr(page, 'data-theme')).toBe('light');
	});

	test('selecting a palette actually recolours the page (computed canvas colour changes)', async ({ page }) => {
		// Read the live seed the surfaces derive from. --seed-bg is overridden
		// per palette (and per mode) in tokens.css; it must differ across
		// palettes, which is what proves data-palette drives the cascade.
		async function canvas(): Promise<string> {
			return page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue('--seed-bg').trim(),
			);
		}
		const seen = new Set<string>();
		for (const palette of PALETTES) {
			await page.getByTestId(`theme-swatch-${palette}`).click();
			const value = await canvas();
			expect(value, `--bg-canvas should resolve for ${palette}`).not.toBe('');
			seen.add(value);
		}
		// At least three distinct canvas colours across the four palettes
		// (two palettes could coincidentally share a dark canvas; three proves
		// the attribute is really driving the cascade).
		expect(seen.size).toBeGreaterThanOrEqual(3);
	});

	test('visual evidence: capture all 8 palette×mode combinations', async ({ page }, testInfo) => {
		const shotDir = process.env.THEME_SHOT_DIR;
		for (const mode of ['dark', 'light'] as const) {
			await page.getByTestId(`theme-mode-${mode}`).click();
			for (const palette of PALETTES) {
				await page.getByTestId(`theme-swatch-${palette}`).click();
				expect(await htmlAttr(page, 'data-palette')).toBe(palette);
				expect(await htmlAttr(page, 'data-theme')).toBe(mode);
				const panel = page.getByTestId('theme-picker-panel');
				const shot = await panel.screenshot(
					shotDir ? { path: join(shotDir, `theme-${palette}-${mode}.png`) } : undefined,
				);
				await testInfo.attach(`theme-${palette}-${mode}`, { body: shot, contentType: 'image/png' });
			}
		}
	});
});
