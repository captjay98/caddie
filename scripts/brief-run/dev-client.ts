/**
 * Lane 8, step 1 — a client for the LOCAL dev server (`bun run dev`).
 *
 * The owner runs `bun run dev` with live keys in `apps/app/.dev.vars` and
 * `AUTH_TEST_MODE=1` so the stub OAuth provider (see
 * `apps/app/src/server/auth.ts`) is active. This client:
 *   - REFUSES any base URL whose host is not 127.0.0.1 or localhost, so the
 *     campaign runner can only ever drive a local dev server, never a deployed
 *     origin (a defence against a mis-set CADDIE_DEV_BASE_URL);
 *   - signs in two local accounts, A and B, through the SAME test sign-in the
 *     fixtures use — POST /api/auth/sign-in/social with a provider, follow the
 *     stub provider's authorize redirect, then the callback (mirrors
 *     tests/fixtures/controls-harness.ts driveOAuth);
 *   - keeps a per-account cookie jar and offers a scoped `fetch` that carries
 *     it and never auto-follows redirects.
 *
 * Everything that touches the network goes through an INJECTED fetch, so the
 * whole client is driven offline in tests with a fake transport. No real call
 * is ever made from a test.
 */

/** The minimal fetch shape we depend on (Bun/undici `fetch`). Injected. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A record of sign-in profiles for the two campaign accounts. */
export interface AccountProfile {
	/** The account label used in reports and the browser check. */
	label: 'A' | 'B';
	/** The provider subject (stable identity key) for the stub provider. */
	sub: string;
	email: string;
	name: string;
}

export class HostNotLocalError extends Error {
	constructor(readonly host: string) {
		super(
			`refusing a non-local dev base: host ${JSON.stringify(
				host,
			)} is not 127.0.0.1 or localhost. The campaign runner drives only a local \`bun run dev\`.`,
		);
		this.name = 'HostNotLocalError';
	}
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * Assert a base URL points at the local dev server and return its normalised
 * origin (no trailing slash). Throws HostNotLocalError for any other host —
 * including a link-local or private address that is not literally 127.0.0.1.
 */
export function assertLocalBase(baseUrl: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new HostNotLocalError(baseUrl);
	}
	if (!LOCAL_HOSTS.has(url.hostname)) throw new HostNotLocalError(url.hostname);
	return url.origin;
}

/** A tiny cookie jar: last-write-wins per cookie name, serialised as a header. */
export class CookieJar {
	private readonly cookies = new Map<string, string>();

