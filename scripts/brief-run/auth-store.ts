/**
 * Lane 8, item 1 — the owner's saved sign-in, used by every later run.
 *
 * The dev server runs with the owner's REAL Google sign-in, so the stub
 * provider sign-in (dev-client.ts) cannot work there. Instead `--sign-in`
 * (see ./sign-in.ts) opens a visible Chromium, waits for the owner to sign in,
 * and saves the browser's storage state to tests/briefs/runs/.auth/owner.json
 * (already gitignored through tests/briefs/runs/). Every later run loads its
 * cookies from that file for the API calls and the browser check.
 *
 * This module is the FILE + the refusals, kept pure and testable:
 *   - the path resolver (so the runner and the sign-in flow agree on one file);
 *   - loadStorageState: read the saved Playwright storageState JSON;
 *   - cookieHeaderFor: turn that state's cookies into a `Cookie:` header for
 *     the base's origin (what the API seams need);
 *   - the two refusals — a MISSING file, and a 401 from /api/home-project —
 *     each returning the one plain sentence telling the owner to run
 *     `bun scripts/brief-run.ts --sign-in`.
 *
 * Everything is driven over injected seams (fs + a status probe), so the whole
 * module runs offline in tests with fakes and no real browser or network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The one sentence the owner sees whenever the saved sign-in is unusable. */
export const SIGN_IN_PROMPT = 'Run `bun scripts/brief-run.ts --sign-in` and sign in as the owner first.';

/**
 * A Playwright storageState file, the shape `context.storageState()` writes and
 * `browser.newContext({ storageState })` reads. We depend only on `cookies`.
 */
export interface StorageState {
	cookies: Array<{
		name: string;
		value: string;
		domain?: string;
		path?: string;
		expires?: number;
		httpOnly?: boolean;
		secure?: boolean;
		sameSite?: 'Strict' | 'Lax' | 'None';
	}>;
	origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
}

/** The saved-auth path for a campaign runs directory (tests/briefs/runs). */
export function ownerAuthPath(runsDir: string): string {
	return join(runsDir, '.auth', 'owner.json');
}

/** A tiny fs seam so the store is tested with no disk. */
export interface AuthFs {
	exists(path: string): boolean;
	read(path: string): string;
	write(path: string, data: string): void;
}

export const nodeAuthFs: AuthFs = {
	exists: (path) => existsSync(path),
	read: (path) => readFileSync(path, 'utf8'),
	write: (path, data) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, data);
	},
};

/** Raised when the saved sign-in cannot be used; carries the owner prompt. */
export class SignInRequiredError extends Error {
	constructor(readonly why: 'missing-file' | 'unauthorized') {
		super(
			why === 'missing-file'
				? `No saved sign-in was found. ${SIGN_IN_PROMPT}`
				: `The saved sign-in is no longer valid (the server answered 401). ${SIGN_IN_PROMPT}`,
		);
		this.name = 'SignInRequiredError';
	}
}

/**
 * Load the saved storage state. Throws SignInRequiredError('missing-file')
 * when the file is absent, and a plain Error when the file is present but not
 * valid JSON with a cookies array (a corrupt file is a different fault from a
 * missing one and must not read as "just sign in again" silently).
 */
export function loadStorageState(path: string, fs: AuthFs = nodeAuthFs): StorageState {
	if (!fs.exists(path)) throw new SignInRequiredError('missing-file');
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.read(path));
	} catch (error) {
		throw new Error(`the saved sign-in at ${path} is not valid JSON (${error instanceof Error ? error.message : 'parse error'})`);
	}
	if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as StorageState).cookies)) {
		throw new Error(`the saved sign-in at ${path} has no cookies array`);
	}
	return parsed as StorageState;
}

/** Save a storage state to the file (creating the .auth dir on first write). */
export function saveStorageState(path: string, state: StorageState, fs: AuthFs = nodeAuthFs): void {
	fs.write(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Turn the saved state's cookies into a `Cookie:` header for the base's host.
 * A cookie is included when its domain matches the base host (an exact host or
 * a leading-dot domain suffix); a cookie with no domain is included too (it was
 * saved for this origin). Playwright stores a leading-dot host cookie, so both
 * forms are handled.
 */
export function cookieHeaderFor(state: StorageState, baseUrl: string): string {
	const host = new URL(baseUrl).hostname;
	const parts: string[] = [];
	for (const cookie of state.cookies) {
		const domain = (cookie.domain ?? '').replace(/^\./, '');
		const matches = domain === '' || domain === host || host.endsWith(`.${domain}`);
		if (matches) parts.push(`${cookie.name}=${cookie.value}`);
	}
	return parts.join('; ');
}

/** The outcome of checking the saved sign-in against the live server. */
export type SignedInProbe = (cookieHeader: string) => Promise<number>;

/**
 * Load the saved sign-in AND confirm it still works: GET /api/home-project with
 * the saved cookies must not answer 401. On a missing file or a 401 the caller
 * gets SignInRequiredError with the owner prompt; any other non-2xx is surfaced
 * as its own error so a real outage is not mistaken for a stale sign-in.
 *
 * Returns the cookie header to use for every later API call and browser check.
 */
export async function requireOwnerSignIn(
	opts: { path: string; baseUrl: string; probe: SignedInProbe; fs?: AuthFs },
): Promise<{ cookieHeader: string; state: StorageState }> {
	const state = loadStorageState(opts.path, opts.fs);
	const cookieHeader = cookieHeaderFor(state, opts.baseUrl);
	const status = await opts.probe(cookieHeader);
	if (status === 401) throw new SignInRequiredError('unauthorized');
	if (status < 200 || status >= 300) {
		throw new Error(`GET /api/home-project answered HTTP ${status} while checking the saved sign-in (not a sign-in problem; the server may be down)`);
	}
	return { cookieHeader, state };
}
