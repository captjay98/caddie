import {
	ContreeClient,
	ContreeApiError,
	base64ToBytes,
	bytesToBase64,
	isImageUuid,
	type ContreeConfig,
	type ContreeOperationState,
	type ContreeFileItem,
} from './contree.ts';

/**
 * P04/P05 Workers-native sandbox driver (contracts.md "Sandbox and
 * verification").
 *
 * Implements the SandboxDriver surface over the contree REST client
 * (`./contree.ts`) — fetch-only, no child_process: the CLI cannot spawn under
 * Workers (feature-ledger settled decision).
 *
 * THE SESSION MODEL (audit P05 finding 1): contree has NO server-side
 * sessions — it is content-addressed. State is a chain of IMAGE snapshots:
 * every non-disposable instance run commits a new image; reads
 * (`/inspect/{image}/…`) address any image. A "session" is therefore OUR
 * bookkeeping: a caller-chosen session key mapped to the CURRENT image uuid
 * plus its workspace root, persisted through the {@link SandboxPersistencePort}
 * BEFORE anything is exposed. `ensureSession` creates that record on first
 * use (bootstrapping the workspace directory with one real instance run) and
 * is idempotent + single-flight per isolate; the agent tool path calls it
 * lazily once per (run, isolate) before any other operation.
 *
 * Semantics that the contract pins down and the tests prove:
 *   - Persistence BEFORE exposure: the session binding (with its current
 *     image) is persisted before `ensureSession`/`create` return; the remote
 *     operation identity is persisted before any completion is exposed; a
 *     successful run's NEW image is persisted before the result is returned;
 *     the artifactRef is persisted before `export` returns.
 *   - Every dispatch carries a caller operation key for correlation. The real
 *     API is NON-idempotent (no key replay guarantee), so a transport failure
 *     on dispatch throws AMBIGUOUS_DISPATCH with state 'ambiguous' and — when
 *     the operation uuid was never learned — stays honestly `unknown` under
 *     `reconcileOperation`. Never a blind re-dispatch.
 *   - A cancellation REQUEST (`DELETE /operations/{id}`) is not confirmed
 *     termination: `cancel` returns `{requested}` and only `status` proves a
 *     terminal outcome. Aborting releases the caller promptly AND requests
 *     the remote cancellation.
 *   - `status` reports 'unknown' rather than fabricating state.
 *
 * NO SHELL BUILT FROM MODEL INPUT (audit P05 finding 2): readFile /
 * writeFile / stat / readdir / exists travel over the content-addressed files
 * API and the inspect endpoints — no command text is constructed from
 * model-controlled paths. Only mkdir/rm have no REST endpoint and run as
 * instance commands; their paths are embedded with {@link shellQuote}
 * (provable single-quote escaping) and validated by
 * {@link resolveWorkspacePath} first (traversal rejected — kept from P04).
 *
 * Hardening (bounded uploads/output, traversal/symlink rejection, time
 * quotas, credential-exclusion) is layered in this same driver.
 */

// --- public types ---------------------------------------------------------------

export interface SandboxQuotas {
	/** Per-file decoded upload bound in bytes. */
	maxUploadBytes: number;
	/** Bound on captured command output (stdout+stderr) in bytes. */
	maxOutputBytes: number;
	/** Upper bound accepted for a single command's timeoutMs. */
	maxCommandTimeoutMs: number;
}

export interface SandboxDriverConfig {
	contree: ContreeConfig;
	quotas: SandboxQuotas;
	/** Absolute sandbox prefix under which per-project workspaces live. */
	workspaceRoot: string;
	pollIntervalMs?: number;
	/** Bound on the dispatch HTTP call itself (default 10s). */
	dispatchTimeoutMs?: number;
	/** Bound on one reconciliation poll cycle (default 5s). */
	reconcileTimeoutMs?: number;
}

export type SandboxState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface SandboxStatusResult {
	state: SandboxState;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	outputBytes?: number;
}

export interface SandboxExecuteInput {
	sessionId: string;
	command: string;
	operationKey: string;
	timeoutMs: number;
	signal?: AbortSignal;
	cwd?: string;
	env?: Record<string, string>;
}

export interface SandboxExecuteResult {
	remoteId: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface SandboxFileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink?: boolean;
	size: number | null;
	mtime?: Date;
}

export interface SandboxRecord {
	kind: 'session' | 'operation' | 'artifact';
	/** `session:<sessionKey>` | `op:<operationKey>` | `artifact:<sessionId>` */
	key: string;
	/** For sessions this IS the caller-chosen session key. */
	sessionId: string | null;
	projectId: string | null;
	runId: string | null;
	/** Current image uuid of the session chain (session records). */
	image: string | null;
	checkpointRef: string | null;
	operationKey: string | null;
	remoteId: string | null;
	/**
	 * session: 'active' | 'disposed'; operation: 'dispatching' | 'dispatched' |
	 * 'ambiguous' | 'succeeded' | 'failed' | 'cancelled' | 'cancel-requested';
	 * artifact: 'exported'.
	 */
	state: string;
	artifactRef: string | null;
	sha256: string | null;
	updatedAt: string;
}

/**
 * Persistence port implemented by CALLERS: tests use the in-memory
 * implementation below; production wires a D1-backed port (a small table
 * `sandbox_bindings` keyed by `key` — migration owned by the
 * integration lead, see docs/setup/sandbox.md). The driver persists remote
 * identity through this port BEFORE exposing completion, so a crashed or
 * restarted driver can always reconcile by persisted key.
 */
export interface SandboxPersistencePort {
	save(record: SandboxRecord): Promise<void>;
	load(key: string): Promise<SandboxRecord | null>;
}

export class InMemorySandboxPersistence implements SandboxPersistencePort {
	private readonly records = new Map<string, SandboxRecord>();

	save(record: SandboxRecord): Promise<void> {
		this.records.set(record.key, { ...record });
		return Promise.resolve();
	}

	load(key: string): Promise<SandboxRecord | null> {
		const record = this.records.get(key);
		return Promise.resolve(record ? { ...record } : null);
	}
}

