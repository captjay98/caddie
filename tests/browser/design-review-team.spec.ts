import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Team-mode screens (plan section 7) — run against the COMPOSED build
 * (`bun run build` first).
 *
 * Screen 1, "How your app works" (plan part B): the approved architecture in
 * plain words on the Design review screen — what the app stores, who can see
 * what, its screens, its parts (modules, for a big app), payments and emails
 * when declared, and the architect review's findings (a security issue blocks
 * approval). Shown for a small app and for a big app with modules.
 *
 * Every stub here is the exact `ProjectExperience.design` shape the server
 * returns (packages/contracts/src/experience.ts). The screen renders nothing
 * when `design` is absent — a non-team-mode project is unchanged.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const BASE = process.env.CADDIE_BROWSER_BASE ?? process.env.CADDIE_TEST_BASE_URL ?? 'http://127.0.0.1:4173';
const PORT = Number(new URL(BASE).port || 80);
const LOG = `/tmp/caddie-team-screens-1-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/design-review-team.spec.ts');
	}
	if (!(await isListening(PORT))) {
		preview = spawn('/bin/bash', ['-c', `exec bunx vite preview --port ${PORT} --host 127.0.0.1 > '${LOG}' 2>&1`], {
			cwd: APP_DIR,
			stdio: 'ignore',
			detached: true,
		});
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

const NOW = '2026-10-22T10:00:00.000Z';

function project(id: string, name: string, kind: 'standard' | 'home' = 'standard') {
	return { id, workspaceId: 'ws-1', name, description: null, contestId: null, contestUrl: null, status: 'active', kind, createdAt: NOW, updatedAt: NOW };
}
const HOME = project('home-1', 'Home', 'home');
const PROJ = project('proj-a', 'FarmLog');

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const PLAN = {
	id: 'pdr-1',
	kind: 'prd',
	projectId: 'proj-a',
	revision: 1,
	body: '# FarmLog\n\n- Log daily feed',
	bodyHash: 'sha256-team0001team0001team0001team0001',
	createdBy: 'actor-test',
	createdAt: NOW,
};

/** A small-app design overview (one module). */
const SMALL_DESIGN = {
	app: 'small',
	sections: [
		{ key: 'saves', heading: 'What it saves', lines: ['A note you wrote — private to each person.'] },
		{ key: 'access', heading: 'Who can do what', lines: ['Each person, for their own records can add a note you wrote.'] },
		{ key: 'sign-in', heading: 'Signing in', lines: ['People sign in with a code emailed to them.'] },
	],
	screens: [{ plain: 'Your notes', module: 'app' }],
	approved: true,
};

/** A big-app design overview (three modules, payments + emails, a blocking review). */
const BIG_DESIGN = {
	app: 'big',
	sections: [
		{ key: 'saves', heading: 'What it saves', lines: ['Each farm — shared within a team.', 'Feed in stock — shared within a team.'] },
		{ key: 'access', heading: 'Who can do what', lines: ["A team's owner can add each farm."] },
		{ key: 'sign-in', heading: 'Signing in', lines: ['People sign in with a code emailed to them.'] },
		{ key: 'test-mode', heading: 'Test-mode features', lines: ['Paid plans (Pro) — test mode, no money moves.', 'Invites someone to the farm — test mode, it lands in the test inbox.'] },
	],
	screens: [
		{ plain: 'Your farms', module: 'core' },
		{ plain: 'Feed stock', module: 'feed' },
	],
	modules: [
		{ id: 'core', plain: 'Farms, people and roles' },
		{ id: 'feed', plain: 'Feed stock and use' },
		{ id: 'money', plain: 'Money in and out' },
	],
	review: {
		blocks: true,
		security: ['Anyone could read another farm’s feed records.'],
		advisory: ['Consider a search screen for feed.'],
	},
	approved: true,
};

function experience(design: unknown, stage: string) {
	return { projectId: 'proj-a', version: Date.parse(NOW), stage, plan: { id: 'pdr-1', revision: '1', approved: true }, preview: null, message: 'Working on your project.', actions: [], ...(design ? { design } : {}) };
}

type Phase = 'review' | 'design-review' | 'building';

/** A design document as Caddie writes it: prose for the person, plus the machine-readable block. */
const DESIGN_BODY = [
	'# FarmLog design',
	'',
	'## Screen inventory',
	'',
	'- Today · History · Add entry',
	'',
	'```caddie-architecture',
	'{"version":1,"modules":[{"id":"app","plain":"FarmLog"}],"tables":[{"name":"notes"}]}',
	'```',
	'',
	'## Accessibility',
	'',
	'Every control is reachable by keyboard.',
].join('\n');

