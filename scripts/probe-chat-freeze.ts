/**
 * Local render-cost probe for the project conversation (owner freeze reports).
 *
 * Drives the REAL composed SPA (preview server, default http://127.0.0.1:4179)
 * with a SIMULATED heavy transcript — heavier than the heaviest real local
 * conversation measured so far (Farmhand: 47 messages, 34 tool calls, ~18k
 * chars of assistant text) — and records long tasks / long animation frames
 * with script attribution, plus input-to-frame and route-to-frame latencies.
 * Transport is mocked at the network layer; the React bundle is the real one.
 *
 * Usage: bun scripts/probe-chat-freeze.ts [baseUrl]
 * Prereq: a preview server on the base URL, e.g.
 *   bun --cwd=apps/app run preview -- --port 4179 --host 127.0.0.1
 */
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4179';
const OFFSET = '0000000000000000_0000000000000001';
const PROJECT = { id: 'proj-perf', workspaceId: 'ws-perf', name: 'Garden journal', description: 'Record a garden observation.', contestId: null, contestUrl: null, status: 'active', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };

// 480 messages, 12 tool parts each: ~2.5x the real conversation's tool-row
// load, and one very large markdown message near the end.
const messages = Array.from({ length: 480 }, (_, i) => ({
	id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', purpose: i % 2 ? 'assistant' : 'user', display: 'visible', timestamp: '2026-10-24T00:00:00Z',
	parts: [
		{ type: 'text', state: 'done', text: i % 2
			? (i === 479 ? `# Final summary\n\n${Array.from({ length: 900 }, (_, k) => `## Note ${k}\n\nA **long** garden record with [a link](#n${k}) and more detail to parse.\n\n`).join('')}` : `Update ${i}. Your observation is saved.\n\n${'A useful garden note. '.repeat(25)}`)
			: `Record observation ${i}` },
		...(i % 2 ? Array.from({ length: 12 }, (_, j) => ({ type: 'dynamic-tool', toolCallId: `t-${i}-${j}`, toolName: 'write_plan_note', state: 'output-available', input: {}, output: { saved: true } })) : []),
	],
}));

const probe = () => {
	(window as unknown as { __probe: unknown[] }).__probe = [];
	const Obs = (window as unknown as { PerformanceObserver: new (cb: PerformanceObserverCallback, opts?: PerformanceObserverInit) => PerformanceObserver }).PerformanceObserver;
	try {
		new Obs(list => {
			for (const e of list.getEntries() as (PerformanceEntry & { attribution?: { containerSrc?: string; containerName?: string }[] })[]) {
				(window as unknown as { __probe: unknown[] }).__probe.push({ kind: 'longtask', ms: Math.round(e.duration), at: Math.round(performance.now()), src: e.attribution?.[0]?.containerSrc ?? e.attribution?.[0]?.containerName ?? '' });
			}
		}, { type: 'longtask', buffered: true }).observe({});
	} catch { /* longtask unsupported */ }
	try {
		new Obs(list => {
			for (const e of list.getEntries() as (PerformanceEntry & { scripts?: { sourceURL?: string; duration?: number }[] })[]) {
				const worst = [...(e.scripts ?? [])].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, 3).map(s => ({ path: (() => { try { return new URL(s.sourceURL ?? '', location.origin).pathname; } catch { return 'unknown'; } })(), ms: Math.round(s.duration ?? 0) }));
				(window as unknown as { __probe: unknown[] }).__probe.push({ kind: 'loaf', ms: Math.round(e.duration), at: Math.round(performance.now()), scripts: worst });
			}
		}, { type: 'long-animation-frame', buffered: true }).observe({});
	} catch { /* loAF unsupported */ }
};

