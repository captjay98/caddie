import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { createEvidenceRouter } from './evidence.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';
import {
	assessCriterionEvidence,
	buildCoachingMaterials,
	extractRubric,
	listScorecards,
	recordScorecard,
	validateScoringResult,
} from '../judge.ts';
import {
	buildChecklist,
	computeRequirementsVersion,
	confirmReuse,
	createSubmissionPackage,
	exportPackage,
	getPackage,
	listPackages,
	recordConfirmation,
} from '../submission.ts';

/**
 * P13 judge + submission router (slice 3) — per-project judge coaching and
 * submission package endpoints, all scope-checked through the P02 patterns:
 * every route derives its Scope server-side from the verified session +
 * membership (never the body) and the service layer re-verifies the scope
 * against D1 at entry. Typed ScopeErrors map to `{ error: code, message }`
 * with their status via the router-level onError.
 *
 * Honesty surface:
 *   - POST scorecards validates the raw structured result against the
 *     EXTRACTED rubric and the recorded evidence; malformed results are a
 *     400 invalid_scoring, and access levels are recomputed from receipts.
 *   - The submission package routes can prepare, export and RECORD a human's
 *     confirmation — they never submit anything externally. Reuse disclosure
 *     requires a human POST before export succeeds (409 otherwise).
 *
 * Exports:
 *   - createJudgeRouter(): the /api-mounted P13 routes (app.ts composes this
 *     next to the other routers — mount PROPOSAL tracked in the P13 packet).
 *   - createJudgeApp(): the full /api composition (auth + projects + evidence
 *     + judge) — the mount shape the local workerd fixture uses; the evidence
 *     router rides along because rules and citations read P10 claims.
 */

type Env = AuthEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled judge route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
}

export function createJudgeRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- judge coaching -----------------------------------------------------------
	router.get('/projects/:projectId/judge/rubric', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json(await extractRubric(c.env.DB, scope));
	});

	router.get('/projects/:projectId/judge/assessment', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const rubric = await extractRubric(c.env.DB, scope);
		const assessment = await assessCriterionEvidence(c.env.DB, scope, rubric);
		return c.json({ rubric, assessment });
	});

	// A structured scoring result (as a model would emit) is validated against
	// the EXTRACTED rubric + recorded evidence before anything persists.
	router.post('/projects/:projectId/judge/scorecards', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const rubric = await extractRubric(c.env.DB, scope);
		const assessment = await assessCriterionEvidence(c.env.DB, scope, rubric);
		const scorecard = validateScoringResult(rubric, assessment, await readJson(c.req.raw));
		const record = await recordScorecard(c.env.DB, scope, scorecard, rubric);
		return c.json({ record }, 201);
	});

	router.get('/projects/:projectId/judge/scorecards', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ scorecards: await listScorecards(c.env.DB, scope) });
	});

	router.get('/projects/:projectId/judge/coaching', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json(await buildCoachingMaterials(c.env.DB, scope));
	});

	// --- submission package ------------------------------------------------------------
	router.get('/projects/:projectId/submission/requirements-version', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ version: await computeRequirementsVersion(c.env.DB, scope) });
	});

	router.get('/projects/:projectId/submission/packages', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ packages: await listPackages(c.env.DB, scope) });
	});

	router.post('/projects/:projectId/submission/packages', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const package_ = await createSubmissionPackage(
			c.env.DB,
			scope,
			(await readJson(c.req.raw)) as never,
		);
		return c.json({ package: package_ }, 201);
	});

	router.get('/projects/:projectId/submission/packages/:packageId', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json(
			await getPackage(c.env.DB, scope, c.req.param('packageId') ?? ''),
		);
	});

	router.post('/projects/:projectId/submission/packages/:packageId/checklist', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const items = await buildChecklist(c.env.DB, scope, c.req.param('packageId') ?? '');
		return c.json({ items }, 201);
	});

	router.post('/projects/:projectId/submission/packages/:packageId/reuse/confirm', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const package_ = await confirmReuse(c.env.DB, scope, c.req.param('packageId') ?? '');
		return c.json({ package: package_ });
	});

	router.post('/projects/:projectId/submission/packages/:packageId/exports', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const export_ = await exportPackage(c.env.DB, scope, c.req.param('packageId') ?? '');
		return c.json({ export: export_ }, 201);
	});

	// RECORDS the human's external submission — performs nothing external.
	router.post('/projects/:projectId/submission/exports/:exportId/confirmations', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const body = (await readJson(c.req.raw)) as { exportId?: string; attestations?: string[]; note?: string };
		const confirmation = await recordConfirmation(c.env.DB, scope, {
			exportId: body.exportId ?? c.req.param('exportId') ?? '',
			attestations: body.attestations ?? [],
			note: body.note ?? null,
		});
		return c.json({ confirmation }, 201);
	});

	return router;
}

/**
 * The full /api composition for the P13 fixture: auth + projects + evidence
 * + judge — the same mount shape app.ts uses for these routers.
 */
export function createJudgeApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createEvidenceRouter());
	app.route('/api', createJudgeRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