/** Typed driver failure, mirroring the ScopeError pattern of P02/P03. */
export class SandboxError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly detail: Record<string, unknown> = {},
	) {
		super(message);
		this.name = 'SandboxError';
	}
}

// --- helpers ---------------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new SandboxError(400, 'INVALID_INPUT', `${field} is required`);
	}
	return value;
}

function isTerminalState(
	state: ContreeOperationState,
): state is 'SUCCEEDED' | 'FAILED' | 'CANCELLED' {
	return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

function encodedByteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Exact decoded size of (valid) base64 without allocating the payload — enough
 * to enforce the upload bound BEFORE any decode or network call.
 */
function base64ByteLength(contentBase64: string): number {
	const withoutPadding = contentBase64.replace(/=+$/, '');
	return Math.floor((withoutPadding.length * 3) / 4);
}

function terminalSandboxState(
	state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
): Exclude<SandboxState, 'running' | 'unknown'> {
	switch (state) {
		case 'SUCCEEDED':
			return 'succeeded';
		case 'FAILED':
			return 'failed';
		case 'CANCELLED':
			return 'cancelled';
	}
}

/**
 * Embed a string into a POSIX shell command as a single-quoted literal.
 * The only character that can terminate a single-quoted shell string is `'`
 * itself, and this replaces every `'` with the four-character sequence
 * `'\''` (close quote, escaped quote, reopen quote), so NO input — however
 * adversarial — can break out of the literal. Unit-tested against injection
 * payloads; every path-bearing shell command in this driver goes through it.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a caller-supplied workspace-relative upload path against the session
 * workspace root. HARDENING (kept from P04): absolute paths and any '..'
 * segment are rejected BEFORE anything is sent; '.' segments are resolved; the
 * result is always inside the root. Symlink escapes cannot be seen from the
 * client side, so they are enforced by the sandbox service (path_escape) and
 * mapped to the same typed error — defense in depth.
 */
function resolveRelativeSandboxPath(root: string, relativePath: string): string {
	if (relativePath.includes('\0')) {
		throw new SandboxError(400, 'INVALID_INPUT', 'upload path contains a NUL byte');
	}
	if (relativePath.startsWith('/')) {
		throw new SandboxError(
			400,
			'UPLOAD_PATH_ESCAPE',
			`upload path must be relative to the session workspace, got absolute: ${relativePath}`,
		);
	}
	const segments: string[] = [];
	for (const segment of relativePath.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			throw new SandboxError(
				400,
				'UPLOAD_PATH_ESCAPE',
				`upload path must not contain '..' segments: ${relativePath}`,
			);
		}
		segments.push(segment);
	}
	if (segments.length === 0) {
		throw new SandboxError(400, 'INVALID_INPUT', 'upload path resolves to the workspace root');
	}
	return `${root}/${segments.join('/')}`;
}

/**
 * Resolve a file path that may be workspace-relative (the SandboxToolDeps
 * contract) OR absolute inside the session workspace (the flue runtime
 * resolves model paths against the sandbox cwd — the session workspace root —
 * before the driver sees them). Both must land inside the root:
 *   - relative: {@link resolveRelativeSandboxPath} (strict — no '..'), or the
 *     root itself for '.' when `allowRoot` (stat/list of the workspace root);
 *   - absolute: accepted ONLY if it normalizes to the root itself or below
 *     it; any escape is the same typed UPLOAD_PATH_ESCAPE.
 */
function resolveWorkspacePath(
	root: string,
	path: string,
	options?: { allowRoot?: boolean },
): string {
	if (path.includes('\0')) {
		throw new SandboxError(400, 'INVALID_INPUT', 'path contains a NUL byte');
	}
	const rootNoSlash = root.replace(/\/+$/, '') || '/';
	if (path.startsWith('/')) {
		const segments: string[] = [];
		for (const segment of path.split('/')) {
			if (segment === '' || segment === '.') continue;
			if (segment === '..') {
				if (segments.length === 0) {
					throw new SandboxError(
						400,
						'UPLOAD_PATH_ESCAPE',
						`path escapes the session workspace: ${path}`,
					);
				}
				segments.pop();
				continue;
			}
			segments.push(segment);
		}
		// The path is already absolute: normalize it AS an absolute path, then
		// require it to stay inside (or be) the workspace root.
		const normalized = `/${segments.join('/')}`;
		if (normalized !== rootNoSlash && !normalized.startsWith(`${rootNoSlash}/`)) {
			throw new SandboxError(400, 'UPLOAD_PATH_ESCAPE', `path escapes the session workspace: ${path}`);
		}
		return normalized;
	}
	const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
	if (segments.length === 0) {
		if (options?.allowRoot) return rootNoSlash;
		return resolveRelativeSandboxPath(root, path); // keeps the strict write-path error
	}
	return resolveRelativeSandboxPath(root, path);
}

/** Parent directory of an absolute workspace path (root for root-level entries). */
function parentDirectory(root: string, absolutePath: string): string {
	const rootNoSlash = root.replace(/\/+$/, '');
	if (absolutePath === rootNoSlash) return rootNoSlash;
	const index = absolutePath.lastIndexOf('/');
	if (index <= rootNoSlash.length) return rootNoSlash;
	return absolutePath.slice(0, index);
}

function baseName(absolutePath: string): string {
	const segments = absolutePath.split('/').filter((segment) => segment.length > 0);
	return segments[segments.length - 1] ?? '';
}

// --- driver ----------------------------------------------------------------------

export class SandboxDriver {
	private readonly contree: ContreeClient;
	private readonly pollIntervalMs: number;
	private readonly dispatchTimeoutMs: number;
	private readonly reconcileTimeoutMs: number;
	/** Single-flight creation promises, per session key, per driver instance. */
	private readonly ensureInflight = new Map<string, Promise<{ sessionId: string }>>();

	constructor(
		private readonly config: SandboxDriverConfig,
		private readonly persistence: SandboxPersistencePort,
	) {
		this.contree = new ContreeClient(config.contree);
		this.pollIntervalMs = config.pollIntervalMs ?? 50;
		this.dispatchTimeoutMs = config.dispatchTimeoutMs ?? 10_000;
		this.reconcileTimeoutMs = config.reconcileTimeoutMs ?? 5_000;
	}

