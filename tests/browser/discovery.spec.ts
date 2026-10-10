import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P11 / discovery-first browser acceptance — the REAL DiscoveryResults
 * component, now mounted at the ACCOUNT-level /discover surface
 * (apps/app/src/client/surface.tsx DiscoverPage + routes.tsx), driven against
 * the COMPOSED build (`bun run build` first; local workerd on
 * 127.0.0.1:4173, SPA under /app). The P11 server router IS real
 * (apps/app/src/server/routes/discovery.ts) — the endpoints are stubbed here at
 * the network layer for deterministic UI-state proofs, mirroring the exact
 * payload shapes of that router (UI-state proofs; real-data behavior is P11's
 * integration suite: tests/discovery.test.ts + tests/planning.integration.test.ts).
 *
 * The redesign moves discovery from a project-scoped /discovery page to a
 * first-class account surface (/discover) that works BEFORE any project exists.
 * It reads the actor's Home project (kind='home') as the account scope, so the
 * discovery namespace is stubbed under /api/projects/home-1/** here.
 *
 * Honesty rules proven here (packets P11 + the discovery-first redesign):
 *   - unauthenticated /discover fails closed to the real sign-in state;
 *   - an empty feed says so — no invented candidates, UNKNOWN country never guessed;
 *   - a failed source is a visible, NAMED feed gap with its reason;
 *   - eligibility renders conservative verdicts and fit detail cites evidence —
 *     no invented links and no win probability anywhere;
 *   - SAVING an opportunity never creates a build project (POST /projects = 0);
 *   - EXPLORING ideas commits to exactly one resumable project carrying the
 *     contest link, and CONTINUES an existing one when the contest is already
 *     linked — it never silently retargets another project;
 *   - the legacy /discovery deep link redirects to /discover, not a dead end.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-p11-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/discovery.spec.ts');
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

// --- fixture data (mirrors the real P11 router payload shapes) ------------------

const NOW = '2026-10-04T10:00:00.000Z';

type ProjectKind = 'standard' | 'home';

function project(id: string, name: string, kind: ProjectKind = 'standard', contestUrl: string | null = null) {
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

// The account scope: the actor's Home project (kind='home'), resolved from the
// list AND /api/home-project. Discover reads THIS id for the discovery namespace,
// so the stubs below are keyed to it — proving discovery works with zero build
// projects (the Home project always exists once signed in).
const HOME = project('home-1', 'Home', 'home');
const PROJECT_A = project('proj-a', 'Pit wall');
/** A build project already linked to cand-1's contest URL — the continue case. */
const PROJECT_LINKED = project('proj-linked', 'Solar board', 'standard', 'https://contest.example/solar-hackweek');

const CAND_1_URL = 'https://contest.example/solar-hackweek';

/** Mutated by handlers/steps so each test drives its own honest state. */
interface StubState {
	feedRuns: {
		id: string;
		requestedAt: string;
		sources: { source: string; outcome: 'succeeded' | 'failed'; failureReason: string | null; candidateCount: number }[];
	}[];
	evaluated: unknown;
	candidatesStatus: number;
	candidatesBody: Record<string, unknown>;
	acceptedIds: string[];
	acceptedCalls: { url: string }[];
}

function initialState(): StubState {
	return {
		feedRuns: [],
		evaluated: { evaluations: [], ranked: [], profileCountry: null },
		candidatesStatus: 200,
		candidatesBody: {},
		acceptedIds: [],
		acceptedCalls: [],
	};
}

const WITH_CANDIDATES: StubState['evaluated'] = {
	evaluations: [
		{
			candidate: {
				id: 'cand-1',
				url: CAND_1_URL,
				title: 'Solar Hackweek',
				summary: 'Build a climate dashboard in a weekend.',
				source: 'local-seed',
				status: 'new',
				firstSeenAt: NOW,
			},
			fit: {
				matchedRequirements: 2,
				claims: [
					{
						requirement: 'Teams of 1-4 may enter',
						claimType: 'team_size',
						verdict: 'supported',
						statement: 'The recorded rules state teams of 1-4 may enter.',
						evidenceClaimIds: ['cl-team-1'],
						assumptions: [],
					},
					{
						requirement: 'Open to international entrants',
						claimType: 'region',
						verdict: 'unknown',
						statement: 'No recorded rule says who may enter by region.',
						evidenceClaimIds: [],
						assumptions: ['region rule assumed unrestricted absent a recorded rule'],
					},
				],
			},
			eligibility: {
				verdict: 'eligible',
				rules: [
					{
						claimType: 'region',
						verdict: 'pass',
						basis: 'cl-team-1',
						reason: 'Quoted rule lists no region restriction.',
					},
				],
			},
		},
		{
			candidate: {
				id: 'cand-2',
				url: 'https://contest.example/employees-only',
				title: 'Employees-only sprint',
				summary: 'Internal company hackathon.',
				source: 'local-seed',
				status: 'new',
				firstSeenAt: NOW,
			},
			fit: {
				matchedRequirements: 1,
				claims: [],
			},
			eligibility: {
				verdict: 'ineligible',
				rules: [
					{
						claimType: 'employment',
						verdict: 'fail',
						basis: 'cl-emp-7',
						reason: 'Quoted rule restricts entry to company employees.',
					},
				],
			},
		},
	],
	ranked: [
		{ candidateId: 'cand-1', matchedRequirements: 2, verdict: 'eligible' },
		{ candidateId: 'cand-2', matchedRequirements: 1, verdict: 'ineligible' },
	],
	profileCountry: 'US',
};

