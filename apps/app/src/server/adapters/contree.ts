/**
 * P04/P05 contree REST client (apps/app/src/server/adapters/contree.ts).
 *
 * fetch-only port over the REAL contree (Nebius TF Sandboxes) REST surface.
 * The endpoint spellings and payload shapes below are taken from the
 * OpenAPI-generated `contree_client` Python package (contree-client 0.4.0,
 * the library behind the contree CLI 0.9.4 the adjudication used) — the same
 * surface docs/setup/sandbox.md now documents. Where the live probe has
 * exercised a path, the docs table upgrades it to LIVE VERIFIED; everything
 * not yet probed stays DOCUMENTATION ONLY for that path.
 *
 * THE API HAS NO SERVER-SIDE SESSIONS. Contree is content-addressed:
 *   - `POST /v1/files` stores raw bytes and returns {uuid, sha256, size};
 *   - `POST /v1/instances` runs ONE command from an IMAGE (a filesystem
 *     snapshot uuid); a non-disposable run commits a NEW image layer
 *     (`result.image`) — that chain of images IS the session state;
 *   - `GET /v1/inspect/{image}/download|list?path=…` read files/directories
 *     from any image without spawning anything.
 * Session identity therefore lives in OUR driver (apps/app/src/server/
 * adapters/sandbox.ts): a session key maps to the current image uuid plus
 * the workspace root — exactly the bookkeeping the contree CLI does locally
 * in its SQLite store (`-S <key>`).
 *
 * Transport rules the driver relies on:
 *   - Authorization: `Bearer <token>` header + `Project: <project id>` header
 *     (the generated client sends exactly these; the P04-assumed
 *     `x-nebius-project-id` name was wrong).
 *   - Every instance dispatch carries a caller operation key for OUR
 *     bookkeeping, but the real API has NO idempotent-replay guarantee:
 *     POST /v1/instances is explicitly non-idempotent ("a re-sent POST could
 *     spawn a second sandbox"). A transport failure on dispatch is therefore
 *     AMBIGUOUS and only reconcilable when the operation uuid was persisted;
 *     otherwise it stays honestly `unknown` — never a blind retry.
 *   - Cancel is `DELETE /v1/operations/{id}` — a REQUEST; termination is
 *     proven by polling `GET /v1/operations/{id}`.
 */

export interface ContreeConfig {
	/** Base incl. service prefix, e.g. `https://api.tokenfactory.nebius.com/sandboxes`. */
	baseUrl: string;
	/** IAM bearer token (owner secret; header only — never in a body). */
	apiToken: string;
	/** Platform project id sent as the `Project` header (owner input). */
	platformProjectId: string;
	/** Test seam; production uses global fetch. */
	fetchImpl?: typeof fetch;
}

export interface ContreeFileRecord {
	uuid: string;
	sha256: string;
	size: number;
}

export interface ContreeAttachedFile {
	/** Absolute path INSIDE the instance filesystem where the file must land. */
	path: string;
	uuid: string;
	/** Octal mode string, e.g. `0644`. */
	mode?: string;
}

export interface ContreeInstanceInput {
	/** Image uuid (or `tag:name` reference) the command runs from. */
	image: string;
	command: string;
	shell?: boolean;
	cwd?: string;
	env?: Record<string, string>;
	/** Seconds; the service kills the instance beyond this. */
	timeoutSec?: number;
	/** Content-addressed files to attach at their instance paths. */
	files?: ContreeAttachedFile[];
	disposable?: boolean;
	/** Server-side stdout+stderr truncation bound in bytes. */
	truncateOutputAt?: number;
}

export interface ContreeStream {
	value: string;
	encoding: 'ascii' | 'base64';
	truncated?: boolean;
}

export interface ContreeOperation {
	operationId: string;
	state: ContreeOperationState;
	/** Process exit code (from metadata.result.state); null when not available. */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	outputBytes: number | null;
	/** True when the service truncated the output stream at the bound. */
	outputTruncated: boolean;
	/** Image uuid committed by a SUCCESSFUL non-disposable run. */
	resultImage: string | null;
	error: string | null;
	timedOut: boolean;
	durationMs: number | null;
}

/**
 * Real statuses: PENDING/ASSIGNED/EXECUTING are in-flight;
 * SUCCESS/FAILED/CANCELLED are terminal. `UNKNOWN` covers anything else.
 */
export type ContreeOperationState =
	| 'PENDING'
	| 'ASSIGNED'
	| 'EXECUTING'
	| 'SUCCEEDED'
	| 'FAILED'
	| 'CANCELLED'
	| 'UNKNOWN';

export interface ContreeFileItem {
	/** Entry name, relative to the listed directory. */
	path: string;
	size: number;
	isDir: boolean;
	isRegular: boolean;
	isSymlink: boolean;
	/** Unix mtime seconds. */
	mtime: number;
	mode: number;
}