	// --- session lifecycle ---------------------------------------------------------

	/**
	 * Create-or-get the run's session under a CALLER-CHOSEN key (audit P05
	 * finding 1). Idempotent: an existing active binding is returned as-is;
	 * otherwise one real instance run bootstraps the workspace directory and
	 * the binding (key → current image) is persisted before returning.
	 * Concurrency-safe within an isolate: concurrent calls for the same key
	 * share one creation promise (single-flight), so exactly one bootstrap
	 * runs no matter how many tool calls race.
	 */
	async ensureSession(input: {
		sessionKey: string;
		image: string;
		projectId: string;
		runId: string;
	}): Promise<{ sessionId: string }> {
		const sessionKey = requireNonEmpty(input.sessionKey, 'sessionKey');
		const image = requireNonEmpty(input.image, 'image');
		const projectId = requireNonEmpty(input.projectId, 'projectId');
		const runId = requireNonEmpty(input.runId, 'runId');
		const key = `session:${sessionKey}`;
		const inflight = this.ensureInflight.get(key);
		if (inflight) return inflight;
		const promise = this.ensureSessionOnce({ sessionKey, image, projectId, runId }).finally(() => {
			this.ensureInflight.delete(key);
		});
		this.ensureInflight.set(key, promise);
		return promise;
	}

	private async ensureSessionOnce(input: {
		sessionKey: string;
		image: string;
		projectId: string;
		runId: string;
	}): Promise<{ sessionId: string }> {
		const { sessionKey, image, projectId, runId } = input;
		const existing = await this.persistence.load(`session:${sessionKey}`);
		if (existing?.kind === 'session') {
			if (existing.state === 'disposed') {
				throw new SandboxError(410, 'SESSION_LOST', `session ${sessionKey} was disposed`);
			}
			if (existing.projectId !== null && existing.projectId !== projectId) {
				throw new SandboxError(
					409,
					'SESSION_KEY_CONFLICT',
					`session key ${sessionKey} is already bound to project ${existing.projectId}`,
				);
			}
			return { sessionId: existing.sessionId ?? sessionKey };
		}
		const workspaceRoot = this.sessionWorkspaceRoot(projectId);
		// One real instance run bootstraps the workspace directory and yields
		// the session's first committed image. This is "creating the session".
		const bootstrapped = await this.runInstance({
			operationKey: `session-bootstrap:${sessionKey}`,
			imageRef: image,
			command: `mkdir -p -- ${shellQuote(workspaceRoot)}`,
			cwd: '/',
			timeoutMs: Math.min(120_000, this.config.quotas.maxCommandTimeoutMs),
		});
		if (bootstrapped.exitCode !== 0 || bootstrapped.resultImage === null) {
			throw new SandboxError(
				502,
				'SESSION_BOOTSTRAP_FAILED',
				`bootstrap of session ${sessionKey} failed (exit ${bootstrapped.exitCode})`,
				{ stderr: bootstrapped.stderr.slice(0, 2000) },
			);
		}
		// Binding persisted BEFORE the id is exposed: a crash after the remote
		// work still leaves the binding; ensureSession re-runs are idempotent
		// because the persistence check above sees it.
		await this.persistence.save({
			kind: 'session',
			key: `session:${sessionKey}`,
			sessionId: sessionKey,
			projectId,
			runId,
			image: bootstrapped.resultImage,
			checkpointRef: null,
			operationKey: null,
			remoteId: null,
			state: 'active',
			artifactRef: null,
			sha256: null,
			updatedAt: nowIso(),
		});
		return { sessionId: sessionKey };
	}

	/**
	 * Named-session creation with the derived logical key (kept for callers
	 * that think in project/run pairs). Same bookkeeping as ensureSession.
	 */
	async create(input: {
		projectId: string;
		runId: string;
		image: string;
	}): Promise<{ sessionId: string }> {
		const projectId = requireNonEmpty(input.projectId, 'projectId');
		const runId = requireNonEmpty(input.runId, 'runId');
		return this.ensureSession({
			sessionKey: `caddie:${projectId}:${runId}`,
			image: input.image,
			projectId,
			runId,
		});
	}

	async checkpoint(sessionId: string): Promise<{ checkpointRef: string }> {
		requireNonEmpty(sessionId, 'sessionId');
		const session = await this.requireActiveSession(sessionId);
		// The current image IS the checkpoint: a committed filesystem snapshot.
		const checkpointRef = requireNonEmpty(session.image, 'session image');
		await this.persistence.save({ ...session, checkpointRef, updatedAt: nowIso() });
		return { checkpointRef };
	}

	/**
	 * Start a session from a checkpoint: a NEW session key whose current image
	 * is the checkpoint's image. The image is verified to exist (a missing
	 * checkpoint is a typed 404, never a silent fabrication).
	 */
	async restore(input: {
		checkpointRef: string;
		projectId: string;
		runId: string;
	}): Promise<{ sessionId: string }> {
		const checkpointRef = requireNonEmpty(input.checkpointRef, 'checkpointRef');
		const projectId = requireNonEmpty(input.projectId, 'projectId');
		const runId = requireNonEmpty(input.runId, 'runId');
		try {
			const probe = await this.contree.inspectList(checkpointRef, '/');
			if (probe === null) {
				throw new SandboxError(
					404,
					'CHECKPOINT_NOT_FOUND',
					`no such checkpoint ${checkpointRef} — restore refused`,
				);
			}
		} catch (error) {
			if (error instanceof SandboxError) throw error;
			throw this.mapContreeError(error, 'RESTORE_FAILED', `restore from ${checkpointRef} failed`);
		}
		const sessionKey = `caddie:${projectId}:${runId}:restore:${checkpointRef}`;
		const existing = await this.persistence.load(`session:${sessionKey}`);
		if (existing?.kind === 'session' && existing.state === 'active') {
			return { sessionId: existing.sessionId ?? sessionKey };
		}
		await this.persistence.save({
			kind: 'session',
			key: `session:${sessionKey}`,
			sessionId: sessionKey,
			projectId,
			runId,
			image: checkpointRef,
			checkpointRef,
			operationKey: null,
			remoteId: null,
			state: 'active',
			artifactRef: null,
			sha256: null,
			updatedAt: nowIso(),
		});
		return { sessionId: sessionKey };
	}

