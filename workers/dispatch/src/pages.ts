/**
 * The small pages the dispatch Worker answers with when it does not hand a
 * request to an app: no app at this address, unpublished, taken down, or the
 * app could not load. Plain words, accessible, phone-friendly, no scripts, no
 * outside resources, never cached, never framed.
 */

export type DispatchPageKind = 'missing' | 'paused' | 'blocked' | 'error';

const COPY: Record<DispatchPageKind, { status: number; title: string; body: string }> = {
	missing: { status: 404, title: 'No app here', body: 'No app lives at this address.' },
	paused: { status: 404, title: 'Not published right now', body: "This app isn't published right now. Its owner has taken it offline." },
	blocked: { status: 451, title: 'App taken down', body: "This app was taken down for breaking Caddie's rules." },
	error: { status: 502, title: "Couldn't load this app", body: "This app couldn't load right now. Try again in a moment." },
};

export const PAGE_HEADERS: Record<string, string> = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Escape for HTML text content. */
export function escapeText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for a double- or single-quoted HTML attribute value. */
export function escapeAttr(text: string): string {
	return escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The report link for an app, on Caddie's own origin. */
export function reportUrl(caddieOrigin: string, slug: string): string {
	return `${caddieOrigin.replace(/\/+$/, '')}/report?app=${encodeURIComponent(slug)}`;
}

export function dispatchPage(kind: DispatchPageKind, options: { caddieOrigin: string; slug?: string; method?: string }): Response {
	const copy = COPY[kind];
	const link =
		kind === 'blocked' && options.slug
			? `<p><a href="${escapeAttr(reportUrl(options.caddieOrigin, options.slug))}">Questions about this? Contact Caddie</a></p>`
			: '';
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeText(copy.title)}</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f7f5;color:#1c1c1a;display:grid;min-height:100vh;place-items:center}
main{max-width:32rem;padding:1.5rem}
h1{font-size:1.4rem;margin:0 0 .5rem}
p{margin:.5rem 0}
a{color:#1a5fb4}
@media (prefers-color-scheme:dark){body{background:#151513;color:#ecece8}a{color:#8ab4f8}}
</style>
</head>
<body>
<main>
<h1>${escapeText(copy.title)}</h1>
<p>${escapeText(copy.body)}</p>
${link}
</main>
</body>
</html>`;
	return new Response(options.method === 'HEAD' ? null : html, { status: copy.status, headers: PAGE_HEADERS });
}
