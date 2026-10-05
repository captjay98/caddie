import * as v from 'valibot';
import type { ExternalOperation } from '@caddie/contracts';
import { ExternalOperationSchema } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

/**
 * P03 external-effects ledger (feature-ledger H5). Deliberately NARROW — no
 * second workflow/lease engine: one table, unique operation key, receipts.
 *
 * Semantics (contracts.md "Approval and effect"):
 *   - The operationKey is the durable idempotency key of the LOGICAL
 *     action/revision, never an attempt id. Its unique insertion ELECTS the one
 *     dispatcher: a duplicate prepare is a typed 409, never a second effect.
 *   - A cancellation REQUEST is not confirmed termination: cancel-requested is
 *     distinct from cancelled, and only a provider receipt proves termination.
 *   - An uncertain dispatch (timeout / unknown outcome) leaves the row in
 *     reconciliation-required. That state can only be left via a real receipt
 *     (recordReceipt / markCancelled) — there is no re-dispatch path, so no
 *     blind retry can duplicate the effect. The (provider, operationKey) pair
 *     is the provider correlation lookup for exactly this reconciliation.
 *
 * Legal transitions:
 *   prepared -> dispatched | cancel-requested
 *   dispatched -> succeeded | failed | cancel-requested | reconciliation-required
 *   cancel-requested -> cancelled (receipt) | succeeded | failed
 *   reconciliation-required -> succeeded | failed | cancelled (receipt only)
 *   succeeded | failed | cancelled: terminal (same receipt replays as a no-op)
 */

const OperationPrepareInputSchema = v.pipe(
	v.strictObject({
		projectId: v.pipe(v.string(), v.nonEmpty()),
		runId: v.pipe(v.string(), v.nonEmpty()),
		provider: v.pipe(v.string(), v.nonEmpty()),
		operationKey: v.pipe(v.string(), v.nonEmpty()),
	}),
	v.readonly(),
);

const OperationReceiptInputSchema = v.pipe(
	v.strictObject({
		receiptId: v.pipe(v.string(), v.nonEmpty()),
		outcome: v.union([v.literal('succeeded'), v.literal('failed')]),
		remoteId: v.optional(v.string()),
	}),
	v.readonly(),
);

// --- helpers -----------------------------------------------------------------

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

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new ScopeError(400, 'invalid_request', `${field} is required`);
	}
	return value;
}

/** Strict boundary parse: DB row -> frozen ExternalOperation contract. */
function operationFromRow(row: Record<string, unknown>): ExternalOperation {
	return parseOr400(ExternalOperationSchema, {
		id: row['id'],
		projectId: row['projectId'],
		runId: row['runId'],
		operationKey: row['operationKey'],
		provider: row['provider'],
		remoteId: row['remoteId'] ?? null,
		status: row['status'],
		receiptId: row['receiptId'] ?? null,
	});
}

type OperationRow = Record<string, unknown>;

async function operationByKey(db: D1Database, operationKey: string): Promise<OperationRow> {
	const res = await db
		.prepare('select * from "external_operations" where "operationKey" = ?')
		.bind(operationKey)
		.all();
	const row = (res.results ?? [])[0] as OperationRow | undefined;
	if (!row) throw new ScopeError(404, 'operation_not_found', 'no such external operation');
	return row;
}

/**
 * Single-statement conditional transition: the WHERE clause admits only the
 * legal source statuses, so a concurrent writer loses with changes = 0 instead
 * of double-applying. `changes` counting is the atomicity proof — no JS lock.
 */
async function transition(
	db: D1Database,
	operationKey: string,
	toStatus: string,
	sourceStatuses: string[],
	sets: { remoteId?: string; receiptId?: string } = {},
): Promise<OperationRow> {
	const assignments = ['"status" = ?', '"updatedAt" = ?'];
	const params: unknown[] = [toStatus, nowIso()];
	if (sets.remoteId !== undefined) {
		assignments.push('"remoteId" = ?');
		params.push(sets.remoteId);
	}
	if (sets.receiptId !== undefined) {
		assignments.push('"receiptId" = ?');
		params.push(sets.receiptId);
	}
	const placeholders = sourceStatuses.map(() => '?').join(', ');
	const sql = `update "external_operations" set ${assignments.join(', ')} where "operationKey" = ? and "status" in (${placeholders})`;
	const res = (await db
		.prepare(sql)
		.bind(...params, operationKey, ...sourceStatuses)
		.run()) as { meta?: { changes?: number } };
	const row = await operationByKey(db, operationKey);
	if ((res.meta?.changes ?? 0) === 0) {
		// nothing transitioned: report the CURRENT state through the transition rules
		const current = String(row['status']);
		if (current === toStatus) return row; // already there (idempotent caller)
		throw new ScopeError(
			409,
			'operation_invalid_transition',
			`cannot transition from ${current} to ${toStatus}`,
		);
	}
	return row;
}

// --- lifecycle ------------------------------------------------------------------

