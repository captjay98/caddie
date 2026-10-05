import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { ScopeError, sessionUserId } from '../scope.ts';
import {
	getApprovalById,
	getApprovalForActor,
	recordDecision,
	requestApproval,
	revokeApproval,
} from '../approvals.ts';

/**
 * P03 approvals router. Two surfaces with deliberately different authority:
 *
 *   /api/approvals                     authenticated USER surface
 *     POST   /api/approvals            record a decision (approved|rejected);
 *                                      decidedBy is ALWAYS the session-derived
 *                                      actor — no input can name one
 *     GET    /api/approvals/:id        read (project membership required)
 *     POST   /api/approvals/:id/revoke revoke a pending/approved record
 *
 *   /api/agents-bridge/approvals       agent surface — REQUEST + READ only
 *     POST   /api/agents-bridge/approvals      request approval (creates PENDING)
 *     GET    /api/agents-bridge/approvals/:id  read
 *     NO decide route exists on this surface: agents can never approve their own
 *     plan (audit defect #4). Requests without a session; a pending record
 *     grants no authority until a session-verified owner decides it.
 *
 * Typed ScopeErrors map to `{ error: code, message }` with their status via the
 * router-level onError; anything else is a 500 without internals.
 *
 * Exports:
 *   - createApprovalsRouter(): the /api-mounted approvals routes (app.ts composes
 *     this next to the auth and projects routers).
 *   - createControlsApp(): the full /api composition (auth + projects +
 *     approvals) — the same mount app.ts uses, wrapped for the local workerd
 *     fixture and tests.
 */

type Env = AuthEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled approvals route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function requireSessionActorId(env: Env, headers: Headers): Promise<string> {
	const userId = await sessionUserId(env, headers);
	if (!userId) {
		throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
	}
	return userId;
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
}

export function createApprovalsRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- authenticated user surface -------------------------------------------------
	router.post('/approvals', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const approval = await recordDecision(c.env.DB, actorId, await readJson(c.req.raw));
		return c.json({ approval });
	});

	router.get('/approvals/:approvalId', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const approval = await getApprovalForActor(c.env.DB, actorId, c.req.param('approvalId'));
		return c.json({ approval });
	});

	router.post('/approvals/:approvalId/revoke', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const approval = await revokeApproval(c.env.DB, actorId, c.req.param('approvalId'));
		return c.json({ approval });
	});

	// --- agent surface: REQUEST + READ ONLY (no decide route exists) ------------------
	router.post('/agents-bridge/approvals', async (c) => {
		const approval = await requestApproval(c.env.DB, await readJson(c.req.raw));
		return c.json({ approval }, 201);
	});

	router.get('/agents-bridge/approvals/:approvalId', async (c) => {
		const approval = await getApprovalById(c.env.DB, c.req.param('approvalId'));
		return c.json({ approval });
	});

	return router;
}

/**
 * The full /api composition — the auth router, the P02 projects router and the
 * P03 approvals router — exactly the mount app.ts uses. The local workerd
 * fixture wraps this to add its /__test control routes.
 */
export function createControlsApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createApprovalsRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
