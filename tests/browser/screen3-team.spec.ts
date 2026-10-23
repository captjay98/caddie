import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Screen 3 (plan section 7): the test inbox with an email and a code, and the
 * jobs list with Run now (parts K and N, lane 10). Run against the COMPOSED
 * build (`bun run build` first). Stub style follows build-progress-team.spec.ts.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-team-screen3-${process.pid}.log`;

let preview: ChildProcess | null = null;
let weStartedTheServer = false;

async function isListening(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
		return true;
	} catch (error) {
		const name = (error as Error)?.name;
		return name === 'TimeoutError' || name === 'AbortError';
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready(timeoutMs: number): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	let lastError = '';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/app/`, { signal: AbortSignal.timeout(1500) });
			if (res.status === 200) return undefined;
			lastError = `status ${res.status}`;
		} catch (error) {
			lastError = String(error);
		}
		await sleep(300);
	}
	return `preview not ready within ${timeoutMs}ms: ${lastError}`;
}

test.beforeAll(async () => {
	if (!existsSync(WORKER_BUNDLE)) {
		throw new Error('Composed build missing — run `bun run build` before tests/browser/screen3-team.spec.ts');
	}
	if (!(await isListening(PORT))) {
		preview = spawn('/bin/bash', ['-c', `exec bunx vite preview --port ${PORT} --host 127.0.0.1 > '${LOG}' 2>&1`], {
			cwd: APP_DIR,
			stdio: 'ignore',
			detached: true,
		});
		preview.unref();
		weStartedTheServer = true;
	}
	const notReady = await ready(30_000);
	if (notReady) {
		const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '(no log)';
		throw new Error(`${notReady}\nlog:\n${log}`);
	}
});

test.afterAll(async () => {
	if (!weStartedTheServer) return;
	for (const signal of ['-TERM', '-KILL']) {
		if (!(await isListening(PORT))) return;
		try {
			execFileSync('pkill', [signal, '-f', `vite preview --port ${PORT}`], { stdio: 'ignore' });
		} catch {
			// pkill exits 1 when nothing matched — fine
		}
		await sleep(500);
	}
});

const NOW = '2026-10-22T10:00:00.000Z';

function project(id: string, name: string, kind: 'standard' | 'home' = 'standard') {
	return { id, workspaceId: 'ws-1', name, description: null, contestId: null, contestUrl: null, status: 'active', kind, createdAt: NOW, updatedAt: NOW };
}
const HOME = project('home-1', 'Home', 'home');
const PROJ = project('proj-a', 'FarmLog');

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const INBOX = {
	messages: [{ to: 'ada@example.com', code: '123456', createdAt: NOW }],
	emails: [{ to: 'bo@example.com', subject: 'Your receipt', text: 'Thanks for your order — $12.', template: 'receipt', mode: 'preview', createdAt: NOW }],
};
const JOB_RUNS = {
	jobs: [
		{ id: 'daily-digest', plain: 'Sends everyone yesterday’s summary', every: 'day' },
		{ id: 'cleanup', plain: 'Clears old drafts', every: 'week' },
	],
	runs: [{ id: 'ajr-1', jobId: 'daily-digest', status: 'done', summary: 'Sent 4 digests.', startedAt: NOW, finishedAt: NOW }],
};

async function stub(context: BrowserContext) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) => json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }));
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) => json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }));
	await context.route('**/api/usage', (route) => json(route, 200, { payer: { payerId: 'actor-test', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 0, reservations: 0 } }));
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJ] }));
	await context.route('**/api/approvals**', (route) => json(route, 200, { approval: null }));
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/workflow/test-inbox')) return json(route, 200, INBOX);
		if (path.endsWith('/workflow/job-runs')) return json(route, 200, JOB_RUNS);
		if (path.includes('/workflow/jobs/') && path.endsWith('/run')) return json(route, 200, { ok: true, runId: 'ajr-2', status: 'done', summary: 'Sent 4 digests.' });
		if (path.endsWith('/experience')) return json(route, 200, { projectId: 'proj-a', version: Date.parse(NOW), stage: 'ready', plan: { id: 'p1', revision: '1', approved: true }, preview: { id: 'out-1' }, message: 'Your app is ready.', actions: [] });
		if (path.endsWith('/activity')) return json(route, 200, { projectId: 'proj-a', phase: 'ready', building: false, steps: [], rounds: [], openIssues: 0, features: [], timeline: null });
		if (path.endsWith('/workflow'))
			return json(route, 200, {
				workflow: { projectId: 'proj-a', phase: 'ready', planId: 'p1', previewId: 'out-1', detail: 'Build checks passed.', brief: 'Build FarmLog.' },
				plan: { id: 'p1', revision: 1 },
				approval: { status: 'approved' },
				previewHasServer: true,
				previewKind: 'react-hono',
				importPreview: null,
			});
		if (path.endsWith('/hackathon')) return json(route, 200, { hackathon: null });
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		return json(route, 200, {});
	});
}

test.describe('Screen 3 — the test inbox and the jobs list (plan section 7)', () => {
	test('the test inbox shows a code and an email marked "Not sent — test mode"', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		const inbox = page.getByTestId('test-inbox');
		await expect(inbox).toBeVisible();
		await expect(page.getByTestId('test-inbox-message')).toContainText('123456');
		const email = page.getByTestId('test-inbox-email');
		await expect(email).toContainText('Your receipt');
		await expect(email).toContainText('bo@example.com');
		await expect(page.getByTestId('test-inbox-email-tag')).toHaveText('Not sent — test mode');
		await context.close();
	});

	test('the jobs list shows each job with Run now, the note, and the latest run', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await stub(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		const jobs = page.getByTestId('app-jobs');
		await expect(jobs).toBeVisible();
		await expect(jobs).toContainText('Runs when you press Run now. Automatic schedules come after the hackathon.');
		await expect(page.getByTestId('app-job').first()).toContainText('Sends everyone yesterday’s summary');
		await expect(page.getByTestId('app-job-run').first()).toContainText('Run now');
		await expect(page.getByTestId('app-job-run-row').first()).toContainText('Sent 4 digests.');
		await context.close();
	});

	test('pressing Run now calls the run route', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		let ran = false;
		await stub(context);
		await context.route('**/api/projects/proj-a/workflow/jobs/daily-digest/run', (route) => {
			ran = true;
			return json(route, 200, { ok: true, runId: 'ajr-2', status: 'done', summary: 'Sent 4 digests.' });
		});
		const page = await context.newPage();
		await page.goto(`${BASE}/app/runs?project=proj-a`);
		await expect(page.getByTestId('app-jobs')).toBeVisible();
		await page.getByTestId('app-job-run').first().click();
		await expect.poll(() => ran).toBe(true);
		await context.close();
	});
});
