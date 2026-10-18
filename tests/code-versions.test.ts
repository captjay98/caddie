import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import type { CodeFile } from '../apps/app/src/server/code-store.ts';
import { LocalCodeStore, getCodeVersion, listCodeVersions, readVersionFiles, recordCodeVersion } from '../apps/app/src/server/code-versions.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { allMigrationPaths } from './fixtures/migrations.ts';
import { splitSqlStatements } from './fixtures/controls-harness.ts';
import { runCodeStoreContract } from './fixtures/code-store-contract.ts';

/**
 * The LOCAL (D1-backed) code store and the code-versions service.
 *
 * Classification: LOCAL VERIFIED against the real production migrations over
 * SQLite (D1-shaped). The local store is the CodeStore used whenever
 * Cloudflare Artifacts is not configured; it runs the same shared contract as
 * the Artifacts adapter, so both backends are proven to behave identically.
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

function migrate(sqlite: Database): void {
	for (const path of allMigrationPaths()) {
		for (const statement of splitSqlStatements(readFileSync(path, 'utf8'))) sqlite.exec(statement);
	}
}

function f(path: string, text: string): CodeFile {
	return { path, contentBase64: Buffer.from(text, 'utf8').toString('base64') };
}

// --- the shared contract, local backend --------------------------------------

runCodeStoreContract('LocalCodeStore', async () => {
	const sqlite = new Database(':memory:');
	migrate(sqlite);
	return {
		store: new LocalCodeStore(d1Adapter(sqlite)),
		cleanup: async () => sqlite.close(),
	};
});

// --- the versions service -----------------------------------------------------

describe('code versions service', () => {
	let sqlite: Database;
	let db: D1Database;
	let store: LocalCodeStore;
	let scope: Scope;

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		migrate(sqlite);
		db = d1Adapter(sqlite);
		store = new LocalCodeStore(db);
		const now = new Date().toISOString();
		sqlite
			.prepare('insert into "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") values (?,?,?,?,?,?,?)')
			.run('user-1', 'Ada', 'ada@example.com', 1, null, now, now);
		const ws = await createWorkspace(db, 'user-1', { name: 'W' });
		const wsScope = await workspaceScopeForUser(db, 'user-1', ws.id);
		const project = await createProject(db, wsScope, { workspaceId: ws.id, name: 'FarmLog', description: 'track the farm' });
		scope = await projectScopeForUser(db, 'user-1', project.id);
	});

	afterEach(() => sqlite.close());

	const record = (kind: 'feature' | 'build' | 'restore' | 'import', title: string, files: CodeFile[], extra: Record<string, unknown> = {}) =>
		recordCodeVersion(db, store, scope, { kind, title, files, actorId: 'user-1', ...extra });

	test('each save point is a version, newest first', async () => {
		const v1 = await record('feature', 'Added the home screen', [f('src/App.tsx', 'one')]);
		expect(v1.created).toBe(true);
		expect(v1.version.seq).toBe(1);
		const v2 = await record('feature', 'Added a list', [f('src/App.tsx', 'two'), f('src/list.tsx', 'list')]);
		expect(v2.version.seq).toBe(2);
		const list = await listCodeVersions(db, scope);
		expect(list.map((v) => v.title)).toEqual(['Added a list', 'Added the home screen']);
		expect(list[0]!.fileCount).toBe(2);
	});

	test('an unchanged snapshot does not make a second version, but links the build output', async () => {
		const feature = await record('feature', 'Built the thing', [f('src/App.tsx', 'same')]);
		const build = await record('build', 'Checked build', [f('src/App.tsx', 'same')], { outputId: 'out-9', image: 'img:1' });
		expect(build.created).toBe(false);
		expect(build.version.commitId).toBe(feature.version.commitId);
		expect(build.version.outputId).toBe('out-9');
		expect(await listCodeVersions(db, scope)).toHaveLength(1);
	});

	test('restoring an old version reads its exact files', async () => {
		const v1 = await record('feature', 'v1', [f('src/App.tsx', 'original'), f('src/gone.tsx', 'bye')]);
		await record('feature', 'v2', [f('src/App.tsx', 'changed')]);
		const files = await readVersionFiles(store, scope.projectId, v1.version.commitId);
		const asText = Object.fromEntries(files.map((file) => [file.path, Buffer.from(file.contentBase64, 'base64').toString('utf8')]));
		expect(asText).toEqual({ 'src/App.tsx': 'original', 'src/gone.tsx': 'bye' });
	});

	test('a version carries the sandbox image and plan for a fast restore', async () => {
		const v = await record('feature', 'has an image', [f('src/App.tsx', 'x')], { image: 'img:abc', planId: 'plan-1', featureId: 'feat-1' });
		const full = await getCodeVersion(db, scope, v.version.commitId);
		expect(full).toMatchObject({ image: 'img:abc', planId: 'plan-1', featureId: 'feat-1', hasImage: true });
	});

	test('another project cannot read this project version', async () => {
		const v = await record('feature', 'secret', [f('src/App.tsx', 'x')]);
		const other = await createProject(db, await workspaceScopeForUser(db, 'user-1', scope.workspaceId), {
			workspaceId: scope.workspaceId,
			name: 'Other',
			description: 'd',
		});
		const otherScope = await projectScopeForUser(db, 'user-1', other.id);
		await expect(getCodeVersion(db, otherScope, v.version.commitId)).rejects.toThrow();
	});
});
