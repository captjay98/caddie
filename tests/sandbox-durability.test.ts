import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { D1SandboxPersistence } from '../apps/app/src/server/adapters/sandbox-persistence.ts';
import { SandboxDriver, type SandboxRecord } from '../apps/app/src/server/adapters/sandbox.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';

// LOCAL VERIFIED adapter/SQLite mechanics. Contree is a SIMULATED local HTTP
// boundary; no paid API or sandbox calls occur. D1's structural API is emulated.
function sqliteD1(db: Database): D1Database {
	return {
		prepare(sql: string) {
			const statement = db.query(sql);
			const bound = (values: unknown[]) => ({
				run: async () => ({ meta: { changes: Number(statement.run(...values as never[]).changes) } }),
				all: async <T = Record<string, unknown>>() => ({ results: statement.all(...values as never[]) as T[] }),
			});
			return { ...bound([]), bind: (...values: unknown[]) => bound(values) };
		},
		batch: async <T = unknown>() => [] as T[],
		exec: async (sql: string) => db.exec(sql),
	};
}

const DDL = `CREATE TABLE sandbox_bindings (key TEXT PRIMARY KEY, kind TEXT NOT NULL, sessionId TEXT, projectId TEXT, runId TEXT, recordJson TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX sandbox_bindings_session ON sandbox_bindings(sessionId, kind);`;
const TOKEN = 'durability-local-test-token';
const IMAGE = 'tag:durability:1';
let stub: SandboxStub;

beforeAll(async () => { stub = new SandboxStub({ expectedToken: TOKEN }); stub.seedImage(IMAGE); await stub.start(); });
afterAll(async () => { await stub.stop(); });

function storage() {
	const sqlite = new Database(':memory:');
	sqlite.exec(DDL);
	const db = sqliteD1(sqlite);
	return { sqlite, db, port: new D1SandboxPersistence(db) };
}
function driver(port: D1SandboxPersistence, overrides: { staleAmbiguousMs?: number } = {}) {
	return new SandboxDriver({ contree: { baseUrl: stub.url, apiToken: TOKEN, platformProjectId: 'local-test' }, workspaceRoot: '/workspace', quotas: { maxUploadBytes: 65536, maxOutputBytes: 65536, maxCommandTimeoutMs: 30000 }, pollIntervalMs: 5, reconcileTimeoutMs: 500, dispatchTimeoutMs: 1000, ...overrides }, port);
}
async function create(subject: SandboxDriver, suffix: string) {
	return (await subject.ensureSession({ sessionKey: `durable:${suffix}`, projectId: `project-${suffix}`, runId: `run-${suffix}`, image: IMAGE })).sessionId;
}

