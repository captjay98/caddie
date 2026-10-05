import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';
import {
	listSources,
	registerSource,
	updateSource,
	captureSnapshot,
	listSnapshots,
	getSnapshot,
	captureFromUrl,
	type FetchPolicyEnv,
} from '../evidence/sources.ts';
import {
	addClaim,
	getClaim,
	listClaimsWithEvidence,
	surveyClaims,
} from '../evidence/claims.ts';
import { deadlineInstantKey, normalizeDeadline } from '../evidence/deadlines.ts';

/**
 * P10 evidence router — per-project sources / snapshots / claims CRUD-lite +
 * reconciliation survey + deadline normalization, all scope-checked through
 * the P02 patterns: every route derives its Scope server-side from the
 * verified session + membership (never the body) and the service layer
 * re-verifies the scope against D1 at entry. Typed ScopeErrors map to
 * `{ error: code, message }` with their status via the router-level onError.
 *
 * Fetch policy note: the capture-url route fetches through
 * {@link captureFromUrl}'s ALLOWED-URL policy with the WORKER's env carrying
 * the owner-authorization signal (CADDIE_LIVE_AUTHORIZED). Without it every
 * external fetch is BLOCKED and private networks are always refused.
 */

type Env = AuthEnv & { CADDIE_LIVE_AUTHORIZED?: string };

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled evidence route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
}

function fetchPolicyEnv(env: Env): FetchPolicyEnv {
	return { CADDIE_LIVE_AUTHORIZED: env.CADDIE_LIVE_AUTHORIZED };
}

export function createEvidenceRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- sources ---------------------------------------------------------------
	router.post('/projects/:projectId/evidence/sources', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const source = await registerSource(c.env.DB, scope, (await readJson(c.req.raw)) as never);
		return c.json({ source }, 201);
	});

	router.get('/projects/:projectId/evidence/sources', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ sources: await listSources(c.env.DB, scope) });
	});

	router.patch('/projects/:projectId/evidence/sources/:sourceId', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const source = await updateSource(
			c.env.DB,
			scope,
			c.req.param('sourceId') ?? '',
			(await readJson(c.req.raw)) as never,
		);
		return c.json({ source });
	});

	// --- snapshots ---------------------------------------------------------------
	router.post('/projects/:projectId/evidence/sources/:sourceId/snapshots', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const captured = await captureSnapshot(
			c.env.DB,
			scope,
			c.req.param('sourceId') ?? '',
			(await readJson(c.req.raw)) as never,
		);
		return c.json({ snapshot: captured.snapshot, outcome: captured.outcome }, 201);
	});

	router.get('/projects/:projectId/evidence/sources/:sourceId/snapshots', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({
			snapshots: await listSnapshots(c.env.DB, scope, c.req.param('sourceId') ?? ''),
		});
	});

	// Fetch through the ALLOWED-URL policy and archive the response (slice 3).
	router.post('/projects/:projectId/evidence/sources/:sourceId/capture-url', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const captured = await captureFromUrl(
			c.env.DB,
			scope,
			c.req.param('sourceId') ?? '',
			(await readJson(c.req.raw)) as never,
			{ env: fetchPolicyEnv(c.env) },
		);
		return c.json({ snapshot: captured.snapshot, outcome: captured.outcome }, 201);
	});

	router.get('/projects/:projectId/evidence/snapshots/:snapshotId', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ snapshot: await getSnapshot(c.env.DB, scope, c.req.param('snapshotId') ?? '') });
	});

	// --- claims --------------------------------------------------------------------
	router.post('/projects/:projectId/evidence/claims', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const claim = await addClaim(c.env.DB, scope, (await readJson(c.req.raw)) as never);
		return c.json({ claim }, 201);
	});

	router.get('/projects/:projectId/evidence/claims', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const claimType = c.req.query('claimType');
		const sourceId = c.req.query('sourceId');
		const claims = await listClaimsWithEvidence(c.env.DB, scope, {
			claimType: claimType || undefined,
			sourceId: sourceId || undefined,
		});
		return c.json({ claims });
	});

	router.get('/projects/:projectId/evidence/claims/:claimId', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ claim: await getClaim(c.env.DB, scope, c.req.param('claimId') ?? '') });
	});

	// Reconciliation view: winners + RETAINED conflicts per claim type.
	router.get('/projects/:projectId/evidence/conflicts', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const claimType = c.req.query('claimType');
		const surveys = await surveyClaims(c.env.DB, scope, {
			claimType: claimType || undefined,
			instantKey: (claim) => deadlineInstantKey(claim.value),
		});
		return c.json({ surveys });
	});

	// --- deadline normalization (pure; exposed for the inspector) ----------------------
	router.post('/projects/:projectId/evidence/deadlines/normalize', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const body = (await readJson(c.req.raw)) as { text?: unknown; zone?: unknown };
		const normalized = normalizeDeadline(
			typeof body.text === 'string' ? body.text : '',
			typeof body.zone === 'string' ? body.zone : null,
		);
		// scope is verified but unused beyond authorization — normalization is pure
		void scope;
		return c.json({ normalized });
	});

	return router;
}

/**
 * The full /api composition for the evidence fixture: the auth router and the
 * projects router (P02 — evidence rows hang off projects) next to the
 * evidence router — the same mount shape app.ts uses.
 */
export function createEvidenceApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createEvidenceRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
