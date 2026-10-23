import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext } from '@playwright/test';

/**
 * Look-and-feel picker acceptance — run against the COMPOSED build
 * (`bun run build` first). Stubs a 'looks-review' workflow with a real
 * caddie-looks note and checks the approved mock's behaviour
 * (docs/reviews/2026-10-23-look-and-feel-picker):
 *   - desktop: the looks side by side (one radio each);
 *   - phone: name tabs, and the look IN VIEW is the choice — the "Use <name>"
 *     button and the tab's aria-pressed follow it;
 *   - touch targets >= 44px; no horizontal overflow at 320/390/412.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-looks-browser-preview-${process.pid}.log`;

let preview: ChildProcess | null = null;
let weStartedTheServer = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function isListening(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
		return true;
	} catch (error) {
		const name = (error as Error)?.name;
		return name === 'TimeoutError' || name === 'AbortError';
	}
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
		await sleep(300);
	}
	return `preview not ready within ${timeoutMs}ms: ${lastError}`;
}

test.beforeAll(async () => {
	if (!existsSync(WORKER_BUNDLE)) throw new Error('Composed build missing — run `bun run build` first');
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
	if (notReady) throw new Error(`${notReady}\nlog:\n${existsSync(LOG) ? readFileSync(LOG, 'utf8') : '(no log)'}`);
});

test.afterAll(async () => {
	if (!weStartedTheServer) return;
	for (const signal of ['-TERM', '-KILL']) {
		if (!(await isListening(PORT))) return;
		try {
			execFileSync('pkill', [signal, '-f', `vite preview --port ${PORT}`], { stdio: 'ignore' });
		} catch {
			// nothing matched — fine
		}
		await sleep(500);
	}
});

const NOW = '2026-10-10T10:00:00.000Z';
const proj = { id: 'proj-a', workspaceId: 'ws-1', name: 'Pit wall', description: null, contestId: null, contestUrl: null, status: 'active', kind: 'standard', createdAt: NOW, updatedAt: NOW };
const HOME = { ...proj, id: 'home-1', name: 'Home', kind: 'home' };

const LOOKS_SET = {
	audience: 'poultry farmers, mostly on their phones in the sheds',
	recommended: 'field',
	looks: [
		{ id: 'field', name: 'Field-ready', why: 'Dark text on a light background, with big buttons. Easy to read in bright sun.', colors: { bg: '#F7F5EF', surface: '#FFFFFF', text: '#1B1F1A', muted: '#5A6157', primary: '#1F7A3A', onPrimary: '#FFFFFF', border: '#D9D6CC', ok: '#1F7A3A', warn: '#9A4A00', danger: '#B42318' }, fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' }, radius: 10, density: 'comfortable' },
		{ id: 'calm', name: 'Calm and clear', why: 'Soft blues and plenty of space. Feels steady for money and the lender report.', colors: { bg: '#F4F7FB', surface: '#FFFFFF', text: '#142033', muted: '#5B6B82', primary: '#2B5FD9', onPrimary: '#FFFFFF', border: '#DCE3EE', ok: '#1F7A3A', warn: '#94520A', danger: '#B42318' }, fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' }, radius: 14, density: 'comfortable' },
		{ id: 'warm', name: 'Warm and bold', why: 'Dark background with amber highlights. Gentle on the eyes at dawn and dusk.', colors: { bg: '#15120E', surface: '#221D17', text: '#F5EFE6', muted: '#B8AC9A', primary: '#F2A541', onPrimary: '#1A1208', border: '#3A3228', ok: '#7BD88F', warn: '#FFB86B', danger: '#FF8A80' }, fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' }, radius: 20, density: 'comfortable' },
	],
};
const SCREEN =
	'```html-mock Today\n<main style="background:var(--bg);color:var(--text);font-family:var(--font-body);padding:16px"><h1>Today in your sheds</h1><p style="color:var(--muted)">Broilers · day 21</p><button style="background:var(--primary);color:var(--on-primary);border-radius:var(--radius);padding:10px 14px;border:0">Hold to speak</button></main>\n```';
const LOOKS_BODY = ['Three starting looks for the app.', '```caddie-looks', JSON.stringify(LOOKS_SET, null, 2), '```', SCREEN].join('\n');

async function stub(context: BrowserContext) {
	const ok = (body: unknown) => (r: { fulfill(o: Record<string, unknown>): unknown }) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	await context.route('**/api/auth/status', ok({ authenticated: true }));
	await context.route('**/api/onboarding', ok({ completedAt: NOW }));
	await context.route('**/api/auth/get-session', ok({ session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada', email: 'ada@caddie.test' } }));
	await context.route('**/api/home-project', ok({ project: HOME }));
	await context.route('**/api/profile', ok({ profile: null }));
	await context.route('**/api/brief/read', ok({ marked: 0 }));
	await context.route('**/api/brief', ok({ cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }));
	await context.route('**/api/usage', ok({ payer: { payerId: 'actor-test', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 0, reservations: 0 } }));
	await context.route('**/api/projects', ok({ projects: [HOME, proj] }));
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		const body = path.endsWith('/workflow')
			? {
					workflow: { phase: 'looks-review', conversationId: 'conv-1', projectId: 'proj-a', planId: 'plan-1' },
					approval: { id: 'apr-1', status: 'approved' },
					plan: { id: 'plan-1', revision: 1, body: '# Plan' },
					looks: { id: 'looks-1', revision: 1, body: LOOKS_BODY },
					design: null,
					designApproval: null,
			  }
			: {};
		return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	});
}

