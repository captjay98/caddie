import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { playwrightBrowserCheck, type BrowserCheckInput } from '../../scripts/brief-run/browser-check.ts';
import type { RecordTarget } from '../../scripts/brief-run/app-users.ts';
import { previewDocument } from '../../apps/app/src/shared/preview-frame.ts';
import { notesAppHtml } from '../fixtures/brief-run-notes-app.ts';

/**
 * LANE 8d ITEM 3 — the browser PROOF of the real playwrightBrowserCheck.
 *
 * The check launches its OWN Chromium and opens the standalone preview page.
 * Here that page is the REAL apps/app InteractivePreview (bundled from source,
 * like tests/browser/interactive-preview.spec.ts) served from a node http
 * server that also stubs the Caddie routes it calls — document, seed, the /app
 * relay and /workflow/test-inbox — standing in for the Worker Loader runtime.
 * Inside the opaque frame runs the hand-written fixture app (sign-in + a
 * hash-routed #/notes screen), whose /api calls are relayed through the parent's
 * in-memory cookie jar, so a FRAME-only reload keeps the app user signed in.
 *
 * Classification: LOCAL VERIFIED against a simulated app in the REAL preview
 * frame + bridge; NOT proven against a real generated app (no live build here).
 *
 * The four seam cases + the real SPA page case:
 *   (a) correct app         → pass;
 *   (b) GET /api/notes leaks every user's notes → B sees A's note → fail;
 *   (c) the form never saves → fail, with the diagnostic noting the API saved;
 *   (d) a whole-page reload would sign the user out, but the check passes
 *       because it reloads only the frame;
 *   (e) the REAL /app/preview SPA page from the built app on 4173 shows the
 *       caddie-interactive-preview frame with the app inside.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = join(ROOT, 'tests/fixtures/interactive-preview-harness.tsx');
const PROJECT = 'project-one';
const OUTPUT = 'output-one';
const PREVIEW_PREFIX = `/api/projects/${PROJECT}/workflow/preview/${OUTPUT}`;

// Each seam run launches its own Chromium and drives TWO contexts end to end
// (sign in, create, reload, re-check) — well over the 60 s default.
test.setTimeout(180_000);

const TARGET: RecordTarget = {
	table: { name: 'notes', module: 'app', plain: 'Each note', owner: 'person', fields: [{ name: 'body', type: 'text', references: null }] },
	createRoute: {
		id: 'notes.create', module: 'app', feature: 'notes', op: 'create', method: 'POST',
		path: '/api/notes', table: 'notes', plain: 'Add a note', access: 'person',
		request: [{ name: 'body', type: 'text', example: 'Buy milk' }], response: ['id', 'body'],
	},
	screen: { id: 'notes', module: 'app', path: '#/notes', plain: 'Your notes', shows: ['notes'] },
	markerField: 'body',
};

// --- a storageState file the check loads for each app user's context ---------
let scratch: string;
let storagePath: string;
let bundle = '';

test.beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'caddie-brief-run-browser-'));
	storagePath = join(scratch, 'owner.json');
	// The owner's one Caddie session. Empty cookies is fine: the fixture server
	// does not gate the Caddie routes; the APP session lives in the frame's jar.
	writeFileSync(storagePath, JSON.stringify({ cookies: [], origins: [] }));
	const out = join(scratch, 'harness.js');
	execFileSync('bun', ['build', HARNESS, '--outfile', out, '--format', 'esm', '--target', 'browser'], { cwd: ROOT, stdio: 'pipe' });
	bundle = readFileSync(out, 'utf8');
});
test.afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// --- the fixture server: the preview page + the Caddie routes ----------------

interface ServerOptions {
	/** The app client HTML served inside the frame (default: the correct app). */
	appHtml?: string;
	/** GET /api/notes returns EVERY user's notes (broken isolation). */
	leaky?: boolean;
}

interface AppState {
	codes: Array<{ to: string; code: string; createdAt: string }>;
	/** app session cookie value → user email */
	sessions: Map<string, string>;
	/** user email → their notes */
	notes: Map<string, Array<{ body: string }>>;
	nextCode: number;
	nextSid: number;
}

