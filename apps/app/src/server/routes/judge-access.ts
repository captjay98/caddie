import { Hono } from 'hono';
import type { ArtifactsBinding } from '../adapters/cloudflare-artifacts.ts';
import type { AuthEnv } from '../auth.ts';
import { getAuth } from '../auth.ts';
import { codeStoreFor } from '../code-store-env.ts';
import { judgeAccessState, judgeIdentityFrom, signInJudge, startJudge, type JudgeAccessConfig } from '../judge-access.ts';
import { seedJudgeExample } from '../judge-example.ts';
import { ScopeError } from '../scope.ts';
import { reportRateLimitKey } from './report.ts';

/**
 * S06 judge access routes, mounted at /api (app.ts composes this next to the
 * other routers):
 *
 *   GET  /api/judge/access    { open, canStart } for the sign-in panel
 *   POST /api/judge/start     { code, name, password } -> session cookie
 *                             (and, S07b, the judge's finished example)
 *   POST /api/judge/sign-in   { name, password }       -> session cookie
 *
 * The route layer only reads the body, keys the caller and forwards the cookie;
 * every rule and every plain sentence the panel shows live in
 * server/judge-access.ts. Refusals are the same JSON shape the rest of the API
 * uses: `{ error, message }`.
 */

type Env = AuthEnv & {
	JUDGE_ACCESS_CODE?: string;
	JUDGE_ACCESS_UNTIL?: string;
	JUDGE_ACCESS_ENABLED?: string;
	JUDGE_ACCESS_MAX_ACCOUNTS?: string;
	/** S07b: the owner's demo project, copied into every new judge's workspace. */
	JUDGE_EXAMPLE_PROJECT_ID?: string;
	ARTIFACTS?: ArtifactsBinding;
};

/** Purpose-bound rate-limit label; the same derivation the report page uses. */
export const JUDGE_RATE_LIMIT_LABEL = 'caddie-judge-ratelimit:v1';

function configOf(env: Env): JudgeAccessConfig {
	return {
		code: env.JUDGE_ACCESS_CODE,
		until: env.JUDGE_ACCESS_UNTIL,
		enabled: env.JUDGE_ACCESS_ENABLED,
		maxAccounts: env.JUDGE_ACCESS_MAX_ACCOUNTS,
	};
}

/** Read a JSON object; anything unreadable reads as an empty body so the
 *  service answers with its own first missing field, never a different text. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const parsed = await request.json();
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * A keyed hash of the caller's address, bound to the current hour. Only this
 * hash is stored; the address itself never is. Mirrors the report page's
 * reporter hash, one hour at a time instead of one day.
 */
async function attemptHash(keyMaterial: string, ip: string, now: Date): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyMaterial), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ip}|${now.toISOString().slice(0, 13)}`)));
	return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Null when there is no master secret to key the hash with — nothing is stored. */
async function callerHash(env: Env, request: Request, now: Date): Promise<string | null> {
	const key = await reportRateLimitKey(env.BETTER_AUTH_SECRET, JUDGE_RATE_LIMIT_LABEL);
	if (key === null) return null;
	return attemptHash(key, request.headers.get('cf-connecting-ip') ?? 'unknown', now);
}

/** Copy Better Auth's `set-cookie` headers onto our JSON answer. */
function forwardSessionCookie(response: Response, from: Headers): Response {
	const headers = from as Headers & { getSetCookie?: () => string[] };
	const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : from.get('set-cookie') ? [from.get('set-cookie') as string] : [];
	for (const cookie of cookies) response.headers.append('set-cookie', cookie);
	response.headers.set('cache-control', 'no-store');
	return response;
}

export function createJudgeAccessRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		if (error instanceof ScopeError) {
			return c.json({ error: error.code, message: error.message }, error.status as 500);
		}
		console.error('judge access: unhandled error:', error);
		return c.json({ error: 'internal_error' }, 500);
	});

	router.get('/judge/access', (c) => c.json(judgeAccessState(configOf(c.env), new Date())));

	router.post('/judge/start', async (c) => {
		const now = new Date();
		const body = await readBody(c.req.raw);
		const hash = await callerHash(c.env, c.req.raw, now);
		if (hash === null) {
			return c.json({ error: 'judge_unavailable', message: "Judge access isn't open right now." }, 503);
		}
		const result = await startJudge(
			c.env.DB,
			{
				code: body['code'],
				name: body['name'],
				password: body['password'],
				secret: c.env.BETTER_AUTH_SECRET,
				ipHash: hash,
				config: configOf(c.env),
				now: now.toISOString(),
			},
			judgeIdentityFrom(getAuth(c.env)),
		);
		// S07b: the judge's finished example. Best-effort and off the answer's
		// path on Workers (waitUntil); awaited where there is no execution
		// context (tests, local scripts) so the result is deterministic.
		const seeding = seedJudgeExample(
			{ db: c.env.DB, store: codeStoreFor(c.env), demoProjectId: c.env.JUDGE_EXAMPLE_PROJECT_ID },
			result.userId,
		).catch((error: unknown) => {
			console.error('judge access: the example was not added:', error instanceof Error ? error.message : String(error));
		});
		let inBackground = false;
		try {
			c.executionCtx.waitUntil(seeding);
			inBackground = true;
		} catch {
			// No execution context: fall through and wait for it.
		}
		if (!inBackground) await seeding;
		return forwardSessionCookie(c.json({ ok: true, name: result.name }), result.headers);
	});

	router.post('/judge/sign-in', async (c) => {
		const now = new Date();
		const body = await readBody(c.req.raw);
		const hash = await callerHash(c.env, c.req.raw, now);
		if (hash === null) {
			return c.json({ error: 'judge_unavailable', message: "Judge access isn't open right now." }, 503);
		}
		const result = await signInJudge(
			c.env.DB,
			{
				name: body['name'],
				password: body['password'],
				ipHash: hash,
				config: configOf(c.env),
				now: now.toISOString(),
			},
			judgeIdentityFrom(getAuth(c.env)),
		);
		return forwardSessionCookie(c.json({ ok: true, name: result.name }), result.headers);
	});

	return router;
}
