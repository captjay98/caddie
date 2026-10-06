import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { ScopeError, projectScopeForUser, sessionUserId } from '../scope.ts';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { createEvidenceRouter } from './evidence.ts';
import { createRunsRouter } from './runs.ts';
import {
	createSchedule,
	getSchedule,
	listOccurrences,
	listSchedules,
	runScheduleNow,
	updateSchedule,
} from '../schedules.ts';
import { createTask, getTask, listTasks, updateTask, TASK_STATUSES } from '../tasks.ts';
import {
	attemptEmailDelivery,
	getNotification,
	listNotifications,
	mailerFromEnv,
	markNotificationRead,
} from '../notifications.ts';
import { listSentinelResults } from '../sentinel.ts';

/**
 * P12 routes — human tasks, schedules and notifications, following the
 * established router shape: every project route derives its Scope
 * server-side from the VERIFIED session + membership (never the body), the
 * service layer re-verifies the scope against D1 at entry, and typed
 * ScopeErrors map to `{ error: code, message }` with their status via the
 * router-level onError.
 *
 * The notification routes are USER-scoped, not project-scoped: the actor id
 * comes from the verified session and the row must belong to that user —
 * ownership is the scope.
 *
 * The /__test/tick executor stand-in is deliberately NOT here: it is a
 * fixture-only route (tests/fixtures/schedules.ts) that calls the same
 * system-level dispatchDueSchedules the REAL `scheduled` handler in
 * src/cloudflare.ts calls on its wrangler.jsonc 5-minute cron trigger.
 */

type Env = AuthEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled tasks route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await request.json();
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			throw new ScopeError(400, 'invalid_input', 'request body must be a JSON object');
		}
		return body as Record<string, unknown>;
	} catch (error) {
		if (error instanceof ScopeError) throw error;
		throw new ScopeError(400, 'invalid_input', 'request body must be valid JSON');
	}
}

export function createTasksRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- tasks ------------------------------------------------------------------

	router.post('/projects/:projectId/tasks', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		const body = await parseJsonBody(c.req.raw);
		const task = await createTask(c.env.DB, scope, {
			title: String(body.title ?? ''),
			dueAt: body.dueAt as string | null | undefined,
			linkedRunId: body.linkedRunId as string | null | undefined,
		});
		return c.json({ task }, 201);
	});

	router.get('/projects/:projectId/tasks', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		const status = c.req.query('status');
		const tasks = await listTasks(c.env.DB, scope, {
			status: status === undefined ? undefined : (status as (typeof TASK_STATUSES)[number]),
		});
		return c.json({ tasks });
	});

	router.get('/projects/:projectId/tasks/:taskId', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		return c.json({ task: await getTask(c.env.DB, scope, c.req.param('taskId')) });
	});

	router.patch('/projects/:projectId/tasks/:taskId', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		const body = await parseJsonBody(c.req.raw);
		const task = await updateTask(c.env.DB, scope, c.req.param('taskId'), {
			title: body.title as string | undefined,
			status: body.status as 'open' | undefined,
			dueAt: body.dueAt as string | null | undefined,
			linkedRunId: body.linkedRunId as string | null | undefined,
		});
		return c.json({ task });
	});

	// --- schedules ----------------------------------------------------------------

	router.post('/projects/:projectId/schedules', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		const body = await parseJsonBody(c.req.raw);
		const schedule = await createSchedule(c.env.DB, scope, {
			name: String(body.name ?? ''),
			cron: String(body.cron ?? ''),
			timezone: String(body.timezone ?? ''),
			payload: body.payload,
		});
		return c.json({ schedule }, 201);
	});

	router.get('/projects/:projectId/schedules', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		return c.json({ schedules: await listSchedules(c.env.DB, scope) });
	});

	router.get('/projects/:projectId/schedules/:scheduleId', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		return c.json({ schedule: await getSchedule(c.env.DB, scope, c.req.param('scheduleId')) });
	});

	router.get('/projects/:projectId/schedules/:scheduleId/occurrences', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		return c.json({ occurrences: await listOccurrences(c.env.DB, scope, c.req.param('scheduleId')) });
	});

	router.patch('/projects/:projectId/schedules/:scheduleId', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		const body = await parseJsonBody(c.req.raw);
		const schedule = await updateSchedule(c.env.DB, scope, c.req.param('scheduleId'), {
			name: body.name as string | undefined,
			cron: body.cron as string | undefined,
			timezone: body.timezone as string | undefined,
			paused: body.paused as boolean | undefined,
			payload: body.payload,
		});
		return c.json({ schedule });
	});

	/** Run a schedule NOW: occurrence key `manual:<instant>`; no timer involved. */
	router.post('/projects/:projectId/schedules/:scheduleId/run-now', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		const outcome = await runScheduleNow(c.env.DB, scope, c.req.param('scheduleId'));
		return c.json({
			elected: outcome.elected,
			result: outcome.result,
			occurrence: outcome.occurrence,
		});
	});

	// --- sentinel results -----------------------------------------------------------

	router.get('/projects/:projectId/sentinel', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const scope = await projectScopeForUser(c.env.DB, userId, c.req.param('projectId'));
		const sourceId = c.req.query('sourceId');
		const results = await listSentinelResults(c.env.DB, scope, sourceId);
		return c.json({ results });
	});

	// --- notifications (user-scoped) -------------------------------------------------

	router.get('/notifications', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const unreadOnly = c.req.query('unread') === '1';
		return c.json({ notifications: await listNotifications(c.env.DB, userId, { unreadOnly }) });
	});

	router.post('/notifications/:notificationId/read', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		const notification = await markNotificationRead(c.env.DB, userId, c.req.param('notificationId'));
		return c.json({ notification });
	});

	/**
	 * Opt-in email attempt for one of the caller's notifications. The mailer
	 * port's outcome NEVER fails this route: a failed send is a domain success
	 * carrying a retry-visible failed receipt (the absent-provider posture is
	 * BLOCKED, not an error).
	 */
	router.post('/notifications/:notificationId/email', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
		// ownership check BEFORE any delivery attempt
		await getNotification(c.env.DB, userId, c.req.param('notificationId'));
		const body = await parseJsonBody(c.req.raw);
		const delivery = await attemptEmailDelivery(
			c.env.DB,
			{
				notificationId: c.req.param('notificationId'),
				to: String(body.to ?? ''),
				origin: new URL(c.req.url).origin,
				priorDeliveryId: body.priorDeliveryId as string | undefined,
			},
			mailerFromEnv(c.env as unknown as Record<string, unknown>),
		);
		return c.json({ delivery });
	});

	return router;
}

/**
 * The full /api composition for the schedules fixture: auth + projects +
 * evidence + runs routers next to the P12 router — the same mount shape
 * app.ts uses at /api.
 */
export function createTasksApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createEvidenceRouter());
	app.route('/api', createRunsRouter());
	app.route('/api', createTasksRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
