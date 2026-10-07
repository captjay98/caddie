import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P06 workspace shell acceptance — run against the COMPOSED build
 * (`bun run build` first): the real Worker under `vite preview` = local
 * workerd on 127.0.0.1:4173, SPA at /app/.
 *
 * What is proven where:
 *   - LIVE (real /api, no stubs): unauthenticated /app shows the P01 sign-in
 *     state — the fail-closed /api/auth/status probe drives the gate.
 *   - UI-STATE PROOFS (Playwright route interception on /api/*): the
 *     loading/empty/stale/denied/limit/error/offline states, project
 *     selection + refresh retention, drafts with retry affordance, keyboard
 *     operability, theme rendering and 390/768/1440 overflow. The local
 *     composed build has auth enabled and no seeded accounts, so the
 *     authenticated data surfaces are driven deterministically by stubbing
 *     the session endpoints and the P02 REST shapes (documented as UI-state
 *     proofs — the real-data integration story is P02's integration suite +
 *     P17 acceptance, not this spec).
 *
 * The chat transport is P05's live acceptance; the channel here proves the
 * draft/idempotency/retry UI contract that P05 plugs into.
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

// The root tsconfig intentionally omits the "dom" lib (it typechecks Node and
// bun code). The callbacks below run inside the browser via page.evaluate, so
// declare the minimal surface this spec touches — module-scoped, mirroring
// landing.spec.ts.
declare const document: {
	documentElement: { scrollWidth: number; clientWidth: number };
	body: object;
	getAnimations(): unknown[];
};
declare function getComputedStyle(element: object): { backgroundColor: string };

// --- fixture data (mirrors the real P02 payload shapes in packages/contracts) --

const NOW = '2026-10-04T10:00:00.000Z';

function project(id: string, name: string) {
	return {
		id,
		workspaceId: 'ws-1',
		name,
		description: null,
		contestId: null,
		contestUrl: null,
		status: 'active',
		createdAt: NOW,
		updatedAt: NOW,
	};
}

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

/** Authenticated session for UI-state proofs: /api/auth/* is stubbed, not live. */
async function stubSession(context: BrowserContext) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Test', email: 't@caddie.test' } }),
	);
	// Default every project-child endpoint to its honest empty shape so a
	// selected project never leaks a real 401 into the panes under test.
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		return json(route, 200, {});
	});
}

type ListConfig = { status: number; body: unknown; delayMs?: number };

/**
 * Mutable list handler: tests flip `config` to drive each explicit state
 * (loading = deferred, empty, data, 500, 403, 429) against the same UI.
 */
async function stubProjectList(context: BrowserContext, config: { current: ListConfig }) {
	await context.route('**/api/projects', async (route) => {
		if (route.request().method() !== 'GET') return json(route, 405, { error: 'method_not_allowed' });
		if (config.current.delayMs) await sleep(config.current.delayMs);
		return json(route, config.current.status, config.current.body);
	});
}

const DATA: ListConfig = { status: 200, body: { projects: [PROJECT_A, PROJECT_B] } };

// --- tests ----------------------------------------------------------------------

