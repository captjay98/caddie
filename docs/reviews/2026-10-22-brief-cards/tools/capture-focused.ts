/**
 * Capture Codex's focused project workspace from the LIVE preview it left
 * running on 127.0.0.1:5176 (the uncommitted build in the main checkout).
 * Stubs auth + projects + per-project /workflow /experience /activity the way
 * tests do, so the signed-in Projects list and a focused project page render.
 * 2x, desktop 1440x900 and phone 390x844.
 *
 *   bun docs/reviews/2026-10-22-brief-cards/tools/capture-focused.ts
 */
import { chromium, type BrowserContext, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'shots');
mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:5176';

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const project = (id: string, name: string, kind = 'standard') => ({ id, workspaceId: 'ws-1', name, description: null, contestId: null, contestUrl: null, status: 'active', kind, createdAt: ago(9000), updatedAt: ago(30) });
const HOME = project('home-1', 'Home', 'home');
const FARM = project('proj-farm', 'FarmLog AI');
const HERD = project('proj-herd', 'HerdVoice');
const json = (r: Route, status: number, body: unknown) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// A BUILDING project: plan approved, Build is the active step, one feature done.
const WORKFLOW = {
	workflow: { projectId: 'proj-farm', runId: 'run-1', conversationId: 'conv-1', phase: 'building', detail: 'Caddie is implementing your approved plan and running the checks.', previewId: null, updatedAt: ago(1) },
	plan: { id: 'plan-1', approved: true },
	approval: { id: 'ap-1', status: 'approved' },
	importPreview: null,
};
const EXPERIENCE = { version: 1, stage: 'building', plan: { approved: true }, steps: [], actions: [] };
const ACTIVITY = { openIssues: 0, timeline: { stages: [
	{ id: 'plan', label: 'Plan', state: 'done' },
	{ id: 'build', label: 'Build', state: 'active' },
	{ id: 'check', label: 'Check', state: 'pending' },
	{ id: 'submit', label: 'Submit', state: 'pending' },
] }, features: [
	{ id: 'f1', name: 'Record a daily entry', state: 'done' },
	{ id: 'f2', name: 'Offline recording', state: 'building' },
	{ id: 'f3', name: 'Weekly summary', state: 'pending' },
] };

async function stub(context: BrowserContext) {
	await context.route('**/api/auth/status', (r) => json(r, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (r) => json(r, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Jamal', email: 'owner@caddie.test' } }));
	await context.route('**/api/onboarding', (r) => json(r, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/home-project', (r) => json(r, 200, { project: HOME }));
	await context.route('**/api/profile', (r) => json(r, 200, { profile: null }));
	await context.route('**/api/projects', (r) => json(r, 200, { projects: [HOME, FARM, HERD] }));
	await context.route('**/api/brief/read', (r) => json(r, 200, { marked: 0 }));
	await context.route('**/api/brief**', (r) => json(r, 200, { cards: [], unseenCount: 0, projects: [HOME, FARM, HERD].map((p) => ({ id: p.id, name: p.name, kind: p.kind })), asOf: new Date().toISOString() }));
	await context.route('**/api/notifications**', (r) => json(r, 200, { notifications: [] }));
	await context.route('**/api/memory/offers**', (r) => json(r, 200, { offers: [] }));
	await context.route('**/api/projects/**', (r) => {
		const path = new URL(r.request().url()).pathname;
		if (path.endsWith('/workflow')) return json(r, 200, WORKFLOW);
		if (path.endsWith('/experience')) return json(r, 200, EXPERIENCE);
		if (path.endsWith('/activity')) return json(r, 200, ACTIVITY);
		if (path.endsWith('/run-bindings')) return json(r, 200, { runBindings: [] });
		if (path.endsWith('/plan-docs')) return json(r, 200, { revisions: [], latest: null });
		if (path.endsWith('/schedules')) return json(r, 200, { schedules: [] });
		if (path.endsWith('/previews')) return json(r, 200, { previews: [] });
		return json(r, 200, {});
	});
}

const browser = await chromium.launch({ headless: true });
try {
	for (const [name, opts, url, wait] of [
		['focused-projects-desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }, '/app/projects', '[data-testid="project-list"], .project-list, main'],
		['focused-project-desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }, '/app/project?project=proj-farm', '[data-testid="focused-project-home"], .focused-project-content, main'],
		['focused-project-phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }, '/app/project?project=proj-farm', '[data-testid="focused-project-home"], .focused-project-content, main'],
	] as const) {
		const context = await browser.newContext({ ...opts, serviceWorkers: 'block', colorScheme: 'dark' });
		await stub(context);
		const page = await context.newPage();
		await page.goto(`${BASE}${url}`);
		try {
			await page.locator(wait).first().waitFor({ state: 'visible', timeout: 15_000 });
		} catch {
			console.log(`  (${name}: wait selector not found, shooting anyway)`);
		}
		await page.waitForTimeout(1200);
		await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
		console.log(`captured ${name}`);
		await context.close();
	}
} finally {
	await browser.close();
}
