import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P13 browser acceptance — the REAL JudgeScorecard and SubmissionPackage
 * components, mounted at the /judge and /submission client routes
 * (apps/app/src/client/surface.tsx + routes.tsx), driven against the
 * COMPOSED build (`bun run build` first; local workerd on 127.0.0.1:4173,
 * SPA under /app). The P13 endpoints are stubbed here at the network layer
 * for deterministic UI-state proofs, mirroring the payload shapes of
 * apps/app/src/server/judge.ts + submission.ts (same classification as
 * workspace.spec.ts: UI-state proofs here; the real-data behavior is P13's
 * integration suite — tests/judge.test.ts + tests/submission.test.ts).
 *
 * Honesty rules proven here (packets P13, feature-ledger C15/C16):
 *   - an empty rubric stays empty (no generic criteria fallback) and its
 *     warnings render; the coaching average keeps its not-a-prediction label
 *     verbatim — no win probability anywhere;
 *   - access badges separate DECLARED from VERIFIED (receipt-backed);
 *   - the checklist renders only cited requirements; a missing requirement
 *     stays MISSING, and readiness BLOCKED/STALE states are named, never
 *     smoothed away;
 *   - export CTA states are honest: record/copy disabled until an export
 *     exists, hash + rules version shown, a rule change marks the export
 *     STALE, and "record submitted" only ever RECORDS the human's
 *     attestation (the tool never submits anywhere).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-p13-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/submission.spec.ts');
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

// --- fixture data (mirrors the real P13 payload shapes) ---------------------------

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

const EMPTY_RUBRIC_PAYLOAD = {
	rubric: {
		criteria: [],
		warnings: ['no rubric-bearing claims are on record for this project'],
		conflicts: [],
		hash: 'sha256-empty000000000000',
		extractionVersion: 'extract-v2',
	},
	assessment: [],
};

const RUBRIC_PAYLOAD = {
	rubric: {
		criteria: [
			{ text: 'Demo video link is provided', weight: null, claimIds: ['cl-vid'] },
			{ text: 'Working public repository link', weight: 40, claimIds: ['cl-repo'] },
		],
		warnings: ['two sources disagree about the repo weight — conflict retained'],
		conflicts: [{ criterionKey: 'repo-weight', claimIds: ['cl-repo', 'cl-repo-2'] }],
		hash: 'sha256-abc123def456abc123def',
		extractionVersion: 'extract-v2',
	},
	assessment: [
		{
			criterionText: 'Demo video link is provided',
			verified: [],
			declared: [
				{ level: 'declared', ref: { id: 'cl-vid', kind: 'claim', text: 'we plan to record a demo video' } },
			],
			access: 'declared',
		},
		{
			criterionText: 'Working public repository link',
			verified: [
				{ level: 'verified_local', ref: { id: 'rc-1', kind: 'receipt', text: 'git ls-remote exit 0' } },
			],
			declared: [],
			access: 'verified_local',
		},
	],
};

function scorecard(id: string) {
	return {
		id,
		rubricHash: 'sha256-abc123def456abc123def',
		scoringVersion: 'score-v1',
		result: {
			criteria: [],
			topRisks: ['repo link is only verified locally'],
			coachingAverage: 6.5,
			averageLabel: 'Coaching average — not a prediction',
		},
		createdAt: NOW,
	};
}

const RULES_NOW = 'rules-2026.10.04-a1b2c3';

function packageRecord(reuseState: 'unconfirmed' | 'confirmed' = 'unconfirmed') {
	return {
		id: 'pkg-1',
		title: 'Pit wall', // the PROJECT title — never an invented contest title
		reuseRequired: true,
		reuseState,
		reuseConfirmedBy: reuseState === 'confirmed' ? 'actor-test' : null,
		requirementsVersion: RULES_NOW,
	};
}

