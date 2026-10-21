import { expect, test, type BrowserContext, type Route } from '@playwright/test';

/**
 * Caddie proposes, the user creates — the proposal card in the REAL composed
 * chat (run `bun run build` first). The model transcript and the /api are
 * SIMULATED at their network boundaries: this proves the card's UI contract
 * (nothing is created until "Start this project"; "Keep refining" creates
 * nothing), not live model behaviour. Server semantics are covered by
 * tests/project-proposals.test.ts against real migrations.
 */
const BASE = 'http://127.0.0.1:4173';
const NOW = '2026-10-15T01:00:00.000Z';
const OFFSET = '0000000000000000_0000000000000001';
const HOME = { id: 'home-prop', workspaceId: 'ws-prop', name: 'Home', description: null, status: 'active', kind: 'home', createdAt: NOW, updatedAt: NOW };
const CREATED = { ...HOME, id: 'proj-herdwatch', name: 'HerdWatch', description: 'A voice-first early-warning helper', kind: 'standard' };
function json(route: Route, status: number, value: unknown) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) }); }

async function fixture(context: BrowserContext, options: { decisionCard?: boolean; resolvedDecision?: boolean; cards?: Record<string, unknown>[]; spendCard?: boolean } = {}) {
 const transcriptCards = options.cards?.map(card => structuredClone(card));
 const agentReads: string[] = [];
 const workflowReads: string[] = [];
	const proposal = {
		id: 'prop-1', name: 'HerdWatch', idea: 'A voice-first early-warning helper for smallholder livestock farmers in Nigeria.',
		hackathonTitle: 'Nebius x NVIDIA Global AI Hackathon', hackathonUrl: 'https://nebiusglobalaihackathon.devpost.com',
		track: 'Personal AI', firstStep: 'A voice note in, a spoken next step out — for one common illness.',
		audience: 'farmers like my uncle who keep goats and cannot read English well',
		problem: 'by the time the vet comes the animal is already dead',
		status: 'proposed' as 'proposed' | 'accepted' | 'dismissed', projectId: null as string | null,
	};
	const posts: string[] = [];
	let projects: Record<string, unknown>[] = options.decisionCard || options.cards ? [HOME, CREATED] : [HOME];
	await context.route('**/api/**', async (route) => {
		const request = route.request(), path = new URL(request.url()).pathname;
		if (path === '/api/auth/status') return json(route, 200, { authenticated: true });
		if (path === '/api/onboarding') return json(route, 200, { completedAt: NOW });
		if (path === '/api/auth/get-session') return json(route, 200, { session: { userId: 'actor-prop' }, user: { id: 'actor-prop', name: 'Ada', email: 'ada@example.test' } });
		if (path === '/api/home-project') return json(route, 200, { project: HOME });
		if (path === '/api/profile') return json(route, 200, { profile: null });
		if (path === '/api/projects') return json(route, 200, { projects });
		if (path === '/api/brief') return json(route, 200, { cards: options.cards ?? (options.resolvedDecision ? [{ id: 'brf_approval_chat', projectId: CREATED.id, kind: 'approval', status: 'handled', headline: 'Plan approval kept on record', summary: 'Decision approved.', evidenceIds: [], updatedAt: NOW, primaryAction: { kind: 'review', label: 'View decision', targetId: 'approval-chat' } }] : []), unseenCount: 0, projects, asOf: NOW });
		if (path.endsWith('/brief/read')) return json(route, 200, { marked: 0 });
		if (path === `/api/projects/${HOME.id}/proposals/prop-1`) return json(route, 200, { proposal });
		if (path === `/api/projects/${HOME.id}/proposals/prop-1/dismiss`) {
			posts.push('dismiss'); proposal.status = 'dismissed'; return json(route, 200, { proposal });
		}
		if (path === `/api/projects/${HOME.id}/proposals/prop-1/accept`) {
			posts.push('accept'); proposal.status = 'accepted'; proposal.projectId = CREATED.id; projects = [HOME, CREATED];
			return json(route, 200, { proposal, project: { id: CREATED.id, name: CREATED.name } });
		}
		if (path.endsWith('/run-bindings')) {
			const projectId = path.split('/')[3]!;
			return json(route, 200, { runBindings: [{ runId: `run-${projectId}`, projectId, conversationId: projectId === HOME.id ? 'conv-home-prop' : 'conv-herdwatch', submissionId: 's', planRevision: 'rev-1', stackId: 'react-hono', payerId: 'actor-prop', modelRouteId: 'route', pricingVersion: 'v1', createdBy: 'actor-prop', createdAt: NOW }] });
		}
		if (path.endsWith('/workflow')) {
            workflowReads.push(path);
			return json(route, 200, path.includes(CREATED.id)
				? { workflow: { projectId: CREATED.id, runId: 'run-h', conversationId: 'conv-herdwatch', sourceConversationId: 'conv-home-prop', brief: 'HerdWatch', phase: 'planning', planId: null, previewId: null, pendingKey: null, pendingBody: null, detail: null, updatedAt: NOW }, plan: null, approval: null }
				: { workflow: null, plan: null, approval: null });
		}
		return json(route, 200, {});
	});
	await context.route('**/agents/coordinator/**', async (route) => {
		const request = route.request(), url = new URL(request.url());
		const conversationId = url.pathname.split('/').pop()!;
        agentReads.push(conversationId);
		if (request.method() === 'POST') return json(route, 202, { streamUrl: `${BASE}${url.pathname}`, offset: OFFSET, submissionId: 'sub', uid: 'uid' });
		if (url.searchParams.get('view') === 'updates') {
			return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
		}
		const messages = conversationId === 'conv-home-prop' ? [{ id: 'm-prop', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: NOW, parts: [
			{ type: 'text', text: 'Here’s the idea written up — start it when you’re happy, or tell me what to change.', state: 'done' },
			{ type: 'data-projectProposal', data: { proposalId: 'prop-1', homeProjectId: HOME.id } },
            ...(transcriptCards ? transcriptCards.map(data => ({ type: 'data-decision-card', data })) : []),
            ...(options.spendCard ? [{ type: 'data-approvalCard', data: { approvalId:'spend-1',projectId:CREATED.id,what:'Use the agreed allowance',capMinorUnits:100,currency:'USD',status:'pending' } }] : []),
            ...(options.decisionCard ? [{ type: 'data-decision-card', data: { id: 'brf_approval_chat', projectId: CREATED.id, kind: 'approval', status: 'needs-you', headline: 'Review this exact project plan', summary: 'A plan awaits your review.', evidenceIds: [], updatedAt: NOW, primaryAction: { kind: 'review', label: 'Review plan from chat', targetId: 'approval-chat' } } }] : []),
		] }] : [];
		return route.fulfill({ contentType: 'application/json', headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' }, body: JSON.stringify({ v: 1, conversationId, offset: OFFSET, messages, settlements: [] }) });
	});
	return { proposal, posts, agentReads, workflowReads };
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); });

