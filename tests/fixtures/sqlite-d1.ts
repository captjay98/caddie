import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '../../apps/app/src/server/auth.ts';
import { allMigrationPaths } from './migrations.ts';
import { splitSqlStatements } from './controls-harness.ts';

/**
 * A D1-shaped database over bun:sqlite with every committed migration applied,
 * for in-process service and route tests. Same statement surface the app
 * uses (prepare/bind/all/run, batch, exec). Not evidence about D1 itself.
 */
export function sqliteD1(sqlite: Database): D1Database {
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

export function migratedDatabase(): { sqlite: Database; db: D1Database } {
	const sqlite = new Database(':memory:');
	for (const path of allMigrationPaths()) {
		for (const statement of splitSqlStatements(readFileSync(path, 'utf8'))) sqlite.exec(statement);
	}
	return { sqlite, db: sqliteD1(sqlite) };
}

export function addUser(sqlite: Database, id: string, email: string): void {
	const now = new Date().toISOString();
	sqlite
		.prepare('insert into "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") values (?,?,?,?,?,?,?)')
		.run(id, id, email, 1, null, now, now);
}
