import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	PREVIEW_D1_SHIM_SOURCE,
	PREVIEW_ENTRY_SOURCE,
	applyPreviewMigrations,
	bridgeRequestToRequest,
	responseToBridge,
	runPreviewScript,
	runPreviewStatements,
	splitSqlScript,
	type PreviewStorageLike,
	type SqlCursorLike,
} from '../apps/app/src/server/preview-runtime.ts';

/**
 * Backend preview runtime, the parts that do not need workerd.
 *
 * Classification: LOCAL VERIFIED under Bun. The Durable Object's SQL storage
 * is stood in by bun:sqlite with the same cursor surface (toArray / raw /
 * columnNames / rowsRead / rowsWritten, transactionSync); the real Worker
 * Loader + Durable Object path is covered by
 * tests/preview-runtime.integration.test.ts against real workerd.
 */

function fakeStorage(sqlite: Database): PreviewStorageLike {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]): SqlCursorLike {
				const statement = sqlite.prepare(query);
				const columns = statement.columnNames;
				if (columns.length > 0) {
					const objects = statement.all(...(bindings as never[])) as Record<string, unknown>[];
					const arrays = objects.map((row) => columns.map((name) => row[name]));
					return { toArray: () => objects, raw: () => arrays, columnNames: columns, rowsRead: objects.length, rowsWritten: 0 };
				}
				const result = statement.run(...(bindings as never[]));
				return { toArray: () => [], raw: () => [], columnNames: [], rowsRead: 0, rowsWritten: result.changes };
			},
		},
		transactionSync<T>(closure: () => T): T {
			return sqlite.transaction(closure)();
		},
	};
}

let sqlite: Database;
let storage: PreviewStorageLike;
beforeEach(() => {
	sqlite = new Database(':memory:');
	storage = fakeStorage(sqlite);
});

describe('preview database executor', () => {
	test('runs statements with parameters and reports D1-shaped meta', () => {
		runPreviewScript(storage, 'create table notes (id integer primary key, body text not null, done integer not null default 0);');
		const [insert] = runPreviewStatements(storage, [{ sql: 'insert into notes (body) values (?)', params: ['buy seeds'], mode: 'all' }], false);
		expect(insert).toMatchObject({ success: true, meta: { changes: 1, last_row_id: 1, changed_db: true } });
		const [all] = runPreviewStatements(storage, [{ sql: 'select id, body from notes', params: [], mode: 'all' }], false);
		expect(all).toMatchObject({ results: [{ id: 1, body: 'buy seeds' }], meta: { changed_db: false, changes: 0 } });
		const [raw] = runPreviewStatements(storage, [{ sql: 'select id, body from notes', params: [], mode: 'raw' }], false);
		expect(raw).toMatchObject({ columns: ['id', 'body'], rows: [[1, 'buy seeds']] });
	});

	test('a batch is all-or-nothing', () => {
		runPreviewScript(storage, 'create table notes (id integer primary key, body text not null);');
		expect(() =>
			runPreviewStatements(
				storage,
				[
					{ sql: 'insert into notes (body) values (?)', params: ['kept?'], mode: 'all' },
					{ sql: 'insert into notes (body) values (?)', params: [null], mode: 'all' },
				],
				true,
			),
		).toThrow(/^D1_ERROR: /);
		const [count] = runPreviewStatements(storage, [{ sql: 'select count(*) as n from notes', params: [], mode: 'all' }], false);
		expect(count).toMatchObject({ results: [{ n: 0 }] });
	});

	test('refuses malformed requests', () => {
		expect(() => runPreviewStatements(storage, [], false)).toThrow(/between 1 and/);
		expect(() => runPreviewStatements(storage, [{ sql: '  ', params: [], mode: 'all' }], false)).toThrow(/SQL text/);
		expect(() => runPreviewStatements(storage, [{ sql: 'select ?', params: new Array(101).fill(1), mode: 'all' }], false)).toThrow(/At most 100/);
	});

	test('SQL errors carry the D1_ERROR prefix', () => {
		expect(() => runPreviewStatements(storage, [{ sql: 'select * from missing', params: [], mode: 'all' }], false)).toThrow(
			/^D1_ERROR: .*no such table/,
		);
	});

	test('migrations apply once each, in name order', () => {
		const files = [
			{ name: '0002_tags.sql', sql: 'alter table notes add column tag text;' },
			{ name: '0001_init.sql', sql: "create table notes (id integer primary key, body text); insert into notes (body) values ('a;b');" },
		];
		expect(applyPreviewMigrations(storage, files).applied).toEqual(['0001_init.sql', '0002_tags.sql']);
		expect(applyPreviewMigrations(storage, files).applied).toEqual([]);
		const [row] = runPreviewStatements(storage, [{ sql: 'select body, tag from notes', params: [], mode: 'all' }], false);
		expect(row).toMatchObject({ results: [{ body: 'a;b', tag: null }] });
	});

	test('a failing migration is not recorded and names the file', () => {
		expect(() => applyPreviewMigrations(storage, [{ name: '0001_bad.sql', sql: 'create table x (; nonsense' }])).toThrow(/0001_bad\.sql failed/);
		expect(applyPreviewMigrations(storage, [{ name: '0001_bad.sql', sql: 'create table x (id integer);' }]).applied).toEqual([
			'0001_bad.sql',
		]);
		expect(() => applyPreviewMigrations(storage, [{ name: '../evil.sql', sql: 'select 1' }])).toThrow(/NNNN_name\.sql/);
	});
});

