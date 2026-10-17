import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AppRoute } from '@caddie/contracts';
import {
	AppHostError,
	type AppHostBinding,
	type AppHostDeployInput,
	type AppHostFile,
} from '../apps/app/src/server/app-host.ts';
import { CloudflareAppHost, readCloudflareConfig } from '../apps/app/src/server/adapters/cloudflare.ts';
import { CloudflareStub } from './fixtures/cloudflare-stub.ts';
import { freePort } from './fixtures/controls-harness.ts';

/**
 * The Cloudflare app-host adapter (apps/app/src/server/adapters/cloudflare.ts)
 * driven end to end through the AppHost port against a local stub of the
 * Cloudflare REST API v4 (tests/fixtures/cloudflare-stub.ts) bound to
 * 127.0.0.1.
 *
 * Classification: LOCAL VERIFIED against the real adapter talking HTTP to the
 * stub. Cloudflare itself is SIMULATED — nothing here is evidence about real
 * api.cloudflare.com (that stays BLOCKED on owner provisioning); it proves the
 * adapter builds the documented request shapes, maps responses to the port's
 * types, and classifies every error the port enumerates.
 */

const TOKEN = 'cf-token-that-must-never-leak';
const ACCOUNT = 'acct-local';
const NAMESPACE = 'caddie-apps';
const KV_ID = 'routes-kv-local';
const ZONE = 'apps-zone-local';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const INDEX_HTML: AppHostFile = { path: '/index.html', bytes: text('<!doctype html><title>app</title>'), contentType: 'text/html' };
const MAIN_JS: AppHostFile = { path: '/main.js', bytes: text('console.log(1)'), contentType: 'application/javascript' };

function deployInput(overrides: Partial<AppHostDeployInput> = {}): AppHostDeployInput {
	return {
		script: 'app-abc',
		assets: [INDEX_HTML, MAIN_JS],
		serverModule: null,
		bindings: [],
		tags: ['project:p1', 'owner:u1'],
		compatibilityDate: '2026-10-17',
		compatibilityFlags: ['nodejs_compat'],
		...overrides,
	};
}

let stub: CloudflareStub;
let host: CloudflareAppHost;

async function refusal(task: Promise<unknown>): Promise<AppHostError> {
	try {
		await task;
	} catch (error) {
		if (error instanceof AppHostError) return error;
		throw new Error(`expected an AppHostError, got ${String(error)}`);
	}
	throw new Error('expected a refusal, but the call succeeded');
}

beforeAll(async () => {
	stub = new CloudflareStub({ token: TOKEN });
	await stub.start(await freePort());
	host = new CloudflareAppHost(
		readCloudflareConfig({
			CLOUDFLARE_API_BASE: `${stub.url}/client/v4`,
			CLOUDFLARE_API_TOKEN: TOKEN,
			CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
			CLOUDFLARE_DISPATCH_NAMESPACE: NAMESPACE,
			CLOUDFLARE_ROUTES_KV_ID: KV_ID,
			CLOUDFLARE_APPS_ZONE_ID: ZONE,
		}),
	);
});

afterAll(async () => {
	await stub.stop();
});

describe('readCloudflareConfig (fail-closed)', () => {
	test('a blank env is NOT_CONFIGURED and names every missing variable', () => {
		const error = (() => {
			try {
				readCloudflareConfig({});
			} catch (e) {
				return e as AppHostError;
			}
			throw new Error('expected a refusal');
		})();
		expect(error).toBeInstanceOf(AppHostError);
		expect(error.code).toBe('NOT_CONFIGURED');
		expect(error.status).toBe(503);
		for (const name of [
			'CLOUDFLARE_API_TOKEN',
			'CLOUDFLARE_ACCOUNT_ID',
			'CLOUDFLARE_DISPATCH_NAMESPACE',
			'CLOUDFLARE_ROUTES_KV_ID',
			'CLOUDFLARE_APPS_ZONE_ID',
		]) {
			expect(error.message).toContain(name);
		}
	});

	test('a half-configured env names only the missing variable', () => {
		const error = (() => {
			try {
				readCloudflareConfig({
					CLOUDFLARE_API_TOKEN: TOKEN,
					CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
					CLOUDFLARE_DISPATCH_NAMESPACE: NAMESPACE,
					CLOUDFLARE_ROUTES_KV_ID: KV_ID,
					// zone missing
				});
			} catch (e) {
				return e as AppHostError;
			}
			throw new Error('expected a refusal');
		})();
		expect(error.code).toBe('NOT_CONFIGURED');
		expect(error.message).toContain('CLOUDFLARE_APPS_ZONE_ID');
		expect(error.message).not.toContain('CLOUDFLARE_API_TOKEN');
	});
});

