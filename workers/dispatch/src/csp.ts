/**
 * Caddie's CSP for app documents. The page can load only its own scripts,
 * fetch only its own server and post forms only to itself — so a page cannot
 * send what a visitor types to another site; outside calls go through the
 * app's server (and its outbound policy). `default-src 'self'` also covers the
 * app's manifest and icons (published-page.ts), which are same-origin files.
 * 'wasm-unsafe-eval' lets the app compile WebAssembly (sql.js and the like);
 * JavaScript eval stays blocked (owner OK, 2026-10-20).
 *
 * Its own module (no Worker-only imports) so tests/browser/app-install.spec.ts
 * can serve a published page under exactly this policy.
 */
export function appCsp(caddieOrigin: string): string {
	return [
		"default-src 'self'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"style-src 'self' 'unsafe-inline' https:",
		"img-src 'self' data: blob: https:",
		"media-src 'self' data: blob: https:",
		"font-src 'self' data: https:",
		"connect-src 'self'",
		"form-action 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		`frame-ancestors 'self' ${caddieOrigin.replace(/\/+$/, '')}`,
	].join('; ');
}
