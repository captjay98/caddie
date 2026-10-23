import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { generateContractFiles } from '../apps/app/src/server/contract-files.ts';
import { NOTES_BLOCK } from './fixtures/contract/notes-apps.ts';

/**
 * FINDING #4 (review 2026-10-23): the generated file-backed `createFileDatabase`
 * wrapper's `batch()` returned the statement OBJECTS without running them, so a
 * batch INSERT-then-SELECT yielded no rows while production D1 executes those
 * writes. No test exercised the generated batch, which is why it shipped broken.
 *
 * This test materialises JUST the generated `test/setup/d1-file.ts` wrapper (with
 * minimal stubs for its three sibling imports — no full `bun install`) and drives
 * its `batch()` against a real bun:sqlite file, asserting the writes actually
 * land and a following SELECT sees them. A mutation that makes batch return the
 * statements unexecuted again fails here.
 */

const GENERATED = generateContractFiles(NOTES_BLOCK, { kind: 'small' }).files;
let dir: string;

function write(rel: string, text: string): void {
	const full = join(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'caddie-batch-'));
	// The generated file-backed wrapper under test.
	write('test/setup/d1-file.ts', GENERATED['test/setup/d1-file.ts']!);
	// Minimal stubs for its sibling imports (it only uses splitStatements +
	// TEST_AUTH_SECRET from ./d1, and createTestCaddie from ./caddie; the type
	// import from ../../caddie/d1 is erased).
	write(
		'test/setup/d1.ts',
		[
			'export const TEST_AUTH_SECRET = "test-secret";',
			'export function splitStatements(sql: string): string[] {',
			'  return sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);',
			'}',
		].join('\n'),
	);
	write('test/setup/caddie.ts', ['export type TestCaddie = Record<string, never>;', 'export function createTestCaddie(): TestCaddie { return {}; }'].join('\n'));
	write('caddie/d1.ts', 'export type D1Database = any;');
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('generated file-backed DB.batch (finding #4)', () => {
	test('a batch INSERT then SELECT actually executes and returns the written row', async () => {
		const { createFileDatabase } = (await import(join(dir, 'test/setup/d1-file.ts'))) as {
			createFileDatabase: (file: string) => {
				prepare: (q: string) => { bind: (...a: unknown[]) => unknown; all: () => Promise<{ results: unknown[] }> };
				batch: (s: unknown[]) => Promise<Array<{ results: unknown[]; success: boolean }>>;
			};
		};
		const dbFile = join(dir, 'batch-probe.sqlite');
		const db = createFileDatabase(dbFile);

		// A table the migrations don't own, created directly, then a batch write.
		await db.prepare('create table probe (v text)').all();
		const batchRes = await db.batch([
			db.prepare('insert into probe (v) values (?)').bind('alpha'),
			db.prepare('insert into probe (v) values (?)').bind('beta'),
		]);

		// The batch reports success for each statement (not unexecuted objects).
		expect(batchRes).toHaveLength(2);
		expect(batchRes.every((r) => r.success === true)).toBe(true);

		// The rows actually landed — the bug returned statement objects and wrote
		// nothing, so this SELECT would have been empty.
		const rows = (await db.prepare('select v from probe order by v').all()).results as Array<{ v: string }>;
		expect(rows.map((r) => r.v)).toEqual(['alpha', 'beta']);
	});
});
