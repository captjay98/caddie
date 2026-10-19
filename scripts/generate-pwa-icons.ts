#!/usr/bin/env bun
/**
 * Draw Caddie's install icons from the brand mark, apps/site/public/favicon.svg
 * (the ring and dot on the dark canvas), with the Chromium that Playwright
 * already installs for the browser tests:
 *
 *   bun scripts/generate-pwa-icons.ts
 *
 * Writes, under apps/app/public/:
 *   icons/icon-192.png, icons/icon-512.png  the mark as is: rounded corners, transparent outside them
 *   icons/icon-maskable-512.png             full-bleed square; Android cuts its own shape, and the
 *                                           ring stays inside the maskable safe zone (80% circle)
 *   apple-touch-icon.png (180)              full-bleed square; iOS rounds the corners itself and
 *                                           would paint transparent corners black
 * tests/pwa.test.ts checks every size and corner.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = join(import.meta.dir, '..');
const PUBLIC = join(ROOT, 'apps', 'app', 'public');
const mark = readFileSync(join(ROOT, 'apps', 'site', 'public', 'favicon.svg'), 'utf8');
if (!mark.includes('rx="14"')) throw new Error('favicon.svg changed shape: update the full-bleed variant below');
const fullBleed = mark.replace('rx="14"', 'rx="0"');

const targets: { file: string; size: number; svg: string }[] = [
	{ file: 'icons/icon-192.png', size: 192, svg: mark },
	{ file: 'icons/icon-512.png', size: 512, svg: mark },
	{ file: 'icons/icon-maskable-512.png', size: 512, svg: fullBleed },
	{ file: 'apple-touch-icon.png', size: 180, svg: fullBleed },
];

mkdirSync(join(PUBLIC, 'icons'), { recursive: true });
const browser = await chromium.launch();
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	for (const { file, size, svg } of targets) {
		await page.setViewportSize({ width: size, height: size });
		const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
		await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
		await page.screenshot({ path: join(PUBLIC, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
		console.log(`wrote apps/app/public/${file} (${size}x${size})`);
	}
} finally {
	await browser.close();
}
