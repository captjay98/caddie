/**
 * Lane 8, item 2 — the browser check with TWO APP USERS.
 *
 * Two Caddie accounts are the wrong design (a second Caddie account can't open
 * the first's preview, so "B can't see the record" would pass for the wrong
 * reason). Instead this uses two users OF THE BUILT APP inside the preview of
 * the run's project, both driven from the OWNER's one Caddie session:
 *
 *   - the record is chosen from the approved design: the first person-owned
 *     table that has a create route and a screen showing it (app-users.ts
 *     pickRecordTarget). An app with no such table is "not applicable", never
 *     "passed".
 *   - each app user signs in through the GENERATED app's own email-code sign-in
 *     (request a code for a@campaign.test / b@campaign.test in the preview, read
 *     it from GET /api/projects/<id>/workflow/test-inbox — carried by the
 *     owner's Caddie session — and enter it; the sign-in screen's real labels
 *     are in stacks/react-hono/auth-files.ts: "Email" / "Email me a code" then
 *     "Code" / "Sign in").
 *   - as A: open the screen, fill the create form's first text field with a
 *     unique marker, submit, reload, require the marker.
 *   - as B: require the screen to render (B saves its own marker and sees it)
 *     and require A's marker to be ABSENT.
 *
 * The check is a SEAM (`BrowserCheck`). The real seam drives the repo's own
 * @playwright/test Chromium (never playwright-cli), time-bounded, two separate
 * browser contexts so the two app users never share app cookies. Tests inject a
 * fake seam that replays the real sign-in screen and test-inbox shapes — no
 * browser launches in a unit test. The real DOM steps are classified UNVERIFIED
 * until run live against a ready build; the data parts (target pick, inbox code
 * read) and the JUDGEMENT are proven offline.
 */
import { readInboxCode, type RecordTarget, type TestInbox } from './app-users.ts';

export interface BrowserCheckInput {
	/** The dev base and the preview URL for the ready build. */
	base: string;
	previewUrl: string;
	/** The owner's Caddie-session cookie header, used to read the test inbox. */
	ownerCookie: string;
	/** The project id, for the test-inbox route. */
	projectId: string;
	/** The chosen record target from the approved design (null → not applicable). */
	target: RecordTarget | null;
	/** Unique markers A and B type into their own records. */
	markerA: string;
	markerB: string;
	/** A hard ceiling for the whole check, ms. */
	timeoutMs: number;
}

export interface BrowserCheckResult {
	/** 'pass' | 'fail' | 'not-applicable' — an app with no private record screen. */
	verdict: 'pass' | 'fail' | 'not-applicable';
	passed: boolean;
	/** aPersisted: A's record survived a reload. bIsolated: B cannot see it. */
	aPersisted: boolean;
	bIsolated: boolean;
	/** bRendered: B's own screen renders (B saved and saw its own marker). */
	bRendered: boolean;
	reason: string;
}

export type BrowserCheck = (input: BrowserCheckInput) => Promise<BrowserCheckResult>;

/**
 * The judgement. A pass requires: A's record persisted across a reload; B's own
 * screen rendered (B saved and saw its own marker, so a blank screen can't fake
 * isolation); and B could not see A's marker. Persistence is named first, then
 * B's render, then isolation.
 */
export function judgeTwoUserCheck(aPersisted: boolean, bRendered: boolean, bIsolated: boolean): BrowserCheckResult {
	if (!aPersisted)
		return { verdict: 'fail', passed: false, aPersisted, bRendered, bIsolated, reason: "A's record did not survive a reload" };
	if (!bRendered)
		return { verdict: 'fail', passed: false, aPersisted, bRendered, bIsolated, reason: "B's own screen did not render (B could not save and see its own marker)" };
	if (!bIsolated)
		return { verdict: 'fail', passed: false, aPersisted, bRendered, bIsolated, reason: "B could see A's record (isolation failed)" };
	return { verdict: 'pass', passed: true, aPersisted, bRendered, bIsolated, reason: "A's record persisted; B's screen rendered; B could not see A's record" };
}

/** The "not applicable" result for an app with no private-record screen. */
export function notApplicable(reason: string): BrowserCheckResult {
	return { verdict: 'not-applicable', passed: false, aPersisted: false, bRendered: false, bIsolated: false, reason };
}

/**
 * One app user's view the real seam drives: it can sign in through the app's
 * email-code sign-in, create a record carrying a marker, read whether a marker
 * is visible, and reload. Kept as an interface so a test replays the real
 * sign-in-screen and test-inbox shapes without a browser.
 */
export interface AppUserPage {
	/** Fill the sign-in "Email" field and press "Email me a code". */
	requestCode(email: string): Promise<void>;
	/** Fill the "Code" field and press "Sign in". */
	enterCode(code: string): Promise<void>;
	/** Navigate to the record screen's hash path and fill+submit the marker. */
	createRecord(screenPath: string, markerField: string, marker: string): Promise<void>;
	/** Reload the page. */
	reload(): Promise<void>;
	/** Whether `marker` text is visible on the current screen. */
	markerVisible(marker: string): Promise<boolean>;
}

