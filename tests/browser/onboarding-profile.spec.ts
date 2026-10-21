import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Profile wizard acceptance (minimal onboarding) — run against the COMPOSED
 * build (`bun run build` first).
 *
 * What this guarantees:
 *   - The required country select blocks advancement on step 1.
 *   - Back preserves earlier answers; the segmented experience/format pickers
 *     keep their selection.
 *   - Interests are a chip flow (suggestion chips toggle, an inline input adds
 *     your own); the field is OPTIONAL.
 *   - Skills / budget / highlight / tools / hours are NOT in onboarding — they
 *     are captured in chat (update_profile / remember) or edited in Settings.
 *   - The saved PUT /api/profile body carries ONLY the essentials (country,
 *     timezone, experience, format, interests); nothing is lost.
 *     skills, highlight, budget) alongside the existing ones.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-onboarding-profile-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/onboarding-profile.spec.ts');
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

const NOW = '2026-10-11T10:00:00.000Z';
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

async function stubAccount(context: BrowserContext, profileBody: { profile: unknown }) {
	const savedBodies: unknown[] = [];
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, {
			session: { userId: 'actor-test' },
			user: { id: 'actor-test', name: 'Ada Lovelace', email: 'user@example.com' },
		}),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	// GET returns the initial (empty) profile; PUT records the saved body and
	// echoes it back as the stored profile. Registered last so it wins.
	await context.route('**/api/profile', (route) => {
		if (route.request().method() === 'PUT') {
			savedBodies.push(route.request().postDataJSON());
			return json(route, 200, { profile: route.request().postDataJSON() });
		}
		return json(route, 200, profileBody);
	});
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME] }));
	await context.route('**/api/projects/**', (route) => json(route, 200, {}));
	let onboardingCompleted = false;
	await context.route('**/api/onboarding', (route) =>
		json(route, 200, { completedAt: onboardingCompleted ? NOW : null }),
	);
	await context.route('**/api/onboarding/complete', (route) => {
		onboardingCompleted = true;
		return json(route, 200, { completedAt: NOW });
	});
	return savedBodies;
}

test.describe('Profile wizard (minimal onboarding)', () => {
	test('required country blocks Continue; Back preserves answers', async ({ browser }, testInfo) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(context, { profile: null });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/onboarding`);
		// The intro hands straight to the profile wizard (no faces stage).
		await page.getByTestId('welcome-next').click();
		await page.getByTestId('welcome-name-skip').click();

		// Nothing chosen: the required country select blocks Continue.
		await expect(page.getByTestId('onboarding-profile')).toBeVisible();
		await page.getByTestId('onboarding-profile-continue').click();
		await expect(page.getByRole('heading', { name: 'Where are you joining from?' })).toBeVisible();

		await page.getByLabel('Where do you live?').fill('Nigeria');
		await page.getByTestId('onboarding-profile-continue').click();

		// Step 2 (the last step) pairs experience + participation format as
		// segmented pickers.
		await expect(page.getByRole('heading', { name: 'A few quick picks. Then we’re off.' })).toBeVisible();
        const finish = page.getByTestId('onboarding-profile-save');
        expect((await finish.boundingBox())?.height).toBe(48);
        expect(await finish.evaluate(el => el.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('quick-picks-mobile.png'), fullPage: true });
        await page.setViewportSize({ width: 320, height: 568 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await page.getByTestId('onboarding-experience').getByRole('radio', { name: 'A few apps' }).click();
		await page.getByTestId('onboarding-format').getByRole('radio', { name: 'Either' }).click();

		// Back returns to step 1 with the country intact; forward keeps step-2 answers.
		await page.getByRole('button', { name: 'Back' }).click();
		await expect(page.getByLabel('Where do you live?')).toHaveValue('Nigeria');
		await page.getByTestId('onboarding-profile-continue').click();
		await expect(page.getByTestId('onboarding-format')).toHaveAttribute('data-value', 'either');
		await context.close();
	});

	test('minimal onboarding: interests chips work, and the save body carries ONLY the essentials (rest learned in chat)', async ({ browser }) => {
		const context = await browser.newContext();
		const savedBodies = await stubAccount(context, { profile: null });
		const page = await context.newPage();
		await page.goto(`${BASE}/app/onboarding`);
		await page.getByRole('radio', { name: 'I’m exploring' }).check();
		await page.getByTestId('welcome-next').click();
		await page.getByTestId('welcome-name-skip').click();

		await page.getByLabel('Where do you live?').fill('Nigeria');
		await page.getByTestId('onboarding-profile-continue').click();

		await page.getByTestId('onboarding-experience').getByRole('radio', { name: 'A few apps' }).click();
		await page.getByTestId('onboarding-format').getByRole('radio', { name: 'Either' }).click();

		// The one remaining chip row is interests, and it is OPTIONAL.
		const interests = page.getByTestId('onboarding-interests');
		// "Open to anything" leads the row and is exclusive: a topic replaces it.
		await expect(interests.getByRole('button', { name: 'Open to anything', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(interests.getByTestId('onboarding-interests-search')).toHaveCount(0);
		await expect(interests.getByTestId('onboarding-interests-count')).toHaveText('Open to anything');
		await interests.getByRole('button', { name: 'AI & agents', exact: true }).click();
		await expect(interests.getByRole('button', { name: 'Open to anything', exact: true })).toHaveAttribute('aria-pressed', 'false');
		await interests.getByTestId('onboarding-interests-more').click();
		// More topics preserves catalog search and custom interests.
		await interests.getByTestId('onboarding-interests-search').fill('agri');
		await interests.getByRole('button', { name: 'Agriculture', exact: true }).click();
		// Anything not listed is one click away.
		await interests.getByTestId('onboarding-interests-search').fill('Race telemetry');
		await interests.getByTestId('onboarding-interests-add').click();
		await expect(interests.getByTestId('onboarding-interests-count')).toHaveText('3/12');

		// Skills / budget / highlight / tools / hours are GONE from onboarding.
		await expect(page.getByTestId('onboarding-skills')).toHaveCount(0);
		await expect(page.getByTestId('onboarding-budget')).toHaveCount(0);
		await expect(page.getByTestId('onboarding-highlight')).toHaveCount(0);
		await expect(page.getByText('Preferred tools')).toHaveCount(0);
		// The defer note tells the user Caddie learns the rest in conversation.
		await expect(page.getByTestId('onboarding-profile')).toContainText('You can change all of this in Settings.');

		await page.getByTestId('onboarding-profile-save').click();

		// Saving hands straight off to the app.
		await expect(page.getByTestId('brief-screen')).toBeVisible();
		expect(savedBodies).toHaveLength(1);
		// Only the essentials are written; nothing is lost (deferred fields are
		// simply not in the body — captured later in chat / Settings).
		expect(savedBodies[0]).toEqual({
			country: 'NG',
			timezone: expect.any(String),
			experienceLevel: 'intermediate',
			formatPreference: 'either',
			freeTextInterests: ['AI & agents', 'Agriculture', 'Race telemetry'],
		});
		await context.close();
	});
});
