import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = pathToFileURL(join(HERE, '..', 'mock', 'brief-cards-mock.html')).href;
const OUT = join(HERE, '..', 'shots');

const browser = await chromium.launch({ headless: true });
try {
	for (const [name, width] of [['mock-desktop', 1280], ['mock-phone', 390]] as const) {
		const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
		const page = await ctx.newPage();
		await page.goto(MOCK);
		await page.waitForTimeout(400);
		await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
		console.log(`shot ${name}`);
		await ctx.close();
	}
} finally {
	await browser.close();
}
