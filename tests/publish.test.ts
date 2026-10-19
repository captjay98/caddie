import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { ApprovalIntent, Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { CloudflareAppHost, readCloudflareConfig } from '../apps/app/src/server/adapters/cloudflare.ts';
import { requestAppSecret, setAppSecret } from '../apps/app/src/server/app-secrets.ts';
import { recordDecision } from '../apps/app/src/server/approvals.ts';
import { decideDesign, decideWorkflow, readPublishBundle, startProjectFromChat, storeBuildOutput, workflowSnapshot } from '../apps/app/src/server/build-workflow.ts';
import { createPlanDocRevision, ensureHomeProject } from '../apps/app/src/server/projects.ts';
import {
	advanceSafetyChecks,
	checkSlug,
	destructiveMigrationIntent,
	getPublishStatus,
	isDestructiveSql,
	publishApp,
	restoreTakenDownApp,
	rollbackApp,
	scriptNameFor,
	PUBLISHED_ENTRY_SOURCE,
	suggestSlug,
	takeDownApp,
	unpublishApp,
	type PublishDeps,
} from '../apps/app/src/server/publish.ts';
import { listAbuseReports } from '../apps/app/src/server/abuse-reports.ts';
import { createRun } from '../apps/app/src/server/runs.ts';
import { createPublishRouter } from '../apps/app/src/server/routes/publish.ts';
import { ScopeError, projectScopeForUser } from '../apps/app/src/server/scope.ts';
import { parseKeyring, type Keyring } from '../apps/app/src/server/secret-box.ts';
import { appAuthSecret } from '../apps/app/src/server/app-sign-in.ts';
import { CloudflareStub } from './fixtures/cloudflare-stub.ts';
import { freePort } from './fixtures/controls-harness.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * The publish service. SIMULATED provider: every Cloudflare call goes through
 * the REAL adapter (CloudflareAppHost) over HTTP to the local Cloudflare stub,
 * which parses uploads like the real API. Caddie's side (approvals, keys,
 * migrations bookkeeping, the operations log) runs on the real migrations
 * over SQLite. Live Workers for Platforms stays BLOCKED.
 */

const TOKEN = 'cf-test-token';
const APPS = 'caddieapps.test';
let stub: CloudflareStub;
let host: CloudflareAppHost;

beforeAll(async () => {
	stub = new CloudflareStub({ token: TOKEN });
	await stub.start(await freePort());
	host = new CloudflareAppHost(
		readCloudflareConfig({
			CLOUDFLARE_API_BASE: `${stub.url}/client/v4`,
			CLOUDFLARE_API_TOKEN: TOKEN,
			CLOUDFLARE_ACCOUNT_ID: 'acct-1',
			CLOUDFLARE_DISPATCH_NAMESPACE: 'caddie-apps',
			CLOUDFLARE_ROUTES_KV_ID: 'kv-routes',
			CLOUDFLARE_APPS_ZONE_ID: 'zone-apps',
		}),
	);
});

afterAll(async () => {
	await stub.stop();
});

const SERVER = "export default { fetch(req) { return new Response(new URL(req.url).pathname === '/api/health' ? '{\"ok\":true}' : 'app'); } };";
const INIT = { name: '0001_init.sql', sql: 'create table notes (id integer primary key, body text not null);' };
const JS = 'console.log("farm log")';
const CSS = 'body { color: green }';

async function rejects(task: Promise<unknown>, code: string): Promise<string> {
	try {
		await task;
	} catch (error) {
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).code).toBe(code);
		return (error as ScopeError).message;
	}
	throw new Error(`expected ${code}, but it succeeded`);
}

