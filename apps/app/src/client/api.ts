/**
 * Typed fetch boundary for the workspace SPA over the real P02 REST surface
 * (apps/app/src/server/routes/projects.ts + auth.ts, same origin /api).
 *
 * Every failure is classified ONCE here into an explicit, renderable kind:
 *   denied  — 401/403: the server refused this actor (missing/insufficient session)
 *   limit   — 429: a quota/rate/budget limit was hit
 *   offline — the request never completed (network down / fetch threw)
 *   error   — anything else (5xx, malformed payloads)
 * Components switch on the kind; nothing is silently swallowed.
 */

export type FailureKind = 'denied' | 'limit' | 'offline' | 'error';

export class ApiError extends Error {
	constructor(
		readonly kind: FailureKind,
		readonly status: number | undefined,
		readonly code: string | undefined,
		message: string,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

interface ErrorBody {
	error?: unknown;
	message?: unknown;
}

function bodyText(body: unknown): string {
	if (body !== null && typeof body === 'object') {
		const { error, message } = body as ErrorBody;
		if (typeof message === 'string' && message.trim()) return message;
		if (typeof error === 'string' && error.trim()) return error;
	}
	return 'The request did not succeed.';
}

/**
 * What a network-level failure means, in plain words. The device's own
 * network state decides it: offline -> reconnect; online -> the server did
 * not answer (it was NOT the person's connection).
 */
export function connectionFailureWords(): string {
	return typeof navigator !== 'undefined' && navigator.onLine === false
		? 'Your device is offline. Reconnect, then try again.'
		: 'Caddie’s server didn’t answer. Try again in a moment.';
}

/**
 * A caught error as a sentence for the screen. The browser's own wording for
 * a request that never completed ("Failed to fetch", "Load failed",
 * "NetworkError when attempting to fetch resource.") is replaced with
 * connectionFailureWords(); anything else keeps its message.
 */
export function readableFailure(cause: unknown): string {
	if (cause instanceof TypeError && /fetch|network|load failed/i.test(cause.message)) return connectionFailureWords();
	return cause instanceof Error ? cause.message : String(cause);
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: { accept: 'application/json', ...(init?.headers ?? {}) },
		});
	} catch {
		// fetch only rejects on network-level failure: the device is offline,
		// OR it is online and Caddie's server did not answer (down/restarting).
		throw new ApiError('offline', undefined, undefined, connectionFailureWords());
	}
	if (!response.ok) {
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			// non-JSON error body — classification carries the meaning
		}
		const kind: FailureKind =
			response.status === 401 || response.status === 403
				? 'denied'
				: response.status === 429
					? 'limit'
					: 'error';
		const code = (body as ErrorBody)?.error;
		throw new ApiError(
			kind,
			response.status,
			typeof code === 'string' ? code : undefined,
			bodyText(body),
		);
	}
	return (await response.json()) as T;
}

export function postJson<T>(path: string, payload: unknown): Promise<T> {
	return fetchJson<T>(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
}