test('a proposal card shows the idea and creates nothing until "Start this project"', async ({ page, context }) => {
	const state = await fixture(context);
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-proposal');
	await expect(card).toBeVisible();
	await expect(card).toContainText('HerdWatch');
	await expect(card).toContainText('voice-first early-warning helper');
	await expect(card).toContainText('Personal AI');
	// Who it's for and the problem, in the person's own words (plan 4.3).
	await expect(card.getByTestId('proposal-audience')).toHaveText("Who it's for“farmers like my uncle who keep goats and cannot read English well”");
	await expect(card.getByTestId('proposal-problem')).toHaveText('The problem“by the time the vet comes the animal is already dead”');
	await expect(card.getByRole('link', { name: 'Nebius x NVIDIA Global AI Hackathon' })).toHaveAttribute('href', 'https://nebiusglobalaihackathon.devpost.com');
	await expect(card).toContainText('Nothing is created until you start it.');
	// Showing the card created nothing.
	expect(state.posts).toEqual([]);

	await card.getByTestId('proposal-start').click();
	// Accepted history remains passive: no background workflow/conversation.
	await expect(page.getByTestId('accepted-project-proposal')).toBeVisible();
    expect(state.agentReads.every(id => id === 'conv-home-prop')).toBe(true);
    expect(state.workflowReads.some(path => path.includes(CREATED.id))).toBe(false);
    await page.getByTestId('accepted-project-proposal').getByRole('button', { name: 'Open project' }).click();
    await expect(page).toHaveURL(/project=proj-herdwatch/);
    await expect.poll(() => state.agentReads.includes('conv-herdwatch')).toBe(true);
	expect(state.posts).toEqual(['accept']);
});

test('"Keep refining" creates nothing and keeps a way to start it later', async ({ page, context }) => {
	const state = await fixture(context);
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-proposal');
	await card.getByTestId('proposal-refine').click();
	await expect(card).toHaveAttribute('data-status', 'dismissed');
	await expect(card.getByTestId('proposal-dismissed')).toContainText('tell Caddie what to change');
	expect(state.posts).toEqual(['dismiss']);
	await expect(page.getByTestId('channel').getByTestId('project-workflow')).toHaveCount(0);
	await expect(card.getByTestId('proposal-start')).toHaveText('Start it anyway');
});

 test('generic chat decision cards open the same scoped Plan route as Brief', async ({ page, context }) => {
  await fixture(context, { decisionCard: true });
  await page.goto(`${BASE}/app/`);
  await page.getByTestId('channel').getByRole('button', { name: 'Review plan from chat' }).click();
  await expect(page).toHaveURL(/design-review\?project=proj-herdwatch/);
 });

 test('a saved chat card follows the same resolved state as Brief instead of its old transcript snapshot', async ({ page, context }) => {
  await fixture(context, { decisionCard: true, resolvedDecision: true });
  await page.goto(`${BASE}/app/`);
  const card = page.getByTestId('channel').getByTestId('decision-card');
  await expect(card).toContainText('Decision approved.');
  await expect(card.getByRole('button', { name: 'Review plan from chat' })).toHaveCount(0);
  await card.getByRole('button', { name: 'View decision' }).click();
  await expect(page).toHaveURL(/approval=approval-chat/);
 });

