import { Hono } from 'hono';
import type { Scope } from '@caddie/contracts';
import type { AuthEnv } from '../auth.ts';
import type { ArtifactsBinding } from '../adapters/cloudflare-artifacts.ts';
import { CodeStoreError, type CodeStore } from '../code-store.ts';
import { codeStoreFor } from '../code-store-env.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';
import { listVersions, restoreVersion } from '../version-restore.ts';

/**
 * Versions (Publish programme stage 1).
 *
 *   GET  /projects/:projectId/versions                     every checked version, newest first
 *   POST /projects/:projectId/versions/:commitId/restore   { key } — owner; the version becomes
 *                                                          the app you try (and can publish)
 */

type Env = AuthEnv & { ARTIFACTS?: ArtifactsBinding };

export interface VersionsRouterOptions {
	scopeFor?: (env: Env, request: Request, projectId: string) => Promise<Scope>;
	storeFor?: (env: Env) => CodeStore;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) return { status: error.status, body: { error: error.code, message: error.message } };
	if (error instanceof CodeStoreError) {
		console.error('versions: code store failure:', error.code, error.message);
		return { status: error.status >= 500 ? 502 : error.status, body: { error: error.code, message: "Caddie couldn't read the saved versions just now. Try again." } };
	}
	console.error('unhandled versions route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

export function createVersionsRouter(options: VersionsRouterOptions = {}): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	const scopeFor = options.scopeFor ?? ((env: Env, request: Request, projectId: string) => requireProjectScope(env.DB, env, request.headers, projectId));
	const storeFor = options.storeFor ?? ((env: Env) => codeStoreFor(env));

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500, NO_STORE);
	});

	router.get('/projects/:projectId/versions', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		return c.json(await listVersions(c.env.DB, scope), 200, NO_STORE);
	});

	router.post('/projects/:projectId/versions/:commitId/restore', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new ScopeError(415, 'invalid_request', 'send JSON');
		let body: { key?: unknown };
		try {
			body = (await c.req.json()) as { key?: unknown };
		} catch {
			throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
		}
		const snapshot = await restoreVersion(c.env.DB, storeFor(c.env), scope, { commitId: c.req.param('commitId'), key: body?.key });
		return c.json({ restored: true, ...snapshot }, 200, NO_STORE);
	});

	return router;
}
