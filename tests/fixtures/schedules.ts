import { createTasksApp } from '../../apps/app/src/server/routes/tasks.ts';
import { dispatchDueSchedules } from '../../apps/app/src/server/schedules.ts';
import type { AuthEnv, D1Database } from '../../apps/app/src/server/auth.ts';

/**
 * Minimal local workerd fixture for P12 (REAL workerd via `wrangler dev`, real
 * local SQLite-backed D1 — never deployed), following the P10 fixture pattern.
 *
 * It mounts the production task/schedule composition (createTasksApp — auth
 * router + projects router + P12 tasks/schedules/notifications router, the
 * mount shape app.ts uses) and adds /__test control routes used only by
 * tests/schedules.integration.test.ts. The /__test/tick route is the stand-in
 * for the P09/P17 cron/alarm executor: it calls the same system-level
 * dispatchDueSchedules the real executor will call — no session, no scope, the
 * schedule's STORED ids are the only targeting information. These control
 * routes are NOT part of the app Worker.
 */

interface FixtureEnv extends AuthEnv {
	[key: string]: unknown;
}

async function d1All(db: D1Database, sql: string): Promise<{ results: unknown[] }> {
	const res = await db.prepare(sql).all();
	return { results: (res.results ?? []) as unknown[] };
}

const apiApp = createTasksApp();

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
		// Cron-executor stand-in: fires everything due at `now` through the
		// production dispatch service. System-level — no session exists on a
		// cron tick, which is exactly why stored project ids are the only truth.
		if (url.pathname === '/__test/tick' && request.method === 'POST') {
			const body = (await request.json().catch(() => ({}))) as { now?: string };
			const nowMs = body.now ? Date.parse(body.now) : Date.now();
			if (!Number.isFinite(nowMs)) return Response.json({ error: 'invalid now' }, { status: 400 });
			try {
				const fired = await dispatchDueSchedules(env.DB, nowMs);
				return Response.json({ fired });
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}
		return apiApp.fetch(request, env);
	},
};
