import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewDocument } from '../apps/app/src/shared/preview-frame.ts';

/**
 * D13 and D14 — opening the preview for maps and location (part O).
 *
 * D13: the preview frame's CSP img-src gains exactly one tile host,
 *      https://tile.openstreetmap.org, so Leaflet's OpenStreetMap tiles load
 *      in the preview. Nothing else in the CSP changes, and data:/blob: stay.
 *
 * This pins the EXACT change by reading the real source. D14 (location) is
 * pinned in tests/preview-location.test.ts and proven in real Chromium in
 * tests/browser/interactive-preview.spec.ts.
 * LOCAL VERIFIED.
 */

const ROOT = join(import.meta.dir, '..');
const FRAME = join(ROOT, 'apps', 'app', 'src', 'shared', 'preview-frame.ts');

function cspOf(html: string): string {
	const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
	if (!match) throw new Error('no CSP meta tag in the preview document');
	return match[1]!;
}

function imgSrcOf(csp: string): string {
	const directive = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src'));
	if (!directive) throw new Error('no img-src directive in the CSP');
	return directive;
}

describe('D13: the preview frame allows OpenStreetMap tiles, and only those', () => {
	test('a web preview document carries the one tile host in img-src, keeping data: and blob:', () => {
		const csp = cspOf(previewDocument('<p>app</p>', 'nonce', {}, false, 'web'));
		const imgSrc = imgSrcOf(csp);
		expect(imgSrc).toContain('https://tile.openstreetmap.org');
		expect(imgSrc).toContain('data:');
		expect(imgSrc).toContain('blob:');
	});

	test('the one tile host is a plain https host, not a wildcard or a scheme opening', () => {
		const imgSrc = imgSrcOf(cspOf(previewDocument('<p>app</p>', 'nonce', {}, false, 'web')));
		// No wildcard host and no bare https: scheme that would allow any site.
		expect(imgSrc).not.toContain('*');
		expect(imgSrc).not.toMatch(/\bhttps:(?!\/\/)/);
	});

	test('only img-src changes: connect-src and frame-src stay fully locked', () => {
		const csp = cspOf(previewDocument('<p>app</p>', 'nonce', {}, false, 'web'));
		expect(csp).toContain("connect-src 'none'");
		expect(csp).toContain("frame-src 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("default-src 'none'");
		// The tile host is allowed for images only — never for connect or frame.
		expect(csp).not.toMatch(/connect-src[^;]*tile\.openstreetmap/);
	});

	test('the source pins the exact tile host on the img-src line', () => {
		const src = readFileSync(FRAME, 'utf8');
		expect(src).toContain('img-src data: blob: https://tile.openstreetmap.org;');
	});
});
