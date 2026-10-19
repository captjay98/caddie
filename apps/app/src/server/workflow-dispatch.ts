/**
 * Server-owned durable dispatch (R02, plan §5 "Durable orchestration and
 * handoff"; narrowed per the plan's R02 scope note).
 *
 * BEFORE: after an approval the server parked `(pendingKey, pendingBody)` in
 * `build_workflows` and relied on the BROWSER (`client/conversation/
 * workflow-dispatch.ts` → `resumeWorkflow`) to call the coordinator agent.
 * A tab closed between the approval write and that client send left the
 * intent recorded but never delivered — the build never started.
 *
 * AFTER: the server delivers the pending message to the coordinator DO itself,
 * at approval/retry/continue time, electing exactly one dispatcher through the
 * existing `external_operations` ledger (unique operationKey = the pending
 * key). Flue's coordinator DO already drains unsettled submissions on
 * `onStart` (30s lease + 15s scan, same-submissionId replacement — LIVE
 * VERIFIED after whole-runtime SIGKILL per docs/flue-contracts.md), so once
 * the message reaches the DO, durability and crash re-delivery are the
 * runtime's job, not ours. The client is reduced to OBSERVING workflow state.
 *
 * We do NOT build a second lease/drain engine. This module only:
 *   1. elects one sender per lease (one conditional UPDATE, claimForDelivery),
 *   2. hands the message to the DO via an injected `deliver` boundary
 *      (so the Worker self-fetch is testable and the runtime send stays at
 *      the edge), keyed by the SAME idempotency key the DO dedupes on,
 *   3. records the receipt and clears the pending slot ONLY after a 2xx. Any
 *      attempt that did not end in a recorded 2xx (a Worker that stopped
 *      mid-send, a non-2xx, a thrown send) keeps the message and is sent again
 *      after REDELIVERY_AFTER_MS with the same key. Flue 2.2.2 converges a
 *      keyed resend of the same message on the original submission, so a
 *      resend after the DO did admit the first one cannot start a second turn
 *      (review 2026-10-19 F01: the old code read "dispatched" as delivered and
 *      cleared the slot, so a crash before admission lost the message).
 *   4. recovers stranded handoffs when the project is polled
 *      (recoverStalledDispatch, from GET /experience).
 */

import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope, ScopeError } from './scope.ts';
import { readWorkflow, acknowledgeDispatch, type BuildWorkflow } from './build-workflow.ts';
import {
	prepareOperation,
	claimForDelivery,
	recordReceipt,
	markReconciliationRequired,
	getOperation,
} from './operations.ts';
import { signInternalDispatch } from './internal-dispatch.ts';
import { lookupRunByConversation } from './runs.ts';

const DISPATCH_PROVIDER = 'coordinator-dispatch';

/** How long an unconfirmed delivery is left alone before it is sent again. */
export const REDELIVERY_AFTER_MS = 2 * 60_000;

/**
 * How a message reaches the coordinator conversation. Injected so the HTTP /
 * runtime boundary stays at the Worker edge and this module is unit-testable
 * with a fake. The real implementation self-delivers to
 * `/agents/coordinator/:conversationId` (same-process `app.fetch`), carrying
 * the idempotency key the Flue DO dedupes on.
 */
export type CoordinatorDeliver = (input: {
	conversationId: string;
	body: string;
	idempotencyKey: string;
}) => Promise<{ delivered: boolean }>;

export interface DispatchResult {
	/** 'dispatched' = this call handed it to the coordinator and got a 2xx;
	 *  'noop' = a 2xx was already recorded, so only the slot was cleared;
	 *  'in-flight' = another attempt is recent, so nothing was sent now;
	 *  'reconcile' = this attempt got no 2xx (kept; retried after the lease),
	 *  or the operation was failed/cancelled and needs a person;
	 *  'none' = nothing pending to dispatch. */
	outcome: 'dispatched' | 'noop' | 'in-flight' | 'reconcile' | 'none';
	operationKey?: string;
}