describe('publish service', () => {
	let sqlite: Database;
	let db: D1Database;
	let scope: Scope;
	let keyring: Keyring;
	let probes: string[];
	let inbox: Array<{ subject: string; text: string }>;
	let probeStatus: (url: string) => number;
	let deps: PublishDeps;

	/** A project whose build is checked and ready, like after verify_build. */
	async function readyProject(name = 'Farm Log') {
		const home = await ensureHomeProject(db, 'alice');
		const homeScope = await projectScopeForUser(db, 'alice', home.id);
		const homeRun = await createRun(db, homeScope, { modelRouteId: 'nemotron-3-super', payerId: 'alice', conversationId: `conv-${crypto.randomUUID()}` });
		const started = await startProjectFromChat(db, homeScope, {
			name,
			description: 'Log feed',
			brief: 'Build a farm log with a database. Show me the plan first.',
			operationKey: `create-${crypto.randomUUID()}`,
			sourceConversationId: homeRun.conversationId,
		});
		const projectScope = await projectScopeForUser(db, 'alice', started.project.id);
		const plan = await createPlanDocRevision(db, projectScope, { kind: 'prd', body: '# Farm log\n\nLog feed and see totals.' });
		await workflowSnapshot(db, projectScope);
		await decideWorkflow(db, projectScope, { planId: plan.id, decision: 'approved' });
		const design = await createPlanDocRevision(db, projectScope, { kind: 'design', body: '# Design brief\n\nOne screen with a form and totals.' });
		await workflowSnapshot(db, projectScope);
		await decideDesign(db, projectScope, { designId: design.id, decision: 'approved' });
		return { scope: projectScope, planId: plan.id, runId: started.workflow.runId as string };
	}

	async function checkedBuild(
		target: { scope: Scope; planId: string; runId: string },
		bundle: { server: string | null; migrations: { name: string; sql: string }[]; js?: string },
		image: string,
	): Promise<string> {
		sqlite.prepare('update build_workflows set phase = ? where projectId = ?').run('building', target.scope.projectId);
		const output = await storeBuildOutput(db, target.scope, {
			html: '<!doctype html><html><body>preview</body></html>',
			image,
			planId: target.planId,
			runId: target.runId,
			bundle: { server: bundle.server, migrations: bundle.migrations, client: { js: bundle.js ?? JS, css: CSS } },
		});
		return output.outputId;
	}

	async function approve(intent: ApprovalIntent | null): Promise<void> {
		expect(intent).not.toBeNull();
		await recordDecision(db, 'alice', { intent, decision: 'approved' });
	}

	const status = () => getPublishStatus(db, { appsDomain: APPS, available: true }, scope);
	const routeOf = (slug: string) => JSON.parse(stub.kv.get(`route:${slug}.${APPS}`) ?? 'null');

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'alice', 'alice@example.com');
		addUser(sqlite, 'bob', 'bob@example.com');
		keyring = await parseKeyring(`k1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`);
		probes = [];
		inbox = [];
		probeStatus = () => 200;
		deps = {
			host,
			appsDomain: APPS,
			keyring,
			probe: async (url) => {
				probes.push(url);
				return probeStatus(url);
			},
			notifyOperator: async (subject, text) => {
				inbox.push({ subject, text });
				return true;
			},
			authSecret: 'caddie-master-secret-for-tests-0123',
			sleep: async () => undefined,
		};
		const ready = await readyProject();
		scope = ready.scope;
		(globalThis as { __ready?: typeof ready }).__ready = ready;
	});

	afterEach(() => {
		sqlite.close();
		// One stub serves every test: start each from an empty account.
		stub.clearFailures();
		stub.maliciousMarker = 'phishy';
		stub.kv.clear();
		stub.scripts.clear();
	});

	const ready = () => (globalThis as { __ready?: { scope: Scope; planId: string; runId: string } }).__ready!;

	test('first publish: one confirm, then database, migrations, upload with keys, route and health — every step logged', async () => {
		const outputId = await checkedBuild(ready(), { server: SERVER, migrations: [INIT] }, 'sha256:img-1');
		await requestAppSecret(db, scope, { name: 'WEATHER_API_KEY', description: 'Forecast.' });
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: 'ow-live-secret-123' });

		const before = await status();
		expect(before.publication).toBeNull();
		expect(before.suggestedSlug).toBe('farm-log');
		expect(before.current).toMatchObject({ outputId, publishable: true, upToDate: false, destructive: [] });
		expect(before.current!.intent).toMatchObject({ action: 'deploy-production', resourceId: `app:${scope.projectId}` });

		// No confirm, no effect.
		const scriptsBefore = stub.scripts.size;
		await rejects(publishApp(db, deps, scope, { outputId }), 'STALE_APPROVAL');
		expect(stub.scripts.size).toBe(scriptsBefore);

		await approve(before.current!.intent);
		await publishApp(db, deps, scope, { outputId });

		const after = await status();
		expect(after.publication).toMatchObject({ slug: 'farm-log', url: `https://farm-log.${APPS}/`, status: 'live', outputId, hasServer: true });
		expect(after.current!.upToDate).toBe(true);
		const run = after.runs[0]!;
		expect(run).toMatchObject({ kind: 'publish', status: 'succeeded', error: null });
		expect(run.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['approval:ok', 'database:ok', 'migration:ok', 'upload:ok', 'safety-check:waiting', 'safety-check:ok', 'route:ok', 'health:ok']);
		// Page + its two files + the manifest and four home-screen icons (published-page.ts).
		expect(run.steps.find((s) => s.step === 'upload')!.detail).toBe('8 files and the server, 1 key');

		// What reached Cloudflare.
		const script = stub.scripts.get(scriptNameFor(scope.projectId, 1))!;
		expect(script.hasModule).toBe(true);
		// The app's own server runs under Caddie's entry, which hands it env.CADDIE.
		expect(Object.keys(script.modules).sort()).toEqual(['app.js', 'index.js']);
		expect(script.modules['index.js']).toBe(PUBLISHED_ENTRY_SOURCE);
		const bindings = script.bindings as Array<Record<string, unknown>>;
		expect(bindings.find((b) => b['name'] === 'DB')).toMatchObject({ type: 'd1' });
		expect(bindings.find((b) => b['name'] === 'WEATHER_API_KEY')).toMatchObject({ type: 'secret_text', text: 'ow-live-secret-123' });
		// The app's own sign-in secret, derived for its live mode (not one of its keys).
		expect(bindings.find((b) => b['name'] === 'CADDIE_AUTH_SECRET')).toEqual({ type: 'secret_text', name: 'CADDIE_AUTH_SECRET', text: await appAuthSecret('caddie-master-secret-for-tests-0123', scope.projectId, 'live') });
		const database = [...stub.databases.values()].at(-1)!;
		expect(database.executedSql.join('\n')).toContain('create table notes');
		expect(routeOf('farm-log')).toMatchObject({ v: 1, script: script.name, projectId: scope.projectId, slug: 'farm-log', status: 'live', hasServer: true, limits: { cpuMs: 50, subRequests: 50 } });
		expect(probes).toEqual([`https://farm-log.${APPS}/`, `https://farm-log.${APPS}/api/health`]);
		// The new version was scanned on a private check address, which is gone now.
		const scanned = [...stub.scans.values()].at(-1)!;
		expect(scanned.url).toMatch(new RegExp(`^https://chk--[0-9a-f]{16}\\.${APPS.replace('.', '\\.')}/$`));
		expect(stub.kv.has(`route:${new URL(scanned.url).hostname}`)).toBe(false);

		// The key's value is in the upload only — never in Caddie's log or status.
		expect(JSON.stringify(after)).not.toContain('ow-live-secret-123');
		expect(JSON.stringify(sqlite.prepare('select * from app_publish_runs').all())).not.toContain('ow-live-secret-123');
	});

	test('the published page loads its own files only: index.html links main.js and main.css', async () => {
		const outputId = await checkedBuild(ready(), { server: null, migrations: [] }, 'sha256:img-static');
		const bundle = await readPublishBundle(db, scope, outputId);
		expect(bundle).toMatchObject({ js: JS, css: CSS, server: null, migrations: [] });
		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId });
		const run = (await status()).runs[0]!;
		expect(run.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['approval:ok', 'database:skipped', 'migration:skipped', 'upload:ok', 'safety-check:waiting', 'safety-check:ok', 'route:ok', 'health:ok']);
		expect(probes).toEqual([`https://farm-log.${APPS}/`]);
		expect(routeOf('farm-log').hasServer).toBe(false);
	});

	test('keys the app asked for must be saved first; nothing is uploaded until they are', async () => {
		const outputId = await checkedBuild(ready(), { server: SERVER, migrations: [INIT] }, 'sha256:img-keys');
		await requestAppSecret(db, scope, { name: 'MAPS_KEY', description: 'Shows the map.' });
		await approve((await status()).current!.intent);
		expect((await status()).missingKeys).toEqual(['MAPS_KEY']);
		const before = stub.databases.size;
		expect(await rejects(publishApp(db, deps, scope, { outputId }), 'KEYS_MISSING')).toBe('Add the keys this app needs first: MAPS_KEY.');
		expect(stub.databases.size).toBe(before);
		expect((await status()).runs).toEqual([]);
	});

	test('updates run only new migrations; an edited one is refused; one that deletes data needs its own confirm', async () => {
		const first = await checkedBuild(ready(), { server: SERVER, migrations: [INIT] }, 'sha256:img-a');
		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId: first });
		const database = [...stub.databases.values()].at(-1)!;
		const databases = stub.databases.size;

		// v2 adds a column.
		const tags = { name: '0002_tags.sql', sql: 'alter table notes add column tag text;' };
		const second = await checkedBuild(ready(), { server: SERVER, migrations: [INIT, tags] }, 'sha256:img-b');
		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId: second });
		expect(stub.databases.size).toBe(databases); // same database
		expect(database.executedSql.filter((sql) => /create table notes/.test(sql))).toHaveLength(1);
		expect(database.executedSql.join('\n')).toContain('add column tag');
		expect((await status()).runs[0]!.steps.filter((s) => s.step === 'migration').map((s) => s.detail)).toEqual(['0002_tags.sql']);

		// v3 edits a migration that already ran.
		const edited = await checkedBuild(ready(), { server: SERVER, migrations: [{ ...INIT, sql: 'create table notes (id integer primary key);' }, tags] }, 'sha256:img-c');
		await approve((await status()).current!.intent);
		await rejects(publishApp(db, deps, scope, { outputId: edited }), 'MIGRATION_CHANGED');

		// v4 deletes data: the status names it, publishing waits for its own confirm.
		const cleanup = { name: '0003_cleanup.sql', sql: '-- remove test rows\ndelete from notes where body = \'test\';' };
		const fourth = await checkedBuild(ready(), { server: SERVER, migrations: [INIT, tags, cleanup] }, 'sha256:img-d');
		const pending = await status();
		expect(pending.current!.destructive.map((d) => d.name)).toEqual(['0003_cleanup.sql']);
		await approve(pending.current!.intent);
		await rejects(publishApp(db, deps, scope, { outputId: fourth }), 'DESTRUCTIVE_MIGRATION_NEEDS_APPROVAL');
		expect(database.executedSql.join('\n')).not.toContain('delete from notes');
		await approve(pending.current!.destructive[0]!.intent);
		await publishApp(db, deps, scope, { outputId: fourth });
		expect(database.executedSql.join('\n')).toContain('delete from notes');
	});

	test('unpublish keeps code and data; publishing again brings it back; roll back puts earlier code live without touching data', async () => {
		const first = await checkedBuild(ready(), { server: SERVER, migrations: [INIT] }, 'sha256:img-1');
		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId: first });
		const second = await checkedBuild(ready(), { server: SERVER, migrations: [INIT, { name: '0002_tags.sql', sql: 'alter table notes add column tag text;' }] }, 'sha256:img-2');
		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId: second });

		await unpublishApp(db, deps, scope);
		expect(routeOf('farm-log').status).toBe('paused');
		expect((await status()).publication!.status).toBe('paused');
		await rejects(unpublishApp(db, deps, scope), 'NOT_LIVE');

		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId: second });
		expect(routeOf('farm-log').status).toBe('live');

		const before = await status();
		expect(before.versions.map((v) => [v.outputId, v.live])).toEqual([
			[second, true],
			[first, false],
		]);
		const database = [...stub.databases.values()].at(-1)!;
		const sqlCount = database.executedSql.length;
		await approve(before.versions[1]!.intent);
		await rollbackApp(db, deps, scope, { outputId: first });
		const after = await status();
		expect(after.publication!.outputId).toBe(first);
		expect(after.runs[0]).toMatchObject({ kind: 'rollback', status: 'succeeded' });
		expect(database.executedSql.length).toBe(sqlCount); // no migrations on roll back
		await rejects(rollbackApp(db, deps, scope, { outputId: 'out_never_published' }), 'NOT_A_PUBLISHED_VERSION');
	});

	test('a failed upload is a plain failure in the log; the database is kept so trying again does not make a second one', async () => {
		const outputId = await checkedBuild(ready(), { server: SERVER, migrations: [INIT] }, 'sha256:img-fail');
		await approve((await status()).current!.intent);
		stub.failNext('PUT /client/v4/accounts/acct-1/workers/dispatch/namespaces/caddie-apps/scripts/', 500, 1);
		const databases = stub.databases.size;
		const message = await rejects(publishApp(db, deps, scope, { outputId }), 'PUBLISH_FAILED');
		expect(message).toBe("The hosting service didn't accept the app. Try again; if it keeps failing, Caddie's team will look at it.");
		const failed = (await status()).runs[0]!;
		expect(failed.status).toBe('failed');
		expect(failed.steps.at(-1)).toMatchObject({ step: 'upload', outcome: 'failed' });
		expect((await status()).publication).toBeNull();
		expect(stub.databases.size).toBe(databases + 1);

		await publishApp(db, deps, scope, { outputId });
		expect(stub.databases.size).toBe(databases + 1);
		expect((await status()).publication!.status).toBe('live');
		// The migration ran once, before the failed upload, and is not repeated.
		const database = [...stub.databases.values()].at(-1)!;
		expect(database.executedSql.filter((sql) => /create table notes/.test(sql))).toHaveLength(1);
	});

	test("a published app that doesn't answer yet is reported honestly", async () => {
		const outputId = await checkedBuild(ready(), { server: SERVER, migrations: [INIT] }, 'sha256:img-slow');
		await approve((await status()).current!.intent);
		probeStatus = (url) => (url.endsWith('/api/health') ? 500 : 200);
		await publishApp(db, deps, scope, { outputId });
		const after = await status();
		expect(after.publication!.status).toBe('live');
		expect(after.runs[0]!.status).toBe('failed');
		expect(after.runs[0]!.error).toBe("The app is published but didn't answer yet (home page answered 200, /api/health answered 500). Open it in a minute, or roll back.");
		expect(probes.filter((u) => u.endsWith('/api/health')).length).toBe(6);
	});

	test('one update at a time; only the owner publishes; taken-down apps stay down; only the latest build can go live', async () => {
		const outputId = await checkedBuild(ready(), { server: SERVER, migrations: [INIT] }, 'sha256:img-x');
		const intent = (await status()).current!.intent;
		await approve(intent);

		sqlite
			.prepare('insert into app_publish_runs (id,projectId,kind,status,steps,actorId,startedAt) values (?,?,?,?,?,?,?)')
			.run('pub_busy', scope.projectId, 'publish', 'running', '[]', 'alice', new Date().toISOString());
		await rejects(publishApp(db, deps, scope, { outputId }), 'PUBLISH_IN_PROGRESS');
		// A run that has been "running" for over ten minutes was interrupted, and no longer blocks.
		sqlite.prepare('update app_publish_runs set startedAt = ? where id = ?').run('2026-01-01T00:00:00.000Z', 'pub_busy');
		await publishApp(db, deps, scope, { outputId });
		expect(sqlite.prepare("select status, error from app_publish_runs where id = 'pub_busy'").get()).toEqual({ status: 'failed', error: 'Interrupted before it finished.' });

		await rejects(publishApp(db, deps, { ...scope, actorId: 'bob' }, { outputId }), 'not_a_member');
		sqlite
			.prepare('insert into workspace_memberships (id,workspaceId,userId,role,createdAt) values (?,?,?,?,?)')
			.run('mem-bob', scope.workspaceId, 'bob', 'member', new Date().toISOString());
		await rejects(publishApp(db, deps, { ...scope, actorId: 'bob' }, { outputId }), 'not_project_owner');
		await rejects(unpublishApp(db, deps, { ...scope, actorId: 'bob' }), 'not_project_owner');
		expect((await getPublishStatus(db, { appsDomain: APPS, available: true }, { ...scope, actorId: 'bob' })).publication!.status).toBe('live');

		await rejects(publishApp(db, deps, scope, { outputId: 'out_someone_else' }), 'NOT_CURRENT_BUILD');

		sqlite.prepare("update app_publications set status = 'blocked' where projectId = ?").run(scope.projectId);
		await rejects(publishApp(db, deps, scope, { outputId }), 'APP_BLOCKED');
	});

	test('over HTTP: status, the confirm gate, publish, unpublish; plain 503 when publishing is not set up', async () => {
		const outputId = await checkedBuild(ready(), { server: SERVER, migrations: [INIT] }, 'sha256:img-http');
		const scopeFor = async (env: { DB: D1Database }, request: Request, id: string) => {
			const user = request.headers.get('x-test-user');
			if (!user) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
			return projectScopeForUser(env.DB, user, id);
		};
		const router = createPublishRouter({ scopeFor, depsFor: async () => deps });
		const call = (path: string, init: RequestInit = {}) =>
			router.request(path, { ...init, headers: { 'x-test-user': 'alice', 'content-type': 'application/json', ...(init.headers ?? {}) } }, { DB: db } as never);
		const base = `/projects/${scope.projectId}/publish`;

		const first = await call(base);
		expect(first.status).toBe(200);
		expect(first.headers.get('cache-control')).toBe('no-store');
		const body = (await first.json()) as { available: boolean; current: { outputId: string; intent: ApprovalIntent } };
		expect(body.available).toBe(true);
		expect(body.current.outputId).toBe(outputId);

		const refused = await call(base, { method: 'POST', body: JSON.stringify({ outputId }) });
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe('STALE_APPROVAL');

		await approve(body.current.intent);
		const published = await call(base, { method: 'POST', body: JSON.stringify({ outputId, slug: 'farm-log' }) });
		expect(published.status).toBe(200);
		expect(((await published.json()) as { publication: { status: string } }).publication.status).toBe('live');

		const form = await call(`${base}/unpublish`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
		expect(form.status).toBe(415);
		const paused = await call(`${base}/unpublish`, { method: 'POST', body: '{}' });
		expect(((await paused.json()) as { publication: { status: string } }).publication.status).toBe('paused');
		expect((await call(base, { headers: { 'x-test-user': 'bob' } })).status).toBe(403);

		// No owner inputs: the card says so plainly, and writes are refused.
		const bare = createPublishRouter({ scopeFor });
		const unset = await bare.request(base, { headers: { 'x-test-user': 'alice' } }, { DB: db } as never);
		expect(await unset.json()).toMatchObject({ available: false, reason: "Publishing isn't set up on this Caddie server yet." });
		const halfSet = await bare.request(
			base,
			{ method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify({ outputId }) },
			{ DB: db, APPS_DOMAIN: 'caddieapps.test', CLOUDFLARE_API_TOKEN: 'only-this' } as never,
		);
		expect(halfSet.status).toBe(503);
		expect(await halfSet.json()).toEqual({ error: 'publishing_unavailable', message: "Publishing isn't set up on this Caddie server yet." });
	});

	test('a version the safety check flags never goes live: the app is taken down, reported, and comes back only after review', async () => {
		const outputId = await checkedBuild(ready(), { server: null, migrations: [] }, 'sha256:img-flag');
		await approve((await status()).current!.intent);
		stub.maliciousMarker = 'chk--';
		try {
			await publishApp(db, deps, scope, { outputId });
		} finally {
			stub.maliciousMarker = 'phishy';
		}
		const after = await status();
		expect(after.publication).toMatchObject({ slug: 'farm-log', status: 'blocked' });
		expect(after.publication!.blockedReason).toContain("Caddie's safety check flagged a new version");
		expect(after.runs[0]).toMatchObject({ status: 'failed', error: "Caddie's safety check flagged this version, so the app isn't on the web. Caddie's team will review it." });
		expect(after.runs[0]!.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['approval:ok', 'database:skipped', 'migration:skipped', 'upload:ok', 'safety-check:waiting', 'safety-check:failed']);
		// Nothing of the flagged version is left serving.
		expect(stub.scripts.has(scriptNameFor(scope.projectId, 1))).toBe(false);
		expect([...stub.kv.keys()].filter((k) => k.includes('chk--'))).toEqual([]);
		expect(routeOf('farm-log')).toBeNull();
		// Reported to the operator's inbox, and in the reports queue.
		expect(inbox.map((m) => m.subject)).toEqual(['[Caddie abuse] phishing report for farm-log (url-scan)']);
		const reports = await listAbuseReports(db, { status: 'open' });
		expect(reports.map((r) => [r.slug, r.source, r.app?.status])).toEqual([['farm-log', 'url-scan', 'blocked']]);
		await rejects(publishApp(db, deps, scope, { outputId }), 'APP_BLOCKED');

		// The operator reviews it and lifts the takedown; publishing again needs no second scan of the same version.
		expect(await restoreTakenDownApp(db, deps, scope.projectId, { by: 'operator-1' })).toBe(true);
		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId });
		const live = await status();
		expect(live.publication!.status).toBe('live');
		expect(live.runs[0]!.steps.map((s) => `${s.step}:${s.outcome}`)).toContain('safety-check:skipped');
	});

	test('while a new version is checked visitors keep the current one; a slow scan finishes in the sweep, a stuck one is dropped', async () => {
		const first = await checkedBuild(ready(), { server: null, migrations: [] }, 'sha256:img-v1');
		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId: first });
		const v1 = scriptNameFor(scope.projectId, 1);
		expect(routeOf('farm-log')).toMatchObject({ status: 'live', script: v1 });

		// v2: the scanner is slow, longer than the publish request waits.
		const second = await checkedBuild(ready(), { server: null, migrations: [], js: 'console.log("v2")' }, 'sha256:img-v2');
		await approve((await status()).current!.intent);
		stub.failNext('GET /client/v4/accounts/acct-1/urlscanner/v2/result/', 404, 6);
		await publishApp(db, deps, scope, { outputId: second });
		const waiting = await status();
		expect(waiting.pendingCheck).not.toBeNull();
		expect(waiting.runs[0]!.status).toBe('running');
		expect(routeOf('farm-log')).toMatchObject({ status: 'live', script: v1 }); // visitors still get v1
		await rejects(unpublishApp(db, deps, scope), 'PUBLISH_IN_PROGRESS');

		// The 5-minute sweep finishes it: v2 goes live, v1 is retired.
		await advanceSafetyChecks(db, deps);
		await advanceSafetyChecks(db, deps);
		const done = await status();
		expect(done.pendingCheck).toBeNull();
		expect(done.runs[0]).toMatchObject({ status: 'succeeded' });
		expect(done.runs[0]!.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['approval:ok', 'database:skipped', 'migration:skipped', 'upload:ok', 'safety-check:waiting', 'safety-check:ok', 'route:ok', 'cleanup:ok', 'health:ok']);
		const v2 = scriptNameFor(scope.projectId, 2);
		expect(routeOf('farm-log')).toMatchObject({ status: 'live', script: v2 });
		expect(stub.scripts.has(v1)).toBe(false);

		// v3: the scan never finishes; after 15 minutes the new version is dropped and v2 stays.
		const third = await checkedBuild(ready(), { server: null, migrations: [], js: 'console.log("v3")' }, 'sha256:img-v3');
		await approve((await status()).current!.intent);
		stub.failNext('GET /client/v4/accounts/acct-1/urlscanner/v2/result/', 404, 20);
		await publishApp(db, deps, scope, { outputId: third });
		expect((await status()).runs[0]!.status).toBe('running');
		const later = { ...deps, now: () => new Date(Date.now() + 16 * 60_000).toISOString() };
		await advanceSafetyChecks(db, later);
		const dropped = await status();
		expect(dropped.runs[0]).toMatchObject({ status: 'failed', error: 'The safety check did not finish in time, so the new version is not on the web. Try publishing again.' });
		expect(routeOf('farm-log')).toMatchObject({ status: 'live', script: v2 });
		expect(stub.scripts.has(scriptNameFor(scope.projectId, 3))).toBe(false);
		expect([...stub.kv.keys()].filter((k) => k.includes('chk--'))).toEqual([]);
	});

	test('the off switch serves the takedown page at the app address; review brings it back unpublished', async () => {
		const outputId = await checkedBuild(ready(), { server: null, migrations: [] }, 'sha256:img-off');
		await approve((await status()).current!.intent);
		await publishApp(db, deps, scope, { outputId });
		expect(await takeDownApp(db, deps, scope.projectId, { by: 'operator-1', reason: 'Phishing page reported by visitors.' })).toBe(true);
		expect(routeOf('farm-log').status).toBe('blocked');
		expect((await status()).publication).toMatchObject({ status: 'blocked', blockedReason: 'Phishing page reported by visitors.' });
		expect(await restoreTakenDownApp(db, deps, scope.projectId, { by: 'operator-1' })).toBe(true);
		expect(routeOf('farm-log').status).toBe('paused');
		expect((await status()).publication).toMatchObject({ status: 'paused', blockedReason: null });
	});

	test('publishing needs a confirmed email address', async () => {
		const outputId = await checkedBuild(ready(), { server: null, migrations: [] }, 'sha256:img-email');
		await approve((await status()).current!.intent);
		sqlite.prepare('update "user" set "emailVerified" = 0 where "id" = ?').run('alice');
		await rejects(publishApp(db, deps, scope, { outputId }), 'EMAIL_NOT_VERIFIED');
		expect(stub.scripts.has(scriptNameFor(scope.projectId, 1))).toBe(false);
	});

	test('a judge account cannot publish and never sees the confirm-your-email message', async () => {
		const outputId = await checkedBuild(ready(), { server: null, migrations: [] }, 'sha256:img-judge');
		await approve((await status()).current!.intent);
		// A judge's `.invalid` address can never be confirmed, so the refusal
		// must come first and say the thing a judge can act on.
		sqlite.prepare('update "user" set "emailVerified" = 0 where "id" = ?').run('alice');
		sqlite
			.prepare('insert into "judge_accounts" ("judgeName","userId","state","createdAt","lastSignInAt") values (?,?,?,?,null)')
			.run('judge-one', 'alice', 'active', new Date().toISOString());
		const message = await rejects(publishApp(db, deps, scope, { outputId }), 'JUDGE_ACCOUNT');
		expect(message).toBe('Publishing is turned off for judge accounts. Everything else works the same.');
		expect(stub.scripts.has(scriptNameFor(scope.projectId, 1))).toBe(false);
		// Roll back is a publish-shaped action, so it is refused the same way.
		await rejects(rollbackApp(db, deps, scope, { outputId }), 'JUDGE_ACCOUNT');
	});

	test('addresses: chosen once, checked for look-alikes, never shared', async () => {
		const outputId = await checkedBuild(ready(), { server: null, migrations: [] }, 'sha256:img-slug');
		await approve((await status()).current!.intent);
		await rejects(publishApp(db, deps, scope, { outputId, slug: 'paypal-login' }), 'invalid_slug');
		await publishApp(db, deps, scope, { outputId, slug: 'Kano-Feed' });
		expect((await status()).publication!.slug).toBe('kano-feed');
		await rejects(publishApp(db, deps, scope, { outputId, slug: 'other-name' }), 'SLUG_LOCKED');

		const other = await readyProject('Kano Feed');
		const otherOutput = await checkedBuild(other, { server: null, migrations: [] }, 'sha256:img-other');
		const otherStatus = await getPublishStatus(db, { appsDomain: APPS, available: true }, other.scope);
		await recordDecision(db, 'alice', { intent: otherStatus.current!.intent, decision: 'approved' });
		await rejects(publishApp(db, deps, other.scope, { outputId: otherOutput, slug: 'kano-feed' }), 'SLUG_TAKEN');
	});
});

