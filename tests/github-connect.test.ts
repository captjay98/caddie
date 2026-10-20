import { describe, expect, test } from 'bun:test';
import {
	CONNECT_TTL_MS,
	connectInstallUrl,
	connectState,
	readConnectState,
	returnLocation,
	safeReturnTo,
	setupOutcome,
} from '../apps/app/src/server/github-connect.ts';
import { GithubError } from '../apps/app/src/server/adapters/github.ts';
import { ScopeError } from '../apps/app/src/server/scope.ts';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { bindInstallation } from '../apps/app/src/server/repositories.ts';
import type { GithubRestClient } from '../apps/app/src/server/adapters/github.ts';

/**
 * Plan 6.1: GitHub connects in one click. GitHub sends the person back to the
 * App's Setup URL with `installation_id`, `setup_action` and the `state` the
 * install link carried. GitHub warns that `installation_id` can be spoofed, so
 * only a state Caddie signed for this same person may connect anything.
 */

const SECRET = 'unit-secret-0123456789abcdef0123456789abcdef';
const NOW = Date.parse('2026-10-20T04:00:00Z');
const REQUEST = { actorId: 'user-alice', workspaceId: 'ws-alice', returnTo: '/app/settings?project=p1&tab=github' };

function bindingWorld(linkedId: string | null = '101', accountType = 'User', providerAccountId = '101') {
	const sqlite = new Database(':memory:');
	for (const migration of ['0001_product.sql', '0006_github.sql']) {
		sqlite.exec(readFileSync(new URL(`../apps/app/migrations/${migration}`, import.meta.url), 'utf8'));
	}
	sqlite.exec(`insert into user values ('alice','Alice','alice@example.com',1,null,'now','now');
	 insert into workspaces values ('ws','Alice','now'),('other-ws','Other','now');
	 insert into workspace_memberships values ('m','ws','alice','owner','now'),('m2','other-ws','alice','owner','now');`);
	if (linkedId) sqlite.prepare('insert into account (id,accountId,providerId,userId,createdAt,updatedAt) values (?,?,?,?,?,?)').run('github-alice', linkedId, 'github', 'alice', 'now', 'now');
	function statement(sql: string, args: unknown[] = []) {
		return {
			bind: (...values: unknown[]) => statement(sql, values),
			all: async () => ({ results: sqlite.prepare(sql).all(...args as never[]) }),
			run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...args as never[]).changes } }),
		};
	}
	const db = { prepare: statement } as unknown as D1Database;
	const client = {
		config: { privateKeyPem: 'local-test-fingerprint-input' },
		getInstallation: async () => ({ installationId: '700', accountLogin: 'alice', accountId: providerAccountId, accountType, permissions: { contents: 'write', pull_requests: 'write' }, appSlug: 'caddie', suspended: false }),
	} as unknown as GithubRestClient;
	const scope = { actorId: 'alice', workspaceId: 'ws' };
	return { sqlite, db, client, scope };
}

describe('installation binding proves the actor owns the provider account', () => {
	test('a linked GitHub user can bind their personal installation and reconnect idempotently', async () => {
		const w = bindingWorld();
		const bound = await bindInstallation(w.db, w.client, w.scope, '700');
		expect(bound.installationId).toBe('700');
		expect((await bindInstallation(w.db, w.client, w.scope, '700')).installationId).toBe('700');
		expect(w.sqlite.query('select count(*) as n from github_installations').get()).toEqual({ n: 1 });
		await expect(bindInstallation(w.db, w.client, { ...w.scope, workspaceId: 'other-ws' }, '700')).rejects.toMatchObject({ code: 'installation_already_bound' });
		w.sqlite.close();
	});

	for (const [label, linkedId, type, accountId, code] of [
		['another GitHub user', '202', 'User', '101', 'installation_ownership_unverified'],
		['a Google-only account', null, 'User', '101', 'github_identity_required'],
		['an organisation', '101', 'Organization', '101', 'installation_ownership_unverified'],
		['missing provider identity metadata', '101', '', '', 'installation_ownership_unverified'],
	] as const) {
		test(`${label} cannot claim a new or webhook-recorded installation`, async () => {
			const w = bindingWorld(linkedId, type, accountId);
			await expect(bindInstallation(w.db, w.client, w.scope, '700')).rejects.toMatchObject({ code });
			expect(w.sqlite.query('select count(*) as n from github_installations').get()).toEqual({ n: 0 });
			w.sqlite.exec(`insert into github_installations values ('pending','700','alice','caddie','{}',null,null,'active','now','now')`);
			await expect(bindInstallation(w.db, w.client, w.scope, '700')).rejects.toMatchObject({ code });
			expect(w.sqlite.query('select workspaceId,boundBy from github_installations').get()).toEqual({ workspaceId: null, boundBy: null });
			w.sqlite.close();
		});
	}
});

