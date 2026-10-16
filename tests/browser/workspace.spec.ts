import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Workspace shell acceptance for the DISCOVERY-FIRST redesign — run against the
 * COMPOSED build (`bun run build` first: the real Worker under `vite preview` =
 * local workerd on 127.0.0.1:4173, SPA at /app/).
 *
 * What the shell guarantees (per the layout clarification + desktop shell update):
 *   - Desktop is a two-panel layout: LEFT = all navigable content under a
 *     floating rounded navigation capsule (exactly THREE global destinations:
 *     Home · Discover · Projects, plus Search + Account); RIGHT = ONE persistent
 *     Caddie conversation with a compact, explicit context label. No global
 *     Chat/Decisions/Build/Ship/Evidence/Agents tabs exist.
 *   - The conversation binds to a SAFE scope: the account Home project on the
 *     global routes (General), the selected project on a project route. Switching
 *     never silently retargets an unrelated project.
 *   - Invalid ?project= ids are MISSING, never a fallback to another project.
 *   - Both panels scroll independently; 390/768/1440 have no horizontal overflow.
 *
 * LIVE vs UI-state proof (same split as the original P06 spec): the
 * unauthenticated gate is driven by the REAL /api/auth/status fail-closed probe;
 * the authenticated surfaces are deterministic route-interception proofs against
 * the real P02/P11 REST shapes (the local composed build has auth on and no
 * seeded accounts). This is a UI-state proof, not auth or live-data evidence.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-p06-browser-preview-${process.pid}.log`;

let preview: ChildProcess | null = null;
let weStartedTheServer = false;

async function isListening(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
		return true;
	} catch (error) {
		const name = (error as Error)?.name;
		return name === 'TimeoutError' || name === 'AbortError';
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		await sleep(300);
	}
	return `preview not ready within ${timeoutMs}ms: ${lastError}`;
}

test.beforeAll(async () => {
	if (!existsSync(WORKER_BUNDLE)) {
		throw new Error('Composed build missing — run `bun run build` before tests/browser/workspace.spec.ts');
	}
	if (!(await isListening(PORT))) {
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

// The root tsconfig omits the "dom" lib; these callbacks run in the browser via
// page.evaluate, so declare the minimal surface this spec touches.
declare const document: {
	documentElement: { scrollWidth: number; clientWidth: number };
	body: object;
	getAnimations(): unknown[];
};
declare function getComputedStyle(element: object): { backgroundColor: string };

// --- fixture data (mirrors the real P02 payload shapes in packages/contracts) --

const NOW = '2026-10-04T10:00:00.000Z';

function project(id: string, name: string, kind: 'standard' | 'home' = 'standard') {
	return {
		id,
		workspaceId: 'ws-1',
		name,
		description: null,
		contestId: null,
		contestUrl: null,
		status: 'active',
		kind,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

// The account scope — kind='home', build/gate-less; excluded from the Projects
// list but always present so Discover + the general conversation exist first.
const HOME = project('home-1', 'Home', 'home');
const PROJECT_A = project('proj-a', 'Pit wall');
const PROJECT_B = project('proj-b', 'Telemetry');

const RUN_BINDING = {
	runId: 'run-01HZX',
	projectId: 'proj-a',
	conversationId: 'conv-01HZX',
	submissionId: 'sub-01HZX',
	planRevision: 'plan-r2',
	stackId: 'react-hono',
	payerId: 'payer-1',
	modelRouteId: 'route-1',
	pricingVersion: 'v1',
	createdBy: 'actor-test',
	createdAt: NOW,
};

const ARTIFACT = {
	id: 'ar-1',
	projectId: 'proj-a',
	artifactId: 'art-spec',
	kind: 'spec',
	revision: 2,
	metadataHash: 'sha256-deadbeefdeadbeef',
	metadata: '{}',
	createdBy: 'actor-test',
	createdAt: NOW,
};

// --- stubbing helpers ----------------------------------------------------------

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

type ListConfig = { status: number; body: unknown; delayMs?: number };
const DATA: ListConfig = { status: 200, body: { projects: [HOME, PROJECT_A, PROJECT_B] } };

/**
 * Authenticated session + a controllable project-list source. Home resolves to
 * the account Home project so the general conversation and Discover work with
 * zero build projects. Project children default to honest empties so a selected
 * project never leaks a real 401 into the panes under test.
 */
async function stubAccount(context: BrowserContext, config: { current: ListConfig }) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Test', email: 't@caddie.test' } }),
	);
	// Independent of the list source: the account Home scope + profile.
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) =>
		route.request().method() === 'PUT' ? json(route, 200, { profile: null }) : json(route, 200, { profile: null }),
	);
	// The account brief (approved navigation): deterministic cards + read state
	// so the badge, the Brief lane and the Chat notice render real state.
	await context.route('**/api/brief/read', (route) =>
		json(route, 200, { marked: 0 }),
	);
	await context.route('**/api/brief', (route) =>
		json(route, 200, {
			cards: [],
			unseenCount: 0,
			projects: [{ id: 'home-1', name: 'Home', kind: 'home' }],
			asOf: NOW,
		}),
	);
	await context.route('**/api/projects', async (route) => {
		if (route.request().method() !== 'GET') return json(route, 405, { error: 'method_not_allowed' });
		if (config.current.delayMs) await sleep(config.current.delayMs);
		return json(route, config.current.status, config.current.body);
	});
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
		if (path.endsWith('/artifact-revisions')) return json(route, 200, { artifacts: [], latest: null });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
		if (path.endsWith('/discovery/candidates')) return json(route, 200, { evaluations: [], ranked: [], profileCountry: null });
		if (path.endsWith('/discovery/feed')) return json(route, 200, { runs: [] });
		return json(route, 200, {});
	});
}

// --- tests ----------------------------------------------------------------------

test.describe('discovery-first workspace shell (composed build)', () => {
	test('unauthenticated /app shows the real sign-in state and crosses no boundary', async ({ page }) => {
		await page.goto(`${BASE}/app/`);
		// The fail-closed /api/auth/status probe drives the gate to a sign-in wall.
		await expect(page.getByTestId('sign-in-panel')).toBeVisible();
		await expect(page.getByTestId('shell')).toBeVisible();
		// The capsule nav and the conversation only exist for a verified session —
		// there is no scope to bind them to, so they are NOT rendered here.
		await expect(page.getByTestId('nav-capsule')).toHaveCount(0);
		await expect(page.getByTestId('conversation-panel')).toHaveCount(0);
		// Identity still crosses: wordmark + a real route back to the landing.
		await expect(page.getByTestId('wordmark')).toBeVisible();
		await expect(page.getByTestId('back-to-landing')).toBeVisible();
	});

	test('authed Home is the actionable brief with the conversation on the GENERAL scope', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		await expect(page.getByTestId('nav-capsule')).toBeVisible();
		await expect(page.getByTestId('nav-brief')).toHaveAttribute('aria-current', 'page');
		// Exactly three global destinations; the removed tabs are gone.
		await expect(page.getByTestId('nav-discover')).toBeVisible();
		await expect(page.getByTestId('nav-projects')).toBeVisible();
		await expect(page.getByTestId('nav-chat')).toHaveCount(0);
		await expect(page.getByTestId('nav-build')).toHaveCount(0);
		await expect(page.getByTestId('nav-ship')).toHaveCount(0);

		await expect(page.getByTestId('brief-screen')).toBeVisible();
		// Returning account (build projects exist): the account brief lane is
		// the surface — the new-user intro is reserved for zero-build accounts.
		await expect(page.getByTestId('brief-lane-panel')).toBeVisible();
		await expect(page.getByTestId('account-brief-lane')).toBeVisible();
		await expect(page.getByTestId('brief-primary')).toHaveCount(0);

		// The persistent conversation is present and bound to the account scope.
		await expect(page.getByTestId('conversation-panel')).toBeVisible();
		await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');
		await expect(page.getByTestId('conv-context-label')).toContainText('Everything');
		await context.close();
	});

	test('Projects lists real builds and excludes the Home account scope', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);

		await expect(page.getByTestId('project-list')).toBeVisible();
		await expect(page.getByTestId('project-row-proj-a')).toBeVisible();
		await expect(page.getByTestId('project-row-proj-b')).toBeVisible();
		// The Home project is the account scope, never a "build" you see here.
		await expect(page.getByTestId('project-row-home-1')).toHaveCount(0);

		// Opening a project routes to its Overview keeping the ?project= binding.
		await page.getByTestId('project-row-proj-b').getByRole('button', { name: 'Telemetry' }).click();
		await expect(page).toHaveURL(/\/app\/project\?project=proj-b$/);
		await context.close();
	});

	test('an invalid ?project= is a MISSING project — never a silent fallback', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=does-not-exist`);

		// Explicit missing state; no other project's data is substituted.
		await expect(page.getByText('That project is not in your list')).toBeVisible();
		await expect(page.getByTestId('project-header')).toHaveCount(0);
		await expect(page.getByText('Pit wall')).toHaveCount(0);

		// The retry affordance clears the bad param (back to a real surface).
		await page.getByTestId('state-retry-error').click();
		await expect(page).toHaveURL(/\/app\/project(\?|$)/);
		await expect(page.getByText('That project is not in your list')).toHaveCount(0);
		await context.close();
	});

	test('the conversation binds to the selected project and never retargets', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		const page = await context.newPage();

		// Global route → general scope.
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');

		// Project route → the project binds by name; refresh retains the binding.
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'project');
		await expect(page.getByTestId('conv-context-label')).toContainText('Pit wall');

		await page.reload();
		await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'project');
		await expect(page.getByTestId('conv-context-label')).toContainText('Pit wall');

		// Moving to another project re-binds to THAT project (no leak of proj-a).
		await page.goto(`${BASE}/app/project?project=proj-b`);
		await expect(page.getByTestId('conv-context-label')).toContainText('Telemetry');
		await context.close();
	});

	test('project-local tabs reach Build with real run/artifact rows and collapsible detail', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		await context.unroute('**/api/projects/**');
		await context.route('**/api/projects/**', (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [RUN_BINDING] });
			if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [ARTIFACT] });
			if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
			if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
			return json(route, 200, {});
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);

		await expect(page.getByTestId('project-tabs')).toBeVisible();
		// v2: Overview orients above the four steps (Plan/Build/Check/Share);
		// no step is current on Overview.
		await expect(page.locator('.project-step.current')).toHaveCount(0);
		await page.getByTestId('project-tab-build').click();
		await expect(page).toHaveURL(/\/app\/runs\?project=proj-a$/); // the binding is preserved
		await expect(page.getByTestId('project-tab-build')).toHaveAttribute('aria-current', 'page');
		// v2 Build: past builds as sentences; details fold; Files is a tab.
		await expect(page.getByTestId('run-row')).toHaveCount(1);
		await expect(page.getByTestId('run-row')).toContainText('react-hono');
		await page.getByTestId('run-detail-toggle').click();
		await expect(page.getByTestId('run-details')).toContainText('Built with');
		// Raw record ids live in the developer fold inside the details.
		await page.getByTestId('run-details').locator('summary', { hasText: 'For developers' }).click();
		await expect(page.getByTestId('run-details')).toContainText('conv-01HZX');
		await page.getByTestId('build-tab-files').click();
		await expect(page).toHaveURL(/tab=files/);
		await expect(page.getByTestId('artifact-viewer')).toBeVisible();
		await context.close();
	});

	test('drafts hold an idempotency key; retry and discard work; drafts survive reload', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		// Pin the coordinator transport to a deterministic refusal for this
		// project so the attempt counter moves exactly once per send/retry.
		await context.route('**/api/projects/proj-a/runs', (route) =>
			json(route, 503, { error: 'run_transport_unavailable', message: 'run creation refused in this spec' }),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('composer-input')).toBeVisible();

		const composer = page.getByTestId('composer-input');
		await composer.fill('Find me a hackathon worth my weekend');
		await page.getByTestId('composer-send').click();
		const draft = page.getByTestId('draft-row');
		await expect(draft).toBeVisible();
		await expect(draft).toContainText('Not sent'); // v2 §3.6 wording
		await expect(draft).toContainText(/key [0-9a-z]/); // generated idempotency key rendered short
		await expect(page.getByTestId('draft-retry')).toBeVisible();

		// Retry bumps the failed-attempt count without duplicating the draft.
		await page.getByTestId('draft-retry').click();
		await expect(page.getByTestId('draft-row')).toContainText('2 attempts');
		await expect(page.getByTestId('draft-row')).toHaveCount(1);

		// Discard keeps the row for reference, struck through as cancelled.
		await page.getByTestId('draft-discard').click();
		await expect(page.getByTestId('draft-row')).toHaveAttribute('data-state', 'cancelled');
		await expect(page.getByTestId('draft-row')).toContainText('cancelled');

		// Drafts are scoped per account+project and survive a reload.
		await page.reload();
		await expect(page.getByTestId('draft-row')).toBeVisible();
		await expect(page.getByTestId('draft-row')).toHaveAttribute('data-state', 'cancelled');
		await context.close();
	});

	test('a loading list resolves; a server fault, denied and limit each render an explicit state', async ({ browser }) => {
		// Loading → resolves into the project list.
		const loadingCtx = await browser.newContext();
		await stubAccount(loadingCtx, { current: DATA });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await loadingCtx.unroute('**/api/projects');
		await loadingCtx.route('**/api/projects', async (route) => {
			if (route.request().method() !== 'GET') return json(route, 405, {});
			await gate;
			return json(route, 200, DATA.body);
		});
		const loadingPage = await loadingCtx.newPage();
		await loadingPage.goto(`${BASE}/app/projects`);
		await expect(loadingPage.getByTestId('state-loading').first()).toBeVisible();
		release();
		await expect(loadingPage.getByTestId('project-list')).toBeVisible({ timeout: 10_000 });
		await loadingCtx.close();

		// Error → explicit fault + recovery; denied → denied; limit → limit.
		const context = await browser.newContext();
		const config: { current: ListConfig } = { current: { status: 500, body: { error: 'internal_error' } } };
		await stubAccount(context, config);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);
		await expect(page.getByTestId('state-error')).toBeVisible();
		await expect(page.getByTestId('state-retry-error')).toBeVisible();

		config.current = { status: 403, body: { error: 'not_a_member' } };
		await page.getByTestId('state-retry-error').click();
		await expect(page.getByTestId('state-denied')).toBeVisible();

		config.current = { status: 429, body: { error: 'rate_limited' } };
		await page.getByTestId('state-retry-denied').click();
		await expect(page.getByTestId('state-limit')).toBeVisible();
		await context.close();
	});

	test('offline renders the explicit offline state when the fetch cannot complete', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		await context.unroute('**/api/projects');
		await context.route('**/api/projects', (route) => route.abort('connectionfailed'));
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);
		await expect(page.getByTestId('state-offline')).toBeVisible();
		await expect(page.getByTestId('state-retry-offline')).toBeVisible();
		await context.close();
	});

	test('light and dark themes both render and the choice persists across reload', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('shell')).toBeVisible();
		const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.getByTestId('theme-toggle').click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		expect(lightBg).not.toEqual(darkBg);
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await context.close();
	});

	test('keyboard operability: skip link, theme toggle and composer are reachable and usable', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		await context.route('**/api/projects/proj-a/runs', (route) => json(route, 503, { error: 'refused' }));
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('nav-capsule')).toBeVisible();

		// First Tab lands on the skip link.
		await page.keyboard.press('Tab');
		await expect(page.locator('.skip-link')).toBeFocused();

		// Theme toggle works from the keyboard.
		await page.getByTestId('theme-toggle').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

		// Composer: keyboard-only send creates a scoped draft.
		await page.getByTestId('composer-input').focus();
		await page.keyboard.type('keyboard only message');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('draft-row')).toContainText('keyboard only message');
		await context.close();
	});

	test('reduced motion disables animation while a loading state is on screen (non-vacuous)', async ({ browser }) => {
		const reduce = await browser.newContext({ reducedMotion: 'reduce' });
		await stubAccount(reduce, { current: DATA });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await reduce.unroute('**/api/projects');
		await reduce.route('**/api/projects', async (route) => {
			if (route.request().method() !== 'GET') return json(route, 405, {});
			await gate;
			return json(route, 200, { projects: [HOME, PROJECT_A] });
		});
		const pageReduce = await reduce.newPage();
		await pageReduce.goto(`${BASE}/app/projects`);
		await expect(pageReduce.getByTestId('state-loading').first()).toBeVisible();
		expect(await pageReduce.evaluate(() => document.getAnimations().length)).toBe(0);
		release();
		await reduce.close();

		const motion = await browser.newContext({ reducedMotion: 'no-preference' });
		await stubAccount(motion, { current: DATA });
		let release2: () => void = () => {};
		const gate2 = new Promise<void>((resolve) => {
			release2 = resolve;
		});
		await motion.unroute('**/api/projects');
		await motion.route('**/api/projects', async (route) => {
			if (route.request().method() !== 'GET') return json(route, 405, {});
			await gate2;
			return json(route, 200, { projects: [HOME, PROJECT_A] });
		});
		const pageMotion = await motion.newPage();
		await pageMotion.goto(`${BASE}/app/projects`);
		await expect(pageMotion.getByTestId('state-loading').first()).toBeVisible();
		expect(await pageMotion.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0);
		release2();
		await motion.close();
	});

	for (const [width, height] of [
		[390, 844],
		[768, 1024],
		[1440, 900],
	] as const) {
		test(`no horizontal overflow at ${width}px (Home + Build)`, async ({ browser }) => {
			const context = await browser.newContext({ viewport: { width, height } });
			await stubAccount(context, { current: DATA });
			await context.unroute('**/api/projects/**');
			await context.route('**/api/projects/**', (route) => {
				const path = new URL(route.request().url()).pathname;
				if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [RUN_BINDING] });
				if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [ARTIFACT] });
				if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
				return json(route, 200, {});
			});
			const page = await context.newPage();
			const assertNoOverflow = () =>
				page.evaluate(() => ({
					scrollWidth: document.documentElement.scrollWidth,
					clientWidth: document.documentElement.clientWidth,
				}));

		// Tablet band (761–1080): content full width, Caddie opens as an overlay
		// from the top-bar button (v2 shell U01).
		await page.goto(`${BASE}/app/`);
		if (width === 768) {
			await expect(page.getByTestId('conv-toggle')).toBeVisible();
			await page.getByTestId('conv-toggle').click();
			await expect(page.getByTestId('conversation-panel')).toBeVisible();
			await page.getByTestId('conv-collapse').click();
		} else if (width < 768) {
			// Mobile lands on the conversation (the chat tab is the default).
			await expect(page.getByTestId('conversation-panel')).toBeVisible();
			await page.goto(`${BASE}/app/?pane=brief`);
			await expect(page.getByTestId('brief-screen')).toBeVisible();
			expect(await assertNoOverflow()).toEqual({ scrollWidth: width, clientWidth: width });
		}
		expect(await assertNoOverflow()).toEqual({ scrollWidth: width, clientWidth: width });

			// Build surface with real rows (desktop tab strip / mobile bottom nav).
			await page.goto(`${BASE}/app/runs?project=proj-a`);
			await expect(page.getByTestId('run-row')).toBeVisible();
			expect(await assertNoOverflow()).toEqual({ scrollWidth: width, clientWidth: width });
			await context.close();
		});
	}

	test('the mobile shell keeps the floating bottom nav + composer and drops the desktop capsule', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		// The persistent right panel is not rendered on mobile; the floating
		// bottom nav carries the three destinations + the composer instead.
		await expect(page.getByTestId('bottom-nav')).toBeVisible();
		await expect(page.getByTestId('nav-discover-mobile')).toBeVisible();
		await expect(page.getByTestId('nav-projects-mobile')).toBeVisible();
		// Only ONE composer exists in the DOM (no duplicate on mobile).
		await expect(page.getByTestId('composer-input')).toHaveCount(1);

		// Opening the conversation from the composer jumps to the channel pane.
		await page.getByTestId('composer-input').fill('hello caddie');
		await page.getByTestId('composer-send').click();
		await expect(page).toHaveURL(/pane=channel/);
		// The floating conversation head serves as the context indicator; tabs
		// navigate away (no Back button in the Today grammar). The pill carries
		// the scope name; the tooltip carries the explanation.
		await expect(page.getByTestId('conv-context')).toBeVisible();
		await expect(page.getByTestId('conv-context-label')).toContainText('Everything');
		// The scope label is now the "Talking about" switch button (U02).
		await expect(page.getByTestId('talking-about')).toHaveAttribute(
			'title',
			'Switch what this chat is about — the project page you are on, or everything',
		);
		await context.close();
	});

	test('the account menu exposes the secondary account surfaces', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await page.getByTestId('account-menu').click();
		await expect(page.getByTestId('account-menu-pop')).toBeVisible();
		await expect(page.getByTestId('account-profile')).toBeVisible();
		await expect(page.getByTestId('account-usage')).toBeVisible();
		// Register BEFORE the click so the usage fetch (fired on mount) is stubbed.
		await context.route('**/api/usage', (route) =>
			json(route, 200, {
				payer: { payerId: 'actor-test', limitMinorUnits: 100000, currency: 'USD' },
				totals: { reservedMinorUnits: 0, settledMinorUnits: 2500, reservations: 1 },
			}),
		);
		await page.getByTestId('account-usage').click();
		// v2 (U08): the account menu routes to Settings › Spending.
		await expect(page).toHaveURL(/\/app\/settings\?tab=spending$/);
		// Usage reads the real budget read model (audit F11/S40): the payer
		// limit plus reserved/settled totals — no fabricated numbers.
		await expect(page.getByTestId('usage-panel')).toBeVisible();
		// Amounts are minor units (cents): 100000 → $1,000.00, 2500 → $25.00 —
		// never the raw number shown as dollars.
		await expect(page.getByTestId('usage-limit')).toHaveText('$1,000.00');
		await expect(page.getByTestId('usage-settled')).toContainText('$25.00');
		await expect(page.getByTestId('usage-settled')).not.toContainText('2,500');
		await context.close();
	});
});
