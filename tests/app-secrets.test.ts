import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import {
	deleteAppSecret,
	listAppSecrets,
	requestAppSecret,
	resolveAppSecrets,
	rotateAppSecrets,
	setAppSecret,
} from '../apps/app/src/server/app-secrets.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { ScopeError, projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { parseKeyring, type Keyring } from '../apps/app/src/server/secret-box.ts';
import { allMigrationPaths } from './fixtures/migrations.ts';
import { splitSqlStatements } from './fixtures/controls-harness.ts';

/**
 * App keys service (migration 0027). LOCAL VERIFIED over the real production
 * migrations on SQLite (D1-shaped) with real WebCrypto sealing.
 */

function d1Adapter(sqlite: Database): D1Database {
	function statement(sql: string, args: unknown[] = []) {
		return {
			bind(...values: unknown[]) {
				return statement(sql, values);
			},
			all() {
				return { results: sqlite.prepare(sql).all(...(args as never[])), meta: {} };
			},
			first() {
				return sqlite.prepare(sql).get(...(args as never[])) ?? null;
			},
			run() {
				const result = sqlite.prepare(sql).run(...(args as never[]));
				return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
			},
		};
	}
	return {
		prepare: statement,
		batch(statements: { run(): unknown }[]) {
			return sqlite.transaction(() => statements.map((stmt) => stmt.run()))();
		},
		exec(sql: string) {
			sqlite.exec(sql);
		},
	} as unknown as D1Database;
}

const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

async function errorOf(run: () => Promise<unknown>): Promise<{ status: number; code: string }> {
	try {
		await run();
	} catch (error) {
		if (error instanceof ScopeError) return { status: error.status, code: error.code };
		throw error;
	}
	return { status: 0, code: 'no error' };
}

const WEATHER = 'wk_9f8e7d6c5b4a-not-real';

