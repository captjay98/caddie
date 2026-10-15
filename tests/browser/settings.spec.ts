import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Structural mirror of the MemoryFact payload the P14 REST surface returns
 * (apps/app/src/client/memory/Memory.tsx). Kept local on purpose: the root
 * tsconfig project (bun types, no DOM lib) must never pull React component
 * sources in via type imports.
 */
interface MemoryFact {
	id: string;
	userId: string;
	projectId: string | null;
	kind: 'preference' | 'fact' | 'correction';
	content: string;
	status: 'proposed' | 'confirmed' | 'retracted';
	sourceRunId: string | null;
	correctsId: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * P14 browser spec — the settings UI (Settings + Memory + Search) of the REAL
 * components, rendered by a test-only harness page (tests/fixtures/
 * settings-harness) that is bundled with Bun.build from the actual component
 * sources and served by this spec's own local HTTP server with the real
 * workspace stylesheet. All /api traffic is stubbed at the network layer
 * (Playwright route interception), mirroring the payload shapes of the P14
 * REST surface.
 *
 * What is proven where (same split as the P06 workspace.spec):
 *   - UI-STATE PROOFS (this spec, /api stubbed): settings render with the
 *     profile editor, honest integration health and the enabled-stack list;
 *     an interrupted save preserves the user's draft and shows the error;
 *     memory confirm/retract flows update the UI and the retracted entry
 *     moves to history; search renders exactly the (stubbed) server result
 *     set, so inaccessible content never appears.
 *   - REAL API BEHAVIOR (P14 integration suites): profile validation,
 *     cross-user isolation, memory correction/retraction semantics, and the
 *     search isolation matrix run against real workerd + D1 in
 *     tests/memory.integration.test.ts and tests/search-isolation.test.ts.
 *
 * The composed-build navigation wiring (app.ts / routes.tsx) is applied by
 * the integration lead; this spec deliberately does not depend on it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'settings-harness');
const TOKENS_CSS = join(REPO_ROOT, 'packages', 'ui', 'src', 'tokens.css');
const WORKSPACE_CSS = join(REPO_ROOT, 'apps', 'app', 'src', 'client', 'workspace.css');
const PORT = 4189;
const BASE = `http://127.0.0.1:${PORT}`;

// --- stubbed server state (mirrors the real P14 payload shapes) -----------------

let profileSaved = false;
let profileSaveShouldFail = false;
let profileBodies: Record<string, unknown>[] = [];
let facts: MemoryFact[] = [];

const INITIAL_FACTS: MemoryFact[] = [
	{
		id: 'mem_confirmed_1',
		userId: 'user-1',
		projectId: null,
		kind: 'preference' as const,
		content: 'Prefers concise status reports',
		status: 'confirmed' as const,
		sourceRunId: null,
		correctsId: null,
		createdAt: '2026-10-05T09:00:00.000Z',
		updatedAt: '2026-10-05T09:00:00.000Z',
	},
	{
		id: 'mem_proposed_1',
		userId: 'user-1',
		projectId: 'proj-1',
		kind: 'fact' as const,
		content: 'Agent suggested: always bump patch version after fixes',
		status: 'proposed' as const,
		sourceRunId: 'run-1',
		correctsId: null,
		createdAt: '2026-10-05T09:05:00.000Z',
		updatedAt: '2026-10-05T09:05:00.000Z',
	},
];

const health = {
	auth: { providers: { google: false, github: false } },
	sandbox: { configured: false, missing: ['CONTREE_BASE_URL', 'CONTREE_API_TOKEN', 'CONTREE_PROJECT_ID'] },
};

const searchResults: Record<string, { total: number; sections: Record<string, { items: unknown[] }> }> = {
	alpha: {
		total: 1,
		sections: {
			projects: {
				items: [
					{
						type: 'project',
						id: 'proj-1',
						projectId: 'proj-1',
						title: 'Alpha Rocket',
						snippet: 'alpha telemetry stack',
					},
				],
			},
			planDocs: { items: [] },
			tasks: { items: [] },
			memory: { items: [] },
		},
	},
	roadmap: {
		total: 0,
		sections: {
			projects: { items: [] },
			planDocs: { items: [] },
			tasks: { items: [] },
			memory: { items: [] },
		},
	},
};