const FEED_WITH_GAP: StubState['feedRuns'] = [
	{
		id: 'feed-1',
		requestedAt: NOW,
		sources: [
			{ source: 'local-seed', outcome: 'succeeded', failureReason: null, candidateCount: 2 },
			{ source: 'devpost', outcome: 'failed', failureReason: 'upstream returned 503 (recorded receipt)', candidateCount: 0 },
		],
	},
];

// --- stubbing helpers (workspace.spec.ts grammar) --------------------------------

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * A signed-in account. The projects list carries the Home project (kind='home')
 * plus any build projects the caller wants; /api/home-project resolves the same
 * Home so the general conversation and Discover scope exist before any build.
 * Project children default to honest empties so no real 401 leaks into the panes.
 */
async function stubAccount(context: BrowserContext, buildProjects: ReturnType<typeof project>[]) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Test', email: 't@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/projects', (route) =>
		route.request().method() === 'GET'
			? json(route, 200, { projects: [HOME, ...buildProjects] })
			: json(route, 405, { error: 'method_not_allowed' }),
	);
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
		return json(route, 200, {});
	});
}

/** One explicit handler for the account-scoped (Home) P11 discovery namespace. */
async function stubDiscovery(context: BrowserContext, state: StubState) {
	await context.route('**/api/projects/home-1/discovery/**', (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path.endsWith('/feed')) {
			if (request.method() === 'POST') {
				state.feedRuns.unshift({
					id: `feed-${state.feedRuns.length + 1}`,
					requestedAt: NOW,
					sources: [{ source: 'local-seed', outcome: 'succeeded', failureReason: null, candidateCount: 2 }],
				});
				return json(route, 201, { feed: state.feedRuns[0] });
			}
			return json(route, 200, { runs: state.feedRuns });
		}
		if (/\/candidates\/[^/]+\/accept$/.test(path)) {
			const candidateId = path.split('/')[6];
			state.acceptedIds.push(candidateId ?? '');
			state.acceptedCalls.push({ url: request.url() });
			return json(route, 200, {
				candidate: {
					id: candidateId,
					url: CAND_1_URL,
					title: 'Solar Hackweek',
					summary: 'Build a climate dashboard in a weekend.',
					source: 'local-seed',
					status: 'accepted',
					firstSeenAt: NOW,
				},
			});
		}
		if (path.endsWith('/candidates')) {
			if (state.candidatesStatus !== 200) {
				return json(route, state.candidatesStatus, state.candidatesBody);
			}
			const evaluated = structuredClone(state.evaluated) as {
				evaluations: { candidate: { id: string; status: string } }[];
			};
			for (const evaluation of evaluated.evaluations) {
				if (state.acceptedIds.includes(evaluation.candidate.id)) {
					evaluation.candidate.status = 'accepted';
				}
			}
			return json(route, 200, evaluated);
		}
		return json(route, 404, { error: 'not_found' });
	});
}

/**
 * A create-project spy on the real REST surface. Every POST /api/projects is
 * recorded so a test can prove saving creates nothing, exploring creates
 * exactly one, and continuing an existing project creates none.
 */
async function stubCreateProject(
	context: BrowserContext,
	log: { calls: Record<string, unknown>[] },
	returnedId = 'proj-new',
	status = 201,
) {
	await context.route('**/api/workspaces', (route) =>
		json(route, 201, { workspace: { id: 'ws-1', name: 'Home', createdAt: NOW } }),
	);
	await context.route('**/api/projects', (route) => {
		const request = route.request();
		if (request.method() === 'GET') {
			// Let the account list stand — the continue-vs-create decision reads
			// the caller's real build-project list (including any linked contest).
			return route.fallback();
		}
		log.calls.push(request.postDataJSON() as Record<string, unknown>);
		if (status !== 201) {
			return json(route, status, { error: 'create_failed', message: 'The project could not be created.' });
		}
		return json(
			route,
			201,
			{
				project: {
					...project(returnedId, 'Solar Hackweek'),
					contestUrl: (log.calls.at(-1)?.contestUrl as string) ?? null,
				},
			},
		);
	});
}

