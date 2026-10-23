/**
 * Part A — the Flue `instrument()` wiring for the spending limit (plan §A).
 *
 * Installed ONCE per isolate from app.ts (before the agent routers), this is
 * the observe()/interceptor pair that, for every `model` operation:
 *   - finds the build's payer for the turn (by instance/build lineage, see
 *     {@link resolveTurnPayer});
 *   - with no payer (ordinary chat), passes the call straight through;
 *   - with a payer, RESERVES the call's worst-case estimate BEFORE next(), in
 *     one conditional insert keyed by turnId. A refusal sets the build blocker
 *     and throws, so the call never reaches Token Factory. A duplicate turnId
 *     (the interceptor fires several times per turn — S1) reserves once;
 *   - after the call, SETTLES the reservation from that call's own usage (the
 *     paired `turn` event), or RELEASES it when the turn errored.
 *
 * The money logic lives in `server/build-spend.ts`; this module is the runtime
 * seam that calls it. Kept free of a hard dependency on the Cloudflare context
 * at module load: the DB handle and env come through the install closure
 * (app.ts hands the isolate's binding in), which the S1 spike proved is how the
 * interceptor reaches D1.
 */

import type { FlueEvent, FlueExecutionContext, FlueExecutionOperation, FlueInstrumentation } from '@flue/runtime';
import type { D1Database } from './auth.ts';
import { readSwitch, type SwitchEnv } from './platform-switches.ts';
import {
	costliestRoute,
	estimateCallMicros,
	payerLimitMicros,
	release,
	reserve,
	routeByModelId,
	settle,
	settleMicrosFromCost,
	SpendLimitError,
} from './build-spend.ts';

// --- the isolate payer registry (instance/build lineage) --------------------
//
// A build's turns do not all share one conversationId: a delegate runs in a
// detached `task:default:...` sub-session with its OWN conversationId but the
// SAME instanceId as its coordinator, and a dispatched module builder is its
// own instance entirely (S1 findings Q1/Q6). So the payer is attributed by the
// build the turn belongs to, resolved through a small per-isolate map keyed by
// BOTH the instanceId and the conversationId a build is known under. The
// coordinator-host registers the coordinator's ids when it opens the payer;
// part P's module builders register their own instance id against the same
// build payer through {@link registerBuildPayerForInstance}.

const payerByKey = new Map<string, string>();

/** Register that a build identity (an instanceId or conversationId) pays through `payerId`. */
export function registerBuildPayer(key: string, payerId: string): void {
	if (key) payerByKey.set(key, payerId);
}

/**
 * The hook part P's module builders call to reach their build's payer. A module
 * builder's instance id is `<projectId>:<buildSeq>:<moduleId>` (plan part P);
 * binding it here makes every model call that builder makes charge the build's
 * shared payer, so parallel module builders share one limit (plan §A step 4).
 */
export function registerBuildPayerForInstance(instanceId: string, payerId: string): void {
	registerBuildPayer(instanceId, payerId);
}

/** Forget a build's payer mappings (e.g. when a build ends). Best-effort cleanup. */
export function forgetBuildPayer(keys: string[]): void {
	for (const key of keys) payerByKey.delete(key);
}

/** Test-only: clear the whole registry between cases. */
export function _resetPayerRegistry(): void {
	payerByKey.clear();
}

/**
 * Thrown by {@link resolveTurnPayer} when a ModuleBuilder turn (part P) has no
 * payer. A module builder runs in its own Durable Object whose isolate registry
 * starts empty, and every model call it (or its delegates) makes MUST be charged
 * to the build's shared payer (plan §A step 4). If the module's `build_modules`
 * row carries no payer, the turn is REFUSED rather than passing through
 * unmetered: the throw propagates out of the interceptor and fails the model
 * call before it reaches Token Factory. (Ordinary chat, which has no module row,
 * still passes through — only a real module-builder turn with a missing payer
 * refuses.)
 */
