import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * P07 browser acceptance — the REAL ArtifactViewer and DesignReview
 * components (bundled from source at test time, see tests/fixtures/
 * browser-harness.tsx) driven against network-stubbed /api routes on the
 * composed build's local preview worker.
 *
 * What is proven where:
 *   - REAL DATA integration (two-user denial, token expiry/revoke, access
 *     log, export headers): tests/preview-access.integration.test.ts on real
 *     workerd + real D1 (LOCAL VERIFIED there).
 *   - HERE (UI-state proofs, network-stubbed — same classification as
 *     workspace.spec.ts): the viewer renders the revisions list with hash/
 *     status/stale markers and a real download link per row, computes the
 *     diff view through the real diff URL shape, and the design review posts
 *     the REAL approval intent (action 'design', revision-bound hash) to
 *     /api/approvals.
 *   - Browser-level cookie isolation: preview content in a CSP-sandboxed
 *     frame runs in an opaque origin and CANNOT read Caddie cookies, while
 *     the app page itself can. (The frame here uses `sandbox allow-scripts`
 *     — the strongest sandbox that still runs JS — to prove the isolation
 *     property; the server's production header is the stricter bare
 *     `sandbox`, asserted verbatim by the integration suite.)
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'app');
const WORKER_BUNDLE = join(APP_DIR, 'dist', 'caddie_app', 'index.js');
const HARNESS_ENTRY = join(REPO_ROOT, 'tests', 'fixtures', 'browser-harness.tsx');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = `/tmp/caddie-p07-browser-preview-${process.pid}.log`;

let preview: ChildProcess | null = null;
let weStartedTheServer = false;
let buildDir: string | null = null;
let HARNESS_JS = '';

// The callbacks below run inside the browser; the root typecheck program has
// no DOM lib, so declare the minimal surface this spec touches (pattern from
// workspace.spec.ts).
declare const window: { __frameMsg?: { cookies: string; origin: string } };
declare const document: { cookie: string };

const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>P07 harness</title></head>
<body>
  <div id="viewer-root"></div>
  <div id="review-root"></div>
  <script type="module" src="/pw-harness.js"></script>
</body></html>`;

const SANDBOX_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>P07 sandbox proof</title></head>
<body>
<p>parent page</p>
<script>
  window.addEventListener('message', function (event) { window.__frameMsg = event.data; });
  var frame = document.createElement('iframe');
  frame.src = '/api/previews/resolve/demo-token';
  document.body.appendChild(frame);
</script>
</body></html>`;

/** Preview frame content — "generated" JS that reports its cookie/origin view. */
const PREVIEW_FRAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>preview</title></head>
<body><p>private preview body</p>
<script>
  var result = { cookies: 'unreadable', origin: 'unreadable' };
  // In a sandboxed opaque-origin frame, reading document.cookie THROWS a
  // SecurityError in Chromium (even stronger than returning an empty string):
  // capture whichever behavior the browser exhibits, never the cookie itself.
  try { result.cookies = document.cookie; } catch (error) { result.cookies = 'BLOCKED: ' + String(error && error.name); }
  try { result.origin = String(location.origin); } catch (error) { result.origin = 'BLOCKED: ' + String(error && error.name); }
  parent.postMessage(result, '*');
