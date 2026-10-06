import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P11 browser acceptance — the REAL DiscoveryResults component, mounted at
 * the /discovery client route (apps/app/src/client/surface.tsx + routes.tsx),
 * driven against the COMPOSED build (`bun run build` first; local workerd on
 * 127.0.0.1:4173, SPA under /app). The P11 server router IS real
 * (apps/app/src/server/routes/discovery.ts, mounted at /api in app.ts) — the
 * endpoints are stubbed here at the network layer for deterministic UI-state
 * proofs, mirroring the exact payload shapes of that router (same split and
 * classification as workspace.spec.ts: these are UI-state proofs; the
 * real-data behavior is P11's integration suite, tests/discovery.test.ts +
 * tests/planning.integration.test.ts on real workerd + D1).
 *
 * Honesty rules proven here (packets P11, feature-ledger C10):
 *   - unauthenticated /app/discovery fails closed to the real sign-in state;
 *   - an empty feed says so — no invented candidates;
 *   - a failed source is a visible, NAMED feed gap with its reason, never a
 *     silently dropped source;
 *   - eligibility renders conservative verdicts (ELIGIBLE / HARD-INELIGIBLE /
 *     UNKNOWN) and fit detail cites the evidence claim ids or records the
 *     assumption — no invented links and no win probability anywhere.
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

function project(id: string, name: string) {
	return {
		id,
		workspaceId: 'ws-1',
		name,
		description: null,
		contestId: null,
		contestUrl: null,
		status: 'active',
		createdAt: NOW,
		updatedAt: NOW,
	};
}

const PROJECT_A = project('proj-a', 'Pit wall');

/** Mutated by handlers/steps so each test drives its own honest state. */
interface StubState {
	feedRuns: {
		id: string;
		requestedAt: string;
		sources: { source: string; outcome: 'succeeded' | 'failed'; failureReason: string | null; candidateCount: number }[];
	}[];
	evaluated: unknown;
	/** Non-200 forces the classified failure path on the candidates list. */
	candidatesStatus: number;
	candidatesBody: Record<string, unknown>;
	/** Candidate ids accepted through the real POST route this run. */
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
				url: 'https://contest.example/solar-hackweek',
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

async function stubSession(context: BrowserContext) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Test', email: 't@caddie.test' } }),
	);
	await context.route('**/api/projects', (route) =>
		route.request().method() === 'GET' ? json(route, 200, { projects: [PROJECT_A] }) : json(route, 405, { error: 'method_not_allowed' }),
	);
	// Default project children to honest empties (the surface page itself only
	// reads /api/projects; the namespace stub below overrides its slice).
	await context.route('**/api/projects/**', (route) => json(route, 200, {}));
}

