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
 *   - Caddie introduces itself; the name question is PREFILLED from the
 *     account — "Ada Lovelace" suggests "Ada"; a GitHub-username-only name
 *     ("captjay98") leaves the box empty with an honest note.
 *   - The intro hands straight to the profile wizard (the 0016/0017 wave
 *     replaced the faces stage); finishing the wizard follows the chosen starting point.
 *   - The name the user saves is the name the account menu shows.
 *   - A name containing markup renders as text everywhere (React escaping).
 *   - Starting choices update the action immediately, including with reduced motion.
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
	// Onboarding status: not completed until /complete is called. After that it
	// reports completed, so the straight-to-app redirect lands on the Brief
	// instead of the gate bouncing back to /onboarding. The specific /complete
	// route is registered last so it wins (Playwright matches the most-recently-
	// added route first).
	let onboardingCompleted = false;
	await context.route('**/api/onboarding', (route) =>
		json(route, 200, { completedAt: onboardingCompleted ? NOW : null }),
	);
	await context.route('**/api/onboarding/complete', (route) => {
		onboardingCompleted = true;
		return json(route, 200, { completedAt: NOW });
	});
}

/** Drive the profile wizard that now follows the welcome intro. */
async function finishProfileWizard(page: import('@playwright/test').Page): Promise<void> {
	await page.getByTestId('onboarding-profile').waitFor();
	await page.getByLabel('Where do you live?').fill('Nigeria');
	await page.getByTestId('onboarding-profile-continue').click();
	await page.getByTestId('onboarding-experience').getByRole('radio', { name: 'A few apps' }).click();
	await page.getByTestId('onboarding-format').getByRole('radio', { name: 'Either' }).click();
	await page.getByTestId('onboarding-profile-save').click();
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
		await page.getByRole('radio', { name: 'I’m exploring' }).check();
		await page.getByTestId('welcome-next').click();

		const nameStep = page.getByTestId('welcome-name');
		await expect(nameStep).toBeVisible();
		await expect(page.getByTestId('welcome-name-input')).toHaveValue('Ada');
		await expect(nameStep).toContainText('From your account. Change it if you like.');

		// The user can reword and save; the wizard follows, then the app.
		await page.getByTestId('welcome-name-input').fill('Grace <b>Hopper</b>');
		await page.getByTestId('welcome-name-save').click();
		await finishProfileWizard(page);

		// Saving the profile hands off to the Brief shell.
		await expect(page.getByTestId('brief-screen')).toBeVisible();

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
		// Skip also hands to the profile wizard, never straight past onboarding.
		await expect(page.getByTestId('onboarding-profile')).toBeVisible();
		await context.close();
	});

	test('starting choices are immediate, retained on Back, and available with reduced motion', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 320, height: 568 } });
  await stubAccount(context, 'Ada Lovelace');
  const page = await context.newPage();
  await page.goto(`${BASE}/app/onboarding`);
  await expect(page.getByRole('radio', { name: 'Find a hackathon' })).toBeChecked();
  await page.getByRole('radio', { name: 'I have an idea' }).check();
  await expect(page.getByTestId('welcome-next')).toHaveText('Start with my idea →');
  await page.getByTestId('welcome-next').click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'I have an idea' })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId('welcome-next').click();
  await page.getByTestId('welcome-name-skip').click();
  await finishProfileWizard(page);
  await expect(page.getByTestId('project-start-panel')).toBeVisible();
  await expect(page).toHaveURL(/start=idea/);
  await context.close();
 });

 test('hackathon starting point opens Discover after profile setup', async ({ browser }) => {
  const context = await browser.newContext();
  await stubAccount(context, 'Ada Lovelace');
  await context.route('**/api/discovery/**', route => json(route, 200, { candidates: [], opportunities: [] }));
  const page = await context.newPage();
  await page.goto(`${BASE}/app/onboarding`);
  await page.getByTestId('welcome-next').click();
  await page.getByTestId('welcome-name-skip').click();
  await finishProfileWizard(page);
  await expect(page).toHaveURL(/\/app\/discover/);
  await context.close();
 });
});
