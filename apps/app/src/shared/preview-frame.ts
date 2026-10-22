/**
 * The preview FRAME document: the policy, the storage shim, the fetch bridge
 * and the app's own document, in one file.
 *
 * A leaf module with no imports on purpose: the server composes the frame
 * document (so the frame loads from a real https URL and the app sees the
 * protocol it would see in production) and the client composes the same
 * document for its own sandboxed frame. One template, one set of rules.
 *
 * Why the frame must load over https and not as `srcdoc`: a `srcdoc` frame
 * has the protocol `about:`, and a generated app that checks its own origin
 * before it fetches (`window.location.protocol === "https:"`) then decides it
 * is offline and never calls its server at all. HerdVoice, 2026-10-22: a
 * green build whose app showed "You're offline" in the preview while the
 * relay answered every request when called directly. The frame is still
 * sandboxed WITHOUT `allow-same-origin`, so its origin stays opaque: it can
 * neither read the workspace's origin nor script the page around it.
 */

export const STORAGE_LIMIT = 100 * 1024;
export const PREVIEW_LIMIT = 5 * 1024 * 1024;
export const BRIDGE_KIND = "caddie-preview-storage";
export const FETCH_KIND = "caddie-preview-fetch";
export const FETCH_RESULT_KIND = "caddie-preview-fetch-result";
export const MAX_RELAY_BODY = Math.ceil((1024 * 1024) / 3) * 4 + 4;
export const MAX_IN_FLIGHT = 8;
// 'wasm-unsafe-eval' lets the app compile WebAssembly (sql.js and the like);
// JavaScript eval stays blocked (owner OK, 2026-10-20).
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
/**
 * Android apps' browser preview (Track 3): Flutter's web engine (CanvasKit,
 * WebAssembly) and its Roboto font come from Google's two Flutter CDNs, and
 * the compiled app starts from a blob: script (server/flutter-preview.ts).
 * Nothing else is reachable: the app's /api calls and its asset files are
 * answered through the shim, never the network.
 */
export const FLUTTER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob: https://www.gstatic.com 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src https://www.gstatic.com https://fonts.gstatic.com; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
/** A Flutter preview page carries its compiled app and assets (server/flutter-preview.ts caps them at 12 MB). */
export const FLUTTER_PREVIEW_LIMIT = 17 * 1024 * 1024;

function scriptJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Apps with a server: the frame has no network (connect-src 'none'), so its
 * fetch('/api/…') calls travel to the parent by postMessage, the parent sends
 * them to Caddie's relay, and the app's answer comes back the same way.
 * Only the app's own /api routes are reachable.
 */
function fetchBridgeShim(nonce: string): string {
  return `(function () {
		'use strict';
		var nonce = ${scriptJSON(nonce)};
		var BASE = 'https://app.preview.invalid';
		var pending = new Map();
		var seq = 0;
		function toBase64(bytes) { var text = ''; for (var i = 0; i < bytes.length; i += 32768) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(text); }
		function fromBase64(value) { var binary = atob(value); var out = new Uint8Array(binary.length); for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i); return out; }
		window.addEventListener('message', function (event) {
			if (event.source !== parent) return;
			var message = event.data;
			if (!message || message.kind !== ${scriptJSON(FETCH_RESULT_KIND)} || message.nonce !== nonce) return;
			var waiting = pending.get(message.id);
			if (!waiting) return;
			pending.delete(message.id);
			if (message.error) { waiting.reject(new TypeError(message.error)); return; }
			var answer = message.response;
			var status = answer.status >= 200 && answer.status <= 599 ? answer.status : 502;
			var headers = answer.headers.filter(function (pair) { return String(pair[0]).toLowerCase() !== 'set-cookie'; });
			var empty = status === 204 || status === 205 || status === 304;
			waiting.resolve(new Response(empty ? null : fromBase64(answer.body), { status: status, headers: headers }));
		});
		window.fetch = async function (input, init) {
			var request = new Request(input instanceof Request ? input : new URL(String(input), BASE + '/'), init);
			var url = new URL(request.url);
			if (url.origin !== BASE || !/^\\/api(?:\\/|$)/.test(url.pathname)) throw new TypeError("The preview can only reach the app's own /api routes.");
			var body = null;
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				var bytes = new Uint8Array(await request.arrayBuffer());
				if (bytes.length > 0) body = toBase64(bytes);
			}
			var headers = [];
			request.headers.forEach(function (value, name) { headers.push([name, value]); });
			var id = ++seq;
			return new Promise(function (resolve, reject) {
				pending.set(id, { resolve: resolve, reject: reject });
				parent.postMessage({ kind: ${scriptJSON(FETCH_KIND)}, nonce: nonce, id: id, request: { method: request.method, path: url.pathname + url.search, headers: headers, body: body } }, '*');
			});
		};
	})();`;
}

