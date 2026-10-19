import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { D1_MAX_VALUE_BYTES, createD1ContentStore } from '../apps/app/src/server/artifacts.ts';
import { ScopeError } from '../apps/app/src/server/scope.ts';

/**
 * Found 2026-10-19: production D1 refuses any single BLOB over 2,000,000
 * bytes, but the local SQLite test DB does not. Every build bundle, code
 * version and artifact is one BLOB in artifact_content, so without a guard an
 * over-2 MB payload passes every local test and then cannot be saved once
 * deployed. createD1ContentStore.put is the one choke point every writer goes
 * through, so the guard lives there.
 */

function makeDb(): D1Database {
	const sqlite = new Database(':memory:');
	sqlite.exec(
		'create table "artifact_content" ("contentHash" text primary key, "bytes" blob not null, "size" integer not null, "createdAt" text not null)',
	);
	// A tiny D1-shaped shim: enough for put/get.
	return {
		prepare(sql: string) {
			const stmt = sqlite.query(sql);
			let bound: unknown[] = [];
			const api = {
				bind(...args: unknown[]) {
					bound = args;
					return api;
				},
				async all() {
					return { results: stmt.all(...(bound as [])) };
				},
				async run() {
					stmt.run(...(bound as []));
					return { meta: { changes: 1 } };
				},
			};
			return api;
		},
	} as unknown as D1Database;
}

describe('the content store never writes a value production D1 would reject', () => {
	test('the limit is D1’s real 2,000,000-byte ceiling', () => {
		expect(D1_MAX_VALUE_BYTES).toBe(2_000_000);
	});

	test('a payload at the limit is stored; one byte over is refused with a plain reason', async () => {
		const store = createD1ContentStore(makeDb());
		const atLimit = await store.put(new Uint8Array(D1_MAX_VALUE_BYTES).fill(1));
		expect(atLimit.size).toBe(D1_MAX_VALUE_BYTES);

		let error: unknown;
		try {
			await store.put(new Uint8Array(D1_MAX_VALUE_BYTES + 1).fill(1));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).status).toBe(422);
		expect((error as ScopeError).code).toBe('CONTENT_TOO_LARGE');
		expect((error as ScopeError).message).toContain('2 MB');
	});

	test('the stated limit really is below what the deployed DDL allows, so the guard is load-bearing', () => {
		// The migration's CHECK is 5 MiB; D1's row limit is lower, so a value
		// between the two passes the CHECK and is still refused by production.
		const ddl = readFileSync(new URL('../apps/app/migrations/0003_artifacts.sql', import.meta.url), 'utf8');
		const checkCap = Number(/<= *(\d+)\)/.exec(ddl)?.[1]);
		expect(checkCap).toBeGreaterThan(D1_MAX_VALUE_BYTES);
	});
});
