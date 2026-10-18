/**
 * Caddie's egress policy: may a generated app's server reach this URL?
 *
 * One pure function serves both places an app's server runs: the preview
 * isolate's outbound gate (preview-outbound.ts) and, later, the published
 * apps' outbound Worker. Runtime-neutral (no cloudflare:* imports), so it is
 * unit-tested under Bun.
 *
 * Denied:
 *   - anything but http: / https:
 *   - IP literals in private, loopback, link-local, CGNAT, benchmarking,
 *     multicast, reserved and documentation ranges (IPv4), and the IPv6
 *     equivalents plus every form that embeds an IPv4 address (mapped,
 *     compatible, NAT64, 6to4). The WHATWG URL parser has already turned
 *     decimal / hex / octal IPv4 spellings into dotted quads, and IPv6 into
 *     its compressed hex form, before this sees the host.
 *   - local names: localhost and *.localhost, *.local, *.internal,
 *     *.home.arpa, and single-label hosts (no public site is one)
 *   - the deny list: Caddie's own hosts and the apps domain (no loops back
 *     into Caddie), plus operator additions — exact host or any subdomain
 *
 * Everything else is allowed: that is what an app's keys are for.
 */

export type OutboundDecision = { allow: true } | { allow: false; reason: OutboundDenyReason };
export type OutboundDenyReason = 'scheme' | 'private-address' | 'local-name' | 'denied-host';

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

// [network, prefix length] for IPv4.
const DENIED_V4: ReadonlyArray<readonly [string, number]> = [
	['0.0.0.0', 8], // "this network"
	['10.0.0.0', 8], // private
	['100.64.0.0', 10], // CGNAT
	['127.0.0.0', 8], // loopback
	['169.254.0.0', 16], // link-local (cloud metadata lives here)
	['172.16.0.0', 12], // private
	['192.0.0.0', 24], // IETF protocol assignments
	['192.0.2.0', 24], // documentation
	['192.88.99.0', 24], // 6to4 relay anycast
	['192.168.0.0', 16], // private
	['198.18.0.0', 15], // benchmarking
	['198.51.100.0', 24], // documentation
	['203.0.113.0', 24], // documentation
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4], // reserved + broadcast
];

function v4ToInt(text: string): number | null {
	const parts = text.split('.');
	if (parts.length !== 4) return null;
	let out = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const n = Number(part);
		if (n > 255) return null;
		out = out * 256 + n;
	}
	return out;
}

const DENIED_V4_INT = DENIED_V4.map(([network, bits]) => {
	const base = v4ToInt(network)!;
	const size = 2 ** (32 - bits);
	return [base, base + size - 1] as const;
});

function v4Denied(address: number): boolean {
	return DENIED_V4_INT.some(([lo, hi]) => address >= lo && address <= hi);
}

/** Parse a bracket-less IPv6 literal into its eight 16-bit groups. */
function v6Groups(text: string): number[] | null {
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const parse = (part: string) => (part === '' ? [] : part.split(':'));
	const head = parse(halves[0]!);
	const tail = halves.length === 2 ? parse(halves[1]!) : [];
	// A trailing dotted IPv4 (the URL parser never emits one, but be strict).
	const last = (halves.length === 2 ? tail : head).at(-1);
	const embedded = last !== undefined && last.includes('.') ? v4ToInt(last) : null;
	if (last !== undefined && last.includes('.')) {
		if (embedded === null) return null;
		(halves.length === 2 ? tail : head).splice(-1, 1, ((embedded >>> 16) & 0xffff).toString(16), (embedded & 0xffff).toString(16));
	}
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
	const out: number[] = [];
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
		out.push(parseInt(group, 16));
	}
	return out.length === 8 ? out : null;
}

function v6Denied(g: number[]): boolean {
	const zeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
	if (zeroUntil(8)) return true; // ::
	if (zeroUntil(7) && g[7] === 1) return true; // ::1
	if (zeroUntil(5) && g[5] === 0xffff) return true; // ::ffff:0:0/96 IPv4-mapped
	if (zeroUntil(6)) return true; // ::/96 IPv4-compatible (deprecated)
	if (g[0] === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 and /48 NAT64
	if (g[0] === 0x2002) return true; // 6to4 embeds an IPv4 address
	if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
	if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
	const first = g[0]!;
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
	if ((first & 0xff00) === 0xff00) return true; // multicast
	return false;
}

/** Normalise a deny-list entry or host: lower-case, no trailing dot. */
function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.+$/, '');
}

/** Parse a comma-separated deny list (env), dropping blanks. */
export function parseDenyHosts(raw: string | null | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map(normalizeHost)
		.filter((host) => host.length > 0);
}

/** The deny list for an environment: Caddie's own origin, the apps domain and operator additions. */
export function egressDenyHosts(env: { BETTER_AUTH_URL?: string; APPS_DOMAIN?: string; EGRESS_DENY_HOSTS?: string }): string[] {
	const hosts = parseDenyHosts(env.EGRESS_DENY_HOSTS);
	if (env.BETTER_AUTH_URL) {
		try {
			hosts.push(normalizeHost(new URL(env.BETTER_AUTH_URL).hostname));
		} catch {
			// an unparsable origin adds nothing
		}
	}
	if (env.APPS_DOMAIN) hosts.push(normalizeHost(env.APPS_DOMAIN));
	return [...new Set(hosts.filter((host) => host.length > 0))];
}

