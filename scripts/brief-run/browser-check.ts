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
import { inboxKeysFor, planFormFill, readInboxCode, type RecordTarget, type TestInbox } from './app-users.ts';

export interface BrowserCheckInput {
	/** The dev base, for the owner-session test-inbox read. */
	base: string;
	/**
	 * The STANDALONE preview page URL, e.g.
	 * `${base}/app/preview?project=<projectId>&preview=<previewId>&source=workflow`.
	 * The check opens THIS page (not the raw frame document): it embeds the app
	 * in `iframe[name="caddie-interactive-preview"]` and relays the app's /api
	 * calls through the parent's in-memory cookie jar, so the app user stays
	 * signed in as long as only the FRAME is reloaded. runCampaign builds it.
	 */
	previewPageUrl: string;
	/**
	 * The owner's saved Playwright storageState file (auth-store ownerAuthPath).
	 * Each app user opens the preview page in a context made with this state, so
	 * both are the owner's one Caddie session but each has its OWN fresh app
	 * cookie jar (the parent keeps the app's cookies in memory per context).
	 */
	ownerStoragePath: string;
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
 * Run one app user's sign-in through the generated app's email-code flow: note
 * the codes already in the inbox for this email, ask for a code, then read the
 * owner-session test inbox until a NEW code for this email arrives (bounded by
 * `attempts`, pausing `waitMs` between reads), and enter it. A code that was
 * there before asking (an earlier try) is never entered. Pure over the page,
 * inbox and sleep seams.
 */
export async function signInAppUser(
	page: AppUserPage,
	readInbox: InboxReader,
	opts: { projectId: string; email: string; attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const waitMs = opts.waitMs ?? 500;
	const attempts = opts.attempts ?? 30;
	const already = inboxKeysFor(await readInbox(opts.projectId), opts.email);
	await page.requestCode(opts.email);
	let code: string | null = null;
	for (let i = 0; i < attempts && code === null; i++) {
		code = readInboxCode(await readInbox(opts.projectId), opts.email, already);
		if (code === null && i < attempts - 1) await sleep(waitMs);
	}
	if (code === null) throw new Error(`no sign-in code arrived in the test inbox for ${opts.email}`);
	await page.enterCode(code);
}

/**
 * The real Chromium seam. Loaded LAZILY so importing this module pulls in no
 * browser. It drives the STANDALONE preview page (input.previewPageUrl), which
 * embeds the generated app in `iframe[name="caddie-interactive-preview"]` and
 * relays the app's /api calls through the parent's in-memory cookie jar. So:
 *
 *   - Two SEPARATE contexts (A then B), each made with the owner's saved
 *     storageState — the owner's one Caddie session, but a fresh app-cookie jar
 *     per context, so B cannot inherit A's app sign-in.
 *   - Every wait is bounded with `locator.waitFor({ state:'visible', timeout })`
 *     inside the overall deadline; the browser is always closed in a finally.
 *   - The app user signs in through the generated sign-in screen (auth-files.ts
 *     labels), then the target SCREEN is opened with `location.hash = path` in
 *     the frame, the create form is filled by `planFormFill`, and the frame is
 *     reloaded with `frame.evaluate(() => location.reload())` — the FRAME only,
 *     never `page.reload()` (a whole-page reload drops the parent's cookie jar
 *     and signs the app user out).
 *   - When the record never appears, the verdict is 'fail' with a plain reason,
 *     and a diagnostic create is tried through the app's own API from inside
 *     the frame (a success is NOTED but never turns the verdict into a pass).
 *
 * The DOM steps are classified LOCAL VERIFIED against a simulated app in the
 * real preview frame + bridge (the browser spec), and NOT proven against a real
 * generated app. The JUDGEMENT (judgeTwoUserCheck) and the form plan
 * (planFormFill) are proven offline.
 */
export const playwrightBrowserCheck: BrowserCheck = async (input) => {
	if (!input.target) return notApplicable('no person-owned table with a screen was found in the approved design');
	const { chromium } = (await import('@playwright/test')) as typeof import('@playwright/test');
	const browser = await chromium.launch();
	const deadline = Date.now() + input.timeoutMs;
	const remaining = () => Math.max(1, deadline - Date.now());
	const target = input.target;

	// Read the test inbox over the OWNER's Caddie session (not the app session).
	const readInbox: InboxReader = async (projectId) => {
		const res = await fetch(`${input.base}/api/projects/${encodeURIComponent(projectId)}/workflow/test-inbox`, {
			headers: { cookie: input.ownerCookie },
		});
		if (!res.ok) throw new Error(`test-inbox → HTTP ${res.status}`);
		return (await res.json()) as TestInbox;
	};

	try {
		// As A: sign in, create a record with markerA, reload the FRAME, require it.
		const a = await openPreviewUser(browser, input, remaining);
		await a.signIn('a@campaign.test', readInbox);
		const aCreate = await a.createRecord(target, input.markerA);
		await a.reloadFrame();
		const aPersisted = aCreate.saved && (await a.markerVisible(input.markerA));
		const aReason = aCreate.saved ? '' : aCreate.reason;
		await a.close();

		// As B: sign in (fresh jar), save markerB and see it (screen renders),
		// and A's marker must be absent.
		const b = await openPreviewUser(browser, input, remaining);
		await b.signIn('b@campaign.test', readInbox);
		const bCreate = await b.createRecord(target, input.markerB);
		await b.reloadFrame();
		const bRendered = bCreate.saved && (await b.markerVisible(input.markerB));
		const bIsolated = !(await b.markerVisible(input.markerA));
		const bReason = bCreate.saved ? '' : bCreate.reason;
		await b.close();

		const verdict = judgeTwoUserCheck(aPersisted, bRendered, bIsolated);
		// Keep the judgement, but carry the create diagnostic when a save failed.
		const extra = [aReason && `A: ${aReason}`, bReason && `B: ${bReason}`].filter(Boolean).join('; ');
		return extra ? { ...verdict, reason: `${verdict.reason}. ${extra}` } : verdict;
	} finally {
		await browser.close();
	}
};

/** The outcome of a create attempt: whether the record saved, with a reason. */
interface CreateOutcome {
	saved: boolean;
	/** A plain reason when it did not save, naming what was tried + the diagnostic. */
	reason: string;
}

/**
 * One app user driving the standalone preview page in its own context. All the
 * real Playwright calls live here; the pure judgement and form plan are
 * elsewhere. `remaining()` bounds every wait inside the overall deadline.
 */
async function openPreviewUser(
	browser: import('@playwright/test').Browser,
	input: BrowserCheckInput,
	remaining: () => number,
) {
	const ctx = await browser.newContext({ storageState: input.ownerStoragePath });
	const page = await ctx.newPage();
	page.setDefaultTimeout(remaining());
	await page.goto(input.previewPageUrl, { timeout: remaining() });

	const FRAME = 'iframe[name="caddie-interactive-preview"]';
	const frameLoc = () => page.frameLocator(FRAME);
	const frame = () => page.frames().find((f) => f.name() === 'caddie-interactive-preview');
	const waitForFrame = async () => {
		await page.locator(FRAME).waitFor({ state: 'visible', timeout: remaining() });
		// The app inside takes a moment to mount; wait for a live frame object.
		for (let i = 0; i < 50 && !frame(); i++) await page.waitForTimeout(100);
		const f = frame();
		if (!f) throw new Error('the app preview frame never appeared');
		return f;
	};

	return {
		async signIn(email: string, readInbox: InboxReader) {
			await waitForFrame();
			const appPage: AppUserPage = {
				async requestCode(address) {
					await frameLoc().getByLabel('Email').waitFor({ state: 'visible', timeout: remaining() });
					await frameLoc().getByLabel('Email').fill(address);
					await frameLoc().getByRole('button', { name: 'Email me a code' }).click();
				},
				async enterCode(code) {
					await frameLoc().getByLabel('Code').waitFor({ state: 'visible', timeout: remaining() });
					await frameLoc().getByLabel('Code').fill(code);
					await frameLoc().getByRole('button', { name: 'Sign in' }).click();
					// Signed in once the Code field is gone (auth-files.ts flow).
					await frameLoc().getByLabel('Code').waitFor({ state: 'detached', timeout: remaining() });
				},
				async createRecord() {
					/* unused: the record creation is driven by createRecord below */
				},
				async reload() {
					/* unused */
				},
				async markerVisible() {
					return false;
				},
			};
			await signInAppUser(appPage, readInbox, { projectId: input.projectId, email });
		},

		/**
		 * Open the target screen (`location.hash = path` in the frame), read the
		 * create form's fields, fill them by plan, submit, and wait ~20 s for the
		 * marker. On failure, try a diagnostic create through the app's own API
		 * from inside the frame, and report whether THAT saved + showed.
		 */
		async createRecord(target: RecordTarget, marker: string): Promise<CreateOutcome> {
			const f = await waitForFrame();
			await f.evaluate((hash) => {
				(globalThis as unknown as { location: { hash: string } }).location.hash = hash;
			}, target.screen.path);

			// Read the first non-sign-in form's fields (pure plan decides values).
			const fields = await readFormFields(f);
			if (fields === null) {
				return { saved: false, reason: `no create form with a text field was found on screen ${target.screen.path}` };
			}
			const plan = planFormFill(fields.fields, marker, new Date());
			const forms = frameLoc().locator('form').nth(fields.formIndex);
			const controls = forms.locator('input, textarea, select');
			let typed = '';
			for (const step of plan) {
				const control = controls.nth(step.index);
				await control.waitFor({ state: 'visible', timeout: remaining() });
				if (step.action === 'check') await control.check({ timeout: remaining() });
				else if (step.action === 'select') await control.selectOption(step.value, { timeout: remaining() });
				else await control.fill(step.value, { timeout: remaining() });
				if (step.marker) typed = `filled the first text field with the marker`;
			}
			const submit = forms.getByRole('button').last();
			const submitName = (await submit.textContent({ timeout: remaining() }).catch(() => ''))?.trim() || 'the submit button';
			await submit.click({ timeout: remaining() });

			// Wait up to ~20 s (bounded by the deadline) for the marker to appear.
			const markerWait = Math.min(20_000, remaining());
			const appeared = await frameLoc()
				.getByText(marker, { exact: false })
				.first()
				.waitFor({ state: 'visible', timeout: markerWait })
				.then(() => true)
				.catch(() => false);
			if (appeared) return { saved: true, reason: '' };

			// The create through the screen failed. Diagnose through the API.
			const diag = await diagnosticApiCreate(f, target, marker);
			const reason =
				`${typed || 'filled the form'}, pressed '${submitName}', the record never appeared` +
				`; diagnostic API create ${diag}`;
			return { saved: false, reason };
		},

		/** Reload the FRAME only (never the page — that signs the app user out). */
		async reloadFrame() {
			const f = frame();
			if (!f) return;
			await f.evaluate(() => {
				(globalThis as unknown as { location: { reload: () => void } }).location.reload();
			});
			await waitForFrame();
		},

		async markerVisible(marker: string): Promise<boolean> {
			return frameLoc()
				.getByText(marker, { exact: false })
				.first()
				.waitFor({ state: 'visible', timeout: Math.min(20_000, remaining()) })
				.then(() => true)
				.catch(() => false);
		},

		async close() {
			await ctx.close();
		},
	};
}

/**
 * Read the first create form on the current screen that is NOT the sign-in form
 * and has a text field, as FormField[] the pure `planFormFill` understands.
 * Returns the form's index among the frame's forms, or null when there is none.
 */
async function readFormFields(
	frame: import('@playwright/test').Frame,
): Promise<{ formIndex: number; fields: import('./app-users.ts').FormField[] } | null> {
	return frame.evaluate(() => {
		const doc = (globalThis as unknown as { document: Document }).document;
		const forms = Array.from(doc.querySelectorAll('form'));
		for (let formIndex = 0; formIndex < forms.length; formIndex++) {
			const form = forms[formIndex]!;
			const controls = Array.from(form.querySelectorAll('input, textarea, select')) as Array<
				HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
			>;
			// Skip the sign-in form (its only text-ish fields are email/code).
			const looksLikeSignIn = controls.some(
				(c) => c instanceof HTMLInputElement && (c.type === 'email' || c.autocomplete === 'one-time-code'),
			);
			const fields = controls.map((c) => {
				if (c instanceof HTMLSelectElement) {
					return {
						kind: 'select' as const,
						required: c.required,
						hasValue: c.value !== '',
						options: Array.from(c.options).map((o) => o.value),
					};
				}
				if (c instanceof HTMLTextAreaElement) {
					return { kind: 'textarea' as const, required: c.required, hasValue: c.value !== '' };
				}
				const type = (c.type || 'text').toLowerCase();
				const hasValue = type === 'checkbox' || type === 'radio' ? c.checked : c.value !== '';
				return { kind: 'input' as const, type, required: c.required, hasValue };
			});
			const hasText = fields.some(
				(f) => f.kind === 'textarea' || (f.kind === 'input' && ['text', 'search', ''].includes((f.type ?? 'text'))),
			);
			if (!looksLikeSignIn && hasText) return { formIndex, fields };
		}
		return null;
	});
}

/**
 * The diagnostic: create the record through the app's OWN API from inside the
 * frame (the frame's fetch is relayed to the app's server), so a failed create
 * through the screen can say whether the data layer itself works. The body is
 * built from each request field's `example`, with the marker in the first text
 * field. Returns a short phrase for the reason. A success here NEVER makes the
 * check pass — it only locates the fault (UI vs server).
 */
async function diagnosticApiCreate(
	frame: import('@playwright/test').Frame,
	target: RecordTarget,
	marker: string,
): Promise<string> {
	const body: Record<string, string> = {};
	const firstText = target.createRoute.request.find((f) => f.type === 'text');
	for (const field of target.createRoute.request) {
		body[field.name] = field === firstText ? marker : field.example;
	}
	const result = await frame
		.evaluate(
			async ({ path, payload }) => {
				try {
					const res = await (globalThis as unknown as { fetch: typeof fetch }).fetch(path, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payload),
					});
					return { ok: res.ok, status: res.status };
				} catch (error) {
					return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
				}
			},
			{ path: target.createRoute.path, payload: body },
		)
		.catch((error: unknown) => ({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }));

	if (!result.ok) {
		return `also failed (${'error' in result && result.error ? result.error : `HTTP ${result.status}`}) — the app's server did not accept the record`;
	}
	// The API saved it; re-check whether it now shows on the screen.
	const shows = await frame
		.evaluate((text) => (globalThis as unknown as { document: Document }).document.body.innerText.includes(text), marker)
		.catch(() => false);
	return shows
		? `saved through the API and the record then showed, so the create FORM is the fault, not the data layer`
		: `saved through the API but the record still did not show, so the SCREEN does not render saved records`;
}