describe('deploy (Workers for Platforms scripts + assets)', () => {
	test('static-only app uploads an assets-only module and SPA config', async () => {
		const result = await host.deploy(deployInput({ script: 'static-app' }));
		expect(result.script).toBe('static-app');
		const script = stub.scripts.get('static-app');
		expect(script).toBeDefined();
		expect(script?.metadata['main_module']).toBe('index.js');
		expect(script?.metadata['compatibility_date']).toBe('2026-10-17');
		expect(script?.metadata['tags']).toEqual(['project:p1', 'owner:u1']);
		const assets = script?.assets as { jwt?: string; config?: { not_found_handling?: string; run_worker_first?: string[] } };
		expect(assets.config?.not_found_handling).toBe('single-page-application');
		expect(assets.config?.run_worker_first).toEqual(['/api/*']);
		// An assets binding is always present so env.ASSETS resolves.
		expect(script?.bindings).toContainEqual({ type: 'assets', name: 'ASSETS' });
		// Both files' hashes were really uploaded.
		expect(stub.storedAssets.size).toBe(2);
	});

	test('full app: server module + d1 + secret + assets bindings all land', async () => {
		const bindings: AppHostBinding[] = [
			{ type: 'd1', name: 'DB', databaseId: 'db-123' },
			{ type: 'secret_text', name: 'API_KEY', text: 'super-secret' },
			{ type: 'plain_text', name: 'MODE', text: 'prod' },
			{ type: 'service', name: 'CADDIE', service: 'caddie-platform', entrypoint: 'AppApi' },
		];
		await host.deploy(deployInput({ script: 'full-app', serverModule: 'export default { fetch(){ return new Response("hi"); } }', bindings }));
		const script = stub.scripts.get('full-app');
		expect(script?.bindings).toContainEqual({ type: 'd1', name: 'DB', id: 'db-123' });
		expect(script?.bindings).toContainEqual({ type: 'secret_text', name: 'API_KEY', text: 'super-secret' });
		expect(script?.bindings).toContainEqual({ type: 'plain_text', name: 'MODE', text: 'prod' });
		expect(script?.bindings).toContainEqual({ type: 'service', name: 'CADDIE', service: 'caddie-platform', entrypoint: 'AppApi' });
	});

	test('redeploy replaces the script in place', async () => {
		await host.deploy(deployInput({ script: 'replace-me', tags: ['v:1'] }));
		await host.deploy(deployInput({ script: 'replace-me', tags: ['v:2'] }));
		expect(stub.scripts.get('replace-me')?.metadata['tags']).toEqual(['v:2']);
	});

	test('an invalid script name is INVALID_INPUT before any call', async () => {
		const before = stub.requests.length;
		const error = await refusal(host.deploy(deployInput({ script: 'Bad_Name' })));
		expect(error.code).toBe('INVALID_INPUT');
		expect(stub.requests.length).toBe(before);
	});

	test('assets without /index.html are refused', async () => {
		const error = await refusal(host.deploy(deployInput({ assets: [MAIN_JS] })));
		expect(error.code).toBe('INVALID_INPUT');
		expect(error.message).toContain('/index.html');
	});
});

describe('removeScript', () => {
	test('deletes an existing script and is idempotent on a missing one', async () => {
		await host.deploy(deployInput({ script: 'gone-soon' }));
		await host.removeScript('gone-soon');
		expect(stub.scripts.has('gone-soon')).toBe(false);
		// Second delete (404 upstream) resolves — already gone.
		await host.removeScript('gone-soon');
	});
});

describe('D1', () => {
	test('create, query (statements run in order), delete', async () => {
		const { id } = await host.createDatabase('app-db');
		expect(id).toBeTruthy();
		const rows = await host.query(id, [
			{ sql: 'create table t (a)' },
			{ sql: 'insert into t values (1)' },
			{ sql: 'select a from t' },
		]);
		expect(rows.length).toBe(3);
		// The select statement returned a row; writes returned none.
		expect(rows[2]).toEqual([{ ok: 1 }]);
		expect(stub.databaseSql(id)).toEqual(['create table t (a)', 'insert into t values (1)', 'select a from t']);
		await host.deleteDatabase(id);
		expect(stub.databases.has(id)).toBe(false);
		// Idempotent delete.
		await host.deleteDatabase(id);
	});

	test('a single parameterised statement binds its params', async () => {
		const { id } = await host.createDatabase('param-db');
		const rows = await host.query(id, [{ sql: 'select * from t where a = ?', params: [1] }]);
		expect(rows.length).toBe(1);
	});

	test('refuses a batch that mixes params across statements', async () => {
		const { id } = await host.createDatabase('mix-db');
		const error = await refusal(
			host.query(id, [
				{ sql: 'insert into t values (?)', params: [1] },
				{ sql: 'insert into t values (?)', params: [2] },
			]),
		);
		expect(error.code).toBe('INVALID_INPUT');
	});
});

describe('routes (KV)', () => {
	const route: AppRoute = {
		v: 1,
		script: 'app-abc',
		projectId: 'p1',
		slug: 'myapp',
		status: 'live',
		limits: { cpuMs: 50, subRequests: 50 },
		hasServer: true,
		updatedAt: '2026-10-17T00:00:00.000Z',
	};

	test('put writes the route JSON under route:<hostname>, delete removes it', async () => {
		await host.putRoute('MyApp.Example.com', route);
		const stored = stub.kv.get('route:myapp.example.com');
		expect(stored).toBeDefined();
		expect(JSON.parse(stored ?? '{}')).toEqual(route);
		await host.deleteRoute('MyApp.Example.com');
		expect(stub.kv.has('route:myapp.example.com')).toBe(false);
	});
});

