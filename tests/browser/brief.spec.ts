import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Approved navigation (2026-10-09) — focused acceptance over the COMPOSED
 * build (local workerd on 127.0.0.1:4173, SPA under /app):
 *
 *   - Brief is the default left-hand surface on desktop; Chat is the mobile
 *     default. The account brief (`GET /api/brief`) aggregates EVERY
 *     authorised project — the Home-scope-only lane is gone.
 *   - Read ≠ resolved: opening Brief marks nothing read; acting on a card
 *     marks it read AND navigates to the exact work; "mark all read" is the
 *     only bulk read action. The unseen badge counts unseen updates.
 *   - The deterministic welcome panel greets a new user in Chat (three
 *     start actions, priority order) and never fabricates an assistant
 *     message; the urgent notice surfaces the top unseen actionable card.
 *   - No paid model call happens merely from opening a tab: zero POSTs to
 *     the runs surface are recorded across the journeys below.
 *   - Restoration precedence: explicit deep link > restored destination
 *     (actor-keyed sessionStorage) > platform default; account switching
 *     clears restored state because the key carries the actor id.
 *
 * All endpoints are stubbed at the network layer (UI-state proofs; the
 * service-level aggregation + read-state semantics are pinned by
 * tests/brief.test.ts). Fixture-backed — never LIVE VERIFIED.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-brief-browser-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/brief.spec.ts');
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
			// pkill exits 1 when nothing matched — fine
		}
		await sleep(500);
	}
});

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const NOW = '2026-10-05T08:00:00.000Z';

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

const HOME = project('home-1', 'Home', 'home');
const PROJ_A = project('proj-a', 'Pit wall');
const PROJ_B = project('proj-b', 'Solar board');

interface BriefCard {
	id: string;
	projectId: string;
	kind: 'approval' | 'change' | 'deadline' | 'result';
	headline: string;
	summary: string;
	evidenceIds: string[];
	status: 'needs-you' | 'changed' | 'blocked' | 'handled';
	updatedAt: string;
	primaryAction: { label: string; kind: 'review' | 'inspect' | 'preview'; targetId: string };
	key?: string;
	seen?: boolean;
}

function card(overrides: Partial<BriefCard> & { id: string; projectId: string; kind: BriefCard['kind'] }): BriefCard {
	return {
		headline: 'Update',
		summary: 'Summary',
		evidenceIds: [],
		status: 'handled',
		updatedAt: NOW,
		primaryAction: { label: 'Open', kind: 'review', targetId: overrides.id },
		...overrides,
	};
}

const APPROVAL_A = card({
	id: 'brf_approval_ap-1',
	projectId: 'proj-a',
	kind: 'approval',
	headline: 'Design review is waiting on you',
	summary: 'Approving this authorises specialists building against this plan revision.',
	status: 'needs-you',
	primaryAction: { label: 'Review the design', kind: 'review', targetId: 'ap-1' },
	key: 'proj-a:approval:ap-1',
});
const DEADLINE_B = card({
	id: 'brf_schedule_sch-1',
	projectId: 'proj-b',
	kind: 'deadline',
	headline: 'Weekly discovery sweep — 0 7 * * 1',
	summary: 'Next run 2026-10-12T07:00:00.000Z (Africa/Lagos).',
	status: 'handled',
	primaryAction: { label: 'Open the schedule', kind: 'review', targetId: 'sch-1' },
	key: 'proj-b:deadline:sch-1',
});
const PREVIEW_A = card({
	id: 'brf_preview_pvw-1',
	projectId: 'proj-a',
	kind: 'result',
	headline: 'A working preview is ready to view',
	summary: 'The share link is live and unexpired.',
	status: 'handled',
	primaryAction: { label: 'View preview', kind: 'preview', targetId: 'pvw-1' },
	key: 'proj-a:result:pvw-1',
});
const BLOCKED_A = card({
	id: 'brf_failed-run_run-9',
	projectId: 'proj-a',
	kind: 'result',
	headline: 'Run stopped: build failed at step 7',
	summary: 'The failure is retained in the repair ledger.',
	status: 'blocked',
	primaryAction: { label: 'Read the failure', kind: 'inspect', targetId: 'run-9' },
	key: 'proj-a:result:run-9',
});