describe('app keys service', () => {
	let sqlite: Database;
	let db: D1Database;
	let scope: Scope;
	let keyring: Keyring;
	let k1: string;

	const addUser = (id: string, email: string) => {
		const now = new Date().toISOString();
		sqlite
			.prepare('insert into "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") values (?,?,?,?,?,?,?)')
			.run(id, id, email, 1, null, now, now);
	};

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		for (const path of allMigrationPaths()) {
			for (const statement of splitSqlStatements(readFileSync(path, 'utf8'))) sqlite.exec(statement);
		}
		db = d1Adapter(sqlite);
		addUser('owner-1', 'owner@example.com');
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		const project = await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Weather', description: 'rain alerts' });
		scope = await projectScopeForUser(db, 'owner-1', project.id);
		k1 = randomKey();
		keyring = await parseKeyring(`k1:${k1}`);
	});

	afterEach(() => sqlite.close());

	test('the builder asks for a key, the owner sets it, and nothing ever lists the value', async () => {
		const asked = await requestAppSecret(db, scope, {
			name: 'WEATHER_API_KEY',
			description: 'Lets the app read the forecast from OpenWeather.',
			helpUrl: 'https://home.openweathermap.org/api_keys',
		});
		expect(asked).toMatchObject({ name: 'WEATHER_API_KEY', status: 'requested', requested: true, helpUrl: 'https://home.openweathermap.org/api_keys' });

		const set = await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: `  ${WEATHER}\n` });
		expect(set).toMatchObject({ status: 'set', requested: true, description: 'Lets the app read the forecast from OpenWeather.' });

		const listed = await listAppSecrets(db, scope);
		expect(listed).toHaveLength(1);
		const serialized = JSON.stringify(listed);
		expect(serialized).not.toContain(WEATHER);
		expect(serialized).not.toContain('v1.k1.');
		expect(Object.keys(listed[0]!).sort()).toEqual(['createdAt', 'description', 'helpUrl', 'name', 'requested', 'status', 'updatedAt']);

		// At rest: only the sealed envelope, never the plaintext.
		const raw = sqlite.prepare('select * from "app_secrets"').all();
		expect(JSON.stringify(raw)).not.toContain(WEATHER);
		expect((raw[0] as { envelope: string }).envelope).toMatch(/^v1\.k1\./);
	});

	test('resolve opens set keys only, trimmed, and reports keys still missing', async () => {
		await requestAppSecret(db, scope, { name: 'MAPS_KEY', description: 'Shows the map.' });
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: ` ${WEATHER} ` });
		const resolved = await resolveAppSecrets(db, keyring, scope.projectId);
		expect(resolved.values).toEqual({ WEATHER_API_KEY: WEATHER });
		expect(resolved.missing).toEqual(['MAPS_KEY']);
		expect(resolved.unreadable).toEqual([]);
	});

	test('setting again replaces the value; a request never touches a set key', async () => {
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: 'first' });
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: 'second' });
		const again = await requestAppSecret(db, scope, { name: 'WEATHER_API_KEY', description: 'Overwrite attempt' });
		expect(again.status).toBe('set');
		expect((await resolveAppSecrets(db, keyring, scope.projectId)).values).toEqual({ WEATHER_API_KEY: 'second' });
		expect((await listAppSecrets(db, scope))[0]!.description).toBeNull();
	});

	test('names, values and help links are checked', async () => {
		for (const name of ['weather', 'W', '1KEY', 'KEY-NAME', 'DB', 'ASSETS', 'CADDIE', 'CADDIE_TOKEN', 'A'.repeat(65)]) {
			expect(await errorOf(() => setAppSecret(db, keyring, scope, { name, value: 'x' }))).toEqual({ status: 400, code: 'invalid_input' });
		}
		expect(await errorOf(() => setAppSecret(db, keyring, scope, { name: 'OK_KEY', value: '   ' }))).toEqual({ status: 400, code: 'invalid_input' });
		expect(await errorOf(() => setAppSecret(db, keyring, scope, { name: 'OK_KEY', value: 'x'.repeat(8 * 1024 + 1) }))).toEqual({ status: 400, code: 'invalid_input' });
		expect(await errorOf(() => setAppSecret(db, keyring, scope, { name: 'OK_KEY', value: 42 }))).toEqual({ status: 400, code: 'invalid_input' });
		for (const helpUrl of ['http://example.com/keys', 'javascript:alert(1)', 'https://user:pass@example.com/', 'not a url']) {
			expect(await errorOf(() => requestAppSecret(db, scope, { name: 'OK_KEY', description: 'x', helpUrl }))).toEqual({ status: 400, code: 'invalid_input' });
		}
		expect(await errorOf(() => requestAppSecret(db, scope, { name: 'OK_KEY', description: '  ' }))).toEqual({ status: 400, code: 'invalid_input' });
		expect(await listAppSecrets(db, scope)).toEqual([]);
	});

	test('removing a requested key keeps the request; removing anything else deletes it', async () => {
		await requestAppSecret(db, scope, { name: 'WEATHER_API_KEY', description: 'Forecast.' });
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: WEATHER });
		await setAppSecret(db, keyring, scope, { name: 'MY_OWN_KEY', value: 'mine' });

		const back = await deleteAppSecret(db, scope, 'WEATHER_API_KEY');
		expect(back).toMatchObject({ name: 'WEATHER_API_KEY', status: 'requested', description: 'Forecast.' });
		expect(await deleteAppSecret(db, scope, 'MY_OWN_KEY')).toBeNull();
		expect((await resolveAppSecrets(db, keyring, scope.projectId)).values).toEqual({});
		expect((await listAppSecrets(db, scope)).map((k) => `${k.name}:${k.status}`)).toEqual(['WEATHER_API_KEY:requested']);

		expect(await deleteAppSecret(db, scope, 'WEATHER_API_KEY')).toBeNull();
		expect(await listAppSecrets(db, scope)).toEqual([]);
		expect(await errorOf(() => deleteAppSecret(db, scope, 'WEATHER_API_KEY'))).toEqual({ status: 404, code: 'key_not_found' });
	});

	test('a key copied into another project does not open there', async () => {
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: WEATHER });
		const ws2 = await createWorkspace(db, 'owner-1', { name: 'W2' });
		const other = await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws2.id), { workspaceId: ws2.id, name: 'Other', description: 'x' });
		sqlite.exec(
			`insert into "app_secrets" select '${other.id}', "name", "status", "envelope", "keyId", "description", "helpUrl", "requestedBy", "updatedBy", "createdAt", "updatedAt" from "app_secrets" where "projectId" = '${scope.projectId}'`,
		);
		const stolen = await resolveAppSecrets(db, keyring, other.id);
		expect(stolen.values).toEqual({});
		expect(stolen.unreadable).toEqual(['WEATHER_API_KEY']);
	});

	test('rotation re-seals with the new key; afterwards the old key can be dropped', async () => {
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: WEATHER });
		await setAppSecret(db, keyring, scope, { name: 'MAPS_KEY', value: 'maps' });
		const before = sqlite.prepare('select "updatedAt" from "app_secrets" order by "name"').all();

		const k2 = randomKey();
		const both = await parseKeyring(`k2:${k2},k1:${k1}`);
		expect((await resolveAppSecrets(db, both, scope.projectId)).values).toEqual({ MAPS_KEY: 'maps', WEATHER_API_KEY: WEATHER });
		expect(await rotateAppSecrets(db, both, { limit: 1 })).toEqual({ resealed: 1, failed: 0, remaining: true });
		expect(await rotateAppSecrets(db, both)).toEqual({ resealed: 1, failed: 0, remaining: false });
		expect(await rotateAppSecrets(db, both)).toEqual({ resealed: 0, failed: 0, remaining: false });

		const onlyNew = await parseKeyring(`k2:${k2}`);
		expect((await resolveAppSecrets(db, onlyNew, scope.projectId)).values).toEqual({ MAPS_KEY: 'maps', WEATHER_API_KEY: WEATHER });
		expect(sqlite.prepare('select "updatedAt" from "app_secrets" order by "name"').all()).toEqual(before);

		// A server that lost the key entirely reports the key as unreadable, not as a crash.
		const lost = await resolveAppSecrets(db, await parseKeyring(`k3:${randomKey()}`), scope.projectId);
		expect(lost.unreadable).toEqual(['MAPS_KEY', 'WEATHER_API_KEY']);
	});

	test('non-members are refused everything; a non-owner member may list and ask but not set or remove', async () => {
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: WEATHER });
		addUser('stranger', 'stranger@example.com');
		const forged: Scope = { ...scope, actorId: 'stranger' };
		for (const run of [
			() => listAppSecrets(db, forged),
			() => requestAppSecret(db, forged, { name: 'X_KEY', description: 'x' }),
			() => setAppSecret(db, keyring, forged, { name: 'WEATHER_API_KEY', value: 'mine now' }),
			() => deleteAppSecret(db, forged, 'WEATHER_API_KEY'),
		]) {
			expect(await errorOf(run)).toEqual({ status: 403, code: 'not_a_member' });
		}

		addUser('helper', 'helper@example.com');
		sqlite
			.prepare('insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values (?,?,?,?,?)')
			.run('mem-helper', scope.workspaceId, 'helper', 'member', new Date().toISOString());
		const member = await projectScopeForUser(db, 'helper', scope.projectId);
		expect((await listAppSecrets(db, member)).map((k) => k.name)).toEqual(['WEATHER_API_KEY']);
		expect((await requestAppSecret(db, member, { name: 'MAPS_KEY', description: 'Map tiles.' })).status).toBe('requested');
		expect(await errorOf(() => setAppSecret(db, keyring, member, { name: 'WEATHER_API_KEY', value: 'mine now' }))).toEqual({ status: 403, code: 'not_project_owner' });
		expect(await errorOf(() => deleteAppSecret(db, member, 'WEATHER_API_KEY'))).toEqual({ status: 403, code: 'not_project_owner' });
		expect((await resolveAppSecrets(db, keyring, scope.projectId)).values).toEqual({ WEATHER_API_KEY: WEATHER });
	});
});
