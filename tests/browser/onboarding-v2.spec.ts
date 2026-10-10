import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Welcome intro acceptance (U09, docs/design/2026-10-10-v2/PACKETS.md) — run
 * against the COMPOSED build (`bun run build` first).
 *
 * What U09 guarantees (HANDOFF §4 Welcome):
 *   - Caddie introduces itself with its face changing per line.
 *   - The name question is PREFILLED from the account — "Ada Lovelace"
 *     suggests "Ada"; a GitHub-username-only name ("captjay98") leaves the
 *     box empty with an honest note.
 *   - Skip works; "Say that again" replays; reduced motion shows all lines.
 *   - The name the user saves is the name the account menu shows.
 *   - A name containing markup renders as text everywhere (React escaping).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-u09-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/onboarding-v2.spec.ts');
	}
	if (!(await isListening(PORT))) {
		preview = spawn(
			'/bin/bash',
			['-c', `exec bunx vite preview --port ${PORT} --host 127.0.0.1 > '${LOG}' 2>&1`],
			{ cwd: APP_DIR, stdio: 'ignore', detached: true },
		);
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

const NOW = '2026-10-10T10:00:00.000Z';
const HOME = {
	id: 'home-1',
	workspaceId: 'ws-1',
	name: 'Home',
	description: null,
	contestId: null,
	contestUrl: null,
	status: 'active',
	kind: 'home',
	createdAt: NOW,
	updatedAt: NOW,
};

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAccount(context: BrowserContext, userName: string | null) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, {
			session: { userId: 'actor-test' },
			user: { id: 'actor-test', name: userName ?? '', email: 'user@example.com' },
		}),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME] }));
	await context.route('**/api/projects/**', (route) => json(route, 200, {}));
}

test.describe('Welcome intro (U09)', () => {
	test('"Ada Lovelace" suggests "Ada"; the saved name shows in the account menu', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, 'Ada Lovelace');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/onboarding`);

		// Caddie introduces itself; Next advances to the name question.
		await expect(page.getByTestId('welcome-intro')).toBeVisible();
		await expect(page.getByTestId('welcome-intro').locator('.mascot')).toBeVisible();
		await page.getByTestId('welcome-next').click();

		const nameStep = page.getByTestId('welcome-name');
		await expect(nameStep).toBeVisible();
		await expect(page.getByTestId('welcome-name-input')).toHaveValue('Ada');
		await expect(nameStep).toContainText('From your account. Change it if you like.');

		// The user can reword and save; the account menu shows the saved name.
		await page.getByTestId('welcome-name-input').fill('Grace <b>Hopper</b>');
		await page.getByTestId('welcome-name-save').click();
		await expect(page.getByTestId('welcome-faces')).toBeVisible();
		await page.getByTestId('welcome-go').click();
		await expect(page.getByTestId('start-screen')).toBeVisible();

		// Markup renders as TEXT, never as tags (React escaping).
		await page.getByTestId('account-menu').click();
		await expect(page.getByTestId('account-menu-name')).toContainText('Grace');
		const head = await page.getByTestId('account-menu-name').innerHTML();
		expect(head).not.toContain('<b>');
		await context.close();
	});

	test('a username-only account name leaves the box empty with an honest note; Skip works', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, 'captjay98');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/onboarding`);
		await page.getByTestId('welcome-next').click();
		await expect(page.getByTestId('welcome-name-input')).toHaveValue('');
		await expect(page.getByTestId('welcome-name')).toContainText('looks like a username');
		await page.getByTestId('welcome-name-skip').click();
		await expect(page.getByTestId('welcome-faces')).toBeVisible();
		await page.getByTestId('welcome-go').click();
		await expect(page.getByTestId('start-screen')).toBeVisible();
		await context.close();
	});

	test('"Say that again" replays; reduced motion shows all lines at once', async ({ browser }) => {
		const context = await browser.newContext();
		await stubAccount(context, 'Ada Lovelace');
		const page = await context.newPage();
		await page.goto(`${BASE}/app/onboarding`);
		// Wait for the intro to finish advancing, then replay from the start.
		await page.waitForTimeout(3400);
		const paragraphs = await page.getByTestId('welcome-intro').locator('p').count();
		expect(paragraphs).toBeGreaterThanOrEqual(3);
		await page.getByTestId('welcome-replay').click();
		await expect(page.getByTestId('welcome-intro').locator('p')).toHaveCount(1);
		await context.close();

		const reduce = await browser.newContext({ reducedMotion: 'reduce' });
		await stubAccount(reduce, 'Ada Lovelace');
		const rPage = await reduce.newPage();
		await rPage.goto(`${BASE}/app/onboarding`);
		// All lines present immediately, no waiting.
		await expect(rPage.getByTestId('welcome-intro').locator('p')).toHaveCount(3);
		await reduce.close();
	});
});
