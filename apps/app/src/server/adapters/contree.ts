/**
 * P04 contree REST client (apps/app/src/server/adapters/contree.ts).
 *
 * fetch-only port of the adjudication's async contree client
 * (`nebius-forge-eval/adjudication/shared/contree-async.ts`): the CLI cannot
 * spawn under Workers (feature-ledger settled decision), so the same remote
 * semantics travel over the documented REST surface.
 *
 * ENDPOINT EVIDENCE SPLIT (docs/setup/sandbox.md has the full table):
 *   - LIVE VERIFIED facts from the adjudication (evidence/phase-a.md):
 *       * base service `https://api.tokenfactory.nebius.com/sandboxes`;
 *       * the documented REST `/sandboxes/v1/*` surface was live-verified
 *         REACHABLE via fetch with IAM + Project headers;
 *       * remote operations are addressed by an id, carry a status
 *         (RUNNING/PENDING/QUEUED observed in flight) and a `kill` verb
 *         cancels them; exec results are JSON `{exit_code, stdout, stderr,
 *         status}`.
 *   - DOCUMENTED ASSUMPTIONS (verify at the first authorized live probe):
 *       exact path spellings and payload field names below. They mirror the
 *       CLI verb surface 1:1 so any drift is a mechanical fix in THIS file —
 *       the driver and tests never hardcode endpoint spellings.
 *
 * Transport rules the driver relies on:
 *   - every remote mutation carries a caller operation key (idempotent
 *     dispatch server-side);
 *   - a transport failure on dispatch throws status 0 `transport_error` —
 *     the caller CANNOT know whether the operation was created, so it must
 *     treat that as AMBIGUOUS and reconcile by operation key;
 *   - cancel is a REQUEST (202): termination is proven by polling status.
 */

export interface ContreeConfig {
	/** Base incl. service prefix, e.g. `https://api.tokenfactory.nebius.com/sandboxes`. */
	baseUrl: string;
	/** IAM bearer token (owner secret; header only — never in a body). */
	apiToken: string;
	/** Platform project id sent as the project header (owner input). */
	platformProjectId: string;
	/** Test seam; production uses global fetch. */
	fetchImpl?: typeof fetch;
}

export interface ContreeSessionInput {
	sessionKey: string;
	image: string;
	restoreFrom?: string;
	isolation?: Record<string, unknown>;
	/** Absolute sandbox workspace directory for this session (containment root). */
	workspaceRoot: string;
}

export interface ContreeExecInput {
	command: string;
	cwd?: string;
	timeoutSec: number;
	operationKey: string;
	env?: Record<string, string>;
}

export type ContreeOperationState =
	| 'PENDING'
	| 'QUEUED'
	| 'RUNNING'
	| 'SUCCEEDED'
	| 'FAILED'
	| 'CANCELLED'
	| 'UNKNOWN';

export interface ContreeOperation {
	operationId: string;
	state: ContreeOperationState;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	outputBytes: number | null;
}

/** Typed remote failure. status 0 = transport-level (request did not complete). */
export class ContreeApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly remoteCode?: string,
	) {
		super(message);
		this.name = 'ContreeApiError';
	}
}

interface RawOperation {
	operationId?: unknown;
	state?: unknown;
	exitCode?: unknown;
	stdout?: unknown;
	stderr?: unknown;
	outputBytes?: unknown;
}

