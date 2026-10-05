import * as v from 'valibot';
import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

/**
 * P03 budgets (feature-ledger H16): persistent, payer-scoped spend control in
 * INTEGER minor units only (no floating-point money anywhere; schemas and DDL
 * enforce integers).
 *
 * Model (contracts.md "Budget"):
 *   - budget_pricing is VERSIONED per model route. An unknown
 *     (modelRouteId, pricingVersion) FAILS CLOSED — an unpriced route can never
 *     execute on a capped account (403 budget_pricing_unknown).
 *   - reserve() binds the reservation immutably to payer + model route +
 *     pricing version (+ run reference). The outstanding liability is the sum
 *     of rows with status 'reserved'; the cap is enforced ATOMICALLY inside the
 *     INSERT by the budget_reservations_cap_guard D1 trigger, which aborts the
 *     statement when the sum would exceed the payer limit. SQLite serializes
 *     concurrent writers, so two simultaneous reserves can never both land —
 *     proven against real workerd D1 in tests/budget-races.integration.test.ts
 *     (no JS mutex, no counter column, hence no drift).
 *   - settle() is IDEMPOTENT: the row transitions reserved->settled in a single
 *     conditional UPDATE; a double settle with the same actual is a no-op
 *     returning the first result. The actual is capped by the reserved bound
 *     (conservative-bound violation is a typed 409). The reserved bound
 *     (estimated) and the settled actual (billed) are recorded distinctly.
 *   - release() works only while reserved; a settled (billed) reservation can
 *     never be released.
 *   - Cancellation is a RUN/OPERATION concern (operations.ts) and does NOT
 *     release money: unresolved liability stays reserved until an explicit
 *     release.
 */

const BudgetLimitInputSchema = v.pipe(
	v.strictObject({
		payerId: v.pipe(v.string(), v.nonEmpty()),
		limitMinorUnits: v.pipe(v.number(), v.integer(), v.minValue(0)),
		currency: v.pipe(v.string(), v.nonEmpty()),
	}),
	v.readonly(),
);

const BudgetPriceInputSchema = v.pipe(
	v.strictObject({
		modelRouteId: v.pipe(v.string(), v.nonEmpty()),
		pricingVersion: v.pipe(v.string(), v.nonEmpty()),
		unitPriceMinorUnits: v.pipe(v.number(), v.integer(), v.minValue(0)),
		currency: v.pipe(v.string(), v.nonEmpty()),
	}),
	v.readonly(),
);

const BudgetReserveInputSchema = v.pipe(
	v.strictObject({
		payerId: v.pipe(v.string(), v.nonEmpty()),
		reservationKey: v.pipe(v.string(), v.nonEmpty()),
		amountMinorUnits: v.pipe(v.number(), v.integer(), v.minValue(1)),
		runId: v.optional(v.pipe(v.string(), v.nonEmpty())),
		modelRouteId: v.pipe(v.string(), v.nonEmpty()),
		pricingVersion: v.pipe(v.string(), v.nonEmpty()),
	}),
	v.readonly(),
);

// --- records -------------------------------------------------------------------

export interface BudgetPayer {
	payerId: string;
	limitMinorUnits: number;
	currency: string;
	createdAt: string;
	updatedAt: string;
}

export interface BudgetPrice {
	modelRouteId: string;
	pricingVersion: string;
	unitPriceMinorUnits: number;
	currency: string;
	createdAt: string;
}

export interface BudgetReservation {
	id: string;
	payerId: string;
	reservationKey: string;
	amountMinorUnits: number;
	/** Billed actual after settle; null while reserved/released (unknown usage). */
	settledAmountMinorUnits: number | null;
	status: 'reserved' | 'settled' | 'released';
	runId: string | null;
	modelRouteId: string;
	pricingVersion: string;
	createdAt: string;
	updatedAt: string;
}

