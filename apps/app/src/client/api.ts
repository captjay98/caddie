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

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: { accept: 'application/json', ...(init?.headers ?? {}) },
		});
	} catch {
		// fetch only rejects on network-level failure (offline, aborted origin)
		throw new ApiError('offline', undefined, undefined, 'You appear to be offline.');
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
