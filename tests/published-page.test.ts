import { describe, expect, test } from 'bun:test';
import { appManifest, publishedAssets, shortName } from '../apps/app/src/server/published-page.ts';

/**
 * Plan step 2.4, improved: a published app is installable from the browser
 * (Android: Chrome's "Install app"; iPhone: Share > Add to Home Screen)
 * because Caddie's publish step writes the page, a web app manifest and the
 * icons next to it. Nothing here depends on the app's own code, so the model
 * that builds an app cannot break it.
 */

const bundle = { js: 'console.log("app")', css: 'body{margin:0}' };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('the short name under the home-screen icon', () => {
	test('whole words up to 12 characters', () => {
		expect(shortName('Todo')).toBe('Todo');
		expect(shortName('Farm Log for Kano Growers')).toBe('Farm Log for');
		expect(shortName('  Farm   Log  ')).toBe('Farm Log');
	});

	test('a long single word is cut at 12', () => {
		expect(shortName('Supercalifragilistic')).toBe('Supercalifra');
	});

	test('an empty name falls back to "My app"', () => {
		expect(shortName('   ')).toBe('My app');
	});
});

describe('the manifest', () => {
	test('has what Chrome and iOS need to install the app on its own', () => {
		const manifest = appManifest('Farm Log for Kano Growers');
		expect(manifest).toMatchObject({
			id: '/',
			name: 'Farm Log for Kano Growers',
			short_name: 'Farm Log for',
			start_url: '/',
			scope: '/',
			display: 'standalone',
			background_color: '#ffffff',
		});
		expect(manifest.icons).toEqual([
			{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
			{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
			{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
		]);
	});

	test('sets no theme colour, since Caddie does not know the app’s colours', () => {
		expect(appManifest('Farm Log')).not.toHaveProperty('theme_color');
	});
});

describe('the published files', async () => {
	const files = await publishedAssets({ name: 'Farm <Log> & "Co"', seed: 'proj-farm' }, bundle);
	const byPath = new Map(files.map((f) => [f.path, f]));
	const html = text(byPath.get('/index.html')!.bytes);

	test('the page, its two files, the manifest and four icons', () => {
		expect(files.map((f) => f.path)).toEqual([
			'/index.html',
			'/main.js',
			'/main.css',
			'/manifest.webmanifest',
			'/icon-192.png',
			'/icon-512.png',
			'/icon-maskable-512.png',
			'/apple-touch-icon.png',
		]);
		expect(byPath.get('/manifest.webmanifest')!.contentType).toBe('application/manifest+json');
		expect(text(byPath.get('/main.js')!.bytes)).toBe(bundle.js);
		expect(text(byPath.get('/main.css')!.bytes)).toBe(bundle.css);
	});

	test('the page links the manifest, a favicon and the Apple touch icon', () => {
		expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
		expect(html).toContain('<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">');
		expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
		expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Farm &lt;Log&gt;">');
	});

	test('the name is escaped in the page and still exact in the manifest', () => {
		expect(html).toContain('<title>Farm &lt;Log&gt; &amp; "Co"</title>');
		expect(html).not.toContain('<Log>');
		const manifest = JSON.parse(text(byPath.get('/manifest.webmanifest')!.bytes));
		expect(manifest.name).toBe('Farm <Log> & "Co"');
	});

	test('keeps the plain viewport: no viewport-fit=cover, which would put the app under the notch', () => {
		expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
		expect(html).not.toContain('viewport-fit');
	});

	test('registers no service worker and runs no inline script (published pages may only load their own files)', () => {
		expect(html).not.toContain('serviceWorker');
		const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!);
		expect(scripts).toEqual([' type="module" src="/main.js"']);
	});

	test('every icon the manifest names is one of the uploaded files', () => {
		const manifest = JSON.parse(text(byPath.get('/manifest.webmanifest')!.bytes));
		for (const icon of manifest.icons) expect(byPath.get(icon.src)?.contentType).toBe('image/png');
	});
});