describe('publish rules', () => {
	test('address rules', () => {
		expect(checkSlug('farm-log')).toBe('farm-log');
		expect(checkSlug('  Kano2026 ')).toBe('kano2026');
		for (const bad of ['ab', 'a'.repeat(33), '-farm', 'farm-', 'farm--log', 'xn--80ak6aa92e', 'farm_log', 'farm.log', 'www', 'admin', 'login', 'my-paypal', 'g-o-o-g-l-e', 'gtbank-alerts', 'caddie-team']) {
			expect(() => checkSlug(bad)).toThrow(ScopeError);
		}
		expect(suggestSlug('Farm Log')).toBe('farm-log');
		expect(suggestSlug('Café Ñandú — Menu!')).toBe('cafe-nandu-menu');
		expect(suggestSlug('!!')).toMatch(/^my-app-[a-z0-9]+$/);
		expect(suggestSlug('PayPal helper')).toMatch(/^my-app-[a-z0-9]+$/);
	});

	test('what counts as deleting data', () => {
		expect(isDestructiveSql('drop table notes;')).toBe(true);
		expect(isDestructiveSql('ALTER TABLE notes DROP COLUMN tag;')).toBe(true);
		expect(isDestructiveSql("delete from notes where id = 1;")).toBe(true);
		expect(isDestructiveSql('create table notes (id integer);')).toBe(false);
		expect(isDestructiveSql('alter table notes add column tag text; -- never drop table here')).toBe(false);
		expect(isDestructiveSql('create index notes_tag on notes(tag);')).toBe(false);
		expect(destructiveMigrationIntent('p1', { name: '0003_x.sql', sha256: 'abc' })).toEqual({
			projectId: 'p1',
			action: 'destructive-database-change',
			resourceId: 'app:p1:0003_x.sql',
			revisionHash: 'abc',
			policyVersion: 'publish/2026-10-18',
		});
	});
});
