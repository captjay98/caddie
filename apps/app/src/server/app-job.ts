import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope } from './scope.ts';
import type { AppAiMode } from './app-ai.ts';
import type { JobRunStatus } from '@caddie/contracts';

/**
 * Scheduled jobs with "Run now" (plan part N), host side. Nothing runs on a
 * timer this week; Caddie calls a declared job's route when the owner presses
 * Run now, with the header `x-caddie-job: <unix-ms>.<hex>`:
 *
 *   - the signature is an HMAC-SHA256 over "<unix-ms>.<route path>", keyed by
 *     {@link appJobSecret} — a per-project, per-mode secret derived from
 *     Caddie's own secret exactly as `appAuthSecret` is, and handed to the app
 *     as `CADDIE_JOB_SECRET` (the way `CADDIE_AUTH_SECRET` is). The key binds
 *     project and mode; the route path binds WHICH job (one job, one route);
 *     the timestamp binds the time. The generated access check
 *     (contract-files.ts) accepts only a signature less than 5 minutes old.
 *   - a preview run goes through the preview runtime; a published run through
 *     the dispatch namespace. The route builds the signed request; the relay
 *     is the caller's.
 *   - each run is stored in `app_job_runs` with the route's one-line summary
 *     (at most 300 characters).
 */

export type AppJobMode = AppAiMode;

/** A job signature is valid for this long; the generated check enforces the same. */
export const JOB_MAX_AGE_MS = 5 * 60_000;
/** The route's one-line result, stored on the run. */
export const JOB_SUMMARY_MAX = 300;
/** How many recent runs the list returns. */
export const JOB_RUNS_SHOWN = 20;
export const JOB_HEADER = 'x-caddie-job';

/**
 * The secret an app verifies a Run-now call with, one per project and mode,
 * derived from Caddie's own secret (HMAC-SHA256): nothing to store, and a
 * preview signature never works on the published app. Null without Caddie's
 * secret. Keyed exactly like {@link appAuthSecret}, under a distinct label so
 * the job secret and the cookie secret are independent.
 */
export async function appJobSecret(masterSecret: string | undefined, projectId: string, mode: AppJobMode): Promise<string | null> {
	const master = (masterSecret ?? '').trim();
	if (master.length < 16) return null;
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(master), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`caddie-app-job:v1:${mode}:${projectId}`)));
	let binary = '';
	for (const byte of mac) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the `x-caddie-job` header value for one Run-now call: `<unix-ms>.<hex>`
 * where the hex is HMAC-SHA256(secret, "<unix-ms>.<route path>"). The same
 * message the generated access check verifies. Null when there is no secret.
 */
export async function caddieJobHeader(secret: string | null, routePath: string, now: Date = new Date()): Promise<string | null> {
	if (!secret) return null;
	const stamp = String(now.getTime());
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${stamp}.${routePath}`)));
	const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${stamp}.${hex}`;
}

export interface JobRunRecord {
	id: string;
	jobId: string;
	status: JobRunStatus;
	summary: string | null;
	startedAt: string;
	finishedAt: string | null;
}

/** Open a run row ('running'); returns its id so the caller can finish it. */
export async function startJobRun(db: D1Database, input: { projectId: string; mode: AppJobMode; jobId: string; now?: Date }): Promise<string> {
	const id = `ajr_${crypto.randomUUID()}`;
	const startedAt = (input.now ?? new Date()).toISOString();
	await db
		.prepare('insert into "app_job_runs" ("id","projectId","mode","jobId","status","summary","startedAt","finishedAt") values (?,?,?,?,?,?,?,?)')
		.bind(id, input.projectId, input.mode, input.jobId, 'running', null, startedAt, null)
		.run();
	return id;
}

/** Close a run row with its outcome and the route's one-line summary (capped). */
export async function finishJobRun(
	db: D1Database,
	input: { runId: string; status: Exclude<JobRunStatus, 'running'>; summary?: string | null; now?: Date },
): Promise<void> {
	const summary = typeof input.summary === 'string' ? input.summary.slice(0, JOB_SUMMARY_MAX) : null;
	await db
		.prepare('update "app_job_runs" set "status" = ?, "summary" = ?, "finishedAt" = ? where "id" = ?')
		.bind(input.status, summary, (input.now ?? new Date()).toISOString(), input.runId)
		.run();
}

/** The latest runs for a project's jobs, newest first (any project member). */
export async function listJobRuns(db: D1Database, scope: Scope, limit: number = JOB_RUNS_SHOWN): Promise<JobRunRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = (await db
		.prepare('select "id", "jobId", "status", "summary", "startedAt", "finishedAt" from "app_job_runs" where "projectId" = ? order by "startedAt" desc, "rowid" desc limit ?')
		.bind(verified.projectId, Math.min(Math.max(limit, 1), 100))
		.all()).results ?? [];
	return (rows as Array<Record<string, unknown>>).map((row) => ({
		id: String(row['id']),
		jobId: String(row['jobId']),
		status: row['status'] as JobRunStatus,
		summary: row['summary'] == null ? null : String(row['summary']),
		startedAt: String(row['startedAt']),
		finishedAt: row['finishedAt'] == null ? null : String(row['finishedAt']),
	}));
}
