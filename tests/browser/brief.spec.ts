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
	runId?: string;
	key?: string;
	seen?: boolean;
	deadline?: { daysLeft: number; dateLabel: string; timeLabel: string; source?: string; localTimeLabel?: string; steps?: { title: string; detail?: string; done: boolean }[] };
	planItems?: { title: string; detail?: string }[];
	fit?: { reasons: string[]; cautions: string[] };
	checks?: { passed: number; items: string[]; version?: string };
	repair?: { expectation: string; fixing?: string };
	footer?: { appName: string; version?: string };
	nextStep?: string;
	build?: { current?: string; features: { title: string; state: 'built' | 'building' | 'waiting' }[]; builtCount: number; lastUpdatedAt?: string };
	peek?: { appName: string; caption?: string; imageUrl?: string; previewId?: string; previewKind?: 'web' | 'flutter'; previewHasServer?: boolean };
	schedule?: { name: string; nextRunLabel: string };
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
	// The onboarding gate wraps every shell route; a completed account lets the
	// shell render instead of bouncing to /onboarding.
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
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
	// Count paid-run attempts: opening tabs must never POST a run. Registered
	// AFTER the catch-all on purpose: Playwright runs the last-registered
	// matching route first, so registered before it this one never saw a
	// request and the welcome case could not count its run.
	await context.route('**/api/projects/**/runs', (route) => {
		if (route.request().method() !== 'POST') return json(route, 200, { runBindings: [] });
		runPosts.n += 1;
		const projectId = new URL(route.request().url()).pathname.split('/')[3] ?? 'home-1';
		return json(route, 200, {
			run: {
				runId: `run-${runPosts.n}`,
				projectId,
				conversationId: `conv-${runPosts.n}`,
				submissionId: `sub-${runPosts.n}`,
				planRevision: 'rev-0',
				stackId: 'react-hono',
				payerId: actorId,
				modelRouteId: 'chat',
				pricingVersion: 'test',
				createdBy: actorId,
				createdAt: NOW,
			},
		});
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
		const { reads, runPosts } = await stubAccount(context, { projects: [HOME], cards: [] });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		// Chat is the default: the conversation shows full-height.
		await expect(page.getByTestId('conversation-panel')).toBeVisible();
		// The deterministic welcome — three template cards, discovery first.
		await expect(page.getByTestId('welcome-panel')).toBeVisible();
		await expect(page.getByText("Let's find a hackathon that fits you")).toBeVisible();
		const cardTitles = page.locator('.welcome-card .welcome-card-title');
		await expect(cardTitles.nth(0)).toHaveText('Find my first hackathon');
		await expect(cardTitles.nth(1)).toHaveText('Start from an idea');
		await expect(cardTitles.nth(2)).toHaveText('Continue existing code');

		// Primary action starts a discovery CONVERSATION with Caddie in-chat —
		// it does NOT bounce to the standalone Discover page (chat-first).
		await page.getByTestId('welcome-find').click();
		await expect(page).not.toHaveURL(/\/app\/discover$/);
		await expect(page.getByTestId('conversation-panel')).toBeVisible();
		// Exactly one run was created to carry the discovery message.
		await expect.poll(() => runPosts.n).toBe(1);
		// Nothing in the Brief was marked read by starting discovery.
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
		await expect(page.locator('[data-testid="decision-card"]')).toHaveCount(3);
		await expect(page.locator('.card-context').first()).toContainText('Pit wall');
		await expect(page.getByTestId('brief-deadline-row')).toContainText('Weekly discovery sweep');

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
	test('retains every open card, including updates after the first three', async ({ browser }) => {
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
		// Open work is never silently truncated at the third card.
		await expect(page.locator('[data-testid="decision-card"]')).toHaveCount(5);
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
		// The deadline row carries its own action (routes to Routines — the
		// project settings section since U08).
		await page.getByTestId('brief-deadline-row').getByTestId('card-primary-action').click();
		await expect(page).toHaveURL(/\/app\/project\/settings\?project=proj-b#routines$/);
		await context.close();
	});
});

test.describe('card details in words (plan 5.5)', () => {
	// Live finding (2026-10-20): "Audit trail" opened a list of raw ids
	// (run …, card …, project …, action → inspect (run-9)).
	test('Details say what the card rests on and what its button does; ids only under For developers', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			cards: [{ ...BLOCKED_A, runId: 'run-9' }, { ...APPROVAL_A, evidenceIds: ['ev-1', 'ev-2'] }],
			unseenCount: 0,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		const blocked = page.getByTestId('decision-card').filter({ hasText: 'Run stopped' });
		const toggle = blocked.getByTestId('card-detail-toggle');
		await expect(toggle).toHaveText('Details');
		await toggle.click();
		await expect(toggle).toHaveText('Hide details');
		const details = blocked.getByTestId('card-details');
		await expect(details.getByTestId('card-details-words').locator('li')).toHaveText([
			'No evidence is attached yet.',
			'“Read the failure” opens what happened so you can look before deciding.',
		]);
		// The ids are there for developers, folded away.
		const dev = details.getByTestId('card-details-dev');
		await expect(dev).not.toHaveAttribute('open');
		await expect(details.getByText('card brf_failed-run_run-9')).toBeHidden();
		await dev.locator('summary').click();
		await expect(details.getByText('card brf_failed-run_run-9')).toBeVisible();
		await expect(details.getByText('run run-9')).toBeVisible();

		const approval = page.getByTestId('decision-card').filter({ hasText: 'Design review is waiting on you' });
		await approval.getByTestId('card-secondary-action').click();
		await expect(approval.getByTestId('card-details-words').locator('li')).toHaveText([
			'It rests on 2 pieces of evidence.',
			'“Review the design” opens it for you to review; nothing changes until you decide.',
		]);
		await context.close();
	});
});