test.describe('P06 workspace shell (composed build)', () => {
	test('unauthenticated /app shows the real sign-in state (live probe, no stubs)', async ({ page }) => {
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('sign-in-panel')).toBeVisible();
		await expect(page.getByTestId('sign-in-google')).toBeVisible();
		await expect(page.getByTestId('shell')).toBeVisible();
		// The workspace itself must not render for an unverified session.
		await expect(page.getByTestId('project-selector')).toHaveCount(0);
	});

	test('authed workspace with no projects renders the onboarding entry', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { current: { status: 200, body: { projects: [] } } });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		await expect(page.getByTestId('project-selector')).toBeVisible();
		await expect(page.getByTestId('project-selector')).toHaveValue('');
		// Zero projects + a clean load: the onboarding IS the workspace body —
		// three entry cards, no profile wall, no fake empty panes. The repo
		// card is honestly "planned" (unlock named in visitor terms, never a
		// packet id); the discovery card is a REAL link now that the P11
		// surface exists — planned pills are removed only when the destination
		// is real.
		await expect(page.getByTestId('start-screen')).toBeVisible();
		await expect(page.getByTestId('start-card-idea')).toBeVisible();
		await expect(page.getByTestId('start-card-repo')).toHaveAttribute('data-testid', 'start-card-repo');
		await expect(page.getByTestId('start-card-repo')).toContainText('needs a repository connection');
		await expect(page.getByTestId('start-card-discovery')).not.toHaveAttribute('data-coming-with');
		await expect(page.getByTestId('start-discovery-go')).toHaveAttribute('href', './discovery');
		await expect(page.getByTestId('start-repo-go')).toHaveAttribute('href', './repositories');
		// The idea card opens the real new-project form in place.
		await page.getByTestId('start-idea-go').click();
		await expect(page.getByTestId('new-project-name')).toBeVisible();
		await context.close();
	});

	test('loading state is reachable and resolves into the project list', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await context.route('**/api/projects', async (route) => {
			await gate;
			return json(route, 200, { projects: [PROJECT_A] });
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('state-loading').first()).toBeVisible();
		release();
		await expect(page.getByTestId('project-selector')).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-a');
		await context.close();
	});

	test('project selection is retained across refresh via the URL param', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-a'); // first project is the fallback
		await page.getByTestId('project-selector').selectOption('proj-b');
		await expect(page).toHaveURL(/\/app\/\?project=proj-b$/);
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-b');

		await page.reload();
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-b');
		await context.close();
	});

	test('runs pane renders the real run-binding and artifact rows with collapsible detail', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { current: DATA });
		await context.unroute('**/api/projects/**');
		await context.route('**/api/projects/**', (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [RUN_BINDING] });
			if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [ARTIFACT] });
			if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
			return json(route, 200, {});
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-a');
		await page.getByTestId('tab-runs').click();
		await expect(page.getByTestId('run-row')).toHaveCount(1);
		await expect(page.getByTestId('run-row')).toContainText('react-hono');
		await expect(page.getByTestId('run-row')).toContainText('recorded'); // honest default status
		await page.getByTestId('run-detail-toggle').click();
		await expect(page.getByTestId('run-details')).toContainText('conv-01HZX');
		await expect(page.getByTestId('run-details')).toContainText('plan-r2');
		await expect(page.getByTestId('artifact-row')).toHaveCount(1);
		await page.getByTestId('artifact-detail-toggle').click();
		await expect(page.locator('[data-testid="artifact-row"]').locator('.row-details')).toContainText('art-spec');
		await context.close();
	});

	test('server fault renders the explicit error state and recovers on retry', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		const config: { current: ListConfig } = {
			current: { status: 500, body: { error: 'internal_error' } },
		};
		await stubProjectList(context, config);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('state-error')).toBeVisible();
		await expect(page.getByTestId('state-retry-error')).toBeVisible();
		config.current = DATA;
		await page.getByTestId('state-retry-error').click();
		await expect(page.getByTestId('project-selector')).toBeVisible();
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-a');
		await context.close();
	});

	test('denied (403) and limit (429) render their explicit states', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		const config: { current: ListConfig } = {
			current: { status: 403, body: { error: 'not_a_member' } },
		};
		await stubProjectList(context, config);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('state-denied')).toBeVisible();

		config.current = { status: 429, body: { error: 'rate_limited' } };
		await page.getByTestId('refresh-data').click();
		await expect(page.getByTestId('state-limit')).toBeVisible();
		await context.close();
	});

	test('offline renders the explicit offline state (pause + fetch-failure paths)', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('project-selector')).toBeVisible();

		// Path 1 — TanStack pauses refetches while the browser is offline; the
		// aside renders the explicit offline panel over the last loaded data.
		await context.setOffline(true);
		await page.getByTestId('refresh-data').click();
		await expect(page.getByTestId('state-offline')).toBeVisible();

		// Path 2 — on reconnect the paused queries resume into a dead network
		// (no stub for the list any more): the fetch rejects and the offline
		// classification holds instead of silently returning to stale data.
		await context.unroute('**/api/projects');
		await context.route('**/api/projects', (route) => route.abort('connectionfailed'));
		await context.setOffline(false);
		await expect(page.getByTestId('state-offline')).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId('state-retry-offline')).toBeVisible();
		await context.close();
	});

	test('stale indicator shows while a refetch is in flight, then clears', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		const config: { current: ListConfig } = { current: { ...DATA } };
		await stubProjectList(context, config);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-a');
		await expect(page.getByTestId('stale-chip')).toHaveCount(0);

		config.current = { ...DATA, delayMs: 600 };
		await page.getByTestId('refresh-data').click();
		await expect(page.getByTestId('stale-chip')).toBeVisible();
		await expect(page.getByTestId('stale-chip')).toBeHidden({ timeout: 10_000 });
		await context.close();
	});

	test('sends are held as drafts with an idempotency key; retry and discard work; drafts survive reload and errors', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		const config: { current: ListConfig } = {
			current: { status: 500, body: { error: 'internal_error' } },
		};
		await stubProjectList(context, config);
		// The coordinator transport IS wired now: pin it to a deterministic
		// failure for this draft-focused test (no run exists, run creation
		// refused), so the attempt counter moves exactly once per send/retry.
		await context.route('**/run-bindings', (route) => json(route, 200, { runBindings: [] }));
		await context.route('**/api/projects/*/runs', (route) =>
			json(route, 503, { error: 'run_transport_unavailable', message: 'run creation refused in this spec' }),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		// The list starts broken: the aside must show the explicit error panel.
		await expect(page.getByTestId('state-error')).toBeVisible();
		// No project can be selected while the list errors — the channel shows
		// its no-project state, so first recover the list.
		config.current = DATA;
		await page.getByTestId('state-retry-error').click();
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-a');

		const composer = page.getByTestId('composer-input');
		await composer.fill('Find me a hackathon worth my weekend');
		await page.getByTestId('composer-send').click();
		const draft = page.getByTestId('draft-row');
		await expect(draft).toBeVisible();
		await expect(draft).toContainText('unsent');
		await expect(draft).toContainText(/key [0-9a-f]/); // generated idempotency key rendered short
		await expect(page.getByTestId('draft-retry')).toBeVisible();

		// Drafts are preserved on data errors: break the list again.
		config.current = { status: 500, body: { error: 'internal_error' } };
		await page.getByTestId('refresh-data').click();
		await expect(page.getByTestId('state-error')).toBeVisible();
		await expect(page.getByTestId('draft-row')).toBeVisible();
		config.current = DATA;
		await page.getByTestId('state-retry-error').click();

		// Retry bumps the attempt counter without duplicating the draft.
		// The transport was refused once on send (attempt 1 shown), the retry
		// makes attempt 2 — the row shows the true failed-attempt count.
		await page.getByTestId('draft-retry').click();
		await expect(page.getByTestId('draft-row')).toContainText('2 attempts');
		await expect(page.getByTestId('draft-row')).toHaveCount(1);

		// Discard renders the cancelled state (kept for reference, struck out).
		await page.getByTestId('draft-discard').click();
		await expect(page.getByTestId('draft-row')).toHaveAttribute('data-state', 'cancelled');
		await expect(page.getByTestId('draft-row')).toContainText('cancelled');

		// Drafts survive a reload (session-scoped storage, actor+project keyed).
		await page.reload();
		await expect(page.getByTestId('draft-row')).toBeVisible();
		await expect(page.getByTestId('draft-row')).toHaveAttribute('data-state', 'cancelled');
		await context.close();
	});

	test('keyboard operability: skip link, selector, tabs, theme and composer reachable and usable', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('project-selector')).toBeVisible();

		// First Tab lands on the skip link.
		await page.keyboard.press('Tab');
		await expect(page.locator('.skip-link')).toBeFocused();

		// The project selector is reachable by keyboard and operable.
		await page.getByTestId('project-selector').focus();
		await page.keyboard.press('t'); // type-ahead to "Telemetry"
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-b');
		await expect(page).toHaveURL(/project=proj-b/);

		// Theme toggle works from the keyboard.
		await page.getByTestId('theme-toggle').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.keyboard.press('Enter');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

		// Runs tab reachable by keyboard; run rows keyboard-expandable.
		await page.getByTestId('tab-runs').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('run-inspector')).toBeVisible();

		// Composer: keyboard-only send (Enter submits).
		await page.getByTestId('composer-input').focus();
		await page.keyboard.type('keyboard only message');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('draft-row')).toContainText('keyboard only message');
		await context.close();
	});

	test('light and dark themes both render from the halo tokens', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { current: DATA });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('shell')).toBeVisible();
		const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.getByTestId('theme-toggle').click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		expect(lightBg).not.toEqual(darkBg);
		// theme choice persists across reloads
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await context.close();
	});

	test('reduced motion disables every animation while loading states are on screen', async ({ browser }) => {
		const reduce = await browser.newContext({ reducedMotion: 'reduce' });
		await stubSession(reduce);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await reduce.route('**/api/projects', async (route) => {
			await gate;
			return json(route, 200, { projects: [PROJECT_A] });
		});
		const pageReduce = await reduce.newPage();
		await pageReduce.goto(`${BASE}/app/`);
		await expect(pageReduce.getByTestId('state-loading').first()).toBeVisible();
		expect(await pageReduce.evaluate(() => document.getAnimations().length)).toBe(0);
		reduce.close();

		// Control: the same loading state animates when motion is allowed —
		// proving the reduce assertion is not vacuous.
		const motion = await browser.newContext({ reducedMotion: 'no-preference' });
		await stubSession(motion);
		let release2: () => void = () => {};
		const gate2 = new Promise<void>((resolve) => {
			release2 = resolve;
		});
		await motion.route('**/api/projects', async (route) => {
			await gate2;
			return json(route, 200, { projects: [PROJECT_A] });
		});
		const pageMotion = await motion.newPage();
		await pageMotion.goto(`${BASE}/app/`);
		await expect(pageMotion.getByTestId('state-loading').first()).toBeVisible();
		expect(await pageMotion.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0);
		release();
		release2();
		await motion.close();
		await reduce.close();
	});

	for (const [width, height] of [
		[390, 844],
		[768, 1024],
		[1440, 900],
	] as const) {
		test(`no horizontal overflow at ${width}px`, async ({ browser }) => {
			const context = await browser.newContext({ viewport: { width, height } });
			await stubSession(context);
			await stubProjectList(context, { current: DATA });
			await context.unroute('**/api/projects/**');
			await context.route('**/api/projects/**', (route) => {
				const path = new URL(route.request().url()).pathname;
				if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [RUN_BINDING] });
				if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [ARTIFACT] });
				if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
				return json(route, 200, {});
			});
			const page = await context.newPage();
			await page.goto(`${BASE}/app/`);
			await expect(page.getByTestId('project-selector')).toBeVisible();

			const assertNoOverflow = () =>
				page.evaluate(() => ({
					scrollWidth: document.documentElement.scrollWidth,
					clientWidth: document.documentElement.clientWidth,
				}));
			// Channel surface (home on mobile, right pane on desktop).
			expect(await assertNoOverflow()).toEqual({
				scrollWidth: width,
				clientWidth: width,
			});
			// Runs surface with real rows.
			await page.getByTestId(width < 768 ? 'tab-runs-mobile' : 'tab-runs').click();
			await expect(page.getByTestId('run-row')).toBeVisible();
			await page.getByTestId('run-detail-toggle').click();
			expect(await assertNoOverflow()).toEqual({
				scrollWidth: width,
				clientWidth: width,
			});
			await context.close();
		});
	}

	test('creating a project from the shell posts to the real REST surface and selects the result', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		const config: { current: ListConfig } = { current: { status: 200, body: { projects: [] } } };
		await stubProjectList(context, config);
		await context.route('**/api/projects', (route) =>
			route.request().method() === 'POST'
				? json(route, 201, { project: project('proj-new', 'Fresh build') })
				: route.fallback(),
		);
		await context.route('**/api/workspaces', (route) =>
			json(route, 201, {
				workspace: { id: 'ws-new', name: 'Home', createdAt: NOW },
			}),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await page.getByTestId('new-project').click();
		await page.getByTestId('new-project-name').fill('Fresh build');
		config.current = { status: 200, body: { projects: [project('proj-new', 'Fresh build')] } };
		await page.getByTestId('new-project-submit').click();
		await expect(page).toHaveURL(/project=proj-new/);
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-new');
		await context.close();
	});
});
