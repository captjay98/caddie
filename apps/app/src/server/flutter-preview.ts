import { base64ToBytes, bytesToBase64 } from './adapters/contree.ts';
import type { SandboxDriver } from './adapters/sandbox.ts';
import { ScopeError } from './scope.ts';

/**
 * The browser preview of an Android app (Track 3). `flutter build web` makes
 * a multi-file site, but Caddie's preview is ONE page loaded into a sandboxed
 * frame with no address of its own. So the page carries the app's compiled
 * code and its asset files inside it:
 *
 *   - the compiled app (build/web/main.dart.js) as base64, started from a
 *     blob: script, so no byte of the app can end the page's script early;
 *   - every file under build/web/assets/ (fonts, shaders, manifests, the
 *     app's own images) except the 1.3 MB licence list, answered by the
 *     frame's fetch shim at FLUTTER_ASSET_BASE (InteractivePreview.tsx);
 *   - Flutter's own engine (CanvasKit) and its Roboto font load from Google's
 *     Flutter CDNs, the only two hosts the preview frame may reach.
 * The frame's CSP and shim are the client's (InteractivePreview kind
 * "flutter"); this module only builds the page. Plain module: no Worker-only
 * imports, so tests and the browser spec use it directly.
 */

export const FLUTTER_ASSET_BASE = 'https://assets.preview.invalid/';
/** The page is stored as one large file; a bigger web build is refused plainly. */
export const FLUTTER_PREVIEW_MAX_BYTES = 12 * 1024 * 1024;

export interface FlutterWebBuild {
	/** build/web/main.dart.js */
	main: Uint8Array;
	/** Paths relative to build/web ("assets/FontManifest.json") -> bytes. */
	assets: Record<string, Uint8Array>;
}

type Reader = Pick<SandboxDriver, 'readFile' | 'pathExists' | 'listEntries'>;

const SKIPPED_ASSETS = new Set(['assets/NOTICES']);

/** Read what the preview needs from `flutter build web` in the app's folder. */
export async function readFlutterWebBuild(driver: Reader, sessionId: string, root: string): Promise<FlutterWebBuild> {
	const web = `${root}/build/web`;
	const read = async (path: string) => base64ToBytes((await driver.readFile(sessionId, path)).contentBase64);
	if (!(await driver.pathExists(sessionId, `${web}/main.dart.js`))) {
		throw new ScopeError(422, 'FLUTTER_WEB_MISSING', 'The web build did not produce build/web/main.dart.js. Run the checks again.');
	}
	const main = await read(`${web}/main.dart.js`);
	const assets: Record<string, Uint8Array> = {};
	let total = main.byteLength;
	const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
		if (depth > 6 || !(await driver.pathExists(sessionId, dir))) return;
		for (const entry of await driver.listEntries(sessionId, dir)) {
			const relative = `${prefix}/${entry.name}`;
			if (entry.isFile) {
				if (SKIPPED_ASSETS.has(relative)) continue;
				const bytes = await read(`${dir}/${entry.name}`);
				total += bytes.byteLength;
				if (total > FLUTTER_PREVIEW_MAX_BYTES) {
					throw new ScopeError(422, 'FLUTTER_WEB_TOO_LARGE', 'The app is too large for the browser preview (over 12 MB of code and assets). Use smaller images.');
				}
				assets[relative] = bytes;
			} else if (entry.isDir) {
				await walk(`${dir}/${entry.name}`, relative, depth + 1);
			}
		}
	};
	await walk(`${web}/assets`, 'assets', 0);
	return { main, assets };
}

function jsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The preview page: data in a JSON block, one small loader, nothing else. */
export function flutterPreviewDocument(build: FlutterWebBuild, title = 'Your app'): string {
	const payload = {
		main: bytesToBase64(build.main),
		assets: Object.fromEntries(Object.entries(build.assets).map(([path, bytes]) => [path, bytesToBase64(bytes)])),
	};
	const loader =
		"(function(){'use strict';" +
		"var data=JSON.parse(document.getElementById('caddie-flutter-app').textContent);" +
		'window.__caddieFlutterAssets=data.assets;' +
		'var text=atob(data.main),bytes=new Uint8Array(text.length);' +
		'for(var i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);' +
		"var script=document.createElement('script');" +
		"script.src=URL.createObjectURL(new Blob([bytes],{type:'text/javascript'}));" +
		'document.body.appendChild(script);' +
		'})();';
	const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 120);
	return (
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
		`<title>${safeTitle}</title></head><body style="margin:0">` +
		`<meta name="assetBase" content="${FLUTTER_ASSET_BASE}">` +
		`<script type="application/json" id="caddie-flutter-app">${jsonForScript(payload)}</script>` +
		`<script>${loader}</script>` +
		'</body></html>'
	);
}