export class ModulePayerMissingError extends Error {
	readonly code = 'module_payer_missing';
	readonly instanceId: string;
	constructor(instanceId: string) {
		super(`This module build has no spending payer, so its model call was refused. (instance ${instanceId})`);
		this.name = 'ModulePayerMissingError';
		this.instanceId = instanceId;
	}
}

/**
 * A ModuleBuilder instance id is `<projectId>:<buildSeq>:<moduleId>` (plan part
 * P). This is a cheap structural test — three colon-separated parts whose middle
 * is a non-negative integer — used only to decide WHETHER to consult
 * build_modules; the row lookup is the authority.
 */
function looksLikeModuleInstance(instanceId: string): boolean {
	const parts = instanceId.split(':');
	return parts.length === 3 && parts[0].length > 0 && parts[2].length > 0 && /^\d+$/.test(parts[1]);
}

/**
 * Resolve the payer for a turn, by lineage. Tries the registry first (instance,
 * then conversation); then, for a ModuleBuilder turn (part P), the build's
 * shared payer from its `build_modules` row; then falls back to D1: a
 * coordinator's conversationId is stored on its `build_workflows` row as
 * `spendPayerId`. Returns null when no build owns the turn (ordinary chat),
 * which means "pass through".
 *
 * REFUSAL (part P / plan §A step 4): when the turn's instance id is a module
 * builder's AND its `build_modules` row carries no payer, this THROWS
 * {@link ModulePayerMissingError} rather than returning null — a module builder's
 * model call must never pass through unmetered. Ordinary chat (no module row)
 * still passes through.
 */
export async function resolveTurnPayer(db: D1Database, ctx: FlueExecutionContext): Promise<string | null> {
	const instanceId = ctx.instanceId ?? '';
	const conversationId = ctx.conversationId ?? '';
	if (instanceId && payerByKey.has(instanceId)) return payerByKey.get(instanceId)!;
	if (conversationId && payerByKey.has(conversationId)) return payerByKey.get(conversationId)!;

	// Part P: a ModuleBuilder (and its delegates, which share its instance id)
	// is charged to its build's shared payer, read from the module's
	// build_modules row by its derived instance id. A module row with no payer is
	// a REFUSAL, not a pass-through — the module build must never run unmetered.
	// The registry (populated by modules.ts via registerBuildPayerForInstance
	// when a module starts) is the fast path above; this is the durable fallback,
	// and it is the live path in a fresh module-builder DO whose registry is empty.
	if (looksLikeModuleInstance(instanceId)) {
		const moduleRow = (
			await db
				.prepare(
					'select "payerId" from "build_modules" where ? = ("projectId" || \':\' || "buildSeq" || \':\' || "moduleId") limit 1',
				)
				.bind(instanceId)
				.all<{ payerId: string | null }>()
		).results?.[0];
		// A real module row exists for this instance: its payer is authoritative.
		if (moduleRow) {
			if (moduleRow.payerId) return moduleRow.payerId;
			throw new ModulePayerMissingError(instanceId);
		}
		// No module row: only Caddie dispatches ids of this shape (ModuleBuilder
		// is dispatch-only; chat and coordinator ids are conv_<hex>), so this is a
		// lost or broken module build. Refuse: it must never run unmetered.
		throw new ModulePayerMissingError(instanceId);
	}
	// A ModuleBuilder's own turn under any other id (a malformed dispatch) has no
	// build to charge either: refuse rather than fall through to chat.
	if (ctx.agentName === 'ModuleBuilder') throw new ModulePayerMissingError(instanceId);

	// D1, read fresh on every call: Caddie addresses a build's coordinator as
	// /agents/coordinator/<build_workflows.conversationId>, and Flue makes that
	// URL id the agent's instanceId (a delegate shares it). Flue's own
	// ctx.conversationId is a different, internal id, so the row is matched on
	// the instanceId first. The coordinator runs in its own Durable Object, whose
	// registry starts empty, so this is the live path. Nothing is cached: a retry
	// stores a fresh payer on the same row, and the next call must see it.
	const keys = [instanceId, conversationId].filter((key) => key.length > 0);
	if (keys.length === 0) return null;
	const row = (
		await db
			.prepare(
				`select "spendPayerId" from build_workflows where "conversationId" in (${keys.map(() => '?').join(',')}) and "spendPayerId" is not null limit 1`,
			)
			.bind(...keys)
			.all<{ spendPayerId: string }>()
	).results?.[0];
	return row?.spendPayerId ?? null;
}

