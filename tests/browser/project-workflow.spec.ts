import { expect, test, type BrowserContext, type Route } from '@playwright/test';

/** Real composed SPA + real Flue SDK HTTP requests; auth, workflows, model
 * transcript and generated HTML are SIMULATED at their network boundaries.
 * This suite proves UI/admission/ack behavior, not live model or sandbox success.
 * Run after `bun run build` so ProjectWorkflow is in the composed client. */
const BASE = 'http://127.0.0.1:4173';
const NOW = '2026-10-11T10:00:00.000Z';
const OFFSET = '0000000000000000_0000000000000001';
const HOME = { id: 'home-workflow', workspaceId: 'ws-workflow', name: 'Home', description: null, status: 'active', kind: 'home', createdAt: NOW, updatedAt: NOW };
const PROJECT = { ...HOME, id: 'proj-workflow', name: 'Todoer', description: 'A modern minimal todo app', kind: 'standard' };
const binding = (projectId: string, conversationId: string) => ({ runId: `run-${projectId}`, projectId, conversationId, submissionId: `sub-${projectId}`, planRevision: 'rev-1', stackId: 'react-hono', payerId: 'actor-workflow', modelRouteId: 'nemotron-3-super', pricingVersion: 'v1', createdBy: 'actor-workflow', createdAt: NOW });
const plan = (revision: number) => ({ id: `plan-${revision}`, projectId: PROJECT.id, kind: 'prd', revision, bodyHash: `sha256-plan-${revision}`, body: `# Minimal Todo app\n\n## What you can do\n\n- Add tasks\n- Complete and delete tasks\n- Save tasks in your browser${revision > 1 ? '\n- Filter active and completed tasks' : ''}`, createdBy: 'actor-workflow', createdAt: NOW });
const TODO = `<!doctype html><html><head><title>Todoer</title></head><body><h1>Todoer</h1><form><input aria-label="New task"><button>Add task</button></form><ul></ul><script>
var todos = JSON.parse(localStorage.getItem('todos') || '[]');
function render() { document.querySelector('ul').replaceChildren(...todos.map(function(task) { var li = document.createElement('li'); li.textContent = task; return li; })); }
document.querySelector('form').addEventListener('submit', function(event) { event.preventDefault(); todos.push(document.querySelector('input').value); localStorage.setItem('todos', JSON.stringify(todos)); document.querySelector('input').value = ''; render(); }); render();
</script></body></html>`;

type Phase = 'planning' | 'review' | 'building' | 'blocked' | 'ready';
interface Admission { conversationId: string; body: Record<string, unknown> }
function json(route: Route, status: number, value: unknown) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) }); }

