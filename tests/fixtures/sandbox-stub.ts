import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * P04/P05 test fixture — LOCAL STUB of the real contree (Nebius TF Sandboxes)
 * REST API. Binds 127.0.0.1 only; emulates the OpenAPI-generated surface that
 * apps/app/src/server/adapters/contree.ts implements (see
 * docs/setup/sandbox.md for the endpoint contract and its evidence split).
 *
 * The model under test: NO server-side sessions. Content-addressed files
 * (`POST /files`), image snapshots addressed by uuid, one-shot instance runs
 * that commit a new image (`POST /instances`), inspect reads
 * (`/inspect/{image}/download|list|archive`), and operations
 * (`GET/DELETE /operations/{id}`). "Sessions" exist only in the driver's
 * persistence port — exactly what the contract tests must prove.
 *
 * Instance commands are interpreted STRUCTURALLY (argv tokenizer with
 * single-quote handling) for the commands the driver itself issues — mkdir,
 * rm, true — and via canned behaviors for anything else. A top-level `;`
 * (OUTSIDE quotes) splits commands, so an injection attempt would show up as
 * separately executed commands in `shellExecutions` — the injection tests
 * assert none appear. This is an emulation for contract tests, never evidence
 * about the real service.
 *
 * Chaos controls (kept from P04) simulate real failure modes: a lost dispatch
 * response (the instance still runs remotely and commits an image we never
 * learn — the honest divergence the driver must survive), a cancel request
 * the remote ignores, and image loss.
 */

export interface StubBehavior {
	/** Operation stays non-terminal for at least this long. */
	delayMs?: number;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	/** Files the command leaves in its result image (absolute path -> text), e.g. a build's dist/. */
	writes?: Record<string, string>;
}

export interface StubRequestLog {
	method: string;
	path: string;
	/** The raw query string (`?path=...`), so tests can tell which file a read asked for. */
	query?: string;
	body: unknown;
	hasAuthorization: boolean;
	authorizationMatched: boolean;
	projectHeader: string | null;
}

interface StubFile {
	bytes: Buffer;
	mode: number;
	mtime: number;
}

interface StubImage {
	imageUuid: string;
	files: Map<string, StubFile>;
	dirs: Set<string>;
}

interface StubOperation {
	operationId: string;
	imageUuid: string;
	command: string;
	state: 'EXECUTING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
	exitCode: number | null;
	stdout: Buffer;
	stderr: Buffer;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	timedOut: boolean;
	resultImage: string | null;
	createdAt: number;
	durationMs: number | null;
	timer?: ReturnType<typeof setTimeout>;
}

export class SandboxStub {
	private server: Server | undefined;
	port = 0;
	url = '';
	private counter = 0;
	private readonly images = new Map<string, StubImage>();
	private readonly tags = new Map<string, string>();
	private readonly filesBySha = new Map<string, { uuid: string; bytes: Buffer }>();
	private readonly operations = new Map<string, StubOperation>();
	private readonly goneImages = new Set<string>();
	readonly requests: StubRequestLog[] = [];
	/** Commands observed as separate shell executions (top-level `;` splits). */
	readonly shellExecutions: string[] = [];
	private behaviors: Array<{ match: string; behavior: StubBehavior }> = [];
	readonly chaos = { resetNextDispatch: false, ignoreCancel: false };

	constructor(
		private readonly options: { expectedToken?: string; workspaceRoot?: string } = {},
	) {}

	// --- test controls -------------------------------------------------------------

	setBehavior(match: string, behavior: StubBehavior): void {
		this.behaviors = [...this.behaviors.filter((b) => b.match !== match), { match, behavior }];
	}

	/** Register a tag with a fresh empty image (the base image a session bootstraps from). */
	seedImage(tagRef: string): string {
		const tag = tagRef.startsWith('tag:') ? tagRef.slice(4) : tagRef;
		const existing = this.tags.get(tag);
		if (existing) return existing;
		const imageUuid = crypto.randomUUID();
		this.tags.set(tag, imageUuid);
		this.images.set(imageUuid, { imageUuid, files: new Map(), dirs: new Set() });
		return imageUuid;
	}