const CHECKLIST = [
	{
		id: 'chk-1',
		kind: 'video',
		requirementText: 'A demo video link is required',
		citation: { claimId: 'cl-vid', quote: 'Submissions must include a demo video', url: 'https://contest.example/rules' },
		status: 'missing',
		evidence: [],
	},
	{
		id: 'chk-2',
		kind: 'repo',
		requirementText: 'Provide a public repository URL',
		citation: { claimId: 'cl-repo', quote: 'Provide a public repository URL', url: 'https://contest.example/rules' },
		status: 'verified',
		evidence: [{ refId: 'rc-2', basis: 'git ls-remote receipt' }],
	},
];

interface DetailShape {
	package: ReturnType<typeof packageRecord>;
	checklist: typeof CHECKLIST;
	exports: { id: string; exportHash: string; requirementsVersion: string; packageJson: string; createdAt: string }[];
	confirmations: { id: string; exportId: string; exportHash: string; attestations: string[]; note: string | null; confirmedAt: string }[];
	readiness: { status: string; currentRequirementsVersion: string; reasons: string[] };
}

function blockedDetail(): DetailShape {
	return {
		package: packageRecord(),
		checklist: CHECKLIST,
		exports: [],
		confirmations: [],
		readiness: {
			status: 'blocked',
			currentRequirementsVersion: RULES_NOW,
			reasons: ['checklist has gaps on record', 'reuse disclosure is unconfirmed'],
		},
	};
}

const STALE_EXPORT = {
	id: 'exp-1',
	exportHash: 'sha256-feedbeeffeedbeeffeed',
	requirementsVersion: 'rules-2026.10.01-0000000', // rules BEFORE the current version
	packageJson: '{"title":"Pit wall"}',
	createdAt: '2026-10-01T10:00:00.000Z',
};

function staleDetail(): DetailShape {
	return {
		package: packageRecord(),
		checklist: CHECKLIST,
		exports: [STALE_EXPORT],
		confirmations: [],
		readiness: {
			status: 'stale',
			currentRequirementsVersion: RULES_NOW,
			reasons: ['rules changed after the latest export'],
		},
	};
}

interface JudgeState {
	assessment: unknown;
	scorecards: unknown[];
	recorded: { url: string; body: Record<string, unknown> }[];
}

interface SubmissionState {
	packages: unknown[];
	detail: DetailShape | null;
	created: { url: string; body: Record<string, unknown> } | null;
	confirmation: { url: string; body: Record<string, unknown> } | null;
}

// --- stubbing helpers (workspace.spec.ts grammar) ---------------------------------
//
// Playwright matches the MOST RECENTLY registered route first, so the
// namespace stubs below (registered after stubSession) take precedence over
// the generic project-children default for their URL slices.

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
	// Default project children to honest empties (run-bindings, artifacts…).
	await context.route('**/api/projects/**', (route) => json(route, 200, {}));
}

async function stubJudge(context: BrowserContext, state: JudgeState) {
	await context.route('**/api/projects/proj-a/judge/**', (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path.endsWith('/assessment')) return json(route, 200, state.assessment);
		if (path.endsWith('/scorecards')) {
			if (request.method() === 'POST') {
				const body = request.postDataJSON() as Record<string, unknown>;
				state.recorded.push({ url: request.url(), body });
				state.scorecards.unshift(scorecard(`sc-${state.scorecards.length + 1}`));
				return json(route, 201, { scorecard: state.scorecards[0] });
			}
			return json(route, 200, { scorecards: state.scorecards });
		}
		return json(route, 404, { error: 'not_found' });
	});
}

