/**
 * Part A — the spending limit, checked before every model call (plan §A).
 *
 * This module owns the MONEY: it creates a build's payer with its D4 limit,
 * reserves micros before a model call, settles a reservation from that call's
 * own usage, releases it when the call fails, and estimates a call's worst-case
 * cost. The Flue `instrument()` wiring that calls these on each model turn lives
 * in `server/spend-instrument.ts`; the two are split so the money logic is
 * testable without a running runtime.
 *
 * Tables (migration 0040):
 *   build_spend_limits        — one row per payer, its ceiling in micros.
 *   build_spend_reservations  — one row per model call, keyed by turnId. The
 *                               limit is enforced ATOMICALLY by the migration's
 *                               `build_spend_reservations_limit_guard` trigger
 *                               inside the INSERT: the row is refused (the
 *                               insert raises `spend_limit_exceeded`) when
 *                               (settled so far) + (open reservations) + (this
 *                               estimate) > limit. Two concurrent reserves
 *                               serialize on SQLite's write lock, so the limit
 *                               is hard across every builder sharing the payer.
 *
 * Money is integer MICROS everywhere (1e-6 of a currency unit); no floats are
 * stored. Flue reports a call's cost in currency units (dollars), so settlement
 * converts `Math.ceil(cost * 1_000_000)`.
 *
 * NOTE on units: a route's price is held in MINOR units per Mtok
 * (`inputPriceMinorUnits` = cents per million tokens). One token therefore costs
 * `pricePerMtokMinor / 100` micros exactly (cents→micros is ×10_000, per-token
 * is ÷1_000_000, net ÷100), so the estimate needs no float and no rounding
 * until the final ceil.
 */

import type { D1Database } from './auth.ts';
import { isJudgeAccount } from './judge-access.ts';
import { MODEL_ROUTES, type ModelRoute } from '../agents/providers.ts';

/** Micros per currency unit (1e-6). All stored money is integer micros. */
export const MICROS_PER_UNIT = 1_000_000;

/** The D4 build limits, in micros. */
export const D4_LIMIT_MICROS = {
	/** Owner and invited users: $5.00. */
	standard: 5 * MICROS_PER_UNIT,
	/** Judge accounts: $2.00. */
	judge: 2 * MICROS_PER_UNIT,
	/** A big-app build (owner/invited only): $40.00. */
	bigApp: 40 * MICROS_PER_UNIT,
} as const;

/** The context-window cap (tokens) the fallback input estimate is clamped to. */
export const CONTEXT_WINDOW_ESTIMATE_CAP = 200_000;

/** Characters per token for the input estimate (plan §A: 1 token per 2 chars). */
const CHARS_PER_TOKEN = 2;

const now = (): string => new Date().toISOString();

/**
 * Raised when a reservation is refused at the limit. The instrument wiring
 * catches this, sets the build blocker, and rethrows so the model call never
 * reaches Token Factory. `limitMicros` is the payer's ceiling, for the blocker
 * message ("...spending limit of $X...").
 */
export class SpendLimitError extends Error {
	readonly code = 'spend_limit_reached';
	readonly payerId: string;
	readonly limitMicros: number;
	constructor(payerId: string, limitMicros: number) {
		super(`This build reached its spending limit of ${formatLimit(limitMicros)}. Your plan and files are saved.`);
		this.name = 'SpendLimitError';
		this.payerId = payerId;
		this.limitMicros = limitMicros;
	}
}

