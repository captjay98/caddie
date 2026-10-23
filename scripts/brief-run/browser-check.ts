/**
 * Lane 8, step 4 — the browser check.
 *
 * Through the app's real preview screen, as account A: create a record, reload
 * the page, and confirm it is still there. Then, as account B: confirm that
 * record is NOT visible. This is the privacy + persistence proof the plan's
 * "Complete" rule requires.
 *
 * The check is a SEAM (`BrowserCheck`). The production seam drives the repo's
 * own `@playwright/test` Chromium (never `playwright-cli`), time-bounded. Tests
 * inject a fake seam that returns a scripted verdict — no browser launches in a
 * unit test, so the suite is fast and deterministic. The real Chromium seam is
 * reached only behind the live gate.
 */

export interface BrowserCheckInput {
	/** The dev base and the preview URL for the ready build. */
	base: string;
	previewUrl: string;
	/** The two accounts' cookie headers, so the browser signs in as A and B. */
	cookieA: string;
	cookieB: string;
	/** A unique marker text A types into the record, searched for after reload. */
	recordMarker: string;
	/** A hard ceiling for the whole check, ms. */
	timeoutMs: number;
}

export interface BrowserCheckResult {
	passed: boolean;
	/** aPersisted: A's record survived a reload. bIsolated: B cannot see it. */
	aPersisted: boolean;
	bIsolated: boolean;
	reason: string;
}

export type BrowserCheck = (input: BrowserCheckInput) => Promise<BrowserCheckResult>;

/** The check passes only if A's record persisted AND B could not see it. */
export function judgeBrowserCheck(aPersisted: boolean, bIsolated: boolean): BrowserCheckResult {
	if (!aPersisted)
		return { passed: false, aPersisted, bIsolated, reason: "A's record did not survive a reload" };
	if (!bIsolated)
		return { passed: false, aPersisted, bIsolated, reason: "B could see A's record (isolation failed)" };
	return { passed: true, aPersisted, bIsolated, reason: "A's record persisted; B could not see it" };
}

/**
 * The real Chromium seam. It is loaded LAZILY (dynamic import of
 * `@playwright/test`) so merely importing this module in a unit test pulls in
 * no browser. Every launch is time-bounded by `timeoutMs`; the browser is
 * always closed in a finally.
 *
 * The exact selectors for "the record screen" depend on the generated app
 * under test, which differs per brief, so the DOM steps are intentionally
 * driven by data-testid hooks the preview frame exposes and classified
 * UNVERIFIED until run live against a real ready build. The persistence and
 * isolation JUDGEMENT (judgeBrowserCheck) is what this module proves offline.
 */
export const playwrightBrowserCheck: BrowserCheck = async (input) => {
	const { chromium } = (await import('@playwright/test')) as typeof import('@playwright/test');
	const browser = await chromium.launch();
	const deadline = Date.now() + input.timeoutMs;
	const remaining = () => Math.max(0, deadline - Date.now());
	try {
		// As A: open the preview, create a record carrying the marker, reload.
		const ctxA = await browser.newContext();
		await ctxA.addCookies(parseCookies(input.cookieA, input.base));
		const pageA = await ctxA.newPage();
		pageA.setDefaultTimeout(remaining());
		await pageA.goto(input.previewUrl, { timeout: remaining() });
		await pageA.getByTestId('record-input').fill(input.recordMarker);
		await pageA.getByTestId('record-save').click();
		await pageA.reload({ timeout: remaining() });
		const aPersisted = await pageA.getByText(input.recordMarker).isVisible();
		await ctxA.close();

		// As B: open the same preview; the marker must not be visible.
		const ctxB = await browser.newContext();
		await ctxB.addCookies(parseCookies(input.cookieB, input.base));
		const pageB = await ctxB.newPage();
		pageB.setDefaultTimeout(remaining());
		await pageB.goto(input.previewUrl, { timeout: remaining() });
		const bIsolated = !(await pageB.getByText(input.recordMarker).isVisible());
		await ctxB.close();

		return judgeBrowserCheck(aPersisted, bIsolated);
	} finally {
		await browser.close();
	}
};

/** Turn a Cookie header into Playwright cookie records scoped to the base. */
function parseCookies(header: string, base: string): Array<{ name: string; value: string; url: string }> {
	const url = new URL(base).origin;
	return header
		.split(';')
		.map((p) => p.trim())
		.filter(Boolean)
		.map((pair) => {
			const eq = pair.indexOf('=');
			return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url };
		});
}
