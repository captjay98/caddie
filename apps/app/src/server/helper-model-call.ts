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

/**
 * B02 §B — transient-retry policy for the DIRECT helper fetch. The
 * coordinator/specialist path is already retried by Flue
 * (MAX_TRANSIENT_MODEL_RETRIES = 3); this is the one un-retried path, so it
 * gets its OWN bounded policy — never a second wrapper around Flue's.
 */
const HELPER_MAX_RETRIES = 2; // physical retries AFTER the original request
const HELPER_MAX_RETRY_DELAY_MS = 10_000;

/** 429 (rate limit), 408/409 and any 5xx (incl. 529 overloaded) are transient. */
export function isTransientHelperStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Retry-After (seconds or HTTP-date), bounded; falls back to a small backoff. */
export function helperRetryDelayMs(headers: Headers, attempt: number, maxDelayMs = HELPER_MAX_RETRY_DELAY_MS): number {
	const header = headers.get('retry-after');
	if (header) {
		const seconds = Number.parseFloat(header);
		const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
		if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, maxDelayMs);
	}
	// Exponential-ish default backoff, bounded.
	return Math.min(200 * 2 ** attempt, maxDelayMs);
}

/** Same response contract as the helpers need, parsed exactly once. Network or
 * successful-response JSON failures still record an issued call with unknown
 * usage before rethrowing to the existing fail-soft caller.
 */
export async function helperModelCompletion(input: {
	role: HelperRole;
	accounting?: HelperAccounting;
	url: string;
	request: RequestInit;
	/** Injectable sleep so tests run without real delays. */
	sleepMs?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
	const route = findModelRouteForRole(input.role);
	// The receipt describes the issued wire request, not merely the role label.
	const requested = typeof input.request.body === 'string' ? object(JSON.parse(input.request.body)) : {};
	if (requested.model !== route.modelId || new URL(input.url).origin !== 'https://api.tokenfactory.nebius.com') throw new Error('Helper model request does not match its registered route');
	const sleep = input.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const started = Date.now();
	let response: Response | undefined;
	let body: unknown;
	let failed = false;
	try {
		// One original request plus at most HELPER_MAX_RETRIES transient retries.
		// A 429/529/5xx is retried with a bounded Retry-After delay; a client
		// error (4xx except 408/409/429) or a success returns immediately. The
		// accounting receipt is recorded ONCE (the finally), for the final
		// attempt — retries never multiply the receipt.
		for (let attempt = 0; ; attempt++) {
			response = await fetch(input.url, input.request);
			failed = !response.ok;
			try { body = await response.json(); } catch (error) { if (response.ok) throw error; }
			if (response.ok || attempt >= HELPER_MAX_RETRIES || !isTransientHelperStatus(response.status)) {
				return { ok: response.ok, status: response.status, body };
			}
			const delayMs = helperRetryDelayMs(response.headers, attempt);
			body = undefined; // the retried attempt's body replaces this
			await sleep(delayMs);
		}
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
