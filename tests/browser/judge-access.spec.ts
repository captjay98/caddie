import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S06 browser spec: judge access on the COMPOSED build (real built SPA served
 * by the real Worker under `vite preview` = local workerd).
 *
 * Requirements: `bun run build` first. The spec asserts the sign-in panel's
 * judge affordances render and degrade honestly:
 *
 *   1. the quiet judge link appears only when `GET /api/judge/access` says
 *      judge access is open (and stays absent on an older build that 404s);
 *   2. the first-visit form submits code + name + password and shows the
 *      SERVER's plain sentence for a failure, verbatim;
 *   3. a successful first visit hands off to the signed-in app;
 *   4. after the real sign-out control, "Sign in as a judge" posts exactly
 *      `{ name, password }` — never the synthetic `@judges.caddie.invalid`
 *      address — and lands signed in;
 *   5. the `judge_full` / `judge_closed` / `too_many_attempts` sentences render
 *      verbatim.
 *
 * HONESTY: every server response below is stubbed at the network layer. These
 * are UI-state proofs, NOT an end-to-end judge sign-in; the session is faked by
 * stubbing `/api/auth/status` and `/api/auth/get-session` the way the other
 * specs do. The end-to-end half is the server test suite.
 *
 * Server policy (mirrors tests/routing.test.ts): if nothing listens on the
 * configured port the spec starts `vite preview` itself and stops it after the
 * run; an already-running server is reused and left alone. Never deploys.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173; // playwright.config.ts baseURL
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-s06-browser-preview-${process.pid}.log`;

let preview: ChildProcess | null = null;
let weStartedTheServer = false;

/**
 * True when something already accepts connections on this port. Probed with
 * fetch (any HTTP response counts; connection refusal does not; a slow or
 * non-HTTP listener conservatively counts as occupied to avoid double-start).
 */
async function isListening(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
		return true;
	} catch (error) {
		const name = (error as Error)?.name;
		return name === 'TimeoutError' || name === 'AbortError';
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ready(timeoutMs: number): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	let lastError = '';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/app/`, { signal: AbortSignal.timeout(1500) });
			if (res.status === 200) return undefined;
			lastError = `status ${res.status}`;
		} catch (error) {
			lastError = String(error);
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return `preview not ready within ${timeoutMs}ms: ${lastError}`;
}

test.beforeAll(async () => {
	if (!existsSync(WORKER_BUNDLE)) {
		throw new Error('Composed build missing — run `bun run build` before tests/browser/judge-access.spec.ts');
	}
	if (!(await isListening(PORT))) {
		// Detached own-session spawn (P00 lesson): a vite child spawned directly
		// by a test runner hangs at startup on inherited FDs.
		preview = spawn(
			'/bin/bash',
			['-c', `exec bunx vite preview --port ${PORT} --host 127.0.0.1 > '${LOG}' 2>&1`],
			{ cwd: APP_DIR, stdio: 'ignore', detached: true },
		);
		preview.unref();
		weStartedTheServer = true;
	}
	const notReady = await ready(30_000);
	if (notReady) {
		const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '(no log)';
		throw new Error(`${notReady}\nlog:\n${log}`);
	}
});

test.afterAll(async () => {
	if (!weStartedTheServer) return;
	// Kill only what this run started; verify the port actually frees.
	for (const signal of ['-TERM', '-KILL']) {
		if (!(await isListening(PORT))) return;
		try {
			execFileSync('pkill', [signal, '-f', `vite preview --port ${PORT}`], { stdio: 'ignore' });
		} catch {
			// pkill exits 1 when nothing matched — fine
		}
		await sleep(500);
	}
});

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** The judge access contract, stubbed exactly as the server writes it. */
type JudgeAccess = { open: boolean; canStart: boolean };

/** The panel reads provider availability before the first click; keep it real. */
async function stubProviders(context: BrowserContext): Promise<void> {
	await context.route('**/api/integrations/health', (route) =>
		json(route, 200, { auth: { providers: { google: true, github: true } } }),
	);
}

/** Signed-out shell: the real app answers this too, but pin it for determinism. */
async function stubSignedOut(context: BrowserContext): Promise<void> {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: false }));
	await context.route('**/api/auth/get-session', (route) => json(route, 200, null));
}

/**
 * A stubbed signed-in shell. `isSignedIn` is read on every response, so a
 * handler that flips it (judge start, judge sign-in, sign-out) is visible to
 * the next `/api/auth/status` read — which is how the handoff is observed.
 */
