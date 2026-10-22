/**
 * Projects redesign review (2026-10-21): screenshots TODAY's Projects list and
 * project page from the real built app (apps/app/dist), desktop 1440x900 and
 * phone 390x844, in the review's five states. Every /api call is answered by
 * fixtures the way tests/browser/project-v2.spec.ts stubs them: no network,
 * no model, no database. The projects are example data; every state title,
 * message and button label is the app's own wording (server/project-experience.ts,
 * server/build-workflow.ts).
 *
 * It also saves each page's rendered HTML (scripts removed) to templates/, so
 * the mockups can reuse the real shell around their own page content.
 *
 * Run from the repo root after `bun run build`:
 *   bun docs/reviews/2026-10-21-projects-redesign/tools/capture-today.ts
 */
import { chromium, type BrowserContext, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, UNCLIP, type Measure } from './measure.ts';

const measures: Record<string, Measure> = {};
const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, '..');
const REPO = join(REVIEW, '..', '..', '..');
const APP_DIR = join(REPO, 'apps', 'app');
const PORT = Number(process.env.REVIEW_PORT ?? 4179);
const BASE = `http://127.0.0.1:${PORT}`;
const TODAY = join(REVIEW, 'today');
const TEMPLATES = join(REVIEW, 'templates');
const FRAGMENTS = join(TEMPLATES, 'fragments');
mkdirSync(TODAY, { recursive: true });
mkdirSync(FRAGMENTS, { recursive: true });

const CREATED = '2026-10-12T09:00:00.000Z';
const minutesAgo = (n: number) => Date.now() - n * 60_000;

type Stage = 'review' | 'building' | 'ready' | 'blocked' | 'empty';

function project(id: string, name: string, description: string | null, extra: Record<string, unknown> = {}) {
	return { id, workspaceId: 'ws-1', name, description, contestId: null, contestUrl: null, status: 'active', kind: 'standard', createdAt: CREATED, updatedAt: CREATED, ...extra };
}
const HOME = project('home-1', 'Home', null, { kind: 'home' });
const FARM = project('proj-farm', 'FarmLog AI', 'Helps small farmers log feed and spot a sick animal early.');
const HERD = project('proj-herd', 'HerdVoice', 'Lets herders report a sick animal by voice, in their own language.');
const PIT = project('proj-pit', 'Pit wall', 'A race-day strategy board for a small karting team.');
const MARKET = project('proj-market', 'Market Day', 'Shows which stalls have stock before you travel.');
const BUDGET = project('proj-budget', 'Budget buddy', 'A simple monthly budget for a student.');

const NEBIUS = { title: 'Nebius x NVIDIA Global AI Hackathon', url: 'https://nebiusglobalaihackathon.devpost.com', track: null, deadline: '2026-10-30', daysLeft: 9, ended: false, eligibility: 'eligible' };

/** The server's own words per stage (server/project-experience.ts messageOf/actionsOf). */
function experience(projectId: string, stage: Stage) {
	const approved = { id: 'plan-2', revision: '2', approved: true };
	switch (stage) {
		case 'empty':
			return { projectId, version: 0, stage: 'planning', plan: null, preview: null, message: 'No workflow yet.', actions: [] };
		case 'review':
			return {
				projectId, version: minutesAgo(4), stage: 'review', plan: { id: 'plan-1', revision: '1', approved: false }, preview: null,
				message: 'A plan is ready for your review.',
				actions: [
					{ kind: 'approve_plan', label: 'Approve plan', enabled: true, primary: true },
					{ kind: 'suggest_change', label: 'Request a change', enabled: true, primary: false },
				],
			};
		case 'building':
			return {
				projectId, version: minutesAgo(1), stage: 'building', plan: approved, preview: null,
				message: 'Caddie is building and checking your app.',
				actions: [{ kind: 'stop', label: 'Stop build', enabled: true, primary: true }],
			};
		case 'ready':
			return {
				projectId, version: minutesAgo(12), stage: 'ready', plan: approved, preview: { id: 'out-7', revision: '2', current: true },
				message: 'Your app passed the required checks. Try it out.',
				actions: [
					{ kind: 'open_preview', label: 'Try app', enabled: true, primary: true },
					{ kind: 'suggest_change', label: 'Request a change', enabled: true, primary: false },
				],
			};
		case 'blocked':
			return {
				projectId, version: minutesAgo(20), stage: 'blocked', plan: approved, preview: null,
				message: 'Caddie stopped making progress on the build for 12 minutes, so it was paused. Your plan and files are saved. Press Retry to continue from here.',
				actions: [{ kind: 'retry', label: 'Review next step', enabled: true, primary: true }],
			};
	}
}

const PHASE: Record<Stage, string | null> = { empty: null, review: 'review', building: 'building', ready: 'ready', blocked: 'blocked' };