	/** Drop an image (eviction/loss): inspect reads 404, spawns refuse it. */
	loseImage(imageUuid: string): void {
		this.goneImages.add(imageUuid);
	}

	/** Test-side: drop every image builds made, as after a long pause; tagged base images stay. Returns how many. */
	loseBuiltImages(): number {
		const tagged = new Set(this.tags.values());
		let lost = 0;
		for (const imageUuid of this.images.keys()) {
			if (tagged.has(imageUuid) || this.goneImages.has(imageUuid)) continue;
			this.goneImages.add(imageUuid);
			lost += 1;
		}
		return lost;
	}

	/** Every command the instances were asked to run, in order. */
	spawnedCommands(): string[] {
		return this.requests
			.filter((r) => r.method === 'POST' && r.path === '/v1/instances')
			.map((r) => String((r.body as { command?: unknown } | null)?.command ?? ''));
	}

	/**
	 * Test-side: an image that already holds these files (absolute paths), as
	 * a finished build's checkpoint would. Returns the image uuid.
	 */
	seedImageWithFiles(files: Record<string, string | Uint8Array>): string {
		const imageUuid = crypto.randomUUID();
		const stored = new Map<string, StubFile>();
		for (const [path, content] of Object.entries(files)) {
			stored.set(this.normalize(path), {
				bytes: typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content),
				mode: 0o100644,
				mtime: 1_760_000_000,
			});
		}
		this.images.set(imageUuid, { imageUuid, files: stored, dirs: new Set() });
		return imageUuid;
	}

	/** Every path an inspect read was requested for (proves what was, and was not, read). */
	downloadedPaths(): string[] {
		return this.requests
			.filter((r) => r.method === 'GET' && /\/inspect\/[^/]+\/download$/.test(r.path))
			.map((r) => new URLSearchParams(r.query ?? '').get('path') ?? '');
	}

	/** Every directory an inspect listing was requested for. */
	listedPaths(): string[] {
		return this.requests
			.filter((r) => r.method === 'GET' && /\/inspect\/[^/]+\/list$/.test(r.path))
			.map((r) => new URLSearchParams(r.query ?? '').get('path') ?? '');
	}

	spawnRequestCount(): number {
		return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/instances').length;
	}

	/** The image uuid a tag reference resolves to (mirrors the client's rule). */
	imageForTag(tagRef: string): string | null {
		const tag = tagRef.startsWith('tag:') ? tagRef.slice(4) : tagRef;
		return this.tags.get(tag) ?? null;
	}

	fileRequestCount(): number {
		return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/files').length;
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
		for (const op of this.operations.values()) {
			if (op.timer) clearTimeout(op.timer);
		}
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
			query: new URL(req.url ?? '/', 'http://127.0.0.1').search,
			body,
			hasAuthorization: typeof authorization === 'string' && authorization.length > 0,
			authorizationMatched:
				typeof authorization === 'string' && expected !== undefined
					? authorization === `Bearer ${expected}`
					: false,
			projectHeader:
				typeof req.headers['project'] === 'string' ? (req.headers['project'] as string) : null,
		};
		this.requests.push(entry);
		return entry;
	}

	private reply(
		res: import('node:http').ServerResponse,
		status: number,
		payload?: unknown,
		headers: Record<string, string> = {},
	): void {
		res.writeHead(
			status,
			{
				'content-type': 'application/json',
				connection: 'close',
				...headers,
			},
		);
		res.end(payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload));
	}

	private image(imageUuid: string): StubImage | null {
		if (this.goneImages.has(imageUuid)) return null;
		return this.images.get(imageUuid) ?? null;
	}

	private readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => resolve(Buffer.concat(chunks)));
			req.on('error', reject);
		});
	}

	private behaviorFor(command: string): StubBehavior | undefined {
		return this.behaviors.find((b) => command.includes(b.match))?.behavior;
	}

	// --- endpoint emulation -----------------------------------------------------------

	private async handle(
		req: import('node:http').IncomingMessage,
		res: import('node:http').ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const path = url.pathname;
		const method = req.method ?? '';

		let parsedBody: unknown = undefined;
		if (method === 'POST' || method === 'PUT') {
			const raw = await this.readBody(req);
			const contentType = req.headers['content-type'] ?? '';
			if (contentType.includes('application/json')) {
				const text = raw.toString('utf8');
				if (text.length > 0) {
					try {
						parsedBody = JSON.parse(text);
					} catch {
						parsedBody = { unparsed: text.slice(0, 256) };
					}
				}
			} else {
				parsedBody = raw;
			}
		}
		const log = this.record(req, parsedBody);

		// Auth gate: the real service requires Bearer IAM + Project headers.
		if (this.options.expectedToken !== undefined) {
			const authorization = req.headers['authorization'];
			if (authorization !== `Bearer ${this.options.expectedToken}`) {
				this.reply(res, 401, { error: 'unauthorized' });
				return;
			}
		}

		try {
			let match: RegExpMatchArray | null;

			// --- tag resolution (302 to the image inspect endpoint) ---------------
			if (path === '/v1/inspect/' && method === 'GET') {
				const tag = url.searchParams.get('tag');
				const imageUuid = tag !== null ? (this.tags.get(tag) ?? null) : null;
				if (imageUuid === null) {
					this.reply(res, 404, { error: 'image_not_found' });
					return;
				}
				this.reply(res, 302, '', { location: `${this.url}/v1/inspect/${imageUuid}/` });
				return;
			}

			// --- image metadata (redirect target; also a cheap existence probe) ----
			match = path.match(/^\/v1\/inspect\/([^/]+)\/$/);
			if (match && method === 'GET') {
				const imageUuid = decodeURIComponent(match[1]);
				const image = this.image(imageUuid);
				if (!image) {
					this.reply(res, 404, { error: 'image_not_found' });
					return;
				}
				const tag = [...this.tags.entries()].find(([, uuid]) => uuid === imageUuid)?.[0] ?? null;
				this.reply(res, 200, { uuid: imageUuid, tag, size: 0 });
				return;
			}

			// --- content-addressed file upload ------------------------------------
			if (path === '/v1/files' && method === 'POST') {
				const bytes = parsedBody instanceof Buffer ? parsedBody : Buffer.alloc(0);
				const sha256 = createHash('sha256').update(bytes).digest('hex');
				const existing = this.filesBySha.get(sha256);
				const uuid = existing?.uuid ?? crypto.randomUUID();
				this.filesBySha.set(sha256, { uuid, bytes });
				this.reply(res, 200, { uuid, sha256, size: bytes.byteLength });
				return;
			}

			// --- inspect: download / list / archive -------------------------------
			match = path.match(/^\/v1\/inspect\/([^/]+)\/download$/);
			if (match && (method === 'GET' || method === 'HEAD')) {
				const image = this.image(decodeURIComponent(match[1]));
				const filePath = url.searchParams.get('path') ?? '';
				const file = image?.files.get(this.normalize(filePath));
				if (!image || !file) {
					this.reply(res, 404, { error: 'not_found' });
					return;
				}
				res.writeHead(200, {
					'content-type': 'application/octet-stream',
					connection: 'close',
					'content-length': String(file.bytes.byteLength),
				});
				res.end(method === 'HEAD' ? undefined : file.bytes);
				return;
			}

			match = path.match(/^\/v1\/inspect\/([^/]+)\/list$/);
			if (match && method === 'GET') {
				const image = this.image(decodeURIComponent(match[1]));
				const dirPath = this.normalize(url.searchParams.get('path') ?? '');
				if (!image) {
					this.reply(res, 404, { error: 'not_found' });
					return;
				}
				if (!this.isDirectory(image, dirPath)) {
					this.reply(res, image.files.has(dirPath) ? 400 : 404, {
						error: image.files.has(dirPath) ? 'not_a_directory' : 'not_found',
					});
					return;
				}
				const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
				const entries = new Map<string, StubFile | 'dir'>();
				for (const [filePath, file] of image.files) {
					if (!filePath.startsWith(prefix)) continue;
					const rest = filePath.slice(prefix.length);
					if (rest.includes('/')) {
						const child = rest.split('/')[0];
						if (!entries.has(child)) entries.set(child, 'dir');
					} else {
						entries.set(rest, file);
					}
				}
				for (const dir of image.dirs) {
					if (!dir.startsWith(prefix)) continue;
					const rest = dir.slice(prefix.length);
					if (rest === '') continue;
					const child = rest.includes('/') ? rest.split('/')[0] : rest;
					if (!entries.has(child)) entries.set(child, 'dir');
				}
				this.reply(res, 200, {
					path: dirPath,
					files: [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, entry]) => {
						const isDir = entry === 'dir';
						const file = isDir ? null : (entry as StubFile);
						return {
							path: name,
							size: file ? file.bytes.byteLength : 0,
							owner: 'root',
							group: 'root',
							uid: 0,
							gid: 0,
							mode: file ? file.mode : 0o40755,
							mtime: file ? file.mtime : 0,
							nlink: 1,
							is_dir: isDir,
							is_regular: !isDir,
							is_symlink: false,
							is_socket: false,
							is_fifo: false,
							symlink_to: '',
						};
					}),
				});
				return;
			}

			match = path.match(/^\/v1\/inspect\/([^/]+)\/archive$/);
			if (match && method === 'GET') {
				const image = this.image(decodeURIComponent(match[1]));
				const archivePath = this.normalize(url.searchParams.get('path') ?? '');
				if (!image || !this.isDirectory(image, archivePath)) {
					this.reply(res, 404, { error: 'not_found' });
					return;
				}
				// Deterministic stand-in for the tar archive: the driver only
				// hashes the bytes, so content shape is irrelevant to the contract.
				const prefix = archivePath === '/' ? '/' : `${archivePath}/`;
				const members = [...image.files.entries()]
					.filter(([filePath]) => filePath.startsWith(prefix))
					.sort(([a], [b]) => (a < b ? -1 : 1));
				const blob = Buffer.from(JSON.stringify(members.map(([p, f]) => [p, f.bytes.toString('base64')])), 'utf8');
				res.writeHead(200, {
					'content-type': 'application/x-tar',
					connection: 'close',
					'content-length': String(blob.byteLength),
				});
				res.end(blob);
				return;
			}

			// --- operations --------------------------------------------------------
			match = path.match(/^\/v1\/operations\/([^/]+)$/);
			if (match && method === 'GET') {
				const op = this.operations.get(decodeURIComponent(match[1]));
				if (!op) {
					this.reply(res, 404, { error: 'operation_not_found' });
					return;
				}
				this.reply(res, 200, this.operationPayload(op));
				return;
			}

			match = path.match(/^\/v1\/operations\/([^/]+)$/);
			if (match && method === 'DELETE') {
				const op = this.operations.get(decodeURIComponent(match[1]));
				if (!op) {
					this.reply(res, 404, { error: 'operation_not_found' });
					return;
				}
				if (!this.chaos.ignoreCancel && op.state === 'EXECUTING') {
					if (op.timer) clearTimeout(op.timer);
					op.state = 'CANCELLED';
				}
				this.reply(res, 200, { cancelled: true });
				return;
			}

			// --- instance spawn -----------------------------------------------------
			if (path === '/v1/instances' && method === 'POST') {
				const body = (parsedBody ?? {}) as {
					image?: unknown;
					command?: unknown;
					shell?: unknown;
					cwd?: unknown;
					files?: unknown;
					truncate_output_at?: unknown;
				};
				if (typeof body.image !== 'string' || typeof body.command !== 'string') {
					this.reply(res, 400, { error: 'invalid_instance' });
					return;
				}
				const source = this.image(body.image);
				if (!source) {
					this.reply(res, 404, { error: 'image_not_found' });
					return;
				}
				const operationId = crypto.randomUUID();
				const op: StubOperation = {
					operationId,
					imageUuid: body.image,
					command: body.command,
					state: 'EXECUTING',
					exitCode: null,
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
					stdoutTruncated: false,
					stderrTruncated: false,
					timedOut: false,
					resultImage: null,
					createdAt: Date.now(),
					durationMs: null,
				};
				this.operations.set(operationId, op);

				const truncateAt =
					typeof body.truncate_output_at === 'number' ? body.truncate_output_at : undefined;
				const attachedFiles = this.attachedFiles(body.files);
				const behavior = this.behaviorFor(body.command);

				const finish = (delayed: boolean) => {
					if (op.state !== 'EXECUTING') return;
					if (op.timer) {
						clearTimeout(op.timer);
						op.timer = undefined;
					}
					// Structural execution over a clone of the source image; the
					// result is committed as a NEW image (non-disposable runs).
					const clone: StubImage = {
						imageUuid: crypto.randomUUID(),
						files: new Map(source.files),
						dirs: new Set(source.dirs),
					};
					for (const [absPath, record] of attachedFiles) {
						clone.files.set(absPath, record);
						this.addParentDirs(clone, absPath);
					}
					for (const [path, text] of Object.entries(behavior?.writes ?? {})) {
						const absPath = this.normalize(path);
						clone.files.set(absPath, { bytes: Buffer.from(text, 'utf8'), mode: 0o100644, mtime: 1_760_000_000 });
						this.addParentDirs(clone, absPath);
					}
					const outcome = behavior
						? { exitCode: behavior.exitCode ?? 0, stderr: behavior.stderr ?? '' }
						: this.runStructural(clone, typeof body.command === 'string' ? body.command : '', attachedFiles.size > 0);
					op.exitCode = outcome.exitCode;
					op.stdout = Buffer.from(behavior?.stdout ?? '', 'utf8');
					op.stderr = Buffer.from(outcome.stderr, 'utf8');
					const total = op.stdout.byteLength + op.stderr.byteLength;
					if (truncateAt !== undefined && total > truncateAt) {
						// Keep the head of stdout; mark the stream truncated.
						const keep = Math.max(0, truncateAt - op.stderr.byteLength);
						op.stdout = op.stdout.subarray(0, keep);
						op.stdoutTruncated = true;
					}
					op.state = 'SUCCESS';
					op.resultImage = clone.imageUuid;
					this.images.set(clone.imageUuid, clone);
					op.durationMs = Date.now() - op.createdAt + (delayed ? 0 : 1);
				};

				if (behavior?.delayMs) {
					op.timer = setTimeout(() => finish(true), behavior.delayMs);
					op.timer.unref?.();
				} else {
					finish(false);
				}

				// Chaos: drop the connection WITHOUT a response — the caller cannot
				// know the dispatch landed, but the instance runs and COMMITS an
				// image we never learn (the honest divergence).
				if (this.chaos.resetNextDispatch) {
					this.chaos.resetNextDispatch = false;
					res.socket?.destroy();
					return;
				}

				this.reply(res, 200, { uuid: operationId });
				return;
			}

			this.reply(res, 404, { error: 'no_such_route' });
		} catch (error) {
			this.reply(res, 500, { error: 'stub_internal', message: String(error) });
		}
	}

	// --- instance execution helpers ---------------------------------------------------

	private operationPayload(op: StubOperation) {
		return {
			uuid: op.operationId,
			kind: 'instance',
			status: op.state,
			error: null,
			created_at: new Date(op.createdAt).toISOString(),
			duration: op.durationMs !== null ? op.durationMs / 1000 : null,
			image_size: null,
			image_uuid: op.imageUuid,
			result_image_uuid: op.resultImage,
			result: op.resultImage ? { image: op.resultImage, tag: null } : null,
			metadata: {
				command: op.command,
				image: op.imageUuid,
				result: {
					exit_code: op.exitCode,
					state: { exit_code: op.exitCode, timed_out: op.timedOut },
					stdout: {
						value: op.stdout.toString('base64'),
						encoding: 'base64',
						truncated: op.stdoutTruncated,
					},
					stderr: {
						value: op.stderr.toString('base64'),
						encoding: 'base64',
						truncated: op.stderrTruncated,
					},
				},
			},
		};
	}

	private attachedFiles(raw: unknown): Map<string, StubFile> {
		const attached = new Map<string, StubFile>();
		if (!raw || typeof raw !== 'object') return attached;
		const mtime = Math.floor(Date.now() / 1000);
		for (const [instancePath, spec] of Object.entries(raw as Record<string, unknown>)) {
			const fileSpec = spec as { uuid?: unknown; mode?: unknown };
			if (typeof fileSpec.uuid !== 'string') continue;
			const stored = [...this.filesBySha.values()].find((f) => f.uuid === fileSpec.uuid);
			if (!stored) continue;
			const mode = typeof fileSpec.mode === 'string' ? Number.parseInt(fileSpec.mode, 8) : 0o644;
			attached.set(this.normalize(instancePath), { bytes: stored.bytes, mode, mtime });
		}
		return attached;
	}

	private normalize(path: string): string {
		const segments: string[] = [];
		for (const segment of path.split('/')) {
			if (segment === '' || segment === '.') continue;
			if (segment === '..') {
				segments.pop();
				continue;
			}
			segments.push(segment);
		}
		return `/${segments.join('/')}`;
	}

	private isDirectory(image: StubImage, dirPath: string): boolean {
		if (dirPath === '/') return true;
		if (image.dirs.has(dirPath)) return true;
		const prefix = `${dirPath}/`;
		for (const filePath of image.files.keys()) {
			if (filePath.startsWith(prefix)) return true;
		}
		return false;
	}

	private addParentDirs(image: StubImage, filePath: string): void {
		const segments = filePath.split('/').filter((segment) => segment.length > 0);
		segments.pop();
		let current = '';
		for (const segment of segments) {
			current += `/${segment}`;
			image.dirs.add(current);
		}
	}

	/**
	 * Structural command interpretation for the commands the DRIVER issues.
	 * Top-level `;` splits commands — anything the driver's quoting failed to
	 * contain would land here as a separate execution (the injection tests
	 * assert that never happens). Returns the exit code of the FIRST command.
	 */
	private runStructural(
		image: StubImage,
		command: string,
		hasAttachments: boolean,
	): { exitCode: number; stderr: string } {
		const commands = splitTopLevel(command);
		for (const extra of commands.slice(1)) {
			this.shellExecutions.push(extra.trim());
		}
		const argv = tokenize(commands[0] ?? '');
		if (argv.length === 0) return { exitCode: hasAttachments ? 0 : 0, stderr: '' };
		const [program] = argv;
		if (program === 'true') return { exitCode: 0, stderr: '' };
		if (program === 'mkdir') {
			const recursive = argv.includes('-p');
			const target = argv[argv.indexOf('--') + 1];
			if (target === undefined) return { exitCode: 1, stderr: 'mkdir: missing operand' };
			const normalized = this.normalize(target);
			if (this.isDirectory(image, normalized) || image.files.has(normalized)) {
				if (recursive) return { exitCode: 0, stderr: '' };
				return { exitCode: 1, stderr: `mkdir: cannot create directory ${target}: File exists` };
			}
			if (recursive) {
				// mkdir -p creates every intermediate level.
				let current = '';
				for (const segment of normalized.split('/').filter((s) => s.length > 0)) {
					current += `/${segment}`;
					image.dirs.add(current);
				}
				return { exitCode: 0, stderr: '' };
			}
			const parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
			if (!this.isDirectory(image, parent)) {
				return {
					exitCode: 1,
					stderr: `mkdir: cannot create directory ${target}: No such file or directory`,
				};
			}
			image.dirs.add(normalized);
			return { exitCode: 0, stderr: '' };
		}
		if (program === 'rm') {
			const flags = (argv.find((arg) => arg.startsWith('-') && arg.length > 1 && arg !== '--') ?? '').replace(/^-/, '');
			const recursive = flags.includes('r');
			const force = flags.includes('f');
			const target = argv[argv.indexOf('--') + 1];
			if (target === undefined) return { exitCode: 1, stderr: 'rm: missing operand' };
			const normalized = this.normalize(target);
			const prefix = `${normalized}/`;
			const isDir = this.isDirectory(image, normalized);
			const hasChildren = [...image.files.keys()].some((filePath) => filePath.startsWith(prefix));
			if (!isDir && !image.files.has(normalized)) {
				if (force) return { exitCode: 0, stderr: '' };
				return { exitCode: 1, stderr: `rm: cannot remove ${target}: No such file or directory` };
			}
			if (isDir && hasChildren && !recursive) {
				return { exitCode: 1, stderr: `rm: cannot remove ${target}: Is a directory` };
			}
			if (isDir) {
				for (const filePath of [...image.files.keys()]) {
					if (filePath.startsWith(prefix)) image.files.delete(filePath);
				}
				for (const dir of [...image.dirs]) {
					if (dir === normalized || dir.startsWith(prefix)) image.dirs.delete(dir);
				}
				image.dirs.delete(normalized);
			} else {
				image.files.delete(normalized);
			}
			return { exitCode: 0, stderr: '' };
		}
		// Unknown programs are not interpreted (no shell emulation beyond the
		// driver's own commands) — canned behavior supplies the outcome.
		return { exitCode: 0, stderr: '' };
	}
}