describe('durable sandbox image chain and machine receipts', () => {
	test('new adapter + driver restores files and actual result across requests, with no bootstrap reset', async () => {
		const { db, port } = storage();
		const first = driver(port);
		const sessionId = await create(first, 'restart');
		await first.writeFile(sessionId, './src/hello.txt', btoa('Hello from the durable image'));
		stub.setBehavior('receipt-with-stderr', { exitCode: 3, stdout: 'test failed: expected 2', stderr: 'assertion error' });
		const result = await first.execute({ sessionId, command: 'receipt-with-stderr', operationKey: 'durable-check', timeoutMs: 1000 });
		const image = (await port.load(`session:${sessionId}`))?.image;
		const spawns = stub.spawnRequestCount();
		const secondPort = new D1SandboxPersistence(db);
		const second = driver(secondPort);
		expect(await create(second, 'restart')).toBe(sessionId);
		expect(atob((await second.readFile(sessionId, 'src/hello.txt')).contentBase64)).toBe('Hello from the durable image');
		expect(await second.getOperationReceipt('durable-check')).toMatchObject({ ...result, projectId: 'project-restart', runId: 'run-restart', command: 'receipt-with-stderr', state: 'succeeded', stdout: 'test failed: expected 2', stderr: 'assertion error' });
		expect((await secondPort.load(`session:${sessionId}`))?.image).toBe(image);
		expect(stub.spawnRequestCount()).toBe(spawns);
	});

	test('replaying the same attempt returns its original receipt and never rolls newer changes back', async () => {
		const { port } = storage(); const subject = driver(port); const sessionId = await create(subject, 'replay');
		stub.setBehavior('replay-command', { stdout: 'the original output' });
		const input = { sessionId, command: 'replay-command', operationKey: 'attempt-one', timeoutMs: 1000 };
		const original = await subject.execute(input);
		await subject.writeFile(sessionId, 'later.txt', btoa('a newer change'));
		const before = stub.spawnRequestCount();
		expect(await subject.execute(input)).toEqual(original);
		expect(stub.spawnRequestCount()).toBe(before);
		expect(atob((await subject.readFile(sessionId, 'later.txt')).contentBase64)).toBe('a newer change');
		await expect(subject.execute({ ...input, command: 'another-command' })).rejects.toMatchObject({ code: 'OPERATION_KEY_CONFLICT' });
	});

	test('interrupted dispatch is blocked on restart, including a new command; no silent rebuild or double dispatch', async () => {
		const { db, port } = storage(); const first = driver(port); const sessionId = await create(first, 'unknown');
		stub.chaos.resetNextDispatch = true;
		const before = stub.spawnRequestCount();
		await expect(first.execute({ sessionId, command: 'uncertain-command', operationKey: 'uncertain-attempt', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'AMBIGUOUS_DISPATCH' });
		stub.chaos.resetNextDispatch = false;
		const restarted = driver(new D1SandboxPersistence(db));
		await expect(create(restarted, 'unknown')).rejects.toMatchObject({ code: 'OPERATION_UNRESOLVED' });
		await expect(restarted.execute({ sessionId, command: 'new-command', operationKey: 'new-attempt', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'OPERATION_UNRESOLVED' });
		expect((await restarted.reconcileOperation('uncertain-attempt')).state).toBe('unknown');
		expect(await restarted.getOperationReceipt('uncertain-attempt')).toBeNull();
		expect(stub.spawnRequestCount() - before).toBe(1);
	});

	test('a dispatch that stayed unknown is closed as failed, so the session continues instead of bricking', async () => {
		// HerdVoice, 2026-10-20: the sandbox isolate died mid-dispatch twice and
		// the unknown outcome locked the workspace for good. The host repaired
		// production D1 by hand both times. An ambiguous operation has no remote
		// id, so nothing can be polled for it: after the staleness window the
		// host closes it as failed and lets the next attempt run.
		const { db, port } = storage();
		const first = driver(port);
		const sessionId = await create(first, 'stale');
		stub.chaos.resetNextDispatch = true;
		await expect(first.execute({ sessionId, command: 'uncertain-command', operationKey: 'stale-attempt', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'AMBIGUOUS_DISPATCH' });
		stub.chaos.resetNextDispatch = false;
		const spawnsAfterTheLostDispatch = stub.spawnRequestCount();

		// A driver whose staleness window has passed closes the unknown attempt.
		const patient = driver(new D1SandboxPersistence(db), { staleAmbiguousMs: 0 });
		const result = await patient.execute({ sessionId, command: 'next-command', operationKey: 'after-stale', timeoutMs: 1000 });
		expect(result.exitCode).toBe(0);

		// The closed attempt is on the record as failed, with the honest note.
		const receipt = await patient.getOperationReceipt('stale-attempt');
		expect(receipt?.state).toBe('failed');
		expect(receipt?.stderr).toContain('outcome was never known');
		// The uncertain command was never dispatched a second time: only the new
		// command reached the sandbox.
		expect(stub.spawnRequestCount() - spawnsAfterTheLostDispatch).toBe(1);
	});

	test('bootstrap also persists its identity before exposure and cannot be blindly repeated after a lost response', async () => {
		const { db, port } = storage(); const subject = driver(port);
		const before = stub.spawnRequestCount();
		stub.chaos.resetNextDispatch = true;
		await expect(create(subject, 'bootstrap-lost')).rejects.toMatchObject({ code: 'AMBIGUOUS_DISPATCH' });
		stub.chaos.resetNextDispatch = false;
		await expect(create(driver(new D1SandboxPersistence(db)), 'bootstrap-lost')).rejects.toMatchObject({ code: 'OPERATION_UNRESOLVED' });
		expect(stub.spawnRequestCount() - before).toBe(1);
	});

	test('crash after receipt save recovers the committed image before another command can execute', async () => {
		const { db } = storage();
		class CrashPort extends D1SandboxPersistence {
			crash = false;
			override async compareAndSave(expected: SandboxRecord, next: SandboxRecord): Promise<boolean> {
				if (this.crash && expected.operationKey !== null && next.operationKey === null) { this.crash = false; throw new Error('simulated process termination'); }
				return super.compareAndSave(expected, next);
			}
		}
		const port = new CrashPort(db); const first = driver(port); const sessionId = await create(first, 'adopt');
		port.crash = true;
		await expect(first.writeFile(sessionId, 'recovered.txt', btoa('recovered commit'))).rejects.toThrow('simulated process termination');
		const before = stub.spawnRequestCount();
		const restarted = driver(new D1SandboxPersistence(db));
		expect(await create(restarted, 'adopt')).toBe(sessionId);
		expect(atob((await restarted.readFile(sessionId, 'recovered.txt')).contentBase64)).toBe('recovered commit');
		expect(stub.spawnRequestCount()).toBe(before);
	});

	test('cwd and project path escapes are rejected before dispatch and writes normalize their relative path', async () => {
		const { port } = storage(); const subject = driver(port); const sessionId = await create(subject, 'paths'); const before = stub.spawnRequestCount();
		await expect(subject.execute({ sessionId, command: 'true', operationKey: 'escaped-cwd', cwd: '/workspace/project-paths/../../outside', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'UPLOAD_PATH_ESCAPE' });
		await expect(subject.ensureSession({ sessionKey: 'bad-project', projectId: '../other-project', runId: 'bad-run', image: IMAGE })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		expect(stub.spawnRequestCount()).toBe(before);
		await subject.writeFile(sessionId, './src//item.txt', btoa('normalized'));
		expect(atob((await subject.readFile(sessionId, 'src/item.txt')).contentBase64)).toBe('normalized');
	});

	test('same content written to different paths commits both, and changing then restoring a file is a new attempt', async () => {
		const { port } = storage(); const subject = driver(port); const sessionId = await create(subject, 'write-identity');
		await subject.writeFile(sessionId, 'one.txt', btoa('same'));
		await subject.writeFile(sessionId, 'two.txt', btoa('same'));
		await subject.writeFile(sessionId, 'one.txt', btoa('changed'));
		await subject.writeFile(sessionId, 'one.txt', btoa('same'));
		expect(atob((await subject.readFile(sessionId, 'one.txt')).contentBase64)).toBe('same');
		expect(atob((await subject.readFile(sessionId, 'two.txt')).contentBase64)).toBe('same');
	});

	test('same durable attempt can recover a crash between image lock and operation claim', async () => {
		const { db, port } = storage(); const first = driver(port); const sessionId = await create(first, 'before-claim');
		const session = (await port.load(`session:${sessionId}`))!;
		await port.save({ ...session, operationKey: 'preclaim-attempt' });
		const restarted = driver(new D1SandboxPersistence(db)); const before = stub.spawnRequestCount();
		await expect(restarted.execute({ sessionId, command: 'true', operationKey: 'other-attempt', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'OPERATION_UNRESOLVED' });
		expect((await restarted.execute({ sessionId, command: 'true', operationKey: 'preclaim-attempt', timeoutMs: 1000 })).exitCode).toBe(0);
		expect(stub.spawnRequestCount() - before).toBe(1);
	});

	test('parallel drivers cannot dispatch two commands from the same current image', async () => {
		const { db, port } = storage(); const first = driver(port); const sessionId = await create(first, 'concurrent');
		const second = driver(new D1SandboxPersistence(db));
		stub.setBehavior('concurrent-image', { delayMs: 100 });
		const before = stub.spawnRequestCount();
		const results = await Promise.allSettled([
			first.execute({ sessionId, command: 'concurrent-image first', operationKey: 'concurrent-first', timeoutMs: 1000 }),
			second.execute({ sessionId, command: 'concurrent-image second', operationKey: 'concurrent-second', timeoutMs: 1000 }),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(stub.spawnRequestCount() - before).toBe(1);
		expect((await port.load(`session:${sessionId}`))?.operationKey).toBeNull();
	});

	test('D1 claims and compare-and-swap have one winner across separate adapter instances', async () => {
		const { db, port } = storage(); const other = new D1SandboxPersistence(db);
		const record: SandboxRecord = { key: 'session:claim', kind: 'session', sessionId: 'claim', projectId: 'project', runId: 'run', image: 'image', checkpointRef: null, operationKey: null, remoteId: null, state: 'active', artifactRef: null, sha256: null, updatedAt: new Date().toISOString() };
		expect(await Promise.all([port.claim(record), other.claim(record)])).toEqual([true, false]);
		expect(await Promise.all([port.compareAndSave(record, { ...record, operationKey: 'first' }), other.compareAndSave(record, { ...record, operationKey: 'second' })])).toEqual([true, false]);
		expect((await other.load(record.key))?.operationKey).toBe('first');
	});
});
