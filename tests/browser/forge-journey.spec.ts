import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * P09 browser journey — Playwright assertions for the acceptance manifest's
 * browser-check phase, run against the seeded fixture app (Hono API + React
 * client).
 *
 * Server resolution, in order:
 *   1. JOURNEY_BASE_URL (set by scripts/run-journey.ts — the server hosting
 *      the sandbox-built dist/main.js artifact),
 *   2. an already-running fixture server on 127.0.0.1:8791,
 *   3. otherwise this spec starts the fixture server itself (local mode), so
 *      `bun run test:browser -- P09` proves the UI without the sandbox.
 *
 * Assertions are the manifest's: the UI renders the seeded task list, and the
 * modified behavior (a task added through the API) renders on the next load.
 */

const PORT = 8791;
const BASE_URL = process.env.JOURNEY_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/forge-task-tracker', import.meta.url));

let server: ReturnType<typeof spawn> | null = null;

test.beforeAll(async () => {
	const alreadyUp = await fetch(`${BASE_URL}/api/health`)
		.then((r) => r.ok)
		.catch(() => false);
	if (alreadyUp) return;
	server = spawn('bun', ['run', 'src/server.ts'], {
		cwd: FIXTURE_DIR,
		env: { ...process.env, PORT: String(PORT) },
		stdio: 'ignore',
	});
	let up = false;
	for (let i = 0; i < 40 && !up; i++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		up = await fetch(`${BASE_URL}/api/health`)
			.then((r) => r.ok)
			.catch(() => false);
	}
	if (!up) throw new Error(`fixture server failed to start on ${BASE_URL}`);
});

test.afterAll(() => {
	server?.kill();
});

test.describe('P09 forge journey browser checks (fixture app)', () => {
	test('health endpoint responds ok', async ({ request }) => {
		const health = await request.get(`${BASE_URL}/api/health`);
		expect(health.status()).toBe(200);
		expect(await health.json()).toEqual({ ok: true });
	});

	test('the UI renders the seeded task list', async ({ page }) => {
		await page.goto(BASE_URL);
		const items = page.getByTestId('task-item');
		await expect(items).toHaveCount(2);
		await expect(items.first()).toContainText('seeded task one');
		await expect(items.nth(1)).toContainText('seeded task two');
		await expect(page.getByTestId('open-count')).toContainText('2 open');
	});

	test('modified behavior: a task added through the API renders on reload', async ({ page, request }) => {
		const created = await request.post(`${BASE_URL}/api/tasks`, {
			data: { title: 'journey browser probe' },
		});
		expect(created.status()).toBe(201);
		await page.goto(BASE_URL);
		const items = page.getByTestId('task-item');
		await expect(items).toHaveCount(3);
		await expect(items.last()).toContainText('journey browser probe');
		await expect(page.getByTestId('open-count')).toContainText('3 open');
	});
});