test('the seven compact card variants share their design in chat and Brief',async({page,context})=>{
 const base={projectId:CREATED.id,kind:'result',status:'changed',headline:'Original card content',summary:'Original server detail.',evidenceIds:[],updatedAt:NOW,primaryAction:{kind:'inspect',label:'View activity',targetId:'r'}};
 const cards=[
  {...base,id:'brf_approval_a',kind:'approval',status:'needs-you',primaryAction:{kind:'review',label:'Review plan',targetId:'a'}},
  {...base,id:'brf_workflow_build_r'},
  {...base,id:'brf_workflow_repair_r',primaryAction:{kind:'inspect',label:'View repair',targetId:'repair-run'}},
  {...base,id:'brf_workflow_preview_p',status:'handled',primaryAction:{kind:'preview',label:'Try the app',targetId:'p'}},
  {...base,id:'brf_schedule_s',kind:'deadline',status:'handled',primaryAction:{kind:'review',label:'Open schedule',targetId:'s'}},
  {...base,id:'brf_opportunity_o',status:'handled',primaryAction:{kind:'inspect',label:'Review opportunity',targetId:'o'}},
  {...base,id:'brf_approval_old',kind:'approval',status:'handled',primaryAction:{kind:'review',label:'View decision',targetId:'old'}},
 ];
 await fixture(context,{cards});await page.goto(`${BASE}/app/`);
 await page.getByTestId('brief-done').locator('summary').first().click();
 for(const variant of ['plan','build','repair','preview','deadline','opportunity','earlier']){
  const chat=page.getByTestId('channel').locator(`[data-testid="decision-card"][data-design="${variant}"]`);
  const brief=page.getByTestId('account-brief-lane').locator(`[data-testid="decision-card"][data-design="${variant}"]`);
  await expect(chat).toBeVisible();await expect(brief).toBeVisible();
  expect(await chat.evaluate(el=>getComputedStyle(el).borderRadius)).toBe('13px');
  expect(await brief.evaluate(el=>getComputedStyle(el).borderRadius)).toBe('13px');
 }
 await page.setViewportSize({width:320,height:568});
 await page.goto(`${BASE}/app/?pane=channel`);
 await expect(page.getByTestId('channel').locator('[data-design="repair"]')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a saved generic build card follows its run through completion even though the preview target changes',async({page,context})=>{
 const cards:Record<string,unknown>[]=[{id:'brf_workflow_build_run-old',projectId:CREATED.id,runId:'run-old',kind:'result',status:'changed',headline:'Building the original app',summary:'Checks are running.',evidenceIds:[],updatedAt:NOW,primaryAction:{kind:'inspect',label:'View activity',targetId:'run-old'}}];
 await fixture(context,{cards});await page.setViewportSize({width:390,height:844});await page.goto(`${BASE}/app/?pane=channel`);
 await expect(page.getByTestId('channel').locator('[data-testid="decision-card"][data-design="build"]')).toBeVisible();
 cards[0]={...cards[0],id:'brf_workflow_preview_exact-output',status:'handled',headline:'The app is ready',primaryAction:{kind:'preview',label:'Try the app',targetId:'exact-output'}};
 await page.getByTestId('tab-brief-mobile').click();await page.getByTestId('mobile-action-refresh').click();
 await page.getByTestId('tab-chat-mobile').click();
 const card=page.getByTestId('channel').getByTestId('decision-card');
 await expect(card).toHaveAttribute('data-design','preview');
 await expect(card).toContainText('The app is ready');
 await expect(card).not.toContainText('In progress');
});

test('a recorded spending decision refreshes to revoked in the same mounted chat',async({page,context})=>{
 await fixture(context,{decisionCard:true,spendCard:true});
 let status='pending';
 await context.route('**/api/approvals/spend-1',route=>json(route,200,{approval:{projectId:CREATED.id,status,action:'design',resourceId:'r',revisionHash:'h',policyVersion:'p'}}));
 await context.route('**/api/approvals',route=>{status='approved';return json(route,200,{approval:{status}});});
 await page.setViewportSize({width:390,height:844});await page.goto(`${BASE}/app/?pane=channel`);
 const card=page.getByTestId('approval-card');
 await card.getByTestId('approval-allow').click();await expect(card).toHaveAttribute('data-status','approved');
 status='revoked';
 await page.getByTestId('tab-brief-mobile').click();await page.getByTestId('mobile-action-refresh').click();await page.getByTestId('tab-chat-mobile').click();
 await expect(card).toHaveAttribute('data-status','revoked');await expect(card).toContainText('Revoked');
});
