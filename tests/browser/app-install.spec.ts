import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import type { AppHostFile } from '../../apps/app/src/server/app-host.ts';
import { publishedAssets } from '../../apps/app/src/server/published-page.ts';
import { appCsp } from '../../workers/dispatch/src/csp.ts';

/**
 * Plan step 2.4, improved: a published app can be installed from the
 * browser. The files are exactly what Caddie's publish step uploads
 * (published-page.ts), served from 127.0.0.1 (a secure context) with the
 * dispatch Worker's own CSP and the single-page fallback Workers static
 * assets use. Chromium's own installability check (DevTools protocol
 * Page.getInstallabilityErrors), in a normal profile, must find nothing.
 *
 * LOCAL VERIFIED at most: installing on a real Android phone or iPhone, and
 * Cloudflare's own asset serving, are not exercised here.
 */

// The root tsconfig omits the "dom" lib; this runs in the browser.
declare const Image: new () => { src: string; decode(): Promise<void>; naturalWidth: number; naturalHeight: number };

const CADDIE_ORIGIN = 'https://caddie.example.com';
const ICONS = ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'];

async function serve(files: AppHostFile[]): Promise<{ server: Server; origin: string; requests: string[] }> {
	const byPath = new Map(files.map((f) => [f.path, f]));
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? '/', 'http://local').pathname;
		requests.push(path);
		// Workers static assets with not_found_handling: single-page-application.
		const file = byPath.get(path === '/' ? '/index.html' : path) ?? byPath.get('/index.html')!;
		const headers: Record<string, string> = { 'content-type': file.contentType, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
		if (file.contentType.startsWith('text/html')) headers['content-security-policy'] = appCsp(CADDIE_ORIGIN);
		response.writeHead(200, headers);
		response.end(Buffer.from(file.bytes));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A normal profile: Chromium refuses to install from an incognito-like context. */
async function launchProfile(name: string): Promise<BrowserContext> {
	return chromium.launchPersistentContext(test.info().outputPath(name), { channel: 'chromium', headless: true });
}

const BUNDLE = {
	js: 'document.getElementById("root").textContent = "Farm Log is running";',
	css: 'body{font-family:system-ui;margin:0}',
};

test('Chromium finds nothing stopping an install of a published app', async () => {
	const files = await publishedAssets({ name: 'Farm Log', seed: 'proj-farm' }, BUNDLE);
	const { server, origin, requests } = await serve(files);
	const context = await launchProfile('profile-install');
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		const blocked: string[] = [];
		page.on('console', (message) => {
			if (/Content Security Policy|Manifest/i.test(message.text())) blocked.push(message.text());
		});
		await page.goto(`${origin}/`);
		await expect(page.locator('#root')).toHaveText('Farm Log is running');

		const cdp = await context.newCDPSession(page);
		const manifest = (await cdp.send('Page.getAppManifest')) as { url: string; errors: unknown[]; data?: string };
		expect(manifest.url).toBe(`${origin}/manifest.webmanifest`);
		expect(manifest.errors).toEqual([]);
		expect(JSON.parse(manifest.data ?? '{}')).toMatchObject({ name: 'Farm Log', short_name: 'Farm Log', display: 'standalone', start_url: '/' });

		const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] };
		expect(installabilityErrors).toEqual([]);
		expect(requests).toContain('/manifest.webmanifest');
		expect(blocked).toEqual([]);
	} finally {
		await context.close();
		server.close();
	}
});

test('each icon loads under the published page’s CSP at its stated size', async () => {
	const files = await publishedAssets({ name: 'Farm Log', seed: 'proj-farm' }, BUNDLE);
	const { server, origin } = await serve(files);
	const context = await launchProfile('profile-icons');
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(`${origin}/`);
		const sizes = await page.evaluate(
			async (paths) =>
				Promise.all(
					paths.map(async (src) => {
						const image = new Image();
						image.src = src;
						await image.decode();
						return [src, image.naturalWidth, image.naturalHeight];
					}),
				),
			ICONS,
		);
		expect(sizes).toEqual([
			['/icon-192.png', 192, 192],
			['/icon-512.png', 512, 512],
			['/icon-maskable-512.png', 512, 512],
			['/apple-touch-icon.png', 180, 180],
		]);
	} finally {
		await context.close();
		server.close();
	}
});

test('without the manifest link, Chromium says there is nothing to install (the check bites)', async () => {
	const files = await publishedAssets({ name: 'Farm Log', seed: 'proj-farm' }, BUNDLE);
	const page = files.find((f) => f.path === '/index.html')!;
	const html = new TextDecoder().decode(page.bytes).replace('<link rel="manifest" href="/manifest.webmanifest">\n', '');
	const { server, origin } = await serve(files.map((f) => (f === page ? { ...f, bytes: new TextEncoder().encode(html) } : f)));
	const context = await launchProfile('profile-no-manifest');
	try {
		const tab = context.pages()[0] ?? (await context.newPage());
		await tab.goto(`${origin}/`);
		const cdp = await context.newCDPSession(tab);
		const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] };
		expect(installabilityErrors.map((e) => e.errorId)).toContain('no-manifest');
	} finally {
		await context.close();
		server.close();
	}
});

// Evidence only: CADDIE_SHOTS=<dir> saves the icons as a phone would show them.
test('review sheet of icons for several apps', async ({ page }) => {
	test.skip(!process.env.CADDIE_SHOTS, 'evidence only: set CADDIE_SHOTS=<dir>');
	const names = ['Farm Log', 'Quiz Night', 'Wild Meadow', 'Money Map', '7 Minute Workout', '农场日记'];
	const tiles: string[] = [];
	for (const [i, name] of names.entries()) {
		const files = await publishedAssets({ name, seed: `proj-${i * 7 + 3}` }, BUNDLE);
		const url = (path: string) => `data:image/png;base64,${Buffer.from(files.find((f) => f.path === path)!.bytes).toString('base64')}`;
		const label = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === '/manifest.webmanifest')!.bytes)).short_name;
		tiles.push(
			`<figure><img src="${url('/icon-maskable-512.png')}" style="border-radius:50%"><img src="${url('/icon-maskable-512.png')}" style="border-radius:28%">` +
				`<img src="${url('/apple-touch-icon.png')}" style="border-radius:22%"><img src="${url('/icon-192.png')}"><figcaption>${label}</figcaption></figure>`,
		);
	}
	const sheet = (background: string, color: string) =>
		`<section style="background:${background};color:${color}">${tiles.join('')}</section>`;
	await page.setViewportSize({ width: 760, height: 400 });
	await page.setContent(
		'<!doctype html><html><head><style>body{margin:0;font:13px system-ui}section{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:20px}' +
			'figure{margin:0;display:grid;grid-template-columns:repeat(4,52px);gap:8px;align-items:center}img{width:52px;height:52px}' +
			'figcaption{grid-column:1/-1;text-align:left;opacity:.85}</style></head><body>' +
			sheet('#1f2430', '#fff') +
			sheet('#f3f4f6', '#111') +
			'</body></html>',
	);
	mkdirSync(process.env.CADDIE_SHOTS!, { recursive: true });
	await page.screenshot({ path: join(process.env.CADDIE_SHOTS!, 'app-icons-sheet.png'), fullPage: true });
});
