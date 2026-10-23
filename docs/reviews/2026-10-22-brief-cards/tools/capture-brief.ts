/**
 * Brief cards review (2026-10-22): screenshots today's Brief from the real
 * built app (this worktree's apps/app/dist) with every /api call answered by
 * test data, the way tests/browser/brief.spec.ts stubs it, using the server's
 * own card words (apps/app/src/server/brief.ts). Also screenshots the card
 * mockups the owner accepted on 2026-10-20 (built from the old Caddie's
 * TheCard grammar). 2x, desktop 1440x900 and phone 390x844.
 *
 * Run from the worktree root after `bun run build`:
 *   bun docs/reviews/2026-10-22-brief-cards/tools/capture-brief.ts
 */
import { chromium, type BrowserContext, type Route } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, '..');
const APP_DIR = join(REVIEW, '..', '..', '..', 'apps', 'app');
const PORT = 4179;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(REVIEW, 'shots');
mkdirSync(OUT, { recursive: true });
const MOCKUPS = '/Users/captjay98/.codex/visualizations/2026/10/20/01a156e1-6c71-7120-8b86-2f4f02367ff6/caddie-card-review.html';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const project = (id: string, name: string, kind = 'standard') => ({ id, workspaceId: 'ws-1', name, description: null, contestId: null, contestUrl: null, status: 'active', kind, createdAt: ago(9000), updatedAt: ago(60) });
const HOME = project('home-1', 'Home', 'home');
const FARM = project('proj-farm', 'FarmLog AI');
const HERD = project('proj-herd', 'HerdVoice');

