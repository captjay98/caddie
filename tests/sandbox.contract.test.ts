import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	InMemorySandboxPersistence,
	SandboxDriver,
	SandboxError,
	shellQuote,
} from '../apps/app/src/server/adapters/sandbox.ts';
import { SandboxStub, splitTopLevel, tokenize } from './fixtures/sandbox-stub.ts';

/**
 * P04/P05 sandbox driver contract against a LOCAL STUB HTTP SERVER that
 * emulates the REAL contree (Nebius TF Sandboxes) REST surface on 127.0.0.1
 * only — content-addressed files, image snapshots, one-shot instance runs,
 * inspect reads, operations. There are NO server-side sessions: a "session"
 * is the driver's persisted bookkeeping (key → current image), and these
 * tests prove that bookkeeping.
 *
 * Honesty classification (AGENTS.md rules):
 *   - Everything here is LOCAL VERIFIED evidence about the DRIVER mechanics
 *     (fetch transport, session bookkeeping, persistence ordering,
 *     abort/cancel semantics, typed quotas, injection-safe quoting) against
 *     the documented real REST shapes (contree_client 0.4.0, OpenAPI).
 *   - It is NEVER evidence about the real contree service: no real network
 *     beyond 127.0.0.1 is touched. Real-service evidence is the authorized
 *     live probe (tests/live/sandbox.spec.ts).
 */

const TOKEN = 'stub-token-local-only-not-a-secret';
const IMAGE_TAG = 'tag:base:1';
const INJECTION_PATH = `x'; echo pwned > /tmp/pwned; echo '`;

function b64(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64');
}