	/**
	 * Export the workspace as a tar archive (the inspect archive endpoint),
	 * hashed locally. The artifact identity is persisted BEFORE `export`
	 * returns, so session loss after this point cannot lose the export.
	 */
	async export(sessionId: string): Promise<{ artifactRef: string; sha256: string }> {
		requireNonEmpty(sessionId, 'sessionId');
		const session = await this.requireActiveSession(sessionId);
		const image = requireNonEmpty(session.image, 'session image');
		const root = this.sessionWorkspaceRoot(session.projectId ?? '');
		let bytes: Uint8Array;
		try {
			const response = await this.contree.inspectArchive(image, root);
			if (response === null) {
				throw new SandboxError(404, 'FILE_NOT_FOUND', `workspace ${root} is gone from image ${image}`);
			}
			bytes = response;
		} catch (error) {
			if (error instanceof SandboxError) throw error;
			throw this.mapContreeError(error, 'EXPORT_FAILED', `export of session ${sessionId} failed`);
		}
		const sha256 = await sha256Hex(bytes);
		const artifactRef = `inspect-archive:${image}:${root}`;
		await this.persistence.save({
			kind: 'artifact',
			key: `artifact:${sessionId}`,
			sessionId,
			projectId: session.projectId,
			runId: session.runId,
			image,
			checkpointRef: null,
			operationKey: null,
			remoteId: null,
			state: 'exported',
			artifactRef,
			sha256,
			updatedAt: nowIso(),
		});
		return { artifactRef, sha256 };
	}

	/** Read the persisted export record (survives session loss). */
	async getExportedArtifact(
		sessionId: string,
	): Promise<{ artifactRef: string; sha256: string } | null> {
		requireNonEmpty(sessionId, 'sessionId');
		const record = await this.persistence.load(`artifact:${sessionId}`);
		if (!record || record.artifactRef === null || record.sha256 === null) return null;
		return { artifactRef: record.artifactRef, sha256: record.sha256 };
	}

	/**
	 * Dispose the session binding. There is no server-side session object to
	 * delete (instances are one-shot; images are content-addressed), so this
	 * is local truth: the binding is marked disposed and every further use is
	 * a typed SESSION_LOST.
	 */
	async dispose(sessionId: string): Promise<void> {
		requireNonEmpty(sessionId, 'sessionId');
		const existing = await this.persistence.load(`session:${sessionId}`);
		if (existing?.state === 'disposed') return; // idempotent
		await this.persistence.save({
			...(existing ?? {
				kind: 'session' as const,
				key: `session:${sessionId}`,
				sessionId,
				projectId: null,
				runId: null,
				image: null,
				checkpointRef: null,
				operationKey: null,
				remoteId: null,
				artifactRef: null,
				sha256: null,
			}),
			state: 'disposed',
			updatedAt: nowIso(),
		});
	}

	// --- files -----------------------------------------------------------------------

	/**
	 * Read one file through the inspect download endpoint — no shell, no
	 * model-controlled command text. Traversal is rejected first (kept from
	 * P04). Missing files are a typed FILE_NOT_FOUND.
	 */
	async readFile(
		sessionId: string,
		path: string,
	): Promise<{ contentBase64: string; size: number }> {
		requireNonEmpty(sessionId, 'sessionId');
		const pathValue = requireNonEmpty(path, 'path');
		const session = await this.requireActiveSession(sessionId);
		const root = this.sessionWorkspaceRoot(session.projectId ?? '');
		const absolutePath = resolveWorkspacePath(root, pathValue);
		const image = requireNonEmpty(session.image, 'session image');
		let bytes: Uint8Array | null;
		try {
			bytes = await this.contree.inspectDownload(image, absolutePath);
		} catch (error) {
			throw this.mapContreeError(error, 'READ_FAILED', `read of ${pathValue} failed`);
		}
		if (bytes === null) {
			throw new SandboxError(404, 'FILE_NOT_FOUND', `cannot read ${pathValue}: no such file in the session workspace`);
		}
		return { contentBase64: bytesToBase64(bytes), size: bytes.byteLength };
	}

	/**
	 * Write one file: content-addressed upload (`POST /files`) followed by one
	 * commit instance that attaches the file at its absolute workspace path —
	 * the same staged-pending-file flow the contree CLI uses (`file cp` then a
	 * trivial run). The session's current image advances to the commit result.
	 */
	async writeFile(
		sessionId: string,
		path: string,
		contentBase64: string,
	): Promise<{ saved: number }> {
		requireNonEmpty(sessionId, 'sessionId');
		const pathValue = requireNonEmpty(path, 'path');
		if (typeof contentBase64 !== 'string') {
			throw new SandboxError(400, 'INVALID_INPUT', 'contentBase64 is required');
		}
		const session = await this.requireActiveSession(sessionId);
		const root = this.sessionWorkspaceRoot(session.projectId ?? '');
		const absolutePath = resolveWorkspacePath(root, pathValue);
		const decodedBytes = base64ByteLength(contentBase64);
		if (decodedBytes > this.config.quotas.maxUploadBytes) {
			throw new SandboxError(
				413,
				'UPLOAD_TOO_LARGE',
				`upload of ${pathValue} is ${decodedBytes} bytes, above the ${this.config.quotas.maxUploadBytes}-byte quota`,
			);
		}
		const image = requireNonEmpty(session.image, 'session image');
		let record;
		try {
			record = await this.contree.uploadFileBytes(base64ToBytes(contentBase64));
		} catch (error) {
			throw this.mapContreeError(error, 'UPLOAD_FAILED', `upload of ${pathValue} failed`);
		}
		const committed = await this.runInstance({
			operationKey: `write:${sessionId}:${record.sha256}`,
			imageRef: image,
			command: 'true',
			files: [{ path: absolutePath, uuid: record.uuid, mode: '0644' }],
			timeoutMs: Math.min(120_000, this.config.quotas.maxCommandTimeoutMs),
		});
		if (committed.exitCode !== 0 || committed.resultImage === null) {
			throw new SandboxError(
				502,
				'UPLOAD_COMMIT_FAILED',
				`commit of ${pathValue} into the session image failed`,
				{ stderr: committed.stderr.slice(0, 2000) },
			);
		}
		await this.advanceSessionImage(session, committed.resultImage);
		return { saved: 1 };
	}