describe('splitSqlScript', () => {
	test('splits on top-level semicolons only', () => {
		expect(
			splitSqlScript(`-- notes; table
create table "a;b" (x text default 'semi;colon'); /* c; */ insert into "a;b" values ('it''s; fine');

`),
		).toEqual([`create table "a;b" (x text default 'semi;colon')`, `insert into "a;b" values ('it''s; fine')`]);
	});

	test('keeps a trigger body together', () => {
		const parts = splitSqlScript(
			'create table t (x int); create trigger tr after insert on t begin update t set x = 1; insert into t values (2); end; select 1;',
		);
		expect(parts).toHaveLength(3);
		expect(parts[1]).toStartWith('create trigger tr');
		expect(parts[1]).toEndWith('end');
	});
});

describe('the D1 shim and entry module inside the app isolate', () => {
	let dir: string;
	let makeD1: (gateway: unknown) => any;
	let entry: { fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> };

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'caddie-preview-shim-'));
		writeFileSync(join(dir, 'caddie-d1.js'), PREVIEW_D1_SHIM_SOURCE);
		writeFileSync(join(dir, 'caddie-entry.js'), PREVIEW_ENTRY_SOURCE);
		writeFileSync(
			join(dir, 'app.js'),
			`export default { async fetch(request, env) {
				const url = new URL(request.url);
				if (url.pathname === '/api/health') return Response.json({ ok: true, key: env.WEATHER_KEY ?? null });
				const row = await env.DB.prepare('select ? as answer').bind(42).first();
				return Response.json(row);
			} };`,
		);
		makeD1 = (await import(join(dir, 'caddie-d1.js'))).makeD1;
		entry = (await import(join(dir, 'caddie-entry.js'))).default;
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function gateway() {
		return {
			query: async (statements: unknown, transaction: boolean) => runPreviewStatements(storage, statements, transaction),
			execScript: async (script: unknown) => runPreviewScript(storage, script),
		};
	}

	test('prepare/bind/run/all/first/raw behave like D1', async () => {
		const db = makeD1(gateway());
		expect(await db.exec('create table notes (id integer primary key, body text, done integer);')).toMatchObject({ count: 1 });
		const run = await db.prepare('insert into notes (body, done) values (?, ?)').bind('water beans', true).run();
		expect(run).toMatchObject({ success: true, meta: { changes: 1, last_row_id: 1 } });
		expect((await db.prepare('select body, done from notes').all()).results).toEqual([{ body: 'water beans', done: 1 }]);
		expect(await db.prepare('select body from notes where id = ?').bind(1).first('body')).toBe('water beans');
		expect(await db.prepare('select body from notes where id = ?').bind(9).first()).toBeNull();
		expect(await db.prepare('select id, body from notes').raw()).toEqual([[1, 'water beans']]);
		expect(await db.prepare('select id, body from notes').raw({ columnNames: true })).toEqual([['id', 'body'], [1, 'water beans']]);
		await expect(db.prepare('select body from notes').first('nope')).rejects.toThrow(/D1_COLUMN_NOTFOUND/);
		expect(() => db.prepare('select ?').bind(undefined)).toThrow(/D1_TYPE_ERROR/);
	});

	test('batch runs in one transaction', async () => {
		const db = makeD1(gateway());
		await db.exec('create table n (v text not null);');
		await expect(
			db.batch([db.prepare('insert into n values (?)').bind('a'), db.prepare('insert into n values (?)').bind(null)]),
		).rejects.toThrow(/D1_ERROR/);
		expect((await db.prepare('select count(*) as c from n').first()).c).toBe(0);
		const results = await db.batch([db.prepare('insert into n values (?)').bind('a'), db.prepare('select v from n')]);
		expect(results[1].results).toEqual([{ v: 'a' }]);
	});

	test('without a gateway every call fails plainly', async () => {
		const db = makeD1(undefined);
		await expect(db.prepare('select 1').all()).rejects.toThrow("The app's database is not available here.");
	});

	test('the entry gives the app env.DB and its own keys', async () => {
		const health = await entry.fetch(new Request('https://app.preview.invalid/api/health'), { CADDIE_VARS: { WEATHER_KEY: 'k-1' } }, {});
		expect(await health.json()).toEqual({ ok: true, key: 'k-1' });
		const answer = await entry.fetch(new Request('https://app.preview.invalid/api/answer'), { CADDIE_DB: gateway() }, {});
		expect(await answer.json()).toEqual({ answer: 42 });
	});
});