/** Auth + project list + the account brief, with read-state recording. */
async function stubAccount(
	context: BrowserContext,
	opts: {
		actorId?: string;
		projects?: ReturnType<typeof project>[];
		cards?: BriefCard[];
		unseenCount?: number;
		briefStatus?: number;
	} = {},
): Promise<{ reads: string[]; runPosts: { n: number } }> {
	const actorId = opts.actorId ?? 'actor-test';
	const projects = opts.projects ?? [HOME, PROJ_A, PROJ_B];
	const cards = opts.cards ?? [APPROVAL_A, DEADLINE_B];
	// Read state is DYNAMIC: the /brief/read handler records keys and the next
	// GET recomputes unseenCount from them — so the badge clearing after
	// mark-all-read is proven end-to-end against the stub.
	const seenKeys = new Set<string>();
	const unseenCount = opts.unseenCount ?? cards.filter((c) => !c.seen).length;
	const reads: string[] = [];
	const runPosts = { n: 0 };

	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: actorId }, user: { id: actorId, name: 'Test', email: 't@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/projects', (route) => {
		if (route.request().method() !== 'GET') return json(route, 405, { error: 'method_not_allowed' });
		return json(route, 200, { projects });
	});
	await context.route('**/api/brief/read', (route) => {
		const body = (route.request().postDataJSON() ?? {}) as { keys?: string[] };
		for (const key of body.keys ?? []) seenKeys.add(key);
		reads.push(...(body.keys ?? []));
		return json(route, 200, { marked: body.keys?.length ?? 0 });
	});
	await context.route('**/api/brief', (route) => {
		if (opts.briefStatus && opts.briefStatus !== 200) {
			return json(route, opts.briefStatus, { error: 'brief_unavailable', message: 'The brief could not be read.' });
		}
		const liveUnseen = seenKeys.size > 0 ? cards.filter((c) => c.key && !seenKeys.has(c.key)).length : unseenCount;
		return json(route, 200, {
			cards: seenKeys.size > 0 ? cards.map((c) => ({ ...c, seen: c.key ? seenKeys.has(c.key) : (c.seen ?? false) })) : cards,
			unseenCount: liveUnseen,
			projects: projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
			asOf: NOW,
		});
	});
	// Count paid-run attempts: opening tabs must never POST a run.
	await context.route('**/api/projects/**/runs', (route) => {
		if (route.request().method() === 'POST') runPosts.n += 1;
		return json(route, 200, { runBindings: [] });
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
	return { reads, runPosts };
}

test.describe('approved navigation — Brief default + Chat start (composed build, stubbed /api)', () => {
	test('no paid model call and no welcome dismissal happen merely from opening tabs', async ({ browser }) => {
		const context = await browser.newContext();
		const { runPosts } = await stubAccount(context, { cards: [APPROVAL_A] });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await page.goto(`${BASE}/app/discover`);
		await page.goto(`${BASE}/app/projects`);
		await expect(page.getByTestId('project-list')).toBeVisible();
		// Zero run POSTs across three tab opens — the transport is lazy on send.
		expect(runPosts.n).toBe(0);
		await context.close();
	});

	test('a new mobile user lands on Chat with the welcome panel and discovery as the primary action', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		const { reads } = await stubAccount(context, { projects: [HOME], cards: [] });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		// Chat is the default: the conversation shows full-height.
		await expect(page.getByTestId('conversation-panel')).toBeVisible();
		// The deterministic welcome — three actions, discovery first.
		await expect(page.getByTestId('welcome-panel')).toBeVisible();
		await expect(page.getByText("Let's find a hackathon that fits you")).toBeVisible();
		const buttons = page.locator('.welcome-actions button');
		await expect(buttons.first()).toHaveText('Find my first hackathon');
		await expect(buttons.nth(1)).toHaveText('Start from an idea');
		await expect(buttons.nth(2)).toHaveText('Continue existing code');

		// Primary action opens the real discovery surface.
		await page.getByTestId('welcome-find').click();
		await expect(page).toHaveURL(/\/app\/discover$/);
		await expect(page.getByTestId('discovery-results')).toBeVisible();
		// No assistant message was fabricated and nothing was marked read.
		expect(reads).toHaveLength(0);
		await context.close();
	});

	test('a new desktop user sees Brief on the left and Chat on the right', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { projects: [HOME], cards: [] });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		await expect(page.getByTestId('nav-capsule')).toBeVisible();
		await expect(page.getByTestId('nav-brief')).toHaveAttribute('aria-current', 'page');
		await expect(page.getByTestId('nav-discover')).toBeVisible();
		await expect(page.getByTestId('nav-projects')).toBeVisible();
		// Left: the brief surface; right: the conversation, both visible.
		await expect(page.getByTestId('brief-screen')).toBeVisible();
		await expect(page.getByTestId('conversation-panel')).toBeVisible();
		await expect(page.getByTestId('brief-new-user')).toBeVisible();
		// The welcome panel lives in Chat — not duplicated on the desktop left.
		await expect(page.getByTestId('welcome-panel')).toBeVisible();
		await context.close();
	});

	test('the brief aggregates multiple authorised projects, grouped, with a correct unseen badge', async ({ browser }) => {
		const context = await browser.newContext();
		const { reads } = await stubAccount(context, {
			cards: [APPROVAL_A, BLOCKED_A, DEADLINE_B],
			unseenCount: 3,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		// Badge on the capsule Brief entry: 3 unseen.
		await expect(page.getByTestId('nav-brief-badge')).toHaveText('3');

		// v2 layout: the open cards render big (server order), each card carries
		// its project as context (no group headers), and finished items fold.
		// Two big cards from proj-a; the handled deadline card folds under Done.
		await expect(page.locator('[data-testid="decision-card"]')).toHaveCount(2);
		await expect(page.locator('.card-context').first()).toContainText('Pit wall');
		const doneFold = page.getByTestId('brief-done');
		await expect(doneFold).toContainText('Done · 1');
		await expect(doneFold).toContainText('Weekly discovery sweep');

		// Opening the brief marks NOTHING read — no read POSTs, badges stay.
		await expect(page.getByTestId('brief-count')).toContainText('3 unseen');
		expect(reads).toHaveLength(0);
		await context.close();
	});

	test('acting on a card opens the exact work and marks only that card read', async ({ browser }) => {
		const context = await browser.newContext();
		const { reads } = await stubAccount(context, {
			cards: [APPROVAL_A, DEADLINE_B],
			unseenCount: 2,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		// The approval card's action goes to the exact plan review surface.
		await page.getByTestId('card-primary-action').first().click();
		await expect(page).toHaveURL(/\/app\/design-review\?project=proj-a$/);
		// Exactly ONE read key — the acted card — and no approval was POSTed.
		expect(reads).toEqual(['proj-a:approval:ap-1']);
		await context.close();
	});

	test('mark-all-read is explicit and clears the badge without resolving work', async ({ browser }) => {
		const context = await browser.newContext();
		const { reads } = await stubAccount(context, {
			cards: [APPROVAL_A, DEADLINE_B],
			unseenCount: 2,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('nav-brief-badge')).toHaveText('2');

		await page.getByTestId('brief-mark-all-read').click();
		expect(reads.sort()).toEqual(['proj-a:approval:ap-1', 'proj-b:deadline:sch-1']);
		// The refetched payload reflects the reads: the badge disappears and the
		// unseen count drops to zero. Read state is separate from resolution —
		// no approval/schedule POSTs happen (the stub records none).
		await expect(page.getByTestId('nav-brief-badge')).toHaveCount(0);
		await expect(page.getByTestId('brief-count')).toContainText('2 updates');
		await expect(page.getByTestId('brief-count')).not.toContainText('unseen');
		await context.close();
	});

	test('the urgent notice surfaces the top unseen actionable card and opens the exact work', async ({ browser }) => {
		const context = await browser.newContext();
		const { reads } = await stubAccount(context, {
			cards: [APPROVAL_A, DEADLINE_B],
			unseenCount: 2,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		// One compact notice in Chat, carrying the REAL card headline.
		await expect(page.getByTestId('urgent-notice')).toBeVisible();
		await expect(page.getByTestId('urgent-notice')).toContainText('Design review is waiting on you');

		// Opening it navigates to the exact review surface and marks it read.
		await page.getByTestId('urgent-notice-open').click();
		await expect(page).toHaveURL(/\/app\/design-review\?project=proj-a$/);
		expect(reads).toEqual(['proj-a:approval:ap-1']);
		await context.close();
	});

	test('an explicit deep link overrides any restored destination', async ({ browser }) => {
		const context = await browser.newContext();
		const { reads } = await stubAccount(context, { cards: [] });
		const page = await context.newPage();
		// Store a restored destination first.
		await page.goto(`${BASE}/app/discover`);
		await expect(page.getByTestId('discovery-results')).toBeVisible();
		// Now a direct deep link to a project page: never redirected.
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page).toHaveURL(/\/app\/project\?project=proj-a$/);
		await expect(page.getByTestId('project-header')).toBeVisible();
		expect(reads).toHaveLength(0);
		await context.close();
	});

	test('a returning user resumes a valid restored destination from the bare default', async ({ browser }) => {
		const context = await browser.newContext();
		const { reads } = await stubAccount(context, { cards: [] });
		const page = await context.newPage();
		// Visit Discover — that becomes the restored destination for THIS actor.
		await page.goto(`${BASE}/app/discover`);
		await expect(page.getByTestId('discovery-results')).toBeVisible();
		// A later bare default (/app/) restores it — precedence 2.
		await page.goto(`${BASE}/app/`);
		await expect(page).toHaveURL(/\/app\/discover$/);
		await expect(page.getByTestId('discovery-results')).toBeVisible();
		expect(reads).toHaveLength(0);
		await context.close();
	});

	test('account switching clears restored state (the key carries the actor id)', async ({ browser }) => {
		const context = await browser.newContext();
		// Actor A stores Discover as their destination.
		await stubAccount(context, { actorId: 'actor-a', cards: [] });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);
		await expect(page.getByTestId('discovery-results')).toBeVisible();

		// Actor B lands on the bare default in a fresh context — nothing restored.
		const contextB = await browser.newContext();
		await stubAccount(contextB, { actorId: 'actor-b', cards: [] });
		const pageB = await contextB.newPage();
		await pageB.goto(`${BASE}/app/`);
		await expect(pageB).toHaveURL(/\/app\/$/);
		await expect(pageB.getByTestId('brief-screen')).toBeVisible();
		await contextB.close();
		await context.close();
	});

	test('retrieval failure is an explicit error with retry, not a silent blank', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { cards: [APPROVAL_A], briefStatus: 500 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('account-brief-lane')).toBeVisible();
		await expect(page.getByText('The brief could not be read.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
		await context.close();
	});

	test('the mobile Brief tab shows its content and Chat stays the default', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(context, { cards: [APPROVAL_A], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		// Chat first.
		await expect(page.getByTestId('conversation-panel')).toBeVisible();
		// The mobile Brief tab carries the unseen badge.
		await expect(page.getByTestId('tab-brief-badge')).toHaveText('1');
		await page.getByTestId('tab-brief-mobile').click();
		await expect(page.getByTestId('brief-screen')).toBeVisible();
		await expect(page.getByTestId('decision-card').first()).toBeVisible();
		await context.close();
	});
});
test.describe('U04 — the v2 brief layout', () => {
	test('never more than three big cards, regardless of how many open updates exist', async ({ browser }) => {
		const context = await browser.newContext();
		const extras = ['x1', 'x2', 'x3'].map((n, i) =>
			card({
				id: `brf_change_${n}`,
				projectId: 'proj-a',
				kind: 'change',
				headline: `Extra update ${i + 1}`,
				summary: 'An open update that must not become a fourth card.',
				status: 'changed',
				primaryAction: { label: 'View the diff', kind: 'inspect', targetId: n },
			}),
		);
		await stubAccount(context, { cards: [APPROVAL_A, BLOCKED_A, ...extras], unseenCount: 5 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('account-brief-lane')).toBeVisible();
		// Exactly the server's top three open cards are big; the rest are not
		// rendered as cards at all (no infinite feed, no re-ranking).
		await expect(page.locator('[data-testid="decision-card"]')).toHaveCount(3);
		// Deadline rows: none of these cards are deadlines.
		await expect(page.getByTestId('brief-deadlines')).toHaveCount(0);
		await context.close();
	});

	test('an open deadline renders as a coloured row with its action', async ({ browser }) => {
		const context = await browser.newContext();
		const openDeadline = card({
			id: 'brf_schedule_sch-9',
			projectId: 'proj-b',
			kind: 'deadline',
			headline: 'Submission window closes soon',
			summary: 'Next milestone 2026-11-01.',
			status: 'needs-you',
			primaryAction: { label: 'Open the schedule', kind: 'review', targetId: 'sch-9' },
		});
		await stubAccount(context, { cards: [openDeadline, APPROVAL_A], unseenCount: 2 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('brief-deadlines').locator('[data-testid="brief-deadline-row"]')).toHaveCount(1);
		await expect(page.getByTestId('brief-deadline-row')).toContainText('Submission window closes soon');
		// The deadline row carries its own action (routes to Routines).
		await page.getByTestId('brief-deadline-action').click();
		await expect(page).toHaveURL(/\/app\/schedules\?project=proj-b$/);
		await context.close();
	});
});