export function outboundDecision(url: URL, denyHosts: readonly string[] = []): OutboundDecision {
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return { allow: false, reason: 'scheme' };
	const raw = url.hostname.toLowerCase();
	if (raw.startsWith('[') && raw.endsWith(']')) {
		const groups = v6Groups(raw.slice(1, -1));
		if (groups === null || v6Denied(groups)) return { allow: false, reason: 'private-address' };
		return { allow: true };
	}
	const host = normalizeHost(raw);
	const v4 = v4ToInt(host);
	if (v4 !== null) return v4Denied(v4) ? { allow: false, reason: 'private-address' } : { allow: true };
	if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) || !host.includes('.')) {
		return { allow: false, reason: 'local-name' };
	}
	for (const denied of denyHosts) {
		const entry = normalizeHost(denied);
		if (entry && (host === entry || host.endsWith(`.${entry}`))) return { allow: false, reason: 'denied-host' };
	}
	return { allow: true };
}

/** The plain message an app's server gets back when Caddie refuses an outside request. */
export function egressDeniedMessage(reason: OutboundDenyReason): string {
	switch (reason) {
		case 'scheme':
			return 'Apps can only make web (http or https) requests.';
		case 'private-address':
		case 'local-name':
			return 'Apps cannot reach private or local network addresses.';
		case 'denied-host':
			return 'Apps cannot call Caddie itself or other Caddie apps from their server.';
	}
}

export interface EgressLogEntry {
	readonly method: string;
	readonly host: string;
	readonly decision: 'allow' | 'deny';
	readonly reason?: OutboundDenyReason;
	readonly hop: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_DROPPED = ['authorization', 'proxy-authorization', 'cookie'];

export function egressDeniedResponse(reason: OutboundDenyReason): Response {
	return Response.json({ error: 'egress_denied', reason, message: egressDeniedMessage(reason) }, { status: 403 });
}

/**
 * Make an app's outside request under the policy. Redirects are followed by
 * hand so EVERY hop is checked (an allowed site cannot bounce the app to a
 * private address), credentials are dropped when a redirect changes origin
 * (as the Fetch standard does for Authorization), and a body is never
 * buffered: a 307/308 that would need it re-sent is handed back unfollowed.
 * Logs carry the method, host and decision only — never paths, query
 * strings, headers or bodies.
 */
export async function fetchWithPolicy(
	request: Request,
	options: {
		denyHosts: readonly string[];
		upstream: (request: Request) => Promise<Response>;
		log?: (entry: EgressLogEntry) => void;
		maxRedirects?: number;
	},
): Promise<Response> {
	const mode = request.redirect === 'manual' || request.redirect === 'error' ? request.redirect : 'follow';
	const maxRedirects = options.maxRedirects ?? 5;
	let method = request.method.toUpperCase();
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return egressDeniedResponse('scheme');
	}
	const hasBody = request.body !== null && method !== 'GET' && method !== 'HEAD';
	let headers = new Headers(request.headers);
	let next: Request = new Request(request, { redirect: 'manual' });
	for (let hop = 0; ; hop++) {
		const decision = outboundDecision(url, options.denyHosts);
		options.log?.({ method, host: url.hostname, decision: decision.allow ? 'allow' : 'deny', ...(decision.allow ? {} : { reason: decision.reason }), hop });
		if (!decision.allow) {
			await next.body?.cancel().catch(() => undefined);
			return egressDeniedResponse(decision.reason);
		}
		const response = await options.upstream(next);
		const location = response.headers.get('location');
		if (!REDIRECT_STATUSES.has(response.status) || location === null || mode === 'manual') return response;
		if (mode === 'error') {
			await response.body?.cancel().catch(() => undefined);
			throw new TypeError('The outside service answered with a redirect.');
		}
		if (hop >= maxRedirects) {
			await response.body?.cancel().catch(() => undefined);
			throw new TypeError('The outside service redirected too many times.');
		}
		let target: URL;
		try {
			target = new URL(location, url);
		} catch {
			return response;
		}
		// Fetch-standard method rewrite: 303 always, 301/302 for POST, become a bodiless GET.
		const toGet = response.status === 303 ? method !== 'HEAD' : (response.status === 301 || response.status === 302) && method === 'POST';
		if (!toGet && hasBody && method !== 'GET' && method !== 'HEAD') return response; // 307/308 would need the body again
		await response.body?.cancel().catch(() => undefined);
		if (toGet) {
			method = 'GET';
			headers = new Headers(headers);
			for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
		}
		if (target.origin !== url.origin) {
			headers = new Headers(headers);
			for (const name of CROSS_ORIGIN_DROPPED) headers.delete(name);
		}
		url = target;
		next = new Request(url.toString(), { method, headers, redirect: 'manual' });
	}
}
