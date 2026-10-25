/**
 * B02 §C — empty results and finish reasons (PURE, no I/O).
 *
 * The 2026-10-25 incident: delegates returned "(task completed with no text)"
 * and the BUILD loop re-delegated the same empty hand-off, burning the turn
 * budget (FarmLog 2026-10-15: six empty delegations, three false "saved"
 * claims). The plan/looks/design loops already carry a plan_incomplete
 * anti-re-delegate signal; this is the build-loop equivalent, as a pure
 * classifier the result handler consults.
 *
 * Principles (plan §C):
 *  - preserve unknown: never fabricate a finish reason (e.g. `length`) from an
 *    empty output alone;
 *  - successful TOOL-ONLY work is productive, not a failed feature;
 *  - output-cap truncation needs a BOUNDED change (shrink scope/context/task),
 *    never blind re-delegation;
 *  - a genuine no-progress empty result feeds the B03 no-progress fingerprint.
 */

/** The empty-delegate sentinel the runtime emits when a turn produced no text. */
export const EMPTY_RESULT_SENTINEL = "(task completed with no text)";

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "unknown";

const KNOWN_FINISH_REASONS: ReadonlySet<string> = new Set([
	"stop",
	"length",
	"tool_calls",
	"content_filter",
]);

/**
 * Normalize a provider/adapter finish reason to a known value, preserving
 * `unknown` for anything absent or unrecognized. It NEVER infers `length`
 * from an empty output — truncation is only claimed when the provider says so.
 */
export function normalizeFinishReason(raw: string | null | undefined): FinishReason {
	if (typeof raw !== "string" || raw === "") return "unknown";
	return KNOWN_FINISH_REASONS.has(raw) ? (raw as FinishReason) : "unknown";
}

export type EmptyResultKind = "answered" | "productive" | "truncated" | "no-progress";

export interface EmptyResultVerdict {
	kind: EmptyResultKind;
	/** The build loop must never re-send the SAME empty hand-off. */
	reDelegate: false;
	/** truncated only: the caller must shrink the task before any retry. */
	action?: "reduce-scope";
	/** no-progress only: this contributes to the B03 no-progress fingerprint. */
	countsTowardFingerprint?: true;
}

function isEmpty(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "" || trimmed === EMPTY_RESULT_SENTINEL;
}

/**
 * Classify a delegate turn's result. A non-empty answer is `answered`. An
 * empty/sentinel result is one of:
 *   - `truncated`     — the provider said `length`: shrink scope, do not re-send;
 *   - `productive`    — tool receipts AND a code change: real work happened;
 *   - `no-progress`   — nothing to show: feeds the fingerprint, never re-sent.
 * In every empty case `reDelegate` is false: the same empty hand-off is never
 * repeated (that is the budget-burning bug this guards).
 */
export function classifyEmptyResult(input: {
	finishReason: string | null | undefined;
	text: string;
	hadToolReceipts: boolean;
	codeChanged: boolean;
}): EmptyResultVerdict {
	if (!isEmpty(input.text)) return { kind: "answered", reDelegate: false };
	const reason = normalizeFinishReason(input.finishReason);
	if (reason === "length") return { kind: "truncated", reDelegate: false, action: "reduce-scope" };
	if (input.hadToolReceipts && input.codeChanged) return { kind: "productive", reDelegate: false };
	return { kind: "no-progress", reDelegate: false, countsTowardFingerprint: true };
}
