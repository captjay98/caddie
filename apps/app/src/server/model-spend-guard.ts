/**
 * The hard ceiling on what Caddie's AI may spend (owner 2026-10-29, after a
 * $58.84 Token Factory bill: "ensure there are no ways we can waste money
 * anymore"). Checked BEFORE every model call Caddie makes — the coordinator
 * and its specialists, the discovery helpers and the plan reviewer — from the
 * receipts already recorded in model_call_usage. Two limits:
 *
 *   - a daily account-wide cap (UTC day): MODEL_SPEND_DAILY_CAP_USD;
 *   - a per-project lifetime cap: MODEL_SPEND_PROJECT_CAP_USD.
 *
 * Over either, the call is refused before it reaches Token Factory, and an
 * active plan/looks/build step is paused with a plain message. Set a cap to
 * "0" to stop all AI calls (a kill switch) or to "off" to lift it. Receipts
 * land after each call, so one in-flight call can overshoot by its own cost.
 *
 * The per-build payer limits (build-spend.ts) still apply on top; they reset
 * on every Retry, which is exactly why this project-wide total exists.
 */
import type { D1Database } from './auth.ts';

export const DEFAULT_DAILY_CAP_USD = 3;
export const DEFAULT_PROJECT_CAP_USD = 2.5;

export type SpendCapScope = 'day' | 'project';

export class ModelSpendCapError extends Error {
	readonly code = 'model_spend_cap';
	constructor(readonly scope: SpendCapScope, readonly capMicros: number, readonly spentMicros: number) {
		super(scope === 'day'
			? `MODEL_SPEND_CAP: today's AI spending limit (${usd(capMicros)}) is reached; ${usd(spentMicros)} spent. No more AI calls until tomorrow (UTC) or until MODEL_SPEND_DAILY_CAP_USD is raised.`
			: `MODEL_SPEND_CAP: this project's AI spending limit (${usd(capMicros)}) is reached; ${usd(spentMicros)} spent. No more AI calls for it until MODEL_SPEND_PROJECT_CAP_USD is raised.`);
		this.name = 'ModelSpendCapError';
	}
}

/** What the owner reads on the paused card. */
export const SPEND_CAP_DETAIL: Record<SpendCapScope, string> = {
	day: 'Caddie reached today’s AI spending limit, so it paused. Your work is saved. It can continue tomorrow.',
	project: 'This project reached its AI spending limit, so Caddie paused it. Your work is saved.',
};

function usd(micros: number): string {
	return `$${(micros / 1_000_000).toFixed(2)}`;
}

type CapKey = 'MODEL_SPEND_DAILY_CAP_USD' | 'MODEL_SPEND_PROJECT_CAP_USD';
/**
 * The cap settings last seen in a Worker env, for callers that hold only a
 * database handle (the discovery helpers, the plan reviewer). Every agent
 * call passes the env and refreshes this, and those callers run in the same
 * isolate, so a raised cap applies to them too.
 */
const seenCaps = new Map<CapKey, string>();
/** Test-only: forget the cap settings seen so far. */
export function _resetSeenSpendCaps(): void {
	seenCaps.clear();
}

/** A cap in micros from the env, null when lifted ("off"), the default when unset or malformed. */
export function capMicros(env: unknown, key: CapKey, fallbackUsd: number): number | null {
	const fromEnv = (env as Record<string, unknown> | null | undefined)?.[key];
	// A real env is the truth, including "not set" (the default).
	if (env) {
		if (typeof fromEnv === 'string') seenCaps.set(key, fromEnv);
		else seenCaps.delete(key);
	}
	const raw = env ? fromEnv : seenCaps.get(key);
	if (typeof raw === 'string') {
		const value = raw.trim().toLowerCase();
		if (value === 'off') return null;
		if (/^\d+(\.\d{1,6})?$/.test(value)) return Math.round(Number(value) * 1_000_000);
	}
	return Math.round(fallbackUsd * 1_000_000);
}

function dayStartIso(nowMs: number): string {
	const day = new Date(nowMs);
	return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString();
}

