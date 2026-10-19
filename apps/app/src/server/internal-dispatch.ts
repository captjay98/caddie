/**
 * S07: proof that a coordinator message came from the SERVER's own dispatch,
 * not a browser.
 *
 * `dispatchPendingWorkflow` self-fetches the coordinator conversation carrying
 * the user's real session cookie, exactly like a browser message. The message
 * quota must count only what the judge typed, so the self-request also carries
 * an HMAC of the conversation id keyed by `BETTER_AUTH_SECRET` — a server-only
 * secret never sent to any client. A judge can set any header from the browser,
 * but cannot compute this value, so the header cannot be spoofed to evade the
 * limit. It is bound to the conversation, so it cannot be replayed elsewhere.
 *
 * Kept in its own module so the conversation guard does not import the whole
 * dispatch/build-workflow graph (and its cycles).
 */

export const INTERNAL_DISPATCH_HEADER = 'x-caddie-internal-dispatch';

function dispatchSecret(env: unknown): string | null {
	const secret = (env as { BETTER_AUTH_SECRET?: unknown } | undefined)?.BETTER_AUTH_SECRET;
	return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

/** The header value for one conversation; call only with a non-empty secret. */
export async function internalDispatchSignature(secret: string, conversationId: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`coordinator-dispatch:v1:${conversationId}`)));
	return [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameSignature(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let differing = 0;
	for (let i = 0; i < a.length; i++) differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return differing === 0;
}

/**
 * Whether this request carries a valid server-dispatch signature for the
 * conversation. No secret configured (e.g. a misconfigured Worker) reads as
 * "not internal", so the message is counted — the limit fails closed.
 */
export async function isInternalDispatch(env: unknown, headers: Headers, conversationId: string): Promise<boolean> {
	const secret = dispatchSecret(env);
	const presented = headers.get(INTERNAL_DISPATCH_HEADER);
	if (!secret || !presented) return false;
	return sameSignature(presented, await internalDispatchSignature(secret, conversationId));
}

/** Add the signature to a server-originated request when the env has a secret. */
export async function signInternalDispatch(env: unknown, headers: Record<string, string>, conversationId: string): Promise<void> {
	const secret = dispatchSecret(env);
	if (secret) headers[INTERNAL_DISPATCH_HEADER] = await internalDispatchSignature(secret, conversationId);
}
