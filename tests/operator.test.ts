import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { AppRoute } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import type { AppHost } from '../apps/app/src/server/app-host.ts';
import { fileAbuseReport, listAbuseReports } from '../apps/app/src/server/abuse-reports.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import type { PublishDeps } from '../apps/app/src/server/publish.ts';
import { createOperatorRouter } from '../apps/app/src/server/routes/operator.ts';
import { workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * The operator's review page. LOCAL VERIFIED in-process (router, real
 * migrations over SQLite); the hosting side is a recorder of route writes
 * (the real adapter is covered by the publish and contract suites).
 */

const ORIGIN = 'https://caddie.example.com';

describe('operator page', () => {
	let sqlite: Database;
	let db: D1Database;
	let projectId = '';
	let routes: Array<[string, AppRoute]>;
	let actor: { id: string; email: string } | null;

	const deps = (): PublishDeps => ({
		host: { putRoute: async (host: string, route: AppRoute) => void routes.push([host, route]) } as unknown as AppHost,
		appsDomain: 'caddieapps.com',
		keyring: null,
		probe: async () => 200,
	});
	const router = createOperatorRouter({ actorFor: async () => actor, depsFor: async () => deps() });
	const env = () => ({ DB: db, OPERATOR_EMAILS: 'Ops@Example.com, second@example.com', APPS_DOMAIN: 'caddieapps.com' }) as never;
	const post = (path: string, fields: Record<string, string> = {}, origin = ORIGIN) =>
		router.request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(fields).toString() }, env());

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		projectId = (await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Farm', description: 'x' })).id;
		const now = new Date().toISOString();
		sqlite
			.prepare('insert into app_publications (projectId, slug, script, status, outputId, manifestSha256, hasServer, appliedMigrations, publishedBy, publishedAt, createdAt, updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?)')
			.run(projectId, 'farm-log', 'app-farm-1', 'live', 'out_1', 'sha', 0, '{}', 'owner-1', now, now, now);
		await fileAbuseReport(db, { slug: 'farm-log', source: 'visitor', category: 'phishing', details: 'Asks for bank <PIN>.', reporterEmail: 'v@example.com' });
		routes = [];
		actor = { id: 'ops-1', email: 'ops@example.com' };
	});

	afterEach(() => sqlite.close());

	test('only operators get in', async () => {
		actor = null;
		expect((await router.request(`${ORIGIN}/operator/reports`, {}, env())).status).toBe(401);
		actor = { id: 'owner-1', email: 'owner@example.com' };
		expect((await router.request(`${ORIGIN}/operator/reports`, {}, env())).status).toBe(403);
		expect((await post(`/operator/apps/${projectId}/takedown`, { reason: 'x' })).status).toBe(403);
		expect(routes).toEqual([]);
	});

	test('the open report is listed, escaped, with the app and its actions', async () => {
		const res = await router.request(`${ORIGIN}/operator/reports`, {}, env());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
		const html = await res.text();
		expect(html).toContain('Open (1)');
		expect(html).toContain('href="https://farm-log.caddieapps.com/"');
		expect(html).toContain('Asks for bank &lt;PIN&gt;.');
		expect(html).toContain('Take the app down');
		expect(html).not.toContain('<script');
	});

	test('take down from a report: the address shows the takedown page and the report is handled; restore brings it back unpublished', async () => {
		const [report] = await listAbuseReports(db, { status: 'open' });
		const down = await post(`/operator/apps/${projectId}/takedown`, { reason: 'Phishing for bank PINs.', report: report!.id });
		expect(down.status).toBe(303);
		expect(down.headers.get('location')).toContain('/operator/reports?done=');
		expect(routes.map(([host, route]) => [host, route.status, route.script])).toEqual([['farm-log.caddieapps.com', 'blocked', 'app-farm-1']]);
		expect(sqlite.prepare('select status, blockedReason, blockedBy from app_publications').get()).toEqual({ status: 'blocked', blockedReason: 'Phishing for bank PINs.', blockedBy: 'ops-1' });
		expect((await listAbuseReports(db))[0]).toMatchObject({ status: 'actioned', resolution: 'Taken down: Phishing for bank PINs.' });

		const restored = await post(`/operator/apps/${projectId}/restore`);
		expect(restored.status).toBe(303);
		expect(routes.at(-1)![1].status).toBe('paused');
		expect(sqlite.prepare('select status, blockedReason from app_publications').get()).toEqual({ status: 'paused', blockedReason: null });
	});

	test('dismiss, and forms from other sites are refused', async () => {
		const [report] = await listAbuseReports(db, { status: 'open' });
		expect((await post(`/operator/reports/${report!.id}/resolve`, { status: 'dismissed' }, 'https://evil.example')).status).toBe(403);
		expect((await listAbuseReports(db, { status: 'open' })).length).toBe(1);
		expect((await post(`/operator/reports/${report!.id}/resolve`, { status: 'dismissed' })).status).toBe(303);
		expect((await listAbuseReports(db, { status: 'open' })).length).toBe(0);
		expect((await listAbuseReports(db, { status: 'dismissed' })).length).toBe(1);
	});
});
