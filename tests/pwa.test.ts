import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import { shouldRegisterServiceWorker } from '../apps/app/src/client/pwa.ts';
import {
	SHARE_PARAMS,
	SHARED_DRAFT_KEY,
	SHARED_DRAFT_MAX,
	captureSharedDraft,
	composeSharedDraft,
	mergeSharedDraft,
	takeSharedDraft,
	type ShareStorage,
} from '../apps/app/src/client/share-target.ts';
import { BUILD_PLACEHOLDER, buildStamp, stampServiceWorker } from '../scripts/sw-stamp.ts';

/**
 * Caddie's /app as an installable phone app (Track 2 of
 * docs/plans/2026-10-19-pwa-flutter-apk-monetization-plan.md): the manifest
 * and icons, the head tags, the share target that puts a shared link in the
 * composer (never sent), and the service worker that keeps the app shell for
 * offline launches and never answers /api or /agents from a cache.
 *
 * The service worker runs here against stand-ins for the browser's fetch and
 * Cache Storage; tests/browser/pwa.spec.ts runs the real one in Chromium.
 */

const ROOT = join(import.meta.dir, '..');
const PUBLIC = join(ROOT, 'apps', 'app', 'public');
const ORIGIN = 'https://caddie.test';

interface ManifestIcon {
	src: string;
	sizes: string;
	type: string;
	purpose?: string;
}
interface Manifest {
	id: string;
	name: string;
	short_name: string;
	description: string;
	start_url: string;
	scope: string;
	display: string;
	orientation?: string;
	background_color: string;
	theme_color: string;
	icons: ManifestIcon[];
	shortcuts: { name: string; url: string; icons?: ManifestIcon[] }[];
	share_target: { action: string; method: string; params: Record<string, string> };
}

function manifest(): Manifest {
	return JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Manifest;
}

/** Width, height and the alpha of the top-left pixel of an 8-bit PNG. */
function png(path: string): { width: number; height: number; cornerAlpha: number } {
	const bytes = readFileSync(path);
	expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	const bitDepth = bytes[24];
	const colorType = bytes[25];
	expect(bitDepth).toBe(8);
	const idat: Buffer[] = [];
	for (let offset = 8; offset < bytes.length; ) {
		const length = bytes.readUInt32BE(offset);
		if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
		offset += 12 + length;
	}
	// Row 0, pixel 0 comes out unfiltered whatever the row's filter (no left or
	// upper neighbours), so its bytes follow the filter byte directly.
	const raw = inflateSync(Buffer.concat(idat));
	const cornerAlpha = colorType === 6 ? raw[4]! : colorType === 2 ? 255 : -1;
	return { width, height, cornerAlpha };
}