async function fixture(context: BrowserContext, options: { phase?: Phase; pending?: boolean; failAdmission?: number; failPreview?: number; repeatHandoff?: boolean; planBody?: string; features?: Record<string, unknown>[]; approved?: boolean } = {}) {
	let currentPlan = options.planBody ? { ...plan(1), body: options.planBody } : plan(1);
	let features = options.features ?? [];
	const rollbacks: Record<string, unknown>[] = [];
	let failedAdmissions = options.failAdmission ?? 0;
	let failedPreviews = options.failPreview ?? 0;
	const workflow = {
		projectId: PROJECT.id, runId: 'run-project-workflow', conversationId: 'conv-project-workflow', sourceConversationId: 'conv-home-workflow',
		brief: 'Build a modern beautiful minimal todo app.', phase: options.phase ?? 'review' as Phase, planId: currentPlan.id,
		previewId: options.phase === 'ready' ? 'output-workflow' : null as string | null,
		pendingKey: options.pending ? 'intake:workflow-key' : null as string | null,
		pendingBody: options.pending ? 'Prepare the original todo app request.' : null as string | null,
		detail: null as string | null, updatedAt: NOW,
	};
	const decisions: Record<string, unknown>[] = [];
	const admissions: Admission[] = [];
	const acks: Record<string, unknown>[] = [];
  const stops: string[] = [];
	let previewReads = 0;
	const snapshot = () => ({ workflow: { ...workflow }, plan: currentPlan, approval: options.approved ? { id: 'apr-workflow', status: 'approved' } : null });
	await context.route('**/api/**', async route => {
		const request = route.request(), path = new URL(request.url()).pathname;
		if (path === '/api/auth/status') return json(route, 200, { authenticated: true });
		if (path === '/api/onboarding') return json(route, 200, { completedAt: NOW });
		if (path === '/api/auth/get-session') return json(route, 200, { session: { userId: 'actor-workflow' }, user: { id: 'actor-workflow', name: 'Ada', email: 'ada@example.test' } });
		if (path === '/api/home-project') return json(route, 200, { project: HOME });
		if (path === '/api/profile') return json(route, 200, { profile: null });
		if (path === '/api/projects') return json(route, 200, { projects: [HOME, PROJECT] });
		if (path === '/api/brief') return json(route, 200, { cards: [], unseenCount: 0, projects: [HOME, PROJECT], asOf: NOW });
		if (path.endsWith('/brief/read')) return json(route, 200, { marked: 0 });
		if (path === '/api/usage') return json(route, 200, { payer: { payerId: 'actor-workflow', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 0, reservations: 0 } });
		if (path.endsWith('/workflow/rollback')) {
			const body = request.postDataJSON() as Record<string, unknown>;
			rollbacks.push(body);
			const target = features.find((f) => f.id === body.featureId) as { position: number; title: string } | undefined;
			features = features.map((f) => (Number(f.position) > (target?.position ?? 0)
				? { ...f, status: 'pending', testsPassed: null, passedAt: null, canRollBack: false }
				: { ...f, canRollBack: false }));
			workflow.phase = 'blocked'; workflow.previewId = null;
			workflow.detail = `Rolled back to just after “${target?.title}”. The app's files are exactly as they were when it passed; 1 later feature will be built again when you press Retry.`;
			return json(route, 200, snapshot());
		}
		if (path.endsWith('/activity')) return json(route, 200, {
			projectId: PROJECT.id, phase: workflow.phase, building: workflow.phase === 'building', steps: [], rounds: [], openIssues: 0, features,
			timeline: { phase: workflow.phase, startedAt: NOW, lastActivityAt: NOW, elapsedMs: 60_000, idleMs: 5_000, quiet: false, summary: 'Caddie is writing the app.', stages: [], scope: [], files: [], fileAreas: { app: 0, test: 0, style: 0, config: 0, server: 0 }, commands: [], tests: null, checks: [] },
		});
		if (path.endsWith('/workflow/stop')) {
      stops.push(path); workflow.phase = 'blocked'; workflow.pendingKey = null; workflow.pendingBody = null;
      workflow.detail = 'Stop requested. Your plan and files are retained.';
      return json(route, 200, snapshot());
    }
    if (path.endsWith('/workflow/decision')) {
			const body = request.postDataJSON() as Record<string, unknown>;
			decisions.push(body);
			if (body.planId !== currentPlan.id) return json(route, 409, { error: 'STALE_PLAN', message: 'The plan changed. Review the latest version.' });
			workflow.phase = body.decision === 'approved' ? 'building' : 'planning';
			// R02: the SERVER delivers the pending message to the coordinator DO and
			// acks it inside this route — so the response carries no pending slot and
			// the browser performs no admission/ack of its own.
			workflow.pendingKey = null;
			workflow.pendingBody = null;
			return json(route, 200, snapshot());
		}
		if (path.endsWith('/workflow/ack')) {
			const body = request.postDataJSON() as Record<string, unknown>;
			acks.push(body);
			if (body.key === workflow.pendingKey) { workflow.pendingKey = null; workflow.pendingBody = null; }
			return json(route, 200, { acknowledged: true });
		}
		if (path.includes('/workflow/preview/')) {
			previewReads++;
			if (failedPreviews-- > 0) return json(route, 403, { error: 'preview_denied' });
			return route.fulfill({ contentType: 'text/html', body: TODO });
		}
		if (path.endsWith('/workflow')) return json(route, 200, path.includes(HOME.id) ? { workflow: null, plan: null, approval: null } : snapshot());
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [path.includes(HOME.id) ? binding(HOME.id, 'conv-home-workflow') : binding(PROJECT.id, workflow.conversationId)] });
		if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [currentPlan], latest: currentPlan });
		if (path.endsWith('/plan-decisions')) return json(route, 200, { decisions: [] });
		if (path.endsWith('/tasks')) return json(route, 200, { tasks: [] });
		if (path.endsWith('/previews')) return json(route, 200, { previews: [] });
		if (path.endsWith('/artifact-revisions')) return json(route, 200, { artifacts: [], latest: null });
		return json(route, 200, {});
	});
	await context.route('**/agents/coordinator/**', async route => {
		const request = route.request(), url = new URL(request.url());
		const conversationId = url.pathname.split('/').pop()!;
    if (request.method() === 'POST' && url.pathname.endsWith('/abort')) {
      stops.push(url.pathname); return json(route, 200, { aborted: true });
    }
		if (request.method() === 'POST') {
			admissions.push({ conversationId, body: request.postDataJSON() as Record<string, unknown> });
			if (failedAdmissions-- > 0) return json(route, 503, { error: { code: 'test_connection', message: 'Simulated connection failure' } });
			return json(route, 202, { streamUrl: `${BASE}${url.pathname}`, offset: OFFSET, submissionId: 'sub-admitted', uid: 'uid-workflow' });
		}
		if (url.searchParams.get('view') === 'updates') {
			return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
		}
		const messages = conversationId === 'conv-home-workflow' ? [{ id: 'message-created-project', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: NOW, parts: [
			{ type: 'text', text: 'I created Todoer for your request. Review its plan here.', state: 'done' },
			{ type: 'data-projectWorkflow', data: { projectId: PROJECT.id, name: PROJECT.name } },
		] }] : [];
		return route.fulfill({ contentType: 'application/json', headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' }, body: JSON.stringify({ v: 1, conversationId, offset: OFFSET, messages: options.repeatHandoff ? [...messages, ...messages.map(m => ({...m, id: m.id + '-continued'}))] : messages, settlements: [] }) });
	});
	return {
		workflow, decisions, admissions, acks, stops, rollbacks,
		get previewReads() { return previewReads; },
		revise() { currentPlan = plan(currentPlan.revision + 1); workflow.planId = currentPlan.id; workflow.phase = 'review'; workflow.pendingKey = null; workflow.pendingBody = null; },
		ready() { workflow.phase = 'ready'; workflow.previewId = 'output-workflow'; workflow.pendingKey = null; workflow.pendingBody = null; },
	};
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); });