async function sumMicros(db: D1Database, sql: string, ...args: unknown[]): Promise<number> {
	try {
		const row = (await db.prepare(sql).bind(...args).all<{ micros: number | null }>()).results[0];
		return Number(row?.micros ?? 0);
	} catch (error) {
		if (/no such (table|column)/i.test(String(error))) return 0;
		throw error;
	}
}

/**
 * The project a call belongs to, and every id its receipts are filed under: a
 * project's coordinator files receipts under its conversation id, and helpers
 * and the plan reviewer under the project id.
 */
async function projectKeys(db: D1Database, input: { projectId?: string | null; conversationIds?: readonly string[] }): Promise<{ projectId: string; keys: string[] } | null> {
	const ids = (input.conversationIds ?? []).filter((id) => id.length > 0);
	try {
		const row = input.projectId
			? (await db.prepare('select projectId, conversationId from build_workflows where projectId = ? limit 1').bind(input.projectId).all<{ projectId: string; conversationId: string }>()).results[0]
			: ids.length
				? (await db.prepare(`select projectId, conversationId from build_workflows where conversationId in (${ids.map(() => '?').join(',')}) limit 1`).bind(...ids).all<{ projectId: string; conversationId: string }>()).results[0]
				: undefined;
		if (row) return { projectId: row.projectId, keys: [row.projectId, row.conversationId] };
	} catch (error) {
		if (!/no such (table|column)/i.test(String(error))) throw error;
	}
	return input.projectId ? { projectId: input.projectId, keys: [input.projectId] } : null;
}

/** Throws ModelSpendCapError when the day's or the project's recorded spend has reached its cap. */
export async function assertModelSpendAllowed(
	db: D1Database,
	env: unknown,
	input: { projectId?: string | null; conversationIds?: readonly string[]; nowMs?: number } = {},
): Promise<void> {
	const daily = capMicros(env, 'MODEL_SPEND_DAILY_CAP_USD', DEFAULT_DAILY_CAP_USD);
	if (daily !== null) {
		const since = dayStartIso(input.nowMs ?? Date.now());
		// Caddie's own calls, plus the AI inside generated apps (its own ledger).
		const spent =
			(await sumMicros(db, 'select sum("catalogCostMicros") as micros from "model_call_usage" where "createdAt" >= ?', since)) +
			(await sumMicros(db, 'select sum(case when "status" = \'reserved\' then "reservedMicros" else "costMicros" end) as micros from "app_ai_usage" where "createdAt" >= ?', since));
		if (spent >= daily) throw new ModelSpendCapError('day', daily, spent);
	}
	const perProject = capMicros(env, 'MODEL_SPEND_PROJECT_CAP_USD', DEFAULT_PROJECT_CAP_USD);
	if (perProject === null) return;
	const project = await projectKeys(db, input);
	if (!project) return;
	const spent = await sumMicros(db, `select sum("catalogCostMicros") as micros from "model_call_usage" where "instanceId" in (${project.keys.map(() => '?').join(',')})`, ...project.keys);
	if (spent >= perProject) throw new ModelSpendCapError('project', perProject, spent);
}

/** Pause the project's active step with the owner-facing cap message. */
export async function pauseForSpendCap(db: D1Database, error: ModelSpendCapError, input: { projectId?: string | null; conversationIds?: readonly string[] }): Promise<void> {
	const ids = (input.conversationIds ?? []).filter((id) => id.length > 0);
	const where = input.projectId ? 'projectId = ?' : ids.length ? `conversationId in (${ids.map(() => '?').join(',')})` : null;
	if (!where) return;
	try {
		await db
			.prepare(`update build_workflows set phase='blocked', pendingKey=null, pendingBody=null, detail=?, updatedAt=? where ${where} and phase in ('planning','looks','design','building')`)
			.bind(SPEND_CAP_DETAIL[error.scope], new Date().toISOString(), ...(input.projectId ? [input.projectId] : ids))
			.run();
	} catch {
		// The refusal stands even when the pause cannot be written.
	}
}