async function stubSession(context: BrowserContext, isSignedIn: () => boolean): Promise<void> {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: isSignedIn() }));
	await context.route('**/api/auth/get-session', (route) =>
		isSignedIn()
			? json(route, 200, {
					session: { userId: 'judge-actor-1' },
					user: { id: 'judge-actor-1', name: 'ada-judge', email: 'ada-judge@judges.caddie.invalid' },
				})
			: json(route, 200, null),
	);
	// A finished onboarder: the gate must not bounce a signed-in judge.
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
}

async function stubJudgeAccess(context: BrowserContext, access: JudgeAccess): Promise<void> {
	await context.route('**/api/judge/access', (route) => json(route, 200, access));
}

const JUDGE_LINK_TEXT = 'Judging the hackathon? Use your access code';

const VIEWPORTS = [
	{ name: 'desktop 1440x900', width: 1440, height: 900 },
	{ name: 'mobile 390x844', width: 390, height: 844 },
] as const;

for (const vp of VIEWPORTS) {
	test.describe(`S06 judge access (${vp.name})`, () => {
		const newPage = async (browser: import('@playwright/test').Browser): Promise<{ context: BrowserContext; page: Page }> => {
			const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
			const page = await context.newPage();
			return { context, page };
		};

		test('the judge link appears when judge access is open, and is absent when it is closed', async ({ browser }) => {
			// Open: the quiet link is offered and the providers are untouched.
			{
				const { context, page } = await newPage(browser);
				await stubProviders(context);
				await stubSignedOut(context);
				await stubJudgeAccess(context, { open: true, canStart: true });
				await page.goto(`${BASE}/app/`);
				const link = page.getByTestId('judge-link');
				await expect(link).toBeVisible();
				await expect(link).toHaveText(JUDGE_LINK_TEXT);
				await expect(page.getByTestId('sign-in-google')).toBeVisible();
				await expect(page.getByTestId('sign-in-panel')).toBeVisible();
				await context.close();
			}

			// Closed: no judge option at all.
			{
				const { context, page } = await newPage(browser);
				await stubProviders(context);
				await stubSignedOut(context);
				await stubJudgeAccess(context, { open: false, canStart: false });
				await page.goto(`${BASE}/app/`);
				await expect(page.getByTestId('sign-in-google')).toBeVisible();
				await expect(page.getByTestId('judge-link')).toHaveCount(0);
				await context.close();
			}

			// Honest degradation: an older build has no endpoint (404) — no judge option.
			{
				const { context, page } = await newPage(browser);
				await stubProviders(context);
				await stubSignedOut(context);
				await context.route('**/api/judge/access', (route) => json(route, 404, { error: 'not_found' }));
				await page.goto(`${BASE}/app/`);
				await expect(page.getByTestId('sign-in-google')).toBeVisible();
				await expect(page.getByTestId('judge-link')).toHaveCount(0);
				await context.close();
			}
		});

		test('a first visit with a short password shows the server’s plain error', async ({ browser }) => {
			const { context, page } = await newPage(browser);
			await stubProviders(context);
			await stubSignedOut(context);
			await stubJudgeAccess(context, { open: true, canStart: true });
			const serverLine = 'Use a password of at least 10 characters.';
			await context.route('**/api/judge/start', (route) =>
				json(route, 400, { error: 'invalid_input', message: serverLine }),
			);
			await page.goto(`${BASE}/app/`);
			await page.getByTestId('judge-link').click();
			await expect(page.getByTestId('judge-start-form')).toBeVisible();
			await page.getByTestId('judge-code').fill('a-four-teen-char-code');
			await page.getByTestId('judge-name').fill('ada-judge');
			await page.getByTestId('judge-password').fill('short');
			await page.getByTestId('judge-start').click();
			const error = page.getByTestId('judge-error');
			await expect(error).toBeVisible({ timeout: 10_000 });
			// The server writes the sentence; the panel shows it verbatim.
			await expect(error).toContainText(serverLine);
			await expect(page.getByTestId('judge-start-form')).toBeVisible();
			await context.close();
		});

		test('a successful first visit signs the judge in', async ({ browser }) => {
			const { context, page } = await newPage(browser);
			let signedIn = false;
			const posts: unknown[] = [];
			await stubProviders(context);
			await stubSession(context, () => signedIn);
			await stubJudgeAccess(context, { open: true, canStart: true });
			await context.route('**/api/judge/start', (route) => {
				posts.push(route.request().postDataJSON());
				signedIn = true;
				return json(route, 200, { ok: true, name: 'ada-judge' });
			});
			await page.goto(`${BASE}/app/`);
			await page.getByTestId('judge-link').click();
			await page.getByTestId('judge-code').fill('a-four-teen-char-code');
			await page.getByTestId('judge-name').fill('ada-judge');
			await page.getByTestId('judge-password').fill('a-long-enough-password');
			await page.getByTestId('judge-start').click();
			// The handoff reloads the app at the callback URL; with the session
			// present the sign-in wall is gone.
			await expect(page.getByTestId('sign-in-panel')).toHaveCount(0, { timeout: 15_000 });
			await expect(page.getByTestId('sign-in-gate')).toHaveCount(0);
			// It sent the three real fields, never a synthetic email.
			expect(posts).toHaveLength(1);
			expect(posts[0]).toEqual({
				code: 'a-four-teen-char-code',
				name: 'ada-judge',
				password: 'a-long-enough-password',
			});
			await context.close();
		});

		test('after sign-out, signing in as a judge sends the judge name and password', async ({ browser }) => {
			const { context, page } = await newPage(browser);
			let signedIn = true;
			const signInPosts: unknown[] = [];
			await stubProviders(context);
			await stubSession(context, () => signedIn);
			await stubJudgeAccess(context, { open: true, canStart: true });
			await context.route('**/api/auth/sign-out', (route) => {
				signedIn = false;
				return json(route, 200, {});
			});
			await context.route('**/api/judge/sign-in', (route) => {
				signInPosts.push(route.request().postDataJSON());
				return json(route, 200, { ok: true, name: 'ada-judge' });
			});
			await page.goto(`${BASE}/app/`);
			// The real account control: sign out, land back on the sign-in wall.
			// Two account menus can be in the DOM (mobile header + conversation
			// header); click the one this viewport shows.
			await page.locator('[data-testid="account-menu"]:visible').first().click();
			await page.locator('[data-testid="sign-out"]:visible').first().click();
			await expect(page.getByTestId('sign-in-panel')).toBeVisible({ timeout: 10_000 });
			// Returning judge: the quiet link, then the sign-in form.
			await page.getByTestId('judge-link').click();
			await page.getByTestId('judge-returning-link').click();
			await expect(page.getByTestId('judge-sign-in-form')).toBeVisible();
			await page.getByTestId('judge-name').fill('ada-judge');
			await page.getByTestId('judge-password').fill('a-long-enough-password');
			await page.getByTestId('judge-sign-in').click();
			await expect.poll(() => signInPosts.length).toBe(1);
			// Exactly name + password — NOT the synthetic @judges.caddie.invalid email.
			expect(signInPosts[0]).toEqual({ name: 'ada-judge', password: 'a-long-enough-password' });
			expect(JSON.stringify(signInPosts[0])).not.toContain('@');
			expect(JSON.stringify(signInPosts[0])).not.toContain('judges.caddie.invalid');
			await context.close();
		});

		test('judge_full, judge_closed and too_many_attempts render the server’s message verbatim', async ({ browser }) => {
			const cases: { name: string; endpoint: 'start' | 'sign-in'; status: number; error: string; message: string }[] = [
				{
					name: 'judge_full',
					endpoint: 'start',
					status: 403,
					error: 'judge_full',
					message: 'All the judge places are taken.',
				},
				{
					name: 'judge_closed',
					endpoint: 'start',
					status: 403,
					error: 'judge_closed',
					message: 'Judge access has closed.',
				},
				{
					name: 'too_many_attempts',
					endpoint: 'sign-in',
					status: 429,
					error: 'too_many_attempts',
					message: 'Too many tries from here. Wait a little while and try again.',
				},
			];
			for (const entry of cases) {
				const { context, page } = await newPage(browser);
				await stubProviders(context);
				await stubSignedOut(context);
				await stubJudgeAccess(context, { open: true, canStart: true });
				await context.route(`**/api/judge/${entry.endpoint}`, (route) =>
					json(route, entry.status, { error: entry.error, message: entry.message }),
				);
				await page.goto(`${BASE}/app/`);
				await page.getByTestId('judge-link').click();
				if (entry.endpoint === 'sign-in') {
					await page.getByTestId('judge-returning-link').click();
					await expect(page.getByTestId('judge-sign-in-form')).toBeVisible();
					await page.getByTestId('judge-name').fill('ada-judge');
					await page.getByTestId('judge-password').fill('a-long-enough-password');
					await page.getByTestId('judge-sign-in').click();
				} else {
					await expect(page.getByTestId('judge-start-form')).toBeVisible();
					await page.getByTestId('judge-code').fill('a-four-teen-char-code');
					await page.getByTestId('judge-name').fill('ada-judge');
					await page.getByTestId('judge-password').fill('a-long-enough-password');
					await page.getByTestId('judge-start').click();
				}
				const error = page.getByTestId('judge-error');
				await expect(error).toBeVisible({ timeout: 10_000 });
				await expect(error).toContainText(entry.message);
				await context.close();
			}
		});
	});
}
