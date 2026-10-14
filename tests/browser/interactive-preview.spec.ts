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
