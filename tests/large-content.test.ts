import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { D1_MAX_VALUE_BYTES } from '../apps/app/src/server/artifacts.ts';
import { LARGE_CHUNK_BYTES, LARGE_MAX_BYTES, getLarge, putLarge } from '../apps/app/src/server/large-content.ts';
import { allMigrationPaths } from './fixtures/migrations.ts';

/**
 * Track 3: files bigger than one D1 value (production D1 refuses any value over
 * 2,000,000 bytes), stored as chunks. The shim below refuses any bound value
 * over that limit, like production does, so a chunk that is too big fails here.
 */
function world() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys=ON');
	for (const path of allMigrationPaths()) sqlite.exec(require('node:fs').readFileSync(path, 'utf8'));
	const statement = (sql: string, args: unknown[] = []) => {
		for (const value of args) {
			const size = value instanceof Uint8Array ? value.byteLength : typeof value === 'string' ? Buffer.byteLength(value) : 0;
			if (size > D1_MAX_VALUE_BYTES) throw new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG');
		}
		const stmt = sqlite.prepare(sql);
		return {
			bind: (...next: unknown[]) => statement(sql, next),
			all: async () => ({ results: stmt.all(...(args as never[])) }),
			run: async () => ({ meta: { changes: stmt.run(...(args as never[])).changes } }),
			first: async () => stmt.get(...(args as never[])),
			_run: () => stmt.run(...(args as never[])),
		};
	};
	let batches = 0;
	const db = {
		prepare: (sql: string) => statement(sql),
		async batch(statements: { _run(): unknown }[]) {
			batches++;
			sqlite.exec('begin');
			try {
				const results = statements.map((s) => s._run());
				sqlite.exec('commit');
				return results;
			} catch (error) {
				sqlite.exec('rollback');
				throw error;
			}
		},
	} as unknown as D1Database;
	return { sqlite, db, batches: () => batches };
}

const random = (size: number) => new Uint8Array(require('node:crypto').randomBytes(size));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('the large-file store', () => {
	test('chunks stay under the D1 value limit', () => {
		expect(LARGE_CHUNK_BYTES).toBeLessThan(D1_MAX_VALUE_BYTES);
		expect(LARGE_MAX_BYTES).toBe(64 * 1024 * 1024);
	});

	test('an APK-sized file goes in as chunks in one batch and comes back byte-identical', async () => {
		const w = world();
		const apk = random(16_000_000);
		const stored = await putLarge(w.db, apk);
		expect(stored).toEqual({ sha256: sha(apk), bytes: 16_000_000, deduped: false });
		expect(w.batches()).toBe(1);
		const chunks = w.sqlite.prepare('select idx, length(bytes) as n from large_content_chunks where sha256 = ? order by idx').all(stored.sha256) as { idx: number; n: number }[];
		expect(chunks.length).toBe(Math.ceil(16_000_000 / LARGE_CHUNK_BYTES));
		for (const chunk of chunks) expect(chunk.n).toBeLessThanOrEqual(LARGE_CHUNK_BYTES);
		const back = await getLarge(w.db, stored.sha256);
		expect(back && Buffer.from(back).equals(Buffer.from(apk))).toBe(true);
	});

	test('a small file is one chunk; the same bytes twice are stored once', async () => {
		const w = world();
		const page = new TextEncoder().encode('<p>hello</p>');
		const first = await putLarge(w.db, page);
		const again = await putLarge(w.db, page);
		expect(again).toEqual({ ...first, deduped: true });
		expect(Number((w.sqlite.prepare('select count(*) as n from large_content_chunks').get() as { n: number }).n)).toBe(1);
	});

	test('empty and over-64 MB files are refused plainly; an unknown hash reads as null', async () => {
		const w = world();
		await expect(putLarge(w.db, new Uint8Array(0))).rejects.toThrow('empty');
		await expect(putLarge(w.db, { byteLength: LARGE_MAX_BYTES + 1 } as Uint8Array)).rejects.toThrow('64 MB');
		expect(await getLarge(w.db, 'f'.repeat(64))).toBeNull();
	});

	test('a file whose stored chunks no longer add up is refused, never served', async () => {
		const w = world();
		const stored = await putLarge(w.db, random(4_000_000));
		w.sqlite.prepare('delete from large_content_chunks where sha256 = ? and idx = 1').run(stored.sha256);
		await expect(getLarge(w.db, stored.sha256)).rejects.toThrow('incomplete');
		const other = await putLarge(w.db, random(3_000_000));
		w.sqlite.prepare("update large_content_chunks set bytes = randomblob(length(bytes)) where sha256 = ? and idx = 0").run(other.sha256);
		await expect(getLarge(w.db, other.sha256)).rejects.toThrow('does not match');
	});
});