// --- tests ------------------------------------------------------------------------

test.describe('Discovery-first: account-level Discover (composed build, stubbed /api)', () => {
	test('unauthenticated /app/discover shows the real sign-in state (live probe, no stubs)', async ({ page }) => {
		await page.goto(`${BASE}/app/discover`);
		await expect(page.getByTestId('sign-in-panel')).toBeVisible();
		// The discovery surface itself must not render for an unverified session.
		await expect(page.locator('section[aria-label="Discovery results"]')).toHaveCount(0);
	});

	test('Discover is reachable with ZERO build projects — it reads the account (Home) scope', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		await stubAccount(context, []); // no build projects at all
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		// The surface renders against /api/projects/home-1/discovery/** (home scope).
		await expect(page.getByTestId('discovery-results')).toBeVisible();
		await expect(page.getByText('Nothing has been read, so nothing is ranked')).toBeVisible();
		await expect(page.getByText('No candidates yet — run the feed.')).toBeVisible();
		// No profile country on record → honest UNKNOWN, never a guess.
		await expect(page.getByText('none recorded — country rules stay UNKNOWN')).toBeVisible();
		// The persistent conversation stays on the GENERAL (account) scope here.
		await expect(page.getByTestId('conv-context-label')).toContainText('Everything');
		await context.close();
	});

	test('candidates render eligibility verdicts, evidence-backed fit and named feed gaps — no invented links, no win probability', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		state.feedRuns = FEED_WITH_GAP;
		await stubAccount(context, [PROJECT_A]);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		await expect(page.getByTestId('discovery-results')).toBeVisible();
		await expect(page.getByText('Solar Hackweek')).toBeVisible();
		// v2 verdict words (§6): plain, never jargon. The hard-ineligible row is
		// hidden until the named reveal is used.
		await expect(page.getByText('You can enter', { exact: true })).toBeVisible();
		await expect(page.getByText("Can't enter", { exact: true })).toHaveCount(0);
		await page.getByTestId('discovery-reveal-ineligible').click();
		await expect(page.getByText("Can't enter", { exact: true })).toBeVisible();
		// One reason it fits: the first evidenced claim's statement.
		await expect(page.getByText('The recorded rules state teams of 1-4 may enter.').first()).toBeVisible();

		// Partial feed failure is a VISIBLE, NAMED gap — never silently dropped.
		const gaps = page.getByRole('status').filter({ hasText: 'Feed gaps' });
		await expect(gaps).toBeVisible();
		await expect(gaps).toContainText('devpost failed — upstream returned 503 (recorded receipt)');

		await expect(page.getByText('Whether you can enter is judged with your profile country: US')).toBeVisible();

		// Fit detail cites the evidence claim id, or records its assumption.
		await page.getByRole('button', { name: 'Can you enter?' }).first().click();
		await expect(page.getByText('SUPPORTED — The recorded rules state teams of 1-4 may enter.')).toBeVisible();
		await expect(page.getByText('evidence: cl-team-1')).toBeVisible();
		await expect(page.getByText('assumption: region rule assumed unrestricted absent a recorded rule')).toBeVisible();

		// The only rendered link is the candidate's real recorded URL — and no
		// win probability exists anywhere in this surface.
		await expect(page.locator(`a[href="${CAND_1_URL}"]`)).toHaveCount(1);
		const body = await page.locator('body').innerText();
		expect(body).not.toMatch(/win (rate|probability|chance)/i);
		await context.close();
	});

	test('each opportunity offers Explore ideas (primary) + Save (secondary) — never a bare "Accept"', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		await stubAccount(context, [PROJECT_A]);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		await expect(page.getByTestId('explore-ideas-cand-1')).toBeVisible();
		await expect(page.getByTestId('save-candidate-cand-1')).toBeVisible();
		// The redesign replaces "Accept" with an explicit explore/save pair.
		await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
		await context.close();
	});

	test('Save accepts on the real route and creates NO project; Explore commits to exactly one with the contest link', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		const created: { calls: Record<string, unknown>[] } = { calls: [] };
		await stubAccount(context, [PROJECT_A]);
		await stubDiscovery(context, state);
		await stubCreateProject(context, created);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		// Saving only flips candidate status — it must never spin up a build.
		await page.getByTestId('save-candidate-cand-1').click();
		await expect(page.getByText('source local-seed · saved')).toBeVisible();
		expect(state.acceptedCalls).toHaveLength(1);
		expect(new URL(state.acceptedCalls[0]!.url).pathname).toBe(
			'/api/projects/home-1/discovery/candidates/cand-1/accept',
		);
		expect(created.calls).toHaveLength(0); // no project created by Save

		// Exploring the other candidate opens the two-step idea flow; cand-2 is
		// hard-ineligible, so it must be revealed first (hidden by default).
		await page.getByTestId('discovery-reveal-ineligible').click();
		await page.getByTestId('explore-ideas-cand-2').click();
		// v2 explore-ideas: step 1 picks/types the idea, step 2 confirms.
		await expect(page.getByTestId('explore-idea-text')).toBeVisible();
		await page.getByTestId('explore-ideas-next').click();
		await expect(page.getByTestId('explore-commit')).toContainText('Start a project for this contest');
		await page.getByTestId('explore-commit-create').click();
		await expect(page).toHaveURL(/\/app\/project\?project=proj-new$/);
		expect(created.calls).toHaveLength(1);
		expect(created.calls[0]).toMatchObject({ name: 'Employees-only sprint', contestUrl: 'https://contest.example/employees-only' });
		await context.close();
	});

	test('Explore commit shows a visible error and stays open when creation fails', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		const created: { calls: Record<string, unknown>[] } = { calls: [] };
		await stubAccount(context, [PROJECT_A]);
		await stubDiscovery(context, state);
		await stubCreateProject(context, created, 'proj-new', 500);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		await page.getByTestId('explore-ideas-cand-1').click();
		await expect(page.getByTestId('explore-idea-text')).toBeVisible();
		await page.getByTestId('explore-ideas-next').click();
		await expect(page.getByTestId('explore-commit')).toContainText('Start a project for this contest');
		await page.getByTestId('explore-commit-create').click();
		await expect(page.getByTestId('explore-commit-error')).toBeVisible();
		await expect(page.getByTestId('explore-commit')).toBeVisible(); // still open, nothing created
		await expect(page).toHaveURL(/\/app\/discover$/);
		expect(created.calls).toHaveLength(1); // one attempt, failed, no navigation
		await context.close();
	});

	test("v2 list: can't-enter rows hide by default with a named reveal; the can-enter filter narrows", async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		await stubAccount(context, [PROJECT_A]);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		// Save cand-1 (stays the accept semantics until B01); cand-2 stays new.
		await page.getByTestId('save-candidate-cand-1').click();
		await expect(page.getByText('source local-seed · saved')).toBeVisible();

		// Hard-ineligible rows are hidden by default behind a named reveal.
		await expect(page.getByTestId('eligibility-cand-2')).toHaveCount(0);
		const reveal = page.getByTestId('discovery-reveal-ineligible');
		await expect(reveal).toContainText("Show 1 you can't enter");
		await reveal.click();
		await expect(page.getByTestId('eligibility-cand-2')).toBeVisible();

		// The can-enter filter narrows to eligible candidates only.
		await page.getByTestId('discovery-filter-canenter').click();
		await expect(page.getByTestId('eligibility-cand-1')).toBeVisible();
		await expect(page.getByTestId('eligibility-cand-2')).toHaveCount(0);
		await context.close();
	});


	test('Explore CONTINUES an existing project already linked to the contest — it never creates a duplicate', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		const created: { calls: Record<string, unknown>[] } = { calls: [] };
		// A build project already linked to cand-1's URL is in the list.
		await stubAccount(context, [PROJECT_LINKED]);
		await stubDiscovery(context, state);
		await stubCreateProject(context, created);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		await page.getByTestId('explore-ideas-cand-1').click();
		await expect(page).toHaveURL(/\/app\/project\?project=proj-linked$/);
		expect(created.calls).toHaveLength(0); // continued, not recreated
		await context.close();
	});

	test('a denied candidates list renders the explicit classified error', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.candidatesStatus = 403;
		state.candidatesBody = { error: 'not_a_member', message: 'you are not a member of this project' };
		await stubAccount(context, [PROJECT_A]);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		const alert = page.getByRole('alert');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('Denied: you are not a member of this project');
		await context.close();
	});

	test('the legacy /discovery deep link redirects to /discover (never a dead end)', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		await stubAccount(context, [PROJECT_A]);
		await stubDiscovery(context, state);
		const page = await context.newPage();

		await page.goto(`${BASE}/app/discovery?project=proj-a`);
		await expect(page).toHaveURL(/\/app\/discover(\?project=proj-a)?$/);
		await expect(page.getByTestId('discovery-results')).toBeVisible();
		await context.close();
	});

	test('Discover is a first-class capsule destination from Home', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		await stubAccount(context, []);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		await expect(page.getByTestId('nav-capsule')).toBeVisible();
		await page.getByTestId('nav-discover').click();
		await expect(page).toHaveURL(/\/app\/discover$/);
		await expect(page.getByTestId('discovery-results')).toBeVisible();
		await context.close();
	});
});