// --- request-size tracking for the estimate ---------------------------------
//
// The paired observer sees `turn_request` (the whole request) before the model
// interceptor runs for that turnId (S1 Q4). We stash each turn's request
// character length so the estimate can size the input from it; if it hasn't
// arrived, the estimate falls back to the route's context window.

const requestCharsByTurn = new Map<string, number>();

/** Character length of a model request's payload (system prompt + messages + tools). */
function requestCharLength(request: Extract<FlueEvent, { type: 'turn_request' }>['request']): number {
	const input = request.input;
	let chars = input.systemPrompt?.length ?? 0;
	for (const message of input.messages ?? []) chars += JSON.stringify(message).length;
	for (const tool of input.tools ?? []) chars += JSON.stringify(tool).length;
	return chars;
}

// --- the blocker hook --------------------------------------------------------

/** How the instrument sets a build's blocker when a reservation is refused. */
export type SetBlocker = (payerId: string, message: string) => void | Promise<void>;

export interface SpendInstrumentConfig {
	/**
	 * The isolate's D1 handle and switch env. In tests a fixed handle is passed.
	 * On the live Cloudflare isolate there is no request-scoped binding at
	 * install time, so app.ts passes {@link resolve} instead, which reads
	 * `getCloudflareContext().env` inside each operation (valid because the
	 * interceptor and the `turn` observer both run inside the DO request
	 * handler's async context — S1 proved D1 is reachable there). Exactly one of
	 * `db` or `resolve` must be provided.
	 */
	db?: D1Database;
	/** The env the switches read (for `spend_enforcement`). Used with a fixed `db`. */
	env?: SwitchEnv | null;
	/**
	 * Lazily resolve the D1 handle and switch env per operation (live isolate).
	 * Returns null when no context is available (e.g. a turn event fired outside
	 * a request), in which case the spend logic is skipped for that event.
	 */
	resolve?: () => { db: D1Database; env?: SwitchEnv | null } | null;
	/**
	 * Set the build blocker for a refused payer. app.ts wires this to the
	 * build-workflow blocker; omitted in tests, where the throw itself is the
	 * assertion. Blocker-setting never blocks the throw: a failing hook is
	 * swallowed so the call is still refused.
	 */
	setBlocker?: SetBlocker;
}

/**
 * Build the `instrument()` instrumentation object for part A. Install the
 * RESULT once per isolate in app.ts: `instrument(makeSpendInstrumentation(...))`.
 */