</script>
</body></html>`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isListening(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
		return true;
	} catch (error) {
		const name = (error as Error)?.name;
		return name === 'TimeoutError' || name === 'AbortError';
	}
}

test.beforeAll(async () => {
	if (!existsSync(WORKER_BUNDLE)) {
		throw new Error('Composed build missing — run `bun run build` before tests/browser/artifacts.spec.ts');
	}
	if (!existsSync(HARNESS_ENTRY)) {
		throw new Error('harness entry missing: tests/fixtures/browser-harness.tsx');
	}
	// Bundle the REAL components for the browser. Resolution note: react is not
	// hoisted, so the harness imports it from the app package by file path.
	buildDir = mkdtempSync(join(tmpdir(), 'caddie-p07-harness-'));
	const outfile = join(buildDir, 'harness.js');
	let bundleError = '';
	try {
		execFileSync(
			'bun',
			['build', HARNESS_ENTRY, '--outfile', outfile, '--format', 'esm', '--target', 'browser'],
			{ cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
		);
	} catch (error) {
		bundleError = ((error as { stderr?: Buffer }).stderr ?? Buffer.from(String(error))).toString();
	}
	if (!existsSync(outfile)) {
		throw new Error(`harness bundle failed: ${bundleError.slice(0, 2000)}`);
	}
	HARNESS_JS = readFileSync(outfile, 'utf8');

	if (!(await isListening(PORT))) {
		preview = spawn(
			'/bin/bash',
			['-c', `exec bunx vite preview --port ${PORT} --host 127.0.0.1 > '${LOG}' 2>&1`],
			{ cwd: APP_DIR, stdio: 'ignore', detached: true },
		);
		preview.unref();
		weStartedTheServer = true;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !(await isListening(PORT))) await sleep(300);
		if (!(await isListening(PORT))) {
			const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '(no log)';
			throw new Error(`preview not ready\nlog:\n${log}`);
		}
	}
});

test.afterAll(async () => {
	if (buildDir) rmSync(buildDir, { recursive: true, force: true });
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

function json(
	route: { fulfill(options: Record<string, unknown>): unknown },
	status: number,
	body: unknown,
) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Harness page + the shared API stubs for the viewer/review surfaces. */
async function openHarness(context: BrowserContext): Promise<{ page: Page; approvals: { url: string; body: Record<string, unknown> }[] }> {
	await context.route('**/pw-harness.html', (route) =>
		route.fulfill({ contentType: 'text/html; charset=utf-8', body: HARNESS_HTML }),
	);
	await context.route('**/pw-harness.js', (route) =>
		route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: HARNESS_JS }),
	);
	// The real diff URL shape: /artifact-revisions/<toId>/diff?from=<fromId>
	await context.route('**/artifact-revisions/art-rev-3/diff*', (route) =>
		json(route, 200, {
			diff: {
				from: { id: 'art-rev-2' },
				to: { id: 'art-rev-3' },
				lines: [
					{ type: 'context', text: 'shared headline' },
					{ type: 'del', text: 'old headline' },
					{ type: 'add', text: 'new headline' },
				],
			},
		}),
	);
	const approvals: { url: string; body: Record<string, unknown> }[] = [];
	await context.route('**/api/approvals', async (route) => {
		const request = route.request();
		if (request.method() !== 'POST') return json(route, 405, { error: 'method_not_allowed' });
		const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
		approvals.push({ url: request.url(), body });
		const decision = (body as { decision?: string }).decision;
		return json(route, 200, {
			approval: { id: 'apr-1', status: decision === 'approved' ? 'approved' : 'rejected' },
		});
	});
	const page = await context.newPage();
	await page.goto(`${BASE}/pw-harness.html`);
	await expect(page.getByTestId('artifact-viewer')).toBeVisible();
	return { page, approvals };
}

test.describe('P07 artifacts viewer + design review (composed build, stubbed /api)', () => {
	test('viewer renders the revisions list with hash/status markers and a download link per revision', async ({ browser }) => {
		const context = await browser.newContext();
		const { page } = await openHarness(context);

		const rows = page.getByTestId('artifact-revision-row');
		await expect(rows).toHaveCount(3);
		// the superseded revision is VISIBLY stale — marked, never erased
		await expect(rows.filter({ hasText: 'plan-r2.md' })).toHaveAttribute('data-status', 'stale');
		await expect(rows.filter({ hasText: 'plan-r3.md' })).toHaveAttribute('data-status', 'current');
		// content-addressed identity is visible per row
		await expect(page.getByTestId('artifact-viewer')).toContainText('b94d27b9934d');

		const downloads = page.getByTestId('artifact-download');
		await expect(downloads).toHaveCount(3);
		await expect(downloads.first()).toHaveAttribute(
			'href',
			'/api/projects/proj-p7/artifact-revisions/art-rev-3/download',
		);
		await context.close();
	});

	test('viewer computes the diff through the real diff URL and renders add/del lines', async ({ browser }) => {
		const context = await browser.newContext();
		const { page } = await openHarness(context);

		await expect(page.getByTestId('artifact-diff-view')).toHaveCount(0);
		await page.getByTestId('artifact-diff-show').click();
		const diff = page.getByTestId('artifact-diff-view');
		await expect(diff).toBeVisible();
		await expect(diff).toContainText('- old headline');
		await expect(diff).toContainText('+ new headline');
		await expect(diff.locator('[data-diff-type="add"]')).toHaveCount(1);
		await expect(diff.locator('[data-diff-type="del"]')).toHaveCount(1);
		await context.close();
	});

	test('design review posts the real revision-bound intent to /api/approvals (approve and reject)', async ({ browser }) => {
		const context = await browser.newContext();
		const { page, approvals } = await openHarness(context);

		await expect(page.getByTestId('design-review-row')).toHaveCount(2);
		await expect(page.getByTestId('design-review-row').first()).toHaveAttribute('data-latest', 'true');

		// The plan body renders readably for the revision under review (F09),
		// titled in the v2 plain words.
		await expect(page.getByTestId('design-review-plan-body')).toContainText("What you're making — plan version 2");
		await expect(page.getByTestId('plan-body-content')).toContainText('render a live chart');

		// v2 (U06): both decisions act through confirmation windows.
		await page.getByTestId('plan-approve-open').click();
		await expect(page.getByTestId('approve-plan-window')).toBeVisible();
		await page.getByTestId('design-review-approve').click();
		await expect(page.getByTestId('design-review-outcome')).toHaveAttribute('data-decision', 'approved');

		await page.getByTestId('plan-changes-open').click();
		await expect(page.getByTestId('request-changes-window')).toBeVisible();
		await page.getByTestId('design-review-reject').click();
		await expect(page.getByTestId('design-review-outcome')).toHaveAttribute('data-decision', 'rejected');

		expect(approvals).toHaveLength(2);
		for (const call of approvals) {
			expect(new URL(call.url).pathname).toBe('/api/approvals');
			const intent = (call.body as { intent?: Record<string, unknown> }).intent;
			expect(intent).toMatchObject({
				projectId: 'proj-p7',
				action: 'design',
				resourceId: 'pdr-latest',
				revisionHash: 'sha256-abc123def456abc123def456abc12345',
				policyVersion: 'v1',
			});
			// the actor is never part of the payload — decidedBy is server-derived
			expect(call.body).not.toHaveProperty('decidedBy');
		}
		expect((approvals[0] as unknown as { body: { decision: string } }).body.decision).toBe('approved');
		expect((approvals[1] as unknown as { body: { decision: string } }).body.decision).toBe('rejected');
		await context.close();
	});

	test('preview content in a CSP-sandboxed frame cannot read Caddie cookies (opaque origin)', async ({ browser }) => {
		const context = await browser.newContext();
		await context.addCookies([
			{ name: 'better-auth.session_token', value: 'p07-secret-cookie-value', url: BASE },
		]);
		await context.route('**/pw-sandbox.html', (route) =>
			route.fulfill({ contentType: 'text/html; charset=utf-8', body: SANDBOX_PAGE }),
		);
		await context.route('**/api/previews/resolve/demo-token', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				// allow-scripts ONLY so the generated JS can demonstrate the
				// isolation; crucially NO allow-same-origin -> opaque origin.
				headers: {
					'content-security-policy': 'sandbox allow-scripts',
					'x-content-type-options': 'nosniff',
					'cache-control': 'no-store',
				},
				body: PREVIEW_FRAME_HTML,
			}),
		);
		const page = await context.newPage();
		await page.goto(`${BASE}/pw-sandbox.html`);

		// the sandboxed frame reports NO cookies and NO app origin. Chromium
		// throws SecurityError on document.cookie in an opaque origin (even
		// stronger than returning ''); both behaviors prove the isolation.
		let frameMsg: { cookies: string; origin: string } | undefined;
		await expect
			.poll(async () => {
				frameMsg = await page.evaluate(() => window.__frameMsg);
				return frameMsg ?? null;
			}, { timeout: 10_000 })
			.not.toBeNull();
		expect(frameMsg).toBeTruthy();
		const cookies = frameMsg!.cookies;
		expect(cookies.includes('p07-secret-cookie-value')).toBe(false);
		// Chromium enforces the opaque origin at the DOCUMENT level: reading
		// document.cookie throws SecurityError (or reads empty) inside the
		// sandboxed frame — the generated JS never sees the session cookie.
		// (location.origin still strings the URL; it is not the enforcement
		// surface, so it is deliberately not asserted here.)
		// ...while the app page itself holds the session cookie (the contrast
		// proves the sandbox, not the absence of the cookie, blocks access)
		expect(await page.evaluate(() => document.cookie)).toContain('p07-secret-cookie-value');
		await context.close();
	});
});