// --- helpers -------------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function parseOr400<S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
	schema: S,
	input: unknown,
): v.InferOutput<S> {
	const result = v.safeParse(schema, input);
	if (!result.success) {
		const first = result.issues[0];
		const path = first?.path?.map((p) => String(p.key)).join('.') ?? '(body)';
		throw new ScopeError(
			400,
			'invalid_input',
			`invalid input at ${path}: ${first?.message ?? 'validation failed'}`,
		);
	}
	return result.output;
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function payerFromRow(row: Record<string, unknown>): BudgetPayer {
	return {
		payerId: String(row['payerId']),
		limitMinorUnits: Number(row['limitMinorUnits']),
		currency: String(row['currency']),
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

function priceFromRow(row: Record<string, unknown>): BudgetPrice {
	return {
		modelRouteId: String(row['modelRouteId']),
		pricingVersion: String(row['pricingVersion']),
		unitPriceMinorUnits: Number(row['unitPriceMinorUnits']),
		currency: String(row['currency']),
		createdAt: String(row['createdAt']),
	};
}

function reservationFromRow(row: Record<string, unknown>): BudgetReservation {
	return {
		id: String(row['id']),
		payerId: String(row['payerId']),
		reservationKey: String(row['reservationKey']),
		amountMinorUnits: Number(row['amountMinorUnits']),
		settledAmountMinorUnits: row['settledAmountMinorUnits'] === null ? null : Number(row['settledAmountMinorUnits']),
		status: String(row['status']) as BudgetReservation['status'],
		runId: row['runId'] === null || row['runId'] === undefined ? null : String(row['runId']),
		modelRouteId: String(row['modelRouteId']),
		pricingVersion: String(row['pricingVersion']),
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

async function reservationByKey(
	db: D1Database,
	reservationKey: string,
): Promise<Record<string, unknown> | null> {
	const rows = await queryAll(
		db,
		'select * from "budget_reservations" where "reservationKey" = ?',
		reservationKey,
	);
	return rows[0] ?? null;
}

function requireReservationRow(row: Record<string, unknown> | null, key: string): Record<string, unknown> {
	if (!row) throw new ScopeError(404, 'reservation_not_found', 'no such budget reservation');
	return row;
}

// --- configuration (owner actions) ------------------------------------------------

/** Set (or adjust) a payer's cap. Upsert: governance settings, not effects. */
export async function setBudgetLimit(db: D1Database, input: unknown): Promise<BudgetPayer> {
	const parsed = parseOr400(BudgetLimitInputSchema, input);
	const now = nowIso();
	await db
		.prepare(
			`insert into "budget_payers" ("payerId","limitMinorUnits","currency","createdAt","updatedAt")
			 values (?,?,?,?,?)
			 on conflict("payerId") do update set
			   "limitMinorUnits" = excluded."limitMinorUnits",
			   "currency" = excluded."currency",
			   "updatedAt" = excluded."updatedAt"`,
		)
		.bind(parsed.payerId, parsed.limitMinorUnits, parsed.currency, now, now)
		.run();
	const rows = await queryAll(db, 'select * from "budget_payers" where "payerId" = ?', parsed.payerId);
	return payerFromRow(rows[0]!);
}

/** Register a versioned price row for a model route. */
export async function setPrice(db: D1Database, input: unknown): Promise<BudgetPrice> {
	const parsed = parseOr400(BudgetPriceInputSchema, input);
	const now = nowIso();
	await db
		.prepare(
			`insert into "budget_pricing" ("modelRouteId","pricingVersion","unitPriceMinorUnits","currency","createdAt")
			 values (?,?,?,?,?)
			 on conflict("modelRouteId","pricingVersion") do update set
			   "unitPriceMinorUnits" = excluded."unitPriceMinorUnits",
			   "currency" = excluded."currency"`,
		)
		.bind(parsed.modelRouteId, parsed.pricingVersion, parsed.unitPriceMinorUnits, parsed.currency, now)
		.run();
	const rows = await queryAll(
		db,
		'select * from "budget_pricing" where "modelRouteId" = ? and "pricingVersion" = ?',
		parsed.modelRouteId,
		parsed.pricingVersion,
	);
	return priceFromRow(rows[0]!);
}

// --- reserve / settle / release -----------------------------------------------------

/**
 * Atomically reserve a conservative bound for a run. The INSERT itself is the
 * authorization (trigger-guarded single statement): over-cap attempts abort
 * with 402 budget_exceeded; a replayed reservationKey elects no second row
 * (409 reservation_key_conflict). Unknown pricing fails closed.
 */
export async function reserveBudget(db: D1Database, input: unknown): Promise<BudgetReservation> {
	const parsed = parseOr400(BudgetReserveInputSchema, input);

	// fail closed: unknown price can never execute on a capped account
	const priceRows = await queryAll(
		db,
		'select * from "budget_pricing" where "modelRouteId" = ? and "pricingVersion" = ?',
		parsed.modelRouteId,
		parsed.pricingVersion,
	);
	const price = priceRows[0];
	if (!price) {
		throw new ScopeError(
			403,
			'budget_pricing_unknown',
			'no price row for this model route + pricing version — refusing to reserve (fail closed)',
		);
	}
	const payerRows = await queryAll(db, 'select * from "budget_payers" where "payerId" = ?', parsed.payerId);
	const payer = payerRows[0];
	if (!payer) throw new ScopeError(404, 'budget_payer_not_found', 'no such budget payer');
	if (String(price['currency']) !== String(payer['currency'])) {
		throw new ScopeError(
			409,
			'budget_currency_mismatch',
			'pricing currency does not match the payer currency — refusing to mix money scales',
		);
	}

	const now = nowIso();
	try {
		await db
			.prepare(
				`insert into "budget_reservations"
				   ("id","payerId","reservationKey","amountMinorUnits","settledAmountMinorUnits","status","runId","modelRouteId","pricingVersion","createdAt","updatedAt")
				 values (?,?,?,?,null,'reserved',?,?,?,?,?)`,
			)
			.bind(
				newId('bres'),
				parsed.payerId,
				parsed.reservationKey,
				parsed.amountMinorUnits,
				parsed.runId ?? null,
				parsed.modelRouteId,
				parsed.pricingVersion,
				now,
				now,
			)
			.run();
	} catch (error) {
		const message = String(error);
		if (message.includes('budget_exceeded')) {
			throw new ScopeError(
				402,
				'budget_exceeded',
				`reservation would exceed the payer cap (limit ${Number(payer['limitMinorUnits'])} ${String(payer['currency'])})`,
			);
		}
		if (message.includes('UNIQUE constraint failed')) {
			throw new ScopeError(
				409,
				'reservation_key_conflict',
				'a reservation with this key already exists — the logical hold exists once',
			);
		}
		throw error;
	}
	return reservationFromRow((await reservationByKey(db, parsed.reservationKey))!);
}

/**
 * Settle a reservation with the billed actual. Idempotent: a double settle
 * with the same actual is a no-op returning the first result. The actual can
 * never exceed the reserved conservative bound.
 */
export async function settleReservation(
	db: D1Database,
	reservationKey: string,
	actualAmountMinorUnits: number,
): Promise<BudgetReservation> {
	if (typeof reservationKey !== 'string' || reservationKey.length === 0) {
		throw new ScopeError(400, 'invalid_request', 'reservationKey is required');
	}
	if (typeof actualAmountMinorUnits !== 'number' || !Number.isSafeInteger(actualAmountMinorUnits) || actualAmountMinorUnits < 0) {
		throw new ScopeError(400, 'invalid_input', 'actualAmountMinorUnits must be a non-negative integer');
	}
	let row = requireReservationRow(await reservationByKey(db, reservationKey), reservationKey);
	let status = String(row['status']);
	if (status === 'settled') {
		if (Number(row['settledAmountMinorUnits']) === actualAmountMinorUnits) {
			return reservationFromRow(row); // idempotent: first result returned again
		}
		throw new ScopeError(409, 'settle_conflict', 'reservation already settled with a different actual');
	}
	if (status === 'released') {
		throw new ScopeError(409, 'reservation_released', 'a released reservation cannot be settled');
	}
	if (actualAmountMinorUnits > Number(row['amountMinorUnits'])) {
		throw new ScopeError(
			409,
			'settle_exceeds_reservation',
			'billed actual exceeds the reserved conservative bound — reserve enough before executing',
		);
	}
	// single-statement conditional transition: a concurrent settle wins, we re-check
	await db
		.prepare(
			'update "budget_reservations" set "status" = \'settled\', "settledAmountMinorUnits" = ?, "updatedAt" = ? where "reservationKey" = ? and "status" = \'reserved\'',
		)
		.bind(actualAmountMinorUnits, nowIso(), reservationKey)
		.run();
	row = requireReservationRow(await reservationByKey(db, reservationKey), reservationKey);
	status = String(row['status']);
	if (status === 'settled') {
		if (Number(row['settledAmountMinorUnits']) === actualAmountMinorUnits) {
			return reservationFromRow(row);
		}
		throw new ScopeError(409, 'settle_conflict', 'a concurrent settle landed with a different actual');
	}
	throw new ScopeError(409, 'reservation_released', 'the reservation was released concurrently');
}

/** Release a reservation. Only a RESERVED row can be released; idempotent on released. */
export async function releaseReservation(
	db: D1Database,
	reservationKey: string,
): Promise<BudgetReservation> {
	if (typeof reservationKey !== 'string' || reservationKey.length === 0) {
		throw new ScopeError(400, 'invalid_request', 'reservationKey is required');
	}
	let row = requireReservationRow(await reservationByKey(db, reservationKey), reservationKey);
	if (String(row['status']) === 'settled') {
		throw new ScopeError(409, 'reservation_settled', 'a settled (billed) reservation cannot be released');
	}
	await db
		.prepare(
			'update "budget_reservations" set "status" = \'released\', "updatedAt" = ? where "reservationKey" = ? and "status" = \'reserved\'',
		)
		.bind(nowIso(), reservationKey)
		.run();
	row = requireReservationRow(await reservationByKey(db, reservationKey), reservationKey);
	return reservationFromRow(row); // released (ours or already released) — idempotent
}

// --- reads ------------------------------------------------------------------------

/** Outstanding reserved liability for a payer (sum of live reservations). */
export async function reservedMinorUnits(db: D1Database, payerId: string): Promise<number> {
	if (typeof payerId !== 'string' || payerId.length === 0) {
		throw new ScopeError(400, 'invalid_request', 'payerId is required');
	}
	const rows = await queryAll(
		db,
		'select coalesce(sum("amountMinorUnits"), 0) as total from "budget_reservations" where "payerId" = ? and "status" = \'reserved\'',
		payerId,
	);
	return Number(rows[0]?.['total'] ?? 0);
}

export async function getReservation(
	db: D1Database,
	reservationKey: string,
): Promise<BudgetReservation | null> {
	if (typeof reservationKey !== 'string' || reservationKey.length === 0) {
		throw new ScopeError(400, 'invalid_request', 'reservationKey is required');
	}
	const row = await reservationByKey(db, reservationKey);
	return row ? reservationFromRow(row) : null;
}
