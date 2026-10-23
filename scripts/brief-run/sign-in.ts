/**
 * Lane 8, item 1 — the `--sign-in` flow.
 *
 * `bun scripts/brief-run.ts --sign-in` opens a VISIBLE Chromium from
 * @playwright/test (never playwright-cli) at CADDIE_DEV_BASE_URL/app/, waits
 * until the owner has signed in (poll GET /api/home-project IN THE PAGE until it
 * returns 200, with a 10-minute limit), then saves the browser storage state to
 * tests/briefs/runs/.auth/owner.json. Only ONE Caddie account — the owner's —
 * is ever used here; the stub-provider path stays only in the offline tests.
 *
 * The flow is pure orchestration over three injected seams, so it is driven in
 * unit tests against a FAKE page/transport with no real browser:
 *   - `openPage(url)`  → a SignInPage the owner signs into (real: a visible
 *                        Chromium page navigated to /app/);
 *   - `clock`          → now()/sleep(), so the 10-minute poll runs instantly in
 *                        a test;
 *   - the page's own `homeProjectStatus()` → the status of GET
 *                        /api/home-project made FROM the page (so it carries the
 *                        page's cookies, exactly the sign-in the owner just did).
 *
 * The real Chromium seam (`playwrightSignInPage`) is loaded lazily and reached
 * only behind the live gate; importing this module pulls in no browser.
 */
import type { Clock } from './clock.ts';
import type { StorageState } from './auth-store.ts';

/** How long to wait for the owner to finish signing in (plan item 1). */
export const SIGN_IN_WAIT_MS = 10 * 60 * 1000; // 10 minutes
/** How often to re-probe GET /api/home-project from the page. */
export const SIGN_IN_POLL_MS = 2000;

/** The page the owner signs into — the seam the flow drives. */
export interface SignInPage {
	/** The status of GET /api/home-project made from the page (carries its cookies). */
	homeProjectStatus(): Promise<number>;
	/** Playwright's context.storageState() — the cookies to save. */
	storageState(): Promise<StorageState>;
	/** Close the browser (always called, even on timeout/throw). */
	close(): Promise<void>;
}

/** Open the sign-in page at `url` (real: a visible Chromium page at /app/). */
export type OpenSignInPage = (url: string) => Promise<SignInPage>;

export class SignInTimeoutError extends Error {
	constructor(readonly waitedMs: number) {
		super(`the owner did not sign in within ${Math.round(waitedMs / 60000)} minutes; nothing was saved. Run the command again when ready.`);
		this.name = 'SignInTimeoutError';
	}
}

export interface SignInFlowOptions {
	/** CADDIE_DEV_BASE_URL — the sign-in page opens at `${baseUrl}/app/`. */
	baseUrl: string;
	waitMs?: number;
	pollEveryMs?: number;
}

export interface SignInFlowResult {
	state: StorageState;
	/** How long the owner took to sign in, ms (for the report). */
	waitedMs: number;
}

/**
 * Drive the sign-in: open the page, poll its own GET /api/home-project until it
 * answers 200 (the owner is signed in) or the 10-minute budget runs out, then
 * read and return the storage state. The browser is ALWAYS closed in a finally.
 * The caller (sign-in in brief-run.ts) saves the returned state to the auth
 * file; this flow does no fs itself so it stays a pure driver.
 */
export async function runSignInFlow(
	openPage: OpenSignInPage,
	clock: Clock,
	opts: SignInFlowOptions,
): Promise<SignInFlowResult> {
	const waitMs = opts.waitMs ?? SIGN_IN_WAIT_MS;
	const pollEveryMs = opts.pollEveryMs ?? SIGN_IN_POLL_MS;
	const url = `${opts.baseUrl.replace(/\/$/, '')}/app/`;
	const start = clock.now();
	const deadline = start + waitMs;
	const page = await openPage(url);
	try {
		// Probe once immediately (the owner may already be signed in), then poll.
		for (;;) {
			const status = await page.homeProjectStatus();
			if (status === 200) {
				const state = await page.storageState();
				return { state, waitedMs: clock.now() - start };
			}
			if (clock.now() >= deadline) throw new SignInTimeoutError(waitMs);
			await clock.sleep(pollEveryMs);
		}
	} finally {
		await page.close();
	}
}

/**
 * The real Chromium seam: open a VISIBLE Chromium (headless: false) from
 * @playwright/test at the given url, so the owner can complete Google sign-in
 * by hand. GET /api/home-project is made FROM the page via its request context,
 * so it carries the page's own cookies. Loaded lazily; a unit test never
 * reaches it.
 */
export const playwrightSignInPage: OpenSignInPage = async (url) => {
	const { chromium } = (await import('@playwright/test')) as typeof import('@playwright/test');
	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(url);
	const origin = new URL(url).origin;
	return {
		async homeProjectStatus() {
			const res = await page.request.get(`${origin}/api/home-project`);
			return res.status();
		},
		async storageState() {
			return (await context.storageState()) as StorageState;
		},
		async close() {
			await browser.close();
		},
	};
};