// --- shell-ish tokenization (single quotes only, as the driver quotes) -----------

/**
 * Split a command line on top-level `;` separators — honoring single-quoted
 * literals and backslash escapes, so the driver's `'\''` quoting keeps an
 * embedded `;` inside one command.
 */
export function splitTopLevel(command: string): string[] {
	const parts: string[] = [];
	let current = '';
	let i = 0;
	while (i < command.length) {
		const char = command[i];
		if (char === "'") {
			// Whole single-quoted literal is inert.
			const end = command.indexOf("'", i + 1);
			if (end === -1) {
				current += command.slice(i);
				i = command.length;
				continue;
			}
			current += command.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (char === '\\' && i + 1 < command.length) {
			// Backslash escape: the next character (even a quote) is inert.
			current += command.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (char === ';') {
			parts.push(current);
			current = '';
			i += 1;
			continue;
		}
		current += char;
		i += 1;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Tokenize a command line honoring single-quoted literals and backslash
 * escapes (POSIX), including the driver's `'\''` idiom — a path like
 * `x'; echo pwned` quotes back to exactly one argv.
 */
export function tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let hasToken = false;
	let i = 0;
	while (i < command.length) {
		const char = command[i];
		if (char === "'") {
			// Single-quoted literal: nothing inside is special until the next `'`.
			const end = command.indexOf("'", i + 1);
			if (end === -1) {
				current += command.slice(i + 1);
				i = command.length;
			} else {
				current += command.slice(i + 1, end);
				i = end + 1;
			}
			hasToken = true;
			continue;
		}
		if (char === '\\' && i + 1 < command.length) {
			current += command[i + 1];
			i += 2;
			hasToken = true;
			continue;
		}
		if (char === ' ' || char === '\t') {
			if (current.length > 0 || hasToken) {
				tokens.push(current);
				current = '';
				hasToken = false;
			}
			i += 1;
			continue;
		}
		current += char;
		hasToken = true;
		i += 1;
	}
	if (current.length > 0 || hasToken) tokens.push(current);
	return tokens;
}
