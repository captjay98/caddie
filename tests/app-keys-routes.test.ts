import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { requestAppSecret, resolveAppSecrets } from '../apps/app/src/server/app-secrets.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { createAppKeysRouter } from '../apps/app/src/server/routes/app-keys.ts';
import { ScopeError, projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { parseKeyring } from '../apps/app/src/server/secret-box.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * The app-keys HTTP surface. LOCAL VERIFIED in-process (Hono router, real
 * migrations over SQLite, real sealing). The session step is substituted by a
 * resolver over the same membership rows (x-test-user header); the verified
 * session path itself is covered by the auth suites.
 */

const KEYRING = `k1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;
const VALUE = 'ow_3c2b1a-not-a-real-key';

describe('app keys routes', () => {
	let sqlite: Database;
	let db: D1Database;
	let projectId = '';

	const router = createAppKeysRouter({
		scopeFor: async (env, request, id) => {
			const user = request.headers.get('x-test-user');
			if (!user) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
			return projectScopeForUser(env.DB, user, id);
		},
	});

	const call = (path: string, init: RequestInit & { user?: string } = {}, keys: string | null = KEYRING) => {
		const headers = new Headers(init.headers);
		if (init.user !== undefined) headers.set('x-test-user', init.user);
		else headers.set('x-test-user', 'owner-1');
		const env = keys === null ? { DB: db } : { DB: db, APP_SECRETS_KEYS: keys };
		return router.request(path, { ...init, headers }, env as never);
	};
	const put = (name: string, body: unknown, extra: RequestInit & { user?: string } = {}, keys: string | null = KEYRING) =>
		call(`/projects/${projectId}/keys/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...extra }, keys);

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		addUser(sqlite, 'stranger', 'stranger@example.com');
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		const project = await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Weather', description: 'x' });
		projectId = project.id;
	});

	afterEach(() => sqlite.close());

	test('set then list: the value never comes back, and nothing is cached', async () => {
		await requestAppSecret(db, await projectScopeForUser(db, 'owner-1', projectId), { name: 'WEATHER_API_KEY', description: 'Reads the forecast.' });
		const saved = await put('WEATHER_API_KEY', { value: VALUE });
		expect(saved.status).toBe(200);
		expect(saved.headers.get('cache-control')).toBe('no-store');
		const savedText = await saved.text();
		expect(savedText).not.toContain(VALUE);
		expect(JSON.parse(savedText).key).toMatchObject({ name: 'WEATHER_API_KEY', status: 'set', requested: true });

		const listed = await call(`/projects/${projectId}/keys`);
		expect(listed.status).toBe(200);
		expect(listed.headers.get('cache-control')).toBe('no-store');
		const listedText = await listed.text();
		expect(listedText).not.toContain(VALUE);
		expect(listedText).not.toContain('v1.k1.');
		expect(JSON.parse(listedText)).toMatchObject({ configured: true, keys: [{ name: 'WEATHER_API_KEY', status: 'set' }] });

		const resolved = await resolveAppSecrets(db, await parseKeyring(KEYRING), projectId);
		expect(resolved.values).toEqual({ WEATHER_API_KEY: VALUE });
	});

	test('remove: a requested key goes back to needed, an own key disappears', async () => {
		await requestAppSecret(db, await projectScopeForUser(db, 'owner-1', projectId), { name: 'WEATHER_API_KEY', description: 'Reads the forecast.' });
		await put('WEATHER_API_KEY', { value: VALUE });
		await put('MY_KEY', { value: 'mine' });
		const back = await call(`/projects/${projectId}/keys/WEATHER_API_KEY`, { method: 'DELETE' });
		expect(await back.json()).toMatchObject({ key: { name: 'WEATHER_API_KEY', status: 'requested' } });
		const gone = await call(`/projects/${projectId}/keys/MY_KEY`, { method: 'DELETE' });
		expect(await gone.json()).toEqual({ key: null });
		const missing = await call(`/projects/${projectId}/keys/MY_KEY`, { method: 'DELETE' });
		expect(missing.status).toBe(404);
	});

	test('a server without a keyring lists keys but refuses to store one, in plain words', async () => {
		const listed = await call(`/projects/${projectId}/keys`, {}, null);
		expect(await listed.json()).toEqual({ configured: false, keys: [] });
		const refused = await put('WEATHER_API_KEY', { value: VALUE }, {}, '');
		expect(refused.status).toBe(503);
		expect(await refused.json()).toEqual({ error: 'keys_unavailable', message: "Saving keys isn't set up on this Caddie server yet." });
		const broken = await put('WEATHER_API_KEY', { value: VALUE }, {}, 'k1:tooshort');
		expect(broken.status).toBe(503);
		expect(await broken.text()).not.toContain('tooshort');
	});

	test('writes need a JSON body of a sane size; bad names are refused', async () => {
		const form = await call(`/projects/${projectId}/keys/WEATHER_API_KEY`, { method: 'PUT', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `value=${VALUE}` });
		expect(form.status).toBe(415);
		const huge = await put('WEATHER_API_KEY', { value: 'x'.repeat(20 * 1024) });
		expect(huge.status).toBe(413);
		const badName = await put('weather', { value: VALUE });
		expect(badName.status).toBe(400);
		const notObject = await call(`/projects/${projectId}/keys/WEATHER_API_KEY`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '"just a string"' });
		expect(notObject.status).toBe(400);
		expect((await call(`/projects/${projectId}/keys`)).status).toBe(200);
		expect(await (await call(`/projects/${projectId}/keys`)).json()).toMatchObject({ keys: [] });
	});

	test('strangers and anonymous callers are refused', async () => {
		expect((await call(`/projects/${projectId}/keys`, { user: 'stranger' })).status).toBe(403);
		expect((await put('WEATHER_API_KEY', { value: VALUE }, { user: 'stranger' })).status).toBe(403);
		expect((await call(`/projects/${projectId}/keys/WEATHER_API_KEY`, { method: 'DELETE', user: 'stranger' })).status).toBe(403);
		expect((await call(`/projects/${projectId}/keys`, { user: '' })).status).toBe(401);
		expect((await resolveAppSecrets(db, await parseKeyring(KEYRING), projectId)).values).toEqual({});
	});
});
