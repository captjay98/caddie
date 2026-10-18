import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { AppRoute } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import type { AppHost } from '../apps/app/src/server/app-host.ts';
import { listAbuseReports } from '../apps/app/src/server/abuse-reports.ts';
import { WebRiskError, createWebRisk } from '../apps/app/src/server/adapters/web-risk.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { recheckLiveApps, type PublishDeps } from '../apps/app/src/server/publish.ts';
import { workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * Google Web Risk and the daily recheck of live apps. SIMULATED provider: the
 * adapter talks to a recording fake fetch (request shape checked against
 * Google's REST reference); the recheck runs on the real migrations over
 * SQLite with a recorder for route writes.
 */

describe('Web Risk adapter', () => {
	test('asks for all three lists with the key in a header, and reads the answer', async () => {
		const seen: Request[] = [];
		const client = createWebRisk({
			apiKey: 'wr-key-123',
			fetch: async (request) => {
				seen.push(request);
				return Response.json(new URL(request.url).searchParams.get('uri')!.includes('bad') ? { threat: { threatTypes: ['SOCIAL_ENGINEERING'], expireTime: '2026-10-19T00:00:00Z' } } : {});
			},
		});
		expect(await client.lookup('https://farm-log.caddieapps.com/')).toEqual({ threats: [] });
		expect(await client.lookup('https://bad.caddieapps.com/')).toEqual({ threats: ['SOCIAL_ENGINEERING'] });
		const url = new URL(seen[0]!.url);
		expect(url.origin + url.pathname).toBe('https://webrisk.googleapis.com/v1/uris:search');
		expect(url.searchParams.getAll('threatTypes')).toEqual(['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE']);
		expect(url.searchParams.get('uri')).toBe('https://farm-log.caddieapps.com/');
		expect(seen[0]!.url).not.toContain('wr-key-123');
		expect(seen[0]!.headers.get('x-goog-api-key')).toBe('wr-key-123');
	});

	test('failures are typed', async () => {
		const answer = (status: number) => createWebRisk({ apiKey: 'k', fetch: async () => new Response('{}', { status }) });
		for (const [status, code] of [[403, 'UNAUTHORIZED'], [429, 'RATE_LIMITED'], [500, 'UPSTREAM']] as const) {
			try {
				await answer(status).lookup('https://x.caddieapps.com/');
				throw new Error('expected a failure');
			} catch (error) {
				expect(error).toBeInstanceOf(WebRiskError);
				expect((error as WebRiskError).code).toBe(code);
			}
		}
	});
});

describe('daily recheck of live apps', () => {
	let sqlite: Database;
	let db: D1Database;
	let routes: Array<[string, AppRoute]>;
	let inbox: string[];
	let clock: number;
	const projects: string[] = [];

	const deps = (): PublishDeps => ({
		host: { putRoute: async (host: string, route: AppRoute) => void routes.push([host, route]) } as unknown as AppHost,
		appsDomain: 'caddieapps.com',
		keyring: null,
		probe: async () => 200,
		notifyOperator: async (subject) => {
			inbox.push(subject);
			return true;
		},
		now: () => new Date(clock).toISOString(),
	});

	async function liveApp(slug: string): Promise<string> {
		const ws = await createWorkspace(db, 'owner-1', { name: slug });
		const id = (await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: slug, description: 'x' })).id;
		const at = new Date(clock).toISOString();
		sqlite
			.prepare('insert into app_publications (projectId, slug, script, status, outputId, manifestSha256, hasServer, appliedMigrations, publishedBy, publishedAt, createdAt, updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?)')
			.run(id, slug, `app-${slug}-1`, 'live', 'out_1', `sha-${slug}`, 0, '{}', 'owner-1', at, at, at);
		projects.push(id);
		return id;
	}

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		routes = [];
		inbox = [];
		clock = Date.parse('2026-10-18T12:00:00.000Z');
	});

	afterEach(() => sqlite.close());

	test('a listed app is taken down and reported; clean apps are not looked up again for a day', async () => {
		const good = await liveApp('farm-log');
		const bad = await liveApp('free-prizes');
		const lookups: string[] = [];
		const webRisk = { lookup: async (url: string) => (lookups.push(url), { threats: url.includes('free-prizes') ? ['SOCIAL_ENGINEERING'] : [] }) };

		expect(await recheckLiveApps(db, deps(), webRisk)).toEqual({ checked: 2, flagged: 1, failed: 0 });
		expect(routes.map(([host, route]) => [host, route.status])).toEqual([['free-prizes.caddieapps.com', 'blocked']]);
		expect(sqlite.prepare('select projectId, status, blockedBy from app_publications order by slug').all()).toEqual([
			{ projectId: good, status: 'live', blockedBy: null },
			{ projectId: bad, status: 'blocked', blockedBy: 'web-risk' },
		]);
		expect((await listAbuseReports(db)).map((r) => [r.slug, r.source, r.category])).toEqual([['free-prizes', 'web-risk', 'phishing']]);
		expect(inbox).toEqual(['[Caddie abuse] phishing report for free-prizes (web-risk)']);
		expect(sqlite.prepare("select status from app_safety_checks where kind = 'web-risk' order by status").all()).toEqual([{ status: 'clean' }, { status: 'flagged' }]);

		// The next tick, an hour later: nothing is due.
		clock += 60 * 60_000;
		expect(await recheckLiveApps(db, deps(), webRisk)).toEqual({ checked: 0, flagged: 0, failed: 0 });
		// A day later the live app is checked again; the taken-down one is not.
		clock += 24 * 60 * 60_000;
		lookups.length = 0;
		expect(await recheckLiveApps(db, deps(), webRisk)).toEqual({ checked: 1, flagged: 0, failed: 0 });
		expect(lookups).toEqual(['https://farm-log.caddieapps.com/']);
	});

	test('a failed lookup leaves the app up and is retried in about an hour, not tomorrow', async () => {
		await liveApp('farm-log');
		let fail = true;
		const webRisk = {
			lookup: async () => {
				if (fail) throw new WebRiskError('UPSTREAM', 'Web Risk HTTP 503');
				return { threats: [] };
			},
		};
		expect(await recheckLiveApps(db, deps(), webRisk)).toEqual({ checked: 0, flagged: 0, failed: 1 });
		expect(routes).toEqual([]);
		expect(sqlite.prepare("select status, detail from app_safety_checks where kind = 'web-risk'").get()).toEqual({ status: 'error', detail: 'Web Risk HTTP 503' });
		clock += 30 * 60_000;
		expect(await recheckLiveApps(db, deps(), webRisk)).toEqual({ checked: 0, flagged: 0, failed: 0 });
		clock += 31 * 60_000;
		fail = false;
		expect(await recheckLiveApps(db, deps(), webRisk)).toEqual({ checked: 1, flagged: 0, failed: 0 });
	});
});
