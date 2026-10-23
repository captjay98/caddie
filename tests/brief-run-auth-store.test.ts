import { describe, expect, test } from 'bun:test';
import {
	type AuthFs,
	type StorageState,
	type SignedInProbe,
	SIGN_IN_PROMPT,
	SignInRequiredError,
	cookieHeaderFor,
	loadStorageState,
	ownerAuthPath,
	requireOwnerSignIn,
	saveStorageState,
} from '../scripts/brief-run/auth-store.ts';
import {
	type OpenSignInPage,
	type SignInPage,
	SIGN_IN_WAIT_MS,
	SignInTimeoutError,
	runSignInFlow,
} from '../scripts/brief-run/sign-in.ts';
import { FakeClock } from '../scripts/brief-run/clock.ts';

/**
 * LANE 8 ITEM 1 — the owner's saved sign-in. Strictly OFFLINE: no browser, no
 * network. The real Chromium seam is never imported here; the flow is driven
 * over a fake page/transport. Proves:
 *   - the cookie-file load (path + JSON + cookies → a Cookie header);
 *   - the MISSING-file refusal and the 401 refusal, each carrying the owner
 *     prompt;
 *   - the --sign-in flow: poll until 200 saves the state; the 10-minute budget
 *     times out and closes the browser without saving.
 */

// --- an in-memory fs seam ----------------------------------------------------

function memFs(initial: Record<string, string> = {}): AuthFs & { files: Map<string, string> } {
	const files = new Map(Object.entries(initial));
	return {
		files,
		exists: (p) => files.has(p),
		read: (p) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`ENOENT ${p}`);
			return v;
		},
		write: (p, data) => void files.set(p, data),
	};
}

const AUTH_PATH = '/runs/.auth/owner.json';
const BASE = 'http://127.0.0.1:5173';

function state(cookies: StorageState['cookies']): StorageState {
	return { cookies };
}

// --- the path resolver -------------------------------------------------------

describe('owner auth path (item 1)', () => {
	test('is .auth/owner.json under the runs dir', () => {
		expect(ownerAuthPath('/x/tests/briefs/runs')).toBe('/x/tests/briefs/runs/.auth/owner.json');
	});
});

// --- cookie-file load + save -------------------------------------------------

describe('cookie-file load (item 1)', () => {
	test('a saved state round-trips and its cookies become a Cookie header', () => {
		const fs = memFs();
		const saved = state([
			{ name: 'app.session_token', value: 'abc', domain: '127.0.0.1', path: '/' },
			{ name: 'app.csrf', value: 'xyz', domain: '127.0.0.1', path: '/' },
		]);
		saveStorageState(AUTH_PATH, saved, fs);
		const loaded = loadStorageState(AUTH_PATH, fs);
		const header = cookieHeaderFor(loaded, BASE);
		expect(header).toContain('app.session_token=abc');
		expect(header).toContain('app.csrf=xyz');
	});

	test('a cookie for another host is NOT included in the header', () => {
		const s = state([
			{ name: 'local', value: '1', domain: '127.0.0.1' },
			{ name: 'remote', value: '2', domain: 'caddie.example.com' },
			{ name: 'nodomain', value: '3' },
		]);
		const header = cookieHeaderFor(s, BASE);
		expect(header).toContain('local=1');
		expect(header).toContain('nodomain=3'); // no domain → this origin
		expect(header).not.toContain('remote=2');
	});

	test('a MISSING file is a SignInRequired(missing-file) carrying the owner prompt', () => {
		const fs = memFs();
		expect(() => loadStorageState(AUTH_PATH, fs)).toThrow(SignInRequiredError);
		try {
			loadStorageState(AUTH_PATH, fs);
		} catch (error) {
			expect((error as SignInRequiredError).why).toBe('missing-file');
			expect((error as Error).message).toContain(SIGN_IN_PROMPT);
		}
	});

	test('a corrupt file is a DIFFERENT, plain error (not "just sign in again")', () => {
		const fs = memFs({ [AUTH_PATH]: 'not json' });
		expect(() => loadStorageState(AUTH_PATH, fs)).toThrow(/not valid JSON/);
		const fs2 = memFs({ [AUTH_PATH]: '{"origins":[]}' });
		expect(() => loadStorageState(AUTH_PATH, fs2)).toThrow(/no cookies array/);
	});
});