/** Elect the dispatcher: unique operationKey admits exactly one prepared row. */
export async function prepareOperation(db: D1Database, input: unknown): Promise<ExternalOperation> {
	const parsed = parseOr400(OperationPrepareInputSchema, input);
	const id = newId('extop');
	const now = nowIso();
	try {
		await db
			.prepare(
				'insert into "external_operations" ("id","projectId","runId","operationKey","provider","remoteId","status","receiptId","createdAt","updatedAt") values (?,?,?,?,?,null,\'prepared\',null,?,?)',
			)
			.bind(id, parsed.projectId, parsed.runId, parsed.operationKey, parsed.provider, now, now)
			.run();
	} catch (error) {
		if (String(error).includes('UNIQUE constraint failed')) {
			throw new ScopeError(
				409,
				'operation_key_conflict',
				'another dispatcher already owns this operation key — the logical effect exists once',
			);
		}
		throw error;
	}
	return operationFromRow(await operationByKey(db, parsed.operationKey));
}

/** Record the provider accepting the dispatch (remote identity persisted). */
export async function markDispatched(
	db: D1Database,
	operationKey: string,
	remoteId: string,
): Promise<ExternalOperation> {
	const key = requireNonEmpty(operationKey, 'operationKey');
	const remote = requireNonEmpty(remoteId, 'remoteId');
	return operationFromRow(
		await transition(db, key, 'dispatched', ['prepared'], { remoteId: remote }),
	);
}

/**
 * Settle a provider receipt (succeeded | failed). Idempotent: replaying the
 * SAME receipt on the settled row is a no-op; a different receipt on a terminal
 * row is a typed conflict. Never fabricates completion: a receipt for a row
 * that was never dispatched is refused.
 */
export async function recordReceipt(
	db: D1Database,
	operationKey: string,
	receipt: { receiptId: string; outcome: 'succeeded' | 'failed'; remoteId?: string },
): Promise<ExternalOperation> {
	const key = requireNonEmpty(operationKey, 'operationKey');
	const parsed = parseOr400(OperationReceiptInputSchema, receipt);
	const row = await operationByKey(db, key);
	const status = String(row['status']);
	if (status === parsed.outcome && row['receiptId'] === parsed.receiptId) {
		return operationFromRow(row); // idempotent receipt replay
	}
	if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
		throw new ScopeError(
			409,
			'receipt_conflict',
			`operation already settled as ${status} with a different receipt`,
		);
	}
	if (status === 'prepared') {
		throw new ScopeError(
			409,
			'operation_invalid_transition',
			'no dispatch on record — a receipt cannot fabricate completion',
		);
	}
	return operationFromRow(
		await transition(db, key, parsed.outcome, ['dispatched', 'cancel-requested', 'reconciliation-required'], {
			receiptId: parsed.receiptId,
			...(parsed.remoteId !== undefined ? { remoteId: parsed.remoteId } : {}),
		}),
	);
}

/**
 * Ambiguous dispatch (timeout / unknown outcome). NEVER a blind retry: the row
 * stops here until a real receipt reconciles it. The operation key is what the
 * provider correlation lookup goes by.
 */
export async function markReconciliationRequired(
	db: D1Database,
	operationKey: string,
): Promise<ExternalOperation> {
	const key = requireNonEmpty(operationKey, 'operationKey');
	return operationFromRow(await transition(db, key, 'reconciliation-required', ['dispatched']));
}

/**
 * Agent/run-facing cancel REQUEST. Distinct from cancellation: the remote may
 * keep running until a receipt proves termination.
 */
export async function requestCancel(db: D1Database, operationKey: string): Promise<ExternalOperation> {
	const key = requireNonEmpty(operationKey, 'operationKey');
	return operationFromRow(await transition(db, key, 'cancel-requested', ['prepared', 'dispatched']));
}

/** Record the provider receipt that PROVES termination (cancelled). */
export async function markCancelled(
	db: D1Database,
	operationKey: string,
	receiptId: string,
): Promise<ExternalOperation> {
	const key = requireNonEmpty(operationKey, 'operationKey');
	const receipt = requireNonEmpty(receiptId, 'receiptId');
	const row = await operationByKey(db, key);
	if (String(row['status']) === 'cancelled' && row['receiptId'] === receipt) {
		return operationFromRow(row); // idempotent replay
	}
	return operationFromRow(
		await transition(db, key, 'cancelled', ['cancel-requested', 'reconciliation-required'], {
			receiptId: receipt,
		}),
	);
}

// --- reads ------------------------------------------------------------------------

export async function getOperation(
	db: D1Database,
	operationKey: string,
): Promise<ExternalOperation | null> {
	const key = requireNonEmpty(operationKey, 'operationKey');
	const res = await db
		.prepare('select * from "external_operations" where "operationKey" = ?')
		.bind(key)
		.all();
	const row = (res.results ?? [])[0] as OperationRow | undefined;
	return row ? operationFromRow(row) : null;
}

/**
 * Provider correlation lookup (contracts: "support provider correlation lookup
 * or stop for reconciliation"): given the provider and the operation key we
 * sent as the idempotency key, find the logical operation — even when the
 * remote id was lost.
 */
export async function findOperationByProviderKey(
	db: D1Database,
	provider: string,
	operationKey: string,
): Promise<ExternalOperation | null> {
	const p = requireNonEmpty(provider, 'provider');
	const key = requireNonEmpty(operationKey, 'operationKey');
	const res = await db
		.prepare('select * from "external_operations" where "provider" = ? and "operationKey" = ?')
		.bind(p, key)
		.all();
	const row = (res.results ?? [])[0] as OperationRow | undefined;
	return row ? operationFromRow(row) : null;
}