async function main() {
	const browser = await chromium.launch();
	try {
		for (const width of [390, 1440] as const) {
			const context = await browser.newContext({ viewport: { width, height: 915 } });
			await context.route('**/api/**', route => {
				const path = new URL(route.request().url()).pathname;
				const send = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
				if (path === '/api/auth/status') return send({ authenticated: true });
				if (path === '/api/auth/get-session') return send({ session: { userId: 'actor-perf' }, user: { id: 'actor-perf', name: 'Jay', email: 'jay@example.test' } });
				if (path === '/api/onboarding') return send({ completedAt: PROJECT.createdAt });
				if (path === '/api/projects') return send({ projects: [PROJECT] });
				if (path === '/api/home-project') return send({ project: { ...PROJECT, id: 'home-perf' } });
				if (path.endsWith('/run-bindings')) return send({ runBindings: [{ runId: 'run-perf', projectId: PROJECT.id, conversationId: 'conv-perf', submissionId: 's', planRevision: 'r', stackId: 'react-hono', payerId: 'actor-perf', modelRouteId: 'nemotron-3.5-super-vl', pricingVersion: 'v1', createdBy: 'actor-perf', createdAt: PROJECT.createdAt }] });
				if (path === '/api/brief') return send({ cards: [], projects: [PROJECT], unseenCount: 0, asOf: PROJECT.createdAt });
				if (path.endsWith('/plan-docs')) return send({ revisions: [], latest: null });
				if (path.endsWith('/workflow')) return send({ workflow: null });
				return send({});
			});
			await context.route('**/agents/coordinator/**', route => {
				if (new URL(route.request().url()).searchParams.get('view') === 'updates') return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
				return route.fulfill({ contentType: 'application/json', headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' }, body: JSON.stringify({ v: 1, conversationId: 'conv-perf', offset: OFFSET, messages, settlements: [] }) });
			});
			const page = await context.newPage();
			await page.addInitScript(probe);

			const t0 = Date.now();
			await page.goto(`${BASE}/app/project?project=proj-perf&pane=channel`);
			await page.getByTestId('msg-user').first().waitFor();
			const initialMs = Date.now() - t0;

			const earlier = Date.now();
			await page.getByTestId('channel-show-earlier').click();
			await page.getByTestId('msg-user').first().waitFor();
			const earlierMs = Date.now() - earlier;

			const tType = Date.now();
			await page.getByTestId('composer-input').fill('A draft to keep while navigating');
			const typingMs = Date.now() - tType;

			// Client-side route changes while the app stays loaded (the old
			// freeze scenario: persistent panel re-render on SPA nav).
			const routes: { to: string; url: string; wait: string }[] = [
				{ to: '/app/?project=proj-perf', url: '**/app/**', wait: '[data-testid="brief-screen"]' },
				{ to: '/app/discover?project=proj-perf', url: '**/app/discover**', wait: '[aria-label="Discovery results"]' },
				{ to: '/app/projects?project=proj-perf', url: '**/app/projects**', wait: '.disc-actions' },
			];
			const routeMs: Record<string, number> = {};
			for (const r of routes) {
				const t = Date.now();
				await page.evaluate(to => { history.pushState({}, '', to); dispatchEvent(new PopStateEvent('popstate')); }, r.to);
				await page.waitForURL(r.url);
				await page.locator(r.wait).first().waitFor({ state: 'attached' });
				routeMs[r.url] = Date.now() - t;
			}
			await page.waitForTimeout(800);
			// SPA-nav events first — a full navigation below re-inits the probe.
			const spaEvents = await page.evaluate(() => (window as unknown as { __probe: unknown[] }).__probe);
			const back = Date.now();
			await page.goto(`${BASE}/app/project?project=proj-perf&pane=channel`);
			await page.getByTestId('msg-user').first().waitFor();
			routeMs['project-reload'] = Date.now() - back;
			await page.waitForTimeout(800);
			const events = [...spaEvents, ...await page.evaluate(() => (window as unknown as { __probe: unknown[] }).__probe)];
			const longtasks = (events as { kind: string; ms: number }[]).filter(e => e.kind === 'longtask');
			const loafs = (events as { kind: string; ms: number; scripts?: { path: string; ms: number }[] }[]).filter(e => e.kind === 'loaf');
			console.log(`\n=== ${width}px (480 msgs, 12 tool rows each, one 900-section markdown) ===`);
			console.log(JSON.stringify({ initialMs, earlierMs, typingMs, routeMs, longTasks: longtasks.length, worstLongTaskMs: Math.max(0, ...longtasks.map(e => e.ms)), loafs: loafs.length, worstLoafMs: Math.max(0, ...loafs.map(e => e.ms)) }));
			for (const loaf of loafs.sort((a, b) => b.ms - a.ms).slice(0, 4)) console.log('loaf', loaf.ms + 'ms', JSON.stringify(loaf.scripts));
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

void main();