async function stubSubmission(context: BrowserContext, state: SubmissionState) {
	await context.route('**/api/projects/proj-a/submission/**', (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;

		// Recording the submission: only ever stores the human's attestation,
		// bound to the exported hash.
		if (/\/exports\/[^/]+\/confirmations$/.test(path)) {
			const body = request.postDataJSON() as { exportId: string; attestations: string[]; note: string | null };
			state.confirmation = { url: request.url(), body };
			state.detail?.confirmations.unshift({
				id: 'cfm-1',
				exportId: body.exportId,
				exportHash: STALE_EXPORT.exportHash,
				attestations: body.attestations,
				note: body.note,
				confirmedAt: NOW,
			});
			return json(route, 201, { confirmation: state.detail?.confirmations[0] ?? null });
		}

		// Export snapshot: appends an export at the CURRENT rules version.
		if (/\/exports$/.test(path) && request.method() === 'POST') {
			const created = {
				id: 'exp-2',
				exportHash: 'sha256-cafecafecafecafecafe',
				requirementsVersion: RULES_NOW,
				packageJson: '{"title":"Pit wall","fresh":true}',
				createdAt: NOW,
			};
			state.detail?.exports.unshift(created);
			return json(route, 201, { export: created });
		}

		if (/\/packages$/.test(path)) {
			if (request.method() === 'POST') {
				state.created = { url: request.url(), body: request.postDataJSON() as Record<string, unknown> };
				// The real service creates the package synchronously; its detail
				// (with the checklist derived from cited requirements) is what a
				// subsequent GET returns.
				state.packages = [packageRecord()];
				state.detail = blockedDetail();
				return json(route, 201, { package: packageRecord() });
			}
			return json(route, 200, { packages: state.packages });
		}

		if (/\/packages\/[^/]+$/.test(path)) {
			if (request.method() === 'POST') {
				// Confirm-reuse is the human's action; the stub flips the state.
				const detail = state.detail;
				if (detail) {
					detail.package = packageRecord('confirmed');
				}
				return json(route, 200, { package: detail?.package ?? null });
			}
			return json(route, 200, state.detail);
		}

		return json(route, 404, { error: 'not_found' });
	});
}

// --- tests ------------------------------------------------------------------------