describe('custom hostnames (Cloudflare for SaaS)', () => {
	test('create -> pending with HTTP DCV records; get -> active; delete', async () => {
		const created = await host.createHostname('app.customer.com');
		expect(created.id).toBeTruthy();
		expect(created.hostname).toBe('app.customer.com');
		expect(created.status).toBe('pending');
		expect(created.sslStatus).toBe('pending_validation');
		expect(created.errors).toContain('custom hostname does not CNAME to this zone.');
		// HTTP DCV + ownership-verification records are surfaced.
		expect(created.validationRecords.some((r) => r.type === 'http')).toBe(true);

		const fetched = await host.getHostname(created.id);
		expect(fetched.status).toBe('active');
		expect(fetched.sslStatus).toBe('active');

		await host.deleteHostname(created.id);
		expect(stub.hostnames.has(created.id)).toBe(false);
		// Idempotent delete (404 upstream).
		await host.deleteHostname(created.id);
	});
});

describe('URL Scanner', () => {
	test('pending on the first poll, then a clean verdict', async () => {
		const { scanId } = await host.scanUrl('https://clean.example.com');
		expect(scanId).toBeTruthy();
		const first = await host.scanResult(scanId);
		expect(first.state).toBe('pending');
		const done = await host.scanResult(scanId);
		expect(done.state).toBe('done');
		if (done.state === 'done') {
			expect(done.malicious).toBe(false);
			expect(done.reportUrl).toContain(scanId);
		}
	});

	test('a URL with the malicious marker scans malicious with categories', async () => {
		const { scanId } = await host.scanUrl('https://phishy.example.com/login');
		await host.scanResult(scanId); // pending
		const done = await host.scanResult(scanId);
		expect(done.state).toBe('done');
		if (done.state === 'done') {
			expect(done.malicious).toBe(true);
			expect(done.categories).toContain('phishing');
		}
	});
});

describe('error mapping (every AppHostErrorCode)', () => {
	const cases: Array<{ status: number; code: AppHostError['code'] }> = [
		{ status: 400, code: 'INVALID_INPUT' },
		{ status: 422, code: 'INVALID_INPUT' },
		{ status: 401, code: 'UNAUTHORIZED' },
		{ status: 403, code: 'UNAUTHORIZED' },
		{ status: 404, code: 'NOT_FOUND' },
		{ status: 409, code: 'CONFLICT' },
		{ status: 429, code: 'RATE_LIMITED' },
		{ status: 500, code: 'UPSTREAM' },
		{ status: 503, code: 'UPSTREAM' },
	];

	beforeEach(() => {
		// Clear any leftover fail rules between cases.
		(stub as unknown as { failRules: unknown[] }).failRules = [];
	});

	for (const { status, code } of cases) {
		test(`HTTP ${status} on D1 create maps to ${code}`, async () => {
			stub.failNext('POST /client/v4/accounts', status);
			const error = await refusal(host.createDatabase('err-db'));
			expect(error.code).toBe(code);
			expect(error.status).toBe(status);
		});
	}

	test('404 on createDatabase (not an idempotent-delete) still maps to NOT_FOUND', async () => {
		stub.failNext('d1/database', 404);
		const error = await refusal(host.createDatabase('nf-db'));
		expect(error.code).toBe('NOT_FOUND');
	});

	test('carries Cloudflare first error code and message', async () => {
		stub.failNext('d1/database', 409);
		const error = await refusal(host.createDatabase('conflict-db'));
		expect(error.upstreamCode).toBe(10009);
		expect(error.message).toContain('Conflict (stub)');
	});
});

describe('token confidentiality', () => {
	test('the API token never appears in any error message', async () => {
		stub.failNext('d1/database', 500);
		const error = await refusal(host.createDatabase('leak-check'));
		expect(error.message).not.toContain(TOKEN);
	});

	test('a transport failure (closed server) is a typed non-leaking error', async () => {
		const deadStub = new CloudflareStub({ token: TOKEN });
		const port = await freePort();
		await deadStub.start(port);
		const base = deadStub.url;
		await deadStub.stop(); // nothing listening now
		const deadHost = new CloudflareAppHost(
			readCloudflareConfig({
				CLOUDFLARE_API_BASE: `${base}/client/v4`,
				CLOUDFLARE_API_TOKEN: TOKEN,
				CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
				CLOUDFLARE_DISPATCH_NAMESPACE: NAMESPACE,
				CLOUDFLARE_ROUTES_KV_ID: KV_ID,
				CLOUDFLARE_APPS_ZONE_ID: ZONE,
			}),
		);
		const error = await refusal(deadHost.createDatabase('x'));
		expect(['UPSTREAM', 'TIMEOUT']).toContain(error.code);
		expect(error.message).not.toContain(TOKEN);
	});
});