/** Read the test inbox over the OWNER's Caddie session (the code reader seam). */
export type InboxReader = (projectId: string) => Promise<TestInbox>;

/**
 * Run one app user's sign-in through the generated app's email-code flow: ask
 * for a code, poll the owner-session test inbox until the newest code for this
 * email arrives (bounded by `attempts`), then enter it. Pure over the page and
 * inbox seams.
 */
export async function signInAppUser(
	page: AppUserPage,
	readInbox: InboxReader,
	opts: { projectId: string; email: string; attempts?: number },
): Promise<void> {
	await page.requestCode(opts.email);
	const attempts = opts.attempts ?? 30;
	let code: string | null = null;
	for (let i = 0; i < attempts && code === null; i++) {
		code = readInboxCode(await readInbox(opts.projectId), opts.email);
		if (code === null && i < attempts - 1) await new Promise((r) => setTimeout(r, 0));
	}
	if (code === null) throw new Error(`no sign-in code arrived in the test inbox for ${opts.email}`);
	await page.enterCode(code);
}

/**
 * The real Chromium seam. Loaded LAZILY so importing this module pulls in no
 * browser. Two separate contexts (two app users); every launch is time-bounded;
 * the browser is always closed in a finally. The DOM selectors follow the
 * generated sign-in screen (auth-files.ts labels) and a data-testid hook for the
 * record form, and are classified UNVERIFIED until run live against a ready
 * build; the JUDGEMENT (judgeTwoUserCheck) is what this module proves offline.
 */
export const playwrightBrowserCheck: BrowserCheck = async (input) => {
	if (!input.target) return notApplicable('no person-owned table with a screen was found in the approved design');
	const { chromium } = (await import('@playwright/test')) as typeof import('@playwright/test');
	const browser = await chromium.launch();
	const deadline = Date.now() + input.timeoutMs;
	const remaining = () => Math.max(0, deadline - Date.now());
	const target = input.target;
	const screenUrl = `${input.previewUrl}${input.previewUrl.includes('#') ? '' : target.screen.path}`;

	// Read the test inbox over the OWNER's Caddie session (not the app session).
	const readInbox: InboxReader = async (projectId) => {
		const res = await fetch(`${input.base}/api/projects/${encodeURIComponent(projectId)}/workflow/test-inbox`, {
			headers: { cookie: input.ownerCookie },
		});
		if (!res.ok) throw new Error(`test-inbox → HTTP ${res.status}`);
		return (await res.json()) as TestInbox;
	};

	/** Build an AppUserPage over a fresh Playwright context (own app cookies). */
	const openUser = async () => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		page.setDefaultTimeout(remaining());
		await page.goto(input.previewUrl, { timeout: remaining() });
		const appPage: AppUserPage = {
			async requestCode(email) {
				await page.getByLabel('Email').fill(email);
				await page.getByRole('button', { name: 'Email me a code' }).click();
			},
			async enterCode(code) {
				await page.getByLabel('Code').fill(code);
				await page.getByRole('button', { name: 'Sign in' }).click();
			},
			async createRecord(screenPath, markerField, marker) {
				await page.goto(`${input.previewUrl}${screenPath}`, { timeout: remaining() });
				await page.getByTestId(`field-${markerField}`).fill(marker);
				await page.getByTestId('record-save').click();
			},
			async reload() {
				await page.reload({ timeout: remaining() });
			},
			async markerVisible(marker) {
				return page.getByText(marker).first().isVisible();
			},
		};
		return { ctx, appPage };
	};

	try {
		void screenUrl; // the screen path is used inside createRecord
		// As A: sign in, create a record with markerA, reload, require it.
		const a = await openUser();
		await signInAppUser(a.appPage, readInbox, { projectId: input.projectId, email: 'a@campaign.test' });
		await a.appPage.createRecord(target.screen.path, target.markerField, input.markerA);
		await a.appPage.reload();
		const aPersisted = await a.appPage.markerVisible(input.markerA);
		await a.ctx.close();

		// As B: sign in, save markerB and see it (screen renders), and A's
		// marker must be absent.
		const b = await openUser();
		await signInAppUser(b.appPage, readInbox, { projectId: input.projectId, email: 'b@campaign.test' });
		await b.appPage.createRecord(target.screen.path, target.markerField, input.markerB);
		await b.appPage.reload();
		const bRendered = await b.appPage.markerVisible(input.markerB);
		const bIsolated = !(await b.appPage.markerVisible(input.markerA));
		await b.ctx.close();

		return judgeTwoUserCheck(aPersisted, bRendered, bIsolated);
	} finally {
		await browser.close();
	}
};