test.describe('Look-and-feel picker', () => {
	test('desktop: three looks side by side, the recommended one picked and its button', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await stub(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);
		const picker = page.getByTestId('looks-picker');
		await expect(picker).toBeVisible();
		await expect(page.getByTestId('looks-option-field')).toBeVisible();
		await expect(page.getByTestId('looks-option-calm')).toBeVisible();
		await expect(page.getByTestId('looks-option-warm')).toBeVisible();
		await expect(page.getByTestId('looks-use')).toHaveText('Use Field-ready');
		await expect(picker.getByText('poultry farmers, mostly on their phones in the sheds')).toBeVisible();
		await context.close();
	});

	test('phone: name tabs, and the look in view drives the button label', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
		await stub(context);
		const page = await context.newPage();
		await page.goto(`${BASE}/app/design-review?project=proj-a`);
		await expect(page.getByTestId('looks-picker')).toBeVisible();
		await expect(page.getByTestId('looks-tabs')).toBeVisible();
		await page.getByTestId('looks-tab-warm').click();
		await expect(page.getByTestId('looks-use')).toHaveText('Use Warm and bold');
		await expect(page.getByTestId('looks-tab-warm')).toHaveAttribute('aria-pressed', 'true');
		await context.close();
	});

	for (const width of [320, 390, 412]) {
		test(`no horizontal overflow at ${width}px, and touch targets are >= 44px`, async ({ browser }) => {
			const context = await browser.newContext({ viewport: { width, height: 780 } });
			await stub(context);
			const page = await context.newPage();
			await page.goto(`${BASE}/app/design-review?project=proj-a`);
			await expect(page.getByTestId('looks-picker')).toBeVisible();
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
			expect(overflow, `page overflows by ${overflow}px at ${width}`).toBeLessThanOrEqual(1);
			for (const id of ['looks-use', 'looks-more', 'looks-tab-field', 'looks-tab-warm']) {
				const box = await page.getByTestId(id).boundingBox();
				expect(box, `${id} has a box`).not.toBeNull();
				expect(box!.height, `${id} height at ${width}`).toBeGreaterThanOrEqual(44);
			}
			await context.close();
		});
	}

	// Evidence shots (docs/evidence/2026-10-23-look-and-feel-picker.md). Writes
	// into the session scratch when present; a no-op elsewhere.
	test('captures evidence screenshots', async ({ browser }) => {
		const dir = process.env.KIROCREW_SCRATCH;
		test.skip(!dir, 'no scratch dir');
		for (const [name, width, height] of [['desktop', 1280, 900], ['phone', 390, 820]] as const) {
			const context = await browser.newContext({ viewport: { width, height } });
			await stub(context);
			const page = await context.newPage();
			await page.goto(`${BASE}/app/design-review?project=proj-a`);
			await expect(page.getByTestId('looks-picker')).toBeVisible();
			await page.waitForTimeout(400);
			await page.screenshot({ path: join(dir!, `looks-picker-${name}.png`), fullPage: name === 'desktop' });
			await context.close();
		}
	});
});
