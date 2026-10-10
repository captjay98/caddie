import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Check page acceptance (U07, docs/design/2026-10-10-v2/PACKETS.md) — run
 * against the COMPOSED build (`bun run build` first).
 *
 * What U07 guarantees for Check (HANDOFF §4):
 *   - "N of M ready" from the submission package's REAL checklist.
 *   - Hand-in list: ready / almost / missing with one fix per gap.
 *   - What judges look for (Caddie's honest read) with the score drawer; old
 *     /judge links land here via ?open=score.
 *   - Personal projects: "No judges here" and the step is optional.
 *   - The proof drawer shows the evidence claims behind the lines.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-u07-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/check-v2.spec.ts');
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

function project(id: string, name: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		workspaceId: 'ws-1',
		name,
		description: null,
		contestId: null,
		contestUrl: null,
		status: 'active',
		kind: 'standard',
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	};
}

const HOME = project('home-1', 'Home', { kind: 'home' });
const CONTEST = project('proj-a', 'Pit wall', { contestUrl: 'https://contest.example/demo', contestId: 'c-1' });
const PERSONAL = project('proj-p', 'Pantry Scale');

const CHECKLIST = [
	{
		id: 'chk-1',
		kind: 'video',
		status: 'verified',
		requirementText: 'A demo video link is required',
		citation: { quote: 'Submissions must include a demo video', url: 'https://contest.example/rules' },
		evidence: [],
	},
	{
		id: 'chk-2',
		kind: 'repo',
		status: 'declared',
		requirementText: 'A working public repository link',
		citation: { quote: 'Provide a public repo', url: 'https://contest.example/rules' },
		evidence: [],
	},
	{
		id: 'chk-3',
		kind: 'license',
		status: 'missing',
		requirementText: 'An OSI license file in the repo',
		citation: { quote: 'License must be OSI-approved', url: 'https://contest.example/rules' },
		evidence: [],
	},
];

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAccount(context: BrowserContext, opts: { project?: typeof CONTEST; packages?: unknown[]; detail?: unknown } = {}) {
	const active = opts.project ?? CONTEST;
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, active] }));
	// The catch-all is registered FIRST: later routes take precedence in
	// Playwright, so the specific submission/evidence stubs below win.
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
		return json(route, 200, {});
	});
	await context.route('**/api/projects/**/submission/packages', (route) => json(route, 200, { packages: opts.packages ?? [] }));
	await context.route(/\/submission\/packages\/[^/]+$/, (route) => json(route, 200, opts.detail ?? {}));
	// Judge surfaces: an explicitly empty rubric (the shape the scorecard
	// understands), never a bare {} that would crash the panel.
	const EMPTY_RUBRIC = {
		rubric: { criteria: [], warnings: ['no rubric-bearing claims are on record for this project'], conflicts: [], hash: 'sha256-empty', extractionVersion: 'extract-v2' },
		assessment: [],
	};
	await context.route('**/api/projects/**/judge/rubric', (route) => json(route, 200, { rubric: EMPTY_RUBRIC.rubric }));
	await context.route('**/api/projects/**/judge/assessment', (route) => json(route, 200, EMPTY_RUBRIC));
	await context.route('**/api/projects/**/judge/scorecards', (route) => json(route, 200, { scorecards: [] }));
}

const PACKAGE_DETAIL = {
	package: { id: 'pkg-1', projectId: 'proj-a', title: 'Pit wall', requirementsVersion: 'rules-2026.10', reuseState: 'confirmed', reuseConfirmedBy: 'actor-test', createdAt: NOW },
	requirementsVersion: 'rules-2026.10',
	readiness: { status: 'blocked', reasons: ['checklist has gaps on record'], currentRequirementsVersion: 'rules-2026.10' },
	checklist: CHECKLIST,
	exports: [],
	confirmations: [],
};

const RUBRIC = {
	rubric: {
		criteria: [
			{ criterion: 'Working public repository link', score: 3, notes: 'repo resolves, README present', access: 'verified' },
		],
		warnings: [],
		conflicts: [],
		hash: 'sha256-rubric000000000000',
		extractionVersion: 'extract-v2',
	},
	assessment: [
		{
			criterionText: 'Working public repository link',
			requirementClaimId: 'cl-repo',
			score: 3,
			basis: 'local',
			evidenceIds: ['rc-1'],
			conflict: null,
		},
	],
};

test.describe('Check page (U07)', () => {
	test('"N of M ready" from the real checklist with one fix per gap', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { packages: [{ id: 'pkg-1', title: 'Pit wall' }], detail: PACKAGE_DETAIL });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/evidence?project=proj-a`);

		await expect(page.getByTestId('check-ready-count')).toContainText('1 of 3 things are ready');
		const items = page.getByTestId('check-handin-item');
		await expect(items).toHaveCount(3);
		await expect(items.filter({ hasText: 'A demo video link is required' })).toContainText('READY');
		await expect(items.filter({ hasText: 'A working public repository link' })).toContainText('ALMOST');
		await expect(items.filter({ hasText: 'An OSI license file' })).toContainText('MISSING');
		// One fix per gap, in plain words.
		await expect(items.filter({ hasText: 'An OSI license file' })).toContainText('Not in the package yet');
		await context.close();
	});

	test('old /judge links land on the score drawer with Caddie\u2019s honest read', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			packages: [{ id: 'pkg-1', title: 'Pit wall' }],
			detail: PACKAGE_DETAIL,
		});
		await context.unroute('**/api/projects/**');
		// Catch-all first; the judge routes below are registered after and so
		// take precedence (Playwright: last matching route wins).
		await context.route('**/api/projects/**', (route) => json(route, 200, {}));
		await context.route('**/api/projects/proj-a/judge/**', (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.endsWith('/assessment')) return json(route, 200, RUBRIC);
			if (path.endsWith('/scorecards')) return json(route, 200, { scorecards: [] });
			if (path.endsWith('/rubric')) return json(route, 200, { rubric: RUBRIC.rubric });
			return json(route, 200, {});
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/judge?project=proj-a`);
		await expect(page).toHaveURL(/\/app\/evidence\?project=proj-a&open=score/);
		await expect(page.locator('section[aria-label="Score it yourself"]')).toBeVisible();
		await context.close();
	});

	test('a personal project shows "No judges here" and keeps the readiness list', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			project: PERSONAL,
			packages: [{ id: 'pkg-1', title: 'Pantry Scale' }],
			detail: { ...PACKAGE_DETAIL, package: { ...PACKAGE_DETAIL.package, projectId: 'proj-p', title: 'Pantry Scale' } },
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/evidence?project=proj-p`);
		await expect(page.getByTestId('check-no-judges')).toContainText('No judges here');
		await expect(page.locator('section[aria-label="Score it yourself"]')).toHaveCount(0);
		await expect(page.getByTestId('check-ready-count')).toBeVisible();
		await context.close();
	});

	test('the proof drawer shows the evidence claims behind the lines', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { packages: [{ id: 'pkg-1', title: 'Pit wall' }], detail: PACKAGE_DETAIL });
		await context.route('**/api/projects/proj-a/evidence/**', (route) =>
			json(route, 200, { claims: [], sources: [] }),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/evidence?project=proj-a`);
		const proof = page.getByTestId('check-proof');
		await expect(proof).toBeVisible();
		// The drawer opens and shows the claims surface (honest empty here).
		await proof.locator('summary').click();
		await expect(proof.locator('summary')).toContainText('Proof');
		await context.close();
	});
});