const card = (c: Record<string, unknown>) => ({ evidenceIds: [], seen: false, ...c });
/** One card of each design, worded exactly as server/brief.ts words them. */
const CARDS = [
	card({ id: 'brf_approval_ap-1', projectId: 'proj-farm', kind: 'approval', status: 'needs-you', updatedAt: ago(4), key: 'proj-farm:approval:ap-1',
		headline: 'Design review is waiting on you',
		summary: 'Approving this authorises specialists building against this plan revision. It does not authorise a deploy, a merge, or any database change — those stay separate gates.',
		primaryAction: { label: 'Review the design', kind: 'review', targetId: 'ap-1' } }),
	card({ id: 'brf_workflow_build_run-1', projectId: 'proj-farm', runId: 'run-1', kind: 'result', status: 'changed', updatedAt: ago(1), key: 'proj-farm:result:run-1',
		headline: 'Your app is taking shape', summary: 'Caddie is implementing your approved plan and running the checks.',
		primaryAction: { label: 'View activity', kind: 'inspect', targetId: 'run-1' } }),
	card({ id: 'brf_workflow_repair_run-2', projectId: 'proj-herd', runId: 'run-2', kind: 'result', status: 'changed', updatedAt: ago(2), key: 'proj-herd:result:run-2',
		headline: 'One check needs another pass', summary: 'feature-2:behavior-tests',
		primaryAction: { label: 'View activity', kind: 'inspect', targetId: 'run-2' } }),
	card({ id: 'brf_workflow_preview_out-7', projectId: 'proj-herd', runId: 'run-3', kind: 'result', status: 'handled', updatedAt: ago(12), key: 'proj-herd:result:out-7',
		headline: 'Your app is ready to try', summary: 'Open the checked app preview. Your plan and build remain available.',
		primaryAction: { label: 'Try the app', kind: 'preview', targetId: 'out-7' } }),
	card({ id: 'brf_schedule_sch-1', projectId: 'proj-farm', kind: 'deadline', status: 'handled', updatedAt: ago(30), key: 'proj-farm:deadline:sch-1',
		headline: 'Weekly discovery sweep is scheduled',
		summary: "Next run 2026-10-26T07:00:00.000Z (Africa/Lagos). A finished run reports here and in the project's activity; a refused or failed read is named, never guessed.",
		primaryAction: { label: 'Open the schedule', kind: 'review', targetId: 'sch-1' } }),
	card({ id: 'brf_opportunity_cand-1', projectId: 'proj-farm', kind: 'result', status: 'handled', updatedAt: ago(90), key: 'proj-farm:result:cand-1',
		headline: 'A suitable opportunity is saved: Nebius x NVIDIA Global AI Hackathon',
		summary: "This was saved from the local seed feed — live contest sources are not connected yet, so this is Caddie's built-in sample, not a live match. Explore ideas for it when you are ready.",
		primaryAction: { label: 'Review opportunity', kind: 'inspect', targetId: 'cand-1' } }),
	card({ id: 'brf_approval_ap-0', projectId: 'proj-farm', kind: 'approval', status: 'handled', updatedAt: ago(2900), key: 'proj-farm:approval:ap-0', seen: true,
		headline: 'the design — approved',
		summary: 'Decision approved. Open the record to read the exact revision it concerned. This does not authorise a new action.',
		primaryAction: { label: 'View decision', kind: 'review', targetId: 'ap-0' } }),
];

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stub(context: BrowserContext) {
	await context.route('**/api/auth/status', (r) => json(r, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (r) => json(r, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Jamal', email: 'owner@caddie.test' } }));
	await context.route('**/api/onboarding', (r) => json(r, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/home-project', (r) => json(r, 200, { project: HOME }));
	await context.route('**/api/profile', (r) => json(r, 200, { profile: null }));
	await context.route('**/api/projects', (r) => json(r, 200, { projects: [HOME, FARM, HERD] }));
	await context.route('**/api/brief/read', (r) => json(r, 200, { marked: 0 }));
	await context.route('**/api/brief/history**', (r) => json(r, 200, { cards: [], next: null }));
	await context.route('**/api/brief', (r) => json(r, 200, { cards: CARDS, unseenCount: CARDS.filter((c) => !c.seen).length, projects: [HOME, FARM, HERD].map((p) => ({ id: p.id, name: p.name, kind: p.kind })), asOf: new Date().toISOString() }));
	await context.route('**/api/notifications**', (r) => json(r, 200, { notifications: [] }));
	await context.route('**/api/memory/offers**', (r) => json(r, 200, { offers: [] }));
	await context.route('**/api/projects/**', (r) => {
		const path = new URL(r.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(r, 200, { runBindings: [] });
		if (path.endsWith('/brief')) return json(r, 200, { cards: [] });
		if (path.endsWith('/plan-docs')) return json(r, 200, { revisions: [], latest: null });
		return json(r, 200, {});
	});
}

async function waitForServer(): Promise<void> {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${BASE}/app/`, { signal: AbortSignal.timeout(1500) })).status === 200) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	throw new Error(`preview did not answer on ${BASE}`);
}

const UNCLIP = `html, body, #root { height: auto !important; overflow: visible !important; }
.shell { height: auto !important; min-height: 100vh; }
.app-split, .shell-left, .shell-main { overflow: visible !important; max-height: none !important; }
.bottom-nav { position: static !important; transform: none !important; margin-top: 12px; }`;

const server = spawn('bunx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
	cwd: APP_DIR,
	env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'brief-preview-')) },
	stdio: ['ignore', openSync(join(tmpdir(), `brief-preview-${process.pid}.log`), 'w'), 'ignore'],
	detached: true,
});
const browser = await chromium.launch({ headless: true });
try {
	// The accepted mockups first (no server needed).
	const mock = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
	const mockPage = await mock.newPage();
	await mockPage.goto(pathToFileURL(MOCKUPS).href);
	await mockPage.waitForTimeout(600);
	await mockPage.screenshot({ path: join(OUT, 'accepted-mockups.png'), fullPage: true });
	await mock.close();
	console.log('captured accepted-mockups');

	await waitForServer();
	for (const [name, options, url] of [
		['today-brief-desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }, '/app/'],
		['today-brief-phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }, '/app/?pane=brief'],
	] as const) {
		const context = await browser.newContext({ ...options, serviceWorkers: 'block', colorScheme: 'dark' });
		await stub(context);
		const page = await context.newPage();
		await page.goto(`${BASE}${url}`);
		await page.getByTestId('decision-card').first().waitFor({ state: 'visible', timeout: 20_000 });
		await page.waitForTimeout(1000);
		await page.addStyleTag({ content: UNCLIP });
		await page.waitForTimeout(200);
		await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
		console.log(`captured ${name}`);
		await context.close();
	}
} finally {
	await browser.close();
	if (server.pid) {
		try {
			process.kill(-server.pid, 'SIGTERM');
		} catch {
			// already gone
		}
	}
}
