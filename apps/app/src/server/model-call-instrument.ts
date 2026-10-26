/** Privacy-safe, leaf-level model accounting. Flue 2.2.2 `turn` is one call;
 * operation/response rollups must never be summed into this ledger again.
 * Catalog cost is an estimate, never a provider invoice or a budget charge.
 * Missing usage stays NULL; it is not reported as free work.
 * Returned observer writes are tracked by Flue 2.2.2 and drained through its
 * Cloudflare invocation waitUntil boundary. This is best effort on process
 * termination, not a replayable or transactional billing ledger.
 */
import type { FlueEvent, FlueInstrumentation } from '@flue/runtime';
import type { D1Database } from './auth.ts';
import { MODEL_ROUTES, MODEL_ROLES, type ModelRole } from '../agents/providers.ts';

export const MODEL_SELECTION_LOG = 'caddie.model_selection';
const REASONS = new Set(['image_attachment', 'background_execution', 'routine_status', 'execution_request', 'explicit_ideation', 'active_ideation', 'default_chat']);
interface Selection { role: ModelRole; reason: string; routeId: string }
type Turn = Extract<FlueEvent, { type: 'turn' }>;

function selectionKey(event: FlueEvent): string {
	// Task identity matters: delegates share an instance but select their own model.
	return JSON.stringify([event.instanceId ?? '', event.conversationId ?? '', event.submissionId ?? '', event.taskId ?? '']);
}
function numberOrNull(value: unknown, integer = false): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;
}

export interface ModelCallRecord {
  finishReason?: string | null; providerFinishReason?: string | null; outputKind?: string;
	turnId: string; instanceId: string | null; conversationId: string | null; submissionId: string | null;
	agentName: string | null; purpose: string; providerId: string; requestedModel: string; responseModel: string | null;
	routeId: string | null; pricingVersion: string | null; currency: string | null;
	selectedRole: string | null; selectionReason: string;
	inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null;
	catalogCostMicros: number | null; durationMs: number | null; isError: boolean; createdAt: string;
}

/** Actual request wins. Never substitute a run binding or an intended selection. */
export function modelCallRecord(event: Turn, selection?: Selection): ModelCallRecord {
	const route = MODEL_ROUTES.find(route => route.providerId === event.request.providerId && route.modelId === event.request.requestedModel);
	const selected = route && selection?.routeId === route.id ? selection : undefined;
	const usage = event.response.usage;
	const cost = numberOrNull(usage?.cost?.total);
	const costMicros = cost === null ? null : Math.ceil(cost * 1_000_000);
  const finish = (value: unknown) => typeof value==='string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : null;
  const content=event.response.output?.content??[];
  const outputKind=content.some(part=>part.type==='text'&&part.text.trim())?'text':content.some(part=>part.type==='toolCall')?'tool-only':'empty';
	return {
    finishReason:finish(event.response.finishReason),providerFinishReason:finish(event.response.providerFinishReason),outputKind,
		turnId: event.turnId, instanceId: event.instanceId ?? null, conversationId: event.conversationId ?? null,
		submissionId: event.submissionId ?? null, agentName: event.agentName ?? null, purpose: event.purpose,
		providerId: event.request.providerId, requestedModel: event.request.requestedModel, responseModel: event.response.responseModel ?? null,
		routeId: route?.id ?? null, pricingVersion: route?.pricingVersion ?? null, currency: route?.currency ?? null,
		selectedRole: selected?.role ?? null,
		selectionReason: event.purpose !== 'agent' ? event.purpose : selected?.reason ?? (selection ? 'selection_model_mismatch' : 'selection_not_reported'),
		inputTokens: numberOrNull(usage?.input, true), outputTokens: numberOrNull(usage?.output, true),
		cacheReadTokens: numberOrNull(usage?.cacheRead, true), cacheWriteTokens: numberOrNull(usage?.cacheWrite, true), totalTokens: numberOrNull(usage?.totalTokens, true),
		catalogCostMicros: costMicros !== null && Number.isSafeInteger(costMicros) ? costMicros : null,
		durationMs: numberOrNull(event.durationMs), isError: event.isError, createdAt: event.timestamp,
	};
}

export async function persistModelCall(db: D1Database, record: ModelCallRecord): Promise<void> {
	const fields = Object.keys(record) as Array<keyof ModelCallRecord>;
	// Immutable first receipt keyed by runtime turn id: a repeated observation
	// cannot double-count. Do not overwrite a historical model/pricing snapshot.
	await db.prepare(`insert or ignore into "model_call_usage" (${fields.map(field => `"${field}"`).join(',')}) values (${fields.map(() => '?').join(',')})`)
		.bind(...fields.map(field => field === 'isError' ? Number(record[field]) : record[field])).run();
}

export function makeModelCallInstrumentation(config: {
	resolve: () => D1Database | null;
	/** Optional platform waitUntil bridge; observer promises are not awaited by Flue. */
	defer?: (write: Promise<void>) => void;
	onError?: () => void;
}): FlueInstrumentation {
	const selections = new Map<string, Selection>();
	return {
		observe(event: FlueEvent) {
			const key = selectionKey(event);
			if (event.type === 'log' && event.message === MODEL_SELECTION_LOG) {
				const { role, reason, routeId } = event.attributes ?? {};
				if (typeof role === 'string' && Object.hasOwn(MODEL_ROLES, role) && typeof reason === 'string' && REASONS.has(reason) && MODEL_ROLES[role as ModelRole] === routeId) {
					// Bounded even if a process dies before settlement.
					if (selections.size >= 256) selections.delete(selections.keys().next().value!);
					selections.set(key, { role: role as ModelRole, reason, routeId: String(routeId) });
				}
				return;
			}
			if (event.type === 'submission_settled') {
				for (const candidate of selections.keys()) {
					const [instance, , submission] = JSON.parse(candidate) as string[];
					if (instance === (event.instanceId ?? '') && submission === (event.submissionId ?? '')) selections.delete(candidate);
				}
				return;
			}
			if (event.type !== 'turn') return;
			let db: D1Database | null;
			try { db = config.resolve(); } catch { config.onError?.(); return; }
			if (!db) return;
			const write = persistModelCall(db, modelCallRecord(event, selections.get(key))).catch(() => { config.onError?.(); });
			config.defer?.(write);
			return write;
		},
		interceptor: (_operation, _ctx, next) => next(),
		dispose() { selections.clear(); },
	};
}