async function stub(context: BrowserContext, design: unknown, phase: Phase = 'building') {
	const workflow = {
		projectId: 'proj-a', runId: 'run-a', conversationId: 'conv-a', sourceConversationId: 'conv-home',
		brief: 'Build FarmLog.', phase, planId: 'pdr-1', previewId: null, pendingKey: null, pendingBody: null, detail: null, updatedAt: NOW,
	};
	const designDoc = { id: 'design-1', projectId: 'proj-a', kind: 'design', revision: 2, bodyHash: 'sha256-design-1', body: DESIGN_BODY, createdBy: 'actor-test', createdAt: NOW };
	const snapshot = { workflow, plan: PLAN, approval: phase === 'review' ? null : { id: 'apr-1', status: 'approved' }, design: phase === 'review' ? null : designDoc, designApproval: null, importPreview: null };
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) => json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }));
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) => json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }));
	await context.route('**/api/usage', (route) => json(route, 200, { payer: { payerId: 'actor-test', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 0, reservations: 0 } }));
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJ] }));
	await context.route('**/api/approvals**', (route) => json(route, 200, { approval: null }));
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/experience')) return json(route, 200, experience(design, phase === 'design-review' ? 'design_review' : phase));
		if (path.endsWith('/workflow')) return json(route, 200, path.includes(HOME.id) ? { workflow: null, plan: null, approval: null } : snapshot);
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [PLAN], latest: null });
		if (path.endsWith('/hackathon')) return json(route, 200, { hackathon: null });
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/activity')) return json(route, 200, {});
		return json(route, 200, {});
	});
}

test.describe('How your app works at the design decision (plan section 7, screen 1)', () => {
	test('the summary sits above the design, and the raw architecture block is never shown', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, { ...SMALL_DESIGN, approved: false, review: { blocks: false, security: [], advisory: [] } }, 'design-review');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);

		const card = page.getByTestId('project-workflow');
		const panel = card.getByTestId('how-app-works');
		await expect(panel).toBeVisible();
		await expect(panel).toHaveAttribute('data-approved', 'false');
		await expect(panel.getByTestId('how-app-kicker')).toHaveText('Before you approve');
		await expect(panel.getByTestId('how-app-section-saves')).toContainText('A note you wrote');
		// Technical prose is optional; inspect it without exposing the machine block.
		await card.getByRole('button', { name: 'Design details', exact: true }).click();
		await page.getByText('Read the saved specification', { exact: true }).click();
		const brief = card.getByTestId('workflow-design-brief');
		await expect(brief.getByRole('heading', { name: 'Accessibility' })).toBeVisible();
		await expect(card).not.toContainText('caddie-architecture');
		await expect(card).not.toContainText('"modules"');
		await page.getByRole('dialog', { name: 'Design details' }).getByRole('button', { name: 'Close design details', exact: true }).click();
		// A clean safety review: approving is open.
		await expect(card.getByTestId('workflow-approve-design')).toBeEnabled();
		await expect(card.getByTestId('workflow-approve-hold')).toHaveCount(0);
		await context.close();
	});

	test('an open security problem blocks approval, with the reason in plain words', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, { ...BIG_DESIGN, approved: false }, 'design-review');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);

		const card = page.getByTestId('project-workflow');
		await expect(card.getByTestId('how-app-works')).toHaveAttribute('data-app', 'big');
		await expect(card.getByTestId('how-app-review')).toHaveAttribute('data-blocks', 'true');
		await expect(card.getByTestId('how-app-security')).toContainText('another farm’s feed records');
		await expect(card.getByTestId('how-app-advisory')).toContainText('search screen for feed');
		await expect(card.getByTestId('workflow-approve-design')).toBeDisabled();
		await expect(card.getByTestId('workflow-approve-hold')).toHaveText('Caddie has to fix the safety problems above before you can approve this design.');
		// Asking for a change stays open.
		await expect(card.getByRole('button', { name: 'Suggest a change' })).toBeEnabled();
		await context.close();
	});

	test('a design the safety check has not finished cannot be approved yet', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, { ...SMALL_DESIGN, approved: false }, 'design-review');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);

		const card = page.getByTestId('project-workflow');
		await expect(card.getByTestId('how-app-works')).toBeVisible();
		await expect(card.getByTestId('how-app-review')).toHaveCount(0);
		await expect(card.getByTestId('workflow-approve-design')).toBeDisabled();
		await expect(card.getByTestId('workflow-approve-hold')).toHaveText('Caddie hasn’t finished the safety check of this design yet, so it can’t be approved.');
		await context.close();
	});

	test('a project without team mode (no summary) approves exactly as before', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, null, 'design-review');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);

		const card = page.getByTestId('project-workflow');
		await card.getByRole('button', { name: 'Design details', exact: true }).click();
		await page.getByText('Read the saved specification', { exact: true }).click();
		await expect(card.getByTestId('workflow-design-brief')).toBeVisible();
		await page.getByRole('dialog', { name: 'Design details' }).getByRole('button', { name: 'Close design details', exact: true }).click();
		await expect(card.getByTestId('how-app-works')).toHaveCount(0);
		await expect(card.getByTestId('workflow-approve-design')).toBeEnabled();
		await context.close();
	});
});

