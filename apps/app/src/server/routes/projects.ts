import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { listPlanDecisions, listProjectPlanDecisions, recordPlanDecision } from '../planning.ts';
import { ScopeError, requireProjectScope, requireWorkspaceScope, sessionUserId } from '../scope.ts';
import {
	archiveProject,
	createArtifactRevision,
	createPlanDocRevision,
	createProject,
	createRunBinding,
	createWorkspace,
	ensureHomeProject,
	getProject,
	getRunBinding,
	listArtifactRevisions,
	listPlanDocRevisions,
	listProjectsForActor,
	listProjectsInWorkspace,
	listRunBindings,
	updateProject,
} from '../projects.ts';

/**
 * P02 projects router — every route derives its Scope server-side from the
 * verified session + membership (never from the body) and delegates to the
 * service layer, which re-verifies the scope at entry. Typed ScopeErrors map
 * to `{ error: code, message }` with their status via the router-level
 * onError; anything else is a 500 without internals.
 *
 * Exports:
 *   - createProjectsRouter(): the /api-mounted project routes (app.ts composes
 *     this next to the auth router).
 *   - createProjectsApp(): the full /api composition (auth + projects) — the
 *     same mount app.ts uses, wrapped for the local workerd fixture and tests.
 */

type Env = AuthEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled projects route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function requireSessionActorId(env: Env, headers: Headers): Promise<string> {
	const userId = await sessionUserId(env, headers);
	if (!userId) {
		throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
	}
	return userId;
}

/** Parse a JSON body, mapping malformed JSON to a 400 (client error class). */
async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
}

/** Validate an addressing field before it reaches scope derivation (400, not 403). */
function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new ScopeError(400, 'invalid_request', `${field} is required`);
	}
	return value;
}

export function createProjectsRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- workspaces -----------------------------------------------------------
	router.get('/home-project', async (c) => {
		const userId = await requireSessionActorId(c.env, c.req.raw.headers);
		const project = await ensureHomeProject(c.env.DB, userId);
		return c.json({ project }, 200);
	});

	router.post('/workspaces', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const workspace = await createWorkspace(c.env.DB, actorId, await readJson(c.req.raw));
		return c.json({ workspace }, 201);
	});

	// --- projects ---------------------------------------------------------------
	router.post('/projects', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const body = await readJson(c.req.raw);
		const workspaceId = requireNonEmptyString(
			(body as { workspaceId?: unknown })?.workspaceId,
			'workspaceId',
		);
		const scope = await requireWorkspaceScope(c.env.DB, c.env, c.req.raw.headers, workspaceId);
		const project = await createProject(c.env.DB, { actorId, workspaceId }, body, c.env);
		return c.json({ project }, 201);
	});

	router.get('/projects', async (c) => {
		const workspaceId = c.req.query('workspaceId');
		if (workspaceId) {
			const scope = await requireWorkspaceScope(c.env.DB, c.env, c.req.raw.headers, workspaceId);
			return c.json({ projects: await listProjectsInWorkspace(c.env.DB, scope) });
		}
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		return c.json({ projects: await listProjectsForActor(c.env.DB, actorId) });
	});

	router.get('/projects/:projectId', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		return c.json({ project: await getProject(c.env.DB, scope) });
	});

	router.patch('/projects/:projectId', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const project = await updateProject(c.env.DB, scope, await readJson(c.req.raw));
		return c.json({ project });
	});

	router.post('/projects/:projectId/archive', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const project = await archiveProject(c.env.DB, scope);
		return c.json({ project });
	});

	// --- plan-doc revisions -------------------------------------------------------
	router.post('/projects/:projectId/plan-docs', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const revision = await createPlanDocRevision(c.env.DB, scope, await readJson(c.req.raw));
		return c.json({ revision }, 201);
	});

	router.get('/projects/:projectId/plan-docs', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const kind = c.req.query('kind');
		// Revision counters are allocated per (project, kind); without ?kind=
		// `latest` spans incomparable counters — clients should pass kind.
		const revisions = await listPlanDocRevisions(c.env.DB, scope, kind);
		return c.json({ revisions, latest: revisions[0] ?? null });
	});

	// B04 — stored plan decisions: approve / suggest-a-change persisted per
	// revision, linked to the approval id. A decision is bound to ONE
	// revision; a newer revision needs a new decision (nothing inherited).
	router.post('/projects/:projectId/plan-docs/:revisionId/decision', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const body = (await readJson(c.req.raw)) as { decision?: unknown; note?: unknown; approvalId?: unknown };
		if (body.decision !== 'approved' && body.decision !== 'changes') {
			throw new ScopeError(400, 'invalid_input', "decision must be 'approved' or 'changes'");
		}
		const decision = await recordPlanDecision(c.env.DB, scope, {
			planRevisionId: c.req.param('revisionId') ?? '',
			decision: body.decision,
			note: typeof body.note === 'string' ? body.note : null,
			approvalId: typeof body.approvalId === 'string' ? body.approvalId : null,
		});
		return c.json({ decision }, 201);
	});

	router.get('/projects/:projectId/plan-docs/:revisionId/decision', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		return c.json({ decisions: await listPlanDecisions(c.env.DB, scope, c.req.param('revisionId') ?? '') });
	});

	router.get('/projects/:projectId/plan-decisions', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		return c.json({ decisions: await listProjectPlanDecisions(c.env.DB, scope) });
	});

	// --- run bindings ----------------------------------------------------------------
	router.post('/projects/:projectId/run-bindings', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const runBinding = await createRunBinding(c.env.DB, scope, await readJson(c.req.raw));
		return c.json({ runBinding }, 201);
	});

	router.get('/projects/:projectId/run-bindings', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		return c.json({ runBindings: await listRunBindings(c.env.DB, scope) });
	});

	router.get('/projects/:projectId/run-bindings/:runId', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const runBinding = await getRunBinding(c.env.DB, scope, c.req.param('runId'));
		if (!runBinding) {
			return c.json({ error: 'run_not_found' }, 404);
		}
		return c.json({ runBinding });
	});

	// --- artifact revisions --------------------------------------------------------
	router.post('/projects/:projectId/artifacts', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const artifact = await createArtifactRevision(c.env.DB, scope, await readJson(c.req.raw));
		return c.json({ artifact }, 201);
	});

	router.get('/projects/:projectId/artifacts', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const artifactId = c.req.query('artifactId');
		return c.json({ artifacts: await listArtifactRevisions(c.env.DB, scope, artifactId) });
	});

	return router;
}

/**
 * The full /api composition — the auth router next to the projects router —
 * exactly the mount app.ts uses. The local workerd fixture wraps this to add
 * its /__test control routes.
 */
export function createProjectsApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
