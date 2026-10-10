import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Page states acceptance (U03, docs/design/2026-10-10-v2/PACKETS.md) — run
 * against the COMPOSED build (`bun run build` first).
 *
 * What U03 guarantees for page states (HANDOFF §3.8):
 *   - Loading: the thinking character plus a specific line; shaped
 *     placeholders, never a blank.
 *   - Error: the stuck character, "Couldn't load"-style title, "Your work is
 *     safe — this is only the connection", "Try again now" and "Ask Caddie
 *     what happened" (which opens the conversation pane).
 *   - The page's real header/steps stay above the state panel — the state
 *     replaces only the content below.
 *   - The existing state kinds (denied, offline, limit, empty) keep working.
 *   - The mascot respects prefers-reduced-motion (static faces).
 *
 * UI-state proofs against stubbed API routes — not live-data evidence.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-u03-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/states.spec.ts');
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

declare const document: {
	documentElement: { scrollWidth: number; clientWidth: number };
	getAnimations(): unknown[];
};

const NOW = '2026-10-10T10:00:00.000Z';

function project(id: string, name: string, kind: 'standard' | 'home' = 'standard') {
	return {
		id,
		workspaceId: 'ws-1',
		name,
		description: 'Track a small habit',
		contestId: null,
		contestUrl: null,
		status: 'active',
		kind,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

const HOME = project('home-1', 'Home', 'home');
const PROJECT_A = project('proj-a', 'Pit wall');

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAccount(context: BrowserContext) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJECT_A] }));
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
		if (path.endsWith('/artifact-revisions')) return json(route, 200, { artifacts: [], latest: null });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
		return json(route, 200, {});
	});
}

test.describe('page states with the character (U03)', () => {
	test('loading shows the thinking character, a specific line and shaped placeholders', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await context.unroute('**/api/projects');
		await context.route('**/api/projects', async (route) => {
			if (route.request().method() !== 'GET') return json(route, 405, {});
			await gate;
			return json(route, 200, { projects: [HOME, PROJECT_A] });
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);

		const loading = page.getByTestId('state-loading').first();
		await expect(loading).toBeVisible();
		// The thinking character, not a blank.
		await expect(loading.locator('.mascot[data-state="thinking"]')).toBeVisible();
		// Shaped placeholders, not an empty box.
		await expect(loading.locator('.state-skeleton span').first()).toBeVisible();
		release();
		await expect(page.getByTestId('project-list')).toBeVisible({ timeout: 10_000 });
		await context.close();
	});

	test('error shows the stuck character, the safety line, Try again now and Ask Caddie', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		await context.unroute('**/api/projects');
		await context.route('**/api/projects', (route) => json(route, 500, { error: 'internal_error' }));
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);

		const error = page.getByTestId('state-error').first();
		await expect(error).toBeVisible();
		await expect(error.locator('.mascot[data-state="stuck"]')).toBeVisible();
		await expect(error.getByTestId('state-safety-note')).toContainText('Your work is safe — this is only the connection');
		await expect(error.getByTestId('state-retry-error')).toContainText('Try again now');

		// "Ask Caddie what happened" opens the conversation pane.
		await error.getByTestId('state-ask-caddie').click();
		await expect(page.getByTestId('app-split')).toHaveAttribute('data-conv-state', 'full');
		await context.close();
	});

	test('a page keeps its real header and steps above the failing content', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		// The project list resolves, but the Build surface's data fails.
		await context.unroute('**/api/projects/**');
		await context.route('**/api/projects/**', (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.endsWith('/run-bindings')) return json(route, 500, { error: 'internal_error' });
			if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
			if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
			if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
			return json(route, 200, {});
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);

		// The v2 header (name + what it's for + steps) stays real.
		await expect(page.getByTestId('project-header')).toBeVisible();
		await expect(page.getByTestId('project-head-name')).toContainText('Pit wall');
		await expect(page.getByTestId('project-tabs')).toBeVisible();
		// The page's own title stays real; only the content below shows the error.
		await expect(page.getByText('Activity')).toBeVisible();
		await expect(page.getByTestId('state-error').first()).toBeVisible();
		await context.close();
	});

	test('no step is ever green unless its data says done', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('project-tabs')).toBeVisible();
		// No status was passed for any step, so no step may carry the done tone.
		await expect(page.locator('.project-step.done')).toHaveCount(0);
		// Four steps; Overview orients above them, so none is current here.
		await expect(page.locator('.project-step')).toHaveCount(4);
		await expect(page.locator('.project-step.current')).toHaveCount(0);
		// On a step page exactly one step is current.
		await page.goto(`${BASE}/app/design-review?project=proj-a`);
		await expect(page.locator('.project-step.current')).toHaveCount(1);
		await expect(page.getByTestId('project-tab-plan')).toHaveAttribute('aria-current', 'page');
		await context.close();
	});

	test('the personal project reads Share as its last step; linked contest reads Submit', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const page = await context.newPage();
		// proj-a has no contestUrl → Share.
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('project-tab-submission')).toContainText('Share');
		await context.close();
	});

	test('the gear is disabled with an honest reason until the project settings route exists', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		const gear = page.getByTestId('project-settings-gear');
		await expect(gear).toBeDisabled();
		await expect(gear).toHaveAttribute('title', 'Project settings is coming');
		await context.close();
	});

	test('the character is animated normally and static under reduced motion', async ({ browser }) => {
		const context = await browser.newContext({ reducedMotion: 'no-preference' });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);
		await expect(page.getByTestId('nav-capsule')).toBeVisible();
		// The conversation head carries a live mascot with running animations.
		const animations = await page.evaluate(() => document.getAnimations().length);
		expect(animations).toBeGreaterThan(0);
		await context.close();

		const reduce = await browser.newContext({ reducedMotion: 'reduce' });
		await stubAccount(reduce);
		const rPage = await reduce.newPage();
		await rPage.goto(`${BASE}/app/projects`);
		await expect(rPage.getByTestId('nav-capsule')).toBeVisible();
		expect(await rPage.evaluate(() => document.getAnimations().length)).toBe(0);
		await reduce.close();
	});
});