	header(): string {
		return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	/** Absorb a response's Set-Cookie header(s). */
	absorb(res: Response): void {
		// Prefer getSetCookie() when the runtime exposes it (undici/Bun): it
		// returns each Set-Cookie separately, so a cookie value containing a
		// comma is never mis-split.
		const list =
			typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
				? (res.headers as { getSetCookie(): string[] }).getSetCookie()
				: splitSetCookie(res.headers.get('set-cookie'));
		for (const raw of list) {
			const [pair] = raw.split(';');
			const eq = pair.indexOf('=');
			if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	}

	/** For tests/inspection: whether a named cookie is present. */
	has(name: string): boolean {
		return this.cookies.has(name);
	}

	/** Seed the jar from a `Cookie:` header (the owner's saved sign-in, item 1). */
	setFromHeader(header: string): void {
		for (const pair of header.split(';')) {
			const trimmed = pair.trim();
			if (!trimmed) continue;
			const eq = trimmed.indexOf('=');
			if (eq > 0) this.cookies.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
		}
	}
}

/** Split a folded Set-Cookie header on commas that start a new `name=` pair. */
function splitSetCookie(value: string | null): string[] {
	if (!value) return [];
	return value.split(/,(?=[^ ;]+=)/);
}

/**
 * A dev-server client bound to one local base URL and one injected fetch.
 * Create one `AccountSession` per account via `signIn`.
 */
export class DevClient {
	readonly base: string;

	constructor(
		baseUrl: string,
		private readonly fetchImpl: FetchLike,
	) {
		this.base = assertLocalBase(baseUrl);
	}

	/** A redirect-manual fetch against the dev base, with no cookies. */
	private rawFetch(path: string, init?: RequestInit): Promise<Response> {
		const url = path.startsWith('http') ? path : `${this.base}${path}`;
		// Only a local absolute URL may be followed (the stub redirect is local).
		if (path.startsWith('http')) assertLocalBase(path);
		const headers = new Headers(init?.headers);
		return this.fetchImpl(url, { ...init, headers, redirect: 'manual' });
	}

	/**
	 * Sign in one account through the stub OAuth provider — the exact flow the
	 * fixtures use (`driveOAuth`): start social sign-in, follow the stub's
	 * authorize redirect, then hit the callback. Returns a cookie-bearing
	 * session scoped to that account.
	 */
	async signIn(profile: AccountProfile, provider = 'google'): Promise<AccountSession> {
		const jar = new CookieJar();
		const start = await this.fetchWithJar(jar, '/api/auth/sign-in/social', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				provider,
				callbackURL: '/',
				// The stub provider reads the requested profile from the start
				// request so two accounts get two identities from one stub.
				requestProfile: { sub: profile.sub, email: profile.email, name: profile.name, email_verified: true },
			}),
		});
		if (!start.ok) {
			throw new Error(`sign-in start for account ${profile.label} failed: HTTP ${start.status}`);
		}
		const body = (await start.json()) as { url?: string };
		if (!body.url) throw new Error(`sign-in for ${profile.label} returned no authorization url`);
		// The authorize URL points at the stub provider (local). Follow it to
		// its redirect back to the app's callback, then drive the callback.
		assertLocalBase(body.url);
		const authorize = await this.fetchWithJar(jar, body.url);
		const callback = authorize.headers.get('location');
		if (!callback) throw new Error(`stub provider did not redirect back for ${profile.label}`);
		await this.fetchWithJar(jar, callback);
		return new AccountSession(profile, this.base, jar, (p, init) => this.fetchWithJar(jar, p, init));
	}

	/** A jar-carrying, redirect-manual fetch — absorbs Set-Cookie after each hop. */
	private async fetchWithJar(jar: CookieJar, path: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers);
		const cookie = jar.header();
		if (cookie) headers.set('cookie', cookie);
		const res = await this.rawFetch(path, { ...init, headers });
		jar.absorb(res);
		return res;
	}

	/**
	 * Build a session from the owner's SAVED cookie header (item 1): every live
	 * run loads the owner's cookies from tests/briefs/runs/.auth/owner.json for
	 * the API calls instead of the stub-provider sign-in, which cannot work
	 * against the owner's real Google sign-in. The profile is cosmetic (labels
	 * in reports); the identity is the cookies.
	 */
	sessionFromCookieHeader(profile: AccountProfile, cookieHeader: string): AccountSession {
		const jar = new CookieJar();
		jar.setFromHeader(cookieHeader);
		return new AccountSession(profile, this.base, jar, (p, init) => this.fetchWithJar(jar, p, init));
	}
}

/** One signed-in account's view of the dev server: a cookie-bearing fetch. */
export class AccountSession {
	constructor(
		readonly profile: AccountProfile,
		readonly base: string,
		readonly jar: CookieJar,
		private readonly scopedFetch: (path: string, init?: RequestInit) => Promise<Response>,
	) {}

	get label(): 'A' | 'B' {
		return this.profile.label;
	}

	/** Fetch a path on the dev server as this account (cookies attached). */
	fetch(path: string, init?: RequestInit): Promise<Response> {
		return this.scopedFetch(path, init);
	}

	/** Fetch and parse JSON, throwing on a non-2xx with the status in the message. */
	async json<T>(path: string, init?: RequestInit): Promise<T> {
		const res = await this.fetch(path, init);
		if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${res.status}`);
		return (await res.json()) as T;
	}
}
