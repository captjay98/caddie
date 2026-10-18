import { Hono } from 'hono';
import type { Scope } from '@caddie/contracts';
import type { AuthEnv } from '../auth.ts';
import { appAiDepsFromEnv, getAppAiUsage, type AppAiDeps } from '../app-ai.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';

/**
 * AI inside apps (Publish programme stage 9).
 *
 *   GET /projects/:projectId/ai-usage   this month's AI use against the app's
 *                                       allowance: calls, percent used, whether
 *                                       it ran out, when it renews. No money,
 *                                       model names or tokens.
 */

type Env = AuthEnv & { NEBIUS_API_KEY?: string; APP_AI_MONTHLY_LIMIT_CENTS?: string };

export interface AppAiRouterOptions {
	scopeFor?: (env: Env, request: Request, projectId: string) => Promise<Scope>;
	depsFor?: (env: Env) => AppAiDeps;
}

export function createAppAiRouter(options: AppAiRouterOptions = {}): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	const scopeFor = options.scopeFor ?? ((env: Env, request: Request, projectId: string) => requireProjectScope(env.DB, env, request.headers, projectId));
	const depsFor = options.depsFor ?? appAiDepsFromEnv;

	router.onError((error, c) => {
		if (error instanceof ScopeError) return c.json({ error: error.code, message: error.message }, error.status as 400, { 'cache-control': 'no-store' });
		console.error('unhandled ai-usage route error:', error);
		return c.json({ error: 'internal_error' }, 500, { 'cache-control': 'no-store' });
	});

	router.get('/projects/:projectId/ai-usage', async (c) => {
		const scope = await scopeFor(c.env, c.req.raw, c.req.param('projectId'));
		return c.json(await getAppAiUsage(c.env.DB, depsFor(c.env), scope), 200, { 'cache-control': 'no-store' });
	});
	return router;
}
