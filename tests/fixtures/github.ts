import type { AuthEnv, D1Database } from '../../apps/app/src/server/auth.ts';
import { createGithubApp } from '../../apps/app/src/server/routes/github.ts';

/**
 * Minimal local workerd fixture for P08 (REAL workerd via `wrangler dev`, real
 * local SQLite-backed D1 — never deployed).
 *
 * It mounts the exact production /api composition (createGithubApp — the auth
 * router plus the P02 projects router plus the P03 approvals router plus the
 * P08 github router, the same set of mounts app.ts composes) and adds
 * /__test/* control routes used only by tests/github.integration.test.ts:
 *
 *   /__test/health   identity probe (D1 reachable, base URL as configured)
 *   /__test/ddl      apply migration statements (trigger-aware splitting happens test-side)
 *   /__test/d1       database-truth probes
 *
 * The GitHub REST API itself is a stub in the TEST process
 * (tests/fixtures/github-stub.ts, 127.0.0.1 only); the worker is pointed at it
 * through the GITHUB_API_BASE_URL env var, exactly like production will point
 * at api.github.com. These /__test routes are NOT part of the app Worker.
 */

interface FixtureEnv extends AuthEnv {
	[key: string]: unknown;
}

const apiApp = createGithubApp();

async function d1All(db: D1Database, sql: string): Promise<{ results: unknown[] }> {
	const res = await db.prepare(sql).all();
	return { results: (res.results ?? []) as unknown[] };
}

export default {
	async fetch(request: Request, env: FixtureEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__test/health') {
			try {
				await d1All(env.DB, 'select 1 as one');
				return Response.json({
					ok: true,
					d1: true,
					betterAuthUrl: env.BETTER_AUTH_URL ?? null,
					githubApiBaseUrl: env.GITHUB_API_BASE_URL ?? null,
				});
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