test('Earlier keeps a resolved decision and opens its original revision without substituting the latest plan', async ({ browser }) => {
 const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
 await stubAccount(context, { cards: [{ ...APPROVAL_A, status: 'handled', headline: 'Design approved', summary: 'Decision approved.', primaryAction: { label: 'View decision', kind: 'review', targetId: 'ap-1' } }] });
 const original = { id: 'plan-original', projectId: 'proj-a', kind: 'prd', revision: 1, bodyHash: 'original-hash', body: '# Original approved scope', createdBy: 'actor-test', createdAt: NOW };
 const newer = { ...original, id: 'plan-newer', revision: 2, bodyHash: 'new-hash', body: '# Newer unapproved scope' };
 await context.route('**/api/projects/proj-a/plan-docs', route => json(route, 200, { revisions: [newer, original] }));
 await context.route('**/api/approvals/ap-1', route => json(route, 200, { approval: { id: 'ap-1', projectId: 'proj-a', action: 'design', resourceId: original.id, revisionHash: original.bodyHash, policyVersion: 'v1', intentHash: 'intent-original', status: 'approved', decidedBy: 'actor-test', expiresAt: '2999-01-01T00:00:00.000Z' } }));
 const page = await context.newPage();
 await page.goto(`${BASE}/app/?pane=brief`);
 await page.getByTestId('brief-done').getByText('Earlier · 1').click();
 await page.getByTestId('brief-done-item').getByRole('button', { name: 'View decision' }).click();
 await expect(page).toHaveURL(/approval=ap-1/);
 await expect(page.getByTestId('decision-original-content')).toContainText('Original approved scope');
 await expect(page.getByTestId('decision-history')).not.toContainText('Newer unapproved scope');
 await expect(page.getByTestId('decision-history').getByRole('button', { name: /Approve/ })).toHaveCount(0);
 await context.close();
});

