/*
 * Caddie's service worker. apps/app/src/client/pwa.ts registers it with scope
 * /app/, so it controls the workspace and never the landing page.
 *
 * It does three things and nothing else:
 *   - pages of the app (/app/...): network first. With no connection the kept
 *     app shell opens, and the app itself then says it is offline;
 *   - Vite's built files (/assets/..., named by their content hash and never
 *     changed in place): kept on first use, served from the cache after that;
 *   - everything else, above all /api and /agents (sign-in, data, the live
 *     conversation): left alone, straight to the network and never cached, so
 *     the app can never show stale data or invent an offline answer.
 *
 * BUILD is filled in when the assets are composed (scripts/compose-assets.ts,
 * scripts/sw-stamp.ts). Each build therefore installs a new worker, which
 * keeps the new shell and drops the caches of the build before it.
 */
'use strict';

const BUILD = '__CADDIE_BUILD__';
const SHELL_CACHE = 'caddie-shell-' + BUILD;
const ASSET_CACHE = 'caddie-assets-' + BUILD;
const SHELL_URL = '/app/';

function under(pathname, prefix) {
	return pathname === prefix || pathname.startsWith(prefix + '/');
}

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			// No connection: the install fails and the browser tries again on a later visit.
			const shell = await fetch(SHELL_URL, { cache: 'reload' });
			if (!shell.ok) return;
			const html = await shell.clone().text();
			await (await caches.open(SHELL_CACHE)).put(SHELL_URL, shell);
			// The JS and CSS the shell loads, so the first offline launch can start the app.
			const files = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]))];
			const assets = await caches.open(ASSET_CACHE);
			await Promise.all(
				files.map(async (file) => {
					const response = await fetch(file, { cache: 'reload' });
					if (response.ok) await assets.put(file, response);
				}),
			);
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const current = new Set([SHELL_CACHE, ASSET_CACHE]);
			const names = await caches.keys();
			await Promise.all(names.filter((name) => name.startsWith('caddie-') && !current.has(name)).map((name) => caches.delete(name)));
			await self.clients.claim();
		})(),
	);
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	// A devtools quirk: such a request must not be answered by a worker.
	if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (under(url.pathname, '/api') || under(url.pathname, '/agents')) return;
	if (request.mode === 'navigate') {
		if (under(url.pathname, '/app')) event.respondWith(appPage(request));
		return;
	}
	if (url.pathname.startsWith('/assets/')) event.respondWith(builtFile(request));
});

async function appPage(request) {
	try {
		const response = await fetch(request);
		// Every /app/ page is the same shell, so the newest good one is kept.
		if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
			await (await caches.open(SHELL_CACHE)).put(SHELL_URL, response.clone());
		}
		return response;
	} catch (error) {
		const kept = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
		if (kept) return kept;
		throw error;
	}
}

async function builtFile(request) {
	const cache = await caches.open(ASSET_CACHE);
	const kept = await cache.match(request);
	if (kept) return kept;
	const response = await fetch(request);
	if (response.ok) await cache.put(request, response.clone());
	return response;
}
