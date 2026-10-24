import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import { previewDocument } from '../../apps/app/src/shared/preview-frame.ts';

/** SIMULATED API/agent boundaries; real composed chat and route navigation. */
const NOW = '2026-10-22T10:00:00.000Z';
const OFFSET = '0000000000000000_0000000000000001';
const HOME = { id: 'home-focused', workspaceId: 'ws-focused', name: 'Home', kind: 'home', description: null, status: 'active', createdAt: NOW, updatedAt: NOW };
const PROJECT = { ...HOME, id: 'proj-focused', name: 'Pantry Pilot', kind: 'standard', description: 'Meal plans from your pantry.' };
const json = (route: Route, body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });

test.beforeEach(async ({ page }) => {
	page.on('pageerror', error => console.error('Focused workspace page error:', error.stack));
});

async function fixture(context: BrowserContext, phase: string, options: { repair?: boolean; copied?: boolean } = {}) {
	const writes: string[] = [];
	const workflow = { projectId: PROJECT.id, runId: 'run-focused', conversationId: 'conv-focused', sourceConversationId: null, brief: PROJECT.description, phase, planId: 'plan-focused', previewId: phase === 'ready' ? 'output-exact' : null, pendingKey: null, pendingBody: null, detail: null, updatedAt: NOW };
	const plan = { id: 'plan-focused', projectId: PROJECT.id, kind: 'prd', revision: 1, body: '# Pantry Pilot\n\nMeal plans from the ingredients you already have.', bodyHash: 'sha-plan-focused', createdAt: NOW };
	const design = { ...plan, id: 'design-focused', kind: 'design', body: '# Pantry Pilot design\n\nPantry first, meal plan second, shopping list third.' };
	const planApproval = { projectId: PROJECT.id, action: 'design', resourceId: plan.id, revisionHash: plan.bodyHash, policyVersion: 'v1', id: 'approval-focused', intentHash: 'intent-focused', decidedBy: 'actor-focused', status: 'approved', expiresAt: '2027-01-01T00:00:00.000Z' };
	const approved = () => !['planning', 'review', 'blocked'].includes(workflow.phase);
	const snapshot = () => ({
		workflow: options.copied ? null : workflow, plan, approval: approved() ? planApproval : null, design, designApproval: null,
		importPreview: options.copied ? { status: 'ready', versionSeq: 1, origin: 'github', repoFullName: 'jay/pantry', outputId: 'copied-exact', hasServer: true, message: null } : null,
	});
	await context.route('**/api/**', route => {
		const request = route.request(), path = new URL(request.url()).pathname;
		if (request.method() === 'POST' && !path.endsWith('/brief/read')) writes.push(path);
		if (path === '/api/auth/status') return json(route, { authenticated: true });
		if (path === '/api/auth/get-session') return json(route, { session: { userId: 'actor-focused' }, user: { id: 'actor-focused', name: 'Jay', email: 'jay@example.test' } });
		if (path === '/api/onboarding') return json(route, { completedAt: NOW });
		if (path === '/api/home-project') return json(route, { project: HOME });
		if (path === '/api/projects') return json(route, { projects: [HOME, PROJECT] });
		if (path === '/api/project-hackathons') return json(route, { hackathons: {} });
		if (path.endsWith('/experience')) return json(route, {
			projectId: PROJECT.id, version: options.copied ? 0 : Date.parse(NOW),
			stage: options.repair ? 'repairing' : workflow.phase === 'design-review' ? 'design_review' : workflow.phase === 'blocked' ? 'planning_blocked' : workflow.phase,
			plan: options.copied ? null : { id: plan.id, revision: '1', approved: !['review', 'planning'].includes(workflow.phase) },
			preview: workflow.previewId ? { id: workflow.previewId, revision: '1', current: true } : null,
			message: 'Caddie is adding the shopping list.', actions: [],
		});
		if (path.endsWith('/plan-docs')) return json(route, { revisions: [plan, design], latest: plan });
		if (path === '/api/approvals' || path === '/api/approvals/approval-focused') return json(route, { approval: approved() ? planApproval : null });
		if (path.endsWith('/workflow/design-decision') && request.method() === 'POST') {
			workflow.phase = 'building';
			return json(route, snapshot());
		}
		if (path.endsWith('/run-bindings')) return json(route, { runBindings: [{ runId: 'run-focused', projectId: PROJECT.id, conversationId: 'conv-focused', submissionId: 's', planRevision: 'r', stackId: 'react-hono', payerId: 'actor-focused', modelRouteId: 'route', pricingVersion: 'v1', createdBy: 'actor-focused', createdAt: NOW }] });
		if (path.endsWith('/workflow')) return json(route, snapshot());
		if (/\/workflow\/preview\/[^/]+\/seed$/.test(path)) return json(route, { seedRef: 'seed-focused' });
		if (/\/workflow\/preview\/[^/]+\/document$/.test(path)) return route.fulfill({
			contentType: 'text/html', body: previewDocument('<h1>Pantry Pilot</h1><button>Make a meal plan</button>', new URL(request.url()).searchParams.get('nonce') ?? '', {}, Boolean(options.copied), 'web'),
		});
		if (/\/workflow\/preview\/[^/]+\/metadata$/.test(path)) return json(route, { outputId: path.split('/').at(-2), kind: 'web', hasServer: Boolean(options.copied) });
		if (/\/workflow\/preview\/[^/]+$/.test(path)) return route.fulfill({ contentType: 'text/html', body: '<html><body><h1>Pantry Pilot</h1><button>Make a meal plan</button></body></html>' });
		if (path.endsWith('/activity')) return json(route, {
			projectId: PROJECT.id, phase, building: phase === 'building', steps: [], rounds: [], openIssues: options.repair ? 1 : 0,
			features: [{ id: 'pantry', title: 'Add pantry ingredients', doneWhen: ['Ingredients save'], position: 1, status: 'passed', attempts: 0, testsPassed: 1, passedAt: NOW, canRollBack: false }, { id: 'list', title: 'Make a shopping list', doneWhen: ['List uses missing ingredients'], position: 2, status: 'building', attempts: 0, testsPassed: null, passedAt: null, canRollBack: false }],
			timeline: { phase, startedAt: NOW, lastActivityAt: NOW, elapsedMs: 60_000, idleMs: 1000, quiet: false, summary: options.repair ? 'Repairing ingredient totals.' : 'Adding the shopping list.', stages: [], scope: [], files: [], fileAreas: { app: 0, test: 0, style: 0, config: 0, server: 0 }, commands: [], tests: null, checks: [] },
		});
		if (path === '/api/brief') return json(route, { cards: [], unseenCount: 0, projects: [HOME, PROJECT], asOf: NOW });
		if (path.endsWith('/brief')) return json(route, { cards: [] });
		if (path === '/api/profile') return json(route, { profile: null });
		if (path.endsWith('/previews')) return json(route, { previews: [] });
		return json(route, {});
	});
	await context.route('**/agents/coordinator/**', route => {
		const url = new URL(route.request().url());
		if (url.searchParams.get('view') === 'updates') return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
		return route.fulfill({ contentType: 'application/json', headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' }, body: JSON.stringify({ v: 1, conversationId: 'conv-focused', offset: OFFSET, messages: [], settlements: [] }) });
	});
	return writes;
}

for (const width of [390, 1440]) {
	test(`compact chat at ${width}px has one project update and opens the full build`, async ({ page, context }) => {
		await page.setViewportSize({ width, height: 960 });
		const writes = await fixture(context, 'building');
		await page.goto('/app/project?project=proj-focused&pane=channel');
		const summary = page.getByTestId('workflow-summary');
		await expect(summary).toContainText('Pantry Pilot');
		await expect(summary).toContainText('Adding the shopping list.');
		await page.screenshot({ path: `/tmp/caddie-focused-compact-chat-${width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: true });
		await expect(summary.locator('iframe')).toHaveCount(0);
		await expect(summary.getByTestId('build-progress')).toHaveCount(0);
		await summary.getByText('Feature progress', { exact: false }).click();
		await expect(summary).toContainText('1 of 2 checked');
		await expect(summary).toContainText('Add pantry ingredients');
		await summary.getByRole('button', { name: 'View build' }).click();
		await expect(page).toHaveURL(/\/runs\?project=proj-focused/);
		expect(writes).toEqual([]);
	});
}

for (const [phase, label] of [['review', 'Review plan'], ['design-review', 'Review design']] as const) {
	test(`${phase} in chat opens the Plan workspace without making a decision`, async ({ page, context }) => {
		const writes = await fixture(context, phase);
		await page.goto('/app/project?project=proj-focused&pane=channel');
		await page.getByTestId('workflow-summary').getByRole('button', { name: label, exact: true }).click();
		await expect(page).toHaveURL(/\/design-review\?project=proj-focused/);
		expect(writes).toEqual([]);
	});
}

test('repair in chat names the issue and opens Check, without nesting build UI', async ({ page, context }) => {
	await fixture(context, 'building', { repair: true });
	await page.goto('/app/project?project=proj-focused&pane=channel');
	const summary = page.getByTestId('workflow-summary');
	await expect(summary).toHaveAttribute('data-design', 'repair');
	await expect(summary).toContainText('Repairing ingredient totals.');
	await summary.getByRole('button', { name: 'View repair' }).click();
	await expect(page).toHaveURL(/\/evidence\?project=proj-focused/);
});

for (const copied of [false, true]) {
	test(`${copied ? 'copied' : 'built'} ready app opens its exact preview beyond chat`, async ({ page, context }) => {
		const writes = await fixture(context, 'ready', { copied });
		await page.goto('/app/project?project=proj-focused&pane=channel');
		const summary = page.getByTestId('workflow-summary');
		await expect(summary.locator('iframe')).toHaveCount(0);
		await summary.getByRole('button', { name: 'Try your app' }).click();
		await expect(page).toHaveURL(new RegExp(`/preview\\?project=proj-focused&preview=${copied ? 'copied-exact' : 'output-exact'}&source=workflow`));
		// Existing preview bootstrapping stores only this exact output's local-data seed.
		expect(writes.filter(path => !new RegExp(`/workflow/preview/${copied ? 'copied-exact' : 'output-exact'}/seed$`).test(path))).toEqual([]);
	});
}

for (const width of [390, 1440]) {
	test(`Focused workspace at ${width}px keeps cards compact and opens the current step`, async ({ page, context }) => {
		await page.setViewportSize({ width, height: 960 });
		await fixture(context, 'building');
		await page.goto('/app/projects');
		const card = page.getByTestId(`project-row-${PROJECT.id}`);
		await expect(card).toContainText('Pantry Pilot');
		await expect(card.locator('.project-journey')).toHaveCount(0);
		await page.screenshot({ path: `/tmp/caddie-focused-project-list-${width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: true });
		await expect(card.locator('.project-card-foot button, .project-card-foot a')).toHaveCount(1);
		await card.getByRole('button', { name: 'Pantry Pilot', exact: true }).click();
		await expect(page).toHaveURL(/\/project\?project=proj-focused/);
		const workspace = page.getByTestId('focused-project-home');
		await expect(workspace).toHaveAttribute('data-step', 'build');
		await expect(workspace.getByTestId('project-workflow')).toBeVisible();
		await expect(page.getByTestId('overview-idea')).toHaveCount(0);
		await expect(page.getByTestId('overview-preview')).toHaveCount(0);
		await expect(page.getByTestId('project-tab-build')).toHaveAttribute('aria-current', 'page');
		const box = await workspace.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
		await page.screenshot({ path: `/tmp/caddie-focused-workspace-${width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: true });
	});
}

test('the chat summary is hidden beside the Plan tab in a pre-build phase, kept in chat-only and once building', async ({ page, context }) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	await fixture(context, 'design-review');
	// A pre-build phase: the Plan tab's left pane already shows the full
	// workflow card, so the chat summary beside it would be pure duplication.
	await page.goto('/app/design-review?project=proj-focused');
	await expect(page.getByTestId('workflow-summary')).toHaveCount(0);
	// The chat-only view (pane=channel) always keeps it — it is the only
	// workflow view there.
	await page.goto('/app/design-review?project=proj-focused&pane=channel');
	await expect(page.getByTestId('workflow-summary')).toBeVisible();
});

test('Plan workspace keeps the design review and its explicit build decision', async ({ page, context }) => {
	const writes = await fixture(context, 'design-review');
	await page.goto('/app/design-review?project=proj-focused');
	const workspace = page.locator('.focused-project-content');
	await expect(workspace.getByTestId('workflow-design-brief')).toContainText('Pantry first, meal plan second, shopping list third.');
	await expect(workspace.getByTestId('workflow-approve-design')).toBeVisible();
	expect(writes).toEqual([]);
	await workspace.getByTestId('workflow-approve-design').click();
	await expect(page.getByTestId('workflow-summary')).toHaveAttribute('data-phase', 'building');
	await expect(workspace.getByTestId('workflow-approve-design')).toHaveCount(0);
	expect(writes).toEqual(['/api/projects/proj-focused/workflow/design-decision']);
});

test('Check selects its own tab and contains the full app preview', async ({ page, context }) => {
	await fixture(context, 'ready');
	await page.goto('/app/evidence?project=proj-focused');
	await expect(page.getByTestId('project-tab-evidence')).toHaveAttribute('aria-current', 'page');
	const app = page.getByTestId('project-app-checks');
	await expect(app.getByTestId('project-workflow')).toHaveAttribute('data-phase', 'ready');
	await expect(app.locator('iframe')).toHaveCount(1);
	await expect(app.frameLocator('iframe').getByRole('heading', { name: 'Pantry Pilot', exact: true })).toBeVisible();
	await expect(page.getByTestId('channel').locator('iframe')).toHaveCount(0);
});

test('a copied app keeps its full preview in the project workspace', async ({ page, context }) => {
	await fixture(context, 'ready', { copied: true });
	await page.goto('/app/project?project=proj-focused');
	const workspace = page.getByTestId('focused-project-home');
	await expect(workspace.getByTestId('imported-app')).toHaveAttribute('data-status', 'ready');
	await expect(workspace).toContainText('jay/pantry');
	await expect(workspace.locator('iframe')).toHaveCount(1);
	await expect(page.getByTestId('channel').locator('iframe')).toHaveCount(0);
});

test('the Overview leads with a plain-language summary and one tap into each of the four steps (owner 2026-10-23)', async ({ page, context }) => {
	await fixture(context, 'building');
	await page.goto('/app/project?project=proj-focused');
	// A short plain-language summary of where the project stands.
	const summary = page.getByTestId('project-overview-summary');
	await expect(summary).toBeVisible();
	await expect(summary).toContainText('Building');
	await expect(summary).toContainText('Caddie is building your app');
	// One tap into each of the four steps (the step bar).
	for (const testid of ['project-tab-plan', 'project-tab-build', 'project-tab-evidence', 'project-tab-submission']) {
		await expect(page.getByTestId(testid)).toBeVisible();
	}
});

test('a blocked plan in chat opens Plan with its explicit Continue control', async ({ page, context }) => {
	const writes = await fixture(context, 'blocked');
	await page.goto('/app/project?project=proj-focused&pane=channel');
	const summary = page.getByTestId('workflow-summary');
	await expect(summary).toContainText('The plan needs another pass');
	await summary.getByRole('button', { name: 'Review plan', exact: true }).click();
	await expect(page).toHaveURL(/\/design-review\?project=proj-focused/);
	await expect(page.locator('.focused-project-content').getByRole('button', { name: 'Continue the plan', exact: true })).toBeVisible();
	expect(writes).toEqual([]);
});

test('slow build history cannot hide the active workspace or its Stop control', async ({ page, context }) => {
	await fixture(context, 'building');
	let release!: () => void;
	let requested = false;
	const waiting = new Promise<void>(resolve => { release = resolve; });
	await context.route('**/api/projects/proj-focused/run-bindings', async route => {
		requested = true;
		await waiting;
		return json(route, { runBindings: [] });
	});
	try {
		await page.goto('/app/runs?project=proj-focused');
		await expect.poll(() => requested).toBe(true);
		const workspace = page.locator('.focused-project-content');
		await expect(workspace.getByTestId('project-workflow')).toHaveAttribute('data-phase', 'building');
		await expect(workspace.getByRole('button', { name: 'Stop build', exact: true })).toBeVisible();
	} finally {
		release();
	}
});