function startFixtureServer(opts: ServerOptions = {}): Promise<{ server: Server; base: string; state: AppState }> {
	const appHtml = opts.appHtml ?? notesAppHtml();
	const state: AppState = { codes: [], sessions: new Map(), notes: new Map(), nextCode: 100000, nextSid: 1 };

	const readBody = (request: IncomingMessage): Promise<string> =>
		new Promise((resolve) => {
			let data = '';
			request.on('data', (chunk) => (data += chunk));
			request.on('end', () => resolve(data));
		});

	/** The app's own server — answers a RELAYED /api request from the frame. */
	function appServer(method: string, path: string, headers: Array<[string, string]>, body: string | null): { status: number; headers: Array<[string, string]>; body: string } {
		const cookieHeader = headers.find(([n]) => n.toLowerCase() === 'cookie')?.[1] ?? '';
		const sid = /(?:^|;\s*)app_sid=([^;]+)/.exec(cookieHeader)?.[1] ?? null;
		const user = sid ? state.sessions.get(sid) ?? null : null;
		const json = (status: number, value: unknown, extra: Array<[string, string]> = []) => ({
			status,
			headers: [['content-type', 'application/json'], ...extra] as Array<[string, string]>,
			body: Buffer.from(JSON.stringify(value)).toString('base64'),
		});
		const payload = body ? (JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as Record<string, string>) : {};

		if (method === 'POST' && path === '/api/auth/code') {
			const email = String(payload.email ?? '').toLowerCase();
			const code = String(state.nextCode++);
			state.codes.push({ to: email, code, createdAt: new Date().toISOString() });
			return json(200, { sent: true });
		}
		if (method === 'POST' && path === '/api/auth/sign-in') {
			const email = String(payload.email ?? '').toLowerCase();
			const code = String(payload.code ?? '');
			const match = state.codes.some((m) => m.to === email && m.code === code);
			if (!match) return json(401, { error: 'bad code' });
			const newSid = `s${state.nextSid++}`;
			state.sessions.set(newSid, email);
			if (!state.notes.has(email)) state.notes.set(email, []);
			return json(200, { user: { email } }, [['set-cookie', `app_sid=${newSid}; Path=/; HttpOnly`]]);
		}
		if (method === 'GET' && path === '/api/auth/session') {
			return user ? json(200, { user: { email: user } }) : json(200, { user: null });
		}
		if (path === '/api/notes') {
			if (!user) return json(401, { error: 'sign in' });
			if (method === 'GET') {
				const notes = opts.leaky ? [...state.notes.values()].flat() : state.notes.get(user) ?? [];
				return json(200, { notes });
			}
			if (method === 'POST') {
				const list = state.notes.get(user) ?? [];
				list.push({ body: String(payload.body ?? '') });
				state.notes.set(user, list);
				return json(201, { id: list.length });
			}
		}
		return json(404, { error: 'not_found' });
	}

	const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		const path = url.pathname;
		const send = (status: number, contentType: string, body: string) => {
			response.statusCode = status;
			response.setHeader('content-type', contentType);
			response.end(body);
		};

		// The bundled harness script.
		if (path === '/harness.js') return send(200, 'text/javascript', bundle);

		// The test inbox, read DIRECTLY by the check over the owner's session.
		if (path === `/api/projects/${PROJECT}/workflow/test-inbox`) {
			return send(200, 'application/json', JSON.stringify({ messages: state.codes, emails: [] }));
		}

		// The frame's saved data goes up; the frame document comes back over http.
		if (path === `${PREVIEW_PREFIX}/seed`) {
			await readBody(request);
			return send(200, 'application/json', JSON.stringify({ seedRef: 'seed-ref' }));
		}
		if (path === `${PREVIEW_PREFIX}/document`) {
			const nonce = url.searchParams.get('nonce') ?? '';
			return send(200, 'text/html', previewDocument(appHtml, nonce, {}, true, 'web'));
		}
		if (path === `${PREVIEW_PREFIX}/metadata`) {
			return send(200, 'application/json', JSON.stringify({ outputId: OUTPUT, kind: 'web', hasServer: true }));
		}
		// The relay: the frame's /api calls arrive here as a parcel.
		if (path === `${PREVIEW_PREFIX}/app`) {
			const raw = await readBody(request);
			const parcel = JSON.parse(raw) as { method: string; path: string; headers: Array<[string, string]>; body: string | null };
			const answer = appServer(parcel.method, parcel.path, parcel.headers, parcel.body);
			return send(200, 'application/json', JSON.stringify(answer));
		}
		if (path === `/api/projects/${PROJECT}/workflow/preview-data/reset`) {
			return send(200, 'application/json', '{"reset":true}');
		}

		// Anything else: the preview page (the harness mounts InteractivePreview).
		return send(200, 'text/html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>');
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('fixture server failed to start');
			resolve({ server, base: `http://127.0.0.1:${address.port}`, state });
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** The seam input for a fixture server. The preview page is the harness page. */
function inputFor(base: string, overrides: Partial<BrowserCheckInput> = {}): BrowserCheckInput {
	return {
		base,
		previewPageUrl: `${base}/preview?workflow&backend`,
		ownerStoragePath: storagePath,
		ownerCookie: 'caddie.session=owner',
		projectId: PROJECT,
		target: TARGET,
		markerA: `marker-A-${Date.now()}`,
		markerB: `marker-B-${Date.now()}`,
		timeoutMs: 60_000,
		...overrides,
	};
}

// --- (a) the correct app passes ---------------------------------------------

test('(a) a correct per-user app passes: A persists, B renders, B is isolated', async () => {
	const { server, base } = await startFixtureServer();
	try {
		const input = inputFor(base);
		const result = await playwrightBrowserCheck(input);
		expect(result.verdict).toBe('pass');
		expect(result.aPersisted).toBe(true);
		expect(result.bRendered).toBe(true);
		expect(result.bIsolated).toBe(true);
	} finally {
		await closeServer(server);
	}
});

// --- (b) a leaky app fails isolation ----------------------------------------

test("(b) an app that shows A's note to B fails with the isolation reason", async () => {
	const { server, base } = await startFixtureServer({ leaky: true });
	try {
		const result = await playwrightBrowserCheck(inputFor(base));
		expect(result.verdict).toBe('fail');
		expect(result.bIsolated).toBe(false);
		expect(result.reason).toMatch(/isolation/i);
	} finally {
		await closeServer(server);
	}
});

// --- (c) a form that never saves fails, with the diagnostic -----------------

test('(c) a form that never saves fails with a plain reason, and the diagnostic is noted', async () => {
	const { server, base } = await startFixtureServer({ appHtml: notesAppHtml({ neverSaves: true }) });
	try {
		const result = await playwrightBrowserCheck(inputFor(base));
		expect(result.verdict).toBe('fail');
		expect(result.aPersisted).toBe(false);
		// The plain reason names what was tried and the diagnostic outcome. The
		// API create DID save (only the form is broken), so the reason says so.
		expect(result.reason).toMatch(/the record never appeared/);
		expect(result.reason).toMatch(/diagnostic API create/);
		expect(result.reason).toMatch(/the create FORM is the fault/);
	} finally {
		await closeServer(server);
	}
});

// --- (d) a whole-page reload would sign out; the frame-only reload keeps in --

test('(d) the check reloads the FRAME only, so the app user stays signed in and still passes', async () => {
	// This is the heart of the design: the parent keeps the app's cookies in an
	// in-memory jar, so page.reload() would drop them and sign the app user out.
	// The fixture server proves it: it NEVER sees a document re-request without a
	// surviving app session. If the check passes, it reloaded only the frame.
	const { server, base, state } = await startFixtureServer();
	try {
		const result = await playwrightBrowserCheck(inputFor(base));
		expect(result.verdict).toBe('pass');
		// A and B each have their own app session (two contexts) — never shared.
		expect(state.sessions.size).toBe(2);
		expect(result.aPersisted).toBe(true);
	} finally {
		await closeServer(server);
	}
});

// --- (e) the REAL SPA preview page on 4173 shows the frame with the app ------

test('(e) the real /app/preview SPA page shows the caddie-interactive-preview frame with the app inside', async ({ page, context }) => {
	// The built app serves /app/preview; here the /api routes are context.route
	// stubs (like tests/browser/workspace.spec.ts). The workspace chrome needs
	// an authenticated session + Home scope to render; then PreviewPage embeds
	// the app in iframe[name="caddie-interactive-preview"].
	const json = (route: import('@playwright/test').Route, status: number, body: unknown) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
	const HOME = { id: 'home-1', workspaceId: 'ws-1', name: 'Home', kind: 'home', status: 'active', description: null, contestId: null, contestUrl: null, createdAt: '2026-10-04T10:00:00.000Z', updatedAt: '2026-10-04T10:00:00.000Z' };
	const PROJ = { ...HOME, id: PROJECT, name: 'Notes app', kind: 'standard' };

	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Test', email: 't@caddie.test' } }),
	);
	await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
	await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
	await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
	await context.route('**/api/brief', (route) => json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: '2026-10-04T10:00:00.000Z' }));
	await context.route('**/api/projects', (route) =>
		route.request().method() === 'GET' ? json(route, 200, { projects: [HOME, PROJ] }) : json(route, 405, { error: 'method_not_allowed' }),
	);

	const appHtml = notesAppHtml();
	await context.route(`**${PREVIEW_PREFIX}/metadata`, (route) => json(route, 200, { outputId: OUTPUT, kind: 'web', hasServer: true }));
	await context.route(`**${PREVIEW_PREFIX}/seed`, (route) => json(route, 200, { seedRef: 'seed-ref' }));
	await context.route(`**${PREVIEW_PREFIX}/document*`, (route) => {
		const nonce = new URL(route.request().url()).searchParams.get('nonce') ?? '';
		return route.fulfill({ contentType: 'text/html', body: previewDocument(appHtml, nonce, {}, true, 'web') });
	});
	await context.route(`**${PREVIEW_PREFIX}/app`, (route) => {
		// Signed out: /api/auth/session → no user, so the app shows its sign-in.
		const parcel = route.request().postDataJSON() as { method: string; path: string };
		const value = parcel.path === '/api/auth/session' ? { user: null } : { notes: [] };
		return json(route, 200, { status: 200, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify(value)).toString('base64') });
	});
	// Any other project child route: an honest empty, so no pane throws a 401.
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.includes('/workflow/preview/')) return route.fallback();
		return json(route, 200, {});
	});

	await page.goto(`/app/preview?project=${PROJECT}&preview=${OUTPUT}&source=workflow`);
	await expect(page.getByTestId('preview-page')).toBeVisible({ timeout: 15_000 });
	await expect(page.locator('iframe[name="caddie-interactive-preview"]')).toBeVisible();
	// The app inside the frame reaches its sign-in screen through the relay.
	await expect(page.frameLocator('iframe[name="caddie-interactive-preview"]').getByRole('button', { name: 'Email me a code' })).toBeVisible({ timeout: 15_000 });
});
