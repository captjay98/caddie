import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Team-mode screens (plan section 7) — run against the COMPOSED build
 * (`bun run build` first).
 *
 * Screen 2, build progress:
 *   - a small app shows its server and screens parts (the existing build card);
 *   - a big app shows its parts side by side, each with its state (waiting,
 *     building, joined, not joined, stopped);
 *   - the spending-limit stop (part A) shows the limit message and what is saved;
 *   - the "Try again from the last save point" button (part F) appears where the
 *     build offers it.
 *
 * Driven by the real `ProjectExperience` shape (its `modules` and `spendStop`
 * fields, and the `try_again` action) plus the build-activity timeline.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-team-screens-2-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/build-progress-team.spec.ts');
	}
	if (!(await isListening(PORT))) {
		preview = spawn('/bin/bash', ['-c', `exec bunx vite preview --port ${PORT} --host 127.0.0.1 > '${LOG}' 2>&1`], {
			cwd: APP_DIR,
			stdio: 'ignore',
			detached: true,
		});
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

const NOW = '2026-10-22T10:00:00.000Z';

function project(id: string, name: string, kind: 'standard' | 'home' = 'standard') {
	return { id, workspaceId: 'ws-1', name, description: null, contestId: null, contestUrl: null, status: 'active', kind, createdAt: NOW, updatedAt: NOW };
}
const HOME = project('home-1', 'Home', 'home');
const PROJ = project('proj-a', 'FarmLog');

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function feature(id: string, title: string, position: number, status: string) {
	return { id, title, doneWhen: ['check'], position, status, attempts: status === 'building' ? 1 : status === 'failed' ? 3 : 0, testsPassed: status === 'passed' ? 1 : null, passedAt: status === 'passed' ? NOW : null, canRollBack: false };
}

function activity(phase: string, features: unknown[]) {
	return {
		projectId: 'proj-a', phase, building: phase === 'building', steps: [], rounds: [], openIssues: 0, features,
		timeline: {
			phase, startedAt: NOW, lastActivityAt: NOW, elapsedMs: 60_000, idleMs: 5_000, quiet: false, summary: 'Caddie is building your app.',
			stages: [
				{ key: 'setup', label: 'Get the workspace ready', state: 'done', startedAt: NOW, endedAt: NOW, durationMs: 20_000, detail: null },
				{ key: 'write', label: 'Write the app', state: phase === 'building' ? 'active' : 'done', startedAt: NOW, endedAt: null, durationMs: 40_000, detail: '2 files' },
				{ key: 'test', label: 'Run its own tests', state: 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
				{ key: 'check', label: 'Final checks by Caddie', state: 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
				{ key: 'preview', label: 'Make the preview', state: 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
			],
			scope: [], files: [], fileAreas: { app: 0, test: 0, style: 0, config: 0, server: 0 }, commands: [], tests: null, checks: [],
		},
	};
}

async function stub(context: BrowserContext, opts: { experience: unknown; activityPhase: string; features?: unknown[]; detail?: string }) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) => json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }));
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) => json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }));
	await context.route('**/api/usage', (route) => json(route, 200, { payer: { payerId: 'actor-test', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 0, reservations: 0 } }));
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJ] }));
	await context.route('**/api/approvals**', (route) => json(route, 200, { approval: null }));
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/experience')) return json(route, 200, opts.experience);
		if (path.endsWith('/activity')) return json(route, 200, activity(opts.activityPhase, opts.features ?? []));
		if (path.endsWith('/workflow'))
			return json(route, 200, {
				workflow: { projectId: 'proj-a', phase: opts.activityPhase, planId: 'p1', previewId: null, detail: opts.detail ?? null, brief: 'Build FarmLog.' },
				plan: { id: 'p1', revision: 1 },
				approval: { status: 'approved' },
				importPreview: null,
			});
		if (path.endsWith('/hackathon')) return json(route, 200, { hackathon: null });
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		return json(route, 200, {});
	});
}

const MODULES = [
	{ id: 'core', plain: 'Farms, people and roles', state: 'joined' },
	{ id: 'sales', plain: 'Sales and suppliers', state: 'built' },
	{ id: 'feed', plain: 'Feed stock and use', state: 'building' },
	{ id: 'money', plain: 'Money in and out', state: 'waiting', waitingFor: ['Feed stock and use'] },
	{ id: 'tasks', plain: 'Tasks', state: 'stopped' },
];