describe("GitHub's return is Caddie's own request (plan 6.1)", () => {
	test('a state Caddie signed reads back as the same person, workspace and page', async () => {
		const state = await connectState(SECRET, REQUEST, NOW);
		expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(await readConnectState(SECRET, state, NOW + 60_000)).toEqual({ ...REQUEST, issuedAt: NOW });
	});

	test('a state that was changed, signed with another key, expired or never Caddie\u2019s reads as nothing', async () => {
		const state = await connectState(SECRET, REQUEST, NOW);
		const [body, mac] = state.split('.') as [string, string];
		// Someone swaps in their own workspace but keeps Caddie's signature.
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
		const forged = `${Buffer.from(JSON.stringify({ ...payload, w: 'ws-mallory' })).toString('base64url')}.${mac}`;
		expect(await readConnectState(SECRET, forged, NOW)).toBeNull();
		expect(await readConnectState('another-secret-0123456789abcdef0123456789', state, NOW)).toBeNull();
		expect(await readConnectState(SECRET, state, NOW + CONNECT_TTL_MS + 1)).toBeNull();
		for (const junk of [null, undefined, '', 'abc', 'a.b.c', `${body}.`, `.${mac}`, 42]) {
			expect(await readConnectState(SECRET, junk, NOW)).toBeNull();
		}
	});

	test('the page to come back to is always one of Caddie\u2019s own pages', async () => {
		expect(safeReturnTo('/app/projects?import=1')).toBe('/app/projects?import=1');
		expect(safeReturnTo('/app')).toBe('/app');
		for (const bad of [
			'//evil.example/app',
			'https://evil.example/app/',
			'/api/github/setup',
			'/application',
			'/app\\..\\x',
			'/app/\nx',
			'javascript:alert(1)',
			'',
			null,
			42,
			`/app/${'x'.repeat(400)}`,
		]) {
			expect(safeReturnTo(bad)).toBe('/app/');
		}
		// A page smuggled into the state is cleaned on the way in as well.
		const state = await connectState(SECRET, { ...REQUEST, returnTo: '//evil.example/app' }, NOW);
		expect((await readConnectState(SECRET, state, NOW))?.returnTo).toBe('/app/');
	});

	test('the install link carries the state; no slug, no link', async () => {
		const state = await connectState(SECRET, REQUEST, NOW);
		expect(connectInstallUrl({ GITHUB_APP_SLUG: 'caddie-forge' }, state)).toBe(
			`https://github.com/apps/caddie-forge/installations/new?state=${state}`,
		);
		expect(connectInstallUrl({}, state)).toBeNull();
		expect(connectInstallUrl({ GITHUB_APP_SLUG: '../evil' }, state)).toBeNull();
	});

	test('coming back keeps the page\u2019s own address and adds the outcome', () => {
		expect(returnLocation('/app/settings?project=p1', 'connected')).toBe('/app/settings?project=p1&github=connected');
		expect(returnLocation('/app/', 'expired')).toBe('/app/?github=expired');
		expect(returnLocation('/app/runs?github=old&project=p2', 'connected')).toBe('/app/runs?github=connected&project=p2');
		expect(returnLocation('//evil.example/', 'connected')).toBe('/app/?github=connected');
	});

	test('a refused connection comes back as one plain outcome, never raw error text', () => {
		expect(setupOutcome(new ScopeError(404, 'installation_not_found', 'x'))).toBe('not_found');
		expect(setupOutcome(new ScopeError(409, 'installation_already_bound', 'x'))).toBe('already_bound');
		expect(setupOutcome(new ScopeError(409, 'installation_suspended', 'x'))).toBe('suspended');
		expect(setupOutcome(new ScopeError(409, 'installation_missing_permissions', 'x'))).toBe('missing_permissions');
		expect(setupOutcome(new ScopeError(403, 'github_identity_required', 'x'))).toBe('github_identity_required');
		expect(setupOutcome(new ScopeError(403, 'installation_ownership_unverified', 'x'))).toBe('installation_ownership_unverified');
		expect(setupOutcome(new GithubError(503, 'GITHUB_NOT_CONFIGURED', 'x'))).toBe('not_configured');
		expect(setupOutcome(new ScopeError(403, 'not_a_member', 'x'))).toBe('failed');
		expect(setupOutcome(new Error('boom'))).toBe('failed');
	});
});