const FEATURES = ['Log daily feed', 'See the feed dashboard', 'Flag a sick animal', 'Record a vet visit', 'Weekly summary for the farm', 'Works without a signal', 'Add a photo to a log'];
function activity(projectId: string, stage: Stage) {
	const passed = stage === 'ready' ? 7 : stage === 'blocked' ? 3 : 2;
	const features = FEATURES.map((title, i) => {
		const status = i < passed ? 'passed' : i === passed && stage === 'building' ? 'building' : i === passed && stage === 'blocked' ? 'failed' : 'pending';
		return { id: `f-${i + 1}`, title, doneWhen: ['check'], position: i + 1, status, attempts: status === 'pending' ? 0 : 1, testsPassed: status === 'passed' ? 10 : null, passedAt: status === 'passed' ? CREATED : null, canRollBack: false };
	});
	const at = new Date(minutesAgo(1)).toISOString();
	const stages = [
		{ key: 'setup', label: 'Get the workspace ready', state: 'done', startedAt: at, endedAt: at, durationMs: 20_000, detail: null },
		{ key: 'write', label: 'Write the app', state: stage === 'building' ? 'active' : 'done', startedAt: at, endedAt: stage === 'building' ? null : at, durationMs: 240_000, detail: '14 files' },
		{ key: 'test', label: 'Run its own tests', state: stage === 'ready' ? 'done' : 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
		{ key: 'check', label: 'Final checks by Caddie', state: stage === 'ready' ? 'done' : 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
		{ key: 'preview', label: 'Make the preview', state: stage === 'ready' ? 'done' : 'pending', startedAt: null, endedAt: null, durationMs: null, detail: null },
	];
	return {
		projectId, phase: PHASE[stage] ?? 'planning', building: stage === 'building', steps: [], rounds: [], openIssues: 0, features,
		timeline: {
			phase: PHASE[stage] ?? 'planning', startedAt: at, lastActivityAt: at, elapsedMs: 300_000, idleMs: 5_000, quiet: false, summary: 'Caddie is writing the app.',
			stages, scope: [], files: [{ path: 'src/App.tsx', area: 'app', writes: 3, lastAt: at, bytes: 4200, role: 'frontend' }],
			fileAreas: { app: 9, test: 3, style: 1, config: 1, server: 0 },
			commands: [{ command: 'bun run build', outcome: 'ok', exitCode: 0, testsPassed: null, testsFailed: null, at, durationMs: 4_000, role: 'frontend' }],
			tests: null, checks: [],
		},
	};
}

interface World {
	projects: Array<ReturnType<typeof project>>;
	stages: Record<string, Stage>;
	hackathons: Record<string, typeof NEBIUS | null>;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stub(context: BrowserContext, world: World) {
	await context.route('**/api/auth/status', (r) => json(r, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (r) => json(r, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (r) => json(r, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Jamal', email: 'owner@caddie.test' } }));
	await context.route('**/api/home-project', (r) => json(r, 200, { project: HOME }));
	await context.route('**/api/profile', (r) => json(r, 200, { profile: null }));
	await context.route('**/api/brief/read', (r) => json(r, 200, { marked: 0 }));
	await context.route('**/api/brief', (r) => json(r, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: new Date().toISOString() }));
	await context.route('**/api/usage', (r) => json(r, 200, { payer: { payerId: 'actor-test', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 2500, reservations: 0 } }));
	await context.route('**/api/projects', (r) => json(r, 200, { projects: [HOME, ...world.projects] }));
	await context.route('**/api/project-hackathons', (r) => {
		const map: Record<string, unknown> = {};
		for (const [id, h] of Object.entries(world.hackathons)) if (h) map[id] = { title: h.title, deadline: h.deadline, daysLeft: h.daysLeft, ended: h.ended };
		return json(r, 200, { hackathons: map });
	});
	await context.route('**/api/notifications**', (r) => json(r, 200, { notifications: [] }));
	await context.route('**/api/memory/offers**', (r) => json(r, 200, { offers: [] }));
	await context.route('**/api/approvals**', (r) => json(r, 200, { approval: null }));
	await context.route('**/api/projects/**', (r) => {
		const path = new URL(r.request().url()).pathname;
		const id = path.split('/')[3] ?? '';
		const stage = world.stages[id] ?? 'empty';
		if (path.endsWith('/workflow')) return json(r, 200, { workflow: PHASE[stage] ? { phase: PHASE[stage], brief: 'Build FarmLog AI for small farmers.' } : null, importPreview: null });
		if (path.endsWith('/experience')) return json(r, 200, experience(id, stage));
		if (path.endsWith('/activity')) return json(r, 200, activity(id, stage));
		if (path.endsWith('/hackathon')) return json(r, 200, { hackathon: world.hackathons[id] ?? null });
		if (path.endsWith('/brief')) return json(r, 200, { cards: [] });
		if (path.endsWith('/plan-docs')) return json(r, 200, { revisions: [], latest: null });
		if (path.endsWith('/run-bindings')) return json(r, 200, { runBindings: [] });
		if (path.endsWith('/tasks')) return json(r, 200, { tasks: [] });
		if (path.endsWith('/previews')) return json(r, 200, { previews: [] });
		return json(r, 200, {});
	});
}

const VIEWPORTS = {
	desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
	phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
} as const;

function stripScripts(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script>/gi, '')
		.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/gi, '')
		.replace(/<link\b[^>]*rel="manifest"[^>]*>/gi, '');
}

async function waitForServer(): Promise<void> {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/app/`, { signal: AbortSignal.timeout(1500) });
			if (res.status === 200) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	throw new Error(`preview did not answer on ${BASE} within 45s`);
}

async function main() {
	let server: ChildProcess | null = null;
	const log = openSync(join(tmpdir(), `review-preview-${process.pid}.log`), 'w');
	try {
		await fetch(`${BASE}/app/`, { signal: AbortSignal.timeout(1000) });
		throw new Error(`port ${PORT} is already answering; stop that server or set REVIEW_PORT`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('port ')) throw error;
	}
	server = spawn('bunx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
		cwd: APP_DIR,
		env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'review-preview-')) },
		stdio: ['ignore', log, log],
		detached: true,
	});
	const browser = await chromium.launch({ headless: true });
	try {
		await waitForServer();
		const projectWorld = (stage: Stage): World => ({ projects: [FARM, HERD, PIT, MARKET, BUDGET], stages: { 'proj-farm': stage }, hackathons: { 'proj-farm': NEBIUS } });
		const listWorld: World = {
			projects: [FARM, HERD, PIT, MARKET, BUDGET],
			stages: { 'proj-farm': 'building', 'proj-herd': 'ready', 'proj-pit': 'review', 'proj-market': 'blocked', 'proj-budget': 'empty' },
			hackathons: { 'proj-farm': NEBIUS, 'proj-herd': { ...NEBIUS }, 'proj-pit': null, 'proj-market': null, 'proj-budget': null },
		};
		const shots: Array<{ name: string; url: string; world: World; ready: string; template?: string }> = [
			{ name: 'list', url: '/app/projects', world: listWorld, ready: '[data-testid="project-list"]', template: 'list' },
			{ name: 'list-empty', url: '/app/projects', world: { projects: [], stages: {}, hackathons: {} }, ready: '[data-testid="state-empty"], .state-panel' },
			...(['review', 'building', 'ready', 'blocked', 'empty'] as const).map((stage) => ({
				name: `project-${stage}`,
				url: '/app/project?project=proj-farm',
				world: projectWorld(stage),
				ready: stage === 'empty' ? '[data-testid="overview-next-step"]' : '[data-testid="overview-now"][data-stage]',
				template: stage === 'ready' ? 'project' : undefined,
			})),
		];
		for (const shot of shots) {
			for (const [vp, options] of Object.entries(VIEWPORTS)) {
				const context = await browser.newContext({ ...options, serviceWorkers: 'block', colorScheme: 'dark' });
				await stub(context, shot.world);
				const page = await context.newPage();
				await page.goto(`${BASE}${shot.url}`);
				await page.locator(shot.ready).first().waitFor({ state: 'visible', timeout: 20_000 });
				await page.waitForTimeout(1200);
				await page.screenshot({ path: join(TODAY, `${shot.name}-${vp}.png`) });
				measures[`${shot.name}-${vp}`] = await measure(page);
				await page.addStyleTag({ content: UNCLIP });
				await page.waitForTimeout(150);
				await page.screenshot({ path: join(TODAY, `${shot.name}-${vp}-full.png`), fullPage: true });
				writeFileSync(join(TEMPLATES, `${shot.name}-${vp}.html`), stripScripts(await page.content()));
				if (shot.template) writeFileSync(join(TEMPLATES, `${shot.template}-${vp}.html`), stripScripts(await page.content()));
				// The real build-stage and feature lists, lifted as-is into the mockups.
				for (const id of ['build-stages', 'build-features']) {
					const found = page.locator(`main [data-testid="${id}"]`).first();
					if ((await found.count()) > 0) writeFileSync(join(FRAGMENTS, `${shot.name}-${id}-${vp}.html`), await found.evaluate((el) => el.outerHTML));
				}
				console.log(`captured ${shot.name}-${vp}`);
				await context.close();
			}
		}
		writeFileSync(join(TODAY, 'measure.json'), `${JSON.stringify(measures, null, '\t')}\n`);
	} finally {
		await browser.close();
		if (server?.pid) {
			try {
				process.kill(-server.pid, 'SIGTERM');
			} catch {
				// already gone
			}
		}
	}
}

await main();