test('shared compact cards fit mobile and keep consistent primary actions', async ({ browser }, testInfo) => {
 const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
 await stubAccount(context, { cards: [APPROVAL_A, BLOCKED_A, { ...APPROVAL_A, id: 'brf_approval_done', key: 'proj-a:approval:ap-done', headline: 'Design approved', summary: 'Decision approved. The original revision is kept.', status: 'handled', primaryAction: { label: 'View decision', kind: 'review', targetId: 'ap-done' } }] });
 const page = await context.newPage();
 await page.goto(`${BASE}/app/?pane=brief`);
 await expect(page.getByTestId('decision-card').filter({ visible: true })).toHaveCount(2);
 for (const action of await page.getByTestId('card-primary-action').filter({ visible: true }).all()) expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
 await page.getByTestId('brief-done').getByText('Earlier · 1').click();
 await page.screenshot({ path: testInfo.outputPath('shared-cards-mobile.png'), fullPage: true });
 await page.setViewportSize({ width: 320, height: 568 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
 await context.close();
});

// --- U (lane 14) step 1: the look, the footer, Earlier and the build rail ----
const SHOTS = process.env.KIROCREW_SCRATCH ?? '/tmp';
const BUILD_CARD = card({
	id: 'brf_workflow_build_run-7',
	projectId: 'proj-a',
	kind: 'result',
	headline: 'Your app is taking shape',
	summary: 'Caddie is implementing your approved plan and running the checks.',
	status: 'changed',
	runId: 'run-7',
	primaryAction: { label: 'View activity', kind: 'inspect', targetId: 'run-7' },
	key: 'proj-a:result:run-7',
});
const REPAIR_CARD = card({
	id: 'brf_workflow_repair_run-7',
	projectId: 'proj-a',
	kind: 'result',
	headline: 'One check needs another pass',
	summary: 'An offline entry did not survive reopening the app. I found it before handing the preview to you.',
	status: 'changed',
	runId: 'run-7',
	primaryAction: { label: 'View activity', kind: 'inspect', targetId: 'run-7' },
	key: 'proj-a:result:run-7',
	repair: { expectation: 'Save something, restart the app, and it must still be there.' },
	checks: { passed: 7, items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
});

test.describe('U step 1 — look, footer, build rail', () => {
	test('a building card shows the four-stage rail at "Building" and a footer; desktop + 390px', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [BUILD_CARD], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);

		const built = page.getByTestId('decision-card').filter({ hasText: 'Your app is taking shape' });
		const rail = built.getByTestId('card-build-rail');
		await expect(rail).toBeVisible();
		// Four named stages, in order.
		await expect(rail.locator('.compact-card-step')).toHaveText(['Plan approved', 'Building', 'Checking', 'Ready to try']);
		// Plan approved is done; Building is the active stage; later ones pending.
		await expect(rail.locator('[data-step="plan"]')).toHaveAttribute('data-state', 'done');
		await expect(rail.locator('[data-step="build"]')).toHaveAttribute('data-state', 'active');
		await expect(rail.locator('[data-step="check"]')).toHaveAttribute('data-state', 'pending');
		await expect(rail.locator('[data-step="preview"]')).toHaveAttribute('data-state', 'pending');
		// Footer reassurance (derived from design, no ids).
		const foot = built.getByTestId('card-foot');
		await expect(foot).toContainText('Preview appears after the checks pass.');
		await expect(foot).not.toContainText('run-7');
		await built.screenshot({ path: join(SHOTS, 'u1-build-card-desktop-2x.png') });

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(rail).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await built.screenshot({ path: join(SHOTS, 'u1-build-card-390.png') });
		await context.close();
	});

	test('a repairing card has NO step rail, a "what needs fixing" panel and the reassurance line; desktop + 390px', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [REPAIR_CARD], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);

		const repairing = page.getByTestId('decision-card').filter({ hasText: 'One check needs another pass' });
		// No step rail on a repair card (mockup).
		await expect(repairing.getByTestId('card-build-rail')).toHaveCount(0);
		// The "What needs fixing" panel shows the fixed expectation, not the body.
		await expect(repairing.getByTestId('card-repair')).toContainText('Save something, restart the app, and it must still be there.');
		// The reassurance line is restored.
		await expect(repairing.getByTestId('card-repair-reassure')).toContainText("You don’t need to do anything. I’ll run the checks again after the fix.");
		// "See what happened" is a bordered action; "Stop build" is text-only.
		await expect(repairing.getByTestId('card-primary-action')).toHaveText('See what happened');
		await expect(repairing.getByTestId('card-secondary-action')).toHaveText('Stop build');
		// No filled CTA on a working card.
		await expect(repairing.locator('.btn-key')).toHaveCount(0);
		await expect(repairing.getByTestId('card-foot')).toContainText('Preview held until the checks pass.');
		await repairing.screenshot({ path: join(SHOTS, 'u1-repair-card-desktop-2x.png') });

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(repairing.getByTestId('card-repair')).toBeVisible();
		await repairing.screenshot({ path: join(SHOTS, 'u1-repair-card-390.png') });
		await context.close();
	});

	test('a plan approval card carries a footer and no build rail', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [APPROVAL_A], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const plan = page.getByTestId('decision-card').filter({ hasText: 'Design review is waiting on you' });
		await expect(plan.getByTestId('card-build-rail')).toHaveCount(0);
		await expect(plan.getByTestId('card-foot')).toContainText('Nothing starts until you approve.');
		await context.close();
	});
});

// --- U (lane 14) step 2: the deadline countdown -----------------------------
const DEADLINE_WITH_COUNTDOWN = card({
	id: 'brf_schedule_sch-dl',
	projectId: 'proj-b',
	kind: 'deadline',
	headline: 'Farm Innovation Challenge is scheduled',
	summary: 'Next run Friday, 23 October 2026 at 17:00 (Africa/Lagos).',
	status: 'needs-you',
	primaryAction: { label: 'Open the schedule', kind: 'review', targetId: 'sch-dl' },
	key: 'proj-b:deadline:sch-dl',
	deadline: { daysLeft: 3, dateLabel: 'Friday, 23 October', timeLabel: '17:00', localTimeLabel: '5:00 pm', source: 'Farm Innovation Challenge (Africa/Lagos)' },
});

test.describe('U step 2 — deadline countdown', () => {
	test('a deadline card shows the days-left countdown with its readable date; desktop + 390px', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [DEADLINE_WITH_COUNTDOWN], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);

		const row = page.getByTestId('brief-deadline-row');
		const countdown = row.getByTestId('card-countdown');
		await expect(countdown).toBeVisible();
		await expect(row.getByTestId('card-days-left')).toHaveText('3');
		await expect(countdown).toContainText('days left');
		await expect(countdown).toContainText('Friday, 23 October');
		// One time line in the reader's own zone; never a bare zoneless "17:00".
		await expect(countdown).toContainText('5:00 pm · Your local time');
		await expect(countdown).not.toContainText('17:00');
		// The source names the schedule + timezone, never a raw id.
		await expect(countdown).toContainText('Africa/Lagos');
		await expect(countdown).not.toContainText('sch-dl');
		await row.screenshot({ path: join(SHOTS, 'u2-deadline-desktop-2x.png') });

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(countdown).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await row.screenshot({ path: join(SHOTS, 'u2-deadline-390.png') });
		await context.close();
	});

	test('a deadline card with no countdown field falls back to its summary', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [DEADLINE_B], unseenCount: 0 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const row = page.getByTestId('brief-deadline-row');
		await expect(row.getByTestId('card-countdown')).toHaveCount(0);
		await expect(row).toContainText('Weekly discovery sweep');
		await context.close();
	});
});

