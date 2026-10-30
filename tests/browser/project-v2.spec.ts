import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Project Overview / Plan / Build v2 acceptance (U06) — run against the
 * COMPOSED build (`bun run build` first).
 *
 * What U06 guarantees (HANDOFF §4):
 *   - Overview: the next step (top open brief card, ONE button), "Your app so
 *     far" stating the real preview status, the to-do list with the add-task
 *     window, and folded "What happened recently".
 *   - Plan: the "Is this OK?" decision bar first, the plan body beneath, the
 *     approve window stating the REAL spend cap (never a fabricated number),
 *     the suggest-a-change window, and earlier versions folded (#earlier).
 *   - Build: Activity · Files tabs, past builds as sentences, and the change-
 *     request window drafting the ask into the project's chat (no fabricated
 *     Caddie response).
 *   - Old /tasks and /artifacts links land on the right surfaces.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const BASE = process.env.CADDIE_BROWSER_BASE ?? 'http://127.0.0.1:4173';
const PORT = Number(new URL(BASE).port || 4173);
const LOG = `/tmp/caddie-u06-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/project-v2.spec.ts');
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

function card(id: string, kind: string, status: string, headline: string, summary: string, targetId = 't-1') {
	return {
		id,
		projectId: 'proj-a',
		kind,
		headline,
		summary,
		evidenceIds: [],
		status,
		updatedAt: NOW,
		primaryAction: { label: kind === 'approval' ? 'Review the plan' : 'Open', kind: 'review', targetId },
		seen: true,
	};
}

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** A project whose checked build is the current preview (the workflow projection's view). */
const READY_EXPERIENCE = {
	projectId: 'proj-a',
	version: Date.parse('2026-10-19T12:00:00.000Z'),
	stage: 'ready',
	plan: { id: 'plan-1', revision: '2', approved: true },
	preview: { id: 'out-1', revision: '2', current: true },
	message: 'Your app is ready.',
	actions: [],
} as const;

async function stubAccount(context: BrowserContext, opts: { brief?: unknown[]; planDocs?: unknown[]; usage?: unknown; approval?: unknown; experience?: unknown; hackathon?: unknown; workflowPhase?: string; importPreview?: unknown; share?: boolean } = {}) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/usage', (route) =>
		json(route, 200, opts.usage ?? { payer: { payerId: 'actor-test', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 2500, reservations: 0 } }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJ_A] }));
	// The design approval posts through the REAL route shape (recorded here).
	await context.route('**/api/approvals**', (route) =>
		route.request().method() === 'GET' ? json(route, 200, { approval: opts.approval ?? null }) :
        json(route, 201, { approval: { id: 'apr-1', status: (route.request().postDataJSON() as { decision?: string }).decision ?? 'approved' } }),
	);
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/workflow/decision')) return json(route, 200, { workflow: null, approval: { id: 'apr-1', status: route.request().postDataJSON().decision } });
        if (path.endsWith('/workflow')) return json(route, 200, { workflow: opts.workflowPhase ? { phase: opts.workflowPhase, brief: 'Build FarmLog AI.' } : null, approval: opts.approval ?? null, plan: null, design: null, designApproval: null, importPreview: opts.importPreview ?? null });
		if (path.endsWith('/brief')) return json(route, 200, { cards: opts.brief ?? [] });
		if (path.endsWith('/experience') && opts.experience) return json(route, 200, opts.experience);
		if (path.endsWith('/hackathon')) return json(route, 200, { hackathon: opts.hackathon ?? null });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: opts.planDocs ?? [], latest: null });
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/tasks') && route.request().method() === 'GET') return json(route, 200, { tasks: [] });
		if (path.endsWith('/tasks') && route.request().method() === 'POST') return json(route, 201, { task: { id: 'task-1', projectId: 'proj-a', title: 'x', status: 'open', createdBy: 'a', createdAt: NOW } });
		if (path.endsWith('/previews'))
			return json(route, 200, {
				previews: opts.share === false ? [] : [
					{ id: 'pvw-1', projectId: 'proj-a', revisionId: 'rev-1', expiresAt: '2027-01-01T00:00:00.000Z', revoked: false, createdBy: 'x', createdAt: NOW },
				],
			});
		return json(route, 200, {});
	});
}

test.describe('Project Overview / Plan / Build v2 (U06)', () => {
	// RETIRED (focused project workspace redesign, commit 5f3574a): the old
	// Overview "Your app so far" preview card (overview-preview-ready/-building/
	// -share, overview-try-app) no longer exists — the ready app is now the
	// inline preview inside the project-workflow card on the focused home. The
	// three tests that asserted that card are covered where the behaviour now
	// lives: project-workflow.spec.ts (data-phase building->ready with no reload,
	// the /seed+/document https-frame, the "Try your app" preview and persisted
	// todos) and focused-project-chat.spec.ts + projects-v2.spec.ts (the
	// "Try your app"/"Try app" action -> /preview?...&source=workflow).

	// RETIRED (focused project workspace redesign, commit 5f3574a): the Overview
	// "next step" brief card with exactly one button (overview-next-step /
	// overview-next-action) is gone. "A plan that needs your OK surfaces one
	// action that opens Plan" is now the Now panel's single server primary
	// action — see 'a plan ready for review offers the server's primary action,
	// which opens the plan' below — with the four-step bar carrying orientation.

	test('Steps: the step the work is on is highlighted; phones keep all four steps reachable', async ({ browser }) => {
		const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await stubAccount(desktop, { workflowPhase: 'planning' });
		const page = await desktop.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('project-tab-plan')).toHaveAttribute('data-active', 'true');
		await expect(page.getByTestId('project-tab-plan')).toContainText('Caddie is drafting it');
		await expect(page.getByTestId('project-tab-build')).toContainText('After you approve');
		await expect(page.getByTestId('project-steps-compact')).toBeHidden();
		// The full brief is readable on the focused home, in the Project brief
		// fold of the supporting details (it replaces the old overview "Read the
		// full brief" card). The fold's text comes from the workflow brief.
		await page.getByRole('button', { name: 'About this project' }).click();
		const brief = page.getByTestId('project-supporting-details').locator('details', { has: page.getByText('Project brief', { exact: true }) });
		await brief.locator('summary').click();
		await expect(brief).toContainText('Build FarmLog AI.');
		await desktop.close();

		const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(phone, { workflowPhase: 'planning' });
		const mobile = await phone.newPage();
		await mobile.goto(`${BASE}/app/project?project=proj-a`);
		// On phones the focused head keeps all four steps reachable as a 2×2
		// grid (two columns, two rows) — no horizontal scroll, every step
		// visible (the old 4-across row ran off-screen). The step the work is
		// on is still the marked active one; the compact one-line view stays
		// hidden (asserted on desktop above).
		await expect(mobile.getByTestId('project-tabs')).toBeVisible();
		await expect(mobile.locator('.project-step')).toHaveCount(4);
		await expect(mobile.getByTestId('project-tab-plan')).toHaveAttribute('data-active', 'true');
		await expect(mobile.getByTestId('project-tab-plan')).toHaveClass(/\bactive\b/);
		await phone.close();
	});

	test('Steps: a build paused after approval keeps Plan approved; a plan stuck before approval stays on Plan', async ({ browser }) => {
		// Both read `blocked` as the workflow phase; only the project status
		// knows whether the plan was approved. On the focused home the four-step
		// bar makes the call (ProjectTabs reads plan.approved), and the project
		// workflow card carries the headline that the old Now title did.
		const paused = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await stubAccount(paused, {
			workflowPhase: 'blocked',
			// An approved-then-paused build: the /workflow approval proves the plan
			// was approved, so the card is "Needs attention", not a stuck plan.
			approval: { resourceId: 'plan-2', revisionHash: 'sha256-2', status: 'approved', expiresAt: '2027-01-01T00:00:00Z' },
			experience: {
				projectId: 'proj-a', version: Date.now(), stage: 'blocked', plan: { id: 'plan-2', revision: '2', approved: true }, preview: null,
				message: 'Caddie stopped making progress on the build for 12 minutes, so it was paused. Your plan and files are saved. Press Retry to continue from here.',
				actions: [{ kind: 'retry', label: 'Retry build', enabled: true, primary: true }],
			},
		});
		const page = await paused.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('project-workflow')).toContainText('Needs attention');
		await expect(page.getByTestId('project-tab-plan')).toContainText('Approved');
		await expect(page.getByTestId('project-tab-plan')).not.toContainText('Paused');
		await expect(page.getByTestId('project-tab-plan')).toHaveClass(/\bdone\b/);
		await expect(page.getByTestId('project-tab-build')).toContainText('Needs your help');
		await expect(page.getByTestId('project-tab-build')).toHaveAttribute('data-active', 'true');
		await paused.close();

		const stuck = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await stubAccount(stuck, {
			// No approval on /workflow: the blocked phase is a plan that never got
			// approved, so the card says the plan needs another pass.
			workflowPhase: 'blocked',
			experience: {
				projectId: 'proj-a', version: Date.now(), stage: 'planning_blocked', plan: { id: 'plan-1', revision: '1', approved: false }, preview: null,
				message: "Caddie couldn't finish writing your plan. Nothing has been built yet — tell Caddie to continue and it will pick up your request and feedback.",
				actions: [{ kind: 'retry', label: 'Continue the plan', enabled: true, primary: true }],
			},
		});
		const stuckPage = await stuck.newPage();
		await stuckPage.goto(`${BASE}/app/project?project=proj-a`);
		await expect(stuckPage.getByTestId('project-workflow')).toContainText('Plan needs another pass');
		await expect(stuckPage.getByTestId('project-tab-plan')).toContainText('Paused — check with Caddie');
		await expect(stuckPage.getByTestId('project-tab-plan')).toHaveAttribute('data-active', 'true');
		await expect(stuckPage.getByTestId('project-tab-build')).toContainText('After you approve');
		await expect(stuckPage.getByTestId('project-tab-build')).not.toContainText('Needs your help');
		await stuck.close();
	});

	test('Header: hackathon chips and a labelled Settings button; no banner or duplicate chat input', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			hackathon: { title: 'Nebius x NVIDIA Global AI Hackathon', url: 'https://nebiusglobalaihackathon.devpost.com', track: null, deadline: '2026-10-30', daysLeft: 15, ended: false, eligibility: 'eligible' },
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('project-chip-event')).toHaveCount(0);
		await page.getByRole('button', {name:'About this project',exact:true}).click();
		await expect(page.getByTestId('project-chip-event')).toHaveText('Nebius x NVIDIA Global AI Hackathon');
		await expect(page.getByTestId('project-chip-event').locator('a')).toHaveAttribute('target', '_blank');
		await expect(page.getByTestId('project-chip-deadline')).toHaveText('Ends Oct 30 · 15 days left');
		await expect(page.getByTestId('project-chip-eligibility')).toHaveText('You can enter');
		await page.getByRole('button',{name:'Close about this project'}).click();
		// Owner 2026-10-30: a quiet icon, named by its label (no visible text).
		await expect(page.getByTestId('project-settings-gear')).toHaveAccessibleName('Project settings');
		await expect(page.getByTestId('project-ask-caddie')).toHaveCount(0);
		await expect(page.getByTestId('project-head-model')).toHaveCount(0);
		await context.close();
	});

	test('Overview: a project without a workflow never claims Caddie is working', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			experience: { projectId: 'proj-a', version: 0, stage: 'planning', plan: null, preview: null, message: 'No workflow yet.', actions: [] },
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		// With no workflow the focused home shows the calm "what to build" prompt,
		// never a build/working card. The project-workflow card and the Now panel
		// (overview-now) only exist once there is a workflow.
		await expect(page.getByTestId('focused-project-home')).toContainText('What would you like to build?');
		await expect(page.getByTestId('project-workflow')).toHaveCount(0);
		await expect(page.getByTestId('overview-now')).toHaveCount(0);
		await expect(page.locator('body')).not.toContainText('Caddie is building');
		await context.close();
	});

	test('Overview: while Caddie plans, the Now panel says so instead of "Let\'s get started"', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			experience: { projectId: 'proj-a', version: Date.now() - 2 * 60_000, stage: 'planning', plan: null, preview: null, message: 'Caddie is preparing a plan for this project.', actions: [] },
		});
		const page = await context.newPage();
		// The Now panel lives on the Build view (no workflow record stubbed, so it
		// reads the experience projection there); it reports the live planning
		// state rather than an idle "let's get started".
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		const now = page.getByTestId('overview-now');
		await expect(now).toHaveAttribute('data-stage', 'planning');
		await expect(now).toHaveAttribute('data-working', 'true');
		await expect(page.getByTestId('overview-now-title')).toHaveText('Caddie is writing your plan');
		await expect(page.getByTestId('overview-now-updated')).toHaveText('Updated 2 min ago');
		await expect(page.locator('body')).not.toContainText('Let’s get started');
		await context.close();
	});

	test('Overview: a plan ready for review offers the server\'s primary action, which opens the plan', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			experience: {
				projectId: 'proj-a', version: Date.now(), stage: 'review', plan: { id: 'plan-1', revision: 'rev-1', approved: false }, preview: null,
				message: 'A plan is ready for your review.',
				actions: [
					{ kind: 'suggest_change', label: 'Suggest a change', enabled: true, primary: false },
					{ kind: 'review_plan', label: 'Review the plan', enabled: true, primary: true },
				],
			},
		});
		const page = await context.newPage();
		// The Now panel (Build view, no workflow record) offers the server's
		// primary action, which opens the Plan tab.
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		await expect(page.getByTestId('overview-now-title')).toHaveText('Your plan is ready to review');
		const primary = page.getByTestId('overview-now-review_plan');
		await expect(primary).toHaveClass(/btn-key/);
		await primary.click();
		await expect(page).toHaveURL(/design-review\?project=proj-a/);
		await context.close();
	});

	test('Overview: no open card means an honest calm next-step state', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { brief: [card('brf_result_1', 'result', 'handled', 'Build finished', 'The latest build produced a preview.')] });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		// No pending decision and no workflow: the focused home stays calm (the
		// "what to build" prompt), and finished work folds under the project's
		// "Earlier decisions & updates" section rather than shouting for action.
		await expect(page.getByTestId('focused-project-home')).toContainText('What would you like to build?');
		await page.getByRole('button', { name: 'About this project' }).click();
		const recent = page.getByTestId('overview-recent');
		await recent.locator('summary').click();
		await expect(recent).toContainText('Build finished');
		await context.close();
	});

	test('Overview: the to-do list embeds on the focused home with the add-task window', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { experience: READY_EXPERIENCE });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		// The ready app itself (the "Your app so far" preview, review F04) is now
		// the inline preview inside the project-workflow card and is covered by
		// project-workflow.spec.ts. What the focused home still owns here is the
		// embedded to-do list; the create form hides behind the button.
		await page.getByRole('button', { name: 'About this project' }).click();
		await page.getByTestId('overview-todo').locator('summary').click();
		await expect(page.getByTestId('tasks-panel')).toBeVisible();
		await expect(page.getByTestId('task-create')).toHaveCount(0);
		await page.getByTestId('add-task-open').click();
		await expect(page.getByTestId('task-create')).toBeVisible();
		await page.getByTestId('task-title').fill('record the demo video');
		await page.getByTestId('task-add').click();
		await expect(page.getByTestId('task-create')).toBeVisible(); // window stays for the next entry
		await context.close();
	});

	test('Plan: the "Is this OK?" bar comes first; the approve window states the real spend cap', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			planDocs: [
				{
					id: 'pdr-1',
                    kind: 'prd',
					projectId: 'proj-a',
					revision: 2,
					body: 'Build a solar dashboard.\n\n- render a live chart',
					bodyHash: 'sha256-abc123def456abc123def456abc12345',
					createdBy: 'actor-test',
					createdAt: NOW,
				},
			],
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);

		// Decision bar above the plan body (§4 order).
		const bar = page.getByTestId('design-review-decision-bar');
		await expect(bar).toBeVisible();
		const bodyBox = await page.getByTestId('design-review-plan-body').boundingBox();
		const barBox = await bar.boundingBox();
		expect(barBox!.y).toBeLessThan(bodyBox!.y);

		// The readable plan renders as real text, not literal markdown source:
		// the overview sentence is shown and the raw "- render a live chart"
		// source line is not surfaced verbatim in the default view.
		await expect(page.getByTestId('plan-body-content')).toContainText('Build a solar dashboard.');
		await expect(page.getByTestId('plan-body-content')).not.toContainText('- render a live chart');

		// The approve window fetches the real usage and states the cap.
		await page.getByTestId('plan-approve-open').click();
		await expect(page.getByTestId('approve-plan-window')).toBeVisible();
		// A configured spending limit is shown (the only useful line at this step).
		await expect(page.getByTestId('approve-plan-spend')).toContainText('$500');
		await expect(page.getByTestId('approve-plan-spend')).toContainText('$25 used so far');

		// Approving posts the revision-bound intent (no window, no approval).
		await page.getByTestId('design-review-approve').click();
		await expect(page.getByTestId('design-review-outcome')).toHaveAttribute('data-decision', 'approved');

        // A settled revision cannot be re-decided by an opposite button.
        await expect(page.getByTestId('plan-changes-open')).toHaveCount(0);
        // Owner 2026-10-29: once approved there is nothing left to press here
        // before the build — no "Your recorded decision", no repeat sentence.
        await expect(page.getByRole('button', { name: 'Continue with Caddie' })).toHaveCount(0);
        await expect(page.getByTestId('approve-meaning')).toHaveCount(0);
        await expect(page.getByTestId('design-review-plan-body')).not.toHaveAttribute('open');

		// No earlier versions → no "Earlier versions · 0" noise fold.
		await expect(page.getByTestId('design-review-earlier')).toHaveCount(0);
		await context.close();
	});

    test('Plan: feedback is required and saved against this revision', async ({ browser }) => {
        const context = await browser.newContext();
        const revision = { id: 'pdr-feedback', projectId: 'proj-a', kind: 'prd', revision: 1, body: '# Todo app\n\n- Add tasks', bodyHash: 'sha256-feedback', createdAt: NOW };
        await stubAccount(context, { planDocs: [revision] });
        const notes: unknown[] = [];
        await context.route('**/api/projects/proj-a/workflow/decision', (route) => {
            notes.push(route.request().postDataJSON());
            return json(route, 200, { workflow: null, approval: { id: 'apr-1', status: 'rejected' } });
        });
        const page = await context.newPage();
        await page.goto(`${BASE}/app/design-review?project=proj-a`);
        await page.getByTestId('plan-changes-open').click();
        await expect(page.getByTestId('design-review-reject')).toBeDisabled();
        await page.getByTestId('plan-change-note').fill('Include keyboard shortcuts');
        await page.getByTestId('design-review-reject').click();
        await expect(page.getByTestId('design-review-outcome')).toHaveAttribute('data-decision', 'rejected');
        expect(notes).toEqual([{ planId: 'pdr-feedback', decision: 'rejected', note: 'Include keyboard shortcuts' }]);
        await context.close();
    });

    test('Plan: a refused approval leaves its error visible and the window open', async ({ browser }) => {
        const context = await browser.newContext();
        await stubAccount(context, { planDocs: [{ id: 'pdr-error', projectId: 'proj-a', kind: 'prd', revision: 1, body: '# Todo app', bodyHash: 'sha256-error', createdAt: NOW }] });
        await context.route('**/api/projects/proj-a/workflow/decision', (route) => json(route, 409, { error: 'STALE_PLAN', message: 'The plan changed. Reload the latest version.' }));
        const page = await context.newPage();
        await page.goto(`${BASE}/app/design-review?project=proj-a`);
        await page.getByTestId('plan-approve-open').click();
        await page.getByTestId('design-review-approve').click();
        await expect(page.getByTestId('approve-plan-window')).toBeVisible();
        await expect(page.getByTestId('approve-plan-window').getByTestId('design-review-error')).toContainText('The plan changed');
        await expect(page.getByTestId('design-review-outcome')).toHaveCount(0);
        await context.close();
    });

    test('Plan: navigation and reload restore a saved approval for this exact revision', async ({ browser }) => {
        const context = await browser.newContext();
        await stubAccount(context, { planDocs: [{ id: 'pdr-saved', projectId: 'proj-a', kind: 'prd', revision: 1, body: '# Todo app', bodyHash: 'sha256-saved', createdAt: NOW }], approval: { resourceId: 'pdr-saved', revisionHash: 'sha256-saved', status: 'approved', expiresAt: '2027-01-01T00:00:00Z' } });
        const page = await context.newPage();
        await page.goto(`${BASE}/app/design-review?project=proj-a`);
        await expect(page.getByTestId('design-review-outcome')).toHaveAttribute('data-decision', 'approved');
        await page.reload();
        await expect(page.getByTestId('design-review-outcome')).toHaveText('Approved');
        await expect(page.getByTestId('plan-approve-open')).toHaveCount(0);
        await context.close();
    });

	test('the Now panel is one card too: nothing inside it is drawn as a card of its own (plan 3.6)', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			experience: {
				projectId: 'proj-a', version: Date.parse('2026-10-19T12:00:00.000Z'), stage: 'building',
				plan: { id: 'plan-r2', revision: '2', approved: true }, preview: null, message: 'Caddie is building your app.',
				actions: [{ kind: 'stop', label: 'Stop build', enabled: true, primary: false }],
			},
		});
		const feature = (id: string, title: string, position: number, status: string) =>
			({ id, title, doneWhen: ['check'], position, status, attempts: status === 'building' ? 1 : 0, testsPassed: status === 'passed' ? 1 : null, passedAt: status === 'passed' ? NOW : null, canRollBack: false });
		await context.route('**/api/projects/proj-a/activity', (route) =>
			json(route, 200, {
				projectId: 'proj-a', phase: 'building', building: true, steps: [], rounds: [], openIssues: 0,
				features: [feature('log-feed', 'Log daily feed', 1, 'passed'), feature('view-dashboard', 'See the feed dashboard', 2, 'building')],
				timeline: {
					phase: 'building', startedAt: NOW, lastActivityAt: NOW, elapsedMs: 60_000, idleMs: 5_000, quiet: false, summary: 'Caddie is writing the app.',
					stages: [
						{ key: 'setup', label: 'Get the workspace ready', state: 'done', startedAt: NOW, endedAt: NOW, durationMs: 20_000, detail: null },
						{ key: 'write', label: 'Write the app', state: 'active', startedAt: NOW, endedAt: null, durationMs: 40_000, detail: '2 files' },
						{ key: 'test', label: 'Run its own tests', state: 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
						{ key: 'check', label: 'Final checks by Caddie', state: 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
						{ key: 'preview', label: 'Make the preview', state: 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
					],
					scope: [], files: [{ path: 'src/App.tsx', area: 'app', writes: 1, lastAt: NOW, bytes: 4200, role: 'frontend' }],
					fileAreas: { app: 1, test: 0, style: 0, config: 0, server: 0 },
					commands: [{ command: 'bun run build', outcome: 'ok', exitCode: 0, testsPassed: null, testsFailed: null, at: NOW, durationMs: 4_000, role: 'frontend' }],
					tests: null, checks: [],
				},
			}),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		const now = page.getByTestId('overview-now');
		// Features are top-level; stages now live under the "Build details" fold
		// (Codex's single-panel redesign). Open it so the box-in-box scan covers
		// the stage list too.
		await expect(now.getByTestId('build-features')).toBeVisible();
		await now.getByRole('button',{name:'Build activity',exact:true}).click();
		await expect(now.getByTestId('build-stages')).toBeVisible();
		const found = await now.evaluate((card) => {
			const boxes: string[] = [];
			for (const el of Array.from(card.querySelectorAll('*'))) {
				// Native dialogs live in the top layer, not inside the card visually.
				if (el.closest('dialog, button, a, input, textarea, select, summary, iframe, [role="button"]')) continue;
				const s = getComputedStyle(el);
				if (!/^(block|flex|grid|list-item)$/.test(s.display)) continue;
				const boxed = ['top', 'right', 'bottom', 'left'].every((side) => parseFloat(s.getPropertyValue(`border-${side}-width`)) >= 1 && s.getPropertyValue(`border-${side}-style`) !== 'none');
				const box = el.getBoundingClientRect();
				if (boxed && parseFloat(s.borderTopLeftRadius) >= 6 && box.width >= 120 && box.height >= 36) boxes.push(String(el.className || el.tagName));
			}
			return boxes;
		});
		expect(found).toEqual([]);
		await context.close();
	});

	test('Build shows the same status as the chat card, and record ids only under For developers (plan 3.5)', async ({ browser }) => {
		// Live, the Build tab said nothing about a paused build (its banner
		// followed this browser's chat connection, not the build) and showed the
		// plan's record id among the plain facts.
		const context = await browser.newContext();
		await stubAccount(context, {
			experience: {
				projectId: 'proj-a',
				version: Date.parse('2026-10-19T12:00:00.000Z'),
				stage: 'blocked',
				plan: { id: 'plan-r2', revision: '2', approved: true },
				preview: null,
				message: 'Caddie stopped making progress on the build for 12 minutes, so it was paused. Your plan and files are saved.',
				actions: [{ kind: 'retry', label: 'Retry build', enabled: true, primary: true }],
			},
		});
		await context.unroute('**/api/projects/proj-a/run-bindings');
		await context.route('**/api/projects/proj-a/run-bindings', (route) =>
			json(route, 200, {
				runBindings: [
					{
						runId: 'run-01HZX', projectId: 'proj-a', conversationId: 'conv-01HZX', submissionId: 'sub-01HZX', planRevision: 'plan-r2',
						stackId: 'react-hono', payerId: 'payer-1', modelRouteId: 'route-1', pricingVersion: 'v1', createdBy: 'actor-test', createdAt: NOW,
					},
				],
			}),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		const now = page.getByTestId('overview-now');
		await expect(now).toHaveAttribute('data-stage', 'blocked');
		await expect(now).toContainText('Caddie stopped making progress on the build for 12 minutes');
		await expect(now.getByRole('button', { name: 'Retry build' })).toBeVisible();
		// Past builds and their record ids live under "Build history & files".
		await page.getByTestId('project-build-resources').getByRole('button').click();
		await page.getByTestId('run-detail-toggle').click();
		const details = page.getByTestId('run-details');
		await expect(details.getByText('react-hono', {exact:true})).toBeHidden();
		await expect(details.getByText('plan-r2')).toBeHidden();
		await details.locator('summary', { hasText: 'For developers' }).click();
		await expect(details.getByText('plan-r2')).toBeVisible();
		await context.close();
	});

	test('Build: Activity and Files tabs; past builds as sentences; change-request drafts into the chat', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		await context.unroute('**/api/projects/proj-a/run-bindings');
		await context.route('**/api/projects/proj-a/run-bindings', (route) =>
			json(route, 200, {
				runBindings: [
					{
						runId: 'run-01HZX',
						projectId: 'proj-a',
						conversationId: 'conv-01HZX',
						submissionId: 'sub-01HZX',
						planRevision: 'plan-r2',
						stackId: 'react-hono',
						payerId: 'payer-1',
						modelRouteId: 'route-1',
						pricingVersion: 'v1',
						createdBy: 'actor-test',
						createdAt: NOW,
					},
				],
			}),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);

		// Build history & files live under their own section on the Build view.
		await page.getByTestId('project-build-resources').getByRole('button').click();

		// Past builds are sentences, not "run 14" tokens.
		await expect(page.getByTestId('run-row')).toContainText('Build request recorded');
		await expect(page.getByTestId('run-row')).not.toContainText(/run \d+/);

		// The Files tab shows the code viewer inline.
		await page.getByTestId('build-tab-files').click();
		await expect(page).toHaveURL(/tab=files/);
		await expect(page.getByTestId('artifact-viewer')).toBeVisible();

		// Change-request drafts the ask into THIS project's chat.
		await page.getByTestId('build-tab-activity').click();
		await page.getByTestId('change-request-open').click();
		const win = page.getByTestId('change-request-window');
		await expect(win).toBeVisible();
		await page.getByTestId('change-request-text').fill('Add a dark mode toggle');
		await expect(page.getByTestId('change-request-text')).toHaveValue('Add a dark mode toggle');
		await expect(page.getByTestId('change-request-send')).toBeEnabled();
		await page.getByTestId('change-request-send').click();
		await expect(page).toHaveURL(/pane=channel/);
		await expect(page.getByTestId('composer-input')).toHaveValue('Please change: Add a dark mode toggle');
		await context.close();
	});

	test('old /tasks and /artifacts links land on the right surfaces, keeping ?project=', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/tasks?project=proj-a`);
		await expect(page).toHaveURL(/\/app\/project\?project=proj-a/);
		await expect(page.getByTestId('overview-todo')).toBeVisible();

		await page.goto(`${BASE}/app/artifacts?project=proj-a`);
		await expect(page).toHaveURL(/\/app\/runs\?project=proj-a&tab=files/);
		await expect(page.getByTestId('artifact-viewer')).toBeVisible();
		await context.close();
	});
});

