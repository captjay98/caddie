/**
 * The dispatch Worker: serves every published Caddie app on Caddie's apps
 * domain (`<slug>.<apps-domain>`) and on owners' custom domains (Cloudflare
 * for SaaS, Worker as fallback origin). PROPOSED — not deployed; see
 * ../wrangler.jsonc for the owner inputs it waits on.
 *
 * Per request:
 *   1. `/__caddie/health` answers 200 {ok:true}; any other `/__caddie/*` is 404
 *      (reserved, never reaches an app).
 *   2. The route record `route:<host>` (written by Caddie's publish service)
 *      decides: none -> 404 "No app lives at this address"; paused -> 404
 *      "isn't published right now"; blocked -> 451 takedown page with a link
 *      to Caddie; live -> the app's user Worker in the dispatch namespace,
 *      with the record's CPU/subrequest limits and the project/slug passed to
 *      the outbound Worker (outbound.ts). An app with a server also gets
 *      env.CADDIE (AppPlatform below) through `props`, bound to its project.
 *   3. Incoming `x-caddie-*` headers are removed before the app sees them.
 *   4. Every app response gets nosniff + a referrer policy; HTML documents
 *      also get Caddie's CSP APPENDED (an app's own policy still applies; a
 *      second policy can only tighten), cookies lose any Domain= attribute
 *      (host-only: one app can never set a cookie for another), and one small
 *      "Made with Caddie · Report" link is added at the end of the page.
 *   5. "Worker not found" -> 404 page; anything else -> 502 page with no
 *      internals.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeKey, type AppRoute } from '../../../packages/contracts/src/publish.ts';
import { dispatchPage, escapeAttr, reportUrl } from './pages.ts';

export interface DispatchEnv {
	ROUTES: { get(key: string, type: 'json'): Promise<unknown> };
	DISPATCHER: {
		get(
			name: string,
			args?: Record<string, unknown>,
			options?: { limits?: { cpuMs: number; subRequests: number }; outbound?: Record<string, unknown> },
		): { fetch(request: Request): Promise<Response> };
	};
	/** Caddie's own origin, e.g. https://caddie.example.com (report links, frame-ancestors). */
	CADDIE_ORIGIN: string;
	/** The apps domain, e.g. caddieapps.com. */
	APPS_DOMAIN: string;
	/** Service binding to Caddie's PublishedAppPlatform entrypoint (AI for published apps). */
	CADDIE_PLATFORM?: { ai(projectId: string, request: unknown): Promise<unknown> };
}

/** The per-request context: ctx.exports makes the props-bound platform capability. */
export interface DispatchContext {
	exports?: { AppPlatform?(options: { props: { projectId: string } }): unknown };
}

/**
 * env.CADDIE for a published app. The dispatch Worker makes one per request
 * with the project from the route record and hands it to the app's Worker in
 * `props`; the app can call ai() but can't read or change which project it
 * is. Each call goes to Caddie's PublishedAppPlatform over the service binding.
 */
export class AppPlatform extends WorkerEntrypoint<DispatchEnv, { projectId: string }> {
	async ai(request: unknown): Promise<unknown> {
		if (!this.env.CADDIE_PLATFORM) return { ok: false, reason: 'unavailable', message: "AI isn't available for this app right now." };
		return this.env.CADDIE_PLATFORM.ai(this.ctx.props.projectId, request);
	}
}

/**
 * Caddie's CSP for app documents. The page can load only its own scripts,
 * fetch only its own server and post forms only to itself — so a page cannot
 * send what a visitor types to another site; outside calls go through the
 * app's server (and its outbound policy).
 */
export function appCsp(caddieOrigin: string): string {
	return [
		"default-src 'self'",
		"script-src 'self'",
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

function parseRoute(value: unknown): AppRoute | null | 'invalid' {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'object') return 'invalid';
	const route = value as Partial<AppRoute>;
	const limits = route.limits as Partial<AppRoute['limits']> | undefined;
	if (
		route.v !== 1 ||
		typeof route.script !== 'string' ||
		route.script.length === 0 ||
		typeof route.projectId !== 'string' ||
		typeof route.slug !== 'string' ||
		(route.status !== 'live' && route.status !== 'blocked' && route.status !== 'paused') ||
		!limits ||
		typeof limits.cpuMs !== 'number' ||
		typeof limits.subRequests !== 'number'
	) {
		return 'invalid';
	}
	return route as AppRoute;
}

/** The request the app sees: same everything, minus Caddie's reserved headers. */
function forwardedRequest(request: Request): Request {
	const headers = new Headers(request.headers);
	for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('x-caddie-')) headers.delete(name);
	return new Request(request, { headers });
}