// --- the two refusals via the live probe -------------------------------------

describe('requireOwnerSignIn: the missing-file and 401 refusals (item 1)', () => {
	const okState = state([{ name: 'app.session_token', value: 'abc', domain: '127.0.0.1' }]);

	test('a 200 from /api/home-project returns the cookie header', async () => {
		const fs = memFs({ [AUTH_PATH]: JSON.stringify(okState) });
		const probe: SignedInProbe = async () => 200;
		const { cookieHeader } = await requireOwnerSignIn({ path: AUTH_PATH, baseUrl: BASE, probe, fs });
		expect(cookieHeader).toContain('app.session_token=abc');
	});

	test('a MISSING file refuses with the owner prompt (no probe needed)', async () => {
		const fs = memFs();
		let probed = false;
		const probe: SignedInProbe = async () => {
			probed = true;
			return 200;
		};
		await expect(requireOwnerSignIn({ path: AUTH_PATH, baseUrl: BASE, probe, fs })).rejects.toThrow(SignInRequiredError);
		expect(probed).toBe(false); // a missing file is caught before the network
	});

	test('a 401 from /api/home-project refuses with the owner prompt', async () => {
		const fs = memFs({ [AUTH_PATH]: JSON.stringify(okState) });
		const probe: SignedInProbe = async () => 401;
		try {
			await requireOwnerSignIn({ path: AUTH_PATH, baseUrl: BASE, probe, fs });
			throw new Error('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(SignInRequiredError);
			expect((error as SignInRequiredError).why).toBe('unauthorized');
			expect((error as Error).message).toContain(SIGN_IN_PROMPT);
		}
	});

	test('a 503 (server down) is a DIFFERENT error, not a sign-in prompt', async () => {
		const fs = memFs({ [AUTH_PATH]: JSON.stringify(okState) });
		const probe: SignedInProbe = async () => 503;
		await expect(requireOwnerSignIn({ path: AUTH_PATH, baseUrl: BASE, probe, fs })).rejects.toThrow(/HTTP 503/);
	});
});

// --- the --sign-in flow over a fake page -------------------------------------

/** A fake page whose home-project status follows a scripted sequence. */
function fakePage(statuses: number[], saved: StorageState): SignInPage & { opened: string[]; closed: boolean } {
	let i = 0;
	const page = {
		opened: [] as string[],
		closed: false,
		async homeProjectStatus() {
			return statuses[Math.min(i++, statuses.length - 1)];
		},
		async storageState() {
			return saved;
		},
		async close() {
			page.closed = true;
		},
	};
	return page;
}

describe('the --sign-in flow (item 1), driven over a fake page', () => {
	test('polls until 200, then saves the page storage state', async () => {
		const saved = state([{ name: 'app.session_token', value: 'owner', domain: '127.0.0.1' }]);
		const page = fakePage([401, 401, 200], saved);
		let openedUrl = '';
		const openPage: OpenSignInPage = async (url) => {
			openedUrl = url;
			return page;
		};
		const result = await runSignInFlow(openPage, new FakeClock(0), { baseUrl: BASE, pollEveryMs: 1000 });
		expect(openedUrl).toBe(`${BASE}/app/`); // the visible page opens at /app/
		expect(result.state).toEqual(saved);
		expect(page.closed).toBe(true); // the browser is always closed
	});

	test('an already-signed-in owner (200 on the first probe) saves at once', async () => {
		const saved = state([{ name: 'app.session_token', value: 'owner' }]);
		const page = fakePage([200], saved);
		const result = await runSignInFlow(async () => page, new FakeClock(0), { baseUrl: BASE });
		expect(result.state).toEqual(saved);
		expect(result.waitedMs).toBe(0);
	});

	test('times out after 10 minutes without signing in, and closes the browser without saving', async () => {
		const page = fakePage([401], state([]));
		const clock = new FakeClock(0);
		await expect(
			runSignInFlow(async () => page, clock, { baseUrl: BASE, pollEveryMs: 60_000 }),
		).rejects.toThrow(SignInTimeoutError);
		expect(clock.now()).toBeGreaterThanOrEqual(SIGN_IN_WAIT_MS);
		expect(page.closed).toBe(true);
	});
});