const KNOWN_STATES = new Set(['PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);

function asOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

export class ContreeClient {
	constructor(private readonly config: ContreeConfig) {}

	private async request<T>(
		method: string,
		path: string,
		options: {
			body?: unknown;
			signal?: AbortSignal;
			/** Treat 404 as null instead of an error (status/correlation lookups). */
			notFoundIsNull?: boolean;
			/** Expect and ignore a 204 empty body. */
			noContent?: boolean;
		} = {},
	): Promise<T | null> {
		let response: Response;
		try {
			response = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl}${path}`, {
				method,
				signal: options.signal,
				headers: {
					authorization: `Bearer ${this.config.apiToken}`,
					'x-nebius-project-id': this.config.platformProjectId,
					...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
				},
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			});
		} catch (error) {
			throw new ContreeApiError(
				0,
				'transport_error',
				`contree ${method} ${path} did not complete: ${String(error)}`,
			);
		}
		if (response.status === 404 && options.notFoundIsNull) return null;
		if (!response.ok) {
			let remoteCode: string | undefined;
			try {
				const body = (await response.json()) as { error?: unknown };
				remoteCode = asOptionalString(body.error);
			} catch {
				// non-JSON error body — status is the honest information
			}
			throw new ContreeApiError(
				response.status,
				'http_error',
				`contree ${method} ${path} failed with HTTP ${response.status}${remoteCode ? ` (${remoteCode})` : ''}`,
				remoteCode,
			);
		}
		if (options.noContent || response.status === 204) return null;
		return (await response.json()) as T;
	}

	createSession(input: ContreeSessionInput, signal?: AbortSignal): Promise<{ sessionId: string }> {
		return this.request<{ sessionId: string }>('POST', '/v1/sessions', {
			body: {
				sessionKey: input.sessionKey,
				image: input.image,
				workspaceRoot: input.workspaceRoot,
				...(input.restoreFrom !== undefined ? { restoreFrom: input.restoreFrom } : {}),
				...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
			},
			signal,
		}) as Promise<{ sessionId: string }>;
	}

	uploadFile(sessionId: string, absolutePath: string, contentBase64: string): Promise<void> {
		return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/files`, {
			body: { path: absolutePath, contentBase64 },
		}).then(() => undefined);
	}

	/**
	 * Async dispatch: 202 + operation id. The operation key makes the remote
	 * mutation idempotent — a replay MUST return the same operation.
	 */
	dispatchExec(
		sessionId: string,
		input: ContreeExecInput,
		signal?: AbortSignal,
	): Promise<{ operationId: string }> {
		return this.request<{ operationId: string }>(
			'POST',
			`/v1/sessions/${encodeURIComponent(sessionId)}/exec`,
			{
				body: {
					command: input.command,
					operationKey: input.operationKey,
					timeoutSec: Math.max(1, Math.ceil(input.timeoutSec)),
					...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
					...(input.env !== undefined ? { env: input.env } : {}),
				},
				signal,
			},
		) as Promise<{ operationId: string }>;
	}

	async getOperation(operationId: string, signal?: AbortSignal): Promise<ContreeOperation | null> {
		const raw = await this.request<RawOperation>(
			'GET',
			`/v1/operations/${encodeURIComponent(operationId)}`,
			{ notFoundIsNull: true, signal },
		);
		if (!raw) return null;
		const state = asOptionalString(raw.state) ?? 'UNKNOWN';
		return {
			operationId: asOptionalString(raw.operationId) ?? operationId,
			state: (KNOWN_STATES.has(state) ? state : 'UNKNOWN') as ContreeOperationState,
			exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
			stdout: asOptionalString(raw.stdout) ?? '',
			stderr: asOptionalString(raw.stderr) ?? '',
			outputBytes: typeof raw.outputBytes === 'number' ? raw.outputBytes : null,
		};
	}

	/** Provider correlation lookup by OUR operation key (remote id may be lost). */
	findOperationByKey(operationKey: string): Promise<{ operationId: string } | null> {
		return this.request<{ operationId: string }>(
			'GET',
			`/v1/operations/by-key/${encodeURIComponent(operationKey)}`,
			{ notFoundIsNull: true },
		);
	}

	/** Cancellation REQUEST. 202 `{requested:true}` proves nothing about termination. */
	cancelOperation(operationId: string, signal?: AbortSignal): Promise<void> {
		return this.request(
			'POST',
			`/v1/operations/${encodeURIComponent(operationId)}/cancel`,
			{ signal },
		).then(() => undefined);
	}

	checkpoint(sessionId: string, signal?: AbortSignal): Promise<{ checkpointRef: string }> {
		return this.request<{ checkpointRef: string }>(
			'POST',
			`/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint`,
			{ signal },
		) as Promise<{ checkpointRef: string }>;
	}

	exportSession(
		sessionId: string,
		signal?: AbortSignal,
	): Promise<{ artifactRef: string; sha256: string }> {
		return this.request<{ artifactRef: string; sha256: string }>(
			'GET',
			`/v1/sessions/${encodeURIComponent(sessionId)}/export`,
			{ signal },
		) as Promise<{ artifactRef: string; sha256: string }>;
	}

	disposeSession(sessionId: string, signal?: AbortSignal): Promise<void> {
		return this.request('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`, {
			noContent: true,
			signal,
		}).then(() => undefined);
	}
}
