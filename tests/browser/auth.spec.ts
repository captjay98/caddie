import { expect, test } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P01 browser spec: the sign-in panel of the COMPOSED build (real built SPA
 * served by the real Worker under `vite preview` = local workerd).
 *
 * Requirements: `bun run build` first. The spec asserts
 *   1. both provider sign-in buttons render,
 *   2. a failed sign-in attempt shows a visible error state with retry.
 *
 * Server policy (mirrors tests/routing.test.ts): if nothing listens on the
 * configured port the spec starts `vite preview` itself and stops it after
 * the run; an already-running server is reused and left alone. Never deploys.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173; // playwright.config.ts baseURL
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-p01-browser-preview-${process.pid}.log`;

let preview: ChildProcess | null = null;
let weStartedTheServer = false;

/**
 * True when something already accepts connections on this port. Probed with
 * fetch (any HTTP response counts; connection refusal does not; a slow or
 * non-HTTP listener conservatively counts as occupied to avoid double-start).
 */
async function isListening(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
		return true;
	} catch (error) {
		const name = (error as Error)?.name;
		return name === 'TimeoutError' || name === 'AbortError';
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
		await new Promise((r) => setTimeout(r, 300));
	}
	return `preview not ready within ${timeoutMs}ms: ${lastError}`;
}

test.beforeAll(async () => {
	if (!existsSync(WORKER_BUNDLE)) {
		throw new Error('Composed build missing — run `bun run build` before tests/browser/auth.spec.ts');
	}
	if (!(await isListening(PORT))) {
		// Detached own-session spawn (P00 lesson): a vite child spawned directly
		// by a test runner hangs at startup on inherited FDs.
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
	// Kill only what this run started; verify the port actually frees.
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

test.describe('P01 sign-in panel (composed build)', () => {
	test('renders both provider sign-in buttons', async ({ page }) => {
		// Deterministic availability: both providers configured, so both
		// buttons are enabled and the presence pills read "configured".
		await page.route('**/api/integrations/health', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ auth: { providers: { google: true, github: true } } }),
			}),
		);
		await page.goto(`${BASE}/app/`);
		const google = page.getByTestId('sign-in-google');
		const github = page.getByTestId('sign-in-github');
		await expect(google).toBeVisible();
		await expect(github).toBeVisible();
		await expect(google).toHaveText('Continue with Google');
		await expect(github).toHaveText('Continue with GitHub');
		await expect(page.getByTestId('sign-in-panel')).toBeVisible();
		// availability stated before the click, never after it
		await expect(page.getByTestId('sign-in-google-state')).toHaveText('configured');
		await expect(page.getByTestId('sign-in-github-state')).toHaveText('configured');
		// no stale error state on a fresh page
		await expect(page.getByTestId('sign-in-error')).toHaveCount(0);
	});

	test('unconfigured providers are labelled before the click, never a guaranteed-failure button', async ({ page }) => {
		// Deterministic availability: Google unconfigured, GitHub configured.
		await page.route('**/api/integrations/health', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ auth: { providers: { google: false, github: true } } }),
			}),
		);
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('sign-in-google-state')).toHaveText('not configured');
		await expect(page.getByTestId('sign-in-google')).toBeDisabled();
		await expect(page.getByTestId('sign-in-github-state')).toHaveText('configured');
		await expect(page.getByTestId('sign-in-github')).toBeEnabled();
	});

	test('terminal 503 offers the other provider instead of a retry that cannot work', async ({ page }) => {
		// Force the failure deterministically: a deployment WITH provisioned
		// provider credentials would redirect to the real provider on success,
		// so the error path is exercised by rejecting the sign-in POST at the
		// network layer (503 auth_not_configured) — the exact honest failure
		// the panel must surface visibly (never a dead button or silent no-op).
		await page.route('**/api/integrations/health', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ auth: { providers: { google: true, github: true } } }),
			}),
		);
		await page.route('**/api/auth/sign-in/social', async (route) => {
			await route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({
					error: 'auth_not_configured',
					message: 'Sign-in is not configured on this deployment yet.',
				}),
			});
		});
		await page.goto(`${BASE}/app/`);
		await page.getByTestId('sign-in-google').click();
		const error = page.getByTestId('sign-in-error');
		await expect(error).toBeVisible({ timeout: 10_000 });
		await expect(error).toContainText('Sign-in with Google');
		await expect(error).toContainText(/failed|unavailable/);
		// 503 is terminal: no retry, the action is the other provider.
		await expect(page.getByTestId('sign-in-retry')).toHaveCount(0);
		const other = page.getByTestId('sign-in-other');
		await expect(other).toBeVisible();
		await expect(other).toContainText('Continue with GitHub instead');
		// buttons stay usable for a manual attempt too
		await expect(page.getByTestId('sign-in-github')).toBeEnabled({ timeout: 10_000 });
	});
});
