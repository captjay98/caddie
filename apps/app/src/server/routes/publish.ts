import { Hono } from 'hono';
import type { Scope } from '@caddie/contracts';
import type { AuthEnv } from '../auth.ts';
import { CloudflareAppHost, readCloudflareConfig, type CloudflareEnv } from '../adapters/cloudflare.ts';
import { AppHostError } from '../app-host.ts';
import { getPublishStatus, publishApp, rollbackApp, unpublishApp, type PublishDeps } from '../publish.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';
import { SecretBoxError, keyringFromEnv, type Keyring } from '../secret-box.ts';

/**
 * Publishing (Publish programme stage 4).
 *
 *   GET  /projects/:projectId/publish            what is live, what the latest
 *                                                checked build needs, the
 *                                                approval intent to record
 *   POST /projects/:projectId/publish            { outputId, slug? } — owner;
 *                                                needs the recorded approval
 *   POST /projects/:projectId/publish/unpublish  owner
 *   POST /projects/:projectId/publish/rollback   { outputId } — owner; needs
 *                                                the recorded approval
 *
 * Without the owner inputs (Cloudflare account values + APPS_DOMAIN) the
 * status says so in plain words and every write is a 503.
 */

type Env = AuthEnv & Partial<CloudflareEnv> & { APPS_DOMAIN?: string; APP_SECRETS_KEYS?: string };

const NO_STORE = { 'cache-control': 'no-store' } as const;
const NOT_SET_UP = "Publishing isn't set up on this Caddie server yet.";

export interface PublishRouterOptions {
	/** Production: the verified session + membership. Tests substitute a resolver over the same rows. */
	scopeFor?: (env: Env, request: Request, projectId: string) => Promise<Scope>;
	/** Production: Cloudflare from env. Tests pass an adapter pointed at the local stub. */
	depsFor?: (env: Env) => Promise<PublishDeps | null>;
}

const sessionScope = (env: Env, request: Request, projectId: string) => requireProjectScope(env.DB, env, request.headers, projectId);

const APPS_DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function appsDomainOf(env: Env): string | null {
	const domain = (env.APPS_DOMAIN ?? '').trim().toLowerCase().replace(/\.+$/, '');
	return APPS_DOMAIN.test(domain) ? domain : null;
}

async function keyringOrNull(env: Env): Promise<Keyring | null> {
	if (!(env.APP_SECRETS_KEYS ?? '').trim()) return null;
	try {
		return await keyringFromEnv(env);
	} catch (error) {
		if (error instanceof SecretBoxError) {
			console.error('publish: APP_SECRETS_KEYS unusable:', error.code);
			return null;
		}
		throw error;
	}
}

/** GET a live URL from Caddie's Worker; the status, or 0 when nothing answered. */
async function probe(url: string): Promise<number> {
	try {
		const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Caddie publish check' } });
		await response.body?.cancel().catch(() => undefined);
		return response.status;
	} catch {
		return 0;
	}
}

async function envDeps(env: Env): Promise<PublishDeps | null> {
	const appsDomain = appsDomainOf(env);
	if (!appsDomain) return null;
	let host: CloudflareAppHost;
	try {
		host = new CloudflareAppHost(readCloudflareConfig(env));
	} catch (error) {
		if (error instanceof AppHostError && error.code === 'NOT_CONFIGURED') return null;
		throw error;
	}
	return { host, appsDomain, keyring: await keyringOrNull(env), probe };
}

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) return { status: error.status, body: { error: error.code, message: error.message } };
	console.error('unhandled publish route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
		throw new ScopeError(415, 'invalid_request', 'send JSON');
	}
	const text = await request.text();
	if (text.length > 4096) throw new ScopeError(413, 'invalid_input', 'body too large');
	if (text.trim() === '') return {};
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ScopeError(400, 'invalid_input', 'body must be an object');
	return body as Record<string, unknown>;
}

export function createPublishRouter(options: PublishRouterOptions = {}): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	const scopeFor = options.scopeFor ?? sessionScope;
	const depsFor = options.depsFor ?? envDeps;

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500, NO_STORE);
	});

	async function requireDeps(env: Env): Promise<PublishDeps> {
		const deps = await depsFor(env);
		if (!deps) throw new ScopeError(503, 'publishing_unavailable', NOT_SET_UP);
		return deps;
	}

	async function status(env: Env, scope: Scope) {
		const deps = await depsFor(env);
		return getPublishStatus(env.DB, { appsDomain: deps?.appsDomain ?? null, available: deps !== null, reason: deps ? null : NOT_SET_UP }, scope);
	}

	router.get('/projects/:projectId/publish', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		return c.json(await status(c.env, scope), 200, NO_STORE);
	});

	router.post('/projects/:projectId/publish', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		const body = await readBody(c.req.raw);
		await publishApp(c.env.DB, await requireDeps(c.env), scope, { outputId: body['outputId'], slug: body['slug'] });
		return c.json(await status(c.env, scope), 200, NO_STORE);
	});

	router.post('/projects/:projectId/publish/unpublish', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		await readBody(c.req.raw);
		await unpublishApp(c.env.DB, await requireDeps(c.env), scope);
		return c.json(await status(c.env, scope), 200, NO_STORE);
	});

	router.post('/projects/:projectId/publish/rollback', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		const body = await readBody(c.req.raw);
		await rollbackApp(c.env.DB, await requireDeps(c.env), scope, { outputId: body['outputId'] });
		return c.json(await status(c.env, scope), 200, NO_STORE);
	});

	return router;
}
