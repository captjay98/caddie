import { androidQrSvg } from './android-qr.ts';
import type { AppHostFile } from './app-host.ts';
import { ICON_FILES, appIconFiles } from './app-icons.ts';

/**
 * The files a published app is served from (plan step 2.4, improved): the
 * page, the app's two built files, a web app manifest and its icons. With
 * them, Chrome on Android offers "Install app" and installs the app like any
 * other (no APK, no "unknown apps" permission), and an iPhone's "Add to Home
 * Screen" opens it full screen with its own icon and name.
 *
 * Caddie writes all of it at publish time, so it works for every app and the
 * model that builds an app cannot break it. Deliberately left out:
 *   - a service worker: Chrome installs from its menu without one (Chrome 108
 *     on Android), and a cached copy could keep showing an old version after
 *     the owner publishes a new one;
 *   - viewport-fit=cover: apps don't pad for the notch, so it would put their
 *     content under it;
 *   - a theme colour: Caddie doesn't know the app's colours, and a wrong one
 *     would tint the phone's status bar.
 * The dispatch Worker's CSP (default-src 'self') allows the same-origin
 * manifest and icons; tests/browser/app-install.spec.ts checks the page is
 * installable under that exact policy.
 *
 * Plain module on purpose (no Worker-only imports), so a browser test can
 * build the same files.
 */

const MAX_NAME = 60;
const MAX_SHORT_NAME = 12;

function escapeText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
	return escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The label under the home-screen icon: whole words up to 12 characters. */
export function shortName(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return 'My app';
	let out = '';
	for (const word of words) {
		const next = out ? `${out} ${word}` : word;
		if (next.length > MAX_SHORT_NAME) break;
		out = next;
	}
	// A trailing word with no letter or digit ("Farm &") reads as a typo.
	out = out.replace(/(\s+[^\p{L}\p{N}]+)+$/u, '');
	return out || words[0]!.slice(0, MAX_SHORT_NAME);
}

export interface AppManifest {
	id: string;
	name: string;
	short_name: string;
	start_url: string;
	scope: string;
	display: 'standalone';
	background_color: string;
	icons: { src: string; sizes: string; type: string; purpose?: 'maskable' }[];
}

export function appManifest(name: string): AppManifest {
	const full = name.trim().slice(0, MAX_NAME) || 'My app';
	return {
		id: '/',
		name: full,
		short_name: shortName(full),
		start_url: '/',
		scope: '/',
		display: 'standalone',
		background_color: '#ffffff',
		icons: ICON_FILES.filter((f) => f.purpose !== 'apple').map((f) => ({
			src: f.path,
			sizes: `${f.size}x${f.size}`,
			type: 'image/png',
			...(f.purpose === 'maskable' ? { purpose: 'maskable' as const } : {}),
		})),
	};
}

/**
 * index.html + main.js + main.css + manifest + icons. The page loads its own
 * files only (the dispatch Worker's CSP forbids inline scripts). `seed` (the
 * project id) picks the icon colour, so renaming the app keeps it.
 */
export async function publishedAssets(app: { name: string; seed: string }, bundle: { js: string; css: string; android?: { downloadUrl: string; bytes: number } }): Promise<AppHostFile[]> {
	const title = app.name.slice(0, 120);
  if (bundle.android) {
    const url = new URL(bundle.android.downloadUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('An Android download needs a plain HTTPS address.');
    const encode = (value: string) => new TextEncoder().encode(value);
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + escapeText(title) + '</title><link rel="stylesheet" href="/android.css"></head><body><main><h1>' + escapeText(title) + '</h1><p>An Android app built with Caddie.</p><a href="' + escapeAttr(url.href) + '">Download Android app (' + (bundle.android.bytes / 1_000_000).toFixed(1) + ' MB)</a><p>Scan on your Android phone to download.</p><img src="/android-qr.svg" width="256" height="256" alt="Scan to download this Android app"><p>Android may ask you to allow installation from your browser. Only install apps you trust.</p></main></body></html>';
    return [
      { path: '/index.html', bytes: encode(html), contentType: 'text/html; charset=utf-8' },
      { path: '/android.css', bytes: encode('body{font:18px system-ui,sans-serif;background:#f6f5f0;color:#17221b;margin:0;padding:32px}main{max-width:560px;margin:32px auto}a{display:inline-block;background:#225d3c;color:white;padding:14px 20px;border-radius:12px}img{display:block;background:white;max-width:100%;height:auto}p{line-height:1.5}'), contentType: 'text/css; charset=utf-8' },
      { path: '/android-qr.svg', bytes: encode(androidQrSvg(url.href)), contentType: 'image/svg+xml' },
    ];
  }
	const html =
		'<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
		`<title>${escapeText(title)}</title>\n` +
		'<link rel="manifest" href="/manifest.webmanifest">\n' +
		'<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">\n' +
		'<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n' +
		`<meta name="apple-mobile-web-app-title" content="${escapeAttr(shortName(title))}">\n` +
		'<link rel="stylesheet" href="/main.css">\n</head>\n<body>\n<div id="root"></div>\n' +
		'<script type="module" src="/main.js"></script>\n</body>\n</html>\n';
	const encode = (text: string) => new TextEncoder().encode(text);
	return [
		{ path: '/index.html', bytes: encode(html), contentType: 'text/html; charset=utf-8' },
		{ path: '/main.js', bytes: encode(bundle.js), contentType: 'text/javascript; charset=utf-8' },
		{ path: '/main.css', bytes: encode(bundle.css), contentType: 'text/css; charset=utf-8' },
		{ path: '/manifest.webmanifest', bytes: encode(JSON.stringify(appManifest(app.name))), contentType: 'application/manifest+json' },
		...(await appIconFiles(app)),
	];
}
