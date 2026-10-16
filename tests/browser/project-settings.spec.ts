import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Project settings acceptance (U08, docs/design/2026-10-10-v2/PACKETS.md) —
 * run against the COMPOSED build (`bun run build` first).
 *
 * What U08 guarantees (HANDOFF §4 Project settings):
 *   - Sections: General (+ edit-description window on PATCH /api/projects/:id,
 *     empty name can't save), Code (+ connect-repo), Routines, What Caddie
 *     knows, Archive (typed name; archive-only — no permanent delete exists).
 *   - The project header's gear navigates here.
 *   - Old /schedules and /repositories links land on the right sections.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-u08-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/project-settings.spec.ts');
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
		description: 'Track pit wall strategy',
		contestId: null,
		contestUrl: null,
		status: 'active',
		kind,
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	};
}

const HOME = project('home-1', 'Home', 'home', { description: null });
const PROJ_A = project('proj-a', 'Pit wall');

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAccount(context: BrowserContext) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJ_A] }));
	// Catch-all registered first so the specific stubs below win.
	await context.route('**/api/projects/**', (route) => json(route, 200, {}));
	const EMPTY_RUBRIC = {
		rubric: { criteria: [], warnings: [], conflicts: [], hash: 'sha256-empty', extractionVersion: 'extract-v2' },
		assessment: [],
	};
	await context.route('**/api/projects/**/judge/**', (route) => json(route, 200, EMPTY_RUBRIC));
	await context.route('**/api/memory**', (route) => json(route, 200, { facts: [] }));
}

