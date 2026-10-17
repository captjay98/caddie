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

type Phase = 'planning' | 'review' | 'design' | 'design-review' | 'building' | 'blocked' | 'ready';
interface Admission { conversationId: string; body: Record<string, unknown> }
function json(route: Route, status: number, value: unknown) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) }); }

async function fixture(context: BrowserContext, options: { phase?: Phase; pending?: boolean; failAdmission?: number; failPreview?: number; repeatHandoff?: boolean; planBody?: string; features?: Record<string, unknown>[]; approved?: boolean; designBody?: string } = {}) {
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
	const design = options.designBody
		? { id: 'design-1', projectId: PROJECT.id, kind: 'design', revision: 2, bodyHash: 'sha256-design-1', body: options.designBody, createdBy: 'actor-workflow', createdAt: NOW }
		: null;
	const snapshot = () => ({ workflow: { ...workflow }, plan: currentPlan, approval: options.approved ? { id: 'apr-workflow', status: 'approved' } : null, design, designApproval: null });
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
    if (path.endsWith('/workflow/design-decision')) {
			const body = request.postDataJSON() as Record<string, unknown>;
			decisions.push(body);
			workflow.phase = body.decision === 'approved' ? 'building' : 'design';
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

const mockScreen = (heading: string, inner: string) =>
	`<main style="display:grid;gap:12px;padding:16px;max-width:880px;margin:0 auto"><h1 style="margin:0;font-size:20px">${heading}</h1>${inner}</main>`;
const DESIGN_BRIEF = [
	'# Farm log design', '', '## Screen inventory', '', '- Today (home) · History · Add entry', '',
	'```html-mock Today',
	mockScreen('Today', '<section style="background:var(--color-panel);color:var(--color-bright);border:1px solid var(--color-line);border-radius:12px;padding:12px">Morning feed · 12 kg</section><button style="background:var(--color-action);color:var(--color-ink);border:0;border-radius:9px;padding:10px 14px">Log feed</button>'),
	'```', '',
	'```html-mock Today · empty',
	mockScreen('Today', '<p style="color:var(--color-muted)">Nothing logged yet</p><script>document.body.dataset.ran = "yes"</script>'),
	'```', '',
	'```html-mock Add entry · error',
	mockScreen('Add entry', '<p role="alert" style="color:var(--color-danger)">Enter the weight as a number, like 12.</p>'),
	'```', '', '## Accessibility', '', 'Every control is reachable by keyboard.',
].join('\n');

test('design review shows each mocked screen at phone and desktop width, script-free, then approves the build', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'design-review', approved: true, designBody: DESIGN_BRIEF });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'design-review');
	await expect(card.getByRole('heading', { name: 'Your design is ready' })).toBeVisible();
	// The prose renders without the raw mock fences.
	await expect(card.getByTestId('workflow-design-brief').getByRole('heading', { name: 'Accessibility' })).toBeVisible();
	await expect(card).not.toContainText('html-mock');

	const preview = card.getByTestId('design-mock-preview');
	await expect(preview.getByTestId('design-mock-screens').getByRole('button')).toHaveText(['Today', 'Today · empty', 'Add entry · error']);
	const iframe = preview.getByTestId('design-mock-frame').locator('iframe');
	// The frame runs no scripts: empty sandbox + a script-forbidding CSP.
	await expect(iframe).toHaveAttribute('sandbox', '');
	await expect(iframe).toHaveAttribute('srcdoc', /script-src 'none'/);
	const frame = preview.getByTestId('design-mock-frame').frameLocator('iframe');
	await expect(frame.getByText('Morning feed · 12 kg')).toBeVisible();
	await expect(frame.getByRole('button', { name: 'Log feed' })).toBeVisible();
	// The mock paints with the app's REAL tokens (Caddie dark: action #4d9fff on page #090b10).
	await expect(frame.getByRole('button', { name: 'Log feed' })).toHaveCSS('background-color', 'rgb(77, 159, 255)');
	await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(9, 11, 16)');
	if (process.env.DESIGN_MOCK_SHOTS) await preview.screenshot({ path: `${process.env.DESIGN_MOCK_SHOTS}/design-mock-desktop-phone.png` });

	// Phone is the default: the mock lays out at 390px.
	await expect(preview).toHaveAttribute('data-device', 'phone');
	await expect(iframe).toHaveCSS('width', '390px');

	// Switching screens swaps the frame; a script inside a mock never runs.
	await preview.getByTestId('design-mock-screen-1').click();
	await expect(preview.getByTestId('design-mock-screen-1')).toHaveAttribute('aria-pressed', 'true');
	await expect(frame.getByText('Nothing logged yet')).toBeVisible();
	await expect(frame.locator('body')).not.toHaveAttribute('data-ran', 'yes');
	await preview.getByTestId('design-mock-screen-2').click();
	await expect(frame.getByRole('alert')).toHaveText('Enter the weight as a number, like 12.');

	// Desktop lays out at 1280px and scales down to fit the card.
	await preview.getByTestId('design-mock-desktop').click();
	await expect(preview).toHaveAttribute('data-device', 'desktop');
	await expect(iframe).toHaveCSS('width', '1280px');
	await expect(iframe).toHaveAttribute('style', /scale\(0\.\d+\)/);
	const cardBox = await card.boundingBox();
	await expect.poll(async () => (await preview.getByTestId('design-mock-frame').boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(cardBox?.width ?? 0);
	if (process.env.DESIGN_MOCK_SHOTS) await preview.screenshot({ path: `${process.env.DESIGN_MOCK_SHOTS}/design-mock-desktop-desktop.png` });

	// "View full size" opens a modal dialog where the desktop layout reads at 1:1.
	await preview.getByTestId('design-mock-full').click();
	const dialog = page.getByTestId('design-mock-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('design-mock-full-desktop')).toHaveAttribute('aria-pressed', 'true');
	const fullIframe = dialog.locator('iframe');
	await expect(fullIframe).toHaveCSS('width', '1280px');
	await expect(fullIframe).not.toHaveAttribute('style', /scale\(/);
	await expect(dialog.frameLocator('iframe').getByRole('alert')).toHaveText('Enter the weight as a number, like 12.');
	if (process.env.DESIGN_MOCK_SHOTS) await page.screenshot({ path: `${process.env.DESIGN_MOCK_SHOTS}/design-mock-full-size.png` });
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();

	// On a phone-sized screen the phone mock still fits without overflow.
	await page.setViewportSize({ width: 390, height: 844 });
	await preview.getByTestId('design-mock-phone').click();
	await preview.getByTestId('design-mock-screen-0').click();
	await expect.poll(async () => {
		const narrow = await preview.getByTestId('design-mock-frame').boundingBox();
		return narrow && narrow.x >= 0 ? narrow.x + narrow.width : Infinity;
	}).toBeLessThanOrEqual(390);
	await expect(frame.getByText('Morning feed · 12 kg')).toBeVisible();
	if (process.env.DESIGN_MOCK_SHOTS) await card.screenshot({ path: `${process.env.DESIGN_MOCK_SHOTS}/design-mock-mobile.png` });

	await card.getByTestId('workflow-approve-design').click();
	await expect(card).toHaveAttribute('data-phase', 'building');
	expect(state.decisions).toEqual([{ designId: 'design-1', decision: 'approved' }]);
});

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