function json(body: unknown, status = 200): Promise<Response> {
	return Promise.resolve(new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	}));
}

async function stubApi(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === '/api/auth/get-session') return json({ user: { id: 'user-1', email: 'builder@example.com' } });
	if (path === '/api/auth/list-accounts') return json([{ providerId: 'google', accountId: 'g-1' }]);
	if (path === '/api/profile' && request.method === 'GET') {
		return json({
			profile: profileSaved
				? {
						userId: 'user-1',
						country: 'CL',
						timezone: 'America/Santiago',
						weeklyHours: 12,
						experienceLevel: 'intermediate',
						stackIds: ['react-hono'],
						freeTextInterests: ['Rust'],
					}
				: null,
		});
	}
	if (path === '/api/profile' && request.method === 'PUT') {
		if (profileSaveShouldFail) {
			return json({ error: 'invalid_input', message: 'timezone must be a valid IANA time zone name' }, 400);
		}
		profileSaved = true;
		const body = (await request.json()) as { country?: string };
		profileBodies.push(body as Record<string, unknown>);
		if (body.country && body.country !== 'CL') {
			return json({ error: 'invalid_input', message: 'unexpected country' }, 400);
		}
		return json({ profile: { userId: 'user-1', country: 'CL' } });
	}
	if (path === '/api/memory' && request.method === 'GET') {
		return json({ facts });
	}
	if (path.startsWith('/api/memory/') && request.method === 'POST') {
		const id = path.split('/')[3];
		const fact = facts.find((f) => f.id === id);
		if (!fact) return json({ error: 'memory_not_found' }, 404);
		if (path.endsWith('/confirm')) fact.status = 'confirmed';
		if (path.endsWith('/retract')) fact.status = 'retracted';
		if (path.endsWith('/correct')) {
			const body = (await request.json()) as { content?: string };
			// correction: new confirmed version, old retracted (history retained)
			fact.status = 'retracted';
			facts.unshift({
				id: `mem_corrected_${Date.now()}`,
				userId: 'user-1',
				projectId: fact.projectId,
				kind: 'correction',
				content: body.content ?? '',
				status: 'confirmed',
				sourceRunId: null,
				correctsId: fact.id,
				createdAt: '2026-10-05T10:00:00.000Z',
				updatedAt: '2026-10-05T10:00:00.000Z',
			});
		}
		return json({ fact });
	}
	if (path === '/api/search') {
		const q = url.searchParams.get('q') ?? '';
		return json(searchResults[q] ?? { total: 0, sections: { projects: { items: [] }, planDocs: { items: [] }, tasks: { items: [] }, memory: { items: [] } } });
	}
	if (path === '/api/integrations/health') return json(health);
	if (path === '/api/stacks') {
		return json({
			stacks: [
				{ id: 'react-hono', status: 'enabled', note: 'proving in the forge' },
				{ id: 'tanstack-start', status: 'planned' },
				{ id: 'laravel-inertia', status: 'planned' },
				{ id: 'fastapi-react', status: 'planned' },
				{ id: 'flutter', status: 'planned' },
			],
		});
	}
	return json({ error: 'not_found' }, 404);
}

// --- local static server (harness page + real stylesheets) ------------------------

let server: Server | null = null;
let buildDir: string | null = null;
let linkCreated = false;