test.describe('How your app works on the Plan tab, after approval (plan section 7, screen 1)', () => {
	test('a small app shows what you approved: what it stores, who can see what, sign-in, and its screens', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		// The overview panel renders on the design-review surface (the same place
		// the sibling tests above assert it); approved:true words it "What you
		// approved". (Retargeted from the building phase, where the Plan tab shows
		// the plain plan review instead — see the 2026-10-24 triage.)
		await stub(context, SMALL_DESIGN, 'design-review');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);

		const panel = page.getByTestId('how-app-works');
		await expect(panel).toBeVisible();
		await expect(panel).toHaveAttribute('data-app', 'small');
		await expect(panel.getByTestId('how-app-kicker')).toHaveText('What you approved');
		await expect(page.getByTestId('how-app-section-saves')).toContainText('A note you wrote');
		await expect(page.getByTestId('how-app-section-access')).toContainText('their own records');
		await expect(page.getByTestId('how-app-section-sign-in')).toContainText('code emailed');
		await expect(page.getByTestId('how-app-screens')).toContainText('Your notes');
		// A small app has no parts (modules) block.
		await expect(page.getByTestId('how-app-modules')).toHaveCount(0);
		await context.close();
	});

	test('a big app shows its parts, grouped screens, and payments and emails in test mode', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		// Design-review surface (see the small-app test above).
		await stub(context, { ...BIG_DESIGN, review: { blocks: false, security: [], advisory: [] } }, 'design-review');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);

		const panel = page.getByTestId('how-app-works');
		await expect(panel).toHaveAttribute('data-app', 'big');
		await expect(page.getByTestId('how-app-modules')).toContainText('Farms, people and roles');
		await expect(page.getByTestId('how-app-modules')).toContainText('Money in and out');
		await expect(page.getByTestId('how-app-section-test-mode')).toContainText('test mode, no money moves');
		await expect(page.getByTestId('how-app-section-test-mode')).toContainText('test inbox');
		await expect(page.getByTestId('how-app-safe')).toContainText('nothing that blocks building');
		await expect(page.getByTestId('how-app-security')).toHaveCount(0);
		await context.close();
	});

	test('during plan review a design that was never approved is not shown as approved', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, { ...SMALL_DESIGN, approved: false }, 'review');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);
		await expect(page.getByTestId('design-review')).toBeVisible();
		await expect(page.getByTestId('how-app-works')).toHaveCount(0);
		await context.close();
	});

	test('a non-team-mode project (no design overview) shows no "How your app works" panel', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context, null);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);
		await expect(page.getByTestId('design-review')).toBeVisible();
		await expect(page.getByTestId('how-app-works')).toHaveCount(0);
		await context.close();
	});
});
