import type { D1Database } from './auth.ts';
import { isJudgeAccount } from './judge-access.ts';
import { ScopeError } from './scope.ts';

/**
 * S07 judge limits (decision D4): every sizing rule for judge accounts lives
 * here, server-side, so no route re-implements one.
 *
 * A judge account is a user with an `active` row in `judge_accounts`
 * ({@link isJudgeAccount}); the owner and every invited user are never counted
 * and every helper below returns immediately for them.
 *
 * The four limits, per judge:
 *   - projects:        at most 3 non-home projects
 *   - build starts:    at most 3 per rolling 24 hours (plan approval, design
 *                      approval and Retry each count once)
 *   - Caddie messages: at most 300 per rolling 24 hours
 *   - discovery:       at most 20 per rolling 24 hours — the two POST
 *                      discovery actions that spend Tavily + Nebius PER CLICK
 *                      ("Check again" on the feed, and "Check eligibility" on
 *                      one candidate). Neither is a build start nor a message,
 *                      so without this cap a judge could spend outside the D4
 *                      quotas unboundedly.
 *
 * Every limit can also be set to `0`, which means NONE: no project, no build
 * start, no message, no discovery lookup. That is the only way to stop a judge
 * who ALREADY has an account, because `JUDGE_ACCESS_ENABLED=0` only blocks new
 * judge starts (S06) — it cannot take spending away from a judge already
 * signed in. `0` is a real limit here, never a way to spell "use the default".
 *
 * Build starts, messages and discovery lookups are recorded in
 * `judge_usage_events` (migration 0034; 0035 widens the CHECK to add
 * 'discovery') because none has a durable source to count: the workflow row
 * only keeps the latest state, a Caddie message lives in the Flue Durable
 * Object, and a discovery sweep leaves no per-click D1 record it could be
 * counted from. Projects need no event table — the `projects` rows ARE the
 * record — so only 'build', 'message' and 'discovery' are written.
 *
 * Every function takes an explicit `now` (default: the real clock) so the
 * 24-hour window is testable by seeding rows.
 */

/** The rolling window for every event limit. */
export const JUDGE_LIMIT_WINDOW_MS = 24 * 60 * 60_000;

/** D4 defaults (discovery's 20 is the owner-ordered follow-up cap). */
export const JUDGE_MAX_PROJECTS_DEFAULT = 3;
export const JUDGE_MAX_BUILDS_PER_DAY_DEFAULT = 3;
export const JUDGE_MAX_MESSAGES_PER_DAY_DEFAULT = 300;
export const JUDGE_MAX_DISCOVERY_PER_DAY_DEFAULT = 20;

/** The four optional env overrides, named exactly as they are documented. */
export interface JudgeLimitEnv {
	JUDGE_MAX_PROJECTS?: string | number;
	JUDGE_MAX_BUILDS_PER_DAY?: string | number;
	JUDGE_MAX_MESSAGES_PER_DAY?: string | number;
	JUDGE_MAX_DISCOVERY_PER_DAY?: string | number;
}

/** The resolved limits for one request. */
export interface JudgeLimits {
	projects: number;
	buildsPerDay: number;
	messagesPerDay: number;
	discoveryPerDay: number;
}

/**
 * A non-negative whole number, or the default.
 *
 * `0` is a REAL limit meaning NONE and is honored as such — it is not
 * replaced by the default. It is the only switch that stops a judge who
 * already has an account from spending, because `JUDGE_ACCESS_ENABLED=0` only
 * blocks new judge starts (S06). Everything a typo could produce — an absent
 * value, an empty or non-numeric string, a negative number, a fraction, or a
 * value outside the safe-integer range — reads as the default, so a bad
 * override is never MORE permissive than D4.
 */
function nonNegativeInteger(raw: string | number | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	if (typeof raw === 'number') {
		return Number.isSafeInteger(raw) && raw >= 0 ? raw : fallback;
	}
	const text = raw.trim();
	if (!/^[0-9]+$/.test(text)) return fallback;
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : fallback;
}