/** The frame document (policy, storage shim, fetch shim, app); exported for tests/browser/flutter-preview.spec.ts. */
export function previewDocument(
  html: string,
  nonce: string,
  seed: Record<string, string>,
  bridgeFetch = false,
  kind: "web" | "flutter" = "web",
): string {
  // Keep all generated HTML parsing inside the sandbox, including resource tags.
  // The policy and synchronous storage shim precede every generated script.
  const shim = `(function () {
		'use strict';
		var data = Object.assign(Object.create(null), ${scriptJSON(seed)});
		var nonce = ${scriptJSON(nonce)};
		var encoder = new TextEncoder();
		function keys() { return Object.keys(data); }
		function commit(next) {
			var all = Object.keys(next), size = 0;
			if (all.length > 512) throw new DOMException('Preview storage is full.', 'QuotaExceededError');
			for (var key of all) {
				if (key.length > 1024) throw new DOMException('Preview storage key is too long.', 'QuotaExceededError');
				size += encoder.encode(key + next[key]).byteLength;
				if (size > ${STORAGE_LIMIT}) throw new DOMException('Preview storage is full.', 'QuotaExceededError');
			}
			data = next;
			parent.postMessage({ kind: ${scriptJSON(BRIDGE_KIND)}, nonce: nonce, storage: data }, '*');
		}
		var methods = {
			getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
			setItem: function (key, value) { var next = Object.assign(Object.create(null), data); next[String(key)] = String(value); commit(next); },
			removeItem: function (key) { var next = Object.assign(Object.create(null), data); delete next[String(key)]; commit(next); },
			clear: function () { commit(Object.create(null)); },
			key: function (index) { return keys()[Number(index) >>> 0] ?? null; }
		};
		var storage = new Proxy(Object.create(null), {
			get: function (_, key) { if (key === 'length') return keys().length; if (key === Symbol.toStringTag) return 'Storage'; if (Object.prototype.hasOwnProperty.call(methods, key)) return methods[key]; return typeof key === 'string' ? methods.getItem(key) ?? undefined : undefined; },
			set: function (_, key, value) { methods.setItem(key, value); return true; },
			deleteProperty: function (_, key) { methods.removeItem(key); return true; },
			ownKeys: function () { return keys(); },
			getOwnPropertyDescriptor: function (_, key) { return Object.prototype.hasOwnProperty.call(data, key) ? { configurable: true, enumerable: true, writable: true, value: data[key] } : undefined; },
			has: function (_, key) { return key === 'length' || Object.prototype.hasOwnProperty.call(methods, key) || Object.prototype.hasOwnProperty.call(data, key); }
		});
		Object.defineProperty(window, 'localStorage', { value: storage, configurable: false, writable: false });
	})();`;
  const fetchShim = kind === "flutter" ? flutterFetchShim(nonce, bridgeFetch) : bridgeFetch ? fetchBridgeShim(nonce) : null;
  // The shims stay CLASSIC scripts: they must be installed BEFORE the app's own
  // scripts run, because a generated app may read localStorage or call fetch
  // at parse time. Making them modules defers them past the app's first
  // statements and breaks exactly that ordering (browser spec, 2026-10-21).
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${kind === "flutter" ? FLUTTER_CSP : CSP}"><meta name="referrer" content="no-referrer"><script>${shim}</script>${fetchShim ? `<script>${fetchShim}</script>` : ""}</head><body>${html}</body></html>`;
}

/**
 * Android apps (Track 3): Flutter's engine fetches its asset files from the
 * page's assetBase (answered here from the page's own data), the app's /api
 * calls go through the same parent relay as web apps, and only Google's two
 * Flutter CDNs (allowed by FLUTTER_CSP) reach the network.
 */
