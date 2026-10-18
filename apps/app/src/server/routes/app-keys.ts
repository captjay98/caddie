import { Hono } from 'hono';
import type { Scope } from '@caddie/contracts';
import type { AuthEnv } from '../auth.ts';
import { deleteAppSecret, listAppSecrets, setAppSecret } from '../app-secrets.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';
import { SecretBoxError, keyringFromEnv, type Keyring } from '../secret-box.ts';

/**
 * App keys (Publish programme stage 8): the keys a generated app needs for
 * outside services.
 *
 *   GET    /projects/:projectId/keys          metadata only + whether this
 *                                             server can store keys at all
 *   PUT    /projects/:projectId/keys/:name    { value } — owner only; sealed
 *                                             at rest; the value is never
 *                                             returned, now or later
 *   DELETE /projects/:projectId/keys/:name    owner only; a key the builder
 *                                             asked for goes back to "needed"
 *
 * No response ever carries a value or an envelope. Writes need a JSON body
 * (a cross-site form cannot send one without a CORS preflight), on top of the
 * session cookie's SameSite default.
 */

type Env = AuthEnv & { APP_SECRETS_KEYS?: string };

const NO_STORE = { 'cache-control': 'no-store' } as const;
const MAX_BODY_BYTES = 16 * 1024;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) return { status: error.status, body: { error: error.code, message: error.message } };
	if (error instanceof SecretBoxError) {
		if (error.code === 'NOT_CONFIGURED' || error.code === 'BAD_KEYRING') {
			if (error.code === 'BAD_KEYRING') console.error('app keys: APP_SECRETS_KEYS is misconfigured:', error.message);
			return { status: 503, body: { error: 'keys_unavailable', message: "Saving keys isn't set up on this Caddie server yet." } };
		}
		console.error('app keys: secret box failure:', error.code);
		return { status: 500, body: { error: 'internal_error' } };
	}
	console.error('unhandled app keys route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function readValue(request: Request): Promise<unknown> {
	if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
		throw new ScopeError(415, 'invalid_request', 'send the key as JSON');
	}
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (declared > MAX_BODY_BYTES) throw new ScopeError(413, 'invalid_input', 'That key is too long (8 KB at most).');
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) throw new ScopeError(413, 'invalid_input', 'That key is too long (8 KB at most).');
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ScopeError(400, 'invalid_input', 'body must be { value }');
	return (body as { value?: unknown }).value;
}

async function keyringOrNull(env: Env): Promise<Keyring | null> {
	try {
		return await keyringFromEnv(env);
	} catch (error) {
		if (error instanceof SecretBoxError) {
			if (error.code === 'BAD_KEYRING') console.error('app keys: APP_SECRETS_KEYS is misconfigured:', error.message);
			return null;
		}
		throw error;
	}
}

export interface AppKeysRouterOptions {
	/**
	 * How a request becomes a project scope. Production: the verified session
	 * plus membership (requireProjectScope). Tests substitute a resolver over the
	 * same membership rows so the routes run in-process without Better Auth.
	 */
	scopeFor?: (env: Env, request: Request, projectId: string) => Promise<Scope>;
}

const sessionScope = (env: Env, request: Request, projectId: string) => requireProjectScope(env.DB, env, request.headers, projectId);

export function createAppKeysRouter(options: AppKeysRouterOptions = {}): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	const scopeFor = options.scopeFor ?? sessionScope;

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500, NO_STORE);
	});

	router.get('/projects/:projectId/keys', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		const keys = await listAppSecrets(c.env.DB, scope);
		const configured = (await keyringOrNull(c.env)) !== null;
		return c.json({ configured, keys }, 200, NO_STORE);
	});

	router.put('/projects/:projectId/keys/:name', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		const value = await readValue(c.req.raw);
		const keyring = await keyringFromEnv(c.env);
		const key = await setAppSecret(c.env.DB, keyring, scope, { name: c.req.param('name'), value });
		return c.json({ key }, 200, NO_STORE);
	});

	router.delete('/projects/:projectId/keys/:name', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		const key = await deleteAppSecret(c.env.DB, scope, c.req.param('name'));
		return c.json({ key }, 200, NO_STORE);
	});

	return router;
}
