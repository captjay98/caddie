import { createAuthApp } from '../../apps/app/src/server/routes/auth.ts';
import type { AuthEnv, D1Database } from '../../apps/app/src/server/auth.ts';

/**
 * Minimal local workerd fixture for P02 (REAL workerd via `wrangler dev`,
 * real local SQLite-backed D1 — never deployed).
 *
 * It mounts the exact production auth composition (createAuthApp — the same
 * router app.ts mounts at /api) and adds /__test/* control routes used only
 * by tests/project-isolation.integration.test.ts to prepare the database and
 * assert on rows. These control routes are NOT part of the app Worker.
 * The projects router is mounted by this fixture from P02 slice 3 onward.
 */

interface FixtureEnv extends AuthEnv {
	[key: string]: unknown;
}

async function d1All(db: D1Database, sql: string): Promise<{ results: unknown[] }> {
	const res = await db.prepare(sql).all();
	return { results: (res.results ?? []) as unknown[] };
}

const authApp = createAuthApp();

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
		return authApp.fetch(request, env);
	},
};