export interface DispatchOptions {
	/** Epoch ms for the lease check (tests pass a later clock). */
	readonly now?: number;
}

/**
 * Deliver whatever is pending for this project's workflow to the coordinator
 * DO, server-side (review 2026-10-19 F01).
 *
 * The pending message is cleared ONLY after a delivery got a 2xx and that was
 * recorded. Any other state keeps it:
 *   - an attempt in flight, or one that ended without a 2xx, is left alone for
 *     REDELIVERY_AFTER_MS, then sent again with the SAME idempotency key. The
 *     pinned Flue runtime (2.2.2, adoptKeyedSubmissionReplay) converges a keyed
 *     resend of the same message on the original submission, so a resend after
 *     the coordinator did admit the first one cannot start a second turn;
 *   - a Worker that died after "dispatched" and before the coordinator admitted
 *     it is therefore recovered by the next call after the lease, instead of
 *     the old behaviour of reading "dispatched" as delivered and dropping it.
 * One conditional UPDATE (claimForDelivery) elects the sender, so concurrent
 * callers (a double-click, a retried request, a poll) send at most once per
 * lease. Safe to call from any authenticated request for the project.
 */
export async function dispatchPendingWorkflow(
	db: D1Database,
	scope: Scope,
	deliver: CoordinatorDeliver,
	options: DispatchOptions = {},
): Promise<DispatchResult> {
	await assertProjectScope(db, scope);
	const workflow = await readWorkflow(db, scope);
	if (!workflow?.pendingKey || !workflow.pendingBody) return { outcome: 'none' };

	const key = workflow.pendingKey;
	const body = workflow.pendingBody;
	const conversationId = workflow.conversationId;
	const now = options.now ?? Date.now();

	let existing = await getOperation(db, key);
	if (!existing) {
		try {
			await prepareOperation(db, {
				projectId: scope.projectId,
				runId: workflow.runId,
				provider: DISPATCH_PROVIDER,
				operationKey: key,
			});
		} catch (error) {
			if (!(error instanceof ScopeError && error.code === 'operation_key_conflict')) throw error;
			// Another dispatcher prepared it between our read and insert.
			existing = await getOperation(db, key);
		}
	}
	if (existing?.status === 'succeeded') {
		// The coordinator accepted it and that was recorded; only clearing the
		// slot was lost (e.g. the Worker stopped right after the receipt).
		await acknowledgeDispatch(db, scope, key);
		return { outcome: 'noop', operationKey: key };
	}
	if (existing && !['prepared', 'dispatched', 'reconciliation-required'].includes(existing.status)) {
		// failed / cancel-requested / cancelled: not ours to resend.
		return { outcome: 'reconcile', operationKey: key };
	}
	const claimed = await claimForDelivery(
		db,
		key,
		conversationId,
		new Date(now).toISOString(),
		new Date(now - REDELIVERY_AFTER_MS).toISOString(),
	);
	if (!claimed) return { outcome: 'in-flight', operationKey: key };

	try {
		const result = await deliver({ conversationId, body, idempotencyKey: key });
		if (!result.delivered) {
			await markReconciliationRequired(db, key);
			return { outcome: 'reconcile', operationKey: key };
		}
	} catch {
		await markReconciliationRequired(db, key);
		return { outcome: 'reconcile', operationKey: key };
	}

	// Accepted. Record the receipt (idempotent) and only then clear the pending
	// slot. The receipt id is the key: one logical delivery, one settlement.
	await recordReceipt(db, key, { receiptId: `delivered:${key}`, outcome: 'succeeded' });
	await acknowledgeDispatch(db, scope, key);
	return { outcome: 'dispatched', operationKey: key };
}

/**
 * Whether this project's pending message looks stranded (review F01): kept
 * but not delivered, with nothing having happened for REDELIVERY_AFTER_MS.
 * That covers a Worker that stopped between writing the message and sending
 * it (no operation row yet), one that stopped mid-send ('dispatched' or
 * 'prepared'), a delivery that got no 2xx ('reconciliation-required'), and
 * one whose 2xx was recorded but whose slot was not cleared ('succeeded').
 * A message written or sent within the lease is left to its own sender.
 */