/**
 * Resolve the D4 defaults with the four env overrides. Takes `unknown`
 * because the Worker env shapes differ (`AuthEnv`, the coordinator's
 * environment, tests); only the four named keys are read.
 */
export function judgeLimits(env: unknown): JudgeLimits {
	const record = (env ?? {}) as JudgeLimitEnv;
	return {
		projects: nonNegativeInteger(record.JUDGE_MAX_PROJECTS, JUDGE_MAX_PROJECTS_DEFAULT),
		buildsPerDay: nonNegativeInteger(record.JUDGE_MAX_BUILDS_PER_DAY, JUDGE_MAX_BUILDS_PER_DAY_DEFAULT),
		messagesPerDay: nonNegativeInteger(record.JUDGE_MAX_MESSAGES_PER_DAY, JUDGE_MAX_MESSAGES_PER_DAY_DEFAULT),
		discoveryPerDay: nonNegativeInteger(record.JUDGE_MAX_DISCOVERY_PER_DAY, JUDGE_MAX_DISCOVERY_PER_DAY_DEFAULT),
	};
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Plain sentences; they say the limit and that nothing else changed. */
export function judgeProjectLimitMessage(limit: number): string {
	return `Judges can have ${plural(limit, 'project')}. Everything else works the same.`;
}

export function judgeBuildLimitMessage(limit: number): string {
	return `Judges can start ${plural(limit, 'build')} in 24 hours. Everything else works the same.`;
}

export function judgeMessageLimitMessage(limit: number): string {
	return `Judges can send ${plural(limit, 'Caddie message')} in 24 hours. Everything else works the same.`;
}

export function judgeDiscoveryLimitMessage(limit: number): string {
	return `Judges can run ${plural(limit, 'discovery lookup')} in 24 hours. Everything else works the same.`;
}

function nowIso(): string {
	return new Date().toISOString();
}

/** The start of the rolling window that ends at `now`. */
function windowStart(now: string): string {
	return new Date(Date.parse(now) - JUDGE_LIMIT_WINDOW_MS).toISOString();
}

async function countRows(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
	const result = await db.prepare(sql).bind(...params).all();
	const row = (result.results ?? [])[0];
	return Number(row?.['n'] ?? 0);
}

/**
 * `isJudgeAccount` that tolerates a database without the judge tables. A
 * fixture (or Worker) predating 0033 has no judge accounts, so nobody is a
 * judge and every limit passes — the same "no such table" tolerance the build
 * progress scan uses. Any other error still propagates.
 */
async function isActiveJudge(db: D1Database, userId: string): Promise<boolean> {
	try {
		return await isJudgeAccount(db, userId);
	} catch (error) {
		if (String(error).includes('no such table')) return false;
		throw error;
	}
}

/**
 * How many non-home projects this judge can reach through their workspace
 * memberships. `projects` has no createdBy, so the account's projects are the
 * ones in workspaces it belongs to. Home is excluded everywhere: the lazy
 * `ensureHomeProject` conversation is not a project a judge chose, so it must
 * never consume the allowance or be refused.
 */
export async function countJudgeProjects(db: D1Database, userId: string): Promise<number> {
	return countRows(
		db,
		`select count(distinct p."id") as "n" from "projects" p
		 join "workspace_memberships" m on m."workspaceId" = p."workspaceId"
		 where m."userId" = ? and p."kind" <> 'home'`,
		userId,
	);
}

/** How many admitted events of `kind` this judge has inside the rolling window. */
export async function countJudgeUsage(
	db: D1Database,
	userId: string,
	kind: 'build' | 'message' | 'discovery',
	now: string = nowIso(),
): Promise<number> {
	return countRows(
		db,
		'select count(*) as "n" from "judge_usage_events" where "userId" = ? and "kind" = ? and "createdAt" >= ?',
		userId,
		kind,
		windowStart(now),
	);
}

/** Drop events that fell out of the window. Best effort: the count already ignores them. */
async function pruneJudgeUsage(db: D1Database, now: string): Promise<void> {
	await db.prepare('delete from "judge_usage_events" where "createdAt" < ?').bind(windowStart(now)).run();
}

/**
 * Admit and record one build start, message or discovery lookup, atomically
 * where the database allows it: the INSERT only happens while the window still
 * has room, so two concurrent requests cannot both take the last place.
 * Returns true when the event was counted, false for a non-judge (who is never
 * limited).
 *
 * A `limit` of 0 makes `... < 0` false for every count, so the SELECT inserts
 * nothing and the event is always refused — the "0 means none" guarantee is
 * structural here, not a special case.
 */
async function admitEvent(
	db: D1Database,
	userId: string,
	kind: 'build' | 'message' | 'discovery',
	code: 'JUDGE_LIMIT_BUILDS' | 'JUDGE_LIMIT_MESSAGES' | 'JUDGE_LIMIT_DISCOVERY',
	limit: number,
	message: string,
	now: string,
): Promise<boolean> {
	if (!(await isActiveJudge(db, userId))) return false;
	const cutoff = windowStart(now);
	const result = (await db
		.prepare(
			`insert into "judge_usage_events" ("id","userId","kind","createdAt")
			 select ?,?,?,?
			 where (select count(*) from "judge_usage_events" where "userId" = ? and "kind" = ? and "createdAt" >= ?) < ?`,
		)
		.bind(`ju_${crypto.randomUUID()}`, userId, kind, now, userId, kind, cutoff, limit)
		.run()) as { meta?: { changes?: number } };
	if (Number(result?.meta?.changes ?? 0) < 1) throw new ScopeError(403, code, message);
	await pruneJudgeUsage(db, now);
	return true;
}

/**
 * Refuse a judge's 4th non-home project, or admit the creation (no event row
 * needed: the project row itself is the record). Non-judges pass through.
 *
 * With `JUDGE_MAX_PROJECTS=0` the check `count >= 0` is always true, so the
 * very first project is refused — "0 means none" holds here too.
 *
 * Call this only after an idempotent replay has been recognised, so re-sending
 * an already-created project never consumes an allowance or reports a refusal.
 */
export async function admitJudgeProject(
	db: D1Database,
	userId: string,
	env?: unknown,
): Promise<boolean> {
	const limits = judgeLimits(env);
	if (!(await isActiveJudge(db, userId))) return false;
	if ((await countJudgeProjects(db, userId)) >= limits.projects) {
		throw new ScopeError(403, 'JUDGE_LIMIT_PROJECTS', judgeProjectLimitMessage(limits.projects));
	}
	return true;
}

/** Refuse a judge's 4th build start in the rolling window; otherwise record it. */
export async function admitJudgeBuildStart(
	db: D1Database,
	userId: string,
	env?: unknown,
	now: string = nowIso(),
): Promise<boolean> {
	const limits = judgeLimits(env);
	return admitEvent(db, userId, 'build', 'JUDGE_LIMIT_BUILDS', limits.buildsPerDay, judgeBuildLimitMessage(limits.buildsPerDay), now);
}

/** Refuse a judge's 301st Caddie message in the rolling window; otherwise record it. */
export async function admitJudgeMessage(
	db: D1Database,
	userId: string,
	env?: unknown,
	now: string = nowIso(),
): Promise<boolean> {
	const limits = judgeLimits(env);
	return admitEvent(db, userId, 'message', 'JUDGE_LIMIT_MESSAGES', limits.messagesPerDay, judgeMessageLimitMessage(limits.messagesPerDay), now);
}

/**
 * Refuse a judge's (N+1)th live discovery lookup in the rolling window;
 * otherwise record it. Called by the two POST discovery routes that spend
 * Tavily + Nebius per click, AFTER the project scope is resolved and BEFORE any
 * paid work, so a refused lookup costs nothing. Non-judges pass through.
 */
export async function admitJudgeDiscovery(
	db: D1Database,
	userId: string,
	env?: unknown,
	now: string = nowIso(),
): Promise<boolean> {
	const limits = judgeLimits(env);
	return admitEvent(db, userId, 'discovery', 'JUDGE_LIMIT_DISCOVERY', limits.discoveryPerDay, judgeDiscoveryLimitMessage(limits.discoveryPerDay), now);
}
