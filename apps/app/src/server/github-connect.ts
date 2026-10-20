import { GithubError, githubInstallUrl, type GithubEnv } from './adapters/github.ts';
import { ScopeError } from './scope.ts';

/**
 * Plan 6.1: GitHub connects in one click.
 *
 * The install link Caddie hands out carries a `state` GitHub returns on the
 * App's Setup URL (`GET /api/github/setup`) together with `installation_id`
 * and `setup_action`. GitHub warns that `installation_id` can be spoofed, so
 * the return connects only when its state is one Caddie signed, in the last
 * 30 minutes, for the same signed-in person: a link someone else crafts can
 * never connect their GitHub to your workspace. The installation itself is
 * then checked exactly as the by-id form checks it (`bindInstallation`: an
 * installation of Caddie's App, the needed permissions, one workspace each).
 *
 * The state is self-contained (no table): base64url(JSON) "." base64url(HMAC
 * under BETTER_AUTH_SECRET, purpose-labelled), so it cannot be changed.
 */

export const CONNECT_TTL_MS = 30 * 60 * 1000;

export interface ConnectRequest {
	readonly actorId: string;
	readonly workspaceId: string;
	/** The Caddie page to come back to, e.g. "/app/settings?project=p1". */
	readonly returnTo: string;
}

/** What GitHub's return came to, shown on the page as `?github=<outcome>`. */
export type GithubReturnOutcome =
	| 'connected'
	| 'requested'
	| 'not_signed_in'
	| 'expired'
	| 'not_found'
	| 'suspended'
	| 'missing_permissions'
	| 'already_bound'
	| 'not_configured'
	| 'failed';

const LABEL = 'caddie-github-connect:v1|';
const PART = /^[A-Za-z0-9_-]+$/;

/** A same-origin page under /app to come back to; anything else is "/app/". */
export function safeReturnTo(value: unknown): string {
	if (typeof value !== 'string' || value.length > 300) return '/app/';
	// Only Caddie's own pages: no other origin, no //host, no backslashes or
	// control characters a browser might read as something else.
	if (!/^\/app(?:[/?#]|$)/.test(value) || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) {
		return '/app/';
	}
	return value;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
	if (!PART.test(text)) return null;
	try {
		const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

async function mac(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(LABEL + body))));
}

function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let differing = 0;
	for (let i = 0; i < a.length; i++) differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return differing === 0;
}

/** Sign a connect request for GitHub's `state` parameter. */
export async function connectState(secret: string, request: ConnectRequest, nowMs = Date.now()): Promise<string> {
	const body = toBase64Url(
		new TextEncoder().encode(
			JSON.stringify({ a: request.actorId, w: request.workspaceId, r: safeReturnTo(request.returnTo), t: nowMs }),
		),
	);
	return `${body}.${await mac(secret, body)}`;
}

/** The state GitHub handed back: null unless Caddie signed it, intact, in the last 30 minutes. */
export async function readConnectState(
	secret: string,
	state: unknown,
	nowMs = Date.now(),
): Promise<(ConnectRequest & { issuedAt: number }) | null> {
	if (typeof state !== 'string' || state.length > 1000) return null;
	const [body, signature, extra] = state.split('.');
	if (!body || !signature || extra !== undefined || !PART.test(signature)) return null;
	if (!sameText(signature, await mac(secret, body))) return null;
	const bytes = fromBase64Url(body);
	if (!bytes) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
	const { a, w, r, t } = (payload ?? {}) as Record<string, unknown>;
	if (typeof a !== 'string' || !a || typeof w !== 'string' || !w || typeof t !== 'number') return null;
	if (t > nowMs + 60_000 || nowMs - t > CONNECT_TTL_MS) return null;
	return { actorId: a, workspaceId: w, returnTo: safeReturnTo(r), issuedAt: t };
}

/** The App's install page carrying the state, or null when the slug is not configured. */
export function connectInstallUrl(env: Partial<GithubEnv>, state: string): string | null {
	const base = githubInstallUrl(env);
	return base ? `${base}?state=${encodeURIComponent(state)}` : null;
}

/** Where GitHub's return sends the person: the page they came from, with the outcome. */
export function returnLocation(returnTo: string, outcome: GithubReturnOutcome): string {
	const page = new URL(safeReturnTo(returnTo), 'https://caddie.invalid');
	page.searchParams.set('github', outcome);
	return `${page.pathname}${page.search}${page.hash}`;
}

/** A refused connection as one plain outcome (the page words it), never raw error text. */
export function setupOutcome(error: unknown): GithubReturnOutcome {
	if (error instanceof GithubError) return error.code === 'GITHUB_NOT_CONFIGURED' ? 'not_configured' : 'failed';
	if (error instanceof ScopeError) {
		const outcomes: Record<string, GithubReturnOutcome> = {
			installation_not_found: 'not_found',
			installation_already_bound: 'already_bound',
			installation_suspended: 'suspended',
			installation_missing_permissions: 'missing_permissions',
		};
		return outcomes[error.code] ?? 'failed';
	}
	return 'failed';
}