test.describe('the Plan tab follows the build (plan 5.3)', () => {
	// Live findings (2026-10-20): the Plan tab was narrower than the other tabs,
	// the long plan stayed open after approval, the badge still said "Plan
	// approved" with "Continue with Caddie" while the app was being built, and
	// what approving means sat in a fold of boxes.
	const PLAN = { id: 'pdr-follow', projectId: 'proj-a', kind: 'prd', revision: 1, body: '# FarmLog AI\n\n- Log daily feed', bodyHash: 'sha256-follow', createdAt: NOW };
	const APPROVED = { resourceId: 'pdr-follow', revisionHash: 'sha256-follow', status: 'approved', expiresAt: '2027-01-01T00:00:00Z' };
const MEANING = 'Next, Caddie draws three looks. Building starts when you pick one.';

	test('before a decision: as wide as the other tabs, one plain sentence on approving, the plan open to read', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stubAccount(context, { planDocs: [PLAN] });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);

		const panel = page.getByTestId('design-review');
		await expect(panel).toBeVisible();
		const column = await page.locator('.page-col').first().boundingBox();
		const box = await panel.boundingBox();
		expect(Math.round(box!.width)).toBe(Math.round(column!.width));
		await expect(page.getByTestId('approve-meaning')).toHaveText(MEANING);
		await expect(page.getByTestId('approval-scope')).toHaveCount(0);
		await expect(page.getByTestId('design-review-plan-body')).toHaveAttribute('open', '');
		await expect(page.getByTestId('plan-body-content')).toBeVisible();
		await context.close();
	});

	for (const [phase, badge, action] of [
		['building', 'Building now', 'See build progress'],
		['blocked', 'Build paused', 'See what’s needed'],
		['ready', 'App built', 'See your app'],
	] as const) {
		test(`approved and ${phase}: the badge and the button follow the build, and the plan is folded`, async ({ browser }) => {
			const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
			await stubAccount(context, { planDocs: [PLAN], approval: APPROVED, workflowPhase: phase });
			const page = await context.newPage();
			await page.goto(`${BASE}/app/design-review?project=proj-a`);

			const outcome = page.getByTestId('design-review-outcome');
			await expect(outcome).toHaveText(badge);
			await expect(outcome).toHaveAttribute('data-decision', 'approved');
			await expect(page.getByRole('button', { name: 'Continue with Caddie' })).toHaveCount(0);
			await expect(page.getByTestId('design-review-plan-body')).not.toHaveAttribute('open');
			const go = page.getByTestId('plan-see-build');
			await expect(go).toHaveText(action);
			// It is a link to the Build tab, drawn as a button: no underline.
			await expect(go).toHaveCSS('text-decoration-line', 'none');
			if (process.env.PLAN_SHOTS) await page.screenshot({ path: `${process.env.PLAN_SHOTS}/plan-tab-${phase}.png` });
			await go.click();
			await expect(page).toHaveURL(/\/app\/runs\?project=proj-a/);
			await context.close();
		});
	}
});