describe('manifest (apps/app/public/manifest.webmanifest)', () => {
	test('installs as Caddie, opens the workspace and stays inside /app/', () => {
		const m = manifest();
		expect({
			id: m.id,
			name: m.name,
			short_name: m.short_name,
			start_url: m.start_url,
			scope: m.scope,
			display: m.display,
			background_color: m.background_color,
			theme_color: m.theme_color,
		}).toEqual({
			id: '/app/',
			name: 'Caddie',
			short_name: 'Caddie',
			start_url: '/app/',
			scope: '/app/',
			display: 'standalone',
			background_color: '#090b10',
			theme_color: '#090b10',
		});
		expect(m.description.length).toBeGreaterThan(20);
		// Tablets and landscape keyboards are supported layouts: no lock.
		expect(m.orientation).toBeUndefined();
	});

	test('names a 192 and a 512 icon and a maskable 512, each a PNG of that size', () => {
		const icons = manifest().icons;
		const kinds = icons.map((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}`).sort();
		expect(kinds).toEqual(['192x192:any', '512x512:any', '512x512:maskable']);
		for (const icon of icons) {
			expect(icon.type).toBe('image/png');
			expect(icon.src.startsWith('/')).toBe(true);
			const file = join(PUBLIC, icon.src);
			expect(existsSync(file)).toBe(true);
			const [w, h] = icon.sizes.split('x').map(Number);
			const info = png(file);
			expect([info.width, info.height]).toEqual([w!, h!]);
		}
	});

	test('the maskable and Apple icons fill the square; the plain icons keep rounded corners', () => {
		const icons = manifest().icons;
		for (const icon of icons) {
			const alpha = png(join(PUBLIC, icon.src)).cornerAlpha;
			expect({ icon: icon.src, alpha }).toEqual({ icon: icon.src, alpha: icon.purpose === 'maskable' ? 255 : 0 });
		}
		const apple = png(join(PUBLIC, 'apple-touch-icon.png'));
		expect(apple).toEqual({ width: 180, height: 180, cornerAlpha: 255 });
	});

	test('shortcuts open real pages of the app', () => {
		const routes = readFileSync(join(ROOT, 'apps', 'app', 'src', 'client', 'routes.tsx'), 'utf8');
		const shortcuts = manifest().shortcuts;
		expect(shortcuts.map((s) => s.name)).toEqual(['Ask Caddie', 'Brief', 'Discover', 'Projects']);
		for (const shortcut of shortcuts) {
			expect(shortcut.url.startsWith('/app/')).toBe(true);
			const path = new URL(shortcut.url, ORIGIN).pathname.replace(/^\/app/, '') || '/';
			expect({ url: shortcut.url, declared: routes.includes(`path: '${path}'`) }).toEqual({ url: shortcut.url, declared: true });
		}
	});

	test('the share target sends the title, text and link to /app/ under the names the app reads', () => {
		expect(manifest().share_target).toEqual({
			action: '/app/',
			method: 'GET',
			params: { title: SHARE_PARAMS.title, text: SHARE_PARAMS.text, url: SHARE_PARAMS.url },
		});
	});
});

describe('app shell head (apps/app/index.html)', () => {
	const html = () => readFileSync(join(ROOT, 'apps', 'app', 'index.html'), 'utf8');

	test('fills the screen on phones and links the install files', () => {
		const head = html();
		const viewport = head.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
		expect(viewport.split(',').map((part) => part.trim())).toEqual(['width=device-width', 'initial-scale=1', 'viewport-fit=cover']);
		expect(head).toContain('<meta name="theme-color" content="#090b10" />');
		expect(head).toContain('<meta name="mobile-web-app-capable" content="yes" />');
		expect(head).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
		expect(head).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
		expect(head).toContain('<meta name="apple-mobile-web-app-title" content="Caddie" />');
		expect(head).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
		expect(head).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
	});

	test('the tags the pre-paint script recolours come before it', () => {
		const head = html();
		const script = head.indexOf('<script data-theme-boot>');
		expect(script).toBeGreaterThan(0);
		expect(head.indexOf('name="theme-color"')).toBeLessThan(script);
		expect(head.indexOf('name="apple-mobile-web-app-status-bar-style"')).toBeLessThan(script);
	});
});

class MemoryShareStorage implements ShareStorage {
	readonly data = new Map<string, string>();
	getItem(key: string) {
		return this.data.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.data.set(key, value);
	}
	removeItem(key: string) {
		this.data.delete(key);
	}
}

class FakeHistory {
	state: unknown = { __TSR_index: 0 };
	readonly replaced: string[] = [];
	replaceState(data: unknown, _unused: string, url: string) {
		this.state = data;
		this.replaced.push(url);
	}
}

describe('share target', () => {
	test('a link with its page title becomes two lines; text that already carries the link is kept as is', () => {
		expect(composeSharedDraft({ title: 'Hack Week', url: 'https://devpost.com/hack-week' })).toBe('Hack Week\nhttps://devpost.com/hack-week');
		expect(composeSharedDraft({ text: 'Join this https://t.co/abc', url: 'https://t.co/abc' })).toBe('Join this https://t.co/abc');
		expect(composeSharedDraft({ title: 'https://x.dev/a', url: 'https://x.dev/a' })).toBe('https://x.dev/a');
		expect(composeSharedDraft({ title: 'Hack Week', text: 'Hack Week is open' })).toBe('Hack Week is open');
		expect(composeSharedDraft({ title: '  ', text: '\n', url: '' })).toBeNull();
		expect(composeSharedDraft({})).toBeNull();
		expect(composeSharedDraft({ text: 'x'.repeat(SHARED_DRAFT_MAX + 50) })?.length).toBe(SHARED_DRAFT_MAX);
	});

	test('capturing takes only the shared values out of the address, keeps the rest, and stores the draft', () => {
		const storage = new MemoryShareStorage();
		const history = new FakeHistory();
		const draft = captureSharedDraft(
			{ pathname: '/app/', search: '?pane=channel&shared_title=Hack+Week&shared_url=https%3A%2F%2Fdevpost.com%2Fhw', hash: '#top' },
			storage,
			history,
		);
		expect(draft).toBe('Hack Week\nhttps://devpost.com/hw');
		expect(history.replaced).toEqual(['/app/?pane=channel#top']);
		expect(history.state).toEqual({ __TSR_index: 0 });
		expect(storage.data.get(SHARED_DRAFT_KEY)).toBe(draft!);
	});

	test('an address with nothing shared is left alone', () => {
		const storage = new MemoryShareStorage();
		const history = new FakeHistory();
		expect(captureSharedDraft({ pathname: '/app/projects', search: '?project=p1', hash: '' }, storage, history)).toBeNull();
		expect(history.replaced).toEqual([]);
		expect(storage.data.size).toBe(0);
	});

	test('empty shared values are still removed from the address, and nothing is stored', () => {
		const storage = new MemoryShareStorage();
		const history = new FakeHistory();
		expect(captureSharedDraft({ pathname: '/app/', search: '?shared_text=', hash: '' }, storage, history)).toBeNull();
		expect(history.replaced).toEqual(['/app/']);
		expect(storage.data.size).toBe(0);
	});

	test('storage that refuses writes still cleans the address', () => {
		const history = new FakeHistory();
		const refusing: ShareStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error('QuotaExceededError');
			},
			removeItem: () => {},
		};
		expect(captureSharedDraft({ pathname: '/app/', search: '?shared_url=https%3A%2F%2Fa.dev', hash: '' }, refusing, history)).toBe('https://a.dev');
		expect(history.replaced).toEqual(['/app/']);
	});

	test('a stored draft is handed over once', () => {
		const storage = new MemoryShareStorage();
		storage.setItem(SHARED_DRAFT_KEY, 'https://devpost.com/hw');
		expect(takeSharedDraft(storage)).toBe('https://devpost.com/hw');
		expect(takeSharedDraft(storage)).toBeNull();
		expect(takeSharedDraft(null)).toBeNull();
		const throwing: ShareStorage = {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {},
			removeItem: () => {},
		};
		expect(takeSharedDraft(throwing)).toBeNull();
	});

	test('a shared draft never replaces what the user was typing', () => {
		expect(mergeSharedDraft('', 'https://a.dev')).toBe('https://a.dev');
		expect(mergeSharedDraft('  ', 'https://a.dev')).toBe('https://a.dev');
		expect(mergeSharedDraft('Is this a fit?  ', 'https://a.dev')).toBe('Is this a fit?\nhttps://a.dev');
		expect(mergeSharedDraft('Is https://a.dev a fit?', 'https://a.dev')).toBe('Is https://a.dev a fit?');
	});
});

// --- the service worker, against stand-ins for the browser APIs ---------------

interface FakeRequest {
	url: string;
	method: string;
	mode: string;
	cache: string;
	headers: Headers;
}

function request(path: string, init: Partial<FakeRequest> = {}): FakeRequest {
	return { url: new URL(path, ORIGIN).href, method: 'GET', mode: 'cors', cache: 'default', headers: new Headers(), ...init };
}
const navigation = (path: string) => request(path, { mode: 'navigate', headers: new Headers({ accept: 'text/html' }) });

type CacheKey = FakeRequest | string;
const keyOf = (key: CacheKey) => (typeof key === 'string' ? new URL(key, ORIGIN).href : key.url);

class FakeCache {
	readonly entries = new Map<string, Response>();
	async match(key: CacheKey) {
		return this.entries.get(keyOf(key))?.clone();
	}
	async put(key: CacheKey, response: Response) {
		this.entries.set(keyOf(key), response.clone());
	}
	async delete(key: CacheKey) {
		return this.entries.delete(keyOf(key));
	}
	async keys() {
		return [...this.entries.keys()].map((url) => ({ url }));
	}
}

class FakeCaches {
	readonly stores = new Map<string, FakeCache>();
	async open(name: string) {
		let cache = this.stores.get(name);
		if (!cache) {
			cache = new FakeCache();
			this.stores.set(name, cache);
		}
		return cache;
	}
	async keys() {
		return [...this.stores.keys()];
	}
	async delete(name: string) {
		return this.stores.delete(name);
	}
	async match(key: CacheKey, options: { cacheName?: string } = {}) {
		const names = options.cacheName ? [options.cacheName] : [...this.stores.keys()];
		for (const name of names) {
			const hit = await this.stores.get(name)?.match(key);
			if (hit) return hit;
		}
		return undefined;
	}
}

type Network = (url: string, input: CacheKey, init?: { cache?: string }) => Promise<Response>;
interface FetchEvent {
	request: FakeRequest;
	respondWith(response: Promise<Response> | Response): void;
}
interface ExtendableEvent {
	waitUntil(promise: Promise<unknown>): void;
}

const SHELL_HTML =
	'<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc.js"></script>' +
	'<link rel="stylesheet" crossorigin href="/assets/index-def.css"></head><body><div id="root"></div></body></html>';

function html(body: string, status = 200) {
	return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Online: the shell and its two files; anything else is a 404. */
const online: Network = async (url) => {
	const path = new URL(url).pathname;
	if (path === '/app/' || path.startsWith('/app/')) return html(SHELL_HTML);
	if (path === '/assets/index-abc.js') return new Response('js', { headers: { 'content-type': 'text/javascript' } });
	if (path === '/assets/index-def.css') return new Response('css', { headers: { 'content-type': 'text/css' } });
	return new Response('missing', { status: 404 });
};
const offline: Network = async () => {
	throw new TypeError('Failed to fetch');
};

function loadWorker(network: Network = online, caches = new FakeCaches()) {
	const listeners = new Map<string, (event: unknown) => void>();
	const calls: { url: string; cache?: string }[] = [];
	const state = { network };
	const fetchStandIn = (input: CacheKey, init?: { cache?: string }) => {
		const url = keyOf(input);
		calls.push({ url, cache: init?.cache ?? (typeof input === 'string' ? undefined : input.cache) });
		return state.network(url, input, init);
	};
	const self = {
		location: { origin: ORIGIN },
		addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
		skipWaiting: async () => {},
		clients: { claim: async () => {} },
	};
	const source = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
	new Function('self', 'caches', 'fetch', source)(self, caches, fetchStandIn);

	return {
		caches,
		calls,
		goOffline: () => {
			state.network = offline;
		},
		setNetwork: (next: Network) => {
			state.network = next;
		},
		/** The worker's answer, or 'network' when it let the browser handle the request. */
		async fetch(req: FakeRequest): Promise<Response | 'network'> {
			let answer: Promise<Response> | undefined;
			const event: FetchEvent = {
				request: req,
				respondWith: (response) => {
					answer = Promise.resolve(response);
				},
			};
			listeners.get('fetch')!(event);
			return answer ?? 'network';
		},
		async lifecycle(type: 'install' | 'activate') {
			const waits: Promise<unknown>[] = [];
			const event: ExtendableEvent = { waitUntil: (promise) => waits.push(promise) };
			listeners.get(type)!(event);
			await Promise.all(waits);
		},
		async cachedUrls(): Promise<string[]> {
			const urls: string[] = [];
			for (const cache of caches.stores.values()) urls.push(...cache.entries.keys());
			return urls.sort();
		},
	};
}

async function text(answer: Response | 'network') {
	if (answer === 'network') throw new Error('expected the worker to answer');
	return answer.text();
}

describe('service worker (apps/app/public/sw.js)', () => {
	test('never answers /api or /agents, other sites, or anything but a GET', async () => {
		const worker = loadWorker();
		await worker.lifecycle('install');
		for (const req of [
			request('/api/auth/status'),
			request('/api'),
			request('/api/projects/p1/experience'),
			request('/agents/coordinator/c1'),
			navigation('/api/auth/callback/github'),
			request('/app/', { method: 'POST' }),
			request('https://www.gstatic.com/x.js'),
			request('/assets/index-abc.js', { cache: 'only-if-cached', mode: 'no-cors' }),
		]) {
			expect({ url: req.url, method: req.method, answer: await worker.fetch(req) }).toEqual({ url: req.url, method: req.method, answer: 'network' });
		}
	});

	test('pages outside the app (the landing page, the report page) are not its business', async () => {
		const worker = loadWorker();
		expect(await worker.fetch(navigation('/'))).toBe('network');
		expect(await worker.fetch(navigation('/report'))).toBe('network');
	});

	test('installing keeps the app shell and the two files it loads, fetched fresh', async () => {
		const worker = loadWorker();
		await worker.lifecycle('install');
		expect(await worker.cachedUrls()).toEqual([`${ORIGIN}/app/`, `${ORIGIN}/assets/index-abc.js`, `${ORIGIN}/assets/index-def.css`]);
		expect(worker.calls.every((call) => call.cache === 'reload')).toBe(true);
	});

	test('an install with no connection fails, so the browser tries again later', async () => {
		const worker = loadWorker(offline);
		await expect(worker.lifecycle('install')).rejects.toThrow('Failed to fetch');
	});

	test('online, opening a page uses the network and refreshes the kept shell', async () => {
		const worker = loadWorker();
		await worker.lifecycle('install');
		worker.setNetwork(async (url) => (new URL(url).pathname.startsWith('/app') ? html('<p>new build</p>') : new Response('', { status: 404 })));
		expect(await text(await worker.fetch(navigation('/app/projects')))).toBe('<p>new build</p>');
		worker.goOffline();
		expect(await text(await worker.fetch(navigation('/app/')))).toBe('<p>new build</p>');
	});

	test('offline, any page of the app opens the kept shell', async () => {
		const worker = loadWorker();
		await worker.lifecycle('install');
		worker.goOffline();
		expect(await text(await worker.fetch(navigation('/app/project?project=p1')))).toBe(SHELL_HTML);
	});

	test('offline with nothing kept, the browser shows its own error', async () => {
		const worker = loadWorker(offline);
		// The worker answers with the network's failure (a pass-through would resolve to 'network').
		await expect(worker.fetch(navigation('/app/'))).rejects.toThrow('Failed to fetch');
	});

	test('a failed or redirected page is passed on and never kept as the shell', async () => {
		const worker = loadWorker();
		await worker.lifecycle('install');
		worker.setNetwork(async () => html('<p>server error</p>', 500));
		const failed = await worker.fetch(navigation('/app/'));
		expect(failed !== 'network' && failed.status).toBe(500);
		worker.setNetwork(async () => Response.redirect(`${ORIGIN}/app/`, 307));
		const moved = await worker.fetch(navigation('/app'));
		expect(moved !== 'network' && moved.status).toBe(307);
		worker.goOffline();
		expect(await text(await worker.fetch(navigation('/app/')))).toBe(SHELL_HTML);
	});

	test('built files are kept on first use and then served without the network', async () => {
		const worker = loadWorker();
		expect(await text(await worker.fetch(request('/assets/index-abc.js')))).toBe('js');
		worker.goOffline();
		expect(await text(await worker.fetch(request('/assets/index-abc.js')))).toBe('js');
		expect(worker.calls.filter((call) => call.url.endsWith('/assets/index-abc.js'))).toHaveLength(1);
	});

	test('a missing built file is not kept', async () => {
		const worker = loadWorker();
		const first = await worker.fetch(request('/assets/gone-123.js'));
		expect(first !== 'network' && first.status).toBe(404);
		await worker.fetch(request('/assets/gone-123.js'));
		expect(worker.calls.filter((call) => call.url.endsWith('/assets/gone-123.js'))).toHaveLength(2);
	});

	test("activating drops Caddie's caches from other builds and leaves other caches alone", async () => {
		const caches = new FakeCaches();
		await caches.open('caddie-shell-old');
		await caches.open('caddie-assets-old');
		await caches.open('someone-else');
		const worker = loadWorker(online, caches);
		await worker.lifecycle('install');
		await worker.lifecycle('activate');
		const names = await caches.keys();
		expect(names).toContain('someone-else');
		expect(names).not.toContain('caddie-shell-old');
		expect(names).not.toContain('caddie-assets-old');
		expect(names.filter((name) => name.startsWith('caddie-'))).toHaveLength(2);
	});
});

describe('build stamp (scripts/sw-stamp.ts)', () => {
	test('the worker source carries the placeholder exactly once', () => {
		const source = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
		expect(source.split(BUILD_PLACEHOLDER).length - 1).toBe(1);
	});

	test('stamping replaces it, and refuses a source without exactly one', () => {
		expect(stampServiceWorker(`const BUILD = '${BUILD_PLACEHOLDER}';`, 'abc123def456')).toBe("const BUILD = 'abc123def456';");
		expect(() => stampServiceWorker('const BUILD = 1;', 'abc')).toThrow();
		expect(() => stampServiceWorker(`${BUILD_PLACEHOLDER} ${BUILD_PLACEHOLDER}`, 'abc')).toThrow();
	});

	test("the stamp is the first 12 hex digits of the shell's sha256, so a new build means a new worker", () => {
		const shell = new TextEncoder().encode(SHELL_HTML);
		expect(buildStamp(shell)).toBe(createHash('sha256').update(shell).digest('hex').slice(0, 12));
		expect(buildStamp(new TextEncoder().encode(`${SHELL_HTML} `))).not.toBe(buildStamp(shell));
	});
});

describe('registration (apps/app/src/client/pwa.ts)', () => {
	test('only the built app under /app registers the worker', () => {
		const base = { production: true, pathname: '/app/', supported: true };
		expect(shouldRegisterServiceWorker(base)).toBe(true);
		expect(shouldRegisterServiceWorker({ ...base, pathname: '/app/project' })).toBe(true);
		expect(shouldRegisterServiceWorker({ ...base, production: false })).toBe(false);
		expect(shouldRegisterServiceWorker({ ...base, pathname: '/' })).toBe(false);
		expect(shouldRegisterServiceWorker({ ...base, pathname: '/application' })).toBe(false);
		expect(shouldRegisterServiceWorker({ ...base, supported: false })).toBe(false);
	});
});

describe('safe areas (apps/app/src/client/workspace.css)', () => {
	const css = () => readFileSync(join(ROOT, 'apps', 'app', 'src', 'client', 'workspace.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

	test('the four insets are read once, with a 0px fallback, and every use goes through them', () => {
		const sheet = css();
		for (const side of ['top', 'right', 'bottom', 'left']) {
			expect(sheet).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px);`);
		}
		expect(sheet.match(/env\(safe-area-inset-/g)).toHaveLength(4);
	});

	test('the shell and the panels pinned to the screen edge leave room for the status bar and notch', () => {
		const sheet = css();
		expect(sheet).toMatch(/\.app-shell\s*\{\s*padding-top: var\(--safe-top\);\s*padding-right: var\(--safe-right\);\s*padding-left: var\(--safe-left\);/);
		const bodies = (selector: string) => {
			const found: string[] = [];
			for (let at = sheet.indexOf(`${selector} {`); at >= 0; at = sheet.indexOf(`${selector} {`, at + 1)) {
				found.push(sheet.slice(at, sheet.indexOf('}', at)));
			}
			return found;
		};
		for (const selector of ['.cdp-pane', ".shell-right[data-conv-state='full']", '.modal-backdrop']) {
			expect({ selector, padded: bodies(selector).some((body) => body.includes('var(--safe-top)')) }).toEqual({ selector, padded: true });
		}
		// The tablet chat overlay is pinned to the top-right corner.
		const overlays = [...sheet.matchAll(/\.shell-right \{([^}]*)\}/g)].map((match) => match[1]!);
		expect(overlays.some((body) => body.includes('position: fixed') && body.includes('var(--safe-top)') && body.includes('var(--safe-right)'))).toBe(true);
	});
});