// --- U (lane 14) step 3: "What you're approving" — the plan's list ----------
const PLAN_WITH_ITEMS = card({
	id: 'brf_approval_ap-plan',
	projectId: 'proj-a',
	kind: 'approval',
	headline: 'Your farm log, ready to build',
	summary: 'Approving this authorises specialists building against this plan revision.',
	status: 'needs-you',
	primaryAction: { label: 'Approve plan', kind: 'review', targetId: 'ap-plan' },
	key: 'proj-a:approval:ap-plan',
	planItems: [
		{ title: 'Daily records, without the paperwork', detail: 'Add feeding, treatments and observations in one place.' },
		{ title: 'Keep recording when you’re offline', detail: 'Your entries sync when the connection returns.' },
		{ title: 'A clear weekly picture', detail: 'Turn your records into a short, useful summary.' },
	],
});

test.describe('U step 3 — plan approval list', () => {
	test('a plan card lists the plan’s features under "What you’re approving"; desktop + 390px', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [PLAN_WITH_ITEMS], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);

		const plan = page.getByTestId('decision-card').filter({ hasText: 'Your farm log, ready to build' });
		const list = plan.getByTestId('card-plan-items');
		await expect(list).toBeVisible();
		await expect(list.locator('.compact-card-list-row')).toHaveCount(3);
		await expect(list).toContainText('Daily records, without the paperwork');
		await expect(list).toContainText('Your entries sync when the connection returns.');
		await expect(plan).toContainText('What you’re approving');
		await plan.screenshot({ path: join(SHOTS, 'u3-plan-items-desktop-2x.png') });

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(list).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await plan.screenshot({ path: join(SHOTS, 'u3-plan-items-390.png') });
		await context.close();
	});

	test('a plan card with no items falls back to "What you’re reviewing" + summary', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [APPROVAL_A], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const plan = page.getByTestId('decision-card').filter({ hasText: 'Design review is waiting on you' });
		await expect(plan.getByTestId('card-plan-items')).toHaveCount(0);
		// With no feature list the card keeps its summary as the lede (no
		// "What you're reviewing" panel): the authorises scope reads inline.
		await expect(plan.locator('.summary')).toContainText('Approving this authorises');
		await context.close();
	});
});

// --- U (lane 14) step 4: the fit split --------------------------------------
function opportunity(overrides: Partial<BriefCard>): BriefCard {
	return card({
		id: 'brf_opportunity_cand-1',
		projectId: 'home-1',
		kind: 'result',
		headline: 'A suitable opportunity is saved: Farm Innovation Challenge',
		summary: "A sample from Caddie's built-in feed, not a real contest yet.",
		status: 'handled',
		primaryAction: { label: 'Review opportunity', kind: 'inspect', targetId: 'cand-1' },
		key: 'home-1:result:cand-1',
		...overrides,
	});
}

test.describe('U step 4 — opportunity fit split', () => {
	test('both sides render as a two-up split when each has content; desktop + 390px', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, {
			cards: [opportunity({ fit: {
				reasons: ['A real problem you know first-hand.', 'Offline tools are relevant to the brief.'],
				cautions: ['Regional eligibility still needs confirming.', 'A short demo video is required.'],
			} })],
			unseenCount: 0,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);

		const opp = page.getByTestId('decision-card').filter({ hasText: 'Farm Innovation Challenge' });
		const split = opp.getByTestId('card-fit');
		await expect(split).toBeVisible();
		await expect(opp).toContainText('Why it fits');
		await expect(opp).toContainText('Before you commit');
		await expect(opp.getByTestId('card-fit-reasons').locator('li')).toHaveCount(2);
		await expect(opp.getByTestId('card-fit-cautions').locator('li')).toHaveCount(2);
		await expect(split).toContainText('A real problem you know first-hand.');
		await expect(split).toContainText('Regional eligibility still needs confirming.');
		// Two columns on a wide card: the two panels share a top edge.
		const panels = await split.locator('.compact-card-panel').all();
		const boxes = await Promise.all(panels.map((p) => p.boundingBox()));
		expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThanOrEqual(2);
		expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width / 2);
		await opp.screenshot({ path: join(SHOTS, 'u4-fit-split-desktop-2x.png') });

		await page.setViewportSize({ width: 390, height: 844 });
		// Stacked on a phone: the second panel drops below the first.
		const narrow = await Promise.all((await split.locator('.compact-card-panel').all()).map((p) => p.boundingBox()));
		expect(narrow[1]!.y).toBeGreaterThan(narrow[0]!.y + narrow[0]!.height / 2);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await opp.screenshot({ path: join(SHOTS, 'u4-fit-split-390.png') });
		await context.close();
	});

	test('only "Before you commit" renders when there are no reasons (the real saved-candidate shape)', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, {
			cards: [opportunity({ fit: { reasons: [], cautions: ['Regional eligibility still needs confirming.'] } })],
			unseenCount: 0,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const opp = page.getByTestId('decision-card').filter({ hasText: 'Farm Innovation Challenge' });
		await expect(opp.getByTestId('card-fit-cautions')).toBeVisible();
		// No empty "Why it fits" heading is rendered.
		await expect(opp.getByTestId('card-fit-reasons')).toHaveCount(0);
		await expect(opp).not.toContainText('Why it fits');
		await expect(opp).toContainText('Before you commit');
		await context.close();
	});

	test('an opportunity with no fit field shows only its summary', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [opportunity({})], unseenCount: 0 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const opp = page.getByTestId('decision-card').filter({ hasText: 'Farm Innovation Challenge' });
		await expect(opp.getByTestId('card-fit')).toHaveCount(0);
		await expect(opp).toContainText("built-in feed");
		await context.close();
	});
});