const FEATURE_PLAN = [
	'# Farm log', '', 'Log feed and see it on a dashboard.', '',
	'```caddie-features',
	JSON.stringify([
		{ id: 'log-feed', title: 'Log daily feed', doneWhen: ['Saving 12 kg shows 12 kg in today’s list', 'The entry is still there after a reload'] },
		{ id: 'view-dashboard', title: 'See the feed dashboard', doneWhen: ['The dashboard totals this week’s feed'] },
	]),
	'```',
].join('\n');
const featureView = (id: string, title: string, position: number, extra: Record<string, unknown> = {}) =>
	({ id, title, doneWhen: ['check'], position, status: 'passed', attempts: 0, testsPassed: position, passedAt: NOW, canRollBack: false, ...extra });

test('the plan review lists what will be built as a checklist, never as raw JSON', async ({ page, context }) => {
	await fixture(context, { planBody: FEATURE_PLAN });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'review');
	const list = card.getByTestId('plan-features');
	await expect(list.getByRole('heading', { name: 'What Caddie will build · 2' })).toBeVisible();
	await expect(list.locator('.plan-feature-title')).toHaveText(['Log daily feed', 'See the feed dashboard']);
	await expect(card.getByTestId('plan-feature-log-feed').locator('li')).toHaveText(['Saving 12 kg shows 12 kg in today’s list', 'The entry is still there after a reload']);
	await expect(card).not.toContainText('caddie-features');
	await expect(card).not.toContainText('"doneWhen"');
});

