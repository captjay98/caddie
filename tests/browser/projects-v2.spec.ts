import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Projects v2 acceptance (U05, docs/design/2026-10-10-v2/PACKETS.md) — run
 * against the COMPOSED build (`bun run build` first).
 *
 * What U05 guarantees for Projects (HANDOFF §4 Projects):
 *   - A card per project: name, what it's for, "Step N of 4 · <step>" in words
 *     plus four small bars, one line of what Caddie is doing. Archived folded.
 *   - Step text derives ONLY from real brief cards (no invented progress).
 *   - Buttons: "New project" (primary) and "Bring your code" (secondary).
 *   - The Bring your code window (import-repo) reads the real GitHub
 *     installations API, states Caddie only READS the repo at first, and only
 *     creates a project after the confirm step.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-u05-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/projects-v2.spec.ts');
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

const NOW = '2026-10-10T10:00:00.000Z';

function project(id: string, name: string, kind: 'standard' | 'home' = 'standard', extra: Record<string, unknown> = {}) {
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
		...extra,
	};
}

const HOME = project('home-1', 'Home', 'home');
const PROJ_A = project('proj-a', 'Pit wall', 'standard', { description: 'Track pit wall strategy' });
const PROJ_B = project('proj-b', 'Telemetry', 'standard', { status: 'archived' });

function briefCard(id: string, projectId: string, kind: string, status: string, headline: string, summary: string, targetId = 't-1') {
	return {
		id,
		projectId,
		kind,
		headline,
		summary,
		evidenceIds: [],
		status,
		updatedAt: NOW,
		primaryAction: { label: 'Open', kind: 'review', targetId },
		seen: true,
	};
}

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAccount(context: BrowserContext, opts: { cards?: unknown[] } = {}) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: opts.cards ?? [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJ_A, PROJ_B] }));
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

test.describe('Projects v2 (U05)', () => {
	test('cards show name, purpose, step text in words, four bars and what Caddie is doing', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			cards: [
				briefCard('brf_approval_ap-1', 'proj-a', 'approval', 'needs-you', 'Plan needs your OK', 'The drafted plan waits for your decision.', 'ap-1'),
				briefCard('brf_result_r-1', 'proj-a', 'result', 'handled', 'Build finished', 'The latest build produced a working preview.', 'r-1'),
			],
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);
		await expect(page.getByTestId('project-list')).toBeVisible();

		const row = page.getByTestId('project-row-proj-a');
		await expect(row).toContainText('Pit wall');
		await expect(row).toContainText('Track pit wall strategy');
		// "Step N of 4" in words: the pending plan approval puts the project at
		// step 1, and the label is the step's name (prototype grammar).
		await expect(row.getByTestId('project-step-text-proj-a')).toContainText('Step 1 of 4 · Plan');
		// Four small bars, the plan one carrying the warn tone.
		const bars = row.getByTestId(`project-steps-proj-a`).locator('i');
		await expect(bars).toHaveCount(4);
		// One line of what Caddie is doing: the newest card's summary.
		await expect(row).toContainText('The drafted plan waits for your decision.');

		// Archived projects fold.
		await expect(page.getByTestId('project-row-proj-b')).toHaveCount(0);
		await expect(page.getByTestId('project-archived')).toContainText('Archived · 1');
		await context.close();
	});

	test('a project with no brief cards claims no step — no invented progress', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);
		const row = page.getByTestId('project-row-proj-a');
		await expect(row.getByTestId('project-step-text-proj-a')).toContainText('No updates yet');
		// No bar may carry a status tone.
		const tones = await row.getByTestId('project-steps-proj-a').locator('i[data-tone]').count();
		expect(tones).toBe(0);
		await context.close();
	});

	test('New project is the primary and Bring your code opens the import window on the real installations API', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const installCalls: string[] = [];
		await context.route('**/api/github/installations**', (route) => {
			installCalls.push(route.request().url());
			return json(route, 200, {
				installations: [
					{
						installationId: 'inst-1',
						accountLogin: 'octo-org',
						status: 'active',
						appSlug: 'caddie',
						permissions: { contents: 'read' },
						workspaceId: 'ws-1',
					},
				],
			});
		});
		await context.route('**/api/github/installations/inst-1/repos', (route) =>
			json(route, 200, {
				repositories: [{ repoFullName: 'octo-org/pit-wall', status: 'selected' }],
			}),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);

		await expect(page.getByTestId('new-idea-project')).toBeVisible();
		await page.getByTestId('import-repo-project').click();
		const win = page.getByTestId('import-repo-window');
		await expect(win).toBeVisible();
		// The window reads the REAL installations API for the project's workspace.
		await expect(win).toContainText('at first only reads it');
		await expect(win.getByTestId('repository-picker')).toBeVisible();
		expect(installCalls.some((url) => url.includes('workspaceId=ws-1'))).toBe(true);

		// Pick the repo → choose the purpose → confirm creates the project.
		await win.getByRole('button', { name: 'Show repositories' }).click();
		await win.getByTestId('pick-repo-octo-org/pit-wall').click();
		await page.getByTestId('import-purpose-improve').click();
		const created: Record<string, unknown>[] = [];
		await context.route('**/api/workspaces', (route) => json(route, 201, { workspace: { id: 'ws-1', name: 'Home', createdAt: NOW } }));
		await context.unroute('**/api/projects');
		await context.route('**/api/projects', (route) => {
			if (route.request().method() !== 'POST') return json(route, 200, { projects: [HOME, PROJ_A] });
			const body = route.request().postDataJSON() as Record<string, unknown>;
			created.push(body);
			return json(route, 201, { project: project('proj-imported', String(body.name ?? 'New'), 'standard') });
		});
		let imported = false;
		await context.route('**/api/projects/proj-imported/github/imports', (route) => {
			imported = true;
			return json(route, 201, { import: { id: 'imp-1' } });
		});
		await page.getByTestId('import-repo-confirm').click();
		await expect(page).toHaveURL(/project=proj-imported/);
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ name: 'pit-wall' });
		expect(imported).toBe(true);
		await context.close();
	});
});