// --- U (lane 14) step 5: the ready card's preview checks --------------------
function ready(overrides: Partial<BriefCard>): BriefCard {
	return card({
		id: 'brf_workflow_preview_prev-1',
		projectId: 'proj-a',
		kind: 'result',
		headline: 'Your app is ready to try',
		summary: 'Open the checked app preview. Your plan and build remain available.',
		status: 'handled',
		runId: 'run-7',
		primaryAction: { label: 'Try the app', kind: 'preview', targetId: 'prev-1' },
		key: 'proj-a:result:prev-1',
		...overrides,
	});
}

test.describe('U step 5 — ready card preview checks', () => {
	test('a ready card shows the passed-checks count and the feature names; desktop + 390px', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, {
			cards: [ready({ checks: { passed: 8, items: ['Daily activity log', 'Search and filters', 'Save and sync entries'], version: 'Version 3' } })],
			unseenCount: 0,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);

		const readyCard = page.getByTestId('decision-card').filter({ hasText: 'Your app is ready to try' });
		const chips = readyCard.getByTestId('card-checks');
		await expect(chips).toBeVisible();
		// Mockup 4 wording: a chip that says WHAT it counts, not "8 checks passed".
		await expect(chips).toContainText('All 8 features passed their checks');
		await expect(chips.getByTestId('card-check-version')).toContainText('Version 3');
		// Never a raw check id on a chip.
		await expect(chips).not.toContainText('feature-');
		await readyCard.screenshot({ path: join(SHOTS, 'u5-ready-checks-desktop-2x.png') });

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(chips).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await readyCard.screenshot({ path: join(SHOTS, 'u5-ready-checks-390.png') });
		await context.close();
	});

	test('the ready chip says what it counts; a single feature reads "feature passed its check"', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, {
			cards: [ready({ checks: { passed: 1, items: ['A'] } })],
			unseenCount: 0,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const chips = page.getByTestId('card-checks');
		await expect(chips).toContainText('All 1 feature passed its check');
		// No per-feature chips (mockup 4 shows the count + version, not each name).
		await expect(page.getByTestId('card-check-item')).toHaveCount(0);
		await context.close();
	});

	test('a ready card with no checks field shows only its summary', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [ready({})], unseenCount: 0 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const readyCard = page.getByTestId('decision-card').filter({ hasText: 'Your app is ready to try' });
		await expect(readyCard.getByTestId('card-checks')).toHaveCount(0);
		await expect(readyCard).toContainText('Open the checked app preview');
		await context.close();
	});
});

test('Earlier loads archived decisions on demand and retains the exact decision target',async({browser})=>{
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await stubAccount(context,{cards:[{...APPROVAL_A,status:'handled',headline:'Recent approval',primaryAction:{kind:'review',label:'View decision',targetId:'ap-1'}}]});
 const requests:string[]=[];
 await context.route('**/api/brief/history**',route=>{requests.push(route.request().url());return route.fulfill({contentType:'application/json',body:JSON.stringify({cards:[{...APPROVAL_A,id:'brf_approval_ancient',status:'handled',headline:'Original archived approval',primaryAction:{kind:'review',label:'View original decision',targetId:'ancient-approval'}}],next:null})});});
 const page=await context.newPage();await page.goto(`${BASE}/app/?pane=brief`);
 expect(requests).toHaveLength(0);
 await page.getByTestId('brief-done').locator('summary').first().click();
 await page.getByRole('button',{name:'Load older decisions'}).click();
 await expect(page.getByText('Original archived approval')).toBeVisible();
 await expect(page.getByText('All recorded decisions are shown.')).toBeVisible();
 await page.getByRole('button',{name:'View original decision'}).click();
 await expect(page).toHaveURL(/approval=ancient-approval/);
 expect(requests).toHaveLength(1);
 await context.close();
});

