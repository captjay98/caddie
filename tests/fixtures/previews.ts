import { createPreviewsApp } from '../../apps/app/src/server/routes/previews.ts';
import { markStaleForPlan } from '../../apps/app/src/server/artifacts.ts';
import type { AuthEnv, D1Database } from '../../apps/app/src/server/auth.ts';

/**
 * Minimal local workerd fixture for P07 (REAL workerd via `wrangler dev`,
 * real local SQLite-backed D1 — never deployed).
 *
 * It mounts the exact production composition shape app.ts will use at /api
 * (createPreviewsApp — auth router + P02 projects router + P07 artifacts
 * router + P07 previews router) and adds /__test/* control routes used only
 * by tests/preview-access.integration.test.ts to prepare the database and
 * drive the system-side markStaleForPlan hook. These control routes are NOT
 * part of the app Worker.
 *
 * Like the other fixtures, this entry imports only the app's own composition
 * exports — resolving hono from tests/ would escape the app package's
 * node_modules and fail wrangler's bundler.
 */

interface FixtureEnv extends AuthEnv {
	[key: string]: unknown;
}

async function d1All(db: D1Database, sql: string): Promise<{ results: unknown[] }> {
	const res = await db.prepare(sql).all();
	return { results: (res.results ?? []) as unknown[] };
}

const apiApp = createPreviewsApp();

export default {
	async fetch(request: Request, env: FixtureEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__test/health') {
			try {
				await d1All(env.DB, 'select 1 as one');
				return Response.json({ ok: true, d1: true, betterAuthUrl: env.BETTER_AUTH_URL ?? null });
			} catch (error) {
				return Response.json({ ok: false, error: String(error) }, { status: 500 });
			}
		}
		if (url.pathname === '/__test/ddl' && request.method === 'POST') {
			const body = (await request.json()) as { statements?: string[] };
			try {
				for (const statement of body.statements ?? []) {
					await env.DB.prepare(statement).run();
				}
				return Response.json({ applied: (body.statements ?? []).length });
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}
		if (url.pathname === '/__test/d1' && request.method === 'POST') {
			const body = (await request.json()) as { sql?: string };
			if (!body.sql) return Response.json({ error: 'sql required' }, { status: 400 });
			try {
				return Response.json(await d1All(env.DB, body.sql));
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}
		if (url.pathname === '/__test/mark-stale' && request.method === 'POST') {
			// Fixture-only driver for the SYSTEM hook (no actor, no scope by
			// design — see markStaleForPlan). The real caller is the plan
			// revision write path (P11 integration).
			try {
				const body = (await request.json()) as {
					projectId?: unknown;
					newPlanRevision?: unknown;
				};
				const result = await markStaleForPlan(
					env.DB,
					typeof body.projectId === 'string' ? body.projectId : '',
					typeof body.newPlanRevision === 'number' ? body.newPlanRevision : Number.NaN,
				);
				return Response.json(result);
			} catch (error) {
				const status = (error as { status?: number }).status ?? 500;
				return Response.json(
					{ error: (error as { code?: string }).code ?? 'internal_error' },
					{ status },
				);
			}
		}
		return apiApp.fetch(request, env);
	},
};