	/**
	 * Batch variant of {@link writeFile}: every file is validated FIRST (a
	 * rejected batch must not partially upload), then uploaded, then committed
	 * with ONE instance run.
	 */
	async uploadFiles(
		sessionId: string,
		files: ReadonlyArray<{ path: string; contentBase64: string }>,
	): Promise<{ saved: number }> {
		requireNonEmpty(sessionId, 'sessionId');
		if (!Array.isArray(files) || files.length === 0) {
			throw new SandboxError(400, 'INVALID_INPUT', 'files must be a non-empty array');
		}
		const session = await this.requireActiveSession(sessionId);
		const root = this.sessionWorkspaceRoot(session.projectId ?? '');
		// Validate EVERYTHING first.
		const prepared = files.map((file) => {
			const path = requireNonEmpty(file.path, 'path');
			if (typeof file.contentBase64 !== 'string') {
				throw new SandboxError(400, 'INVALID_INPUT', 'contentBase64 is required');
			}
			const absolutePath = resolveWorkspacePath(root, path);
			const decodedBytes = base64ByteLength(file.contentBase64);
			if (decodedBytes > this.config.quotas.maxUploadBytes) {
				throw new SandboxError(
					413,
					'UPLOAD_TOO_LARGE',
					`upload of ${path} is ${decodedBytes} bytes, above the ${this.config.quotas.maxUploadBytes}-byte quota`,
				);
			}
			return { absolutePath, contentBase64: file.contentBase64, path };
		});
		const image = requireNonEmpty(session.image, 'session image');
		const attached: Awaited<Parameters<ContreeClient['spawnInstance']>[0]['files']> = [];
		try {
			for (const file of prepared) {
				const record = await this.contree.uploadFileBytes(base64ToBytes(file.contentBase64));
				attached.push({ path: file.absolutePath, uuid: record.uuid, mode: '0644' });
			}
		} catch (error) {
			throw this.mapContreeError(error, 'UPLOAD_FAILED', 'batch upload failed');
		}
		const committed = await this.runInstance({
			operationKey: `write-batch:${sessionId}:${nowIso()}`,
			imageRef: image,
			command: 'true',
			files: attached,
			timeoutMs: Math.min(120_000, this.config.quotas.maxCommandTimeoutMs),
		});
		if (committed.exitCode !== 0 || committed.resultImage === null) {
			throw new SandboxError(502, 'UPLOAD_COMMIT_FAILED', 'commit of the batch into the session image failed');
		}
		await this.advanceSessionImage(session, committed.resultImage);
		return { saved: prepared.length };
	}

	/**
	 * Real stat via the inspect list endpoint (parent directory + entry),
	 * preserving full fidelity: isFile/isDirectory/symlink/size/mtime. No
	 * shell, no hardcoded `{isFile: true}` fabrication (audit P05 finding 5).
	 */
	async statFile(sessionId: string, path: string): Promise<SandboxFileStat> {
		const { image, absolutePath, root } = await this.requireSessionForRead(sessionId, path);
		if (absolutePath === root.replace(/\/+$/, '')) {
			return { isFile: false, isDirectory: true, size: null };
		}
		const listing = await this.requireListing(image, parentDirectory(root, absolutePath), path);
		const entry = listing.files.find((item) => item.path === baseName(absolutePath));
		if (!entry) {
			throw new SandboxError(404, 'FILE_NOT_FOUND', `stat failed for ${path}: no such path in the session workspace`);
		}
		return {
			isFile: entry.isRegular && !entry.isDir,
			isDirectory: entry.isDir,
			isSymbolicLink: entry.isSymlink || undefined,
			size: entry.size,
			mtime: entry.mtime > 0 ? new Date(entry.mtime * 1000) : undefined,
		};
	}

	/** Real directory listing via the inspect list endpoint. */
	async listDir(sessionId: string, path: string): Promise<string[]> {
		const { image, absolutePath } = await this.requireSessionForRead(sessionId, path);
		const listing = await this.requireListing(image, absolutePath, path);
		return listing.files.map((item) => item.path);
	}

	/** Stat-based existence: typed FILE_NOT_FOUND maps to false, other errors rethrow. */
	async pathExists(sessionId: string, path: string): Promise<boolean> {
		try {
			await this.statFile(sessionId, path);
			return true;
		} catch (error) {
			if (error instanceof SandboxError && error.code === 'FILE_NOT_FOUND') return false;
			throw error;
		}
	}

	/**
	 * mkdir has no REST endpoint; it runs as an instance command. The path is
	 * workspace-validated and shell-quoted (injection-proven), and the
	 * `recursive` option is honored (audit P05 finding 5).
	 */
	async mkdir(sessionId: string, path: string, options?: { recursive?: boolean }): Promise<void> {
		requireNonEmpty(sessionId, 'sessionId');
		const pathValue = requireNonEmpty(path, 'path');
		const session = await this.requireActiveSession(sessionId);
		const root = this.sessionWorkspaceRoot(session.projectId ?? '');
		const absolutePath = resolveWorkspacePath(root, pathValue);
		// argv-style build: no flag means no flag token (never a bare `-`).
		const command = ['mkdir', ...(options?.recursive ? ['-p'] : []), '--', shellQuote(absolutePath)].join(' ');
		const result = await this.executeForSession(session, {
			command,
			operationKey: `mkdir:${session.sessionId}:${await shortHash(pathValue)}`,
			timeoutMs: Math.min(60_000, this.config.quotas.maxCommandTimeoutMs),
		});
		if (result.exitCode !== 0) {
			const exists = result.stderr.includes('File exists');
			throw new SandboxError(
				exists ? 409 : 400,
				exists ? 'MKDIR_EXISTS' : 'MKDIR_FAILED',
				`mkdir failed for ${pathValue}`,
				{ stderr: result.stderr.slice(0, 2000) },
			);
		}
	}

