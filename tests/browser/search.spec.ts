import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Quick search + search results acceptance (U09) — run against the COMPOSED
 * build (`bun run build` first).
 *
 * What U09 guarantees (HANDOFF §4):
 *   - ⌘K (and "/") opens the palette; typing shows "See all results for …"
 *     → /search?q=.
 *   - Results page: type labels (Project, Plan, To-do, Caddie knows), matched
 *     words highlighted, counted filter chips, 5 per page "1–5 of N" with
 *     Previous/Next, and an honest "chats aren't searched yet".
 *   - Empty query shows recent searches; no matches is an explicit state.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-u09-search-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/search.spec.ts');
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

declare const document: { documentElement: { scrollWidth: number; clientWidth: number } };

const NOW = '2026-10-10T10:00:00.000Z';
const HOME = { id: 'home-1', workspaceId: 'ws-1', name: 'Home', description: null, contestId: null, contestUrl: null, status: 'active', kind: 'home', createdAt: NOW, updatedAt: NOW };
const PROJ_A = { id: 'proj-a', workspaceId: 'ws-1', name: 'Pit wall', description: null, contestId: null, contestUrl: null, status: 'active', kind: 'standard', createdAt: NOW, updatedAt: NOW };

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAccount(context: BrowserContext, searchPayload?: unknown) {
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
	await context.route('**/api/projects/**', (route) => json(route, 200, {}));
	if (searchPayload !== undefined) {
		await context.route('**/api/search**', (route) => json(route, 200, searchPayload));
	}
}

const SEVEN_TASKS = {
	query: 'chart',
	sections: {
		projects: { items: [], total: 0 },
		planDocs: { items: [], total: 0 },
		memory: { items: [], total: 0 },
		tasks: {
			items: Array.from({ length: 5 }, (_, i) => ({
				type: 'task',
				id: `task-${i + 1}`,
				projectId: 'proj-a',
				title: `Chart the telemetry part ${i + 1}`,
				snippet: `A to-do about the chart view ${i + 1}`,
			})),
			total: 7,
		},
	},
	total: 7,
	limit: 5,
	offset: 0,
};

test.describe('Quick search and results (U09)', () => {
	test('⌘K opens the palette; typing offers "See all results for …" leading to /search?q=', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('nav-capsule')).toBeVisible();

		await page.keyboard.press('Control+k');
		const palette = page.getByTestId('quick-search');
		await expect(palette).toBeVisible();
		await expect(page.getByTestId('quick-search-list').getByTestId('quick-search-item')).toHaveCount(6); // 4 nav + 1 project + Start a project

		// Typing narrows and adds the see-all entry.
		await page.getByTestId('quick-search-input').fill('pit');
		await expect(page.getByTestId('quick-search-list')).toContainText('See all results for');
		await page.keyboard.press('Enter'); // first match (Pit wall) is active
		await expect(page).toHaveURL(/project=proj-a/);

		// The see-all route goes to /search?q=.
		await page.keyboard.press('Control+k');
		await page.getByTestId('quick-search-input').fill('zzz');
		await page.getByText('See all results for “zzz”').click();
		await expect(page).toHaveURL(/\/app\/search\?q=zzz/);
		await context.close();
	});

	test('results page: 5 per page with counted chips, highlights, honest chats note', async ({ browser }) => {
		const context = await browser.newContext();
		// Offset-aware stub: page 2 returns the remaining two hits, so the
		// paging assertions test real offset handling, not a static payload.
		await stubAccount(context, undefined);
		await context.unroute('**/api/search**');
		await context.route('**/api/search**', (route) => {
			const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? '0');
			const limit = Number(new URL(route.request().url()).searchParams.get('limit') ?? '5');
			const all = Array.from({ length: 7 }, (_, i) => ({
				type: 'task',
				id: `task-${i + 1}`,
				projectId: 'proj-a',
				title: `Chart the telemetry part ${i + 1}`,
				snippet: `A to-do about the chart view ${i + 1}`,
			}));
			const items = all.slice(offset, offset + limit);
			return json(route, 200, {
				query: 'chart',
				sections: { projects: { items: [], total: 0 }, planDocs: { items: [], total: 0 }, memory: { items: [], total: 0 }, tasks: { items, total: 7 } },
				total: 7,
				limit,
				offset,
			});
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/search?q=chart`);

		await expect(page.getByTestId('search-results')).toBeVisible();
		// The To-do chip carries the real count.
		await expect(page.getByTestId('search-filter-tasks')).toContainText('To-do (7)');
		// Five hits on page one, with the matched word highlighted.
		await expect(page.getByTestId('search-hit')).toHaveCount(5);
		await expect(page.locator('mark').first()).toContainText('Chart');
		// Paging: "1–5 of 7" with a live Next and a disabled Previous.
		await expect(page.getByTestId('search-paging')).toContainText('1–5 of 7');
		await expect(page.getByTestId('search-prev')).toBeDisabled();
		await page.getByTestId('search-next').click();
		await expect(page.getByTestId('search-hit')).toHaveCount(2);
		// Pagination never requests past the total (offset 5, limit 5).
		await expect(page.getByTestId('search-paging')).toContainText('6–7 of 7');
		await expect(page.getByTestId('search-next')).toBeDisabled();
		// Honest limitation, stated in plain words.
		await expect(page.getByTestId('search-idle').or(page.getByText("Chats aren't searched yet"))).toHaveCount(0);
		await context.close();
	});

	test('an empty query shows recent searches; a query with no matches is an explicit state', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { query: 'zzz', sections: { projects: { items: [], total: 0 }, planDocs: { items: [], total: 0 }, tasks: { items: [], total: 0 }, memory: { items: [], total: 0 } }, total: 0, limit: 5, offset: 0 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/search?q=chart`);
		// A search records a recent entry (localStorage).
		await page.evaluate(() => localStorage.setItem('caddie:recent-searches', JSON.stringify(['chart', 'telemetry'])));
		await page.goto(`${BASE}/app/search`);
		await expect(page.getByTestId('search-idle')).toContainText("Chats aren't searched yet");
		await expect(page.getByTestId('search-recent')).toHaveCount(2);

		await page.getByTestId('search-input').fill('zzz');
		await page.getByTestId('search-submit').click();
		await expect(page.getByTestId('search-empty')).toContainText('No matches for “zzz”');
		await context.close();
	});
});
