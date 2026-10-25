/** Direct HTTP helpers share privacy-safe per-call receipts with agent turns.
 * No usage is fabricated: absent provider counts stay NULL. Cost is a catalog
 * estimate from reported counts under the frozen route, never a billed charge.
 */
import type { D1Database } from './auth.ts';
import { findModelRouteForRole, type ModelRole } from '../agents/providers.ts';
import { persistModelCall, type ModelCallRecord } from './model-call-instrument.ts';

export interface HelperAccounting { db: D1Database; projectId?: string }
type HelperRole = Extract<ModelRole, 'helperRules' | 'helperRanking' | 'helperSummary'>;
const REASON: Record<HelperRole, string> = { helperRules: 'rules_extraction', helperRanking: 'candidate_ranking', helperSummary: 'candidate_summary' };
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function count(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }

/** Same response contract as the helpers need, parsed exactly once. Network or
 * successful-response JSON failures still record an issued call with unknown
 * usage before rethrowing to the existing fail-soft caller.
 */
export async function helperModelCompletion(input: {
	role: HelperRole;
	accounting?: HelperAccounting;
	url: string;
	request: RequestInit;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
	const route = findModelRouteForRole(input.role);
	// The receipt describes the issued wire request, not merely the role label.
	const requested = typeof input.request.body === 'string' ? object(JSON.parse(input.request.body)) : {};
	if (requested.model !== route.modelId || new URL(input.url).origin !== 'https://api.tokenfactory.nebius.com') throw new Error('Helper model request does not match its registered route');
	const started = Date.now();
	let response: Response | undefined;
	let body: unknown;
	let failed = false;
	try {
		response = await fetch(input.url, input.request);
		failed = !response.ok;
		try { body = await response.json(); } catch (error) { if (response.ok) throw error; }
		return { ok: response.ok, status: response.status, body };
	} catch (error) { failed = true; throw error; }
	finally {
		if (input.accounting) {
			const parsed = object(body);
			const usage = object(parsed.usage);
			const inputTokens = count(usage.prompt_tokens);
			const outputTokens = count(usage.completion_tokens);
			const estimate = inputTokens === null || outputTokens === null ? null : Math.ceil((inputTokens * route.inputPriceMinorUnits + outputTokens * route.outputPriceMinorUnits) / 100);
			const record: ModelCallRecord = {
				turnId: `helper_${crypto.randomUUID()}`, instanceId: input.accounting.projectId ?? null, conversationId: null, submissionId: null,
				agentName: 'direct-helper', purpose: 'helper', providerId: route.providerId, requestedModel: route.modelId,
				responseModel: typeof parsed.model === 'string' ? parsed.model : null,
				routeId: route.id, pricingVersion: route.pricingVersion, currency: route.currency, selectedRole: input.role, selectionReason: REASON[input.role],
				inputTokens, outputTokens, cacheReadTokens: count(object(usage.prompt_tokens_details).cached_tokens), cacheWriteTokens: null,
				totalTokens: count(usage.total_tokens), catalogCostMicros: estimate !== null && Number.isSafeInteger(estimate) ? estimate : null,
				durationMs: Math.max(0, Date.now() - started), isError: failed, createdAt: new Date().toISOString(),
			};
			// Observability failure must not turn successful extraction into a fake
			// model failure or suppress the caller's real network/JSON exception.
			try { await persistModelCall(input.accounting.db, record); }
			catch { console.error('Helper model call accounting write unavailable'); }
		}
	}
}