test.describe('P13 judge + submission surfaces (composed build, stubbed /api)', () => {
	test('unauthenticated /app/submission shows the real sign-in state (live probe, no stubs)', async ({ page }) => {
		await page.goto(`${BASE}/app/submission`);
		await expect(page.getByTestId('sign-in-panel')).toBeVisible();
		await expect(page.locator('section[aria-label="Submission package"]')).toHaveCount(0);
		await expect(page.locator('section[aria-label="Judge scorecard"]')).toHaveCount(0);
	});

	test('judge: an empty rubric stays empty with its warning — never a generic criteria set', async ({ browser }) => {
		const context = await browser.newContext();
		const state: JudgeState = { assessment: EMPTY_RUBRIC_PAYLOAD, scorecards: [], recorded: [] };
		await stubSession(context);
		await stubJudge(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/judge?project=proj-a`);

		await expect(page.locator('section[aria-label="Judge scorecard"]')).toBeVisible();
		await expect(page.getByText('No judging criteria are on record in this project')).toBeVisible();
		await expect(page.getByText('no rubric-bearing claims are on record for this project')).toBeVisible();
		// No scoring controls can exist against a rubric that does not exist.
		await expect(page.getByText('score (0–10)')).toHaveCount(0);
		await context.close();
	});

	test('judge: rubric renders access badges, retained conflicts, not-a-prediction average; scoring posts the real payload', async ({ browser }) => {
		const context = await browser.newContext();
		const state: JudgeState = { assessment: RUBRIC_PAYLOAD, scorecards: [scorecard('sc-1')], recorded: [] };
		await stubSession(context);
		await stubJudge(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/judge?project=proj-a`);

		// Access badges separate declared from verified — receipts decide.
		await expect(page.getByText('DECLARED ONLY', { exact: true })).toBeVisible();
		await expect(page.getByText('VERIFIED (local)', { exact: true })).toBeVisible();
		// Weights are never guessed: unclaimed stays "not claimed".
		await expect(page.getByText('weight: not claimed (never guessed)')).toBeVisible();
		await expect(page.getByText('weight: 40%')).toBeVisible();

		// Warnings and retained conflicts are visible, never smoothed away.
		const warnings = page.getByRole('status').filter({ hasText: 'Rubric warnings' });
		await expect(warnings).toBeVisible();
		await expect(warnings).toContainText('two sources disagree about the repo weight');
		const conflicts = page.getByRole('status').filter({ hasText: 'Retained conflicts' });
		await expect(conflicts).toBeVisible();
		await expect(conflicts).toContainText('repo-weight');

		// The recorded card renders the coaching average + label verbatim.
		await expect(page.getByText('6.5 — Coaching average — not a prediction')).toBeVisible();
		await expect(page.getByText('repo link is only verified locally')).toBeVisible();

		// Show evidence expands receipts vs claims-only separately.
		await page.getByRole('button', { name: 'Show evidence' }).first().click();
		await expect(page.getByText('none — nothing verified for this criterion')).toBeVisible();
		await expect(page.getByText('we plan to record a demo video')).toBeVisible();

		// Scoring posts the real structured payload to the real route. The
		// unscored criterion posts score 0 — server-side validation is the
		// real gate for that, not this UI-state proof.
		await page.locator('input[type="number"]').first().fill('7');
		await page.getByPlaceholder('notes (required)').first().fill('matches the recorded receipts');
		await page.getByRole('button', { name: 'Validate and record scorecard' }).click();
		await expect(page.getByRole('heading', { name: 'Recorded scorecards' })).toBeVisible();
		expect(state.recorded).toHaveLength(1);
		expect(new URL(state.recorded[0]!.url).pathname).toBe('/api/projects/proj-a/judge/scorecards');
		const body = state.recorded[0]!.body as {
			criteria: { criterion: string; score: number; notes: string }[];
			topRisks: string[];
		};
		expect(body.criteria).toEqual([
			{ criterion: 'Demo video link is provided', score: 7, notes: 'matches the recorded receipts' },
			{ criterion: 'Working public repository link', score: 0, notes: '' },
		]);
		expect(body.topRisks).toEqual([]);

		// The not-a-prediction grammar stays on the page, and there is no win
		// probability anywhere in this surface.
		await expect(
			page.getByText('they are not a prediction of how judges will score this project'),
		).toBeVisible();
		const pageText = await page.locator('body').innerText();
		expect(pageText).not.toMatch(/win (rate|probability|chance)/i);
		await context.close();
	});

	test('submission: no package renders the honest creation CTA; creation uses the real route; checklist renders only cited requirements', async ({ browser }) => {
		const context = await browser.newContext();
		const state: SubmissionState = { packages: [], detail: null, created: null, confirmation: null };
		await stubSession(context);
		await stubSubmission(context, state);
		const page = await context.newPage();

		await page.goto(`${BASE}/app/submission?project=proj-a`);
		await expect(page.locator('section[aria-label="Submission package"]')).toBeVisible();
		await expect(page.getByText('No package yet.')).toBeVisible();

		// Create with the reuse disclosure flagged; the real REST shape is
		// POST /api/projects/:projectId/submission/packages { reuseRequired }.
		await page.getByText('submitting requires a reuse disclosure').click();
		await page.getByRole('button', { name: 'Create package' }).click();
		expect(state.created).not.toBeNull();
		expect(new URL(state.created!.url).pathname).toBe('/api/projects/proj-a/submission/packages');
		expect(state.created!.body).toEqual({ reuseRequired: true });

		// The package title is the PROJECT title — never an invented contest.
		await expect(page.getByRole('region', { name: 'Submission package' }).getByText('Pit wall')).toBeVisible();
		await expect(page.getByText('BLOCKED (gaps on record)', { exact: true })).toBeVisible();
		const gaps = page.getByRole('status').filter({ hasText: 'Readiness gaps' });
		await expect(gaps).toBeVisible();
		await expect(gaps).toContainText('checklist has gaps on record');
		await expect(gaps).toContainText('reuse disclosure is unconfirmed');

		// Checklist rows exist only with their citation (claim id, quote, url);
		// a missing requirement stays MISSING — never filled in.
		await expect(page.getByText('A demo video link is required')).toBeVisible();
		await expect(page.getByText('MISSING', { exact: true })).toBeVisible();
		await expect(page.getByText('cited: cl-vid — “Submissions must include a demo video”')).toBeVisible();
		await expect(page.locator('a[href="https://contest.example/rules"]')).toHaveCount(2);
		await expect(page.getByText('backed by: rc-2 (git ls-remote receipt)')).toBeVisible();

		// Export/record CTAs are honest before any export exists.
		await expect(page.getByRole('button', { name: 'Copy latest export' })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Record submitted' })).toBeDisabled();
		await expect(page.getByText('This tool never submits anywhere. After you submit')).toBeVisible();

		// Reuse disclosure needs an explicit human confirmation; it rides the
		// real package route.
		await page.getByRole('button', { name: 'Confirm reuse disclosure (human)' }).click();
		await expect(page.getByText('reuse disclosure confirmed by actor-test')).toBeVisible();
		await context.close();
	});

	test('submission: a rules change marks the export STALE, and recording only stores the human attestation', async ({ browser }) => {
		const context = await browser.newContext();
		const state: SubmissionState = {
			packages: [packageRecord()],
			detail: staleDetail(),
			created: null,
			confirmation: null,
		};
		await stubSession(context);
		await stubSubmission(context, state);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/submission?project=proj-a`);

		await expect(page.getByRole('region', { name: 'Submission package' }).getByText('Pit wall')).toBeVisible();
		// Stale readiness is named — never silently recomputed away.
		await expect(page.getByText('STALE — RULES CHANGED', { exact: true })).toBeVisible();
		await expect(page.getByText('STALE (rules changed after this export)')).toBeVisible();
		await expect(page.getByText('rules changed after the latest export')).toBeVisible();

		// The export row shows its hash and the rules version it was built from
		// (the UI renders truncated forms; the STALE marker carries the
		// distinction, which is the honest contract).
		await expect(page.getByText('sha256-feedbeeffeed…')).toBeVisible();
		await expect(page.getByText('rules-2026.10.…').first()).toBeVisible();

		// With an export on record both CTAs are live.
		await expect(page.getByRole('button', { name: 'Copy latest export' })).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Record submitted' })).toBeEnabled();

		// Recording the submission only RECORDS the human's attestation, bound
		// to the exported hash — the final submission stays a human action.
		await page
			.getByLabel('your attestations (one per line, required)')
			.fill('I submitted this package myself on the contest portal');
		await page.getByRole('button', { name: 'Record submitted' }).click();
		await expect(page.getByText('CONFIRMED SUBMITTED')).toBeVisible();
		expect(state.confirmation).not.toBeNull();
		expect(new URL(state.confirmation!.url).pathname).toBe(
			'/api/projects/proj-a/submission/exports/exp-1/confirmations',
		);
		expect(state.confirmation!.body).toEqual({
			exportId: 'exp-1',
			attestations: ['I submitted this package myself on the contest portal'],
			note: null,
		});
		await context.close();
	});

	test('topbar entry points reach the judge and submission surfaces', async ({ browser }) => {
		const context = await browser.newContext();
		const judgeState: JudgeState = { assessment: EMPTY_RUBRIC_PAYLOAD, scorecards: [], recorded: [] };
		const submissionState: SubmissionState = { packages: [], detail: null, created: null, confirmation: null };
		await stubSession(context);
		await stubJudge(context, judgeState);
		await stubSubmission(context, submissionState);
		const page = await context.newPage();

		await page.goto(`${BASE}/app/?project=proj-a`);
		await page.getByTestId('nav-prove').click();
		await page.getByTestId('stage-tab-judge').click();
		await expect(page).toHaveURL(/\/app\/judge\?project=proj-a$/);
		await expect(page.locator('section[aria-label="Judge scorecard"]')).toBeVisible();

		await page.goto(`${BASE}/app/?project=proj-a`);
		await page.getByTestId('nav-ship').click();
		await expect(page).toHaveURL(/\/app\/submission\?project=proj-a$/);
		await expect(page.locator('section[aria-label="Submission package"]')).toBeVisible();
		await context.close();
	});
});