test('the Brief shows one standard-width card per row, centred, within a 420–584px band (no two-up)', async ({ browser }) => {
	// Lane rule (owner 2026-10-23 revised): ONE standard-width card per row,
	// centred in the Brief section — no two-up. Each card sits between a minimum
	// (420px) and a maximum (584px) width. A phone width fills the card.
	const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
	await stubAccount(context, { cards: [APPROVAL_A, BLOCKED_A], unseenCount: 2 });
	const page = await context.newPage();
	await page.goto(`${BASE}/app/?pane=brief`);

	const cards = page.getByTestId('decision-card');
	await expect(cards).toHaveCount(2);
	const wideBoxes = await Promise.all((await cards.all()).map((c) => c.boundingBox()));
	expect(wideBoxes[0] && wideBoxes[1]).toBeTruthy();
	// ONE per row: the second card is below the first, not beside it.
	expect(wideBoxes[1]!.y).toBeGreaterThan(wideBoxes[0]!.y + wideBoxes[0]!.height / 2);
	// Each card is within its min/max width band.
	expect(wideBoxes[0]!.width).toBeGreaterThanOrEqual(420);
	expect(wideBoxes[0]!.width).toBeLessThanOrEqual(584 + 2);
	// Centred: the Brief section has roughly equal margin either side of the card.
	const lane = await page.getByTestId('account-brief-lane').boundingBox();
	const leftGap = wideBoxes[0]!.x - lane!.x;
	const rightGap = lane!.x + lane!.width - (wideBoxes[0]!.x + wideBoxes[0]!.width);
	expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(8);

	// At a phone width the cards stack one per row with no overflow.
	await page.setViewportSize({ width: 390, height: 844 });
	const narrowBoxes = await Promise.all((await cards.all()).map((c) => c.boundingBox()));
	expect(narrowBoxes[1]!.y).toBeGreaterThan(narrowBoxes[0]!.y + narrowBoxes[0]!.height / 2);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await context.close();
});

test('U — rich cards (plan + fit) render one centred standard-width column, and stack at 390', async ({ browser }) => {
	// Lane rule (owner 2026-10-23 revised): one standard-width card per row,
	// centred, each within the 420–584px band so the plan list + fit split read
	// at the mockup scale. A phone width stacks them.
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await stubAccount(context, {
		cards: [
			PLAN_WITH_ITEMS,
			opportunity({ fit: { reasons: ['A real problem you know first-hand.'], cautions: ['Regional eligibility still needs confirming.', 'A short demo video is required.'] } }),
		],
		unseenCount: 1,
	});
	const page = await context.newPage();
	await page.goto(`${BASE}/app/?pane=brief`);

	const cards = page.getByTestId('decision-card');
	await expect(cards).toHaveCount(2);
	const boxes = await Promise.all((await cards.all()).map((c) => c.boundingBox()));
	// ONE per row: the second card sits below the first, not beside it.
	expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height / 2);
	// Each card is within its min/max width band.
	expect(boxes[0]!.width).toBeGreaterThanOrEqual(420);
	expect(boxes[0]!.width).toBeLessThanOrEqual(584 + 2);
	// The plan list and the fit split both still render.
	await expect(page.getByTestId('card-plan-items')).toBeVisible();
	await expect(page.getByTestId('card-fit-cautions')).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	const narrow = await Promise.all((await cards.all()).map((c) => c.boundingBox()));
	expect(narrow[1]!.y).toBeGreaterThan(narrow[0]!.y + narrow[0]!.height / 2);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await context.close();
});

// --- Per-card acceptance against the accepted mockups (2026-10-22 redo) ------
// One browser test per card type, asserting the distinctive mockup element the
// owner's accepted design requires. Every card is stubbed at the network layer
// (UI-state proof); the service-level fills are pinned by brief-card-redo.test.ts.
test.describe('redo — each card matches its mockup', () => {
	test('every card carries a "· time" kicker and no monospace "updated" meta line', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [{ ...APPROVAL_A, updatedAt: NOW }], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const cardEl = page.getByTestId('decision-card').first();
		await expect(cardEl.getByTestId('card-fresh')).toContainText('ago');
		// The rejected developer-looking meta line is gone.
		await expect(cardEl.getByTestId('card-meta')).toHaveCount(0);
		await context.close();
	});

	test('plan card: feature list, fixed next-step line, hue CTA + ghost secondary, footer app · Plan v2', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [{ ...PLAN_WITH_ITEMS, nextStep: 'Approve this scope and I’ll prepare the design for your review.', footer: { appName: 'FarmLog AI', version: 'Plan v2' } }], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const plan = page.getByTestId('decision-card').first();
		await expect(plan.getByTestId('card-plan-items')).toBeVisible();
		await expect(plan.getByTestId('card-next-step')).toContainText('prepare the design');
		await expect(plan.getByTestId('card-primary-action')).toHaveText('Approve plan');
		await expect(plan.getByTestId('card-secondary-action')).toHaveText('Read the plan');
		await expect(plan.getByTestId('card-foot-subject')).toHaveText('FarmLog AI · Plan v2');
		await context.close();
	});