describe('the preview frame relay', () => {
	const base64 = (text: string) => btoa(text);

	test('only /api routes are relayed', () => {
		for (const path of ['/', '/index.html', '/apix', 'https://evil.example/api/x', '//evil.example/api', '/api\\..\\x']) {
			expect(() => bridgeRequestToRequest({ method: 'GET', path, headers: [], body: null })).toThrow(/own \/api routes/);
		}
		const ok = bridgeRequestToRequest({ method: 'get', path: '/api/notes?done=1', headers: [], body: null });
		expect(ok.method).toBe('GET');
		expect(new URL(ok.url).pathname + new URL(ok.url).search).toBe('/api/notes?done=1');
	});

	test('methods, headers and bodies are checked', async () => {
		expect(() => bridgeRequestToRequest({ method: 'CONNECT', path: '/api/x', headers: [], body: null })).toThrow(/method/);
		const request = bridgeRequestToRequest({
			method: 'POST',
			path: '/api/notes',
			headers: [
				['Content-Type', 'application/json'],
				['Host', 'evil.example'],
				['X-Caddie-Actor', 'spoofed'],
				['Cookie', 'sid=1'],
			],
			body: base64('{"body":"hi"}'),
		});
		expect(request.headers.get('content-type')).toBe('application/json');
		expect(request.headers.get('x-caddie-actor')).toBeNull();
		expect(request.headers.get('cookie')).toBe('sid=1');
		expect(await request.text()).toBe('{"body":"hi"}');
		const big = 'a'.repeat(Math.ceil((1024 * 1024 + 10) / 3) * 4);
		expect(() => bridgeRequestToRequest({ method: 'POST', path: '/api/x', headers: [], body: big })).toThrow(/1 MB/);
	});

	test('answers keep every Set-Cookie and are capped', async () => {
		const headers = new Headers({ 'content-type': 'application/json' });
		headers.append('set-cookie', 'a=1; Path=/');
		headers.append('set-cookie', 'b=2; Path=/; HttpOnly');
		const relayed = await responseToBridge(new Response('{"ok":true}', { status: 201, headers }));
		expect(relayed.status).toBe(201);
		expect(atob(relayed.body)).toBe('{"ok":true}');
		expect(relayed.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value)).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
		await expect(responseToBridge(new Response(new Uint8Array(2 * 1024 * 1024 + 1)))).rejects.toThrow(/2 MB/);
	});
});