function flutterFetchShim(nonce: string, bridge: boolean): string {
  return `(function () {
		'use strict';
		var nonce = ${scriptJSON(nonce)};
		var BASE = 'https://app.preview.invalid';
		var ASSETS = 'https://assets.preview.invalid';
		var CDNS = ['https://www.gstatic.com', 'https://fonts.gstatic.com'];
		var bridge = ${bridge ? "true" : "false"};
		var network = window.fetch.bind(window);
		var pending = new Map();
		var seq = 0;
		var TYPES = { json: 'application/json', otf: 'font/otf', ttf: 'font/ttf', woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', frag: 'application/octet-stream', bin: 'application/octet-stream' };
		function toBase64(bytes) { var text = ''; for (var i = 0; i < bytes.length; i += 32768) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(text); }
		function fromBase64(value) { var binary = atob(value); var out = new Uint8Array(binary.length); for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i); return out; }
		// The frame has no address of its own (about:srcdoc, opaque origin):
		// Flutter's router writes its route into the URL, which the browser
		// refuses here, so keep the history state and drop the URL change.
		['pushState', 'replaceState'].forEach(function (name) {
			var original = history[name].bind(history);
			history[name] = function (state, title, url) {
				try { return original(state, title, url); } catch (error) { return original(state, title); }
			};
		});
		// Reading navigator.serviceWorker throws in a sandboxed frame; there is none.
		try { Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true, get: function () { return undefined; } }); } catch (error) {}
		window.addEventListener('message', function (event) {
			if (event.source !== parent) return;
			var message = event.data;
			if (!message || message.kind !== ${scriptJSON(FETCH_RESULT_KIND)} || message.nonce !== nonce) return;
			var waiting = pending.get(message.id);
			if (!waiting) return;
			pending.delete(message.id);
			if (message.error) { waiting.reject(new TypeError(message.error)); return; }
			var answer = message.response;
			var status = answer.status >= 200 && answer.status <= 599 ? answer.status : 502;
			var headers = answer.headers.filter(function (pair) { return String(pair[0]).toLowerCase() !== 'set-cookie'; });
			var empty = status === 204 || status === 205 || status === 304;
			waiting.resolve(new Response(empty ? null : fromBase64(answer.body), { status: status, headers: headers }));
		});
		window.fetch = async function (input, init) {
			var request = new Request(input instanceof Request ? input : new URL(String(input), BASE + '/'), init);
			var url = new URL(request.url);
			if (url.origin === ASSETS) {
				var assets = window.__caddieFlutterAssets || {};
				var path = decodeURIComponent(url.pathname.slice(1));
				if (!Object.prototype.hasOwnProperty.call(assets, path)) return new Response(null, { status: 404 });
				var ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
				return new Response(fromBase64(assets[path]), { status: 200, headers: { 'content-type': TYPES[ext] || 'application/octet-stream' } });
			}
			if (CDNS.indexOf(url.origin) !== -1 && request.method === 'GET') return network(request);
			if (!bridge || url.origin !== BASE || !/^\\/api(?:\\/|$)/.test(url.pathname)) throw new TypeError("The preview can only reach the app's own /api routes.");
			var body = null;
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				var bytes = new Uint8Array(await request.arrayBuffer());
				if (bytes.length > 0) body = toBase64(bytes);
			}
			var headers = [];
			request.headers.forEach(function (value, name) { headers.push([name, value]); });
			var id = ++seq;
			return new Promise(function (resolve, reject) {
				pending.set(id, { resolve: resolve, reject: reject });
				parent.postMessage({ kind: ${scriptJSON(FETCH_KIND)}, nonce: nonce, id: id, request: { method: request.method, path: url.pathname + url.search, headers: headers, body: body } }, '*');
			});
		};
	})();`;
}


/**
 * The app's own saved data (its localStorage in the preview), as a bounded
 * record of strings. One rule for both sides: the client sends it, the server
 * stores it, and the frame's storage shim accepts it.
 */
export function previewSeed(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 512) return null;
  let size = 0;
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of entries) {
    if (
      key.length > 1024 ||
      typeof item !== "string" ||
      item.length > STORAGE_LIMIT
    )
      return null;
    size += new TextEncoder().encode(key + item).byteLength;
    if (size > STORAGE_LIMIT) return null;
    result[key] = item;
  }
  return result;
}
