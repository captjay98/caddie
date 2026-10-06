import { createProfileApp } from '../../apps/app/src/server/routes/profile.ts';
import type { AuthEnv, D1Database } from '../../apps/app/src/server/auth.ts';

/**
 * Minimal local workerd fixture for P14 (REAL workerd via `wrangler dev`,
 * real local SQLite-backed D1 — never deployed).
 *
 * It mounts the production /api composition the P14 tests need (auth +
 * projects + the P14 profile/memory/search router — P14 is mounted alongside
 * the existing routers, exactly as the proposed app.ts diff does) and adds
 * /__test/* control routes used only by
 * tests/memory.integration.test.ts and tests/search-isolation.test.ts to
 * prepare the database and assert on rows. These control routes are NOT part
 * of the app Worker.
 */

interface FixtureEnv extends AuthEnv {
	[key: string]: unknown;
}

async function d1All(db: D1Database, sql: string): Promise<{ results: unknown[] }> {
	const res = await db.prepare(sql).all();
	return { results: (res.results ?? []) as unknown[] };
}

const apiApp = createProfileApp();

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
		return apiApp.fetch(request, env);
	},
};
