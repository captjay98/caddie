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
 *   1. elects one dispatcher (unique key → a duplicate is a typed no-op),
 *   2. hands the message to the DO via an injected `deliver` boundary
 *      (so the Worker self-fetch is testable and the runtime send stays at
 *      the edge), keyed by the SAME idempotency key the DO dedupes on,
 *   3. acks the pending slot on success, or marks reconciliation-required on
 *      an uncertain delivery — never a blind re-send that could double-fire.
 */

import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope, ScopeError } from './scope.ts';
import { readWorkflow, acknowledgeDispatch, type BuildWorkflow } from './build-workflow.ts';
import {
	prepareOperation,
	markDispatched,
	recordReceipt,
	markReconciliationRequired,
	getOperation,
} from './operations.ts';

const DISPATCH_PROVIDER = 'coordinator-dispatch';

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
	/** 'dispatched' = handed to the DO and acked; 'noop' = already owned/acked;
	 *  'reconcile' = delivery outcome uncertain, left for reconciliation;
	 *  'none' = nothing pending to dispatch. */
	outcome: 'dispatched' | 'noop' | 'reconcile' | 'none';
	operationKey?: string;
}

/**
 * Deliver whatever is pending for this project's workflow to the coordinator
 * DO, server-side. Idempotent: the unique operationKey elects one dispatcher,
 * so concurrent calls (a double-click, a retried HTTP request, a monitor tick)
 * collapse to one logical delivery. Safe to call after decide/retry/continue
 * and from a server-side reconcile sweep.
 */
export async function dispatchPendingWorkflow(
	db: D1Database,
	scope: Scope,
	deliver: CoordinatorDeliver,
): Promise<DispatchResult> {
	await assertProjectScope(db, scope);
	const workflow = await readWorkflow(db, scope);
	if (!workflow?.pendingKey || !workflow.pendingBody) return { outcome: 'none' };

	const key = workflow.pendingKey;
	const body = workflow.pendingBody;
	const conversationId = workflow.conversationId;

	// Elect exactly one dispatcher for this logical delivery. A second caller
	// loses on the unique key and must not re-deliver.
	const existing = await getOperation(db, key);
	if (existing) {
		// Already owned. If it reached a terminal/dispatched state, the ack
		// either happened or will on reconcile — never re-send here.
		if (existing.status === 'succeeded' || existing.status === 'dispatched') {
			await acknowledgeDispatch(db, scope, key);
			return { outcome: 'noop', operationKey: key };
		}
		if (existing.status === 'reconciliation-required') {
			return { outcome: 'reconcile', operationKey: key };
		}
		// prepared/failed/cancel-* — fall through to a single delivery attempt
		// only when still prepared; otherwise report reconcile.
		if (existing.status !== 'prepared') {
			return { outcome: 'reconcile', operationKey: key };
		}
	} else {
		try {
			await prepareOperation(db, {
				projectId: scope.projectId,
				runId: workflow.runId,
				provider: DISPATCH_PROVIDER,
				operationKey: key,
			});
		} catch (error) {
			if (error instanceof ScopeError && error.code === 'operation_key_conflict') {
				// Another dispatcher won the election between our read and insert.
				return { outcome: 'noop', operationKey: key };
			}
			throw error;
		}
	}

	// One delivery attempt. We optimistically mark the operation dispatched
	// BEFORE the send so an uncertain outcome can legally transition to
	// reconciliation-required (operations.ts allows reconcile only from
	// 'dispatched'). The DO dedupes on the idempotency key and its own onStart
	// drain owns re-delivery after a crash — so an uncertain outcome here is
	// reconciled, never blindly re-sent.
	await markDispatched(db, key, conversationId);
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

	// Delivered. Record the receipt (idempotent) and clear the pending slot so
	// the UI stops showing a pending dispatch. The receipt id is the key —
	// one logical delivery, one settlement.
	await recordReceipt(db, key, { receiptId: `delivered:${key}`, outcome: 'succeeded' });
	await acknowledgeDispatch(db, scope, key);
	return { outcome: 'dispatched', operationKey: key };
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
		const response = await app.fetch(
			new Request(url.href, {
				method: 'POST',
				headers,
				body: JSON.stringify({ message: { kind: 'user', body }, idempotencyKey }),
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
