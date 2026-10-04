import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { getAuth } from '../auth.ts';

/**
 * P01 auth router: the composition surface mounted at /api.
 *
 *   GET  /api/auth/status   app-owned session probe -> { authenticated }
 *   ALL  /api/auth/*        Better Auth handler (sign-in/social, callback,
 *                           get-session, sign-out, link-social, ...)
 *
 * The mount point and the JSON `{ authenticated }` shape are the frozen
 * composition contract: the P00 stub returned { authenticated: false } for
 * /api/auth/status and this router returns exactly that for every caller
 * without a valid session — including deployments where auth is not yet
 * configured or the schema is not applied. That is fail-closed: the probe
 * never claims an authenticated session it could not verify. Auth endpoints
 * (sign-in, callback, ...) surface a 503 instead so misconfiguration is
 * loud where it matters, and the SPA can show its error/retry state.
 */
export function createAuthRouter(): Hono<{ Bindings: AuthEnv }> {
	const router = new Hono<{ Bindings: AuthEnv }>();

	router.get('/auth/status', async (c) => {
		if (!authConfigured(c.env)) return c.json({ authenticated: false });
		try {
			const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
			return c.json({ authenticated: Boolean(session?.session) });
		} catch (error) {
			// Fail closed: an unverifiable session is reported as unauthenticated.
			// The sign-in endpoints below surface the cause loudly instead.
			console.error('auth: session probe failed:', error);
			return c.json({ authenticated: false });
		}
	});

	router.all('/auth/*', async (c) => {
		if (!authConfigured(c.env)) {
			return c.json(
				{
					error: 'auth_not_configured',
					message:
						'BETTER_AUTH_SECRET and BETTER_AUTH_URL are required. See docs/setup/auth.md; auth never derives secrets from model/API keys.',
				},
				503,
			);
		}
		return getAuth(c.env).handler(c.req.raw);
	});

	return router;
}

/**
 * Convenience root app with the auth router mounted at /api — the same
 * composition app.ts uses. Used by the local workerd test fixture, which
 * cannot import Hono itself (it lives outside the app workspace).
 */
export function createAuthApp(): Hono<{ Bindings: AuthEnv }> {
	const app = new Hono<{ Bindings: AuthEnv }>();
	app.route('/api', createAuthRouter());
	return app;
}

function authConfigured(env: Pick<AuthEnv, 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL'>): boolean {
	return Boolean(env.BETTER_AUTH_SECRET?.trim() && env.BETTER_AUTH_URL?.trim());
}