/** Drop any Domain= attribute so every cookie stays on the exact app host. */
export function hostOnlyCookie(cookie: string): string {
	return cookie
		.split(';')
		.filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
		.join(';');
}

function badgeHtml(caddieOrigin: string, slug: string): string {
	const href = escapeAttr(reportUrl(caddieOrigin, slug));
	return (
		`<a href="${href}" target="_blank" rel="noopener" data-caddie-badge="" aria-label="Made with Caddie. Report this app"` +
		' style="position:fixed;right:8px;bottom:8px;z-index:2147483647;font:12px/1.3 system-ui,-apple-system,sans-serif;' +
		'padding:4px 9px;border-radius:999px;background:rgba(20,20,20,.82);color:#fff;text-decoration:none">Made with Caddie · Report</a>'
	);
}

function isHtml(response: Response): boolean {
	return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

/** Headers, cookies, CSP and the badge on an app's response. */
export function secureAppResponse(response: Response, route: AppRoute, env: Pick<DispatchEnv, 'CADDIE_ORIGIN'>, method: string): Response {
	// 101 (WebSocket upgrade) responses cannot be rebuilt; pass them through untouched.
	if (response.status === 101) return response;
	const html = isHtml(response);
	const headers = new Headers(response.headers);
	headers.set('x-content-type-options', 'nosniff');
	if (!headers.has('referrer-policy')) headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
	if (cookies.length > 0) {
		headers.delete('set-cookie');
		for (const cookie of cookies) headers.append('set-cookie', hostOnlyCookie(cookie));
	}
	if (!html) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });

	headers.append('content-security-policy', appCsp(env.CADDIE_ORIGIN));
	if (method === 'HEAD') return new Response(null, { status: response.status, statusText: response.statusText, headers });
	const hasBody = response.body !== null && response.status !== 204 && response.status !== 304;
	if (!hasBody) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	headers.delete('content-length'); // the badge changes the length
	const rebuilt = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	let injected = false;
	const badge = badgeHtml(env.CADDIE_ORIGIN, route.slug);
	return new HTMLRewriter()
		.on('body', {
			element(element) {
				if (injected) return;
				injected = true;
				element.append(badge, { html: true });
			},
		})
		.onDocument({
			end(end) {
				if (injected) return;
				injected = true;
				end.append(badge, { html: true });
			},
		})
		.transform(rebuilt);
}

function isWorkerNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('Worker not found');
}

export async function handleDispatch(request: Request, env: DispatchEnv, ctx?: DispatchContext): Promise<Response> {
	const url = new URL(request.url);
	const pageOptions = { caddieOrigin: env.CADDIE_ORIGIN, method: request.method };
	if (url.pathname === '/__caddie/health' || url.pathname.startsWith('/__caddie/')) {
		if (url.pathname === '/__caddie/health' && (request.method === 'GET' || request.method === 'HEAD')) {
			return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
		}
		return dispatchPage('missing', pageOptions);
	}
	const host = url.hostname.toLowerCase().replace(/\.+$/, '');
	let route: AppRoute | null | 'invalid';
	try {
		route = parseRoute(await env.ROUTES.get(routeKey(host), 'json'));
	} catch {
		return dispatchPage('error', pageOptions);
	}
	if (route === 'invalid') return dispatchPage('error', pageOptions);
	if (route === null) return dispatchPage('missing', pageOptions);
	if (route.status === 'paused') return dispatchPage('paused', pageOptions);
	if (route.status === 'blocked') return dispatchPage('blocked', { ...pageOptions, slug: route.slug });

	let response: Response;
	try {
		// An app with a server gets Caddie's platform (env.CADDIE) for its own project.
		const platform = route.hasServer ? ctx?.exports?.AppPlatform?.({ props: { projectId: route.projectId } }) : undefined;
		const worker = env.DISPATCHER.get(route.script, platform ? { props: { CADDIE: platform } } : {}, {
			limits: { cpuMs: route.limits.cpuMs, subRequests: route.limits.subRequests },
			outbound: { projectId: route.projectId, slug: route.slug },
		});
		response = await worker.fetch(forwardedRequest(request));
	} catch (error) {
		if (isWorkerNotFound(error)) return dispatchPage('missing', pageOptions);
		console.error(JSON.stringify({ kind: 'dispatch-error', slug: route.slug, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
		return dispatchPage('error', pageOptions);
	}
	return secureAppResponse(response, route, env, request.method);
}

export default {
	fetch(request: Request, env: DispatchEnv, ctx: DispatchContext): Promise<Response> {
		return handleDispatch(request, env, ctx);
	},
};
