import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { ScopeError, requireProjectScope, sessionUserId } from '../scope.ts';
import { accountBrief, briefSummary, markBriefRead, projectBrief } from '../brief.ts';

/**
 * The brief feed routes.
 *
 *   GET  /api/projects/:projectId/brief   project-scoped decision cards
 *   GET  /api/brief                      ACCOUNT-wide brief (approved
 *                                        navigation 2026-10-09): every
 *                                        authorised project's cards with
 *                                        per-actor read state
 *   POST /api/brief/read { keys }        mark cards read (explicit action or
 *                                        mark-all-read) — read NEVER resolves
 *                                        the underlying approval/schedule/
 *                                        artifact/preview
 *
 * The scope is derived server-side from the verified session + membership,
 * exactly the P02/P10 pattern; the service layer re-verifies against D1 at
 * entry. Read state is keyed by actorId — another account can never read or
 * write another account's rows.
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

	router.get('/brief', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		return c.json(await accountBrief(c.env.DB, actorId));
	});

	// R05: the brief-in-chat summary — counts derived from the SAME accountBrief
	// so chat and the Brief destination never drift.
	router.get('/brief/summary', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		return c.json(await briefSummary(c.env.DB, actorId));
	});

	router.post('/brief/read', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const body = (await c.req.json().catch(() => null)) as { keys?: unknown } | null;
		const keys = Array.isArray(body?.keys)
			? (body.keys as unknown[]).filter((k): k is string => typeof k === 'string')
			: [];
		await markBriefRead(c.env.DB, actorId, keys);
		return c.json({ marked: keys.length });
	});

	return router;
}

async function requireSessionActorId(env: Env, headers: Headers): Promise<string> {
	const userId = await sessionUserId(env, headers);
	if (!userId) {
		throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
	}
	return userId;
}