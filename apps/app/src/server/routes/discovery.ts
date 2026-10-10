import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { createEvidenceRouter } from './evidence.ts';
import { ScopeError, requireProjectScope, sessionUserId } from '../scope.ts';
import { generatePlan, getPlanOverview, recordUserPlanRevision } from '../planning.ts';
import {
	acceptCandidate,
	listSavedCandidates,
	saveCandidate,
	unsaveCandidate,
	createLocalSeedAdapter,
	evaluateCandidate,
	listCandidateEvaluations,
	listCandidates,
	listFeedRuns,
	runDiscoveryFeed,
} from '../discovery.ts';
import { getProfile } from '../profiles.ts';

/**
 * P11 discovery/planning router — per-project planning endpoints (slice 2)
 * and discovery candidate endpoints (slice 3), all scope-checked through the
 * P02 patterns: every route derives its Scope server-side from the verified
 * session + membership (never the body) and the service layer re-verifies the
 * scope against D1 at entry. Typed ScopeErrors map to
 * `{ error: code, message }` with their status via the router-level onError.
 *
 * Exports:
 *   - createDiscoveryRouter(): the /api-mounted P11 routes (app.ts composes
 *     this next to the other routers).
 *   - createDiscoveryApp(): the full /api composition (auth + projects +
 *     evidence + discovery) — the mount shape the local workerd fixture uses;
 *     the evidence router rides along because discovery fit/eligibility read
 *     P10 claims.
 */

type Env = AuthEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled discovery route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
}

export function createDiscoveryRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- planning (slice 2) ------------------------------------------------------
	router.post('/projects/:projectId/planning/generate', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const result = await generatePlan(c.env.DB, scope, (await readJson(c.req.raw)) as never);
		return c.json({ result }, 201);
	});

	router.get('/projects/:projectId/planning/plan', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json(await getPlanOverview(c.env.DB, scope));
	});

	// A USER-authored plan-doc revision (edit-one-section). Provenance 'user'
	// — planning preserves it on the next generate.
	router.post('/projects/:projectId/planning/plan-docs', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const revision = await recordUserPlanRevision(c.env.DB, scope, (await readJson(c.req.raw)) as never);
		return c.json({ revision }, 201);
	});

	// --- discovery candidates (slice 3) ---------------------------------------------
	//
	// The feed runs the LOCAL seed adapter (the pluggable local implementation;
	// a real Devpost adapter is P17 live wiring). Personal eligibility reads the
	// ACTOR'S OWN P14 profile — resolved from the verified session, never from
	// a body field — and stays honest about what it used (profileCountry).

	async function actorEligibilityProfile(
		env: Env,
		headers: Headers,
	): Promise<{ country: string | null }> {
		const userId = await sessionUserId(env, headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const profile = await getProfile(env.DB, userId);
		return { country: profile?.country ?? null };
	}

	router.post('/projects/:projectId/discovery/feed', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const feed = await runDiscoveryFeed(c.env.DB, scope, {
			adapters: [createLocalSeedAdapter(c.env.DB)],
		});
		return c.json({ feed }, 201);
	});

	router.get('/projects/:projectId/discovery/feed', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ runs: await listFeedRuns(c.env.DB, scope) });
	});

	router.get('/projects/:projectId/discovery/candidates', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		if (c.req.query('evaluate') === '1') {
			const profile = await actorEligibilityProfile(c.env, c.req.raw.headers);
			return c.json(await listCandidateEvaluations(c.env.DB, scope, profile));
		}
		return c.json({ candidates: await listCandidates(c.env.DB, scope) });
	});

	router.get('/projects/:projectId/discovery/candidates/:candidateId', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const profile = await actorEligibilityProfile(c.env, c.req.raw.headers);
		return c.json(
			await evaluateCandidate(c.env.DB, scope, c.req.param('candidateId') ?? '', profile),
		);
	});

	router.post('/projects/:projectId/discovery/candidates/:candidateId/accept', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const candidate = await acceptCandidate(c.env.DB, scope, c.req.param('candidateId') ?? '');
		return c.json({ candidate });
	});

	// B01 — saved hackathons: bookmark without accepting; DELETE unsaves;
	// GET lists the project's shortlist. Never creates a project or a run.
	router.post('/projects/:projectId/discovery/candidates/:candidateId/save', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const candidate = await saveCandidate(c.env.DB, scope, c.req.param('candidateId') ?? '');
		return c.json({ candidate });
	});

	router.delete('/projects/:projectId/discovery/candidates/:candidateId/save', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const candidate = await unsaveCandidate(c.env.DB, scope, c.req.param('candidateId') ?? '');
		return c.json({ candidate });
	});

	router.get('/projects/:projectId/discovery/saved', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ candidates: await listSavedCandidates(c.env.DB, scope) });
	});

	return router;
}

/**
 * The full /api composition for the P11 fixture: auth + projects + evidence
 * + discovery — the same mount shape app.ts uses for these routers.
 */
export function createDiscoveryApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createEvidenceRouter());
	app.route('/api', createDiscoveryRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
