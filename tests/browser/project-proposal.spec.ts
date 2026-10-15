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

async function fixture(context: BrowserContext) {
	const proposal = {
		id: 'prop-1', name: 'HerdWatch', idea: 'A voice-first early-warning helper for smallholder livestock farmers in Nigeria.',
		hackathonTitle: 'Nebius x NVIDIA Global AI Hackathon', hackathonUrl: 'https://nebiusglobalaihackathon.devpost.com',
		track: 'Personal AI', firstStep: 'A voice note in, a spoken next step out — for one common illness.',
		status: 'proposed' as 'proposed' | 'accepted' | 'dismissed', projectId: null as string | null,
	};
	const posts: string[] = [];
	let projects: Record<string, unknown>[] = [HOME];
	await context.route('**/api/**', async (route) => {
		const request = route.request(), path = new URL(request.url()).pathname;
		if (path === '/api/auth/status') return json(route, 200, { authenticated: true });
		if (path === '/api/onboarding') return json(route, 200, { completedAt: NOW });
		if (path === '/api/auth/get-session') return json(route, 200, { session: { userId: 'actor-prop' }, user: { id: 'actor-prop', name: 'Ada', email: 'ada@example.test' } });
		if (path === '/api/home-project') return json(route, 200, { project: HOME });
		if (path === '/api/profile') return json(route, 200, { profile: null });
		if (path === '/api/projects') return json(route, 200, { projects });
		if (path === '/api/brief') return json(route, 200, { cards: [], unseenCount: 0, projects, asOf: NOW });
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
			return json(route, 200, path.includes(CREATED.id)
				? { workflow: { projectId: CREATED.id, runId: 'run-h', conversationId: 'conv-herdwatch', sourceConversationId: 'conv-home-prop', brief: 'HerdWatch', phase: 'planning', planId: null, previewId: null, pendingKey: null, pendingBody: null, detail: null, updatedAt: NOW }, plan: null, approval: null }
				: { workflow: null, plan: null, approval: null });
		}
		return json(route, 200, {});
	});
	await context.route('**/agents/coordinator/**', async (route) => {
		const request = route.request(), url = new URL(request.url());
		const conversationId = url.pathname.split('/').pop()!;
		if (request.method() === 'POST') return json(route, 202, { streamUrl: `${BASE}${url.pathname}`, offset: OFFSET, submissionId: 'sub', uid: 'uid' });
		if (url.searchParams.get('view') === 'updates') {
			return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
		}
		const messages = conversationId === 'conv-home-prop' ? [{ id: 'm-prop', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: NOW, parts: [
			{ type: 'text', text: 'Here’s the idea written up — start it when you’re happy, or tell me what to change.', state: 'done' },
			{ type: 'data-projectProposal', data: { proposalId: 'prop-1', homeProjectId: HOME.id } },
		] }] : [];
		return route.fulfill({ contentType: 'application/json', headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' }, body: JSON.stringify({ v: 1, conversationId, offset: OFFSET, messages, settlements: [] }) });
	});
	return { proposal, posts };
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
	await expect(card.getByRole('link', { name: 'Nebius x NVIDIA Global AI Hackathon' })).toHaveAttribute('href', 'https://nebiusglobalaihackathon.devpost.com');
	await expect(card).toContainText('Nothing is created until you start it.');
	// Showing the card created nothing.
	expect(state.posts).toEqual([]);

	await card.getByTestId('proposal-start').click();
	// The card becomes the normal project card for the project the click created.
	await expect(page.getByTestId('channel').getByTestId('project-workflow')).toBeVisible();
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