function unb64(contentBase64: string): string {
	return Buffer.from(contentBase64, 'base64').toString('utf8');
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('P04/P05 sandbox driver contract (local contree REST stub)', () => {
	let stub: SandboxStub;

	beforeAll(async () => {
		stub = new SandboxStub({ expectedToken: TOKEN });
		stub.seedImage(IMAGE_TAG);
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
					// Generous here: mechanics first; the tight bounds are exercised
					// in the hardening suite below.
					maxCommandTimeoutMs: 30_000,
				},
				workspaceRoot: '/workspace',
				pollIntervalMs: 10,
				dispatchTimeoutMs: 2_000,
			},
			port,
		);
	}

	async function newSession(
		driver: SandboxDriver,
		projectId: string,
		runId: string,
	): Promise<string> {
		const { sessionId } = await driver.ensureSession({
			sessionKey: `session:${runId}`,
			image: IMAGE_TAG,
			projectId,
			runId,
		});
		return sessionId;
	}

	function spawnBodies(): Record<string, unknown>[] {
		return stub.requests
			.filter((r) => r.method === 'POST' && r.path === '/v1/instances')
			.map((r) => r.body as Record<string, unknown>);
	}

	// --- session-on-first-use (audit P05 finding 1) ---------------------------

	test('ensureSession creates the session on first use: one bootstrap run, binding persisted first', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const spawnsBefore = stub.spawnRequestCount();
		const { sessionId } = await driver.ensureSession({
			sessionKey: 'session:run-boot',
			image: IMAGE_TAG,
			projectId: 'p1',
			runId: 'run-boot',
		});
		expect(sessionId).toBe('session:run-boot');
		// The binding (key → current image) is persisted BEFORE the id is exposed.
		const record = await port.load('session:session:run-boot');
		expect(record).toMatchObject({
			kind: 'session',
			sessionId: 'session:run-boot',
			projectId: 'p1',
			runId: 'run-boot',
			state: 'active',
		});
		expect(typeof record?.image).toBe('string');
		expect(record?.image?.length).toBeGreaterThan(0);
		// Exactly ONE real instance run bootstrapped the workspace directory.
		expect(stub.spawnRequestCount() - spawnsBefore).toBe(1);
		const spawn = spawnBodies().at(-1);
		expect(spawn?.['command']).toBe(`mkdir -p -- '/workspace/p1'`);
		// The tag reference was resolved to the base image uuid before dispatch.
		expect(spawn?.['image']).toBe(stub.imageForTag(IMAGE_TAG));
		// Auth travels as Bearer + Project headers on every request.
		const logged = stub.requests.filter((r) => r.path === '/v1/instances').at(-1);
		expect(logged?.hasAuthorization).toBe(true);
		expect(logged?.authorizationMatched).toBe(true);
		expect(logged?.projectHeader).toBe('platform-project-test');
	});

	test('ensureSession reuses the session after creation — no second bootstrap', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const first = await driver.ensureSession({
			sessionKey: 'session:run-reuse',
			image: IMAGE_TAG,
			projectId: 'p1',
			runId: 'run-reuse',
		});
		const spawnsAfterFirst = stub.spawnRequestCount();
		const second = await driver.ensureSession({
			sessionKey: 'session:run-reuse',
			image: IMAGE_TAG,
			projectId: 'p1',
			runId: 'run-reuse',
		});
		expect(second.sessionId).toBe(first.sessionId);
		expect(stub.spawnRequestCount()).toBe(spawnsAfterFirst);
	});

	test('ensureSession is concurrency-safe: N racing callers share ONE bootstrap (single-flight)', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const spawnsBefore = stub.spawnRequestCount();
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				driver.ensureSession({
					sessionKey: 'session:run-race',
					image: IMAGE_TAG,
					projectId: 'p1',
					runId: 'run-race',
				}),
			),
		);
		expect(new Set(results.map((r) => r.sessionId))).toEqual(new Set(['session:run-race']));
		expect(stub.spawnRequestCount() - spawnsBefore).toBe(1);
	});

	test('ensureSession refuses to rebind a key to a different project', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		await driver.ensureSession({
			sessionKey: 'session:run-conflict',
			image: IMAGE_TAG,
			projectId: 'p1',
			runId: 'run-conflict',
		});
		expect(
			driver
				.ensureSession({
					sessionKey: 'session:run-conflict',
					image: IMAGE_TAG,
					projectId: 'p-other',
					runId: 'run-conflict',
				})
				.then(
					() => {
						throw new Error('ensureSession should have rejected');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'SESSION_KEY_CONFLICT' });
	});

	test('create() derives the logical session key from the project/run pair', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const { sessionId } = await driver.create({ projectId: 'p1', runId: 'r-derived', image: IMAGE_TAG });
		expect(sessionId).toBe('caddie:p1:r-derived');
		expect((await port.load('session:caddie:p1:r-derived'))?.state).toBe('active');
	});

	// --- execution ---------------------------------------------------------------

	test('execute runs to completion, persists the receipt, and advances the session image', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-exec');
		const imageBefore = (await port.load(`session:${sessionId}`))?.image;
		stub.setBehavior('live-ok', { stdout: 'live from stub', exitCode: 0 });
		const result = await driver.execute({
			sessionId,
			command: 'echo live-ok',
			operationKey: 'op-exec',
			timeoutMs: 5_000,
		});
		expect(result.remoteId).toBeTruthy();
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('live from stub');

		const sessionAfter = await port.load(`session:${sessionId}`);
		// The run COMMITTED a new image and the session adopted it BEFORE the
		// result was exposed (persist-before-expose).
		expect(sessionAfter?.image).toBeTruthy();
		expect(sessionAfter?.image).not.toBe(imageBefore);
		const opRecord = await port.load('op:op-exec');
		expect(opRecord).toMatchObject({
			kind: 'operation',
			operationKey: 'op-exec',
			remoteId: result.remoteId,
			state: 'succeeded',
			sessionId,
		});
	});

	test('exec carries the workspace cwd by default, passes caller env, and never the token', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-env');
		await driver.execute({
			sessionId,
			command: 'printenv',
			operationKey: 'op-env-shape',
			timeoutMs: 5_000,
			env: { ALLOWED_X: '1', K2: 'v2' },
			cwd: '/workspace/p1/sub',
		});
		const body = spawnBodies().at(-1);
		expect(body?.['cwd']).toBe('/workspace/p1/sub');
		expect(body?.['env']).toEqual({ ALLOWED_X: '1', K2: 'v2' });
		expect(body?.['shell']).toBe(true);
		expect(JSON.stringify(body)).not.toContain(TOKEN);
		// The truncate bound travels with every dispatch (server-side output cap).
		expect(body?.['truncate_output_at']).toBe(64 * 1024);
	});

	test('status maps remote states honestly; an unknown remote id reports unknown', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-status');
		stub.setBehavior('slow-status', { delayMs: 300, exitCode: 0, stdout: 'done' });
		const pending = driver.execute({
			sessionId,
			command: 'run slow-status',
			operationKey: 'op-status',
			timeoutMs: 5_000,
		});
		await sleep(60);
		const remoteId = (await port.load('op:op-status'))?.remoteId as string;
		expect(remoteId).toBeTruthy();
		const running = await driver.status(remoteId);
		expect(running.state).toBe('running');
		await pending;
		const terminal = await driver.status(remoteId);
		expect(terminal.state).toBe('succeeded');
		expect(terminal.exitCode).toBe(0);
		const unknown = await driver.status('no-such-operation');
		expect(unknown.state).toBe('unknown');
	});

	test('an already-aborted signal never dispatches', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-preabort');
		const spawnsBefore = stub.spawnRequestCount();
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
		expect(stub.spawnRequestCount()).toBe(spawnsBefore);
		expect(await port.load('op:op-preaborted')).toBeNull();
	});

	test('abort mid-flight releases the caller promptly AND cancels the remote operation', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-abort');
		stub.setBehavior('run hang', { delayMs: 5_000, exitCode: 0 });
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
		// Adjudication semantics: a local abort releases the caller (~1.5s
		// against the real service; the local stub is immediate).
		expect(releasedAfterMs).toBeLessThan(1_000);
		// A cancel was issued to the remote operation...
		expect(stub.requests.some((r) => r.method === 'DELETE' && /^\/v1\/operations\/[^/]+$/.test(r.path))).toBe(true);
		// ...and status proves the terminal outcome (the REQUEST is not the proof).
		const remoteId = (await port.load('op:op-abort'))?.remoteId as string;
		const terminal = await driver.status(remoteId);
		expect(terminal.state).toBe('cancelled');
		const record = await port.load('op:op-abort');
		expect(record?.state).toBe('cancel-requested');
	});

	test('command timeout kills the command and the status proves termination', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-timeout');
		stub.setBehavior('run forever', { delayMs: 30_000, exitCode: 0 });
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
		const remoteId = (await port.load('op:op-timeout'))?.remoteId as string;
		const terminal = await driver.status(remoteId);
		expect(terminal.state).toBe('cancelled');
	});

	test('ambiguous dispatch is persisted as unknown and NEVER retried blindly (no server-side key correlation)', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-amb');
		const spawnsBefore = stub.spawnRequestCount();
		stub.chaos.resetNextDispatch = true;
		expect(
			driver
				.execute({
					sessionId,
					command: 'echo lost-response',
					operationKey: 'op-ambiguous',
					timeoutMs: 5_000,
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
		// Exactly one dispatch happened on the wire despite the ambiguity.
		expect(stub.spawnRequestCount() - spawnsBefore).toBe(1);
		// The real API has no by-key correlation: without a remote id the honest
		// answer is unknown — never a blind re-dispatch.
		const reconciled = await driver.reconcileOperation('op-ambiguous');
		expect(reconciled.state).toBe('unknown');
		expect(stub.spawnRequestCount() - spawnsBefore).toBe(1);
		stub.chaos.resetNextDispatch = false;
	});

	test('a restarted driver adopts the persisted operation identity and the committed image chain', async () => {
		const port = new InMemorySandboxPersistence();
		const driverA = makeDriver(port);
		const sessionId = await newSession(driverA, 'p1', 'run-restart');
		const imageBefore = (await port.load(`session:${sessionId}`))?.image;
		stub.setBehavior('slow-start', { delayMs: 300, exitCode: 0, stdout: 'recovered' });
		const pending = driverA.execute({
			sessionId,
			command: 'run slow-start',
			operationKey: 'op-restart',
			timeoutMs: 10_000,
		});
		// Dispatch happened; the remote identity must already be persisted.
		await sleep(60);
		const persisted = await port.load('op:op-restart');
		expect(persisted?.remoteId).toBeTruthy();
		expect(persisted?.state).toBe('dispatched');

		// driverA dies mid-exec (crash): a NEW driver over the SAME persistence
		// settles the SAME logical operation — no re-dispatch, no duplicate.
		void pending.catch(() => {});
		const driverB = makeDriver(port);
		const settled = await driverB.reconcileOperation('op-restart');
		expect(settled.state).toBe('succeeded');
		expect(settled.exitCode).toBe(0);
		// The committed image chain was adopted: the session moved off its old image.
		const session = await port.load(`session:${sessionId}`);
		expect(session?.image).toBeTruthy();
		expect(session?.image).not.toBe(imageBefore);
		// Exactly one dispatch happened on the wire for this logical operation.
		const spawnCommands = spawnBodies().map((body) => body['command']);
		expect(spawnCommands.filter((command) => command === 'run slow-start')).toHaveLength(1);
		// And the session keeps working from the adopted image.
		const continued = await driverB.execute({
			sessionId,
			command: 'echo adopted',
			operationKey: 'op-restart-continued',
			timeoutMs: 5_000,
		});
		expect(continued.exitCode).toBe(0);
	});

	// --- files: real endpoints, no shell (audit P05 finding 2) ------------------

	test('writeFile then readFile round-trip through the content-addressed files API', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-files');
		const spawnsBefore = stub.spawnRequestCount();
		const saved = await driver.writeFile(sessionId, 'src/app.ts', b64('export const app = 1;\n'));
		expect(saved.saved).toBe(1);
		// One content upload + ONE commit instance — no shell path in between.
		expect(stub.fileRequestCount()).toBe(1);
		expect(stub.spawnRequestCount() - spawnsBefore).toBe(1);
		expect(spawnBodies().at(-1)?.['command']).toBe('true');

		const read = await driver.readFile(sessionId, 'src/app.ts');
		expect(unb64(read.contentBase64)).toBe('export const app = 1;\n');
		expect(read.size).toBe('export const app = 1;\n'.length);

		const missing = driver.readFile(sessionId, 'src/missing.ts').then(
			() => {
				throw new Error('readFile should have rejected');
			},
			(error: unknown) => error,
		);
		expect(missing).resolves.toMatchObject({ code: 'FILE_NOT_FOUND' });
	});

	test('uploadFiles batches N files behind ONE commit run', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-batch');
		const spawnsBefore = stub.spawnRequestCount();
		const saved = await driver.uploadFiles(sessionId, [
			{ path: 'a.txt', contentBase64: b64('A') },
			{ path: 'nested/b.txt', contentBase64: b64('B') },
		]);
		expect(saved.saved).toBe(2);
		expect(stub.spawnRequestCount() - spawnsBefore).toBe(1);
		expect(unb64((await driver.readFile(sessionId, 'nested/b.txt')).contentBase64)).toBe('B');
	});

	test('path injection cannot execute: file operations dispatch ZERO shell commands', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-inject');
		expect(stub.shellExecutions).toEqual([]);

		// (a) readFile with an injection payload: typed failure, nothing runs.
		const spawnsBeforeRead = stub.spawnRequestCount();
		expect(
			driver.readFile(sessionId, INJECTION_PATH).then(
				() => {
					throw new Error('readFile should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'FILE_NOT_FOUND' });
		expect(stub.spawnRequestCount()).toBe(spawnsBeforeRead);
		expect(stub.shellExecutions).toEqual([]);

		// (b) writeFile with an injection payload: the path becomes inert,
		// weird FILE NAMES inside the workspace — never a command.
		const spawnsBeforeWrite = stub.spawnRequestCount();
		await driver.writeFile(sessionId, INJECTION_PATH, b64('inert\n'));
		// Exactly the one commit run, whose command is the attachment marker —
		// the injected `echo pwned` never appeared as a shell execution.
		expect(stub.spawnRequestCount() - spawnsBeforeWrite).toBe(1);
		expect(stub.shellExecutions).toEqual([]);
		// The payload's path segments live inside the workspace (its first
		// segment tops the listing) and the full path round-trips as a file.
		const listed = await driver.listDir(sessionId, '.');
		expect(listed).toContain(`x'; echo pwned > `);
		const read = await driver.readFile(sessionId, INJECTION_PATH);
		expect(unb64(read.contentBase64)).toBe('inert\n');
		// (c) The quoted form round-trips: the stub's POSIX tokenizer recovers
		// the original path as ONE argv with no top-level `;`.
		const quoted = shellQuote(INJECTION_PATH);
		expect(tokenize(`mkdir -p -- ${quoted}`)).toEqual(['mkdir', '-p', '--', INJECTION_PATH]);
		expect(splitTopLevel(quoted)).toHaveLength(1);
	});

	test('traversal is rejected client-side before anything is sent (kept from P04)', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-traversal');
		const requestsBefore = stub.requests.length;
		const cases: Array<{ path: string; code: string }> = [
			{ path: '../escape.txt', code: 'UPLOAD_PATH_ESCAPE' },
			{ path: '/etc/passwd', code: 'UPLOAD_PATH_ESCAPE' },
			{ path: 'a/../../escape', code: 'UPLOAD_PATH_ESCAPE' },
			{ path: 'ok/../../escape', code: 'UPLOAD_PATH_ESCAPE' },
			{ path: '', code: 'INVALID_INPUT' },
			{ path: '.', code: 'INVALID_INPUT' },
		];
		for (const testCase of cases) {
			expect(
				driver.writeFile(sessionId, testCase.path, b64('nope')).then(
					() => {
						throw new Error(`write should have rejected: ${JSON.stringify(testCase.path)}`);
					},
					(error: unknown) => error,
				),
			).resolves.toMatchObject({ code: testCase.code });
		}
		expect(
			driver.readFile(sessionId, '/etc/passwd').then(
				() => {
					throw new Error('read should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'UPLOAD_PATH_ESCAPE' });
		// Rejections happen client-side: nothing reached the service.
		expect(stub.requests.length).toBe(requestsBefore);
	});

	test('stat reports real fidelity (file vs directory, size, mtime) via the inspect list endpoint', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-stat');
		await driver.writeFile(sessionId, 'dir-a/file.txt', b64('12345'));
		const spawnsBefore = stub.spawnRequestCount();

		const fileStat = await driver.statFile(sessionId, 'dir-a/file.txt');
		expect(fileStat.isFile).toBe(true);
		expect(fileStat.isDirectory).toBe(false);
		expect(fileStat.size).toBe(5);
		expect(fileStat.mtime).toBeInstanceOf(Date);

		const dirStat = await driver.statFile(sessionId, 'dir-a');
		expect(dirStat.isFile).toBe(false);
		expect(dirStat.isDirectory).toBe(true);

		const rootStat = await driver.statFile(sessionId, '.');
		expect(rootStat.isDirectory).toBe(true);

		// The flue runtime resolves model paths against the sandbox cwd before
		// the driver sees them: absolute paths UNDER the workspace root work…
		const absolute = await driver.statFile(sessionId, '/workspace/p1/dir-a/file.txt');
		expect(absolute.isFile).toBe(true);
		// …and absolute paths OUTSIDE the root are the same typed rejection.
		expect(
			driver.statFile(sessionId, '/tmp/evil').then(
				() => {
					throw new Error('stat should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'UPLOAD_PATH_ESCAPE' });

		expect(
			driver.statFile(sessionId, 'dir-a/nope.txt').then(
				() => {
					throw new Error('stat should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'FILE_NOT_FOUND' });

		// stat/readdir/exists never spawn an instance.
		expect(stub.spawnRequestCount()).toBe(spawnsBefore);
		expect(await driver.pathExists(sessionId, 'dir-a/file.txt')).toBe(true);
		expect(await driver.pathExists(sessionId, 'dir-a/nope.txt')).toBe(false);
	});

	test('readdir lists directory entries through the inspect list endpoint', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-readdir');
		await driver.uploadFiles(sessionId, [
			{ path: 'dir-a/one.txt', contentBase64: b64('1') },
			{ path: 'dir-a/two.txt', contentBase64: b64('2') },
			{ path: 'top.txt', contentBase64: b64('t') },
		]);
		expect((await driver.listDir(sessionId, 'dir-a')).sort()).toEqual(['one.txt', 'two.txt']);
		const root = await driver.listDir(sessionId, '.');
		expect(root).toContain('dir-a');
		expect(root).toContain('top.txt');
		expect(
			driver.listDir(sessionId, 'missing-dir').then(
				() => {
					throw new Error('readdir should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'FILE_NOT_FOUND' });
	});

	test('mkdir honors the recursive option and embeds paths injection-safely', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-mkdir');

		await driver.mkdir(sessionId, 'deep/nested/dir', { recursive: true });
		expect(await driver.pathExists(sessionId, 'deep/nested/dir')).toBe(true);

		// Without recursive, a missing parent is a typed failure.
		expect(
			driver.mkdir(sessionId, 'other/missing/child').then(
				() => {
					throw new Error('mkdir should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'MKDIR_FAILED' });

		// An injection payload becomes ONE quoted argv carrying the ABSOLUTE
		// workspace path — the stub observes no separate shell execution for
		// the smuggled `echo`.
		const spawnsBefore = stub.spawnRequestCount();
		const injected = `y'; echo pwned2 > /tmp/pwned2; echo '`;
		await driver.mkdir(sessionId, injected, { recursive: true });
		expect(stub.spawnRequestCount() - spawnsBefore).toBe(1);
		const command = spawnBodies().at(-1)?.['command'] as string;
		expect(tokenize(command)).toEqual(['mkdir', '-p', '--', `/workspace/p1/${injected}`]);
		expect(stub.shellExecutions).toEqual([]);
	});

	test('rm honors recursive/force; missing without force is a typed 404', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-rm');
		await driver.uploadFiles(sessionId, [
			{ path: 'doomed.txt', contentBase64: b64('x') },
			{ path: 'tree/inner/file.txt', contentBase64: b64('y') },
		]);

		// rm of a file
		await driver.removePath(sessionId, 'doomed.txt');
		expect(await driver.pathExists(sessionId, 'doomed.txt')).toBe(false);

		// rm of a NON-EMPTY directory without recursive fails typed
		expect(
			driver.removePath(sessionId, 'tree').then(
				() => {
					throw new Error('rm should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'RM_FAILED' });
		expect(await driver.pathExists(sessionId, 'tree/inner/file.txt')).toBe(true);

		// recursive removes the tree
		await driver.removePath(sessionId, 'tree', { recursive: true });
		expect(await driver.pathExists(sessionId, 'tree')).toBe(false);

		// missing without force → FILE_NOT_FOUND; with force → idempotent ok
		expect(
			driver.removePath(sessionId, 'never-existed.txt').then(
				() => {
					throw new Error('rm should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'FILE_NOT_FOUND' });
		await driver.removePath(sessionId, 'never-existed.txt', { force: true });
	});

	// --- checkpoint / restore / export / dispose --------------------------------

	test('checkpoint, restore, export and dispose round-trip', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p1', 'run-ck');
		await driver.writeFile(sessionId, 'seed.txt', b64('seed\n'));

		// The checkpoint IS the current committed image.
		const checkpoint = await driver.checkpoint(sessionId);
		expect(checkpoint.checkpointRef).toBeTruthy();
		const checkpointed = await port.load(`session:${sessionId}`);
		expect(checkpointed?.image).toBeTruthy();
		expect(checkpoint.checkpointRef).toBe(checkpointed?.image as string);

		// State written AFTER the checkpoint is invisible to the restored session.
		await driver.writeFile(sessionId, 'later.txt', b64('later\n'));
		const restored = await driver.restore({
			checkpointRef: checkpoint.checkpointRef,
			projectId: 'p1',
			runId: 'ck-child',
		});
		expect(restored.sessionId).not.toBe(sessionId);
		const restoredRecord = await port.load(`session:${restored.sessionId}`);
		expect(restoredRecord).toMatchObject({ projectId: 'p1', state: 'active' });
		expect(unb64((await driver.readFile(restored.sessionId, 'seed.txt')).contentBase64)).toBe('seed\n');
		expect(
			driver.readFile(restored.sessionId, 'later.txt').then(
				() => {
					throw new Error('readFile should have rejected');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'FILE_NOT_FOUND' });

		// A bogus checkpoint is a typed 404, never a fabricated session.
		expect(
			driver
				.restore({ checkpointRef: 'img-bogus', projectId: 'p1', runId: 'ck-bogus' })
				.then(
					() => {
						throw new Error('restore should have rejected');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' });

		// Export hashes the workspace archive and persists the artifact FIRST.
		const exported = await driver.export(sessionId);
		expect(exported.artifactRef).toContain('inspect-archive:');
		expect(exported.sha256).toMatch(/^[0-9a-f]{64}$/);
		const artifactRecord = await port.load(`artifact:${sessionId}`);
		expect(artifactRecord).toMatchObject({
			kind: 'artifact',
			artifactRef: exported.artifactRef,
			sha256: exported.sha256,
		});

		// Dispose is local truth; every further use is a typed SESSION_LOST.
		await driver.dispose(sessionId);
		const disposedRecord = await port.load(`session:${sessionId}`);
		expect(disposedRecord?.state).toBe('disposed');
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
		await driver.dispose(sessionId); // idempotent
	});

	// --- hardening (kept from P04, re-proven on the real surface) ----------------

	test('platform credentials are never sent into the sandbox command or env', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p2', 'run-cred');
		const spawnsBefore = stub.spawnRequestCount();
		expect(
			driver
				.execute({
					sessionId,
					command: `echo ${TOKEN}`,
					operationKey: 'op-leak-cmd',
					timeoutMs: 2_000,
				})
				.then(
					() => {
						throw new Error('execute should have refused the credential leak');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'CREDENTIAL_IN_ENV' });
		expect(
			driver
				.execute({
					sessionId,
					command: 'printenv',
					operationKey: 'op-leak-env',
					timeoutMs: 2_000,
					env: { LEAK: `bearer ${TOKEN}` },
				})
				.then(
					() => {
						throw new Error('execute should have refused the credential leak');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'CREDENTIAL_IN_ENV' });
		// Neither leaked call reached the wire.
		expect(stub.spawnRequestCount()).toBe(spawnsBefore);
	});

	test('quota refusals happen before any dispatch or upload', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p2', 'run-quota');
		const spawnsBefore = stub.spawnRequestCount();
		const filesBefore = stub.fileRequestCount();
		expect(
			driver
				.execute({
					sessionId,
					command: 'echo never dispatched',
					operationKey: 'op-overquota',
					timeoutMs: 60_000,
				})
				.then(
					() => {
						throw new Error('execute should have been refused');
					},
					(error: unknown) => error,
				),
		).resolves.toMatchObject({ code: 'QUOTA_TIME_LIMIT' });
		expect(
			driver.writeFile(sessionId, 'big.bin', b64('x'.repeat(64 * 1024 + 1))).then(
				() => {
					throw new Error('write should have been refused');
				},
				(error: unknown) => error,
			),
		).resolves.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
		expect(stub.spawnRequestCount()).toBe(spawnsBefore);
		expect(stub.fileRequestCount()).toBe(filesBefore);
	});

	test('output beyond the quota is truncated by the service and reported as a typed failure', async () => {
		const port = new InMemorySandboxPersistence();
		const driver = makeDriver(port);
		const sessionId = await newSession(driver, 'p2', 'run-spam');
		// ~96KB of stdout against the 64KB truncate bound.
		stub.setBehavior('spam', { stdout: 'x'.repeat(96 * 1024), exitCode: 0 });
		const cancelCountBefore = stub.requests.filter(
			(r) => r.method === 'DELETE' && /^\/v1\/operations\//.test(r.path),
		).length;
		let caught: unknown = null;
		try {
			await driver.execute({
				sessionId,
				command: 'echo spam',
				operationKey: 'op-spam',
				timeoutMs: 5_000,
			});
		} catch (error) {
			caught = error;
		}
		expect((caught as SandboxError).code).toBe('QUOTA_OUTPUT_EXCEEDED');
		// The session still advanced to the proven terminal image before the
		// typed failure was raised (persist-before-expose ordering).
		expect(await port.load('op:op-spam')).toMatchObject({ state: 'succeeded' });
		// No cancellation was needed: the service bounds the output itself.
		const cancels = stub.requests.filter(
			(r) => r.method === 'DELETE' && /^\/v1\/operations\//.test(r.path),
		).length;
		expect(cancels).toBe(cancelCountBefore);
	});

	test('the shellQuote primitive cannot be broken out of', async () => {
		const adversarial: string[] = [
			INJECTION_PATH,
			`'; rm -rf /; echo '`,
			`$(echo pwned)`,
			'`id`',
			"' single",
			"'' double''",
			'\\; backslash;',
			'newline\ninjection',
		];
		for (const value of adversarial) {
			const quoted = shellQuote(value);
			// The quoted form is ONE token that decodes to exactly the input.
			expect(tokenize(`-- ${quoted}`)).toEqual(['--', value]);
			// No top-level `;` exists outside the quoted literal.
			expect(splitTopLevel(quoted)).toHaveLength(1);
		}
	});
});
