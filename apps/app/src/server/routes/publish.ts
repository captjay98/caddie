import { Hono } from 'hono';
import type { Scope } from '@caddie/contracts';
import type { AuthEnv } from '../auth.ts';
import { advanceSafetyChecks, getPublishStatus, publishApp, rollbackApp, unpublishApp, type PublishDeps } from '../publish.ts';
import { publishDepsFromEnv, type PublishEnv } from '../publish-env.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';

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

type Env = AuthEnv & PublishEnv;

const NO_STORE = { 'cache-control': 'no-store' } as const;
const NOT_SET_UP = "Publishing isn't set up on this Caddie server yet.";

export interface PublishRouterOptions {
	/** Production: the verified session + membership. Tests substitute a resolver over the same rows. */
	scopeFor?: (env: Env, request: Request, projectId: string) => Promise<Scope>;
	/** Production: Cloudflare from env. Tests pass an adapter pointed at the local stub. */
	depsFor?: (env: Env) => Promise<PublishDeps | null>;
}

const sessionScope = (env: Env, request: Request, projectId: string) => requireProjectScope(env.DB, env, request.headers, projectId);
const envDeps = (env: Env) => publishDepsFromEnv(env);

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
		// A status read is also a nudge: settle this project's pending safety check if the scan is done.
		if (deps) await advanceSafetyChecks(env.DB, deps, { projectId: scope.projectId, limit: 1 });
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
