/**
 * B02 §A — layered deadline policy (PURE, fake-clock-testable).
 *
 * The 2026-10-25 incident: a single delegate hung 6,189,040 ms (103 min) then
 * errored, because nothing bounds one model request / stream / specialist
 * task's wall-clock. The only wall-clock bound was
 * COORDINATOR_DURABILITY.timeoutMs = 60 min at the SUBMISSION level
 * (permissions.ts) plus the 20-min stall watchdog (build-workflow.ts). This
 * module adds the missing layer: per-request / stream-idle / per-specialist
 * deadlines, each derived from the LESSER of its own policy allowance and the
 * parent's remaining time, under ONE persisted absolute build deadline that
 * survives restart.
 *
 * Every function is pure (clock passed in, never read here) so the fault tests
 * drive it with a fake clock and no real waits. Wiring these verdicts into the
 * delegate/coordinator/host execution paths is a separate step; this is the
 * decision layer those paths consult.
 *
 * The starting values are INITIAL ENGINEERING DEFAULTS to validate against
 * representative workloads (plan B02 §A.2) — not measured-optimal limits, and
 * never a reason to lower output-token headroom to satisfy a timer.
 */

export const DEADLINE_POLICY = {
	/** Per physical model request. */
	requestMs: 300_000, // 300 s
	/** Allowed stream inactivity before an idle settle. */
	streamIdleMs: 90_000, // 90 s
	/** Per specialist task. */
	specialistMs: 600_000, // 600 s
} as const;

export type DeadlineKind = "running" | "deadline-exhausted" | "stream-idle-exhausted";

export interface DeadlineVerdict {
	kind: Extract<DeadlineKind, "running" | "deadline-exhausted">;
	/** Only set on a terminal verdict: never a blind retry. */
	next?: "reconcile-or-stop";
}

export interface StreamIdleVerdict {
	kind: DeadlineKind;
	next?: "reconcile-or-stop";
}

/**
 * A child's effective deadline is the LESSER of (started + its own policy
 * allowance) and the parent's absolute deadline — a child can never outlive
 * its parent (plan B02 §A.4). All timestamps are epoch ms.
 */
export function childDeadlineAt(startedAt: number, policyMs: number, parentDeadlineAt: number): number {
	return Math.min(parentDeadlineAt, startedAt + policyMs);
}

/**
 * At/after the deadline the work is terminal and must reconcile-or-stop — an
 * ambiguous remote outcome is reconciled against its receipt, never blindly
 * retried (invariants 2 & 4). Before it, still running.
 */
export function deadlineVerdict(deadlineAt: number, now: number): DeadlineVerdict {
	if (now >= deadlineAt) return { kind: "deadline-exhausted", next: "reconcile-or-stop" };
	return { kind: "running" };
}

/**
 * Stream liveness. A fresh chunk resets the idle timer but CANNOT extend the
 * hard deadline: the hard deadline always wins (chunks are activity, not
 * progress — plan B02 §A.4). Order of checks matters: hard deadline first.
 */
export function streamIdleVerdict(input: {
	lastChunkAt: number;
	now: number;
	hardDeadlineAt: number;
	idleMs?: number;
}): StreamIdleVerdict {
	const idleMs = input.idleMs ?? DEADLINE_POLICY.streamIdleMs;
	if (input.now >= input.hardDeadlineAt) return { kind: "deadline-exhausted", next: "reconcile-or-stop" };
	if (input.now - input.lastChunkAt >= idleMs) return { kind: "stream-idle-exhausted", next: "reconcile-or-stop" };
	return { kind: "running" };
}

export interface PersistedBuildDeadline {
	/** The absolute deadline, fixed at admission. */
	deadlineAt: number;
	/** True once `t` is past the persisted deadline. */
	expiredAt(t: number): boolean;
}

/**
 * The absolute build deadline is computed ONCE at admission and persisted; it
 * is NOT recomputed from a restart time, so a cold restart cannot silently turn
 * the admitted hour into a fresh hour (the F2-adjacent budget bug — plan
 * B02 §A.3). `restartAt` is accepted only to make the invariance explicit in
 * tests; it never moves the deadline.
 */
export function persistedBuildDeadline(
	admittedAt: number,
	totalAllowanceMs: number,
	_restartAt?: number,
): PersistedBuildDeadline {
	const deadlineAt = admittedAt + totalAllowanceMs;
	return {
		deadlineAt,
		expiredAt: (t: number) => t > deadlineAt,
	};
}

/**
 * The absolute-deadline anchor for the CURRENT build attempt.
 *
 * A build's payer id is `build:<runId>:<startMs>` (build-spend.ts), rewritten
 * on every retry (openBuildSpendPayer reset=true) — so its trailing timestamp
 * is this ATTEMPT's start, not the run's birth. The absolute deadline must
 * anchor here: a retry is a new build with a fresh payer and budget and so
 * deserves a fresh hour, while a crash-restart (which reuses the same payer id)
 * keeps the original admission and cannot silently win a fresh hour (B02 §A.3).
 *
 * Anchoring on run_bindings.createdAt instead was a bug: it never resets, so a
 * retry of any run older than the allowance re-paused instantly and could never
 * start. Falls back to `bindingCreatedAt` only when no payer id is parseable.
 */
export function buildAttemptAdmittedAt(spendPayerId: string | null | undefined, bindingCreatedAt: number | null): number | null {
	if (spendPayerId) {
		const match = /^build:.+:(\d{10,})$/.exec(spendPayerId);
		if (match) {
			const ms = Number(match[1]);
			if (Number.isFinite(ms) && ms > 0) return ms;
		}
	}
	return bindingCreatedAt;
}
