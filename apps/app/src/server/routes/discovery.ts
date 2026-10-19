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
	evaluateCandidate,
	candidateDetail,
	checkCandidateEligibility,
	listCandidateEvaluations,
	listCandidates,
	listFeedRuns,
} from '../discovery.ts';
import { getProfile } from '../profiles.ts';
import { digestProfileFrom } from '../candidate-inspection.ts';
import { discoverForActor } from '../coordinator-context.ts';
import { buildHackathonResultsCard } from '../hackathon-card.ts';
import { admitJudgeDiscovery } from '../judge-limits.ts';

/**
 * Background hook for work that must not delay the response. In a Worker it
 * is `executionCtx.waitUntil`, so the work outlives the response; Hono throws
 * when there is no execution context (tests, other runtimes), and then the
 * work simply runs unawaited.
 */
function backgroundFor(c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } }): (task: Promise<unknown>) => void {
	try {
		const ctx = c.executionCtx;
		return (task) => ctx.waitUntil(task);
	} catch {
		return (task) => void task;
	}
}

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

/** The Nebius key drives rules reading and the AI fit check on a live sweep. */
type Env = AuthEnv & { NEBIUS_API_KEY?: string; TAVILY_API_KEY?: string };

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
	// Discover and the chat share ONE pipeline (discoverForActor): Devpost's
	// open-contests API first, Tavily for the other platforms (and as Devpost
	// backup), the top events' rules pages read via Tavily for quoted
	// eligibility, then the AI fit check. A failed source is a VISIBLE named
	// feed gap, never a silent empty list. Personal eligibility reads the
	// ACTOR'S OWN P14 profile — resolved from the verified session, never from
	// a body field — and stays honest about what it used (profileCountry).

	/** How many ranked events Discover lists (the page folds all but the first dozen). */
	const DISCOVER_LIMIT = 50;

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
		// S07 judge limits: this is a live paid sweep (Tavily + Nebius), so a
		// judge's rolling-24h discovery budget is spent HERE, before any work.
		await admitJudgeDiscovery(c.env.DB, scope.actorId, c.env);
		// "Check again": the full live sweep, exactly what the chat runs (paid
		// Tavily + Nebius calls, bounded inside discoverForActor).
		await discoverForActor(c.env.DB, scope, { refresh: true, limit: DISCOVER_LIMIT }, {
			tavilyApiKey: c.env.TAVILY_API_KEY,
			nebiusApiKey: c.env.NEBIUS_API_KEY,
			// Digest pre-warm finishes after the response (Workers waitUntil).
			background: backgroundFor(c),
		});
		const [feed] = await listFeedRuns(c.env.DB, scope);
		return c.json({ feed }, 201);
	});

	// Deliberately NOT judge-limited: the GETs below read stored rows (feed
	// history, candidates, one candidate, the detail pane, the cached digest);
	// none runs a live Tavily/Nebius call, so none spends money per click. Only
	// the two POSTs that DO — this feed refresh and check-eligibility below —
	// are capped. Do not add a limit to a GET.
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
			// `card` is the same ranked, filtered, rules-checked view the chat
			// renders, re-ranked from the stored catalog — no live sweep and no
			// paid call on a page load. `evaluations` stays for older readers.
			const [evaluated, result] = await Promise.all([
				listCandidateEvaluations(c.env.DB, scope, profile),
				discoverForActor(c.env.DB, scope, { refresh: false, limit: DISCOVER_LIMIT }, { inspect: false }),
			]);
			return c.json({ ...evaluated, card: buildHackathonResultsCard(result) });
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

	// Detail pane: evaluation + grouped verbatim rules + a fail-soft AI digest.
	// `?digest=defer` returns the rules immediately (digestPending on a cache
	// miss); the pane then calls `/digest` for the slow model call.
	router.get('/projects/:projectId/discovery/candidates/:candidateId/detail', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const stored = await getProfile(c.env.DB, userId);
		return c.json(
			await candidateDetail(
				c.env.DB,
				scope,
				c.req.param('candidateId') ?? '',
				{ country: stored?.country ?? null },
				c.env.NEBIUS_API_KEY,
				digestProfileFrom(stored),
				{ deferDigest: c.req.query('digest') === 'defer' },
			),
		);
	});

	// The deferred AI digest for the detail pane (the slow model call), split
	// out so the rules render while it runs. Same scope/auth as /detail.
	router.get('/projects/:projectId/discovery/candidates/:candidateId/digest', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const stored = await getProfile(c.env.DB, userId);
		const detail = await candidateDetail(
			c.env.DB,
			scope,
			c.req.param('candidateId') ?? '',
			{ country: stored?.country ?? null },
			c.env.NEBIUS_API_KEY,
			digestProfileFrom(stored),
		);
		return c.json({ digest: detail.digest, digestGap: detail.digestGap });
	});

	// On-demand "Check eligibility": read ONE candidate's rules page now, then
	// re-evaluate. Paid Tavily + Nebius calls, bounded to a single page.
	router.post('/projects/:projectId/discovery/candidates/:candidateId/check-eligibility', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		// S07 judge limits: paid Tavily + Nebius calls, so the discovery budget
		// is spent here, before the single-page read.
		await admitJudgeDiscovery(c.env.DB, scope.actorId, c.env);
		const profile = await actorEligibilityProfile(c.env, c.req.raw.headers);
		return c.json(
			await checkCandidateEligibility(c.env.DB, scope, c.req.param('candidateId') ?? '', profile, {
				tavilyApiKey: c.env.TAVILY_API_KEY,
				nebiusApiKey: c.env.NEBIUS_API_KEY,
			}),
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
