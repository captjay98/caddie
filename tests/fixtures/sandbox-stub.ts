import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * P04 test fixture — LOCAL STUB of the contree (Nebius TF Sandboxes) REST API.
 *
 * Binds 127.0.0.1 only; emulates the documented REST surface that
 * apps/app/src/server/adapters/contree.ts implements (see
 * docs/setup/sandbox.md for the endpoint contract and its evidence split:
 * adjudication facts vs documented assumptions).
 *
 * Chaos controls (slice 3) simulate the failure modes the real service can
 * produce without needing it: a lost dispatch response, a cancel request the
 * remote ignores (orphaned operation) and session loss.
 */

export interface StubBehavior {
	/** Operation stays non-terminal for at least this long. */
	delayMs?: number;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	/** Grow stdout by this many bytes per tick while running (output quota). */
	outputBytesPerTick?: number;
	tickMs?: number;
}

export interface StubRequestLog {
	method: string;
	path: string;
	body: unknown;
	hasAuthorization: boolean;
	authorizationMatched: boolean;
	projectHeader: string | null;
}

interface StubSession {
	sessionId: string;
	sessionKey: string;
	image: string;
	restoreFrom: string | null;
	isolation: unknown;
	root: string;
	files: Map<string, Buffer>;
	symlinks: Map<string, string>;
}

interface StubOperation {
	operationId: string;
	sessionId: string;
	operationKey: string;
	command: string;
	env: Record<string, string> | null;
	state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timer?: ReturnType<typeof setTimeout>;
	interval?: ReturnType<typeof setInterval>;
}

interface StubCheckpoint {
	checkpointRef: string;
	root: string;
	files: Map<string, Buffer>;
	symlinks: Map<string, string>;
}

function clearOpTimers(op: StubOperation): void {
	if (op.timer) clearTimeout(op.timer);
	if (op.interval) clearInterval(op.interval);
	op.timer = undefined;
	op.interval = undefined;
}

export class SandboxStub {
	private server: Server | undefined;
	port = 0;
	url = '';
	private counter = 0;
	private readonly sessions = new Map<string, StubSession>();
	private readonly operations = new Map<string, StubOperation>();
	private readonly operationsByKey = new Map<string, string>();
	private readonly checkpoints = new Map<string, StubCheckpoint>();
	private readonly gone = new Set<string>();
	readonly requests: StubRequestLog[] = [];
	private behaviors: Array<{ match: string; behavior: StubBehavior }> = [];
	readonly chaos = { resetNextDispatch: false, ignoreCancel: false };

	constructor(
		private readonly options: { expectedToken?: string; workspaceRoot?: string } = {},
	) {}

	// --- test controls -------------------------------------------------------------

	setBehavior(match: string, behavior: StubBehavior): void {
		this.behaviors = [...this.behaviors.filter((b) => b.match !== match), { match, behavior }];
	}

	seedSymlink(sessionId: string, from: string, to: string): void {
		this.requireSession(sessionId).symlinks.set(from, to);
	}

	loseSession(sessionId: string): void {
		this.gone.add(sessionId);
	}

	operationIdByKey(operationKey: string): string | null {
		return this.operationsByKey.get(operationKey) ?? null;
	}

	fileContent(sessionId: string, absolutePath: string): string | null {
		const file = this.sessions.get(sessionId)?.files.get(absolutePath);
		return file ? file.toString('utf8') : null;
	}

	// --- lifecycle -----------------------------------------------------------------

