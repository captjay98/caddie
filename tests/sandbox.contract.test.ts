import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	InMemorySandboxPersistence,
	SandboxDriver,
} from '../apps/app/src/server/adapters/sandbox.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';

/**
 * P04 slices 1 — sandbox driver contract (contracts.md "Sandbox and
 * verification") against a LOCAL STUB HTTP SERVER that emulates the contree
 * (Nebius TF Sandboxes) REST endpoints on 127.0.0.1 only.
 *
 * Honesty classification (AGENTS.md rules):
 *   - Everything in this file is LOCAL VERIFIED evidence about the DRIVER
 *     mechanics (fetch transport, persistence ordering, abort/cancel
 *     semantics, typed quotas) against the documented contree REST shapes.
 *   - It is NEVER evidence about the real contree service: no real network
 *     beyond 127.0.0.1 is touched. Real-service probes are BLOCKED on owner
 *     credentials (see docs/setup/sandbox.md).
 *
 * The stub is an in-process node:http server (the same pattern as the P01/P03
 * fixtures). fetch-only — no child_process anywhere: the CLI cannot spawn
 * under Workers (feature ledger, settled decision).
 */

const TOKEN = 'stub-token-local-only-not-a-secret';

function b64(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64');
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('P04 sandbox driver contract (local contree REST stub)', () => {
	let stub: SandboxStub;

	beforeAll(async () => {
		stub = new SandboxStub({ expectedToken: TOKEN, workspaceRoot: '/work' });
		await stub.start();
	});

	afterAll(async () => {
		await stub.stop();
	});

	function makeDriver(port: InMemorySandboxPersistence): SandboxDriver {
		return new SandboxDriver(
			{
				contree: {
					baseUrl: stub.url,
					apiToken: TOKEN,
					platformProjectId: 'platform-project-test',
				},
				quotas: {
					maxUploadBytes: 64 * 1024,
					maxOutputBytes: 64 * 1024,
					maxCommandTimeoutMs: 5_000,
				},
				workspaceRoot: '/work',
				pollIntervalMs: 10,
				dispatchTimeoutMs: 2_000,
			},
			port,
		);
	}

	test('create persists the session binding before exposing the session id', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({
			projectId: 'p1',
			runId: 'r1',
			image: 'tag:base:1',
		});
		expect(sessionId).toBeTruthy();
		const record = await port.load(`session:${sessionId}`);
		expect(record).toMatchObject({
			kind: 'session',
			sessionId,
			projectId: 'p1',
			runId: 'r1',
			image: 'tag:base:1',
			state: 'active',
		});
		const createRequests = stub.requests.filter((r) => r.method === 'POST' && r.path === '/v1/sessions');
		expect(createRequests).toHaveLength(1);
		expect(createRequests[0]?.hasAuthorization).toBe(true);
		expect(createRequests[0]?.authorizationMatched).toBe(true);
		expect((createRequests[0]?.body as Record<string, unknown>)['image']).toBe('tag:base:1');
	});

	test('execute runs to completion and persists remote identity before exposing completion', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'r1', image: 'tag:base:1' });
		stub.setBehavior('echo', { stdout: 'hello from stub', exitCode: 0 });
		const result = await driver.execute({
			sessionId,
			command: 'echo hello from stub',
			operationKey: 'op-happy',
			timeoutMs: 2_000,
		});
		expect(result.remoteId).toBeTruthy();
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('hello from stub');

		// Persistence: the operation record exists with the remote id and the
		// terminal receipt — restart can reconcile from it (used by slice 3).
		const record = await port.load('op:op-happy');
		expect(record).toMatchObject({
			kind: 'operation',
			operationKey: 'op-happy',
			remoteId: result.remoteId,
			state: 'succeeded',
			sessionId,
		});

		// Idempotent dispatch: the same operation key maps to the SAME remote op.
		const replay = await driver.execute({
			sessionId,
			command: 'echo hello from stub',
			operationKey: 'op-happy',
			timeoutMs: 2_000,
		});
		expect(replay.remoteId).toBe(result.remoteId);
		expect(replay.exitCode).toBe(0);
	});

	test('exec dispatch carries the operation key and only caller-passed env', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'env', image: 'tag:base:1' });
		await driver.execute({
			sessionId,
			command: 'printenv',
			operationKey: 'op-env-shape',
			timeoutMs: 2_000,
			env: { ALLOWED_X: '1', K2: 'v2' },
		});
		const exec = stub.requests.find(
			(r) => r.method === 'POST' && r.path === `/v1/sessions/${sessionId}/exec`,
		);
		expect(exec).toBeTruthy();
		const body = exec?.body as Record<string, unknown>;
		expect(body['operationKey']).toBe('op-env-shape');
		expect(body['env']).toEqual({ ALLOWED_X: '1', K2: 'v2' });
		// The platform token travels in the Authorization header only — never in
		// the request body the sandbox could observe.
		expect(JSON.stringify(body)).not.toContain(TOKEN);
	});

	test('status maps remote states honestly; an unknown remote id reports unknown', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'st', image: 'tag:base:1' });
		stub.setBehavior('slow', { delayMs: 400, exitCode: 0, stdout: 'done' });
		const pending = driver.execute({
			sessionId,
			command: 'run slow',
			operationKey: 'op-status',
			timeoutMs: 5_000,
		});
		await sleep(60);
		const remoteId = stub.operationIdByKey('op-status');
		expect(remoteId).toBeTruthy();
		const running = await driver.status(remoteId as string);
		expect(running.state).toBe('running');
		await pending;
		const terminal = await driver.status(remoteId as string);
		expect(terminal.state).toBe('succeeded');
		expect(terminal.exitCode).toBe(0);
		const unknown = await driver.status('no-such-operation');
		expect(unknown.state).toBe('unknown');
	});

	test('an already-aborted signal never dispatches', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'ab', image: 'tag:base:1' });
		const execCountBefore = stub.requests.filter((r) => r.path.endsWith('/exec')).length;
		const controller = new AbortController();
		controller.abort();
		expect(
			driver
				.execute({
					sessionId,
					command: 'should never run',
					operationKey: 'op-preaborted',
					timeoutMs: 2_000,
					signal: controller.signal,
				})
				.then(
					() => {
						throw new Error('execute should have rejected');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'ABORTED_BEFORE_DISPATCH' });
		expect(stub.requests.filter((r) => r.path.endsWith('/exec'))).toHaveLength(execCountBefore);
		expect(await port.load('op:op-preaborted')).toBeNull();
	});

	test('abort mid-flight releases the caller promptly AND cancels the remote operation', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'ab2', image: 'tag:base:1' });
		stub.setBehavior('hang', { delayMs: 5_000, exitCode: 0 });
		const controller = new AbortController();
		const startedAt = Date.now();
		const outcome = driver
			.execute({
				sessionId,
				command: 'run hang',
				operationKey: 'op-abort',
				timeoutMs: 10_000,
				signal: controller.signal,
			})
			.then(
				() => {
					throw new Error('execute should have rejected');
				},
				(error: unknown) => error,
			);
		await sleep(50);
		controller.abort();
		const error = (await outcome) as { code?: string };
		const releasedAfterMs = Date.now() - startedAt;
		expect(error.code).toBe('ABORTED_CANCEL_REQUESTED');
		// Adjudication semantics: a local abort releases the caller (~1.5s there;
		// the local stub is immediate). Generous bound keeps the test stable.
		expect(releasedAfterMs).toBeLessThan(1_000);
		// A cancel was issued to the remote operation...
		expect(stub.requests.some((r) => /\/v1\/operations\/[^/]+\/cancel$/.test(r.path))).toBe(true);
		// ...and status proves the terminal outcome (cancellation request is not
		// the proof — the status is).
		const remoteId = stub.operationIdByKey('op-abort');
		const terminal = await driver.status(remoteId as string);
		expect(terminal.state).toBe('cancelled');
		// The persistence record shows cancel-requested, not fabricated success.
		const record = await port.load('op:op-abort');
		expect(record?.state).toBe('cancel-requested');
	});

	test('command timeout kills the command and the status proves termination', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'to', image: 'tag:base:1' });
		stub.setBehavior('forever', { delayMs: 30_000, exitCode: 0 });
		expect(
			driver
				.execute({
					sessionId,
					command: 'run forever',
					operationKey: 'op-timeout',
					timeoutMs: 150,
				})
				.then(
					() => {
						throw new Error('execute should have rejected');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'EXEC_TIMEOUT' });
		const remoteId = stub.operationIdByKey('op-timeout');
		const terminal = await driver.status(remoteId as string);
		expect(terminal.state).toBe('cancelled');
	});

	test('ambiguous dispatch reports unknown and reconciles by operation key', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'amb', image: 'tag:base:1' });
		// Exactly one dispatch happened on the wire despite the ambiguity (the
		// stub request log is suite-wide, so compare against the prior count).
		const execCountBefore = stub.requests.filter((r) => r.path.endsWith('/exec')).length;
		stub.chaos.resetNextDispatch = true;
		expect(
			driver
				.execute({
					sessionId,
					command: 'echo lost-response',
					operationKey: 'op-ambiguous',
					timeoutMs: 2_000,
				})
				.then(
					() => {
						throw new Error('execute should have rejected');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'AMBIGUOUS_DISPATCH' });
		const record = await port.load('op:op-ambiguous');
		expect(record?.state).toBe('ambiguous');
		expect(record?.remoteId).toBeNull();

		// Reconciliation correlates by the persisted operation key — never a
		// blind re-dispatch — adopts the remote id, and polls to the outcome.
		const reconciled = await driver.reconcileOperation('op-ambiguous');
		expect(reconciled.state).toBe('succeeded');
		expect(reconciled.exitCode).toBe(0);
		const adopted = await port.load('op:op-ambiguous');
		expect(adopted?.remoteId).toBe(stub.operationIdByKey('op-ambiguous'));
		expect(adopted?.state).toBe('succeeded');
		// Exactly one dispatch happened on the wire despite the ambiguity.
		const execRequests = stub.requests.filter((r) => r.path.endsWith('/exec'));
		expect(execRequests.length - execCountBefore).toBe(1);
	});

	test('bounded upload stores files inside the session workspace', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'up', image: 'tag:base:1' });
		const saved = await driver.uploadFiles(sessionId, [
			{ path: 'src/app.ts', contentBase64: b64('export const app = 1;\n') },
		]);
		expect(saved.saved).toBe(1);
		const stored = stub.fileContent(sessionId, '/work/p1/src/app.ts');
		expect(stored).toBe('export const app = 1;\n');
	});

	test('checkpoint, restore, export and dispose round-trip', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'ck', image: 'tag:base:1' });
		await driver.uploadFiles(sessionId, [{ path: 'seed.txt', contentBase64: b64('seed\n') }]);

		const checkpoint = await driver.checkpoint(sessionId);
		expect(checkpoint.checkpointRef).toBeTruthy();

		const restored = await driver.restore({
			checkpointRef: checkpoint.checkpointRef,
			projectId: 'p1',
			runId: 'ck-child',
			image: 'tag:base:1',
		});
		expect(restored.sessionId).not.toBe(sessionId);
		// Restore record persisted before it was exposed.
		const restoredRecord = await port.load(`session:${restored.sessionId}`);
		expect(restoredRecord).toMatchObject({ projectId: 'p1', runId: 'ck-child', state: 'active' });
		expect(stub.fileContent(restored.sessionId, '/work/p1/seed.txt')).toBe('seed\n');

		const exported = await driver.export(sessionId);
		expect(exported.artifactRef).toBeTruthy();
		expect(exported.sha256).toMatch(/^[0-9a-f]{64}$/);
		const artifactRecord = await port.load(`artifact:${sessionId}`);
		expect(artifactRecord).toMatchObject({
			kind: 'artifact',
			artifactRef: exported.artifactRef,
			sha256: exported.sha256,
		});

		await driver.dispose(sessionId);
		const disposedRecord = await port.load(`session:${sessionId}`);
		expect(disposedRecord?.state).toBe('disposed');
		// A disposed session no longer executes or exports — typed, not silent.
		expect(
			driver
				.execute({
					sessionId,
					command: 'echo gone',
					operationKey: 'op-after-dispose',
					timeoutMs: 1_000,
				})
				.then(
					() => {
						throw new Error('execute should have rejected');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'SESSION_LOST' });
		expect(
			driver.export(sessionId).then(
				() => {
					throw new Error('export should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'SESSION_LOST' });
	});
});
