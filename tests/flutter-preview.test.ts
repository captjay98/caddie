import { describe, expect, test } from 'bun:test';
import { bytesToBase64 } from '../apps/app/src/server/adapters/contree.ts';
import { FLUTTER_ASSET_BASE, FLUTTER_PREVIEW_MAX_BYTES, flutterPreviewDocument, readFlutterWebBuild } from '../apps/app/src/server/flutter-preview.ts';

/**
 * Track 3, stage D: the one-page browser preview of an Android app. The real
 * page runs in Chromium in tests/browser/flutter-preview.spec.ts; these pin
 * what goes in it and what is left out.
 */

const text = (value: string) => new TextEncoder().encode(value);

function fakeDriver(files: Record<string, Uint8Array>) {
	const dirs = new Set<string>();
	for (const path of Object.keys(files)) {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
	}
	return {
		async readFile(_session: string, path: string) {
			const bytes = files[path];
			if (!bytes) throw new Error(`no ${path}`);
			return { contentBase64: bytesToBase64(bytes), size: bytes.byteLength };
		},
		async pathExists(_session: string, path: string) {
			return path in files || dirs.has(path);
		},
		async listEntries(_session: string, dir: string) {
			const names = new Map<string, boolean>();
			for (const path of [...Object.keys(files), ...dirs]) {
				if (!path.startsWith(`${dir}/`)) continue;
				const rest = path.slice(dir.length + 1);
				if (rest.includes('/')) continue;
				names.set(rest, path in files);
			}
			return [...names].map(([name, isFile]) => ({ name, isFile, isDir: !isFile, size: files[`${dir}/${name}`]?.byteLength ?? 0 }));
		},
	} as never;
}

const ROOT = '/workspace/p';
const WEB = `${ROOT}/build/web`;

describe('reading the web build', () => {
	test('the compiled app and every asset except the licence list', async () => {
		const build = await readFlutterWebBuild(
			fakeDriver({
				[`${WEB}/main.dart.js`]: text('main();'),
				[`${WEB}/flutter.js`]: text('loader'),
				[`${WEB}/index.html`]: text('<html>'),
				[`${WEB}/assets/FontManifest.json`]: text('[]'),
				[`${WEB}/assets/NOTICES`]: text('licences'),
				[`${WEB}/assets/fonts/MaterialIcons-Regular.otf`]: new Uint8Array([0, 1, 2]),
				[`${WEB}/assets/assets/images/logo.png`]: new Uint8Array([137, 80]),
				[`${WEB}/canvaskit/canvaskit.wasm`]: new Uint8Array(10),
			}),
			'session',
			ROOT,
		);
		expect(new TextDecoder().decode(build.main)).toBe('main();');
		expect(Object.keys(build.assets).sort()).toEqual(['assets/FontManifest.json', 'assets/assets/images/logo.png', 'assets/fonts/MaterialIcons-Regular.otf']);
	});

	test('no web build, or one over 12 MB, is refused with a plain reason', async () => {
		await expect(readFlutterWebBuild(fakeDriver({}), 's', ROOT)).rejects.toThrow('did not produce build/web/main.dart.js');
		const huge = fakeDriver({ [`${WEB}/main.dart.js`]: new Uint8Array(1), [`${WEB}/assets/big.bin`]: new Uint8Array(FLUTTER_PREVIEW_MAX_BYTES) });
		await expect(readFlutterWebBuild(huge, 's', ROOT)).rejects.toThrow('too large for the browser preview');
	});
});

describe('the preview page', () => {
	const page = flutterPreviewDocument({ main: text('console.log("</script><!-- x")'), assets: { 'assets/FontManifest.json': text('[]') } }, 'Farm <Log>');

	test('carries the app and its assets as data, and points the engine at the virtual asset address', () => {
		expect(page).toContain(`<meta name="assetBase" content="${FLUTTER_ASSET_BASE}">`);
		const json = /<script type="application\/json" id="caddie-flutter-app">(.*?)<\/script>/s.exec(page)![1]!;
		const data = JSON.parse(json);
		expect(atob(data.main)).toBe('console.log("</script><!-- x")');
		expect(atob(data.assets['assets/FontManifest.json'])).toBe('[]');
	});

	test('no byte of the app appears raw in the page, so it cannot end a script early', () => {
		expect(page).not.toContain('console.log');
		expect((page.match(/<\/script>/g) ?? []).length).toBe(2);
		expect(page).toContain('<title>Farm &lt;Log&gt;</title>');
	});

	test('the app starts from a blob: script; nothing is fetched from the network by the page itself', () => {
		expect(page).toContain("URL.createObjectURL(new Blob([bytes],{type:'text/javascript'}))");
		expect(page).not.toMatch(/src="https?:/);
	});
});