export function makeSpendInstrumentation(config: SpendInstrumentConfig): FlueInstrumentation {
	/** Resolve {db, env} for one operation, from the fixed handle or the resolver. */
	function context(): { db: D1Database; env?: SwitchEnv | null } | null {
		if (config.resolve) return config.resolve();
		if (config.db) return { db: config.db, env: config.env };
		return null;
	}

	return {
		observe(event: FlueEvent) {
			if (event.type === 'turn_request') {
				requestCharsByTurn.set(event.turnId, requestCharLength(event.request));
				rememberTurnModel(event.turnId, event.request.requestedModel);
				return;
			}
			if (event.type === 'turn') {
				// Settle or release from the leaf turn's own usage. isError → release
				// (the call failed; hand the worst-case estimate back); otherwise
				// settle the call's actual cost. Fire-and-forget: the turn event is
				// observe-only and must not throw back into the runtime.
				const turnId = event.turnId;
				requestCharsByTurn.delete(turnId);
				routeModelByTurn.delete(turnId);
				const resolved = safeContext(context);
				if (!resolved) return;
				const { db } = resolved;
				if (event.isError) {
					void release(db, turnId).catch(() => {});
				} else {
					const micros = settleMicrosFromCost(event.response.usage?.cost.total);
					void settle(db, turnId, micros).catch(() => {});
				}
			}
		},

		interceptor: async <T>(
			operation: FlueExecutionOperation,
			ctx: FlueExecutionContext,
			next: () => Promise<T>,
		): Promise<T> => {
			if (operation.type !== 'model') return next();
			const turnId = ctx.turnId ?? operation.turnId;

			const resolved = safeContext(context);
			// No context (e.g. called outside a request): cannot price or reserve;
			// pass straight through rather than risk a throw from a missing handle.
			if (!resolved) return next();
			const { db, env } = resolved;

			const payerId = await resolveTurnPayer(db, ctx);
			// No payer (ordinary chat): pass straight through (plan §A step 2).
			if (!payerId) return next();

			const enforcement = await readSwitch(db, env, 'spend_enforcement');

			// The requested model is on turn_request (the ctx does not carry it), so
			// the route is resolved from the model the observer stashed for this
			// turn. When it can't be resolved (an unknown model id, or turn_request
			// has not arrived), the call is priced at the costliest route's worst
			// case: a paying build never makes an unpriced call (lead fix,
			// 2026-10-23). The settle path still records the turn's real usage.
			const requestChars = requestCharsByTurn.get(turnId);
			const resolvedRoute = resolveRouteForTurn(turnId);
			const route = resolvedRoute ?? costliestRoute();

			const estimateMicros = estimateCallMicros(route, requestChars);
			const result = await reserve(db, {
				payerId,
				turnId,
				conversationId: ctx.conversationId ?? '',
				estimateMicros,
			});

			if (result.outcome === 'refused') {
				// spend_enforcement=off: record the refusal intent but never block —
				// release any row and pass through (plan §A step 7, kill switch).
				if (enforcement === 'off') return next();
				const limitMicros = (await payerLimitMicros(db, payerId)) ?? 0;
				const error = new SpendLimitError(payerId, limitMicros);
				if (config.setBlocker) {
					try {
						await config.setBlocker(payerId, error.message);
					} catch {
						// A failing blocker hook must not swallow the refusal.
					}
				}
				throw error;
			}

			// reserved or duplicate: the call proceeds. A duplicate (the interceptor
			// re-fired for a turn already reserved) is NOT the limit (plan §A step 2).
			return next();
		},

		dispose() {
			payerByKey.clear();
			requestCharsByTurn.clear();
			routeModelByTurn.clear();
		},
	};
}

// --- route resolution for a turn --------------------------------------------
//
// The interceptor ctx does not carry the requested model, but the observer saw
// it on turn_request. We stash the route id per turn alongside the request
// size so the interceptor can price the call.

/** Resolve {db, env} without ever throwing (a missing context becomes null). */
function safeContext(
	resolve: () => { db: D1Database; env?: SwitchEnv | null } | null,
): { db: D1Database; env?: SwitchEnv | null } | null {
	try {
		return resolve();
	} catch {
		return null;
	}
}

const routeModelByTurn = new Map<string, string>();

/** Record the requested model for a turn (called from observe on turn_request). */
function rememberTurnModel(turnId: string, requestedModel: string): void {
	routeModelByTurn.set(turnId, requestedModel);
}

/** The route a turn requested, or null when unknown / not a frozen route. */
function resolveRouteForTurn(turnId: string) {
	const requestedModel = routeModelByTurn.get(turnId);
	return routeByModelId(requestedModel);
}
