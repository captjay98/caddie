/**
 * Projects redesign review (2026-10-21): screenshots every mockup page made by
 * build-mockups.ts (desktop 1440x900 at 1x, phone 390x844 at 2x) into
 * shots/<option>/: the first screen, then the whole page (the shell is let
 * grow, see measure.ts UNCLIP), and records each page's measures in
 * shots/measure.json. Then shoots the comparison sheets (screens/sheets/).
 * Opens the files directly (file://): fonts are inline, nothing is served.
 *
 * Run from the repo root:  bun docs/reviews/2026-10-21-projects-redesign/tools/shoot-mockups.ts [filter]
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measure, UNCLIP, type Measure } from './measure.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, '..');
const filter = process.argv[2] ?? '';

const VIEWPORTS = {
	desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
	phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
} as const;

const browser = await chromium.launch({ headless: true });
try {
	const measures: Record<string, Measure> = {};
	let count = 0;
	for (const option of readdirSync(join(REVIEW, 'screens')).filter((d) => d !== 'sheets')) {
		const dir = join(REVIEW, 'screens', option);
		mkdirSync(join(REVIEW, 'shots', option), { recursive: true });
		for (const file of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
			const name = file.replace(/\.html$/, '');
			if (filter && !`${option}/${name}`.includes(filter)) continue;
			const vp = name.endsWith('-phone') ? 'phone' : 'desktop';
			const context = await browser.newContext({ ...VIEWPORTS[vp], colorScheme: 'dark' });
			const page = await context.newPage();
			await page.goto(pathToFileURL(join(dir, file)).href);
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(250);
			if (!(await page.evaluate(() => document.fonts.check('600 16px Inter')))) throw new Error(`${option}/${name}: Inter did not load`);
			await page.screenshot({ path: join(REVIEW, 'shots', option, `${name}.png`) });
			measures[`${option}/${name}`] = await measure(page);
			await page.addStyleTag({ content: UNCLIP });
			await page.waitForTimeout(150);
			await page.screenshot({ path: join(REVIEW, 'shots', option, `${name}-full.png`), fullPage: true });
			await context.close();
			count += 1;
		}
	}
	if (!filter) writeFileSync(join(REVIEW, 'shots', 'measure.json'), `${JSON.stringify(measures, null, '\t')}\n`);
	// The comparison sheets, shot from the screenshots just taken.
	const sheets = join(REVIEW, 'screens', 'sheets');
	if (existsSync(sheets)) {
		for (const file of readdirSync(sheets).filter((f) => f.endsWith('.html'))) {
			const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
			const page = await context.newPage();
			await page.goto(pathToFileURL(join(sheets, file)).href);
			await page.evaluate(() => Promise.all(Array.from(document.images).map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r))))));
			await page.evaluate(() => document.fonts.ready);
			await page.screenshot({ path: join(REVIEW, 'shots', file.replace(/\.html$/, '.png')), fullPage: true });
			await context.close();
		}
	}
	console.log(`shot ${count} pages`);
} finally {
	await browser.close();
}