async function startHarness(): Promise<void> {
	// Bun resolves bare imports (react, @tanstack/react-query) by walking up
	// from the entry file — tests/fixtures/... never reaches apps/app's
	// node_modules, where the app's dependencies live. Link them in for the
	// duration of the run (node_modules is gitignored, so the repo stays
	// clean; no lockfile or config is touched).
	const link = join(HARNESS_DIR, 'node_modules');
	const target = join(REPO_ROOT, 'apps', 'app', 'node_modules');
	rmSync(link, { force: true, recursive: true });
	symlinkSync(target, link, 'dir');
	linkCreated = true;

	// Bundle the REAL component sources with the Bun bundler (invoked as a CLI
	// subprocess because Playwright executes specs under Node; no repo build
	// config is touched — the harness lives under tests/fixtures/).
	buildDir = mkdtempSync(join(tmpdir(), 'p14-harness-'));
	execFileSync('bun', [
		'build',
		join(HARNESS_DIR, 'main.tsx'),
		'--outdir',
		buildDir,
		'--target',
		'browser',
		'--format',
		'esm',
		'--define',
		'process.env.NODE_ENV="development"',
	], { cwd: REPO_ROOT, stdio: 'pipe' });
	if (!existsSync(join(buildDir, 'main.js'))) {
		throw new Error('harness bundle did not produce main.js');
	}

	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', BASE);
		const send = (body: string, type: string) => {
			res.writeHead(200, { 'content-type': type });
			res.end(body);
		};
		if (url.pathname === '/' || url.pathname === '/index.html') {
			send(readFileSync(join(HARNESS_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
			return;
		}
		if (url.pathname === '/main.js') {
			send(readFileSync(join(buildDir!, 'main.js'), 'utf8'), 'text/javascript; charset=utf-8');
			return;
		}
		if (url.pathname === '/tokens.css') {
			send(readFileSync(TOKENS_CSS, 'utf8'), 'text/css; charset=utf-8');
			return;
		}
		if (url.pathname === '/workspace.css') {
			send(readFileSync(WORKSPACE_CSS, 'utf8'), 'text/css; charset=utf-8');
			return;
		}
		// SPA fallback: the harness router owns every other path (/search, /settings).
		send(readFileSync(join(HARNESS_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
	});
	await new Promise<void>((resolve, reject) => {
		server!.once('error', reject);
		server!.listen(PORT, '127.0.0.1', () => resolve());
	});
}

test.beforeAll(async () => {
	if (!existsSync(join(HARNESS_DIR, 'main.tsx'))) {
		throw new Error('harness entry missing: tests/fixtures/settings-harness/main.tsx');
	}
	await startHarness();
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	if (buildDir) rmSync(buildDir, { recursive: true, force: true });
	if (linkCreated) rmSync(join(HARNESS_DIR, 'node_modules'), { force: true, recursive: true });
});

// --- the specs ---------------------------------------------------------------------

test.describe('P14 settings UI (real components, /api stubbed at the network layer)', () => {
	test.beforeEach(() => {
		// per-test isolation: fresh stubbed server state
		profileSaved = false;
		profileSaveShouldFail = false;
		profileBodies = [];
		facts = INITIAL_FACTS.map((fact) => ({ ...fact }));
	});

	test.beforeEach(async ({ page }) => {
		await page.route('**/api/**', async (route) => {
			const pwRequest = route.request();
			const method = pwRequest.method();
			const post = method === 'GET' || method === 'HEAD' ? undefined : (pwRequest.postData() ?? undefined);
			const request = new Request(pwRequest.url(), {
				method,
				...(post !== undefined
					? { body: post, headers: { 'content-type': 'application/json' } }
					: {}),
			});
			const response = await stubApi(request);
			await route.fulfill({
				status: response.status,
				contentType: 'application/json',
				body: await response.text(),
			});
		});
	});

	test('settings render: one header, grouped rail, profile choices, plain build tools, honest accounts', async ({ page }) => {
		await page.goto(`${BASE}/`);
		await expect(page.getByTestId('settings-screen')).toBeVisible();

		// One page header: label + the section's title (no repeated section name inside).
		await expect(page.getByTestId('settings-title')).toHaveText('Profile');
		await expect(page.getByTestId('settings-screen').locator('h1')).toHaveCount(1);
		await expect(page.locator('.settings-content .card-surface')).toHaveCount(0);
		// The rail is grouped: You / Caddie / Account.
		for (const group of ['You', 'Caddie', 'Account']) {
			await expect(page.getByTestId('settings-tabs').getByRole('group', { name: group })).toBeVisible();
		}

		// Profile uses the same choices as onboarding (all optional).
		await expect(page.getByTestId('profile-editor')).toBeVisible();
		await expect(page.getByTestId('profile-country')).toBeVisible();
		await expect(page.getByTestId('profile-timezone')).toBeVisible();
		await expect(page.getByTestId('profile-experience').getByRole('radio', { name: 'Experienced' })).toBeVisible();
		await expect(page.getByTestId('profile-format').getByRole('radio', { name: 'In person' })).toBeVisible();
		await expect(page.getByTestId('profile-weekly-hours').getByRole('radio', { name: '20+' })).toBeVisible();

		// Build tools: plain names; "Available" only where the server says enabled.
		await page.getByTestId('settings-tab-tools').click();
		await expect(page.getByTestId('settings-title')).toHaveText('Build tools');
		await expect(page.getByTestId('stack-react-hono')).toContainText('React + Hono');
		await expect(page.getByTestId('stack-react-hono')).toContainText('Available');
		await expect(page.getByTestId('stack-tanstack-start')).toContainText('Coming later');
		await expect(page.getByTestId('stack-flutter')).toContainText('Coming later');

		// Connected accounts: the user's own accounts first…
		await page.getByTestId('settings-tab-accounts').click();
		await expect(page.getByTestId('account-google')).toContainText('Signed in as builder@example.com');
		await expect(page.getByTestId('account-google')).toContainText('Connected');
		await expect(page.getByTestId('service-status')).toContainText('Needs setup');
		// …and the server's configuration stays honest in the details (names, never values).
		await expect(page.getByTestId('integration-auth-google')).toContainText('not configured');
		await expect(page.getByTestId('integration-auth-github')).toContainText('not configured');
		await expect(page.getByTestId('integration-sandbox')).toContainText('not configured');
		await expect(page.getByTestId('integration-sandbox')).toContainText('CONTREE_BASE_URL');
		// no fake buttons in the health details (labels only, no action styled as working)
		expect(await page.getByTestId('integrations-health').getByRole('button').count()).toBe(0);
	});

	test('interests: the shared picker and skills save together, without touching the profile fields', async ({ page }) => {
		await page.goto(`${BASE}/?tab=interests`);
		await expect(page.getByTestId('settings-title')).toHaveText('Interests');
		const picker = page.getByTestId('interests-picker');
		await picker.getByRole('button', { name: 'Health', exact: true }).click();
		await picker.getByTestId('interests-picker-search').fill('Race telemetry');
		await picker.getByTestId('interests-picker-add').click();
		await page.getByTestId('skills-field-input').fill('TypeScript');
		await page.getByTestId('skills-field-input').press('Enter');
		await page.getByTestId('interests-save').click();
		await expect(page.getByTestId('interests-saved')).toBeVisible();
		expect(profileBodies).toEqual([{ freeTextInterests: ['Health', 'Race telemetry'], skills: ['TypeScript'] }]);
	});

	test('memory: confirm a proposal, retract a fact, and the retracted entry moves to history', async ({ page }) => {
		await page.goto(`${BASE}/?tab=knows`);
		await expect(page.getByTestId('memory-panel')).toBeVisible();

		// both seeded facts are visible with their status
		await expect(page.getByTestId('memory-fact')).toHaveCount(2);
		await expect(page.getByText('Agent suggested: always bump patch version after fixes')).toBeVisible();

		// confirm the proposed fact
		await page.getByTestId('memory-confirm-mem_proposed_1').click();
		await expect(page.getByTestId('memory-confirm-mem_proposed_1')).toHaveCount(0); // no longer proposed

		// retract the confirmed fact
		await page.getByTestId('memory-retract-mem_confirmed_1').click();
		await expect(page.getByTestId('memory-fact')).toHaveCount(1);
		// the retracted entry is retained visibly as history, never deleted silently
		await expect(page.getByTestId('memory-history')).toBeVisible();
		await expect(page.getByTestId('memory-retracted')).toHaveCount(1);
		await expect(page.getByTestId('memory-retracted')).toContainText('Prefers concise status reports');
	});

	test('memory correction: saving a correction replaces the active wording and retains the old version', async ({ page }) => {
		await page.goto(`${BASE}/?tab=knows`);
		await page.getByTestId('memory-correct-mem_proposed_1').click();
		await page.getByTestId('memory-correct-input-mem_proposed_1').fill('Bump minor version after fixes');
		await page.getByTestId('memory-correct-save-mem_proposed_1').click();

		// the corrected wording becomes the active fact
		await expect(page.getByText('Bump minor version after fixes').first()).toBeVisible();
		// the old version moved to history
		await expect(page.getByTestId('memory-history')).toBeVisible();
		await expect(page.getByTestId('memory-retracted')).toHaveCount(1);
	});

	test('search isolation is visible: only accessible content is rendered, nothing leaks', async ({ page }) => {
		await page.goto(`${BASE}/search`);
		await page.getByTestId('search-input').fill('alpha');
		await page.getByTestId('search-submit').click();

		await expect(page.getByTestId('search-results')).toBeVisible();
		// exactly the accessible hit is rendered
		const hits = page.getByTestId('search-hit');
		await expect(hits).toHaveCount(1);
		await expect(hits.first()).toContainText('Alpha Rocket');
		// the inaccessible project (which also matches "alpha" server-side in
		// the real system) is nowhere in the DOM
		const body = await page.locator('body').innerText();
		expect(body).not.toContain('Alpha Secret');

		// a query with no accessible matches shows the honest empty state
		await page.getByTestId('search-input').fill('roadmap');
		await page.getByTestId('search-submit').click();
		await expect(page.getByTestId('search-empty')).toBeVisible();
		await expect(page.getByTestId('search-results')).toHaveCount(0);
	});

	test('interrupted settings save preserves the draft and shows the error', async ({ page }) => {
		await page.goto(`${BASE}/`);
		await page.getByTestId('profile-country').fill('Chile');
		await page.getByTestId('profile-timezone').fill('America/Santiago');
		await page.getByTestId('profile-weekly-hours').getByRole('radio', { name: '10–20' }).click();

		// first save fails server-side
		profileSaveShouldFail = true;
		await page.getByTestId('profile-save').click();
		await expect(page.getByTestId('profile-error')).toContainText('IANA');

		// the draft is preserved after the failed save
		await expect(page.getByTestId('profile-country')).toHaveValue('Chile');
		await expect(page.getByTestId('profile-timezone')).toHaveValue('America/Santiago');
		await expect(page.getByTestId('profile-weekly-hours')).toHaveAttribute('data-value', '10to20');

		// second save succeeds — and carries ONLY the profile section's fields
		profileSaveShouldFail = false;
		await page.getByTestId('profile-save').click();
		await expect(page.getByTestId('profile-saved')).toBeVisible();
		expect(profileSaved).toBe(true);
		expect(profileBodies.at(-1)).toEqual({
			country: 'CL',
			timezone: 'America/Santiago',
			experienceLevel: null,
			formatPreference: null,
			weeklyHours: 15,
		});
	});

	test('a country that is not on the list is refused before saving, and nothing is sent', async ({ page }) => {
		await page.goto(`${BASE}/`);
		await page.getByTestId('profile-country').fill('Atlantis');
		await page.getByTestId('profile-save').click();
		await expect(page.getByTestId('profile-error')).toContainText('Choose your country from the list');
		expect(profileBodies).toHaveLength(0);
	});
});