	/**
	 * rm as an instance command; `recursive` and `force` are honored (audit
	 * P05 finding 5). Missing path without force is a typed FILE_NOT_FOUND.
	 */
	async removePath(
		sessionId: string,
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		requireNonEmpty(sessionId, 'sessionId');
		const pathValue = requireNonEmpty(path, 'path');
		const session = await this.requireActiveSession(sessionId);
		const root = this.sessionWorkspaceRoot(session.projectId ?? '');
		const absolutePath = resolveWorkspacePath(root, pathValue);
		const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
		const command = ['rm', ...(flags ? [`-${flags}`] : []), '--', shellQuote(absolutePath)].join(' ');
		const result = await this.executeForSession(session, {
			command,
			operationKey: `rm:${session.sessionId}:${await shortHash(pathValue)}`,
			timeoutMs: Math.min(120_000, this.config.quotas.maxCommandTimeoutMs),
		});
		if (result.exitCode !== 0 && !options?.force) {
			const missing = result.stderr.includes('No such file or directory');
			throw new SandboxError(
				missing ? 404 : 400,
				missing ? 'FILE_NOT_FOUND' : 'RM_FAILED',
				`rm failed for ${pathValue}`,
				{ stderr: result.stderr.slice(0, 2000) },
			);
		}
	}

	// --- execution ---------------------------------------------------------------------

	async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
		const sessionId = requireNonEmpty(input.sessionId, 'sessionId');
		const session = await this.requireActiveSession(sessionId);
		const result = await this.executeForSession(session, input);
		return {
			remoteId: result.remoteId,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}

	/** Honest status: never fabricates; transport/404 failures read as 'unknown'. */
	async status(remoteId: string): Promise<SandboxStatusResult> {
		requireNonEmpty(remoteId, 'remoteId');
		const operation = await this.contree.getOperation(remoteId).catch(() => null);
		if (!operation) return { state: 'unknown' };
		switch (operation.state) {
			case 'PENDING':
			case 'ASSIGNED':
			case 'EXECUTING':
				return { state: 'running' };
			case 'SUCCEEDED':
				return {
					state: 'succeeded',
					exitCode: operation.exitCode ?? undefined,
					stdout: operation.stdout,
					stderr: operation.stderr,
					outputBytes: operation.outputBytes ?? undefined,
				};
			case 'FAILED':
				return {
					state: 'failed',
					exitCode: operation.exitCode ?? undefined,
					stdout: operation.stdout,
					stderr: operation.stderr,
					outputBytes: operation.outputBytes ?? undefined,
				};
			case 'CANCELLED':
				return { state: 'cancelled' };
			default:
				return { state: 'unknown' };
		}
	}

	/** Cancellation REQUEST — `{requested}` says nothing about termination. */
	async cancel(remoteId: string): Promise<{ requested: boolean }> {
		requireNonEmpty(remoteId, 'remoteId');
		try {
			await this.contree.cancelOperation(remoteId, AbortSignal.timeout(this.dispatchTimeoutMs));
			return { requested: true };
		} catch (error) {
			if (error instanceof ContreeApiError && error.status === 404) return { requested: false };
			return { requested: false };
		}
	}

	/**
	 * Reconcile a persisted operation by ITS KEY (never a blind re-dispatch).
	 * The real API has no by-key correlation lookup, so adoption is only
	 * possible when the remote id was persisted; otherwise the honest answer
	 * is 'unknown' and the record keeps its ambiguous state.
	 */
	async reconcileOperation(operationKey: string): Promise<SandboxStatusResult> {
		requireNonEmpty(operationKey, 'operationKey');
		const stored = await this.persistence.load(`op:${operationKey}`);
		if (!stored || stored.kind !== 'operation') {
			throw new SandboxError(
				404,
				'OPERATION_NOT_RECORDED',
				`no persisted operation for key ${operationKey} — reconciliation needs the persisted identity`,
			);
		}
		let remoteId = stored.remoteId;
		if (remoteId === null) {
			// No server-side correlation exists: without a remote id the
			// outcome is unknowable — say so instead of retrying blindly.
			return { state: 'unknown' };
		}
		const bound = Date.now() + this.reconcileTimeoutMs;
		for (;;) {
			const operation = await this.contree.getOperation(remoteId).catch(() => null);
			if (operation && isTerminalState(operation.state)) {
				const outcome = terminalSandboxState(operation.state);
				await this.persistence.save({ ...stored, remoteId, state: outcome, updatedAt: nowIso() });
				// Adopt the committed image into the linked session: a driver that
				// died mid-exec must not leave the session's image chain behind
				// the work it already settled.
				if (
					operation.state === 'SUCCEEDED' &&
					operation.resultImage !== null &&
					stored.sessionId !== null
				) {
					const session = await this.persistence.load(`session:${stored.sessionId}`);
					if (session?.kind === 'session' && session.state === 'active' && session.image !== null) {
						await this.advanceSessionImage(session, operation.resultImage);
					}
				}
				return { state: outcome, exitCode: operation.exitCode ?? undefined };
			}
			if (Date.now() >= bound) return { state: 'unknown' };
			await sleep(this.pollIntervalMs);
		}
	}

	// --- internals -------------------------------------------------------------------

	/** Workspace directory of one project's sessions. */
	private sessionWorkspaceRoot(projectId: string): string {
		return `${this.config.workspaceRoot.replace(/\/+$/, '')}/${projectId}`;
	}

	private async requireActiveSession(sessionId: string): Promise<SandboxRecord> {
		const record = await this.persistence.load(`session:${sessionId}`);
		if (!record || record.kind !== 'session') {
			throw new SandboxError(
				404,
				'SESSION_LOST',
				`no persisted binding for session ${sessionId} — create it first`,
			);
		}
		if (record.state === 'disposed') {
			throw new SandboxError(410, 'SESSION_LOST', `session ${sessionId} was disposed`);
		}
		if (record.image === null) {
			throw new SandboxError(410, 'SESSION_LOST', `session ${sessionId} has no current image`);
		}
		return record;
	}