test.describe('Build progress — small and big apps (plan section 7, screen 2)', () => {
	test('a small app shows its server and screens parts (stages), no module board', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, {
			experience: { projectId: 'proj-a', version: Date.parse(NOW), stage: 'building', plan: { id: 'p1', revision: '1', approved: true }, preview: null, message: 'Caddie is building your app.', actions: [{ kind: 'stop', label: 'Stop build', enabled: true, primary: false }] },
			activityPhase: 'building',
			features: [feature('log-feed', 'Log daily feed', 1, 'building')],
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		await expect(page.getByTestId('build-progress')).toBeVisible();
		await expect(page.getByTestId('build-stages')).toContainText('Write the app');
		await expect(page.getByTestId('build-stages')).toContainText('Run its own tests');
		// A small app has no parts board.
		await expect(page.getByTestId('module-progress')).toHaveCount(0);
		if (process.env.CADDIE_SHOTS) await page.getByTestId('project-workflow').screenshot({ path: join(process.env.CADDIE_SHOTS, 'build-small-desktop.png') });
		await context.close();
	});

	test('a big app shows its parts side by side, each with its state', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, {
			experience: { projectId: 'proj-a', version: Date.parse(NOW), stage: 'building', plan: { id: 'p1', revision: '1', approved: true }, preview: null, message: 'Caddie is building your app.', actions: [{ kind: 'stop', label: 'Stop build', enabled: true, primary: false }], modules: MODULES },
			activityPhase: 'building',
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		const board = page.getByTestId('module-progress');
		await expect(board).toBeVisible();
		await expect(page.getByTestId('module-core')).toHaveAttribute('data-state', 'joined');
		await expect(page.getByTestId('module-state-core')).toHaveText('In your app');
		// Passed its own checks but not joined yet: never "In your app".
		await expect(page.getByTestId('module-sales')).toHaveAttribute('data-state', 'built');
		await expect(page.getByTestId('module-state-sales')).toHaveText('Built · joining your app next');
		await expect(board.getByRole('heading')).toContainText('1 of 5 joined');
		await expect(page.getByTestId('module-feed')).toHaveAttribute('data-state', 'building');
		await expect(page.getByTestId('module-state-feed')).toHaveText('Building now');
		await expect(page.getByTestId('module-state-money')).toHaveText('Waiting for Feed stock and use');
		await expect(page.getByTestId('module-state-tasks')).toContainText('Stopped');
		if (process.env.CADDIE_SHOTS) {
			await page.getByTestId('project-workflow').screenshot({ path: join(process.env.CADDIE_SHOTS, 'build-big-desktop.png') });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByTestId('module-progress').screenshot({ path: join(process.env.CADDIE_SHOTS, 'build-big-mobile.png') });
		}
		await context.close();
	});

	test('the spending-limit stop says it once, and adds what retrying does', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		const sentence = 'This build reached its spending limit of $5.00. Your plan and files are saved.';
		await stub(context, {
			experience: {
				projectId: 'proj-a', version: Date.parse(NOW), stage: 'blocked', plan: { id: 'p1', revision: '1', approved: true }, preview: null,
				message: sentence,
				actions: [{ kind: 'retry', label: 'Retry build', enabled: true, primary: true }],
				spendStop: { note: 'Retrying starts the build again with a new spending limit.' },
				modules: MODULES,
			},
			activityPhase: 'blocked',
			detail: sentence,
			features: [feature('log-feed', 'Log daily feed', 1, 'passed')],
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		const card = page.getByTestId('project-workflow');
		await expect(page.getByTestId('spend-stop')).toHaveText('Retrying starts the build again with a new spending limit.');
		// The stop sentence (the build's blocker message) is on the card exactly once.
		const text = await card.innerText();
		expect(text.split('reached its spending limit').length - 1).toBe(1);
		// The parts board is still shown beside the stop.
		await expect(page.getByTestId('module-progress')).toBeVisible();
		await context.close();
	});

	test('the Try again button appears where the build offers it (part F)', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		let tried = false;
		await stub(context, {
			experience: {
				projectId: 'proj-a', version: Date.parse(NOW), stage: 'blocked', plan: { id: 'p1', revision: '1', approved: true }, preview: null,
				message: 'Caddie stopped after three tries on a feature. Your plan and files are saved.',
				actions: [
					{ kind: 'try_again', label: 'Try this feature again', enabled: true, primary: true },
					{ kind: 'retry', label: 'Resume the build', enabled: true, primary: false },
				],
			},
			activityPhase: 'blocked',
			features: [feature('log-feed', 'Log daily feed', 1, 'passed'), feature('dashboard', 'See the dashboard', 2, 'failed')],
		});
		await context.route('**/api/projects/proj-a/workflow/try-again', (route) => {
			tried = true;
			return json(route, 200, { workflow: { phase: 'building' } });
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		const button = page.getByTestId('try-again-button');
		await expect(button).toBeVisible();
		await expect(button).toContainText('Try this feature again');
		await button.click();
		await expect.poll(() => tried).toBe(true);
		if (process.env.CADDIE_SHOTS) await page.getByTestId('try-again').screenshot({ path: join(process.env.CADDIE_SHOTS, 'build-try-again-desktop.png') });
		await context.close();
	});

	test('a build that does not offer try-again shows no Try again button', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, {
			experience: {
				projectId: 'proj-a', version: Date.parse(NOW), stage: 'blocked', plan: { id: 'p1', revision: '1', approved: true }, preview: null,
				message: 'The build paused. Press Retry to continue.',
				actions: [{ kind: 'retry', label: 'Retry build', enabled: true, primary: true }],
			},
			activityPhase: 'blocked',
			features: [feature('log-feed', 'Log daily feed', 1, 'passed')],
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		await expect(page.getByTestId('project-workflow')).toBeVisible();
		await expect(page.getByTestId('try-again-button')).toHaveCount(0);
		await context.close();
	});
});
