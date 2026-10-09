import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { ScopeError, sessionUserId } from '../scope.ts';
import { getProfile, upsertProfile } from '../profiles.ts';
import { searchContent } from '../search.ts';
import {
	addMemoryFact,
	confirmMemoryFact,
	correctMemoryFact,
	listMemoryFacts,
	memoryForInjection,
	proposeMemoryFact,
	retractMemoryFact,
} from '../memory.ts';
import { STACK_CATALOG } from '../stacks.ts';

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

/** Parse a JSON body, mapping malformed JSON to a 400 (client error class). */
async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
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

	// --- memory (living builder memory; personal + project-scoped) -------------
	// Specific paths are registered before the parameterized /:id routes.

	router.get('/memory', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const projectId = c.req.query('projectId');
		const facts = await listMemoryFacts(c.env.DB, actorId, {
			...(projectId ? { projectId } : {}),
			includeRetracted: c.req.query('includeRetracted') === '1',
		});
		return c.json({ facts });
	});

	router.get('/memory/injection', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const facts = await memoryForInjection(c.env.DB, actorId, c.req.query('projectId') ?? null);
		return c.json({ facts });
	});

	router.post('/memory/proposals', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const fact = await proposeMemoryFact(c.env.DB, actorId, await readJson(c.req.raw));
		return c.json({ fact }, 201);
	});

	router.post('/memory', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const fact = await addMemoryFact(c.env.DB, actorId, await readJson(c.req.raw));
		return c.json({ fact }, 201);
	});

	router.post('/memory/:factId/confirm', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const fact = await confirmMemoryFact(c.env.DB, actorId, c.req.param('factId'));
		return c.json({ fact });
	});

	router.post('/memory/:factId/retract', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const fact = await retractMemoryFact(c.env.DB, actorId, c.req.param('factId'));
		return c.json({ fact });
	});

	router.post('/memory/:factId/correct', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const fact = await correctMemoryFact(c.env.DB, actorId, c.req.param('factId'), await readJson(c.req.raw));
		return c.json({ fact }, 201);
	});

	// --- search (permission-filtered; items AND counts stay inside scope) ------

	router.get('/search', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		const result = await searchContent(c.env.DB, actorId, c.req.query('q') ?? '', {
			limit: c.req.query('limit'),
			offset: clampedQueryNumber(c.req.query('offset')),
		});
		return c.json(result);
	});

	// --- integration health (honest presence checks; values never echoed) -------

	router.get('/integrations/health', (c) => {
		const providerConfigured = (id?: string, secret?: string) => Boolean(id && secret);
		const sandboxMissing = (
			['CONTREE_BASE_URL', 'CONTREE_API_TOKEN', 'CONTREE_PROJECT_ID'] as const
		).filter((name) => !c.env[name]);
		return c.json({
			auth: {
				// the session itself is running, so the auth core is configured;
				// providers are only reported when BOTH halves of their pair exist
				providers: {
					google: providerConfigured(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET),
					github: providerConfigured(c.env.GITHUB_CLIENT_ID, c.env.GITHUB_CLIENT_SECRET),
				},
			},
			sandbox: {
				configured: sandboxMissing.length === 0,
				// names of missing variables only — never values
				missing: sandboxMissing,
			},
		});
	});

	// --- usage & budget (audit F11/S40): the account's real spend position -----
	// Read-only: the payer limit and reservation totals the budget system
	// already enforces per run. No spending happens here; absence is honest
	// ("no budget configured"), never a fabricated number.
	router.get('/usage', async (c) => {
		const actorId = await requireSessionActorId(c.env, c.req.raw.headers);
		let payer: { payerId: string; limitMinorUnits: number; currency: string } | null = null;
		let totals = { reservedMinorUnits: 0, settledMinorUnits: 0, reservations: 0 };
		let unavailable: string | undefined;
		try {
			const payerRows = await c.env.DB.prepare(
				'select "payerId", "limitMinorUnits", "currency" from "budget_payers" where "payerId" = ?',
			)
				.bind(actorId)
				.all<{ payerId: string; limitMinorUnits: number; currency: string }>();
			const payerRow = payerRows.results?.[0];
			if (payerRow) {
				payer = {
					payerId: String(payerRow['payerId']),
					limitMinorUnits: Number(payerRow['limitMinorUnits']),
					currency: String(payerRow['currency']),
				};
			}
			const totalsRows = await c.env.DB.prepare(
				`select
					coalesce(sum(case when "status" = 'reserved' then "amountMinorUnits" else 0 end), 0) as reservedMinorUnits,
					coalesce(sum(case when "status" = 'settled' then coalesce("settledAmountMinorUnits", "amountMinorUnits") else 0 end), 0) as settledMinorUnits,
					count(*) as reservations
				from "budget_reservations" where "payerId" = ?`,
			)
				.bind(actorId)
				.all<{ reservedMinorUnits: number; settledMinorUnits: number; reservations: number }>();
			const totalsRow = totalsRows.results?.[0];
			if (totalsRow) {
				totals = {
					reservedMinorUnits: Number(totalsRow['reservedMinorUnits'] ?? 0),
					settledMinorUnits: Number(totalsRow['settledMinorUnits'] ?? 0),
					reservations: Number(totalsRow['reservations'] ?? 0),
				};
			}
		} catch {
			// Budget tables not initialised in this deployment — report honestly
			// instead of a 500 (the capability genuinely is not configured).
			unavailable = 'budget tracking is not configured in this deployment';
		}
		return c.json({ payer, totals, ...(unavailable ? { unavailable } : {}) });
	});

	// --- enabled stacks (honest, no inherited pricing or fake availability) -----

	router.get('/stacks', (c) => c.json({ stacks: STACK_CATALOG }));

	return router;
}

function clampedQueryNumber(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === '') return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * The full /api composition for the P14 fixture — the auth and projects
 * routers plus the P14 router, mirroring how app.ts will mount it (P14 is
 * added alongside the existing routers, not instead of them).
 */
export function createProfileApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createProfileRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