	private async requireSessionForRead(
		sessionId: string,
		path: string,
	): Promise<{ image: string; absolutePath: string; root: string }> {
		requireNonEmpty(sessionId, 'sessionId');
		const pathValue = requireNonEmpty(path, 'path');
		const session = await this.requireActiveSession(sessionId);
		const root = this.sessionWorkspaceRoot(session.projectId ?? '');
		const absolutePath = resolveWorkspacePath(root, pathValue, { allowRoot: true });
		return { image: requireNonEmpty(session.image, 'session image'), absolutePath, root };
	}

	private async requireListing(
		image: string,
		dir: string,
		originalPath: string,
	): Promise<{ path: string; files: ContreeFileItem[] }> {
		let listing;
		try {
			listing = await this.contree.inspectList(image, dir);
		} catch (error) {
			throw this.mapContreeError(error, 'LIST_FAILED', `listing ${dir} failed`);
		}
		if (listing === null) {
			throw new SandboxError(
				404,
				'FILE_NOT_FOUND',
				`no such directory for ${originalPath} in the session workspace`,
			);
		}
		return listing;
	}

	private async advanceSessionImage(session: SandboxRecord, resultImage: string): Promise<void> {
		await this.persistence.save({
			...session,
			image: resultImage,
			updatedAt: nowIso(),
		});
	}

	/**
	 * One instance run on behalf of a session: dispatch from the session's
	 * current image, poll to the proven terminal, persist the new image and
	 * the operation receipt BEFORE exposing the result.
	 */
	private async executeForSession(
		session: SandboxRecord,
		input: {
			command: string;
			operationKey: string;
			timeoutMs: number;
			signal?: AbortSignal;
			cwd?: string;
			env?: Record<string, string>;
		},
	): Promise<{
		remoteId: string;
		exitCode: number | null;
		stdout: string;
		stderr: string;
		resultImage: string | null;
	}> {
		const command = requireNonEmpty(input.command, 'command');
		const operationKey = requireNonEmpty(input.operationKey, 'operationKey');
		if (
			typeof input.timeoutMs !== 'number' ||
			!Number.isSafeInteger(input.timeoutMs) ||
			input.timeoutMs <= 0
		) {
			throw new SandboxError(400, 'INVALID_INPUT', 'timeoutMs must be a positive integer');
		}
		// TIME QUOTA (hardening): refuse misconfigured timeouts before dispatch —
		// fail closed instead of silently clamping.
		if (input.timeoutMs > this.config.quotas.maxCommandTimeoutMs) {
			throw new SandboxError(
				400,
				'QUOTA_TIME_LIMIT',
				`timeoutMs ${input.timeoutMs} exceeds the configured command time quota (${this.config.quotas.maxCommandTimeoutMs}ms)`,
			);
		}
		if (input.signal?.aborted) {
			// Never dispatch on an already-aborted signal — zero remote calls.
			throw new SandboxError(
				409,
				'ABORTED_BEFORE_DISPATCH',
				'signal was already aborted — nothing was dispatched',
			);
		}
		// CREDENTIAL EXCLUSION (hardening): the platform token must never reach
		// the sandbox — not in generated command text, not in the env. (The token
		// travels in the Authorization header only, which the sandbox service
		// observes but the sandboxed code does not.)
		const token = this.config.contree.apiToken;
		if (
			token.length > 0 &&
			(command.includes(token) ||
				Object.values(input.env ?? {}).some(
					(value) => typeof value === 'string' && value.includes(token),
				))
		) {
			throw new SandboxError(
				400,
				'CREDENTIAL_IN_ENV',
				'refusing to send the platform token into the sandbox: command text or an env value contains it',
			);
		}

		const image = requireNonEmpty(session.image, 'session image');
		const root = this.sessionWorkspaceRoot(session.projectId ?? '');
		const record = (state: string, remoteId: string | null): SandboxRecord => ({
			kind: 'operation',
			key: `op:${operationKey}`,
			sessionId: session.sessionId,
			projectId: null,
			runId: null,
			image: null,
			checkpointRef: null,
			operationKey,
			remoteId,
			state,
			artifactRef: null,
			sha256: null,
			updatedAt: nowIso(),
		});

		// The caller-abort listener is registered BEFORE the final awaits: an
		// abort landing inside those awaits must still cancel the dispatch.
		const controller = new AbortController();
		const onCallerAbort = () => controller.abort();
		input.signal?.addEventListener('abort', onCallerAbort, { once: true });
		// Re-check immediately before the dispatch awaits: addEventListener
		// does not fire for an already-aborted signal, so the earlier check is
		// not sufficient once awaits intervene.
		if (input.signal?.aborted) {
			input.signal?.removeEventListener('abort', onCallerAbort);
			throw new SandboxError(
				409,
				'ABORTED_BEFORE_DISPATCH',
				'signal was aborted before dispatch — nothing was dispatched',
			);
		}
		// Durable identity BEFORE dispatch: a crash right after the dispatch can
		// always be reconciled by this key (when the id was learned).
		await this.persistence.save(record('dispatching', null));

		let remoteId: string | null = null;
		const dispatchTimer = setTimeout(() => controller.abort(), this.dispatchTimeoutMs);
		dispatchTimer.unref?.();
		try {
			const dispatched = await this.contree.spawnInstance(
				{
					image,
					command,
					shell: true,
					...(input.cwd !== undefined ? { cwd: input.cwd } : { cwd: root }),
					...(input.env !== undefined ? { env: input.env } : {}),
					timeoutSec: Math.ceil(input.timeoutMs / 1000),
					truncateOutputAt: this.config.quotas.maxOutputBytes,
				},
				controller.signal,
			);
			remoteId = dispatched.operationId;
		} catch (error) {
			// The real API is NON-idempotent: a received 4xx proves the instance
			// was NOT created (definitive rejection). Transport failures and
			// aborts are ambiguous — an instance MAY exist remotely and we have
			// no way to correlate it. Never retry blindly either way.
			const status = (error as { status?: number }).status;
			if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
				await this.persistence.save(record('failed', null));
				throw new SandboxError(
					502,
					'DISPATCH_REJECTED',
					`dispatch of operation key ${operationKey} was rejected by the sandbox service (status ${status})`,
					{ operationKey, upstreamStatus: status },
				);
			}
			await this.persistence.save(record('ambiguous', null));
			throw new SandboxError(
				502,
				'AMBIGUOUS_DISPATCH',
				`dispatch of operation key ${operationKey} did not complete — outcome unknown; reconcile by operation key`,
				{ operationKey },
			);
		} finally {
			clearTimeout(dispatchTimer);
			input.signal?.removeEventListener('abort', onCallerAbort);
		}

