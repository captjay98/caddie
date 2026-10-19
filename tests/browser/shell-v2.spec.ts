import { expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shell v2 acceptance (U01, docs/design/2026-10-10-v2/PACKETS.md) — run
 * against the COMPOSED build (`bun run build` first: the real Worker under
 * `vite preview` = local workerd on 127.0.0.1:4173, SPA at /app/).
 *
 * What U01 guarantees (HANDOFF §3.1–§3.3, §3.9):
 *   - Three viewport bands: ≥1081 two-panel desktop, 761–1080 tablet overlay
 *     (min(420px,100vw) + scrim from a top-bar Caddie button), ≤760 mobile.
 *   - The Caddie panel is a FRACTION of the window: default 40%, min 340px,
 *     max min(60%, window − 520px) — the content column never drops under
 *     520px. Drag + full keyboard resize (±2%, Shift ±10%, Home, End, Enter),
 *     double-click reset, ARIA separator semantics, percent tip.
 *   - The fraction AND the open/closed state persist per browser and survive
 *     reload; the closed state is the 64px character rail.
 *   - Full-screen chat via ?pane=channel at every band.
 *   - Theme (§3.9): loading a page NEVER writes `caddie-theme`; only an
 *     explicit toggle does; the toggle's label names the theme it switches to.
 *
 * These are UI-state proofs against stubbed API routes (same split as
 * tests/browser/workspace.spec.ts) — not auth or live-data evidence.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-u01-browser-preview-${process.pid}.log`;

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
		throw new Error('Composed build missing — run `bun run build` before tests/browser/shell-v2.spec.ts');
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

// The root tsconfig omits the "dom" lib; these callbacks run in the browser via
// page.evaluate, so declare the minimal surface this spec touches.
declare const window: { innerWidth: number };
declare const localStorage: { getItem(key: string): string | null };
declare const document: { documentElement: { scrollWidth: number; clientWidth: number } };

// --- stubbing (mirrors the workspace.spec harness) ------------------------------

const NOW = '2026-10-10T10:00:00.000Z';

function project(id: string, name: string, kind: 'standard' | 'home' = 'standard') {
	return {
		id,
		workspaceId: 'ws-1',
		name,
		description: null,
		contestId: null,
		contestUrl: null,
		status: 'active',
		kind,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

const HOME = project('home-1', 'Home', 'home');
const PROJECT_A = project('proj-a', 'Pit wall');

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAccount(context: BrowserContext) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, {
			session: { userId: 'actor-test' },
			user: { id: 'actor-test', name: 'Ada Lovelace', email: 'ada@caddie.test' },
		}),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) =>
		json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
	);
	await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME, PROJECT_A] }));
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
		if (path.endsWith('/artifact-revisions')) return json(route, 200, { artifacts: [], latest: null });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
		return json(route, 200, {});
	});
}

// --- tests ----------------------------------------------------------------------

test.describe('shell v2: resizable Caddie panel, bands, theme (U01)', () => {
	test('desktop opens the panel at 40% of the window by default (±1px)', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('nav-capsule')).toBeVisible();

		const panel = page.getByTestId('conversation-panel');
		await expect(panel).toBeVisible();
		const box = await panel.boundingBox();
		const innerWidth = await page.evaluate(() => window.innerWidth);
		expect(Math.round(innerWidth * 0.4)).toBe(576);
		expect(Math.abs((box?.width ?? 0) - innerWidth * 0.4)).toBeLessThanOrEqual(1);

		// The resize handle is a real ARIA separator with percent semantics.
		const handle = page.getByTestId('conv-resize-handle');
		await expect(handle).toHaveAttribute('role', 'separator');
		await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
		await expect(handle).toHaveAttribute('aria-valuenow', '40');
		await expect(handle).toHaveAttribute('aria-valuetext', 'Caddie takes 40% of the window');
		await context.close();
	});

	test('dragging clamps to the legal range and the content column stays ≥520px', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('conv-resize-handle')).toBeVisible();

		const handle = page.getByTestId('conv-resize-handle');
		const handleBox = await handle.boundingBox();
		const y = handleBox!.y + 300;

		// Drag the panel's left edge far LEFT → panel grows to its maximum
		// (min(60% of window, window − 520px) = 864px at 1440).
		await page.mouse.move(handleBox!.x + 5, y);
		await page.mouse.down();
		await page.mouse.move(60, y, { steps: 8 });
		await page.mouse.up();
		let panelBox = await page.getByTestId('conversation-panel').boundingBox();
		expect(panelBox?.width).toBe(864);

		// Content column = 1440 − 864 = 576 ≥ 520.
		const leftBox = await page.getByTestId('shell-left').boundingBox();
		expect(leftBox!.width).toBeGreaterThanOrEqual(520);

		// Drag far RIGHT → panel shrinks to its 340px minimum. The handle now
		// sits at the panel's new left edge (1440 − 864 = 576), so start there.
		const handleNow = await handle.boundingBox();
		await page.mouse.move(handleNow!.x + 5, y);
		await page.mouse.down();
		await page.mouse.move(1400, y, { steps: 8 });
		await page.mouse.up();
		panelBox = await page.getByTestId('conversation-panel').boundingBox();
		expect(panelBox?.width).toBe(340);

		// The tip shows during a drag and marks the default. Re-acquire the
		// handle position first — it sits at the panel's current left edge.
		const handleAgain = await handle.boundingBox();
		await page.mouse.move(handleAgain!.x + 5, y);
		await page.mouse.down();
		await page.mouse.move(1440 - 576, y, { steps: 4 });
		const tip = page.getByTestId('conv-width-tip');
		await expect(tip).toBeVisible();
		await expect(tip).toContainText('%');
		await page.mouse.up();
		await context.close();
	});

	test('keyboard resize: ±2%, Shift ±10%, Home/End, Enter resets, ARIA values follow', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		const handle = page.getByTestId('conv-resize-handle');
		await handle.focus();

		const widthOf = () => page.getByTestId('conversation-panel').boundingBox().then((b) => b?.width ?? 0);

		// ArrowLeft widens by 2% of the window (28.8px at 1440 → rounds in px).
		const start = await widthOf();
		await handle.press('ArrowLeft');
		expect((await widthOf()) - start).toBeCloseTo(1440 * 0.02, -1);

		// Shift+ArrowRight shrinks by 10%.
		const afterStep = await widthOf();
		await handle.press('Shift+ArrowRight');
		expect(afterStep - (await widthOf())).toBeCloseTo(1440 * 0.1, -1);

		// End = maximum = min(60%·1440, 1440−520) = 864px.
		await handle.press('End');
		expect(await widthOf()).toBe(864);
		await expect(handle).toHaveAttribute('aria-valuemax', '60');
		await expect(handle).toHaveAttribute('aria-valuetext', 'Caddie takes 60% of the window');

		// Home = minimum = 340px.
		await handle.press('Home');
		expect(await widthOf()).toBe(340);
		await expect(handle).toHaveAttribute('aria-valuemin', '24'); // 340/1440 ≈ 23.6 → 24
		await expect(handle).toHaveAttribute('aria-valuetext', 'Caddie takes 24% of the window');

		// Enter resets to the 40% default.
		await handle.press('Enter');
		expect(await widthOf()).toBe(576);
		await expect(handle).toHaveAttribute('aria-valuenow', '40');

		// Double-click also resets: drive to max, then dblclick.
		await handle.press('End');
		await handle.dblclick();
		expect(await widthOf()).toBe(576);
		await context.close();
	});

	test('the fraction and open/closed state persist across reload; closed state is the rail', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		// Set a distinctive width (End = 864px), reload → restored.
		const handle = page.getByTestId('conv-resize-handle');
		await handle.focus();
		await handle.press('End');
		await expect(page.getByTestId('conversation-panel').boundingBox().then((b) => b?.width)).resolves.toBe(864);
		await page.reload();
		await expect(page.getByTestId('nav-capsule')).toBeVisible();
		await expect(page.getByTestId('conversation-panel').boundingBox().then((b) => b?.width)).resolves.toBe(864);

		// Close → the 64px rail; reload → still closed.
		await page.getByTestId('conv-collapse').click();
		const rail = page.getByTestId('conv-rail');
		await expect(rail).toBeVisible();
		const railBox = await page.getByTestId('conversation-panel').boundingBox();
		expect(railBox?.width).toBe(64);
		await page.reload();
		await expect(page.getByTestId('conv-rail')).toBeVisible();

		// Reopen from the rail → panel again; persists across reload.
		await page.getByTestId('conv-rail-open').click();
		await expect(page.getByTestId('conv-resize-handle')).toBeVisible();
		await page.reload();
		await expect(page.getByTestId('conv-resize-handle')).toBeVisible();
		await context.close();
	});

	test('the content column never drops under 520px even at the 1081px threshold', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1081, height: 800 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		const handle = page.getByTestId('conv-resize-handle');
		await handle.focus();
		await handle.press('End');
		// max = min(0.6·1081, 1081−520) = 561 → content exactly 520.
		const panelBox = await page.getByTestId('conversation-panel').boundingBox();
		expect(panelBox?.width).toBe(561);
		const leftBox = await page.getByTestId('shell-left').boundingBox();
		expect(leftBox!.width).toBeGreaterThanOrEqual(520);
		await context.close();
	});

	test('tablet band (768px): content full width, Caddie overlay opens from the top bar with a scrim', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);

		// Closed by default: no panel, no scrim; the capsule carries the toggle.
		await expect(page.getByTestId('conv-toggle')).toBeVisible();
		await expect(page.getByTestId('conversation-panel')).toBeHidden();
		await expect(page.getByTestId('conv-scrim')).toHaveCount(0);

		await page.getByTestId('conv-toggle').click();
		await expect(page.getByTestId('conversation-panel')).toBeVisible();
		await expect(page.getByTestId('conv-scrim')).toBeVisible();
		const box = await page.getByTestId('conversation-panel').boundingBox();
		// Round, don't ceil: the overlay is a fixed 420px that slides in with a
		// transform, and mid-slide the rect's width can read 420.00001, which
		// Math.ceil turned into a 421 failure about one run in eight.
		expect(Math.round(box?.width ?? 0)).toBeLessThanOrEqual(420);

		// Scrim click closes.
		await page.getByTestId('conv-scrim').click({ position: { x: 40, y: 300 } });
		await expect(page.getByTestId('conv-scrim')).toHaveCount(0);
		await expect(page.getByTestId('conversation-panel')).toBeHidden();

		// Open again; Esc also closes.
		await page.getByTestId('conv-toggle').click();
		await expect(page.getByTestId('conversation-panel')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('conversation-panel')).toBeHidden();
		await context.close();
	});

	test('?pane=channel is the full-screen chat at every band, with a way back', async ({ browser }) => {
		// Desktop.
		const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(desktop);
		const dPage = await desktop.newPage();
		await dPage.goto(`${BASE}/app/`);
		await dPage.getByTestId('conv-expand').click();
		await expect(dPage.getByTestId('app-split')).toHaveAttribute('data-conv-state', 'full');
		// The left content is hidden; the chat owns the window.
		const leftHidden = await dPage.getByTestId('shell-left').isHidden();
		expect(leftHidden).toBe(true);
		await dPage.getByTestId('conv-exit-full').click();
		await expect(dPage.getByTestId('app-split')).toHaveAttribute('data-conv-state', 'open');
		await desktop.close();

		// Mobile (390): pane=channel opens the chat over the content.
		const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(mobile);
		const mPage = await mobile.newPage();
		await mPage.goto(`${BASE}/app/?pane=channel`);
		await expect(mPage.getByTestId('app-split')).toHaveAttribute('data-conv-state', 'full');
		await mobile.close();
	});

	test('loading a page never writes caddie-theme; only the toggle does, labelled with the target', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('nav-capsule')).toBeVisible();

		// §3.9: no saved choice → no key written just by loading.
		const storedAfterLoad = await page.evaluate(() => localStorage.getItem('caddie-theme'));
		expect(storedAfterLoad).toBeNull();

		// The toggle's label names the theme it switches TO.
		const toggle = page.getByTestId('theme-toggle');
		await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');
		await toggle.click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');
		expect(await page.evaluate(() => localStorage.getItem('caddie-theme'))).toBe('light');

		// The choice persists; loading the page never rewrites it.
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await context.close();
	});

	test('the account menu states the real session identity (name + email)', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await page.getByTestId('account-menu').click();
		const head = page.getByTestId('account-menu-head');
		await expect(head).toContainText('Ada Lovelace');
		await expect(head).toContainText('ada@caddie.test');
		await context.close();
	});

	test('at 390px the mobile shell is unchanged: bottom nav, one composer, no horizontal scroll', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('bottom-nav')).toBeVisible();
		await expect(page.getByTestId('composer-input')).toHaveCount(1);
		const overflow = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
		}));
		expect(overflow.scrollWidth).toBe(overflow.clientWidth);
		await context.close();
	});

	test('U02: the ask bar sits above the mobile tab bar on non-Caddie tabs and opens the Caddie tab bound to the screen', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(context);
		const page = await context.newPage();

		// The Caddie tab (mobile default): the real composer, no ask bar.
		await page.goto(`${BASE}/app/`);
		await expect(page.getByTestId('composer-input')).toBeVisible();
		await expect(page.getByTestId('ask-bar')).toHaveCount(0);

		// Brief tab: the ask bar replaces the composer above the tab bar.
		await page.goto(`${BASE}/app/?pane=brief`);
		await expect(page.getByTestId('ask-bar')).toBeVisible();
		await expect(page.getByTestId('composer-input')).toHaveCount(0);

		// Tapping it opens the Caddie tab (pane=channel), scoped to Everything.
		await page.getByTestId('ask-bar').click();
		await expect(page).toHaveURL(/pane=channel/);
		await expect(page.getByTestId('conv-context-label')).toContainText('Everything');

		// On a project route the ask bar names the project it will open.
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('ask-bar')).toBeVisible();
		await expect(page.getByTestId('ask-bar')).toContainText('Ask about Pit wall…');
		await page.getByTestId('ask-bar').click();
		await expect(page).toHaveURL(/pane=channel/);
		await expect(page.getByTestId('conv-context-label')).toContainText('Pit wall');
		await context.close();
	});

	test('U02: the mobile tab bar reads Caddie · Brief · Discover · Projects', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/?pane=brief`);
		const nav = page.getByTestId('bottom-nav');
		await expect(nav).toContainText('Caddie');
		await expect(nav).toContainText('Brief');
		await expect(nav).toContainText('Discover');
		await expect(nav).toContainText('Projects');
		// The old word is gone from the visible tab bar.
		await expect(nav).not.toContainText('Chat');
		await context.close();
	});

	test('U02: the Talking about switch lists Everything + projects and navigates between scopes', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await stubAccount(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/project?project=proj-a`);
		await expect(page.getByTestId('conv-context-label')).toContainText('Pit wall');

		// Open the switch: Everything + the active projects; the current one marked.
		await page.getByTestId('talking-about').click();
		const menu = page.getByTestId('talking-about-menu');
		await expect(menu).toBeVisible();
		// U02 honesty (B05 pending): the switch describes itself as a scope
		// switch, never as separate chat threads.
		await expect(menu).toContainText('Switches what this chat is about.');
		await expect(menu.getByTestId('scope-everything')).toBeVisible();
		await expect(menu.getByTestId('scope-proj-a')).toBeVisible();

		// Selecting Everything navigates out of the project; scope follows.
		await menu.getByTestId('scope-everything').click();
		await expect(page).toHaveURL(/\/app\/$/);
		await expect(page.getByTestId('conv-context-label')).toContainText('Everything');

		// Back into the project via the switch.
		await page.getByTestId('talking-about').click();
		await page.getByTestId('talking-about-menu').getByTestId('scope-proj-a').click();
		await expect(page).toHaveURL(/project=proj-a/);
		await expect(page.getByTestId('conv-context-label')).toContainText('Pit wall');
		await context.close();
	});
});
