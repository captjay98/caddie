import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * D14 — the interactive preview iframe may ask for location (part O).
 *
 * The interactive preview iframe (the one judges try apps in,
 * name="caddie-interactive-preview") gains allow="geolocation" so a generated
 * app can call navigator.geolocation in the preview. Nothing else about the
 * iframe changes: the sandbox stays allow-scripts allow-forms.
 *
 * This pins the EXACT change by reading the real source; the granted-location
 * behaviour is proven in real Chromium in
 * tests/browser/interactive-preview.spec.ts.
 * LOCAL VERIFIED.
 */

const PREVIEW = join(import.meta.dir, '..', 'apps', 'app', 'src', 'client', 'artifacts', 'InteractivePreview.tsx');

function interactiveFrame(src: string): string {
	const marker = src.indexOf('name="caddie-interactive-preview"');
	if (marker === -1) throw new Error('interactive preview iframe not found');
	const open = src.lastIndexOf('<iframe', marker);
	const close = src.indexOf('/>', marker);
	return src.slice(open, close);
}

describe('D14: location is allowed on the interactive preview iframe', () => {
	test('the interactive preview iframe carries allow="geolocation"', () => {
		expect(interactiveFrame(readFileSync(PREVIEW, 'utf8'))).toContain('allow="geolocation"');
	});

	test('native storage is granted only to an isolated launch; opaque frames retain scripts/forms only', () => {
		expect(interactiveFrame(readFileSync(PREVIEW, 'utf8'))).toContain("loaded.nativeStorage ? 'allow-scripts allow-forms allow-same-origin' : 'allow-scripts allow-forms'");
	});

	test('only geolocation is granted — no camera, microphone or wider allow list', () => {
		const frame = interactiveFrame(readFileSync(PREVIEW, 'utf8'));
		const allow = frame.match(/allow="([^"]*)"/);
		expect(allow?.[1]).toBe('geolocation');
	});
});