		// Remote identity persisted BEFORE any completion is exposed.
		await this.persistence.save(record('dispatched', remoteId));

		const deadline = Date.now() + input.timeoutMs;
		const hardDeadline = deadline + 2_000; // grace to PROVE the kill we requested
		let cancelRequested = false;
		let timedOut = false;

		for (;;) {
			if (input.signal?.aborted) {
				// Release the caller promptly AND cancel the remote op. The REQUEST
				// is not the proof — status is (tests assert both sides).
				const requested = await this.requestCancelNow(remoteId);
				await this.persistence.save(record('cancel-requested', remoteId));
				throw new SandboxError(
					409,
					'ABORTED_CANCEL_REQUESTED',
					'caller abort released the wait; remote cancellation was requested — termination must be proven via status',
					{ remoteId, requested },
				);
			}

			const operation = await this.contree.getOperation(remoteId).catch(() => null);
			if (operation && isTerminalState(operation.state)) {
				// Persist the receipt AND the committed image chain BEFORE the
				// caller can observe completion.
				const outcome = terminalSandboxState(operation.state);
				await this.persistence.save(record(outcome, remoteId));
				if (operation.state === 'SUCCEEDED' && operation.resultImage !== null) {
					await this.advanceSessionImage(session, operation.resultImage);
				}
				// OUTPUT QUOTA (hardening): the service truncates at the bound we
				// send (truncate_output_at); a truncated stream is a typed, honest
				// failure — never silently-shortened output.
				if (operation.outputTruncated) {
					throw new SandboxError(
						413,
						'QUOTA_OUTPUT_EXCEEDED',
						'command output exceeded the configured quota — the stream was truncated by the service',
						{
							remoteId,
							provenState: outcome,
							outputBytes: operation.outputBytes ?? undefined,
							maxOutputBytes: this.config.quotas.maxOutputBytes,
						},
					);
				}
				if (operation.timedOut || timedOut) {
					throw new SandboxError(
						504,
						'EXEC_TIMEOUT',
						'command time quota expired — cancellation was requested and the terminal outcome is proven',
						{ remoteId, provenState: outcome },
					);
				}
				return {
					remoteId,
					exitCode: operation.exitCode,
					stdout: operation.stdout,
					stderr: operation.stderr,
					resultImage: operation.resultImage,
				};
			}

			if (!timedOut && Date.now() >= deadline) {
				timedOut = true;
				if (!cancelRequested) {
					cancelRequested = true;
					await this.requestCancelNow(remoteId);
					await this.persistence.save(record('cancel-requested', remoteId));
				}
			}
			if (timedOut && Date.now() >= hardDeadline) {
				throw new SandboxError(
					504,
					'EXEC_TIMEOUT',
					'command time quota expired — cancellation was requested but the outcome could not be proven before the grace bound',
					{ remoteId, provenState: 'unknown' },
				);
			}

			await sleep(this.pollIntervalMs);
		}
	}

	/**
	 * Instance run NOT bound to an existing session (bootstrap): same dispatch
	 * and polling machinery, but the resulting image is returned instead of
	 * advancing a session record.
	 */
	private async runInstance(input: {
		imageRef: string;
		command: string;
		operationKey: string;
		timeoutMs: number;
		cwd?: string;
		files?: Array<{ path: string; uuid: string; mode?: string }>;
	}): Promise<{
		exitCode: number | null;
		stdout: string;
		stderr: string;
		resultImage: string | null;
	}> {
		let image = input.imageRef;
		if (!isImageUuid(image)) {
			image = await this.contree.resolveImageRef(image, AbortSignal.timeout(this.dispatchTimeoutMs));
		}
		const dispatched = await this.contree.spawnInstance(
			{
				image,
				command: input.command,
				shell: true,
				...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
				timeoutSec: Math.ceil(input.timeoutMs / 1000),
				truncateOutputAt: this.config.quotas.maxOutputBytes,
				...(input.files !== undefined && input.files.length > 0 ? { files: input.files } : {}),
			},
			AbortSignal.timeout(this.dispatchTimeoutMs),
		);
		const remoteId = dispatched.operationId;
		for (;;) {
			const operation = await this.contree.getOperation(remoteId).catch(() => null);
			if (operation && isTerminalState(operation.state)) {
				return {
					exitCode: operation.exitCode,
					stdout: operation.stdout,
					stderr: operation.stderr,
					resultImage: operation.state === 'SUCCEEDED' ? operation.resultImage : null,
				};
			}
			await sleep(this.pollIntervalMs);
		}
	}

	private async requestCancelNow(remoteId: string): Promise<boolean> {
		try {
			await this.contree.cancelOperation(remoteId, AbortSignal.timeout(this.dispatchTimeoutMs));
			return true;
		} catch {
			return false;
		}
	}

	private mapContreeError(error: unknown, code: string, message: string): SandboxError {
		if (error instanceof ContreeApiError) {
			if (error.status === 404) {
				return new SandboxError(410, 'SESSION_LOST', `${message}: image is gone`, {
					remoteCode: error.remoteCode,
				});
			}
			if (error.remoteCode === 'path_escape') {
				return new SandboxError(400, 'UPLOAD_PATH_ESCAPE', `${message}: path escapes the session workspace`);
			}
			if (error.status === 0) {
				return new SandboxError(502, 'UPSTREAM_UNREACHABLE', `${message}: transport failure`);
			}
			return new SandboxError(502, 'UPSTREAM_ERROR', `${message}: HTTP ${error.status}`, {
				remoteCode: error.remoteCode,
			});
		}
		return new SandboxError(500, code, message);
	}
}

// --- crypto helpers ------------------------------------------------------------

async function shortHash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 16);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// Defensive copy so a caller-held ArrayBuffer view cannot be detached.
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const digest = await crypto.subtle.digest('SHA-256', copy);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