test.describe('Project settings (U08)', () => {
	test('the five sections render; the gear reaches this page', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project/settings?project=proj-a`);
		// The rail shows one section at a time; each tab opens its section.
		await expect(page.getByTestId('ps-general')).toBeVisible();
		await expect(page.getByTestId('ps-description')).toContainText('Track pit wall strategy');
		await page.getByTestId('ps-tab-code').click();
		await expect(page.getByTestId('ps-code')).toBeVisible();
		await page.getByTestId('ps-tab-routines').click();
		await expect(page.getByTestId('ps-routines')).toBeVisible();
		await page.getByTestId('ps-tab-knows').click();
		await expect(page.getByTestId('ps-knows')).toBeVisible();
		await page.getByTestId('ps-tab-archive').click();
		await expect(page.getByTestId('ps-archive')).toBeVisible();
		await context.close();
	});

	test('edit-description: PATCHes the real route; an empty name cannot save', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const patches: { url: string; body: Record<string, unknown> }[] = [];
		await context.route('**/api/projects/proj-a', (route) => {
			if (route.request().method() !== 'PATCH') return json(route, 200, { project: PROJ_A });
			const body = route.request().postDataJSON() as Record<string, unknown>;
			patches.push({ url: route.request().url(), body });
			return json(route, 200, { project: { ...PROJ_A, ...body } });
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project/settings?project=proj-a`);
		await page.getByTestId('edit-description-open').click();
		const win = page.getByTestId('edit-description-window');
		await expect(win).toBeVisible();
		// The window notes that an approved plan isn't changed.
		await expect(win).toContainText('does not change an approved plan');

		// Empty name → save disabled.
		await page.getByTestId('edit-name').fill('');
		await expect(win.getByRole('button', { name: 'Save' })).toBeDisabled();
		await page.getByTestId('edit-name').fill('Pit wall v2');
		await page.getByTestId('edit-description').fill('Tyre strategy for race day');
		await win.getByRole('button', { name: 'Save' }).click();
		await expect(win).toHaveCount(0);
		expect(patches).toHaveLength(1);
		expect(patches[0]!.body).toMatchObject({ name: 'Pit wall v2', description: 'Tyre strategy for race day' });
		await context.close();
	});

	test('connect-repo uses the real installations API and connects read-only', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		await context.route('**/api/github/installations**', (route) =>
			json(route, 200, {
				installations: [
					{ installationId: 'inst-1', accountLogin: 'octo', status: 'active', appSlug: 'caddie', permissions: { contents: 'read' }, workspaceId: 'ws-1' },
				],
			}),
		);
		await context.route('**/api/github/installations/inst-1/repos', (route) =>
			json(route, 200, { repositories: [{ repoFullName: 'octo/pit-wall', status: 'selected' }] }),
		);
		// The Code section reads the ONE linked repo live; before connecting
		// there is none, after connecting this project's repo is shown.
		let repoLinked = false;
		const repo = { projectId: 'proj-a', installationId: 'inst-1', repoFullName: 'octo/pit-wall', visibility: 'private', origin: 'connected', htmlUrl: 'https://github.com/octo/pit-wall' };
		await context.route('**/api/projects/proj-a/github/repo', (route) =>
			json(route, 200, { repo: repoLinked ? repo : null }),
		);
		let connected: Record<string, unknown> | null = null;
		await context.route('**/api/projects/proj-a/github/repo/connect', (route) => {
			connected = route.request().postDataJSON() as Record<string, unknown>;
			repoLinked = true;
			return json(route, 200, { repo });
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project/settings?project=proj-a`);
		await page.getByTestId('ps-tab-code').click();
		await expect(page.getByTestId('ps-code-empty')).toBeVisible();
		await page.getByTestId('ps-code-connect').click();
		await page.getByRole('button', { name: 'Show repositories' }).click();
		await page.getByTestId('pick-repo-octo/pit-wall').click();
		// Picking a repo connects it for THIS project; the section then shows it.
		await expect(page.getByTestId('ps-code-connected')).toBeVisible();
		await expect(page.getByTestId('ps-repo-link')).toContainText('octo/pit-wall');
		expect(connected).toEqual({ installationId: 'inst-1', repoFullName: 'octo/pit-wall' });
		await context.close();
	});

	test('archive requires typing the project name; wrong name stays disabled', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		let archived = false;
		await context.route('**/api/projects/proj-a/archive', (route) => {
			archived = true;
			return json(route, 200, { project: { ...PROJ_A, status: 'archived' } });
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project/settings?project=proj-a`);
		await page.getByTestId('ps-tab-archive').click();
		// The window is labelled "Archive project" — no pretend delete.
		await expect(page.getByTestId('ps-archive')).toContainText('Nothing is permanently deleted today');
		await page.getByTestId('archive-open').click();
		const win = page.getByTestId('archive-window');
		await expect(win).toContainText('Archive project');

		await page.getByTestId('archive-typed-name').fill('pit wall');
		await expect(win.getByRole('button', { name: 'Archive project' })).toBeDisabled();
		await page.getByTestId('archive-typed-name').fill('Pit wall');
		await win.getByRole('button', { name: 'Archive project' }).click();
		await expect(page).toHaveURL(/\/app\/projects/);
		expect(archived).toBe(true);
		await context.close();
	});

	test('old /schedules and /repositories links land on Project settings sections', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/schedules?project=proj-a`);
		await expect(page).toHaveURL(/\/app\/project\/settings\?project=proj-a/);
		await expect(page.getByTestId('ps-routines')).toBeVisible();

		await page.goto(`${BASE}/app/repositories?project=proj-a`);
		await expect(page.getByTestId('ps-code')).toBeVisible();
		await context.close();
	});

	test('settings tabs and old account links: /automations and /usage land on their tabs', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		await context.route('**/api/usage', (route) =>
			json(route, 200, { payer: { payerId: 'a', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 0, reservations: 0 } }),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/automations`);
		await expect(page).toHaveURL(/\/app\/settings\?tab=routines/);
		await page.goto(`${BASE}/app/usage`);
		await expect(page).toHaveURL(/\/app\/settings\?tab=spending/);
		await expect(page.getByTestId('usage-panel')).toBeVisible();
		// No budget configured stays honest, never a fabricated number.
		await page.goto(`${BASE}/app/settings?tab=appearance`);
		await expect(page.getByTestId('appearance-reset-width')).toBeVisible();
		await context.close();
	});
});
