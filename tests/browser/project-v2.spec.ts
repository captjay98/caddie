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
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
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
        if (path.endsWith('/workflow')) return json(route, 200, { workflow: opts.workflowPhase ? { phase: opts.workflowPhase, brief: 'Build FarmLog AI.' } : null, importPreview: opts.importPreview ?? null });
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
	test('Overview: a copied example with no build workflow is ready to try (review F04)', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			experience: { projectId: 'proj-a', version: 0, stage: 'planning', plan: null, preview: null, message: 'No plan yet.', actions: [] },
			importPreview: { status: 'ready', origin: 'example', message: null, outputId: 'out-ex', repoFullName: 'Todoer', versionSeq: 1, hasServer: false },
			share: false,
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('overview-preview-ready')).toHaveText('An example app Caddie built is ready to try.');
		await expect(page.getByTestId('overview-try-app')).toBeVisible();
		await expect(page.getByTestId('overview-preview-share')).toHaveCount(0);
		if (process.env.CADDIE_SHOTS) {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByTestId('overview-preview').screenshot({ path: join(process.env.CADDIE_SHOTS, 'overview-app-example-mobile.png') });
		}
		await context.close();
	});

	test('Overview: a build finishing while the page is open flips "Your app" to ready, no reload (review F04)', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { share: false });
		let calls = 0;
		await context.route('**/api/projects/proj-a/experience', (route) => {
			calls += 1;
			const ready = calls > 1;
			return json(route, 200, {
				...READY_EXPERIENCE,
				version: Date.parse(NOW) + calls,
				stage: ready ? 'ready' : 'building',
				preview: ready ? READY_EXPERIENCE.preview : null,
			});
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('overview-preview-building')).toBeVisible();
		await expect(page.getByTestId('overview-preview-ready')).toHaveText('Your app is ready to try.', { timeout: 10_000 });
		await context.close();
	});

	test('Overview: Try your app opens the chat pane, where the app runs (phone width, review F04)', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(context, { experience: READY_EXPERIENCE });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await page.getByTestId('overview-try-app').click();
		await expect(page).toHaveURL(/pane=channel/);
		await context.close();
	});

	test('Overview: next step card from the top open brief card with one button', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			brief: [
				card('brf_approval_1', 'approval', 'needs-you', 'The plan needs your OK', 'Caddie drafted version 1 and waits for your decision.'),
				card('brf_result_1', 'result', 'handled', 'Build finished', 'The latest build produced a preview.'),
			],
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);

		const next = page.getByTestId('overview-next-step');
		await expect(next).toContainText('The plan needs your OK');
		// Exactly ONE button on the next-step card.
		await expect(next.locator('button')).toHaveCount(1);
		await page.getByTestId('overview-next-action').click();
		await expect(page).toHaveURL(/design-review\?project=proj-a/);
		await context.close();
	});

	test('Steps: the step the work is on is highlighted; phones get "Step 1 of 4 · Plan" and a bar', async ({ browser }) => {
		const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await stubAccount(desktop, { workflowPhase: 'planning' });
		const page = await desktop.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('project-tab-plan')).toHaveAttribute('data-active', 'true');
		await expect(page.getByTestId('project-tab-plan')).toContainText('Caddie is drafting it');
		await expect(page.getByTestId('project-tab-build')).toContainText('After you approve');
		await expect(page.getByTestId('project-steps-compact')).toBeHidden();
		await expect(page.getByTestId('overview-brief-open')).toContainText('Read the full brief');
		await desktop.close();

		const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(phone, { workflowPhase: 'planning' });
		const mobile = await phone.newPage();
		await mobile.goto(`${BASE}/app/project?project=proj-a`);
		await expect(mobile.getByTestId('project-steps-compact')).toBeVisible();
		await expect(mobile.getByTestId('project-steps-compact')).toContainText('Step 1 of 4 · Plan');
		await expect(mobile.locator('.project-steps-bar span[data-filled="true"]')).toHaveCount(1);
		// The four steps stay reachable as tabs.
		await expect(mobile.locator('.project-step')).toHaveCount(4);
		await phone.close();
	});

	test('Header: hackathon chips and a labelled Settings button; no banner or duplicate chat input', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			hackathon: { title: 'Nebius x NVIDIA Global AI Hackathon', url: 'https://nebiusglobalaihackathon.devpost.com', track: null, deadline: '2026-10-30', daysLeft: 15, ended: false, eligibility: 'eligible' },
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('project-chip-event')).toHaveText('Nebius x NVIDIA Global AI Hackathon');
		await expect(page.getByTestId('project-chip-event')).toHaveAttribute('target', '_blank');
		await expect(page.getByTestId('project-chip-deadline')).toHaveText('Ends Oct 30 · 15 days left');
		await expect(page.getByTestId('project-chip-eligibility')).toHaveText('You can enter');
		await expect(page.getByTestId('project-settings-gear')).toHaveText('Settings');
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
		await expect(page.getByTestId('overview-next-step')).toContainText('Let’s get started');
		await expect(page.getByTestId('overview-brief-building')).toHaveCount(0);
		await expect(page.getByTestId('overview-now')).toHaveCount(0);
		await context.close();
	});

	test('Overview: while Caddie plans, the Now panel says so instead of "Let\'s get started"', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, {
			experience: { projectId: 'proj-a', version: Date.now() - 2 * 60_000, stage: 'planning', plan: null, preview: null, message: 'Caddie is preparing a plan for this project.', actions: [] },
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		const now = page.getByTestId('overview-now');
		await expect(now).toHaveAttribute('data-stage', 'planning');
		await expect(page.getByTestId('overview-now-title')).toHaveText('Caddie is writing your plan');
		await expect(page.getByTestId('overview-now-updated')).toHaveText('Updated 2 min ago');
		await expect(page.getByTestId('overview-next-step')).toHaveCount(0);
		await expect(page.locator('body')).not.toContainText('Let’s get started');
		await expect(page.getByTestId('overview-brief-building')).toBeVisible();
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
		await page.goto(`${BASE}/app/project?project=proj-a`);
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
		await expect(page.getByTestId('overview-next-step')).toContainText('Nothing needs you right now');
		// Finished work folds under "What happened recently".
		const recent = page.getByTestId('overview-recent');
		await expect(recent).toContainText('What happened recently · 1');
		await context.close();
	});

	test('Overview: "Your app" reads the checked build, offers Try your app, states a share link separately, and to-dos embed', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, { experience: READY_EXPERIENCE });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		// Review F04: the app is there because the build produced it, not because a share link exists.
		await expect(page.getByTestId('overview-preview-ready')).toHaveText('Your app is ready to try.');
		await expect(page.getByTestId('overview-try-app')).toBeVisible();
		await expect(page.getByTestId('overview-preview-share')).toContainText('A private share link is also live');
		await expect(page.getByTestId('overview-preview')).not.toContainText('in the chat');
		if (process.env.CADDIE_SHOTS) {
			await page.getByTestId('overview-preview').screenshot({ path: join(process.env.CADDIE_SHOTS, 'overview-app-ready.png') });
		}

		// The to-do list is embedded; the create form hides behind the button.
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

		// The approve window fetches the real usage and states the cap.
		await page.getByTestId('plan-approve-open').click();
		await expect(page.getByTestId('approve-plan-window')).toBeVisible();
		await expect(page.getByTestId('approve-plan-spend')).toContainText('$500');
		await expect(page.getByTestId('approve-plan-spend')).toContainText('$25 used so far');

		// Approving posts the revision-bound intent (no window, no approval).
		await page.getByTestId('design-review-approve').click();
		await expect(page.getByTestId('design-review-outcome')).toHaveAttribute('data-decision', 'approved');

        // A settled revision cannot be re-decided by an opposite button.
        await expect(page.getByTestId('plan-changes-open')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Continue with Caddie' })).toBeVisible();
        // Markdown is a real list rather than literal source text.
        await expect(page.getByTestId('plan-body-content').locator('li')).toContainText('render a live chart');
        await expect(page.getByTestId('design-review-scope')).not.toHaveAttribute('open');
        await page.screenshot({ path: '/tmp/caddie-plan-review.png' });

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
        await expect(page.getByTestId('design-review-outcome')).toContainText('Plan approved');
        await expect(page.getByTestId('plan-approve-open')).toHaveCount(0);
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

		// Past builds are sentences, not "run 14" tokens.
		await expect(page.getByTestId('run-row')).toContainText('A build ran');
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
