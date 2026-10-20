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
 *   - A card per project: name, what it's for, an evidence-backed status, readable purpose, and an actionable continuation. Archived folded.
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
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
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
	test('cards show purpose, an evidence-backed status, and clear next actions', async ({ browser }) => {
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
        await expect(page.getByTestId('welcome-panel')).toBeVisible();
        await expect(page.getByText('Say hello — your first message starts a run')).toHaveCount(0);

		const row = page.getByTestId('project-row-proj-a');
		await expect(row).toContainText('Pit wall');
		await expect(row).toContainText('Track pit wall strategy');
		// A pending decision is explicit rather than an inferred percentage.
		await expect(row.getByTestId('project-step-text-proj-a')).toContainText('Decision needed');
        await expect(row.getByTestId('project-next-proj-a')).toBeVisible();
        await expect(row.getByTestId('project-continue-proj-a')).toBeVisible();

		// One line of what Caddie is doing: the newest card's summary.
		await expect(row).toContainText('The drafted plan waits for your decision.');
        await page.screenshot({ path: '/tmp/caddie-projects-desktop.png' });

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
		// No progress bars invent a completion state.
		const tones = await row.locator('.steps-mini i[data-tone]').count();
		expect(tones).toBe(0);
		await context.close();
	});

	test("a judge's example with no workflow yet reads Ready to try, not No updates yet (S07b)", async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		// Registered after stubAccount's catch-all on purpose: Playwright runs
		// the last-registered matching route first.
		await context.route('**/api/projects/proj-a/experience', (route) =>
			json(route, 200, { projectId: 'proj-a', version: 0, stage: 'planning', plan: null, preview: null, message: 'Nothing planned yet.', actions: [] }),
		);
		await context.route('**/api/projects/proj-a/workflow', (route) =>
			json(route, 200, {
				workflow: null,
				importPreview: { status: 'ready', versionSeq: 1, origin: 'example', repoFullName: 'Farm Log', outputId: 'output-example', hasServer: false, message: null },
			}),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);
		const row = page.getByTestId('project-row-proj-a');
		await expect(row.getByTestId('project-step-text-proj-a')).toHaveText('Ready to try');
		await expect(row).toContainText('An example app Caddie built. Try it, then tell Caddie what to change.');
		await expect(row.getByRole('button', { name: 'Try app' })).toBeVisible();
		await context.close();
	});

    test('New project opens idea capture in Chat instead of returning to onboarding', async ({ browser }) => {
        const context = await browser.newContext();
        await stubAccount(context);
        const page = await context.newPage();
        await page.goto(`${BASE}/app/projects`);
        await page.getByTestId('new-idea-project').click();
        await expect(page.getByTestId('project-start-panel')).toContainText('What would you like to build?');
        await expect(page.getByTestId('composer-input')).toBeVisible();
        await expect(page).not.toHaveURL(/onboarding/);
        await context.close();
    });

    test('Continue keeps the project conversation visible on mobile and avoids horizontal overflow', async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await stubAccount(context);
        const page = await context.newPage();
        await page.goto(`${BASE}/app/projects`);
        await expect(page.getByTestId('project-continue-proj-a')).toBeVisible();
        const widths = await page.evaluate(() => {
            const view = globalThis as unknown as { document: { documentElement: { scrollWidth: number } }; innerWidth: number };
            return { content: view.document.documentElement.scrollWidth, viewport: view.innerWidth };
        });
        expect(widths.content).toBeLessThanOrEqual(widths.viewport);
        await page.screenshot({ path: '/tmp/caddie-projects-mobile.png' });
        await page.getByTestId('project-continue-proj-a').click();
        await expect(page).toHaveURL(/project=proj-a.*pane=channel/);
        await expect(page.getByTestId('composer-input')).toBeVisible();
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
		let imported: Record<string, unknown> | null = null;
		await context.route('**/api/projects/proj-imported/github/imports', (route) => {
			imported = route.request().postDataJSON() as Record<string, unknown>;
			return json(route, 201, { import: { id: 'imp-1' }, start: { ok: true, repoFullName: 'octo-org/pit-wall', version: { commitId: 'c1', seq: 1, fileCount: 24 } } });
		});
		await page.getByTestId('import-repo-confirm').click();
		await expect(page).toHaveURL(/project=proj-imported/);
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ name: 'pit-wall' });
		expect(imported).toMatchObject({ installationId: 'inst-1', repoFullName: 'octo-org/pit-wall', start: true });
		await context.close();
	});

	test('a repo Caddie cannot build on is explained before opening the new project', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		await context.route('**/api/github/installations**', (route) =>
			json(route, 200, { installations: [{ installationId: 'inst-1', accountLogin: 'octo-org', status: 'active', appSlug: 'caddie', permissions: { contents: 'read' }, workspaceId: 'ws-1' }] }),
		);
		await context.route('**/api/github/installations/inst-1/repos', (route) => json(route, 200, { repositories: [{ repoFullName: 'octo-org/vite-site', status: 'selected' }] }));
		await context.route('**/api/workspaces', (route) => json(route, 201, { workspace: { id: 'ws-1', name: 'Home', createdAt: NOW } }));
		await context.unroute('**/api/projects');
		await context.route('**/api/projects', (route) =>
			route.request().method() !== 'POST' ? json(route, 200, { projects: [HOME, PROJ_A] }) : json(route, 201, { project: project('proj-vite', 'vite-site', 'standard') }),
		);
		await context.route('**/api/projects/proj-vite/github/imports', (route) =>
			json(route, 201, {
				import: { id: 'imp-2' },
				start: { ok: false, reason: 'not_caddie_app', message: "Caddie can continue apps that were made with Caddie and saved to GitHub. This repo was made another way, so Caddie can't build on it yet." },
			}),
		);
		const page = await context.newPage();
		if (process.env.CADDIE_SHOTS_MOBILE) await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${BASE}/app/projects`);
		await page.getByTestId('import-repo-project').click();
		const win = page.getByTestId('import-repo-window');
		await win.getByRole('button', { name: 'Show repositories' }).click();
		await win.getByTestId('pick-repo-octo-org/vite-site').click();
		await expect(win).toContainText('copies the app’s code into a new project and builds on it');
		await page.getByTestId('import-repo-confirm').click();
		const notice = win.getByTestId('import-repo-notice');
		await expect(notice).toContainText('Caddie will start a new app instead.');
		await expect(notice).toContainText('made with Caddie and saved to GitHub');
		await expect(page).not.toHaveURL(/project=proj-vite/);
		const dir = process.env.CADDIE_SHOTS;
		if (dir) await win.screenshot({ path: `${dir}/import-${process.env.CADDIE_SHOTS_MOBILE ? 'mobile-' : ''}refused.png` });
		await notice.getByTestId('import-repo-open').click();
		await expect(page).toHaveURL(/project=proj-vite/);
		await context.close();
	});
});

test.describe('the project card shows the app, its steps and its hackathon (plan 5.7)', () => {
	// The owner chose variants B + C (2026-10-20): the app's picture (its letter
	// tile until real screenshots exist), the four steps, and the hackathon with
	// its deadline.
	const PROJ_C = project('proj-c', 'Notes', 'standard', { description: 'Quick notes for the farm' });
	const building = (projectId: string) => ({
		projectId, version: 1_760_090_000_000, stage: 'building',
		plan: { id: 'pdr-1', revision: '1', approved: true }, preview: null,
		message: 'Caddie is building your app.', actions: [],
	});

	test('a building project for a hackathon: letter tile, contest and days left, and where it is in four steps', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await stubAccount(context);
		await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJ_A, PROJ_C] }));
		await context.route('**/api/projects/proj-a/experience', (route) => json(route, 200, building('proj-a')));
		await context.route('**/api/projects/proj-c/experience', (route) => json(route, 200, building('proj-c')));
		await context.route('**/api/project-hackathons', (route) =>
			json(route, 200, { hackathons: { 'proj-a': { title: 'Nebius x NVIDIA Global AI Hackathon', deadline: '2026-10-29', daysLeft: 4, ended: false } } }),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);

		const row = page.getByTestId('project-row-proj-a');
		const tile = row.getByTestId('project-tile-proj-a');
		await expect(tile).toHaveText('P');
		// The same colour the published app's home-screen icon gets for this project.
		const { iconColor } = await import('../../packages/contracts/src/app-icon.ts');
		const hex = iconColor('proj-a');
		const rgb = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
		await expect(tile).toHaveCSS('background-color', rgb);
		await expect(row.getByTestId('project-contest-proj-a')).toHaveText('Nebius x NVIDIA Global AI Hackathon · Due in 4 days');
		const steps = row.getByTestId('project-journey-proj-a').locator('li');
		await expect(steps).toHaveCount(4);
		expect(await steps.evaluateAll((items) => items.map((li) => `${li.querySelector('.project-journey-label')?.textContent}:${li.getAttribute('data-state')}`))).toEqual([
			'Plan:done', 'Build:now', 'Check:todo', 'Submit:todo',
		]);
		await expect(steps.nth(1)).toHaveAttribute('aria-current', 'step');

		// A personal project: no hackathon line, and its last step is Share.
		const notes = page.getByTestId('project-row-proj-c');
		await expect(notes.getByTestId('project-tile-proj-c')).toHaveText('N');
		await expect(notes.getByTestId('project-contest-proj-c')).toHaveCount(0);
		await expect(notes.getByTestId('project-journey-proj-c').locator('.project-journey-label').last()).toHaveText('Share');
		if (process.env.CARD_SHOTS) await page.getByTestId('project-list').screenshot({ path: `${process.env.CARD_SHOTS}/project-card-desktop.png` });
		await context.close();
	});

	test('on a phone the card keeps the tile, the contest line and the four steps', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(context);
		await context.route('**/api/projects/proj-a/experience', (route) => json(route, 200, building('proj-a')));
		await context.route('**/api/project-hackathons', (route) =>
			json(route, 200, { hackathons: { 'proj-a': { title: 'Nebius x NVIDIA Global AI Hackathon', deadline: '2026-10-29', daysLeft: 0, ended: false } } }),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/projects`);

		const row = page.getByTestId('project-row-proj-a');
		await expect(row.getByTestId('project-tile-proj-a')).toBeVisible();
		await expect(row.getByTestId('project-contest-proj-a')).toHaveText('Nebius x NVIDIA Global AI Hackathon · Due today');
		await expect(row.getByTestId('project-journey-proj-a').locator('li')).toHaveCount(4);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBe(0);
		if (process.env.CARD_SHOTS) await row.screenshot({ path: `${process.env.CARD_SHOTS}/project-card-phone.png` });
		await context.close();
	});
});
