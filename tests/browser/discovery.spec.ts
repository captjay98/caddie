import { expect, test, type BrowserContext, type Page } from '@playwright/test';
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

async function exploreIdeas(page: Page, candidateId: string) {
    await page.getByTestId(`disc-open-${candidateId}`).click();
    await page.getByTestId('contest-detail-pane').getByRole('button',{name:'Find an idea',exact:true}).click();
}

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
	savedIds: string[];
	savedCalls: { url: string }[];
	acceptedCalls: { url: string }[];
}

function initialState(): StubState {
	return {
		feedRuns: [],
		evaluated: { evaluations: [], ranked: [], profileCountry: null },
		candidatesStatus: 200,
		candidatesBody: {},
		acceptedIds: [],
		savedIds: [],
		savedCalls: [],
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
						statement: 'Teams of 1-4 may enter (on record: 1-4)',
						evidenceClaimIds: ['cl-team-1'],
						assumptions: [],
					},
					{
						requirement: 'Open to international entrants',
						claimType: 'region',
						verdict: 'unknown',
						statement: 'Open to international entrants (nothing on record yet)',
						evidenceClaimIds: [],
						assumptions: ['Not counted as a fit until Caddie has read a rule about it.'],
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
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
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
		// B01: save/unsave bookmarks — the stub tracks saved ids and the
		// candidates listing reflects them (read state is dynamic, like reads).
		if (/\/candidates\/[^/]+\/save$/.test(path)) {
			const candidateId = path.split('/')[6];
			state.savedCalls.push({ url: request.url() });
			if (request.method() === 'POST') {
				if (!state.savedIds.includes(candidateId ?? '')) state.savedIds.push(candidateId ?? '');
				return json(route, 200, { candidate: { id: candidateId, savedAt: NOW, status: 'new' } });
			}
			state.savedIds = state.savedIds.filter((id) => id !== candidateId);
			return json(route, 200, { candidate: { id: candidateId, savedAt: null, status: 'new' } });
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
        if (path.endsWith('/detail')) return json(route,200,{
            candidate:{id:'cand-1',url:CAND_1_URL,title:'Solar Hackweek',summary:'Build a climate dashboard in a weekend.'},
            eligibility:{verdict:'eligible'},digest:null,digestGap:'No summary in this fixture.',
            groups:[{kind:'entry',label:'Entry requirements',claims:[{claimId:'cl-team-1',claimType:'team',quote:'Teams of 1–4 may enter.',verdict:'eligible',reason:'Team size fits'}]}]
        });
		if (path.endsWith('/candidates')) {
			if (state.candidatesStatus !== 200) {
				return json(route, state.candidatesStatus, state.candidatesBody);
			}
			const evaluated = structuredClone(state.evaluated) as {
				evaluations: { candidate: { id: string; status: string; savedAt?: string | null } }[];
			};
			for (const evaluation of evaluated.evaluations) {
				evaluation.candidate.savedAt = state.savedIds.includes(evaluation.candidate.id) ? NOW : null;
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
		await expect(page.getByTestId('discovery-empty')).toBeVisible();
		await expect(page.getByText("Let's see what's out there")).toBeVisible();
		await expect(page.getByTestId('discovery-sweep-empty')).toBeVisible();
		// The empty state carries ONE sweep CTA — the results toolbar (and its
		// country chip) only appears once candidates are ranked.
		await expect(page.getByTestId('discovery-sweep')).toHaveCount(0);
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
		// v2 verdict words (§6): plain, never jargon. A dense row shows the short
		// chip and carries the full verdict as its title (hackathon-format.ts).
		// The hard-ineligible row is hidden until the named reveal is used.
		await expect(page.getByTestId('eligibility-cand-1')).toHaveText('Can enter');
		await expect(page.getByTestId('eligibility-cand-1')).toHaveAttribute('title', 'You can enter');
		await expect(page.getByText("Can't enter", { exact: true })).toHaveCount(0);
		await page.getByTestId('discovery-reveal-ineligible').click();
		await expect(page.getByText("Can't enter", { exact: true })).toBeVisible();
		await page.getByTestId('disc-open-cand-1').click();
        await expect(page.getByTestId('contest-detail-pane')).toBeVisible();
        // One reason it fits: the first evidenced claim's statement, in the
		// row's "Why it fits" fold (collapsed by default since the 2026-10-15 card).
		await page.getByTestId('disc-fit-cand-1').locator('summary').click();
		await expect(page.getByTestId('disc-fit-cand-1').getByText('Teams of 1-4 may enter (on record: 1-4)')).toBeVisible();

		await page.getByTestId('contest-detail-close').click();

		// Partial feed failure is a VISIBLE, NAMED gap — never silently dropped.
		const gaps = page.getByRole('status').filter({ hasText: 'Some sources failed' });
		await expect(gaps).toBeVisible();
		await expect(gaps).toContainText('devpost failed — upstream returned 503 (recorded receipt)');

		await expect(page.getByTestId('discovery-country')).toContainText('United States');

		// The fit reason cites its evidence claim id, and a claim Caddie could
		// not confirm is shown under it with the assumption it recorded, so a
		// fit is never presented as more certain than it is.
		await page.getByTestId('disc-open-cand-1').click();
        const fit = page.getByTestId('disc-fit-cand-1');
        await fit.locator('summary').click();
		await expect(fit).toContainText('evidence: cl-team-1');
		const open = page.getByTestId('disc-open-claims-cand-1');
		await expect(open).toBeVisible();
		await expect(open).toContainText('Not confirmed yet');
		await expect(open).toContainText('Open to international entrants · no rule on record yet');
		await expect(open).toContainText('Assumption: Not counted as a fit until Caddie has read a rule about it.');
		// Review screenshot of the open fold (same switch as interactive-preview.spec.ts).
		if (process.env.CADDIE_SHOTS) {
			if (process.env.CADDIE_SHOTS_MOBILE) await page.setViewportSize({ width: 390, height: 844 });
			await page.getByTestId('disc-row-cand-1').screenshot({
				path: join(process.env.CADDIE_SHOTS, `why-it-fits${process.env.CADDIE_SHOTS_MOBILE ? '-mobile' : ''}.png`),
			});
		}

		// No invented links: every outbound link on the page is a recorded
		// candidate URL — and no win probability exists anywhere in this surface.
		const outbound = await page.locator('a[href^="http"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
		const fixture = WITH_CANDIDATES as { evaluations: { candidate: { url: string } }[] };
		const recorded = new Set(fixture.evaluations.map((evaluation) => evaluation.candidate.url));
		for (const href of outbound) expect(recorded.has(href ?? '')).toBe(true);
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

		await expect(page.getByTestId('disc-row-cand-1').getByRole('button',{name:'Find an idea',exact:true})).toHaveCount(0);
        await page.getByTestId('disc-open-cand-1').click();
        await expect(page.getByTestId('contest-detail-pane').getByRole('button',{name:'Find an idea',exact:true})).toBeVisible();
		await expect(page.getByTestId('save-candidate-cand-1')).toBeVisible();
		// The redesign replaces "Accept" with an explicit explore/save pair.
		await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
		await context.close();
	});

	test('Save posts the real save route (never accept, never a project); Explore commits to one with the contest link', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		const created: { calls: Record<string, unknown>[] } = { calls: [] };
		await stubAccount(context, [PROJECT_A]);
		await stubDiscovery(context, state);
		await stubCreateProject(context, created);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discover`);

		// B01: saving hits the real save route — never the accept route, never
		// a project creation.
		await page.getByTestId('save-candidate-cand-1').click();
        await expect(page.getByTestId('contest-detail-pane')).toHaveCount(0);
		// The v2 row marks a saved event with its Saved (unsave) button.
		await expect(page.getByTestId('unsave-candidate-cand-1')).toHaveAttribute('aria-pressed','true');
		expect(state.acceptedCalls).toHaveLength(0);
		expect(state.savedCalls).toHaveLength(1);
		expect(new URL(state.savedCalls[0]!.url).pathname).toBe(
			'/api/projects/home-1/discovery/candidates/cand-1/save',
		);
		expect(created.calls).toHaveLength(0); // no project created by Save

		// Exploring the other candidate opens the two-step idea flow; cand-2 is
		// hard-ineligible, so it must be revealed first (hidden by default).
		await page.getByTestId('discovery-reveal-ineligible').click();
		await exploreIdeas(page, 'cand-2');
        await expect(page.getByTestId('contest-detail-pane')).toHaveCount(0);
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

		await exploreIdeas(page, 'cand-1');
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

		// Save cand-1 (B01: the real saved bookmark, never an accept).
		await page.getByTestId('save-candidate-cand-1').click();
        await expect(page.getByTestId('contest-detail-pane')).toHaveCount(0);
		// The v2 row marks a saved event with its Saved (unsave) button.
		await expect(page.getByTestId('unsave-candidate-cand-1')).toHaveAttribute('aria-pressed','true');

		// The Saved segment isolates the bookmark; unsave returns it to For you.
		await page.getByTestId('discovery-view-saved').click();
		await expect(page.getByTestId('eligibility-cand-1')).toBeVisible();
		await expect(page.getByTestId('eligibility-cand-2')).toHaveCount(0);
		await page.getByTestId('unsave-candidate-cand-1').click();
		await expect(page.getByTestId('discovery-view-saved').locator('..')).toBeVisible(); // stays on Saved
		await expect(page.locator('.disc-list [data-testid="eligibility-cand-1"]')).toHaveCount(0);

		// Hard-ineligible rows are hidden by default behind a named reveal.
		await page.getByTestId('discovery-view-foryou').click();
		await expect(page.getByTestId('eligibility-cand-2')).toHaveCount(0);
		const reveal = page.getByTestId('discovery-reveal-ineligible');
		await expect(reveal).toContainText("Show 1 you can't enter");
		await reveal.click();
		await expect(page.getByTestId('eligibility-cand-2')).toBeVisible();

		// The can-enter filter narrows to eligible candidates only.
		await page.getByTestId('discovery-filter-toggle').click();
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

		await exploreIdeas(page, 'cand-1');
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

test('populated discovery cards, facts and toolbar stay inside narrow content bounds', async ({ browser },testInfo) => {
 const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
 const state = initialState();
 state.evaluated = structuredClone(WITH_CANDIDATES);
 const evaluated = state.evaluated as {evaluations:{candidate:Record<string,unknown>}[]};
 Object.assign(evaluated.evaluations[0]!.candidate,{title:'A developer hackathon with a long title that must remain readable on a phone',platform:'devpost.com',format:'online',themes:['Machine Learning/AI','A very long theme that should wrap instead of widening this card'],participants:59800,startsAt:'2026-08-31T00:00:00.000Z',endsAt:'2026-10-23T00:00:00.000Z'});
 (state.evaluated as Record<string,unknown>).card = {candidates:[{
  ...evaluated.evaluations[0]!.candidate, prize:'$138,000',deadline:null,organizer:null,topPick:false,eligibility:'eligible',eligibilityNote:'',eligibilityQuote:null,eligibilityNeedsConfirm:false,rulesUrl:null,openStatusUnverified:false,saved:false,aiFit:'unknown',aiFitReason:'',aiFitConfidence:null
 }],gaps:[],profileCountry:'US'};
 await stubAccount(context,[PROJECT_A]); await stubDiscovery(context,state);
 const page = await context.newPage(); await page.goto(`${BASE}/app/discover`);
 await expect(page.locator('.disc-row').first()).toBeVisible();
 await expect(page.locator('.disc-fact')).toHaveCount(2);
 await expect(page.getByTestId('discovery-filters')).toBeHidden();
 await page.getByTestId('discovery-filter-toggle').click();
 await expect(page.getByTestId('discovery-filters')).toBeVisible();
 for (const width of [412,390,320,768,1440]) {
  await page.setViewportSize({width,height:915});
  const overflow = await page.locator('.discovery-panel').evaluate(panel => {
   const bounds=panel.getBoundingClientRect();
   return [...panel.querySelectorAll('.disc-toolbar,.disc-row,.disc-row-title,.disc-fact,.disc-row-actions,.disc-country-chip,.disc-filter')].filter(el=>{
    const box=el.getBoundingClientRect();return box.width>0 && (box.right>bounds.right+1 || box.left<bounds.left-1 || el.scrollWidth>el.clientWidth+1);
   }).map(el=>el.className);
  });
  expect(overflow,`overflow at ${width}px`).toEqual([]);
  expect(await page.locator('.disc-row').first().evaluate(el=>el.getBoundingClientRect().height),`card height at ${width}px`).toBeLessThan(270);
  await expect(page.getByRole('button',{name:'View opportunity',exact:true})).toHaveCount(0);
  const card=page.locator('.disc-row').first();
  const alignment=await card.evaluate(el=>{const h=el.querySelector('.disc-event-host')!.getBoundingClientRect(),v=el.querySelector('.disc-entry-status')!.getBoundingClientRect();return {difference:Math.abs(h.y+h.height/2-v.y-v.height/2),display:getComputedStyle(el.querySelector('.disc-card-top')!).display};});
  expect(alignment.difference,JSON.stringify({width,...alignment})).toBeLessThan(2);
  await expect(card.getByRole('button',{name:'Find an idea',exact:true})).toHaveCount(0);
  expect((await card.locator('.disc-bookmark').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if(width===412) await page.screenshot({path:testInfo.outputPath('discovery-mobile-contained.png')});
 }
 await context.close();
});


test('Fit first detail retains supporting facts, prizes and exact rules behind readable sections', async ({ browser }) => {
 const context = await browser.newContext({viewport:{width:390,height:844}});
 const state = initialState(); state.evaluated = structuredClone(WITH_CANDIDATES);
 const record=(state.evaluated as {evaluations:{candidate:Record<string,unknown>}[]}).evaluations[0]!.candidate;
 (state.evaluated as Record<string,unknown>).card={candidates:[{...record,platform:'devpost.com',organizer:'Solar organisers',format:'online',startsAt:'2026-10-01',endsAt:'2026-10-23',deadline:'2026-10-23',prize:'$5,000',participants:100,themes:['Climate','Energy','Open-ended'],topPick:false,eligibility:'eligible',eligibilityNote:'',eligibilityQuote:'International entrants may participate.',eligibilityNeedsConfirm:false,rulesUrl:'https://contest.example/solar-hackweek/rules',openStatusUnverified:false,saved:false,aiFit:'unknown',aiFitReason:'',aiFitConfidence:null}],gaps:[],profileCountry:'US'};
 await stubAccount(context,[PROJECT_A]); await stubDiscovery(context,state);
 await context.route('**/candidates/cand-1/detail?digest=defer',route=>route.fulfill({json:{
  candidate:{id:'cand-1',url:CAND_1_URL,title:'Solar Hackweek',summary:'Build a solar project'},eligibility:{verdict:'eligible'},
  officialPrizes:[{label:'First place',amount:'$5,000',quantity:'2',eligibility:'Working solar prototypes'},{label:'Hardware and hosting award',amount:'$25,000 cash * $15,000 AWS Credits * Meeting with Amazon Developer team * Project featured on Amazon Developer channels',quantity:'1',eligibility:'All qualifying working applications'}],prizesSourceUrl:'https://contest.example/solar-hackweek/rules',
  digest:{headline:'Build a solar project',bullets:['Deadline → Oct 23, 2026 @ 12:00pm PDT','Format → Online'],watchOut:'Submit before the deadline',tracks:[{name:'Clean energy',detail:'Reduce energy waste'}],prizes:[{label:'First place',amount:'$1'},{label:'Community award',amount:'$250'}],perks:['Cloud credits'],judging:['Working prototype'],fitTracks:[{name:'Clean energy',why:'Matches your interests'}]},
  digestGap:null,groups:[{kind:'entry',label:'Entry requirements',claims:[{claimId:'cl-entry',claimType:'country',quote:'International entrants may participate.',verdict:'eligible',reason:'Country requirement met'}]}]
 }}));
 const page = await context.newPage(); await page.goto(`${BASE}/app/discover`);
 await page.getByTestId('disc-open-cand-1').click();
 const pane=page.getByTestId('contest-detail-pane');
 await expect(pane).toBeVisible();
 await expect(pane.getByTestId('contest-detail-fit')).toBeVisible();
 await expect(pane.getByTestId('contest-detail-key-details')).toBeVisible();
 await expect(pane.getByText('Oct 23, 2026 @ 12:00pm PDT',{exact:true})).toBeVisible();
 await expect(pane.getByRole('heading',{name:'At a glance',exact:true})).toHaveCount(0);
 await expect(pane.getByRole('heading',{name:'Event details',exact:true})).toHaveCount(0);
 await expect(pane.getByTestId('contest-detail-key-details').getByText('Online',{exact:true})).toHaveCount(1);
 await expect(pane.getByRole('button',{name:'More about the challenge'})).toHaveCount(0);
 const back=await pane.getByTestId('contest-detail-close').boundingBox();
 const title=await pane.locator('.cdp-title').boundingBox();
 expect(back!.y+back!.height).toBeLessThanOrEqual(title!.y);
 for(const button of await pane.locator('.cdp-foot > *').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
 await pane.getByTestId('contest-detail-source-summary').locator('summary').click();
 await expect(pane.getByTestId('contest-detail-source-summary')).toContainText('Build a solar project');
 await expect(pane.getByRole('tab',{name:'Overview',exact:true})).toHaveAttribute('aria-selected','true');
 await pane.getByRole('tab',{name:'Prizes',exact:true}).click();
 await expect(pane.getByText('$5,000',{exact:true})).toBeVisible();
 await expect(pane.getByText('$1',{exact:true})).toHaveCount(0);
 await pane.locator('.cdp-unmatched-prizes').locator('summary').click();
 await expect(pane.getByText('Community award',{exact:true})).toBeVisible();
 await expect(pane.getByText('$250',{exact:true})).toBeVisible();
 await expect(pane.getByText('Number of awards: 2')).toBeVisible();
 await pane.getByRole('tab',{name:'Build',exact:true}).click();
 await expect(pane.getByTestId('contest-detail-tracks')).toContainText('Reduce energy waste');
 await expect(pane.getByTestId('contest-detail-tracks').locator('[data-fit="true"]')).toContainText('Clean energy');
 await expect(pane.getByTestId('contest-detail-judging')).toContainText('Working prototype');
 await pane.getByRole('tab',{name:'Entry rules',exact:true}).click();
 await expect(pane.getByTestId('contest-detail-verdict')).toContainText('Your profile matches');
 await expect(pane.getByTestId('contest-detail-group-entry')).toHaveAttribute('open','');
 await expect(pane.getByText('“International entrants may participate.”')).toBeVisible();
 await expect(pane.getByRole('tabpanel',{name:'Entry rules',exact:true}).locator('.hk-why')).toHaveCount(0);
 await expect(pane.getByRole('link',{name:'Official entry rules',exact:true})).toHaveAttribute('href','https://contest.example/solar-hackweek/rules');
 for(const width of [320,390,768,1440]) {
  await page.setViewportSize({width,height:915});
  expect(await pane.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await pane.getByRole('tab',{name:'Prizes',exact:true}).click();
  expect(await pane.locator('.cdp-item-amount,.cdp-prize-benefits li').evaluateAll(elements=>elements.filter(el=>el.getBoundingClientRect().width>0).every(el=>el.scrollWidth<=el.clientWidth+1))).toBe(true);
  await pane.getByRole('tab',{name:'Entry rules',exact:true}).click();
 }
 await pane.getByRole('tab',{name:'Entry rules',exact:true}).press('ArrowLeft');
 await expect(pane.getByRole('tab',{name:'Build',exact:true})).toBeFocused();
 await expect(pane.getByText('Submit before the deadline')).toBeVisible();
 await page.getByTestId('contest-detail-close').click();
 await expect(pane).toHaveCount(0); await expect(page.getByTestId('disc-row-cand-1')).toBeVisible();
 await page.getByTestId('disc-row-cand-1').click({position:{x:5,y:5}});
 await expect(pane).toBeVisible();
 await expect(pane.getByRole('tab',{name:'Overview',exact:true})).toHaveAttribute('aria-selected','true');
 await page.keyboard.press('Escape');
 await expect(pane).toHaveCount(0);
 await context.close();
});


test('stored fit evidence and source summary survive a failed detail request', async ({ browser }) => {
 const context = await browser.newContext();
 const state=initialState(); state.evaluated=structuredClone(WITH_CANDIDATES);
 await stubAccount(context,[PROJECT_A]); await stubDiscovery(context,state);
 await context.route('**/candidates/cand-1/detail?digest=defer',route=>route.fulfill({status:503,json:{error:'detail_temporarily_unavailable'}}));
 const page=await context.newPage(); await page.goto(`${BASE}/app/discover`);
 await page.getByTestId('disc-open-cand-1').click();
 const pane=page.getByTestId('contest-detail-pane');
 const fit=pane.getByTestId('disc-fit-cand-1');
 await fit.locator('summary').click();
 await expect(fit).toContainText('evidence: cl-team-1');
 await pane.getByTestId('contest-detail-source-summary').locator('summary').click();
 await expect(pane.getByTestId('contest-detail-source-summary')).toContainText('Build a climate dashboard');
 await expect(pane.getByText('Could not load this hackathon')).toBeVisible({timeout:15000});
 await expect(fit).toBeVisible();
 await expect(pane.getByRole('tab',{name:'Entry rules',exact:true})).toHaveAttribute('aria-controls',/.+-entry$/);
 await context.close();
});