export interface ContreeDirectoryList {
	path: string;
	files: ContreeFileItem[];
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
	uuid?: unknown;
	status?: unknown;
	error?: unknown;
	duration?: unknown;
	result?: unknown;
	metadata?: unknown;
}

interface RawStream {
	value?: unknown;
	encoding?: unknown;
	truncated?: unknown;
}

const KNOWN_STATES = new Set([
	'PENDING',
	'ASSIGNED',
	'EXECUTING',
	'SUCCESS',
	'FAILED',
	'CANCELLED',
]);
const TERMINAL_STATES = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);

function asOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** Decode a contree StreamRepr ({value, encoding}) to text. */
function decodeStream(stream: unknown): string {
	if (!stream || typeof stream !== 'object') return '';
	const raw = stream as RawStream;
	const value = asOptionalString(raw.value) ?? '';
	if (raw.encoding === 'base64') {
		try {
			// atob → binary string → Uint8Array → UTF-8 (Workers-safe).
			const binary = atob(value);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			return new TextDecoder().decode(bytes);
		} catch {
			return '';
		}
	}
	return value;
}

function streamBytes(stream: unknown): number {
	if (!stream || typeof stream !== 'object') return 0;
	const raw = stream as RawStream;
	const value = asOptionalString(raw.value) ?? '';
	if (raw.encoding === 'base64') {
		return Math.floor((value.replace(/=+$/, '').length * 3) / 4);
	}
	return new TextEncoder().encode(value).length;
}

