import { classifyBuildFailure } from './build-recovery.ts';
/** Bounded direct helper calls, with one receipt per issued physical request.
 * Unknown usage remains NULL; observation failures cannot change the real result.
 */
import type { D1Database } from './auth.ts';
import { findModelRouteForRole, type ModelRole } from '../agents/providers.ts';
import { persistModelCall, type ModelCallRecord } from './model-call-instrument.ts';
import { DIGEST_CALL_TIMEOUT_MS, MODEL_CALL_TIMEOUT_MS } from './http-timeouts.ts';

export interface HelperAccounting { db: D1Database; projectId?: string }
type HelperRole = Extract<ModelRole, 'helperRules' | 'helperRanking' | 'helperSummary'>;
const REASON: Record<HelperRole, string> = { helperRules: 'rules_extraction', helperRanking: 'candidate_ranking', helperSummary: 'candidate_summary' };
const HELPER_MAX_RETRIES = 2;
const HELPER_MAX_RETRY_DELAY_MS = 10_000;
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function count(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
export function isTransientHelperStatus(status: number): boolean { return classifyBuildFailure({status,readOnly:true}).action==='retry-same-operation'; }

/** A server-provided minimum wait is never clamped into an earlier retry. */
export function helperRetryDelayMs(headers: Headers, attempt: number, maxDelayMs = HELPER_MAX_RETRY_DELAY_MS): number {
 const milliseconds = Number(headers.get('retry-after-ms') ?? NaN);
 if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
 const header = headers.get('retry-after');
 if (header !== null) {
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (Number.isFinite(delay) && delay >= 0) return delay;
 }
 return Math.min(200 * 2 ** attempt, maxDelayMs);
}
function terminalProviderError(body: unknown): boolean {
 const error = object(object(body).error);
 const result=classifyBuildFailure({code:String(error.code??error.type??''),readOnly:true});
 return result.kind==='budget-exhausted'||result.kind==='needs-user';
}
function transientTransport(error: unknown): boolean {
 return classifyBuildFailure({transportError:error,readOnly:true}).action==='retry-same-operation';
}
function withSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
 signal.throwIfAborted();
 return new Promise<T>((resolve, reject) => {
  const abort = () => { cleanup(); reject(signal.reason); };
  const cleanup = () => signal.removeEventListener('abort', abort);
  signal.addEventListener('abort', abort, { once: true });
  Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
 });
}
export async function helperModelCompletion(input: {
 role: HelperRole;
 accounting?: HelperAccounting;
 url: string;
 request: RequestInit;
 deadlineAt?: number;
 sleepMs?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
 const route = findModelRouteForRole(input.role);
 const requested = typeof input.request.body === 'string' ? object(JSON.parse(input.request.body)) : {};
 if (requested.model !== route.modelId || new URL(input.url).origin !== 'https://api.tokenfactory.nebius.com') throw new Error('Helper model request does not match its registered route');
 const allowance = input.role === 'helperSummary' ? DIGEST_CALL_TIMEOUT_MS : MODEL_CALL_TIMEOUT_MS;
 const deadlineAt = Math.min(input.deadlineAt ?? Infinity, Date.now() + allowance);
 const remaining = deadlineAt - Date.now();
 if (!(remaining > 0)) throw new DOMException('Helper time limit reached', 'TimeoutError');
 const signal = AbortSignal.any([...(input.request.signal ? [input.request.signal] : []), AbortSignal.timeout(Math.ceil(remaining))]);
 for (let attempt = 0; ; attempt++) {
  signal.throwIfAborted();
  const started = Date.now();
  let response: Response | undefined, body: unknown, failed = true, transportError: unknown, issued = false;
  try {
   response = await withSignal(() => { issued = true; return fetch(input.url, {...input.request, signal}); }, signal);
   try { body = await withSignal(() => response!.json(), signal); } catch (error) { if (response.ok || signal.aborted) throw error; }
   failed = !response.ok;
  } catch (error) { transportError = error; }
  finally {
   if (input.accounting && issued) {
    const parsed = object(body), usage = object(parsed.usage);
    const inputTokens = count(usage.prompt_tokens), outputTokens = count(usage.completion_tokens);
    const estimate = inputTokens === null || outputTokens === null ? null : Math.ceil((inputTokens * route.inputPriceMinorUnits + outputTokens * route.outputPriceMinorUnits) / 100);
    const record: ModelCallRecord = {
     turnId: `helper_${crypto.randomUUID()}`, instanceId: input.accounting.projectId ?? null, conversationId: null, submissionId: null,
     agentName: 'direct-helper', purpose: 'helper', providerId: route.providerId, requestedModel: route.modelId,
     responseModel: typeof parsed.model === 'string' ? parsed.model : null, routeId: route.id, pricingVersion: route.pricingVersion, currency: route.currency,
     selectedRole: input.role, selectionReason: REASON[input.role], inputTokens, outputTokens,
     cacheReadTokens: count(object(usage.prompt_tokens_details).cached_tokens), cacheWriteTokens: null, totalTokens: count(usage.total_tokens),
     catalogCostMicros: estimate !== null && Number.isSafeInteger(estimate) ? estimate : null,
     durationMs: Math.max(0, Date.now() - started), isError: failed || transportError !== undefined, createdAt: new Date().toISOString(),
    };
    try { await persistModelCall(input.accounting.db, record); } catch { console.error('Helper model call accounting write unavailable'); }
   }
  }
  signal.throwIfAborted();
  if (transportError !== undefined) {
   if (attempt >= HELPER_MAX_RETRIES || !transientTransport(transportError)) throw transportError;
  } else if (response!.ok || attempt >= HELPER_MAX_RETRIES || !isTransientHelperStatus(response!.status) || terminalProviderError(body)) {
   return {ok: response!.ok, status: response!.status, body};
  }
  const delay = helperRetryDelayMs(response?.headers ?? new Headers(), attempt);
  // Stop rather than violate the provider's wait instruction or parent allowance.
  if (delay > HELPER_MAX_RETRY_DELAY_MS || delay >= deadlineAt - Date.now()) {
   if (transportError !== undefined) throw transportError;
   return {ok:false,status:response!.status,body};
  }
  if (input.sleepMs) await withSignal(() => input.sleepMs!(delay), signal);
  else await withSignal(() => new Promise<void>((resolve, reject) => {
   const abort = () => { clearTimeout(timer); reject(signal.reason); };
   const timer = setTimeout(() => {signal.removeEventListener('abort',abort);resolve();}, delay);
   signal.addEventListener('abort',abort,{once:true});
  }), signal);
 }
}