export async function needsRedelivery(db: D1Database, scope: Scope, now: number = Date.now()): Promise<boolean> {
	const workflow = await readWorkflow(db, scope);
	if (!workflow?.pendingKey || !workflow.pendingBody) return false;
	const staleBefore = now - REDELIVERY_AFTER_MS;
	const rows = await db
		.prepare('select "status", "updatedAt" from "external_operations" where "operationKey" = ?')
		.bind(workflow.pendingKey)
		.all();
	const op = (rows.results ?? [])[0] as { status?: string; updatedAt?: string } | undefined;
	if (!op) return Date.parse(workflow.updatedAt) < staleBefore;
	if (op.status === 'succeeded') return true;
	if (!['prepared', 'dispatched', 'reconciliation-required'].includes(String(op.status))) return false;
	return Date.parse(String(op.updatedAt)) < staleBefore;
}

/**
 * Re-send a stranded handoff, if there is one. Called when the project's
 * state is polled (GET /experience, every 3 s while a project or the Projects
 * list is open), so a lost handoff recovers within one lease of the user
 * looking, with the same key and at most one send per lease.
 */
export async function recoverStalledDispatch(
	db: D1Database,
	scope: Scope,
	deliver: CoordinatorDeliver,
	now: number = Date.now(),
): Promise<DispatchResult | null> {
	if (!(await needsRedelivery(db, scope, now))) return null;
	// The conversation guard admits only its owner, so another member's poll
	// would only collect refusals: leave the resend to the owner.
	const workflow = await readWorkflow(db, scope);
	const owner = workflow ? await lookupRunByConversation(db, workflow.conversationId) : null;
	if (!owner || owner.createdBy !== scope.actorId) return null;
	return dispatchPendingWorkflow(db, scope, deliver, { now });
}

/**
 * The real delivery boundary: self-fetch the in-process Worker so the server
 * owns the coordinator send. `app` is the Hono fetch handler; `origin` is the
 * request origin to resolve the agent URL against. Carries the idempotency key
 * and the authenticated cookie header so the /agents guard admits it.
 *
 * `env` (and `executionCtx`) MUST be the current request's Worker bindings: a
 * bare `app.fetch(request)` runs the self-request with `c.env === undefined`,
 * so the /agents guard's session probe throws, the delivery is not 2xx and the
 * intake is parked in reconciliation-required forever — the project sits on
 * "Caddie is turning your request into a plan" with nothing running.
 */
export function workerSelfDeliver(
	app: { fetch(request: Request, env?: unknown, executionCtx?: unknown): Promise<Response> | Response },
	origin: string,
	cookieHeader: string | null,
	env: unknown,
	executionCtx?: unknown,
): CoordinatorDeliver {
	return async ({ conversationId, body, idempotencyKey }) => {
		const url = new URL(`/agents/coordinator/${encodeURIComponent(conversationId)}`, origin);
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (cookieHeader) headers['cookie'] = cookieHeader;
		// S07: mark the delivery as server-originated. The guard admits it
		// without counting it against the judge's message quota; without this
		// HMAC the server's own intake would consume a judge's messages.
		await signInternalDispatch(env, headers, conversationId);
		const response = await app.fetch(
			new Request(url.href, {
				method: 'POST',
				headers,
				// The Flue conversation route admits the DeliveredMessage FLAT, with
				// send controls as siblings — exactly what @flue/sdk send() posts
				// (`{ idempotencyKey, kind, body }`). A nested `{ message: {...} }`
				// is not a message: it was rejected, parking every intake in
				// reconciliation-required.
				body: JSON.stringify({ idempotencyKey, kind: 'user', body }),
			}),
			env,
			executionCtx,
		);
		// A 2xx means the DO admitted the submission; anything else is uncertain
		// and must reconcile rather than silently drop.
		return { delivered: response.ok };
	};
}

export type { BuildWorkflow };
