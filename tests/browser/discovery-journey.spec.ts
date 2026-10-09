import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Discovery-first ACCEPTANCE JOURNEY — one signed-in account walked end-to-end
 * through the redesigned loop, against the COMPOSED build (`bun run build`
 * first; local workerd on 127.0.0.1:4173, SPA under /app). Where workspace.spec
 * and discovery.spec prove each guarantee in isolation, this spec proves the
 * GUARANTEES HOLD TOGETHER along a single coherent path — the acceptance
 * scenarios A–G of the redesign, chained without a reset between steps.
 *
 *   A. Home is the actionable brief (never an empty data pane) and the
 *      conversation opens on the safe GENERAL (account) scope.
 *   B. Discover is a first-class capsule destination reachable with ZERO build
 *      projects; each opportunity offers Explore ideas (primary) + Save
 *      (secondary), a named feed gap, and never a bare "Accept".
 *   C. Saving an opportunity never creates a build project (POST /projects = 0).
 *   D. Exploring ideas commits to exactly ONE resumable project carrying the
 *      contest link, and the conversation RETARGETS to that project by name.
 *   E. The project surface keeps the THREE global destinations and adds only
 *      project-local tabs — no global Chat/Build/Ship tab reappears.
 *   F. The committed build shows in Projects; the Home account scope never does.
 *   G. The composer drafts are scoped to the project, and an invalid ?project=
 *      is a MISSING project — never a silent fallback to another one.
 *
 * UI-state proof (route-interception stubs mirroring the real P02/P11 REST
 * shapes), NOT live data or auth evidence — the same classification the sibling
 * specs use. The one live, un-stubbed probe is the fail-closed /api/auth/status.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-journey-preview-${process.pid}.log`;

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

test.beforeAll(async () => {
	if (!existsSync(WORKER_BUNDLE)) {
		throw new Error('Composed build missing — run `bun run build` before tests/browser/discovery-journey.spec.ts');
	}
	if (!(await isListening(PORT))) {
		preview = spawn(
			'/bin/bash',
			['-c', `exec bunx vite preview --port ${PORT} --host 127.0.0.1 > '${LOG}' 2>&1`],
			{ cwd: APP_DIR, stdio: 'ignore', detached: true },
		);
		preview.unref();
		weStartedTheServer = true;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !(await isListening(PORT))) await sleep(300);
		if (!(await isListening(PORT))) {
			const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '(no log)';
			throw new Error(`preview not ready\nlog:\n${log}`);
		}
	}
});

test.afterAll(async () => {
	if (!weStartedTheServer) return;
	for (const signal of ['-TERM', '-KILL']) {
		if (!(await isListening(PORT))) return;
		try {
			execFileSync('pkill', [signal, '-f', `vite preview --port ${PORT}`], { stdio: 'ignore' });
		} catch {
			// nothing matched — fine
		}
		await sleep(500);
	}
});

// --- fixtures (real P02/P11 payload shapes) -------------------------------------

const NOW = '2026-10-04T10:00:00.000Z';
const CAND_1_URL = 'https://contest.example/solar-hackweek';

function project(id: string, name: string, kind: 'standard' | 'home' = 'standard', contestUrl: string | null = null) {
	return {
		id,
		workspaceId: 'ws-1',
		name,
		description: null,
		contestId: null,
		contestUrl,
		status: 'active',
		kind,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

const HOME = project('home-1', 'Home', 'home');

function candidatesEvaluated(acceptedIds: string[]) {
	const mk = (id: string, title: string, url: string, verdict: 'eligible' | 'ineligible') => ({
		candidate: {
			id,
			url,
			title,
			summary: `${title} — a contest Caddie read from a watched source.`,
			source: 'local-seed',
			status: acceptedIds.includes(id) ? 'accepted' : 'new',
			firstSeenAt: NOW,
		},
		fit: { matchedRequirements: verdict === 'eligible' ? 2 : 1, claims: [] },
		eligibility: {
			verdict,
			rules: [{ claimType: 'region', verdict: verdict === 'eligible' ? 'pass' : 'fail', basis: 'cl-1', reason: 'Quoted rule on record.' }],
		},
	});
	return {
		evaluations: [
			mk('cand-1', 'Solar Hackweek', CAND_1_URL, 'eligible'),
			mk('cand-2', 'Employees-only sprint', 'https://contest.example/employees-only', 'ineligible'),
		],
		ranked: [
			{ candidateId: 'cand-1', matchedRequirements: 2, verdict: 'eligible' },
			{ candidateId: 'cand-2', matchedRequirements: 1, verdict: 'ineligible' },
		],
		profileCountry: 'US',
	};
}

function json(route: Route, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * A signed-in account whose project list is DYNAMIC: Explore commits a real
 * project that then appears in every subsequent read, so the journey walks a
 * single coherent state — Home (general scope) → Discover → commit → project →
 * Projects — without a reset between steps. The run transport refuses sends so
 * composer drafts stay optimistically visible (the transport is not under test).
 */
async function stubJourneyAccount(context: BrowserContext): Promise<{ created: Record<string, unknown>[] }> {
	const created: Record<string, unknown>[] = [];
	const projects: Record<string, unknown>[] = [HOME];
	const acceptedIds: string[] = [];

	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Test', email: 't@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));

	await context.route('**/api/workspaces', (route) =>
		json(route, 201, { workspace: { id: 'ws-1', name: 'Home', createdAt: NOW } }),
	);

	await context.route('**/api/projects', (route) => {
		if (route.request().method() === 'GET') return json(route, 200, { projects });
		const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
		created.push(body);
		const made = project('proj-committed', String(body.name ?? 'New project'), 'standard', (body.contestUrl as string) ?? null);
		projects.push(made); // now it exists in every read (list, gate, conversation)
		return json(route, 201, { project: made });
	});

	// Every project child reads honest empties. Registered BEFORE the specific
	// discovery + runs handlers below, because Playwright matches the
	// most-recently-registered route first — the specific paths must win.
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
		if (path.endsWith('/artifact-revisions')) return json(route, 200, { artifacts: [], latest: null });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
		return json(route, 200, {});
	});

	// Account-scoped (Home) discovery namespace — the surface Discover reads.
	await context.route('**/api/projects/home-1/discovery/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/feed')) return json(route, 200, { runs: [{ id: 'feed-1', requestedAt: NOW, sources: [{ source: 'local-seed', outcome: 'succeeded', failureReason: null, candidateCount: 2 }, { source: 'devpost', outcome: 'failed', failureReason: 'upstream returned 503 (recorded receipt)', candidateCount: 0 }] }] });
		if (/\/candidates\/[^/]+\/accept$/.test(path)) {
			const id = path.split('/')[6] ?? '';
			if (!acceptedIds.includes(id)) acceptedIds.push(id);
			return json(route, 200, { candidate: { id, url: '', title: '', summary: '', source: 'local-seed', status: 'accepted', firstSeenAt: NOW } });
		}
		if (path.endsWith('/candidates')) return json(route, 200, candidatesEvaluated(acceptedIds));
		return json(route, 404, { error: 'not_found' });
	});

	// Registered last so it overrides the generic child handler: a send to the
	// committed project refuses, keeping the optimistic draft visible.
	await context.route('**/api/projects/proj-committed/runs', (route) =>
		json(route, 503, { error: 'run_transport_unavailable', message: 'refused in this journey spec' }),
	);

	return { created };
}

// --- the journey ------------------------------------------------------------------

test.describe('discovery-first acceptance journey (composed build, one account, A–G)', () => {
	test('Home → Discover → Save (no build) → Explore (commits one) → project → Projects → scoped composer, in one path', async ({ browser }) => {
		const context = await browser.newContext();
		const { created } = await stubJourneyAccount(context);
		const page = await context.newPage();

		// ---- A. Home is the actionable brief on the GENERAL scope -----------------
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('home-screen')).toBeVisible();
		await expect(page.getByTestId('home-primary')).toBeVisible();
		await expect(page.getByTestId('home-find-hackathon')).toBeVisible();
		await expect(page.getByTestId('home-start-idea')).toBeVisible();
		await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');
		await expect(page.getByTestId('conv-context-label')).toContainText('General');
		// Exactly three global destinations; no global chat/build/ship tab.
		await expect(page.getByTestId('nav-home')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId('nav-discover')).toBeVisible();
		await expect(page.getByTestId('nav-projects')).toBeVisible();
		await expect(page.getByTestId('nav-chat')).toHaveCount(0);
		await expect(page.getByTestId('nav-build')).toHaveCount(0);

		// ---- B. Discover is first-class with ZERO build projects ------------------
		await page.getByTestId('nav-discover').click();
		await expect(page).toHaveURL(/\/app\/discover$/);
		await expect(page.getByTestId('discovery-results')).toBeVisible();
		await expect(page.getByTestId('explore-ideas-cand-1')).toBeVisible();
		await expect(page.getByTestId('save-candidate-cand-1')).toBeVisible();
		await expect(page.getByTestId('feed-gaps')).toContainText('devpost failed');
		await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);

		// ---- C. Saving an opportunity never creates a build -----------------------
		await page.getByTestId('save-candidate-cand-2').click();
		await expect(page.getByTestId('discovery-results')).toContainText('status accepted');
		expect(created).toHaveLength(0); // no POST /api/projects from a save

		// ---- D. Explore commits exactly one project + retargets the conversation --
		await page.getByTestId('explore-ideas-cand-1').click();
		await expect(page.getByTestId('explore-commit')).toBeVisible();
		await page.getByTestId('explore-commit-create').click();
		await expect(page).toHaveURL(/\/app\/project\?project=proj-committed$/);
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ name: 'Solar Hackweek', contestUrl: CAND_1_URL });
		await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'project', { timeout: 10_000 });
		await expect(page.getByTestId('conv-context-label')).toContainText('Solar Hackweek');

		// ---- E. Project keeps the three globals + only local tabs -----------------
		await expect(page.getByTestId('project-tabs')).toBeVisible();
		await expect(page.getByTestId('project-tab-overview')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId('project-tab-build')).toBeVisible();
		await expect(page.getByTestId('project-tab-submission')).toBeVisible();
		await expect(page.getByTestId('nav-home')).toBeVisible();
		await expect(page.getByTestId('nav-discover')).toBeVisible();
		await expect(page.getByTestId('nav-projects')).toBeVisible();
		await expect(page.getByTestId('nav-build')).toHaveCount(0); // still no global Build tab

		// ---- F. The committed build shows in Projects; Home never does ------------
		await page.getByTestId('nav-projects').click();
		await expect(page).toHaveURL(/\/app\/projects(\?|$)/);
		await expect(page.getByTestId('project-list')).toBeVisible();
		await expect(page.getByTestId('project-row-proj-committed')).toBeVisible();
		await expect(page.getByTestId('project-row-home-1')).toHaveCount(0);

		// ---- G. Composer drafts scope to the project; a bad id is MISSING ---------
		await page.getByTestId('project-row-proj-committed').getByRole('button').click();
		await expect(page).toHaveURL(/\/app\/project\?project=proj-committed$/);
		await page.getByTestId('composer-input').fill('Draft a plan for Solar Hackweek');
		await page.getByTestId('composer-send').click();
		await expect(page.getByTestId('draft-row')).toContainText('Draft a plan for Solar Hackweek');

		await page.goto(`${BASE}/app/project?project=does-not-exist`);
		await expect(page.getByText('That project is not in your list')).toBeVisible();
		await expect(page.getByTestId('project-header')).toHaveCount(0);
		await expect(page.getByText('Solar Hackweek')).toHaveCount(0); // no silent fallback

		await context.close();
	});
});
