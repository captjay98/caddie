import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';
import { projectBrief } from '../brief.ts';

/**
 * UI review board phase 2 — the brief feed route. One GET reads the
 * project's real state (approvals, retained conflicts, stale artifacts,
 * failed rounds, armed schedules) and returns decision-card shapes. The scope
 * is derived server-side from the verified session + membership, exactly the
 * P02/P10 pattern; the service layer re-verifies against D1 at entry.
 */

type Env = AuthEnv;

export function createBriefRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		if (error instanceof ScopeError) {
			return c.json({ error: error.code, message: error.message }, error.status as 500);
		}
		console.error('unhandled brief route error:', error);
		return c.json({ error: 'internal_error' }, 500);
	});

	router.get('/projects/:projectId/brief', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ cards: await projectBrief(c.env.DB, scope) });
	});

	return router;
}