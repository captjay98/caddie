import {
	ContreeClient,
	ContreeApiError,
	base64ToBytes,
	bytesToBase64,
	isImageUuid,
	type ContreeConfig,
	type ContreeOperationState,
	type ContreeFileItem,
	type ContreeOperation,
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
	/**
	 * How long an operation whose outcome is unknown (dispatch lost, no remote
	 * id) may block the session before the host closes it as failed
	 * (default 5 minutes). Nothing can be polled for such an operation, so
	 * waiting only prolongs the block.
	 */
	staleAmbiguousMs?: number;
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

/** Machine result saved by the driver, never supplied by an agent. */
export interface SandboxOperationReceipt extends SandboxExecuteResult {
	operationKey: string;
	sessionId: string | null;
	projectId: string | null;
	runId: string | null;
	command: string;
	cwd: string;
	inputImage: string;
	resultImage: string | null;
	state: 'succeeded' | 'failed' | 'cancelled';
	outputTruncated: boolean;
	timedOut: boolean;
	outputBytes: number | null;
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
	/** Immutable identity of a logical command attempt; excludes secret environment values. */
	inputHash?: string;
	command?: string;
	cwd?: string;
	inputImage?: string;
	receipt?: SandboxOperationReceipt;
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
	/** Atomic insert: only its winner may dispatch the non-idempotent remote call. */
	claim(record: SandboxRecord): Promise<boolean>;
	/** Compare-and-swap prevents concurrent commands from forking the image chain. */
	compareAndSave(expected: SandboxRecord, record: SandboxRecord): Promise<boolean>;
}

export class InMemorySandboxPersistence implements SandboxPersistencePort {
	private readonly records = new Map<string, SandboxRecord>();

	save(record: SandboxRecord): Promise<void> {
		this.records.set(record.key, structuredClone(record));
		return Promise.resolve();
	}

	claim(record: SandboxRecord): Promise<boolean> {
		if (this.records.has(record.key)) return Promise.resolve(false);
		this.records.set(record.key, structuredClone(record));
		return Promise.resolve(true);
	}

	compareAndSave(expected: SandboxRecord, record: SandboxRecord): Promise<boolean> {
		if (JSON.stringify(this.records.get(expected.key)) !== JSON.stringify(expected)) return Promise.resolve(false);
		this.records.set(record.key, structuredClone(record));
		return Promise.resolve(true);
	}

	load(key: string): Promise<SandboxRecord | null> {
		const record = this.records.get(key);
		return Promise.resolve(record ? structuredClone(record) : null);
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
		if (normalized === rootNoSlash && !options?.allowRoot) throw new SandboxError(400, 'INVALID_INPUT', 'path resolves to the workspace root');
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
	private readonly staleAmbiguousMs: number;
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
		this.staleAmbiguousMs = config.staleAmbiguousMs ?? 5 * 60_000;
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
		this.sessionWorkspaceRoot(projectId); // validate before tag lookup or persistence
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
		let existing = await this.persistence.load(`session:${sessionKey}`);
		if (existing?.kind === 'session') {
			if (existing.state === 'disposed') throw new SandboxError(410, 'SESSION_LOST', `session ${sessionKey} was disposed`);
			if (existing.projectId !== projectId || existing.runId !== runId) {
				throw new SandboxError(409, 'SESSION_KEY_CONFLICT', `session ${sessionKey} belongs to a different project or run`);
			}
			if (existing.state === 'active') {
				await this.requireActiveSession(sessionKey);
				return { sessionId: sessionKey };
			}
		} else {
			let initialImage = image;
			if (!isImageUuid(initialImage)) initialImage = await this.contree.resolveImageRef(initialImage, AbortSignal.timeout(this.dispatchTimeoutMs));
			const creating: SandboxRecord = {
				kind: 'session', key: `session:${sessionKey}`, sessionId: sessionKey,
				projectId, runId, image: initialImage, checkpointRef: null,
				operationKey: null, remoteId: null, state: 'creating',
				artifactRef: null, sha256: null, updatedAt: nowIso(),
			};
			if (!(await this.persistence.claim(creating))) return this.ensureSessionOnce(input);
			existing = creating;
		}
		const workspaceRoot = this.sessionWorkspaceRoot(projectId);
		const bootstrapped = await this.executeForSession(existing, {
			operationKey: `session-bootstrap:${sessionKey}`,
			command: `mkdir -p -- ${shellQuote(workspaceRoot)}`,
			cwd: '/',
			timeoutMs: Math.min(120_000, this.config.quotas.maxCommandTimeoutMs),
		}, true);
		if (bootstrapped.exitCode !== 0 || bootstrapped.resultImage === null) {
			throw new SandboxError(502, 'SESSION_BOOTSTRAP_FAILED', `bootstrap of session ${sessionKey} failed (exit ${bootstrapped.exitCode})`, { stderr: bootstrapped.stderr.slice(0, 2000) });
		}
		const settled = await this.persistence.load(`session:${sessionKey}`);
		if (!settled || settled.state === 'disposed') throw new SandboxError(410, 'SESSION_LOST', `session ${sessionKey} was disposed during bootstrap`);
		await this.persistence.save({ ...settled, image: bootstrapped.resultImage, operationKey: null, state: 'active', updatedAt: nowIso() });
		return { sessionId: sessionKey };
	}

	/**
	 * Whether the working copy a session key stands for can still be used:
	 * the session's current image (or, before the session exists, the image
	 * it would start from) is still kept by the sandbox. Images are not kept
	 * forever, so a build that resumes after a long pause must check.
	 *
	 * - A session used within `recheckAfterMs` is trusted without a probe.
	 * - Tag references (the base image) are never probed.
	 * - An empty image means there is no working copy to start from.
	 * - Only a definite "not there" answers false; transport errors throw, so
	 *   a flaky network never discards a working copy.
	 */
	async workingCopyAvailable(input: { sessionKey: string; image: string; recheckAfterMs: number }): Promise<boolean> {
		const record = await this.persistence.load(`session:${requireNonEmpty(input.sessionKey, 'sessionKey')}`);
		let image = input.image;
		if (record?.kind === 'session') {
			// Disposed or still-creating sessions keep their existing handling.
			if (record.state !== 'active' || !record.image) return true;
			if (Date.now() - Date.parse(record.updatedAt) < input.recheckAfterMs) return true;
			image = record.image;
		}
		if (image === '') return false;
		if (!isImageUuid(image)) return true;
		try {
			return (await this.contree.inspectList(image, '/', AbortSignal.timeout(this.dispatchTimeoutMs))) !== null;
		} catch (error) {
			throw this.mapContreeError(error, 'IMAGE_CHECK_FAILED', `checking image ${image} failed`);
		}
	}

	/** Whether a working copy (a session record that isn't disposed) exists under this key. */
	async hasSession(sessionKey: string): Promise<boolean> {
		const record = await this.persistence.load(`session:${requireNonEmpty(sessionKey, 'sessionKey')}`);
		return record?.kind === 'session' && record.state !== 'disposed';
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
		const committed = await this.executeForSession(session, {
			operationKey: `write:${sessionId}:${await shortHash(JSON.stringify([image, absolutePath, record.sha256]))}`,
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
		const committed = await this.executeForSession(session, {
			operationKey: `write-batch:${sessionId}:${await shortHash(JSON.stringify([image, attached]))}`,
			command: 'true',
			files: attached,
			timeoutMs: Math.min(120_000, this.config.quotas.maxCommandTimeoutMs),
		});
		if (committed.exitCode !== 0 || committed.resultImage === null) {
			throw new SandboxError(502, 'UPLOAD_COMMIT_FAILED', 'commit of the batch into the session image failed');
		}
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

	/**
	 * One directory level with each entry's kind and size (the same inspect
	 * list call as listDir), so a tree walk needs one request per directory
	 * instead of one stat per entry.
	 */
	async listEntries(
		sessionId: string,
		path: string,
	): Promise<Array<{ name: string; isDir: boolean; isFile: boolean; isSymlink: boolean; size: number }>> {
		const { image, absolutePath } = await this.requireSessionForRead(sessionId, path);
		const listing = await this.requireListing(image, absolutePath, path);
		return listing.files.map((item) => ({
			name: item.path,
			isDir: item.isDir,
			isFile: item.isRegular && !item.isDir,
			isSymlink: item.isSymlink,
			size: item.size,
		}));
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
			operationKey: `mkdir:${session.sessionId}:${await shortHash(JSON.stringify([session.image, command]))}`,
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
			operationKey: `rm:${session.sessionId}:${await shortHash(JSON.stringify([session.image, command]))}`,
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
		const session = await this.requireActiveSession(sessionId, input.operationKey);
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
		if (stored.receipt) {
			await this.adoptOperationImage(stored);
			return this.receiptStatus(stored.receipt);
		}
		if (stored.remoteId === null) return { state: 'unknown' };
		const bound = Date.now() + this.reconcileTimeoutMs;
		for (;;) {
			const operation = await this.contree.getOperation(stored.remoteId).catch(() => null);
			if (operation && isTerminalState(operation.state)) {
				const terminal = await this.persistTerminal(stored, operation);
				await this.adoptOperationImage(terminal);
				return this.receiptStatus(terminal.receipt!);
			}
			if (Date.now() >= bound) return { state: 'unknown' };
			await sleep(this.pollIntervalMs);
		}
	}

	/** Only genuine terminal results can become verification evidence. */
	async getOperationReceipt(operationKey: string): Promise<SandboxOperationReceipt | null> {
		requireNonEmpty(operationKey, 'operationKey');
		const record = await this.persistence.load(`op:${operationKey}`);
		return record?.kind === 'operation' && record.receipt ? structuredClone(record.receipt) : null;
	}

	// --- internals -------------------------------------------------------------------

	/** Workspace directory of one project's sessions. */
	private sessionWorkspaceRoot(projectId: string): string {
		if (!projectId || projectId === '.' || projectId === '..' || /[\/\\\0]/.test(projectId)) throw new SandboxError(400, 'INVALID_INPUT', 'projectId must be one workspace path segment');
		return `${this.config.workspaceRoot.replace(/\/+$/, '')}/${projectId}`;
	}

	/**
	 * True when an operation's outcome is unknown (dispatch never got a remote
	 * id, so nothing can be polled) and it has been sitting unresolved long
	 * enough that no live attempt can still be finishing it.
	 */
	private isStaleAmbiguous(record: SandboxRecord): boolean {
		if (record.state !== 'ambiguous' || record.remoteId !== null) return false;
		const updatedAt = Date.parse(record.updatedAt);
		// An unreadable timestamp is broken data, not a live attempt: it must
		// not block the session forever.
		if (Number.isNaN(updatedAt)) return true;
		return Date.now() - updatedAt >= this.staleAmbiguousMs;
	}

	/**
	 * Close a stale ambiguous operation as failed, with a receipt that says
	 * exactly what happened, and release the session lock through the normal
	 * reconcile path (the receipt is what adoptOperationImage consumes).
	 */
	private async closeStaleAmbiguous(record: SandboxRecord, session: SandboxRecord): Promise<void> {
		const receipt: SandboxOperationReceipt = {
			operationKey: record.operationKey ?? record.key.replace(/^op:/, ''),
			sessionId: record.sessionId,
			projectId: record.projectId,
			runId: record.runId,
			command: record.command ?? '',
			cwd: record.cwd ?? '',
			inputImage: session.image ?? record.inputImage ?? '',
			resultImage: null,
			// No remote operation ever existed for this attempt, so there is no
			// remote id to point at.
			remoteId: '',
			exitCode: null,
			stdout: '',
			stderr:
				'The sandbox lost this dispatch and its outcome was never known (no remote id), so the host closed it as failed instead of blocking the session forever. The work may not have landed: re-run it under a new operation key.',
			state: 'failed',
			outputTruncated: false,
			timedOut: false,
			outputBytes: 0,
		};
		await this.persistence.save({ ...record, state: 'failed', receipt, updatedAt: nowIso() });
	}

	private async requireActiveSession(sessionId: string, resumeOperationKey?: string): Promise<SandboxRecord> {
		let record = await this.persistence.load(`session:${sessionId}`);
		if (!record || record.kind !== 'session') throw new SandboxError(404, 'SESSION_LOST', `no persisted binding for session ${sessionId} — create it first`);
		if (record.state === 'disposed') throw new SandboxError(410, 'SESSION_LOST', `session ${sessionId} was disposed`);
		if (record.operationKey !== null) {
			const pending = await this.persistence.load(`op:${record.operationKey}`);
			// Crash between locking the image and claiming an operation: only the
			// SAME durable attempt may compete for the atomic claim; no remote call
			// can have occurred before that claim exists. Other work stays blocked.
			if (!pending && record.operationKey === resumeOperationKey && record.state === 'active') return record;
			if (!pending) throw new SandboxError(409, 'OPERATION_UNRESOLVED', 'Sandbox work was interrupted before dispatch; retry the same operation key.', { operationKey: record.operationKey });
			// A dispatch whose outcome is unknown and that nobody has resolved for
			// minutes is closed DETERMINISTICALLY as failed, so the session
			// unlocks instead of bricking every later command. With no remote id
			// there is nothing to poll and no way to recover the outcome, so
			// waiting only prolongs the block: the next attempt runs under a
			// fresh key, and nothing that may have run remotely is dispatched
			// again. (HerdVoice, 2026-10-20: two builds lost ~35 minutes each
			// to this wedge, repaired by hand in production D1.)
			if (this.isStaleAmbiguous(pending)) await this.closeStaleAmbiguous(pending, record);
			const result = await this.reconcileOperation(record.operationKey);
			if (result.state === 'unknown' || result.state === 'running') {
				throw new SandboxError(409, 'OPERATION_UNRESOLVED', 'Previous sandbox work has an unknown outcome; reconcile it before continuing.', { operationKey: record.operationKey });
			}
			record = await this.persistence.load(`session:${sessionId}`);
		}
		if (!record || record.state !== 'active' || record.image === null) throw new SandboxError(410, 'SESSION_LOST', `session ${sessionId} is not ready`);
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

	private receiptStatus(receipt: SandboxOperationReceipt): SandboxStatusResult {
		return { state: receipt.state, exitCode: receipt.exitCode ?? undefined, stdout: receipt.stdout, stderr: receipt.stderr, outputBytes: receipt.outputBytes ?? undefined };
	}

	private async persistTerminal(stored: SandboxRecord, operation: ContreeOperation, timedOut = false): Promise<SandboxRecord> {
		const receipt: SandboxOperationReceipt = {
			operationKey: stored.operationKey!, sessionId: stored.sessionId, projectId: stored.projectId,
			runId: stored.runId, command: stored.command ?? '', cwd: stored.cwd ?? '',
			inputImage: stored.inputImage ?? '', resultImage: operation.resultImage,
			remoteId: operation.operationId, exitCode: operation.exitCode,
			stdout: operation.stdout, stderr: operation.stderr,
			state: terminalSandboxState(operation.state as 'SUCCEEDED' | 'FAILED' | 'CANCELLED'),
			outputTruncated: operation.outputTruncated, timedOut: operation.timedOut || timedOut,
			outputBytes: operation.outputBytes,
		};
		const terminal = { ...stored, state: receipt.state, receipt, updatedAt: nowIso() };
		await this.persistence.save(terminal);
		return terminal;
	}

	private async adoptOperationImage(operation: SandboxRecord): Promise<void> {
		if (!operation.sessionId || !operation.receipt) return;
		const session = await this.persistence.load(`session:${operation.sessionId}`);
		if (!session || session.state === 'disposed') return;
		// A replay of a completed old attempt must never roll a newer session back.
		if (session.operationKey !== operation.operationKey) return;
		const receipt = operation.receipt;
		if (session.image !== receipt.inputImage && session.image !== receipt.resultImage) {
			throw new SandboxError(409, 'SESSION_IMAGE_CONFLICT', 'Cannot adopt a result from an older sandbox image.', { operationKey: operation.operationKey });
		}
		const image = receipt.state === 'succeeded' && receipt.resultImage !== null ? receipt.resultImage : session.image;
		const advanced = { ...session, image, operationKey: null, updatedAt: nowIso() };
		if (!(await this.persistence.compareAndSave(session, advanced))) {
			const current = await this.persistence.load(session.key);
			if (current?.operationKey === operation.operationKey) throw new SandboxError(409, 'SESSION_IMAGE_CONFLICT', 'Sandbox state changed while adopting a result.');
		}
	}

	private replayReceipt(receipt: SandboxOperationReceipt): SandboxOperationReceipt {
		if (receipt.outputTruncated) throw new SandboxError(413, 'QUOTA_OUTPUT_EXCEEDED', 'Recorded command output was truncated.', { remoteId: receipt.remoteId });
		if (receipt.timedOut) throw new SandboxError(504, 'EXEC_TIMEOUT', 'Recorded command exceeded its time quota.', { remoteId: receipt.remoteId, provenState: receipt.state });
		return receipt;
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
			files?: Array<{ path: string; uuid: string; mode?: string }>;
		},
		bootstrap = false,
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
		const cwd = bootstrap ? '/' : resolveWorkspacePath(root, input.cwd ?? '.', { allowRoot: true });
		const inputHash = await sha256Hex(new TextEncoder().encode(JSON.stringify([session.sessionId, command, cwd, input.timeoutMs, Object.entries(input.env ?? {}).sort(([a], [b]) => a.localeCompare(b)), input.files ?? []])));
		const record = (state: string, remoteId: string | null): SandboxRecord => ({
			kind: 'operation',
			key: `op:${operationKey}`,
			sessionId: session.sessionId,
			projectId: session.projectId,
			runId: session.runId,
			image: null,
			checkpointRef: null,
			inputImage: image, inputHash, command, cwd,
			operationKey,
			remoteId,
			state,
			artifactRef: null,
			sha256: null,
			updatedAt: nowIso(),
		});

		const previous = await this.persistence.load(`op:${operationKey}`);
		if (previous) {
			if (previous.sessionId !== session.sessionId || previous.inputHash !== inputHash) {
				throw new SandboxError(409, 'OPERATION_KEY_CONFLICT', 'Operation key belongs to a different command or session.', { operationKey });
			}
			if (!previous.receipt) await this.reconcileOperation(operationKey);
			const reconciled = await this.persistence.load(previous.key);
			if (reconciled?.receipt) {
				await this.adoptOperationImage(reconciled);
				return this.replayReceipt(reconciled.receipt);
			}
			throw new SandboxError(409, previous.state === 'failed' && previous.remoteId === null ? 'DISPATCH_REJECTED' : 'OPERATION_UNRESOLVED', 'Recorded operation has no proven result; it was not dispatched again.', { operationKey, remoteId: previous.remoteId });
		}
		// Lock the image chain before dispatch. Every mutation uses this path.
		const pendingSession = { ...session, operationKey, updatedAt: nowIso() };
		if ((session.operationKey !== null && session.operationKey !== operationKey) || (session.operationKey === null && !(await this.persistence.compareAndSave(session, pendingSession)))) {
			throw new SandboxError(409, 'SESSION_BUSY', 'Another sandbox operation owns this image; retry after it settles.', { operationKey });
		}
		const dispatchRecord = record('dispatching', null);
		if (!(await this.persistence.claim(dispatchRecord))) {
			throw new SandboxError(409, 'OPERATION_UNRESOLVED', 'Operation is already claimed; reconcile its persisted identity.', { operationKey });
		}

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
			await this.persistence.save(record('failed', null));
			await this.persistence.compareAndSave(pendingSession, { ...pendingSession, operationKey: null, updatedAt: nowIso() });
			throw new SandboxError(
				409,
				'ABORTED_BEFORE_DISPATCH',
				'signal was aborted before dispatch — nothing was dispatched',
			);
		}
		// The atomic claim above persists identity before the remote effect.
		let remoteId: string | null = null;
		const dispatchTimer = setTimeout(() => controller.abort(), this.dispatchTimeoutMs);
		dispatchTimer.unref?.();
		try {
			const dispatched = await this.contree.spawnInstance(
				{
					image,
					command,
					shell: true,
					cwd,
					...(input.files?.length ? { files: input.files } : {}),
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
				await this.persistence.compareAndSave(pendingSession, { ...pendingSession, operationKey: null, updatedAt: nowIso() });
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
				const terminal = await this.persistTerminal(record(outcome, remoteId), operation, timedOut);
				await this.adoptOperationImage(terminal);
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