test('a finished build shows each feature and rolls back to a save point in two clicks', async ({ page, context }) => {
	const state = await fixture(context, {
		phase: 'ready',
		approved: true,
		planBody: FEATURE_PLAN,
		features: [
			featureView('log-feed', 'Log daily feed', 1, { canRollBack: true }),
			featureView('view-dashboard', 'See the feed dashboard', 2),
		],
	});
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	const features = card.getByTestId('build-features');
	await expect(features.getByRole('heading', { name: 'Features · 2 of 2 done' })).toBeVisible();
	await expect(card.getByTestId('build-feature-log-feed')).toContainText('Done · 1 test passing');
	await expect(card.getByTestId('rollback-view-dashboard')).toHaveCount(0);
	await card.getByTestId('rollback-log-feed').click();
	// The first click only explains what will be undone; nothing is sent yet.
	await expect(card.getByTestId('build-feature-log-feed')).toContainText('Undo everything after this? 1 later feature goes back to the list');
	expect(state.rollbacks).toHaveLength(0);
	await card.getByTestId('rollback-confirm-log-feed').click();
	await expect(card).toHaveAttribute('data-phase', 'blocked');
	expect(state.rollbacks).toHaveLength(1);
	expect(state.rollbacks[0]?.featureId).toBe('log-feed');
	expect(String(state.rollbacks[0]?.key)).toMatch(/^rollback:log-feed:[0-9a-f-]{36}$/);
	await expect(card).toContainText('Rolled back to just after “Log daily feed”');
	await expect(card.getByRole('button', { name: 'Retry build' })).toBeVisible();
	await expect(card.getByTestId('build-feature-view-dashboard')).toHaveAttribute('data-status', 'pending');
});

test('Home chat shows a readable project plan; approval admits the correct build and acknowledges its durable key', async ({ page, context }) => {
	const state = await fixture(context);
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveCount(1);
	await expect(card).toHaveAttribute('data-phase', 'review');
	await expect(card.getByRole('heading', { name: 'Minimal Todo app' })).toBeVisible();
	await expect(card.locator('li')).toHaveText(['Add tasks', 'Complete and delete tasks', 'Save tasks in your browser']);
	await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');
	await card.getByRole('button', { name: 'Looks good — build it' }).click();
	await expect(card).toHaveAttribute('data-phase', 'building');
	expect(state.decisions).toEqual([{ planId: 'plan-1', decision: 'approved' }]);
	// R02: dispatch is server-owned. The browser makes NO coordinator admission
	// and NO ack of its own — the decision route delivered + acked server-side.
	expect(state.admissions).toHaveLength(0);
	expect(state.acks).toHaveLength(0);
	await expect(page).toHaveURL(`${BASE}/app/`);
	await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');
	await page.reload();
	await expect(page.getByTestId('channel').getByTestId('project-workflow')).toHaveAttribute('data-phase', 'building');
	expect(state.admissions).toHaveLength(0);
});

