import {
	ContreeClient,
	ContreeApiError,
	type ContreeConfig,
	type ContreeOperationState,
} from './contree.ts';

/**
 * P04 Workers-native sandbox driver (contracts.md "Sandbox and verification").
 *
 * Implements the SandboxDriver surface over the contree REST client
 * (`./contree.ts`) — fetch-only, no child_process: the CLI cannot spawn under
 * Workers (feature-ledger settled decision).
 *
 * Semantics that the contract pins down and the tests prove:
 *   - Persistence BEFORE exposure: the session binding is persisted before
 *     `create` returns; the remote operation identity is persisted before any
 *     completion is exposed; the artifactRef is persisted before `export`
 *     returns. An injected {@link SandboxPersistencePort} owns storage — tests
 *     use the in-memory implementation; production wires a D1 port (P05
 *     integrator; migration numbering belongs to the integration lead).
 *   - Every remote mutation carries a caller-supplied operationKey (idempotent
 *     dispatch; the correlation key for ambiguous outcomes).
 *   - A cancellation REQUEST is not confirmed termination: `cancel` returns
 *     `{requested}` and only `status` proves a terminal outcome. Aborting
 *     releases the caller promptly AND requests the remote cancellation
 *     (adjudication: local abort releases ~1.5s; the remote op is killed, not
 *     orphaned by us — SIGKILL-style orphans are reconciled by operation key).
 *   - Ambiguous dispatch (transport failure / timeout — the response may or
 *     may not have landed) throws AMBIGUOUS_DISPATCH with the state persisted
 *     as 'ambiguous' and remoteId unknown; `reconcileOperation` correlates by
 *     the persisted operation key and NEVER re-dispatches blindly.
 *   - `status` reports 'unknown' rather than fabricating state.
 *
 * Hardening (bounded uploads, traversal/symlink rejection, output/time
 * quotas, credential-exclusion) is layered in this same driver — see the
 * quota checks and `resolveSandboxPath` below.
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
	/** Isolation flags sent at session creation (documented in docs/setup/sandbox.md). */
	isolation?: Record<string, unknown>;
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