	start(): Promise<void> {
		const server = createServer((req, res) => {
			this.handle(req, res).catch((error) => {
				// Last-resort: never let the stub crash the test process silently.
				if (!res.headersSent) {
					res.writeHead(500, { 'content-type': 'application/json', connection: 'close' });
					res.end(JSON.stringify({ error: 'stub_internal', message: String(error) }));
				} else {
					res.destroy();
				}
			});
		});
		this.server = server;
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (!address || typeof address === 'string') {
					reject(new Error('stub: no tcp address'));
					return;
				}
				this.port = address.port;
				this.url = `http://127.0.0.1:${this.port}`;
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		for (const op of this.operations.values()) clearOpTimers(op);
		const server = this.server;
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
		});
		this.server = undefined;
	}

	// --- request plumbing ------------------------------------------------------------

	private record(req: import('node:http').IncomingMessage, body: unknown): StubRequestLog {
		const authorization = req.headers['authorization'];
		const expected = this.options.expectedToken;
		const entry: StubRequestLog = {
			method: req.method ?? '',
			path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
			body,
			hasAuthorization: typeof authorization === 'string' && authorization.length > 0,
			authorizationMatched:
				typeof authorization === 'string' && expected !== undefined
					? authorization === `Bearer ${expected}`
					: false,
			projectHeader:
				typeof req.headers['x-nebius-project-id'] === 'string'
					? (req.headers['x-nebius-project-id'] as string)
					: null,
		};
		this.requests.push(entry);
		return entry;
	}

	private reply(
		res: import('node:http').ServerResponse,
		status: number,
		payload?: unknown,
	): void {
		res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
		res.end(payload === undefined ? '' : JSON.stringify(payload));
	}

	private requireSession(sessionId: string): StubSession {
		const session = this.sessions.get(sessionId);
		if (!session || this.gone.has(sessionId)) {
			const error = new Error('session_gone') as Error & { stubStatus?: number; stubCode?: string };
			error.stubStatus = 404;
			error.stubCode = 'session_gone';
			throw error;
		}
		return session;
	}

	private readBody(req: import('node:http').IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = '';
			req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
			req.on('end', () => resolve(body));
			req.on('error', reject);
		});
	}

	private behaviorFor(command: string): StubBehavior | undefined {
		return this.behaviors.find((b) => command.includes(b.match))?.behavior;
	}

	// --- endpoint emulation -----------------------------------------------------------

	private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const path = url.pathname;
		const method = req.method ?? '';

		let rawBody: string | undefined;
		if (method === 'POST') rawBody = await this.readBody(req);
		let parsedBody: unknown = undefined;
		if (rawBody !== undefined && rawBody.length > 0) {
			try {
				parsedBody = JSON.parse(rawBody);
			} catch {
				parsedBody = { unparsed: rawBody.slice(0, 256) };
			}
		}
		const log = this.record(req, parsedBody);

		// Auth gate: the real service requires IAM + project headers (phase-a:
		// live-verified reachable with IAM + Project headers).
		if (this.options.expectedToken !== undefined) {
			const authorization = req.headers['authorization'];
			if (authorization !== `Bearer ${this.options.expectedToken}`) {
				this.reply(res, 401, { error: 'unauthorized' });
				return;
			}
		}

		try {
			// NOTE: /by-key must match before the generic /:id route.
			let match = path.match(/^\/v1\/operations\/by-key\/([^/]+)$/);
			if (match && method === 'GET') {
				const operationId = this.operationsByKey.get(decodeURIComponent(match[1]));
				if (!operationId) {
					this.reply(res, 404, { error: 'operation_not_found' });
					return;
				}
				this.reply(res, 200, { operationId });
				return;
			}

			match = path.match(/^\/v1\/operations\/([^/]+)$/);
			if (match && method === 'GET') {
				const op = this.operations.get(decodeURIComponent(match[1]));
				if (!op) {
					this.reply(res, 404, { error: 'operation_not_found' });
					return;
				}
				this.reply(res, 200, {
					operationId: op.operationId,
					state: op.state,
					exitCode: op.exitCode,
					stdout: op.stdout,
					stderr: op.stderr,
					outputBytes: Buffer.byteLength(op.stdout, 'utf8') + Buffer.byteLength(op.stderr, 'utf8'),
				});
				return;
			}

			match = path.match(/^\/v1\/operations\/([^/]+)\/cancel$/);
			if (match && method === 'POST') {
				const op = this.operations.get(decodeURIComponent(match[1]));
				if (!op) {
					this.reply(res, 404, { error: 'operation_not_found' });
					return;
				}
				if (!this.chaos.ignoreCancel && (op.state === 'RUNNING' || op.state === 'PENDING')) {
					clearOpTimers(op);
					op.state = 'CANCELLED';
				}
				this.reply(res, 202, { requested: true });
				return;
			}

			match = path.match(/^\/v1\/sessions\/([^/]+)$/);
			if (match && method === 'DELETE') {
				const session = this.requireSession(decodeURIComponent(match[1]));
				for (const op of this.operations.values()) {
					if (op.sessionId === session.sessionId && (op.state === 'RUNNING' || op.state === 'PENDING')) {
						clearOpTimers(op);
						op.state = 'CANCELLED';
					}
				}
				this.gone.add(session.sessionId);
				this.reply(res, 204);
				return;
			}

			match = path.match(/^\/v1\/sessions\/([^/]+)\/files$/);
			if (match && method === 'POST') {
				const session = this.requireSession(decodeURIComponent(match[1]));
				const body = (parsedBody ?? {}) as { path?: unknown; contentBase64?: unknown };
				if (typeof body.path !== 'string' || typeof body.contentBase64 !== 'string') {
					this.reply(res, 400, { error: 'invalid_file' });
					return;
				}
				const resolved = this.resolveWithin(session, body.path);
				if (!resolved) {
					this.reply(res, 400, { error: 'path_escape' });
					return;
				}
				session.files.set(resolved, Buffer.from(body.contentBase64, 'base64'));
				this.reply(res, 200, { saved: true });
				return;
			}

			match = path.match(/^\/v1\/sessions\/([^/]+)\/exec$/);
			if (match && method === 'POST') {
				const session = this.requireSession(decodeURIComponent(match[1]));
				const body = (parsedBody ?? {}) as {
					command?: unknown;
					cwd?: unknown;
					timeoutSec?: unknown;
					operationKey?: unknown;
					env?: unknown;
				};
				if (typeof body.command !== 'string' || typeof body.operationKey !== 'string') {
					this.reply(res, 400, { error: 'invalid_exec' });
					return;
				}
				// Idempotent dispatch: the operation key elects exactly one remote op.
				const existing = this.operationsByKey.get(body.operationKey);
				if (existing) {
					this.reply(res, 202, { operationId: existing });
					return;
				}
				const operationId = `op_${++this.counter}_${Math.random().toString(36).slice(2, 8)}`;
				const op: StubOperation = {
					operationId,
					sessionId: session.sessionId,
					operationKey: body.operationKey,
					command: body.command,
					env: (body.env ?? null) as Record<string, string> | null,
					state: 'RUNNING',
					exitCode: null,
					stdout: '',
					stderr: '',
				};
				this.operations.set(operationId, op);
				this.operationsByKey.set(op.operationKey, operationId);

				// The command actually starts running remotely...
				this.schedule(op, this.behaviorFor(body.command));

				// ...chaos: drop the connection WITHOUT a response — the caller
				// cannot know the dispatch landed, but the op exists and runs.
				if (this.chaos.resetNextDispatch) {
					this.chaos.resetNextDispatch = false;
					res.socket?.destroy();
					return;
				}

				this.reply(res, 202, { operationId });
				return;
			}

			match = path.match(/^\/v1\/sessions\/([^/]+)\/checkpoint$/);
			if (match && method === 'POST') {
				const session = this.requireSession(decodeURIComponent(match[1]));
				const checkpointRef = `chk_${++this.counter}`;
				this.checkpoints.set(checkpointRef, {
					checkpointRef,
					root: session.root,
					files: new Map(session.files),
					symlinks: new Map(session.symlinks),
				});
				this.reply(res, 200, { checkpointRef });
				return;
			}

			match = path.match(/^\/v1\/sessions\/([^/]+)\/export$/);
			if (match && method === 'GET') {
				const session = this.requireSession(decodeURIComponent(match[1]));
				const hash = createHash('sha256');
				for (const file of [...session.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
					hash.update(file[0]);
					hash.update('\n');
					hash.update(file[1]);
				}
				const artifactRef = `art_${session.sessionId}_${++this.counter}`;
				this.reply(res, 200, { artifactRef, sha256: hash.digest('hex') });
				return;
			}

			if (path === '/v1/sessions' && method === 'POST') {
				const body = (parsedBody ?? {}) as {
					sessionKey?: unknown;
					image?: unknown;
					restoreFrom?: unknown;
					isolation?: unknown;
					workspaceRoot?: unknown;
				};
				if (typeof body.sessionKey !== 'string' || typeof body.image !== 'string') {
					this.reply(res, 400, { error: 'invalid_session' });
					return;
				}
				let files = new Map<string, Buffer>();
				let symlinks = new Map<string, string>();
				let root =
					typeof body.workspaceRoot === 'string' && body.workspaceRoot.length > 0
						? body.workspaceRoot
						: (this.options.workspaceRoot ?? '/work');
				if (typeof body.restoreFrom === 'string') {
					const checkpoint = this.checkpoints.get(body.restoreFrom);
					if (!checkpoint) {
						this.reply(res, 404, { error: 'checkpoint_not_found' });
						return;
					}
					files = new Map(checkpoint.files);
					symlinks = new Map(checkpoint.symlinks);
					root = checkpoint.root;
				}
				const sessionId = `sess_${++this.counter}`;
				this.sessions.set(sessionId, {
					sessionId,
					sessionKey: body.sessionKey,
					image: body.image,
					restoreFrom: typeof body.restoreFrom === 'string' ? body.restoreFrom : null,
					isolation: body.isolation ?? null,
					root,
					files,
					symlinks,
				});
				this.reply(res, 200, { sessionId, image: body.image });
				return;
			}

			this.reply(res, 404, { error: 'no_such_route' });
		} catch (error) {
			const stubError = error as { stubStatus?: number; stubCode?: string };
			if (typeof stubError.stubStatus === 'number') {
				this.reply(res, stubError.stubStatus, { error: stubError.stubCode ?? 'stub_error' });
				return;
			}
			throw error;
		}
	}

	// --- operation scheduling ------------------------------------------------------

	private schedule(op: StubOperation, behavior: StubBehavior | undefined): void {
		const finish = (exitCode: number, stdout = '', stderr = '') => {
			if (op.state === 'CANCELLED' || op.state === 'SUCCEEDED' || op.state === 'FAILED') return;
			clearOpTimers(op);
			op.exitCode = exitCode;
			if (stdout) op.stdout += stdout;
			if (stderr) op.stderr += stderr;
			op.state = exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
		};
		if (!behavior) {
			finish(0);
			return;
		}
		if (behavior.stdout) op.stdout += behavior.stdout;
		if (behavior.stderr) op.stderr += behavior.stderr;
		if (behavior.outputBytesPerTick && behavior.tickMs) {
			op.interval = setInterval(() => {
				if (op.state !== 'RUNNING') return;
				// Hard internal cap so a broken test cannot grow memory forever.
				if (Buffer.byteLength(op.stdout, 'utf8') > 4 * 1024 * 1024) {
					finish(0);
					return;
				}
				op.stdout += 'x'.repeat(behavior.outputBytesPerTick as number);
			}, behavior.tickMs);
			op.interval.unref?.();
		}
		if (behavior.delayMs) {
			op.timer = setTimeout(
				() => finish(behavior.exitCode ?? 0, '', ''),
				behavior.delayMs,
			);
			op.timer.unref?.();
		} else if (!behavior.outputBytesPerTick) {
			finish(behavior.exitCode ?? 0);
		}
	}

	/**
	 * Service-side containment: resolve `..`/`.` segments and session symlinks;
	 * the FINAL path must stay inside the session workspace root. A symlink that
	 * points outside the root (or a `..` escape) returns null -> 400 path_escape.
	 */
	private resolveWithin(session: StubSession, requestedPath: string): string | null {
		if (requestedPath.length === 0 || requestedPath.includes('\0')) return null;
		const segments: string[] = [];
		for (const segment of requestedPath.split('/')) {
			if (segment === '' || segment === '.') continue;
			if (segment === '..') return null;
			segments.push(segment);
		}
		if (segments.length === 0) return null;
		let current = `/${segments.join('/')}`;
		// Resolve one level of session-known symlinks. Keys are workspace-relative;
		// walk from the shortest prefix so nested links compose.
		const rootPrefix = session.root.endsWith('/') ? session.root.slice(0, -1) : session.root;
		for (const [from, to] of [...session.symlinks.entries()].sort(
			([a], [b]) => b.length - a.length,
		)) {
			const prefix = `${rootPrefix}/${from}`;
			if (current === prefix || current.startsWith(`${prefix}/`)) {
				current = `${to}${current.slice(prefix.length)}`;
				break;
			}
		}
		const root = session.root.endsWith('/') ? session.root : `${session.root}/`;
		if (!current.startsWith(root)) return null;
		return current;
	}
}