test('feedback requires text, continues planning in the target conversation and returns a new readable revision after reload', async ({ page, context }) => {
	const state = await fixture(context);
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await card.getByRole('button', { name: 'Suggest a change' }).click();
	await expect(card.getByRole('button', { name: 'Send feedback' })).toBeDisabled();
	await card.getByLabel('What should change?').fill('Please include active and completed filters.');
	await card.getByRole('button', { name: 'Send feedback' }).click();
	await expect(card).toHaveAttribute('data-phase', 'planning');
	expect(state.decisions).toEqual([{ planId: 'plan-1', decision: 'rejected', note: 'Please include active and completed filters.' }]);
	// R02: the server delivers the revise message to the coordinator; the browser
	// makes no admission of its own.
	expect(state.admissions).toHaveLength(0);
	state.revise();
	await page.reload();
	await expect(page.getByTestId('channel').getByTestId('project-workflow')).toHaveAttribute('data-phase', 'review');
	await expect(page.getByTestId('channel').getByTestId('project-workflow').locator('li')).toContainText(['Filter active and completed tasks']);
	await page.getByTestId('channel').getByTestId('project-workflow').getByRole('button', { name: 'Looks good — build it' }).click();
	await expect(page.getByTestId('channel').getByTestId('project-workflow')).toHaveAttribute('data-phase', 'building');
	expect(state.decisions[1]).toEqual({ planId: 'plan-2', decision: 'approved' });
	expect(state.admissions).toHaveLength(0);
});

test('R02: a pending planning project is server-owned — the browser makes no admission and shows no client-dispatch error', async ({ page, context }) => {
	// Pre-R02 the browser drove dispatch on a pending slot and could error; R02
	// moved that to the server, so the tab only OBSERVES. A planning project
	// with a pending slot must not trigger a browser coordinator admission and
	// must not surface a "could not continue" client error.
	const state = await fixture(context, { phase: 'planning', pending: true });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'planning');
	// No client-driven dispatch: no admission, no ack, no continuation error.
	expect(state.admissions).toHaveLength(0);
	expect(state.acks).toHaveLength(0);
	await expect(card.getByRole('alert')).toHaveCount(0);
});

test('ready app remains inside Home chat, has access-error retry, and persists generated todos across reload', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', failPreview: 1 });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	await expect(card.getByRole('alert')).toContainText('You do not have access');
	await card.getByRole('button', { name: 'Try again' }).click();
	const preview = card.frameLocator('iframe');
	await preview.getByRole('textbox', { name: 'New task' }).fill('Review real Caddie journey');
	await preview.getByRole('button', { name: 'Add task' }).click();
	await expect(preview.getByRole('listitem')).toHaveText('Review real Caddie journey');
	await expect.poll(() => page.evaluate("localStorage.getItem('caddie:preview:actor-workflow:proj-workflow')")).toContain('Review real Caddie journey');
	await page.reload();
	await expect(page.getByTestId('channel').getByTestId('project-workflow').frameLocator('iframe').getByRole('listitem')).toHaveText('Review real Caddie journey');
	await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');
	expect(state.admissions).toHaveLength(0);
	expect(state.previewReads).toBe(3);
});

test('mobile Home chat retains the embedded workflow and opens its explicit project only when requested', async ({ page, context }) => {
	await fixture(context);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/?pane=channel`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card.getByRole('heading', { name: 'Your plan is ready' })).toBeVisible();
	await card.getByRole('button', { name: 'Open project' }).click();
	await expect(page).toHaveURL(/project=proj-workflow/);
	await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'project');
});


test('repeated project handoffs keep one live card and one preview', async ({ context, page }) => {
  await fixture(context, { phase: 'ready', repeatHandoff: true });
  await page.goto('/app/?pane=channel');
  await expect(page.getByTestId('project-workflow')).toHaveCount(1);
  await expect(page.getByTestId('interactive-preview')).toHaveCount(1);
  await expect(page.frameLocator('iframe[title="Your app preview"]').getByRole('heading', { name: 'Todoer' })).toBeVisible();
});


test('Stop build sends durable abort and retains the stopped project', async ({ context, page }) => {
  const fx = await fixture(context, { phase: 'building' });
  await page.goto('/app/?pane=channel');
  await page.getByRole('button', { name: 'Stop build', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.getByTestId('project-workflow')).toContainText('Your plan and files are retained');
  expect(fx.stops).toEqual(['/agents/coordinator/conv-project-workflow/abort', '/api/projects/proj-workflow/workflow/stop']);
  expect(fx.admissions).toHaveLength(0);
});