export interface SandboxRecord {
	kind: 'session' | 'operation' | 'artifact';
	/** `session:<id>` | `op:<operationKey>` | `artifact:<sessionId>` */
	key: string;
	sessionId: string | null;
	projectId: string | null;
	runId: string | null;
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
 * implementation below; production wires a D1-backed port in P05 (a small
 * table `sandbox_bindings` keyed by `key` — migration owned by the
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
 * Resolve a caller-supplied workspace-relative upload path against the session
 * workspace root. HARDENING (slice 2): absolute paths and any '..' segment are
 * rejected BEFORE anything is sent; '.' segments are resolved; the result is
 * always inside the root. Symlink escapes cannot be seen from the client side,
 * so they are enforced by the sandbox service (path_escape) and mapped to the
 * same typed error — defense in depth, both layers proven by tests.
 */
function resolveSandboxPath(root: string, relativePath: string): string {
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
 * Exact decoded size of (valid) base64 without allocating the payload — enough
 * to enforce the upload bound BEFORE any decode or network call.
 */
function base64ByteLength(contentBase64: string): number {
	const withoutPadding = contentBase64.replace(/=+$/, '');
	return Math.floor((withoutPadding.length * 3) / 4);
}

function terminalSandboxState(state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'): Exclude<SandboxState, 'running' | 'unknown'> {
	switch (state) {
		case 'SUCCEEDED':
			return 'succeeded';
		case 'FAILED':
			return 'failed';
		case 'CANCELLED':
			return 'cancelled';
	}
}

// --- driver ----------------------------------------------------------------------

export class SandboxDriver {
	private readonly contree: ContreeClient;
	private readonly pollIntervalMs: number;
	private readonly dispatchTimeoutMs: number;
	private readonly reconcileTimeoutMs: number;

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

	async create(input: {
		projectId: string;
		runId: string;
		image: string;
	}): Promise<{ sessionId: string }> {
		const projectId = requireNonEmpty(input.projectId, 'projectId');
		const runId = requireNonEmpty(input.runId, 'runId');
		const image = requireNonEmpty(input.image, 'image');
		const workspaceRoot = `${this.config.workspaceRoot.replace(/\/+$/, '')}/${projectId}`;
		const { sessionId } = await this.contree.createSession(
			{
				sessionKey: `caddie:${projectId}:${runId}`,
				image,
				workspaceRoot,
				...(this.config.isolation !== undefined ? { isolation: this.config.isolation } : {}),
			},
			AbortSignal.timeout(this.dispatchTimeoutMs),
		);
		// Session binding persisted BEFORE the id is exposed: a crash between
		// remote creation and return still leaves the binding for reconciliation.
		await this.persistence.save(this.sessionRecord(sessionId, { projectId, runId, image }, 'active'));
		return { sessionId };
	}

	async checkpoint(sessionId: string): Promise<{ checkpointRef: string }> {
		requireNonEmpty(sessionId, 'sessionId');
		await this.requireActiveSession(sessionId);
		let checkpointRef: string;
		try {
			({ checkpointRef } = await this.contree.checkpoint(
				sessionId,
				AbortSignal.timeout(this.dispatchTimeoutMs),
			));
		} catch (error) {
			throw this.mapContreeError(error, 'CHECKPOINT_FAILED', `checkpoint of session ${sessionId} failed`);
		}
		const existing = await this.persistence.load(`session:${sessionId}`);
		await this.persistence.save({
			...(existing ?? this.sessionRecord(sessionId, {}, 'active')),
			checkpointRef,
			updatedAt: nowIso(),
		});
		return { checkpointRef };
	}

	async restore(input: {
		checkpointRef: string;
		projectId: string;
		runId: string;
		image: string;
	}): Promise<{ sessionId: string }> {
		const checkpointRef = requireNonEmpty(input.checkpointRef, 'checkpointRef');
		const projectId = requireNonEmpty(input.projectId, 'projectId');
		const runId = requireNonEmpty(input.runId, 'runId');
		const image = requireNonEmpty(input.image, 'image');
		const workspaceRoot = `${this.config.workspaceRoot.replace(/\/+$/, '')}/${projectId}`;
		let sessionId: string;
		try {
			({ sessionId } = await this.contree.createSession(
				{
					sessionKey: `caddie:${projectId}:${runId}:restore:${checkpointRef}`,
					image,
					restoreFrom: checkpointRef,
					workspaceRoot,
				},
				AbortSignal.timeout(this.dispatchTimeoutMs),
			));
		} catch (error) {
			if (error instanceof ContreeApiError && error.status === 404) {
				throw new SandboxError(
					404,
					'CHECKPOINT_NOT_FOUND',
					`no such checkpoint ${checkpointRef} — restore refused`,
				);
			}
			throw this.mapContreeError(error, 'RESTORE_FAILED', `restore from ${checkpointRef} failed`);
		}
		await this.persistence.save(
			this.sessionRecord(sessionId, { projectId, runId, image, checkpointRef }, 'active'),
		);
		return { sessionId };
	}

	async export(sessionId: string): Promise<{ artifactRef: string; sha256: string }> {
		requireNonEmpty(sessionId, 'sessionId');
		await this.requireActiveSession(sessionId);
		let exported: { artifactRef: string; sha256: string };
		try {
			exported = await this.contree.exportSession(
				sessionId,
				AbortSignal.timeout(this.dispatchTimeoutMs),
			);
		} catch (error) {
			throw this.mapContreeError(error, 'EXPORT_FAILED', `export of session ${sessionId} failed`);
		}
		// Artifact identity persisted BEFORE exposure: session loss after this
		// point cannot lose the export (slice-3 test proves the recovery).
		await this.persistence.save({
			kind: 'artifact',
			key: `artifact:${sessionId}`,
			sessionId,
			projectId: null,
			runId: null,
			image: null,
			checkpointRef: null,
			operationKey: null,
			remoteId: null,
			state: 'exported',
			artifactRef: exported.artifactRef,
			sha256: exported.sha256,
			updatedAt: nowIso(),
		});
		return { artifactRef: exported.artifactRef, sha256: exported.sha256 };
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

	async dispose(sessionId: string): Promise<void> {
		requireNonEmpty(sessionId, 'sessionId');
		const existing = await this.persistence.load(`session:${sessionId}`);
		if (existing?.state === 'disposed') return; // idempotent
		try {
			await this.contree.disposeSession(sessionId, AbortSignal.timeout(this.dispatchTimeoutMs));
		} catch (error) {
			if (!(error instanceof ContreeApiError && error.status === 404)) throw error;
			// Already gone remotely — disposing locally is still the truth.
		}
		await this.persistence.save({
			...(existing ?? this.sessionRecord(sessionId, {}, 'active')),
			state: 'disposed',
			updatedAt: nowIso(),
		});
	}

	// --- files ---------------------------------------------------------------------

	async uploadFiles(
		sessionId: string,
		files: ReadonlyArray<{ path: string; contentBase64: string }>,
	): Promise<{ saved: number }> {
		requireNonEmpty(sessionId, 'sessionId');
		if (!Array.isArray(files) || files.length === 0) {
			throw new SandboxError(400, 'INVALID_INPUT', 'files must be a non-empty array');
		}
		const session = await this.requireActiveSession(sessionId);
		const root = `${this.config.workspaceRoot.replace(/\/+$/, '')}/${session.projectId ?? ''}`;
		// Validate EVERYTHING first: a rejected batch must not partially upload.
		const prepared = files.map((file) => {
			const path = requireNonEmpty(file.path, 'path');
			if (typeof file.contentBase64 !== 'string') {
				throw new SandboxError(400, 'INVALID_INPUT', 'contentBase64 is required');
			}
			const absolutePath = resolveSandboxPath(root, path);
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
		for (const file of prepared) {
			try {
				await this.contree.uploadFile(sessionId, file.absolutePath, file.contentBase64);
			} catch (error) {
				throw this.mapContreeError(error, 'UPLOAD_FAILED', `upload of ${file.path} failed`);
			}
		}
		return { saved: prepared.length };
	}

	// --- execution -------------------------------------------------------------------

	async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
		const sessionId = requireNonEmpty(input.sessionId, 'sessionId');
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
				Object.values(input.env ?? {}).some((value) => typeof value === 'string' && value.includes(token)))
		) {
			throw new SandboxError(
				400,
				'CREDENTIAL_IN_ENV',
				'refusing to send the platform token into the sandbox: command text or an env value contains it',
			);
		}
		await this.requireActiveSession(sessionId);

		const record = (state: string, remoteId: string | null): SandboxRecord => ({
			kind: 'operation',
			key: `op:${operationKey}`,
			sessionId,
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

		// Durable identity BEFORE dispatch: a crash right after the dispatch can
		// always be reconciled by this key.
		await this.persistence.save(record('dispatching', null));

		let remoteId: string | null = null;
		const controller = new AbortController();
		const onCallerAbort = () => controller.abort();
		input.signal?.addEventListener('abort', onCallerAbort, { once: true });
		const dispatchTimer = setTimeout(() => controller.abort(), this.dispatchTimeoutMs);
		dispatchTimer.unref?.();
		try {
			const dispatched = await this.contree.dispatchExec(
				sessionId,
				{
					command,
					operationKey,
					timeoutSec: Math.ceil(input.timeoutMs / 1000),
					...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
					...(input.env !== undefined ? { env: input.env } : {}),
				},
				controller.signal,
			);
			remoteId = dispatched.operationId;
		} catch (error) {
			// Transport failure: the operation MAY exist remotely. Persist the
			// ambiguity; never retry blindly — reconcile by operation key.
			void error;
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
		let outputQuotaBreached = false;

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
				const outcome = terminalSandboxState(operation.state);
				await this.persistence.save(record(outcome, remoteId));
				if (outputQuotaBreached) {
					throw new SandboxError(
						413,
						'QUOTA_OUTPUT_EXCEEDED',
						'command output exceeded the configured quota — the command was killed and the terminal outcome is proven',
						{
							remoteId,
							provenState: outcome,
							outputBytes:
								operation.outputBytes ??
								encodedByteLength(operation.stdout) + encodedByteLength(operation.stderr),
							maxOutputBytes: this.config.quotas.maxOutputBytes,
						},
					);
				}
				if (timedOut) {
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
				};
			}

			if (operation && !outputQuotaBreached) {
				// OUTPUT QUOTA (hardening): while still running, growing output past
				// the bound triggers a kill — then we poll to the proven terminal.
				const bytes =
					operation.outputBytes ??
					encodedByteLength(operation.stdout) + encodedByteLength(operation.stderr);
				if (bytes > this.config.quotas.maxOutputBytes) {
					outputQuotaBreached = true;
					cancelRequested = true;
					await this.requestCancelNow(remoteId);
					await this.persistence.save(record('cancel-requested', remoteId));
				}
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

	/** Honest status: never fabricates; transport/404 failures read as 'unknown'. */
	async status(remoteId: string): Promise<SandboxStatusResult> {
		requireNonEmpty(remoteId, 'remoteId');
		const operation = await this.contree.getOperation(remoteId).catch(() => null);
		if (!operation) return { state: 'unknown' };
		switch (operation.state) {
			case 'RUNNING':
			case 'PENDING':
			case 'QUEUED':
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
		const requested = await this.requestCancelNow(remoteId);
		return { requested };
	}

	/**
	 * Reconcile a persisted operation by ITS KEY (never a blind re-dispatch):
	 * adopts the remote id via provider correlation when it was lost, then
	 * polls to a terminal outcome or reports 'unknown'.
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
			const found = await this.contree.findOperationByKey(operationKey).catch(() => null);
			if (!found) return { state: 'unknown' };
			remoteId = found.operationId;
			await this.persistence.save({
				...stored,
				remoteId,
				state: stored.state === 'ambiguous' ? 'dispatched' : stored.state,
				updatedAt: nowIso(),
			});
		}
		const bound = Date.now() + this.reconcileTimeoutMs;
		for (;;) {
			const operation = await this.contree.getOperation(remoteId).catch(() => null);
			if (operation && isTerminalState(operation.state)) {
				const outcome = terminalSandboxState(operation.state);
				await this.persistence.save({ ...stored, remoteId, state: outcome, updatedAt: nowIso() });
				return { state: outcome, exitCode: operation.exitCode ?? undefined };
			}
			if (Date.now() >= bound) return { state: 'unknown' };
			await sleep(this.pollIntervalMs);
		}
	}

	// --- internals -------------------------------------------------------------------

	private sessionRecord(
		sessionId: string,
		fields: { projectId?: string; runId?: string; image?: string; checkpointRef?: string },
		state: string,
	): SandboxRecord {
		return {
			kind: 'session',
			key: `session:${sessionId}`,
			sessionId,
			projectId: fields.projectId ?? null,
			runId: fields.runId ?? null,
			image: fields.image ?? null,
			checkpointRef: fields.checkpointRef ?? null,
			operationKey: null,
			remoteId: null,
			state,
			artifactRef: null,
			sha256: null,
			updatedAt: nowIso(),
		};
	}

	/** Load the session binding; a missing or disposed session is typed, not silent. */
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
		return record;
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
				return new SandboxError(410, 'SESSION_LOST', `${message}: session is gone`, {
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