/** One explicit handler for the whole P11 discovery namespace. */
async function stubDiscovery(context: BrowserContext, state: StubState) {
	// The generic project-children default must not shadow this namespace.
	await context.unroute('**/api/projects/**');
	await context.route('**/api/projects/proj-a/discovery/**', (route) => {
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
			// /api/projects/proj-a/discovery/candidates/<id>/accept → segment 6
			const candidateId = path.split('/')[6];
			state.acceptedIds.push(candidateId ?? '');
			state.acceptedCalls.push({ url: request.url() });
			return json(route, 200, {
				candidate: {
					id: candidateId,
					url: 'https://contest.example/solar-hackweek',
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
			// Serve the list fresh each time, with the accepted status the real
			// service would persist after a POST to the accept route.
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

// --- tests ------------------------------------------------------------------------

test.describe('P11 discovery surface (composed build, stubbed /api)', () => {
	test('unauthenticated /app/discovery shows the real sign-in state (live probe, no stubs)', async ({ page }) => {
		await page.goto(`${BASE}/app/discovery`);
		await expect(page.getByTestId('sign-in-panel')).toBeVisible();
		// The discovery surface itself must not render for an unverified session.
		await expect(page.locator('section[aria-label="Discovery results"]')).toHaveCount(0);
	});

	test('authed surface with no candidates renders the honest empty feed', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		await stubSession(context);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discovery?project=proj-a`);

		await expect(page.locator('section[aria-label="Discovery results"]')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Discovery' })).toBeVisible();
		await expect(page.getByText('No candidates yet — run the feed.')).toBeVisible();
		// No profile country on record → the honest UNKNOWN note, never a guess.
		await expect(page.getByText('none recorded — country rules stay UNKNOWN')).toBeVisible();
		await context.close();
	});

	test('candidates render eligibility verdicts, evidence-backed fit and named feed gaps — no invented links, no win probability', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		state.feedRuns = FEED_WITH_GAP;
		await stubSession(context);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discovery?project=proj-a`);

		// Conservative eligibility labels, ranked demotion without relabeling.
		await expect(page.getByText('Solar Hackweek')).toBeVisible();
		await expect(page.getByText('ELIGIBLE', { exact: true })).toBeVisible();
		await expect(page.getByText('HARD-INELIGIBLE', { exact: true })).toBeVisible();
		await expect(page.getByText('fit: 2 requirement(s) evidenced')).toBeVisible();

		// Partial feed failure is a VISIBLE, NAMED gap — never silently dropped.
		const gaps = page.getByRole('status').filter({ hasText: 'Feed gaps' });
		await expect(gaps).toBeVisible();
		await expect(gaps).toContainText('devpost failed — upstream returned 503 (recorded receipt)');
		await expect(gaps).toContainText('its candidates are missing from this list');

		// Profile country is named as the basis for eligibility.
		await expect(page.getByText('Eligibility uses your profile country: US')).toBeVisible();

		// Fit detail cites the evidence claim id, or records its assumption.
		await page.getByRole('button', { name: 'Explain fit' }).first().click();
		await expect(page.getByText('SUPPORTED — The recorded rules state teams of 1-4 may enter.')).toBeVisible();
		await expect(page.getByText('evidence: cl-team-1')).toBeVisible();
		await expect(page.getByText('assumption: region rule assumed unrestricted absent a recorded rule')).toBeVisible();
		await expect(page.getByText('Quoted rule lists no region restriction.')).toBeVisible();

		// The only rendered link is the candidate's real recorded URL — and no
		// win probability exists anywhere in this surface.
		await expect(page.locator('a[href="https://contest.example/solar-hackweek"]')).toHaveCount(1);
		const body = await page.locator('body').innerText();
		expect(body).not.toMatch(/win (rate|probability|chance)/i);
		await context.close();
	});

	test('accept posts to the real accept route and the accepted status renders', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.evaluated = WITH_CANDIDATES;
		state.feedRuns = FEED_WITH_GAP;
		await stubSession(context);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discovery?project=proj-a`);

		await expect(page.getByText('Solar Hackweek')).toBeVisible();
		await page.getByRole('button', { name: 'Accept', exact: true }).first().click();

		// The real REST shape: POST /api/projects/:projectId/discovery/candidates/:id/accept
		await expect(page.getByText('status accepted')).toBeVisible();
		expect(state.acceptedCalls).toHaveLength(1);
		expect(new URL(state.acceptedCalls[0]!.url).pathname).toBe(
			'/api/projects/proj-a/discovery/candidates/cand-1/accept',
		);
		// The accepted row no longer offers Accept.
		await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(1); // cand-2 only
		await context.close();
	});

	test('a denied candidates list renders the explicit classified error', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		state.candidatesStatus = 403;
		state.candidatesBody = { error: 'not_a_member', message: 'you are not a member of this project' };
		await stubSession(context);
		await stubDiscovery(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/discovery?project=proj-a`);

		const alert = page.getByRole('alert');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('Denied: you are not a member of this project');
		await context.close();
	});

	test('entry points reach the surface: the workspace topbar link and the onboarding discovery card', async ({ browser }) => {
		const context = await browser.newContext();
		const state = initialState();
		await stubSession(context);
		await stubDiscovery(context, state);
		const page = await context.newPage();

		// Topbar: Discovery carries the selected project through the search param.
		await page.goto(`${BASE}/app/?project=proj-a`);
		await expect(page.getByTestId('project-selector')).toHaveValue('proj-a');
		await page.getByTestId('nav-discovery').click();
		await expect(page).toHaveURL(/\/app\/discovery\?project=proj-a$/);
		await expect(page.locator('section[aria-label="Discovery results"]')).toBeVisible();

		// Onboarding: the formerly "Planned — arrives with P11" card is now a
		// real link, because the destination exists.
		await page.goto(`${BASE}/app/onboarding`);
		const card = page.getByTestId('start-card-discovery');
		await expect(card).toBeVisible();
		await expect(card).not.toHaveAttribute('data-coming-with');
		await page.getByTestId('start-discovery-go').click();
		await expect(page).toHaveURL(/\/app\/discovery$/);
		await expect(page.locator('section[aria-label="Discovery results"]')).toBeVisible();
		await context.close();
	});
});