/** Binary string (chars 0-255) → base64, Workers-safe (no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** base64 → bytes, Workers-safe. */
export function base64ToBytes(contentBase64: string): Uint8Array {
	const binary = atob(contentBase64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export class ContreeClient {
	constructor(private readonly config: ContreeConfig) {}

	private async request(
		method: string,
		path: string,
		options: {
			body?: unknown;
			/** Raw bytes body (content-addressed file upload). */
			bodyBytes?: Uint8Array;
			query?: Record<string, string>;
			signal?: AbortSignal;
			/** Treat 404 as null instead of an error (inspect/operation lookups). */
			notFoundIsNull?: boolean;
			/** Return the raw response instead of parsing JSON (302/bytes paths). */
			raw?: boolean;
		} = {},
	): Promise<Response | null> {
		const url = new URL(`${this.config.baseUrl}/v1${path}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			url.searchParams.set(key, value);
		}
		let response: Response;
		try {
			response = await (this.config.fetchImpl ?? fetch)(url, {
				method,
				signal: options.signal,
				// Manual redirects: the tag-resolution endpoint answers 302 and the
				// CLIENT reads the Location header (never auto-followed).
				redirect: 'manual',
				headers: {
					authorization: `Bearer ${this.config.apiToken}`,
					project: this.config.platformProjectId,
					...(options.bodyBytes !== undefined
						? { 'content-type': 'application/octet-stream' }
						: options.body !== undefined
							? { 'content-type': 'application/json' }
							: {}),
				},
				body:
					options.bodyBytes !== undefined
						? // Exact-size ArrayBuffer copy (BodyInit; avoids Uint8Array
							// generic variance issues across TS lib targets).
							options.bodyBytes.slice().buffer as ArrayBuffer
						: options.body !== undefined
							? JSON.stringify(options.body)
							: undefined,
			});
		} catch (error) {
			throw new ContreeApiError(
				0,
				'transport_error',
				`contree ${method} ${path} did not complete: ${String(error)}`,
			);
		}
		if (options.raw) return response;
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
		return response;
	}

	private async requestJson<T>(
		method: string,
		path: string,
		options?: Parameters<ContreeClient['request']>[2],
	): Promise<T | null> {
		const response = await this.request(method, path, options);
		if (!response) return null;
		if (response.status === 204) return null;
		return (await response.json()) as T;
	}

	// --- images -------------------------------------------------------------

	/**
	 * Resolve an image reference to its uuid: a raw uuid passes through;
	 * `tag:name` (or a bare tag) resolves via `GET /inspect/?tag=` which
	 * answers 302 with the image location.
	 */
	async resolveImageRef(ref: string, signal?: AbortSignal): Promise<string> {
		const trimmed = requireNonEmpty(ref, 'image ref').trim();
		if (isImageUuid(trimmed)) return trimmed;
		const tag = trimmed.startsWith('tag:') ? trimmed.slice(4) : trimmed;
		const response = await this.request('GET', '/inspect/', {
			query: { tag },
			signal,
			raw: true,
		});
		if (!response || response.status !== 302) {
			const status = response?.status ?? 0;
			throw new ContreeApiError(
				status === 0 ? 0 : status,
				'image_not_found',
				`contree could not resolve image tag ${tag} (HTTP ${status})`,
			);
		}
		const location = response.headers.get('location') ?? '';
		// The Location header ends with the image uuid (…/inspect/<uuid>/ or
		// …/inspect/<uuid>) — take the last non-empty path segment.
		const segments = location.split('/').filter((segment) => segment.length > 0);
		const uuid = segments[segments.length - 1] ?? '';
		if (!uuid) {
			throw new ContreeApiError(502, 'image_not_found', `contree tag resolution for ${tag} returned no image uuid (Location: ${location})`);
		}
		return uuid;
	}

	// --- content-addressed files ---------------------------------------------

	/** `POST /files` — store raw bytes (deduplicated server-side by content). */
	async uploadFileBytes(content: Uint8Array, signal?: AbortSignal): Promise<ContreeFileRecord> {
		const response = await this.requestJson<ContreeFileRecord>('POST', '/files', {
			bodyBytes: content,
			signal,
		});
		if (!response || typeof response.uuid !== 'string') {
			throw new ContreeApiError(502, 'upload_failed', 'contree file upload returned no uuid');
		}
		return {
			uuid: response.uuid,
			sha256: asOptionalString(response.sha256) ?? '',
			size: typeof response.size === 'number' ? response.size : content.byteLength,
		};
	}

	// --- inspect (read files/directories from any image) -----------------------

	/**
	 * `GET /inspect/{image}/download?path=…` — raw bytes of one file inside
	 * the image. Returns null when the path does not exist (404).
	 */
	async inspectDownload(
		imageUuid: string,
		absolutePath: string,
		signal?: AbortSignal,
	): Promise<Uint8Array | null> {
		const response = await this.request('GET', `/inspect/${encodeURIComponent(requireNonEmpty(imageUuid, 'imageUuid'))}/download`, {
			query: { path: absolutePath },
			signal,
			notFoundIsNull: true,
			raw: true,
		});
		if (!response || response.status === 404) return null;
		if (!response.ok) {
			throw new ContreeApiError(
				response.status,
				'http_error',
				`contree inspect download of ${absolutePath} failed with HTTP ${response.status}`,
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	/**
	 * `GET /inspect/{image}/list?path=…` — one directory level inside the
	 * image. Returns null when the directory does not exist (404).
	 */
	async inspectList(
		imageUuid: string,
		dirAbsolutePath: string,
		signal?: AbortSignal,
	): Promise<ContreeDirectoryList | null> {
		const raw = await this.requestJson<{ path?: unknown; files?: unknown }>(
			'GET',
			`/inspect/${encodeURIComponent(requireNonEmpty(imageUuid, 'imageUuid'))}/list`,
			{ query: { path: dirAbsolutePath }, signal, notFoundIsNull: true },
		);
		if (!raw) return null;
		const files = Array.isArray(raw.files) ? raw.files : [];
		return {
			path: asOptionalString(raw.path) ?? dirAbsolutePath,
			files: files.map((item) => {
				const entry = item as Record<string, unknown>;
				return {
					path: asOptionalString(entry['path']) ?? '',
					size: typeof entry['size'] === 'number' ? entry['size'] : 0,
					isDir: entry['is_dir'] === true,
					isRegular: entry['is_regular'] === true,
					isSymlink: entry['is_symlink'] === true,
					mtime: typeof entry['mtime'] === 'number' ? entry['mtime'] : 0,
					mode: typeof entry['mode'] === 'number' ? entry['mode'] : 0,
				};
			}),
		};
	}

	/**
	 * `GET /inspect/{image}/archive?path=…` — a POSIX tar archive of the path
	 * (file or directory tree) inside the image. Returns null on 404.
	 */
	async inspectArchive(
		imageUuid: string,
		absolutePath: string,
		signal?: AbortSignal,
	): Promise<Uint8Array | null> {
		const response = await this.request(
			'GET',
			`/inspect/${encodeURIComponent(requireNonEmpty(imageUuid, 'imageUuid'))}/archive`,
			{ query: { path: absolutePath }, signal, notFoundIsNull: true, raw: true },
		);
		if (!response || response.status === 404) return null;
		if (!response.ok) {
			throw new ContreeApiError(
				response.status,
				'http_error',
				`contree inspect archive of ${absolutePath} failed with HTTP ${response.status}`,
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	// --- instances (one command execution from an image) -----------------------

	/**
	 * `POST /instances` — run ONE command from an image. NON-IDEMPOTENT on
	 * the wire (a lost response may leave a running orphan); the caller
	 * persists the operation identity BEFORE dispatch where possible and
	 * never retries blindly. Returns the operation uuid to poll.
	 */
	async spawnInstance(
		input: ContreeInstanceInput,
		signal?: AbortSignal,
	): Promise<{ operationId: string }> {
		const body: Record<string, unknown> = {
			image: requireNonEmpty(input.image, 'image'),
			command: requireNonEmpty(input.command, 'command'),
			shell: input.shell ?? true,
			disposable: input.disposable ?? false,
		};
		if (input.cwd !== undefined) body['cwd'] = input.cwd;
		if (input.env !== undefined) body['env'] = input.env;
		if (input.timeoutSec !== undefined) body['timeout'] = Math.max(1, Math.ceil(input.timeoutSec));
		if (input.truncateOutputAt !== undefined) body['truncate_output_at'] = input.truncateOutputAt;
		if (input.files !== undefined && input.files.length > 0) {
			body['files'] = Object.fromEntries(
				input.files.map((file) => [
					file.path,
					{ uuid: file.uuid, ...(file.mode !== undefined ? { mode: file.mode } : {}) },
				]),
			);
		}
		const response = await this.requestJson<{ uuid?: unknown }>('POST', '/instances', {
			body,
			signal,
		});
		const operationId = asOptionalString(response?.uuid);
		if (!operationId) {
			throw new ContreeApiError(502, 'dispatch_failed', 'contree instance spawn returned no operation uuid');
		}
		return { operationId };
	}

	// --- operations ------------------------------------------------------------

	/**
	 * `GET /operations/{id}` — poll one operation. Returns null for an
	 * unknown id (404). Normalizes the real response shape:
	 * `{uuid, status, error, duration, result: {image}, metadata: {result:
	 * {exit_code, stdout, stderr, state: {exit_code, timed_out}}}}`.
	 */
	async getOperation(operationId: string, signal?: AbortSignal): Promise<ContreeOperation | null> {
		const raw = await this.requestJson<RawOperation>(
			'GET',
			`/operations/${encodeURIComponent(requireNonEmpty(operationId, 'operationId'))}`,
			{ notFoundIsNull: true, signal },
		);
		if (!raw) return null;
		const status = asOptionalString(raw.status) ?? 'UNKNOWN';
		const state = (KNOWN_STATES.has(status) ? status : 'UNKNOWN') as string;
		const normalizedState: ContreeOperationState =
			state === 'SUCCESS' ? 'SUCCEEDED' : (state as ContreeOperationState);
		const metadata = (raw.metadata ?? null) as Record<string, unknown> | null;
		const instanceResult = (metadata?.['result'] ?? null) as Record<string, unknown> | null;
		const resultState = (instanceResult?.['state'] ?? null) as Record<string, unknown> | null;
		const exitCode =
			resultState && typeof resultState['exit_code'] === 'number' ? resultState['exit_code'] : null;
		const result = (raw.result ?? null) as Record<string, unknown> | null;
		const stdoutStream = instanceResult?.['stdout'];
		const stderrStream = instanceResult?.['stderr'];
		const truncated = (stream: unknown): boolean =>
			!!(stream && typeof stream === 'object' && (stream as RawStream).truncated === true);
		return {
			operationId: asOptionalString(raw.uuid) ?? operationId,
			state: normalizedState,
			exitCode,
			stdout: decodeStream(stdoutStream),
			stderr: decodeStream(stderrStream),
			outputBytes: streamBytes(stdoutStream) + streamBytes(stderrStream),
			outputTruncated: truncated(stdoutStream) || truncated(stderrStream),
			resultImage:
				result && typeof result['image'] === 'string' ? (result['image'] as string) : null,
			error: asOptionalString(raw.error) ?? null,
			timedOut: resultState?.['timed_out'] === true,
			durationMs:
				typeof raw.duration === 'number' ? Math.round(raw.duration * 1000) : null,
		};
	}

	/**
	 * Cancellation REQUEST — `DELETE /operations/{id}`. Proves nothing about
	 * termination; poll the operation to prove the terminal outcome.
	 */
	async cancelOperation(operationId: string, signal?: AbortSignal): Promise<void> {
		const response = await this.request(
			'DELETE',
			`/operations/${encodeURIComponent(requireNonEmpty(operationId, 'operationId'))}`,
			{ signal },
		);
		if (response && !response.ok && response.status !== 404) {
			throw new ContreeApiError(
				response.status,
				'http_error',
				`contree cancel of ${operationId} failed with HTTP ${response.status}`,
			);
		}
	}

	/** Credential probe for the live harness — `GET /whoami` (no side effects). */
	async whoami(signal?: AbortSignal): Promise<{ tokenUuid: string } | null> {
		const raw = await this.requestJson<{ token_uuid?: unknown }>('GET', '/whoami', { signal });
		if (!raw) return null;
		return { tokenUuid: asOptionalString(raw['token_uuid']) ?? '' };
	}
}

// --- helpers -------------------------------------------------------------------

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new ContreeApiError(400, 'invalid_input', `${field} is required`);
	}
	return value;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True when the reference is already a raw image uuid (no tag resolution). */
export function isImageUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}
