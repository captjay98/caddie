/**
 * Per-request time budgets for outbound calls on the discovery path
 * (find_hackathons → Devpost API, Tavily search/extract, Nebius model calls).
 *
 * Why this exists: workerd's fetch has no default timeout. One stalled socket
 * left a find_hackathons call hanging for ~70 minutes until Flue's durability
 * supervisor killed the whole submission ("Caddie stopped before finishing").
 * Every caller of these budgets already degrades on a thrown error (visible
 * gap, unknown eligibility, no digest), so an abort turns a hang into the same
 * honest fail-soft path a network error takes.
 */
export const DEVPOST_TIMEOUT_MS = 15_000;
export const TAVILY_SEARCH_TIMEOUT_MS = 20_000;
export const TAVILY_EXTRACT_TIMEOUT_MS = 30_000;
export const MODEL_CALL_TIMEOUT_MS = 45_000;

/** An AbortSignal that fires after `ms`; pass as `signal` on an outbound fetch. */
export function timeoutSignal(ms: number): AbortSignal {
	return AbortSignal.timeout(ms);
}
