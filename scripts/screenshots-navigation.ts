import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Approved-navigation screenshots (fixture-backed, deterministic): the
 * composed build (127.0.0.1:4173) with stubbed /api — the same stubs as
 * tests/browser/brief.spec.ts. These show the DESIGNED states (new-user
 * welcome, aggregated brief with badge + notice), not live data. Captured at
 * mobile 390x844, tablet 768x1024 and desktop 1440x900.
 */
const BASE = 'http://127.0.0.1:4173';
const OUT = '/Users/captjay98/projects/caddie-forge/docs/reviews/screenshots-2026-10-09';
mkdirSync(OUT, { recursive: true });

const NOW = '2026-10-05T08:00:00.000Z';
function project(id: string, name: string, kind = 'standard') {
	return { id, workspaceId: 'ws-1', name, description: null, contestId: null, contestUrl: null, status: 'active', kind, createdAt: NOW, updatedAt: NOW };
}
function json(route: unknown, status: number, body: unknown) {
	return (route as { fulfill(o: Record<string, unknown>): unknown }).fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
function card(id: string, projectId: string, kind: string, headline: string, status: string, label: string, targetId: string, key: string, seen = false) {
	return { id, projectId, kind, headline, summary: 'Summary text for the screenshot card.', evidenceIds: [], status, updatedAt: NOW, primaryAction: { label, kind: kind === 'deadline' ? 'review' : kind === 'result' ? 'inspect' : 'review', targetId }, key, seen };
}
const CARDS = [
	card('brf_approval_ap-1', 'proj-a', 'approval', 'Design review is waiting on you', 'needs-you', 'Review the design', 'ap-1', 'proj-a:approval:ap-1'),
	card('brf_failed_run_run-9', 'proj-a', 'result', 'Run stopped: build failed at step 7', 'blocked', 'Read the failure', 'run-9', 'proj-a:result:run-9'),
	card('brf_schedule_sch-1', 'proj-b', 'deadline', 'Weekly discovery sweep — 0 7 * * 1', 'handled', 'Open the schedule', 'sch-1', 'proj-b:deadline:sch-1'),
	card('brf_preview_pvw-1', 'proj-b', 'result', 'A working preview is ready to view', 'handled', 'View preview', 'pvw-1', 'proj-b:result:pvw-1', true),
];
const PROJECTS = [project('home-1', 'Home', 'home'), project('proj-a', 'Pit wall'), project('proj-b', 'Solar board')];

async function stub(context: any, cards: unknown[] = CARDS, projects: unknown[] = PROJECTS, newUser = false) {
	await context.route('**/api/auth/status', (r: any) => json(r, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (r: any) => json(r, 200, { session: { userId: 'shot-user' }, user: { id: 'shot-user', name: 'Alex', email: 'a@caddie.test' } }));
	await context.route('**/api/home-project', (r: any) => json(r, 200, { project: project('home-1', 'Home', 'home') }));
	await context.route('**/api/profile', (r: any) => json(r, 200, { profile: null }));
	await context.route('**/api/projects', (r: any) => {
		if (r.request().method() !== 'GET') return json(r, 405, {});
		return json(r, 200, { projects: newUser ? [project('home-1', 'Home', 'home')] : PROJECTS });
	});
	await context.route('**/api/brief/read', (r: any) => json(r, 200, { marked: 0 }));
	await context.route('**/api/brief', (r: any) =>
		json(r, 200, { cards: newUser ? [] : CARDS, unseenCount: newUser ? 0 : 3, projects: PROJECTS.map((p: any) => ({ id: p.id, name: p.name, kind: p.kind })), asOf: NOW }),
	);
	await context.route('**/api/projects/**', (r: any) => {
		const path = new URL(r.request().url()).pathname;
		if (path.endsWith('/discovery/candidates')) return json(r, 200, { evaluations: [], ranked: [], profileCountry: null });
		if (path.endsWith('/discovery/feed')) return json(r, 200, { runs: [] });
		if (path.endsWith('/plan-docs')) return json(r, 200, { revisions: [], latest: null });
		return json(r, 200, {});
	});
}

async function main() {
	const browser = await chromium.launch();
	// New-user mobile: Chat welcome (390) + Brief tab (390)
	for (const [name, width, height, path, opts] of [
		['mobile-chat-welcome', 390, 844, '/app/', { newUser: true }],
		['mobile-brief', 390, 844, '/app/?pane=brief', { newUser: false }],
	] as const) {
		const context = await browser.newContext({ viewport: { width, height } });
		await stub(context, CARDS, PROJECTS, (opts as any).newUser === true);
		const page = await context.newPage();
		await page.goto(`${BASE}${path}`);
		await page.waitForTimeout(2200);
		await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
		await context.close();
	}
	// Tablet + desktop: Brief left + Chat right (with badge + notice)
	for (const [name, width, height] of [
		['tablet-brief-chat', 768, 1024],
		['desktop-brief-chat', 1440, 900],
	] as const) {
		const context = await browser.newContext({ viewport: { width, height } });
		await stub(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await page.waitForTimeout(2200);
		await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
		await context.close();
	}
	// Desktop destinations: Discover + Projects
	for (const [name, path] of [['desktop-discover', '/app/discover'], ['desktop-projects', '/app/projects']] as const) {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stub(context);
		const page = await context.newPage();
		await page.goto(`${BASE}${path}`);
		await page.waitForTimeout(2200);
		await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
		await context.close();
	}
	await browser.close();
	console.log('screenshots written to', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });