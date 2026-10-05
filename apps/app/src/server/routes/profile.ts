import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { ScopeError, sessionUserId } from '../scope.ts';
import { getProfile, upsertProfile } from '../profiles.ts';

/**
 * P14 profile/memory/search router — every route derives its user id
 * server-side from the verified session (never from the body) and delegates
 * to the service layer. Typed ScopeErrors map to `{ error: code, message }`
 * with their status via the router-level onError; anything else is a 500
 * without internals.
 *
 * Exports:
 *   - createProfileRouter(): the /api-mounted P14 routes (app.ts composes
 *     this next to the auth router — proposed mount diff in the P14 notes).
 *   - createProfileApp(): the /api composition used by the local workerd
 *     fixture (tests/fixtures/profile.ts) and tests: auth router + P14
 *     router, the same shape createProjectsApp uses.
 */

/**
 * Every environment input the P14 routes read, by name. Health checks report
 * PRESENCE only — secret values are never echoed to the client or logs.
 */
export type ProfileEnv = AuthEnv & {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	CONTREE_BASE_URL?: string;
	CONTREE_API_TOKEN?: string;
	CONTREE_PROJECT_ID?: string;
};

type Env = ProfileEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled profile route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function requireSessionActorId(env: Env, headers: Headers): Promise<string> {
	const userId = await sessionUserId(env, headers);
	if (!userId) {
		throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
	}
	return userId;
}

export function createProfileRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- profile (user-scoped; no userId/projectId is ever taken from input) ---
	router.get('/profile', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const profile = await getProfile(c.env.DB, actorId);
		return c.json({ profile });
	});

	router.put('/profile', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		let body: unknown;
		try {
			body = await c.req.raw.json();
		} catch {
			throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
		}
		const profile = await upsertProfile(c.env.DB, actorId, body);
		return c.json({ profile });
	});

	return router;
}

/**
 * The full /api composition for the P14 fixture — the auth router next to the
 * P14 router, exactly the mount app.ts will use (proposed diff).
 */
export function createProfileApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProfileRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