/** Format a micros limit as a plain dollar string for the blocker, e.g. "$5.00". */
export function formatLimit(limitMicros: number): string {
	const units = limitMicros / MICROS_PER_UNIT;
	return `$${units.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The SQLite error the migration-0040 trigger raises when the limit is exceeded. */
const TRIGGER_LIMIT_MESSAGE = 'spend_limit_exceeded';

function isLimitTriggerError(error: unknown): boolean {
	return error instanceof Error && error.message.includes(TRIGGER_LIMIT_MESSAGE);
}

// --- payer creation ----------------------------------------------------------

/**
 * Create a build's payer id. `build:<runId>:<time>` (plan §A step 1): the runId
 * ties it to the build, and the time makes a retry's new build a new payer with
 * a fresh limit, so Retry starts over rather than inheriting a spent budget.
 */
export function buildPayerId(runId: string, at: Date = new Date()): string {
	return `build:${runId}:${at.getTime()}`;
}

/**
 * Resolve a build's D4 limit (micros). A big-app build is $40; otherwise a judge
 * account is $2 and everyone else $5. `isJudgeAccount` is the same judge check
 * the judge-limits path uses, so the two never disagree.
 */
export async function resolveBuildLimitMicros(
	db: D1Database,
	actorId: string,
	opts: { bigApps: boolean },
): Promise<number> {
	if (opts.bigApps) return D4_LIMIT_MICROS.bigApp;
	return (await isJudgeAccount(db, actorId)) ? D4_LIMIT_MICROS.judge : D4_LIMIT_MICROS.standard;
}

/**
 * Create the payer's limit row. Idempotent: a payer id already present keeps its
 * original limit (a replay never resets it). Part A creates this BEFORE the
 * first reservation, so the trigger's "no limit row = refuse" guard only ever
 * fires on a real bug, never in the normal path.
 */
export async function createBuildPayer(db: D1Database, payerId: string, limitMicros: number): Promise<void> {
	const ts = now();
	await db
		.prepare(
			'insert into "build_spend_limits" ("payerId","limitMicros","createdAt","updatedAt") values (?,?,?,?) on conflict ("payerId") do nothing',
		)
		.bind(payerId, limitMicros, ts, ts)
		.run();
}

/**
 * An operator's LOWER-ONLY cap on new builds' limits, read from the env as US
 * dollars (`SPEND_LIMIT_CAP_USD`, e.g. "0.75"): it lets a smoke test or the
 * campaign make a build stop early, for real. It can only lower a limit, never
 * raise one. Unset, malformed, zero or negative means no cap.
 */
export function spendCapMicros(env: unknown): number | null {
	const raw = (env as Record<string, unknown> | null | undefined)?.['SPEND_LIMIT_CAP_USD'];
	if (typeof raw !== 'string' || !/^\d+(\.\d{1,6})?$/.test(raw.trim())) return null;
	const micros = Math.round(Number(raw.trim()) * MICROS_PER_UNIT);
	return micros > 0 ? micros : null;
}

/** Create a build's payer end-to-end: resolve the limit, write the row, return the id. */
export async function openBuildPayer(
	db: D1Database,
	input: { runId: string; actorId: string; bigApps: boolean; at?: Date; capMicros?: number | null },
): Promise<{ payerId: string; limitMicros: number }> {
	const payerId = buildPayerId(input.runId, input.at);
	const resolved = await resolveBuildLimitMicros(db, input.actorId, { bigApps: input.bigApps });
	// The operator cap only ever lowers the D4 limit (spendCapMicros).
	const limitMicros = input.capMicros ? Math.min(resolved, input.capMicros) : resolved;
	await createBuildPayer(db, payerId, limitMicros);
	return { payerId, limitMicros };
}

/** The payer's limit in micros, or null when no limit row exists. */
export async function payerLimitMicros(db: D1Database, payerId: string): Promise<number | null> {
	const row = (
		await db.prepare('select "limitMicros" from "build_spend_limits" where "payerId" = ?').bind(payerId).all<{ limitMicros: number }>()
	).results?.[0];
	return row ? row.limitMicros : null;
}

// --- the per-call estimate ---------------------------------------------------

/** Resolve a route by the model id a turn requested (frozen; returns null if unknown). */
export function routeByModelId(requestedModel: string | undefined | null): ModelRoute | null {
	if (!requestedModel) return null;
	return MODEL_ROUTES.find((route) => route.modelId === requestedModel) ?? null;
}

/**
 * The route to price a paying build's call at when its model can't be resolved
 * (an id not in the table, or no turn_request yet): the costliest route's worst
 * case, so a paying build never makes an unpriced call (fail-closed; the settle
 * path still records the real cost).
 */
export function costliestRoute(): ModelRoute {
	return [...MODEL_ROUTES].sort((a, b) => estimateCallMicros(b, undefined) - estimateCallMicros(a, undefined))[0]!;
}

/**
 * The worst-case cost of one model call, in micros (plan §A step 2 "estimate").
 *   input  = the turn_request's own size at 1 token per 2 chars, when known;
 *            else the route's context window capped at 200k tokens;
 *   output = the route's maxTokens;
 * each priced at the route's per-Mtok minor-unit rate (1 token = rate/100 micros).
 * `requestChars` is the character length of the call's request payload (system
 * prompt + messages + tools) as seen in `turn_request`; pass undefined when
 * turn_request has not arrived for this turn.
 */
export function estimateCallMicros(route: ModelRoute, requestChars: number | undefined): number {
	const inputTokens =
		requestChars === undefined
			? Math.min(route.contextWindow, CONTEXT_WINDOW_ESTIMATE_CAP)
			: Math.ceil(requestChars / CHARS_PER_TOKEN);
	const outputTokens = route.maxTokens;
	// 1 token costs `pricePerMtokMinor / 100` micros (cents→micros ÷100).
	const micros = inputTokens * (route.inputPriceMinorUnits / 100) + outputTokens * (route.outputPriceMinorUnits / 100);
	return Math.ceil(micros);
}

/** Micros for a settled call's own usage cost (currency units), rounded up. */
export function settleMicrosFromCost(costTotalUnits: number | undefined | null): number {
	if (!costTotalUnits || costTotalUnits <= 0) return 0;
	return Math.ceil(costTotalUnits * MICROS_PER_UNIT);
}

// --- reserve / settle / release ----------------------------------------------

export interface ReserveInput {
	payerId: string;
	turnId: string;
	conversationId: string;
	estimateMicros: number;
}

export type ReserveResult =
	/** A new reservation was written (the call may proceed). */
	| { outcome: 'reserved' }
	/** This turnId already had a reservation — NOT the limit; the call proceeds. */
	| { outcome: 'duplicate' }
	/** The trigger refused the insert: the limit would be exceeded. */
	| { outcome: 'refused' };

/**
 * Reserve the estimate for one model call, keyed by turnId (plan §A steps 2, 4).
 * Idempotent per turnId: the model interceptor fires more than once per turn
 * (S1: observed 8×), so a turnId that already has a reservation returns
 * `duplicate` — NEVER read as "limit reached" — and the call proceeds. A brand
 * new turnId inserts a `reserved` row; the migration-0040 trigger refuses it
 * atomically when the payer's settled+reserved+this estimate would exceed the
 * limit, which surfaces here as `refused`.
 */
export async function reserve(db: D1Database, input: ReserveInput): Promise<ReserveResult> {
	// Fast-path the idempotency check so a duplicate turnId never even attempts
	// the insert (the primary-key conflict would otherwise look like an error).
	const existing = (
		await db.prepare('select "turnId" from "build_spend_reservations" where "turnId" = ?').bind(input.turnId).all<{ turnId: string }>()
	).results?.[0];
	if (existing) return { outcome: 'duplicate' };

	const ts = now();
	try {
		await db
			.prepare(
				'insert into "build_spend_reservations" ("turnId","payerId","conversationId","reservedMicros","settledMicros","status","createdAt","updatedAt") values (?,?,?,?,?,?,?,?)',
			)
			.bind(input.turnId, input.payerId, input.conversationId, input.estimateMicros, null, 'reserved', ts, ts)
			.run();
		return { outcome: 'reserved' };
	} catch (error) {
		if (isLimitTriggerError(error)) return { outcome: 'refused' };
		// A primary-key conflict means a concurrent reserve for the same turnId
		// won the race: treat it as a duplicate, not a failure.
		if (error instanceof Error && /unique|primary key|constraint/i.test(error.message)) return { outcome: 'duplicate' };
		throw error;
	}
}

/**
 * Settle a reservation from the call's own usage (plan §A step 3). Writes the
 * call's actual micros and flips the row to `settled`. Only a still-`reserved`
 * row is settled, so a release or a second settle is a no-op (idempotent).
 */
export async function settle(db: D1Database, turnId: string, settledMicros: number): Promise<void> {
	await db
		.prepare('update "build_spend_reservations" set "settledMicros" = ?, "status" = \'settled\', "updatedAt" = ? where "turnId" = ? and "status" = \'reserved\'')
		.bind(Math.max(0, settledMicros), now(), turnId)
		.run();
}

/**
 * Release a reservation (plan §A step 3: "a failed call releases it"). Flips a
 * still-`reserved` row to `released`, which the trigger counts toward neither
 * settled nor open liability, so the worst-case estimate is handed back. A row
 * already settled is left alone.
 */
export async function release(db: D1Database, turnId: string): Promise<void> {
	await db
		.prepare('update "build_spend_reservations" set "status" = \'released\', "updatedAt" = ? where "turnId" = ? and "status" = \'reserved\'')
		.bind(now(), turnId)
		.run();
}

/** A payer's current spend picture (micros), for tests and the build card. */
export interface SpendSnapshot {
	limitMicros: number | null;
	settledMicros: number;
	reservedMicros: number;
}

export async function spendSnapshot(db: D1Database, payerId: string): Promise<SpendSnapshot> {
	const limitMicros = await payerLimitMicros(db, payerId);
	const settled = (
		await db
			.prepare('select coalesce(sum("settledMicros"),0) as total from "build_spend_reservations" where "payerId" = ? and "status" = \'settled\'')
			.bind(payerId)
			.all<{ total: number }>()
	).results?.[0]?.total ?? 0;
	const reserved = (
		await db
			.prepare('select coalesce(sum("reservedMicros"),0) as total from "build_spend_reservations" where "payerId" = ? and "status" = \'reserved\'')
			.bind(payerId)
			.all<{ total: number }>()
	).results?.[0]?.total ?? 0;
	return { limitMicros, settledMicros: settled, reservedMicros: reserved };
}

/**
 * Set the blocked phase + detail on the build that owns `payerId` (plan §A
 * step 1: "the build stops with..."). Keyed by the workflow's stored
 * spendPayerId, so the interceptor's blocker hook needs no project scope. This
 * is UI state only; the throw is what actually fails the call. Best-effort — a
 * build row that cannot be found (a chat payer, say) is a no-op.
 */
export async function blockBuildByPayer(db: D1Database, payerId: string, detail: string): Promise<void> {
	await db
		.prepare('update build_workflows set phase = ?, detail = ?, updatedAt = ? where "spendPayerId" = ?')
		.bind('blocked', detail.slice(0, 2000), now(), payerId)
		.run();
}