test('a long card title is clamped to two lines (owner 2026-10-23)', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const longTitle = 'This is a deliberately very long decision card headline that would wrap onto three or four lines if it were not clamped to exactly two lines with an ellipsis at the end';
	await stubAccount(context, { cards: [card({ id: 'brf_long', projectId: 'proj-a', kind: 'approval', status: 'needs-you', headline: longTitle })], unseenCount: 1 });
	const page = await context.newPage();
	await page.goto(`${BASE}/app/?pane=brief`);

	const title = page.getByTestId('decision-card').locator('h3').first();
	await expect(title).toBeVisible();
	const metrics = await title.evaluate((el) => {
		const cs = getComputedStyle(el);
		return { clamp: cs.webkitLineClamp || (cs as unknown as Record<string, string>)['lineClamp'], clientH: (el as HTMLElement).clientHeight, scrollH: (el as HTMLElement).scrollHeight, lineHeight: parseFloat(cs.lineHeight) };
	});
	// Clamped to two lines, and the full text overflows (so it IS truncated).
	expect(metrics.clamp).toBe('2');
	expect(metrics.scrollH).toBeGreaterThan(metrics.clientH);
	// The visible box is no taller than ~2 lines.
	expect(metrics.clientH).toBeLessThanOrEqual(Math.ceil(metrics.lineHeight * 2) + 2);
	await context.close();
});
	test('build card: Now line + feature feed with states + last-update line', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [{ ...BUILD_CARD, build: { current: 'offline recording', builtCount: 2, features: [
			{ title: 'Daily activity log', state: 'built' }, { title: 'Search and filters', state: 'built' }, { title: 'Save and sync entries', state: 'building' }, { title: 'Weekly summary', state: 'waiting' },
		] }, footer: { appName: 'FarmLog AI' } }], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const build = page.getByTestId('decision-card').first();
		await expect(build.getByTestId('card-build-current')).toHaveText('Now: offline recording');
		await expect(build.getByTestId('card-build-feed-row')).toHaveCount(4);
		await expect(build.getByTestId('card-build-feed-row').last()).toContainText('Waiting');
		await expect(build.getByTestId('card-build-update')).toContainText('2 features built');
		// A card where Caddie is working gets NO filled CTA: "View activity" is a
		// bordered action and "Stop build" is text-only.
		await expect(build.locator('.btn-key')).toHaveCount(0);
		await expect(build.getByTestId('card-primary-action')).toHaveText('View activity');
		await expect(build.getByTestId('card-secondary-action')).toHaveText('Stop build');
		await context.close();
	});

	test('repair card: no rail + "what needs fixing" panel + checks line', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [{ ...REPAIR_CARD, checks: { passed: 7, items: ['a', 'b'] }, repair: { expectation: 'Save something, restart the app, and it must still be there.', fixing: 'Save and sync entries' } }], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const repair = page.getByTestId('decision-card').first();
		// No step rail on a repair card (mockup).
		await expect(repair.getByTestId('card-build-rail')).toHaveCount(0);
		// The panel reads the fixed expectation, never the card body sentence.
		await expect(repair.getByTestId('card-repair')).toContainText('What needs fixing');
		await expect(repair.getByTestId('card-repair')).toContainText('Save something, restart the app, and it must still be there.');
		// The work line names the feature from the build record; the count is of
		// features (what it really counts), not "checks".
		await expect(repair.getByTestId('card-repair-now')).toHaveText('Now fixing: Save and sync entries');
		await expect(repair.getByTestId('card-repair-fix')).toContainText('7 features passed');
		await expect(repair.getByTestId('card-repair-reassure')).toContainText("I’ll run the checks again after the fix.");
		await context.close();
	});

	test('ready card: worded chip + green (hue) CTA', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [ready({ checks: { passed: 8, items: ['a'], version: '3' }, peek: { appName: 'FarmLog AI', caption: 'A checked preview.' } })], unseenCount: 0 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const readyCard = page.getByTestId('decision-card').filter({ hasText: 'Your app is ready to try' });
		await expect(readyCard.getByTestId('card-checks')).toContainText('All 8 features passed their checks');
		// The app peek is left absent (mockup), even when a peek record exists.
		await expect(readyCard.getByTestId('card-peek')).toHaveCount(0);
		// The CTA fill uses the card's green hue (--color-ok), not the blue action.
		const fill = await readyCard.getByTestId('card-primary-action').evaluate((el) => getComputedStyle(el).backgroundColor);
		const ok = await readyCard.evaluate((el) => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--color-ok)';
			el.appendChild(probe);
			const c = getComputedStyle(probe).color;
			probe.remove();
			return c;
		});
		const action = await readyCard.evaluate((el) => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--color-action)';
			el.appendChild(probe);
			const c = getComputedStyle(probe).color;
			probe.remove();
			return c;
		});
		expect(fill).toBe(ok);
		expect(fill).not.toBe(action);
		await context.close();
	});

	test('ready card: a live, scaled, inert view of its own checked preview (owner, 2026-10-22)', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, {
			cards: [ready({ checks: { passed: 8, items: ['a'], version: '3' }, peek: { appName: 'FarmLog AI', previewId: 'prev-1', previewKind: 'web', previewHasServer: false } })],
			unseenCount: 0,
		});
		// The card's own preview: the same seed + document endpoints the full
		// preview uses, answering a tiny real page.
		let seeded = 0;
		await context.route('**/api/projects/proj-a/workflow/preview/prev-1/seed', (route) => {
			seeded += 1;
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seedRef: 'seed-1' }) });
		});
		await context.route('**/api/projects/proj-a/workflow/preview/prev-1/document**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><h1>Hello from FarmLog</h1></body></html>' }),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const readyCard = page.getByTestId('decision-card').filter({ hasText: 'Your app is ready to try' });
		const peek = readyCard.getByTestId('card-peek');
		await expect(peek).toBeVisible();
		await expect(peek).toContainText('FarmLog AI');
		await expect(peek).toContainText('Live preview');
		// The real app runs in the frame, loaded from THIS card's preview.
		const frame = peek.getByTestId('peek-frame');
		await expect(frame).toHaveAttribute('src', /\/workflow\/preview\/prev-1\/document\?/);
		await expect(page.frameLocator('[data-testid="peek-frame"]').getByRole('heading', { name: 'Hello from FarmLog' })).toBeVisible();
		expect(seeded).toBe(1);
		// Not clickable or focusable: "Try the app" is how a person opens it.
		const viewport = peek.locator('.compact-card-peek-viewport');
		await expect(viewport).toHaveAttribute('inert', '');
		expect(await viewport.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
		await expect(frame).toHaveAttribute('tabindex', '-1');
		await context.close();
	});

	test('deadline card: days-left countdown + local time line + submission steps, no schedule wording', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [card({
			id: 'brf_hackathon-deadline_proj-a', projectId: 'proj-a', kind: 'deadline',
			headline: 'Leave time to tell the story', summary: 'The app is one part of the submission.',
			status: 'needs-you', primaryAction: { label: 'Review submission', kind: 'review', targetId: 'proj-a' },
			deadline: { daysLeft: 3, dateLabel: 'Friday, 23 October', timeLabel: '17:00', source: 'Farm Innovation Challenge', localTimeLabel: '5:00 pm', steps: [
				{ title: 'App preview ready', detail: 'Your current build has passed its checks.', done: true },
				{ title: 'Demo video', detail: 'Not yet attached.', done: false },
			] },
			footer: { appName: 'Farm Innovation Challenge', version: 'Submission' },
		})], unseenCount: 1 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const deadline = page.getByTestId('decision-card').first();
		await expect(deadline.getByTestId('card-days-left')).toHaveText('3');
		// One time line in the reader's own zone; never the bare zoneless "17:00".
		await expect(deadline.getByTestId('card-local-time')).toContainText('5:00 pm · Your local time');
		await expect(deadline.getByTestId('card-countdown')).not.toContainText('17:00');
		await expect(deadline.getByTestId('card-deadline-steps').locator('li')).toHaveCount(2);
		await context.close();
	});

	test('schedule-backed deadline card says when it next runs, with no days-left and no Deadline badge', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [card({
			id: 'brf_schedule_sch-1', projectId: 'proj-a', kind: 'deadline',
			headline: 'Weekly discovery sweep is scheduled', summary: 'A finished run reports here.',
			status: 'handled', primaryAction: { label: 'Open the schedule', kind: 'review', targetId: 'sch-1' },
			schedule: { name: 'Weekly discovery sweep', nextRunLabel: 'Monday, 12 October 2026 at 07:00 (Africa/Lagos)' },
		})], unseenCount: 0 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const sched = page.getByTestId('decision-card').first();
		await expect(sched.getByTestId('card-schedule')).toContainText('runs next');
		await expect(sched.getByTestId('card-countdown')).toHaveCount(0);
		await expect(sched.getByText('Deadline', { exact: true })).toHaveCount(0);
		await context.close();
	});

	test('opportunity card: Why it fits + Before you commit split, green CTA + "Save for later"', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [opportunity({ fit: { reasons: ['A real problem you know first-hand.'], cautions: ['Regional eligibility still needs confirming.'] }, footer: { appName: 'Farm Innovation Challenge' } })], unseenCount: 0 });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const opp = page.getByTestId('decision-card').first();
		await expect(opp.getByTestId('card-fit-reasons')).toContainText('first-hand');
		await expect(opp.getByTestId('card-fit-cautions')).toContainText('eligibility');
		await expect(opp.getByTestId('card-secondary-action')).toHaveText('Save for later');
		// The kicker reads "Found for you" (mockup), not the generic design label.
		await expect(opp.locator('.compact-card-kicker')).toContainText('Found for you');
		// Green, as in the mockup: the hue drives the kicker, the pill, the panel
		// tint and the filled CTA.
		await expect(opp).toHaveAttribute('data-tone', 'green');
		await context.close();
	});

	test('earlier card: a compact history record (mark, title, line, link, time)', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context, { cards: [{ ...APPROVAL_A, id: 'brf_approval_done', status: 'handled', headline: 'You approved the plan', summary: 'Daily logs, offline recording, and weekly summaries.', primaryAction: { label: 'View approved plan', kind: 'review', targetId: 'ap-done' }, key: 'proj-a:approval:ap-done' }] });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		// The earlier card lives in the folded "Earlier" section.
		await page.getByTestId('brief-done').getByText('Earlier · 1').click();
		const earlier = page.getByTestId('decision-card').filter({ hasText: 'You approved the plan' }).first();
		await expect(earlier.locator('.compact-card-record')).toBeVisible();
		await expect(earlier.locator('.compact-card-record time')).toBeVisible();
		// The footer: N completed updates on the left, Read-only history right.
		const foot = earlier.getByTestId('card-foot');
		await expect(foot).toContainText('1 completed update');
		await expect(foot).toContainText('Read-only history');
		await context.close();
	});
});
