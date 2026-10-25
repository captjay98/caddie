import { describe, test, expect } from "bun:test";
import {
  DEADLINE_POLICY,
  childDeadlineAt,
  deadlineVerdict,
  streamIdleVerdict,
  persistedBuildDeadline,
} from "../apps/app/src/server/build-deadlines.ts";

/**
 * B01 part 2 — the F2 RED (the headline incident: a delegate hung 103 min
 * — 6,189,040 ms — then errored, because nothing bounds a single model
 * request / stream / specialist task's wall-clock).
 *
 * Today the ONLY wall-clock bound is COORDINATOR_DURABILITY.timeoutMs = 60 min
 * at the SUBMISSION level (permissions.ts:183) plus the 20-min stall watchdog
 * (build-workflow.ts BUILD_STALL_MS). Per-request, stream-idle and
 * per-specialist deadlines, and a persisted ABSOLUTE build deadline that
 * survives restart, do NOT exist. This test specifies them as a pure policy
 * (B02 §A's illustrative `effectiveDeadlineAt = min(parent, started+policy)`),
 * with a FAKE CLOCK — no real waits, no paid calls.
 *
 * It is RED until `apps/app/src/server/build-deadlines.ts` exists (B02 §A).
 * The fault it encodes: a 103-minute request must be impossible.
 */

const MIN = 60_000;

describe("F2 — layered deadline policy (fake clock)", () => {
  test("engineering default policy values match the plan's starting points", () => {
    // Initial engineering defaults (B02 §A.2) — validated against workloads
    // later, not claimed optimal. Named so a change is a deliberate edit.
    expect(DEADLINE_POLICY.requestMs).toBe(300_000); // 300s per physical model request
    expect(DEADLINE_POLICY.streamIdleMs).toBe(90_000); // 90s of stream inactivity
    expect(DEADLINE_POLICY.specialistMs).toBe(600_000); // 600s per specialist task
  });

  test("a child deadline is the LESSER of its policy allowance and the parent's remaining time", () => {
    const startedAt = 1_000_000;
    // Parent has only 2 min left; the specialist policy is 10 min → child capped at parent.
    const parentDeadlineAt = startedAt + 2 * MIN;
    const child = childDeadlineAt(startedAt, DEADLINE_POLICY.specialistMs, parentDeadlineAt);
    expect(child).toBe(parentDeadlineAt);

    // Parent has plenty left → child capped at its own policy.
    const roomyParent = startedAt + 60 * MIN;
    const child2 = childDeadlineAt(startedAt, DEADLINE_POLICY.specialistMs, roomyParent);
    expect(child2).toBe(startedAt + DEADLINE_POLICY.specialistMs);
  });

  test("a request that never resolves settles 'deadline-exhausted' at its request deadline", () => {
    const startedAt = 5_000;
    const deadlineAt = startedAt + DEADLINE_POLICY.requestMs;
    // one tick before → still running
    expect(deadlineVerdict(deadlineAt, deadlineAt - 1).kind).toBe("running");
    // at/after the deadline → terminal, must reconcile-or-stop (not a blind retry)
    const v = deadlineVerdict(deadlineAt, deadlineAt + 1);
    expect(v.kind).toBe("deadline-exhausted");
    expect(v.next).toBe("reconcile-or-stop");
  });

  test("the 103-minute hang is impossible: a specialist is terminal long before it", () => {
    const startedAt = 0;
    const hangMs = 6_189_040; // the real incident duration
    const deadlineAt = childDeadlineAt(startedAt, DEADLINE_POLICY.specialistMs, startedAt + 60 * MIN);
    expect(deadlineVerdict(deadlineAt, hangMs).kind).toBe("deadline-exhausted");
    // and it settles no later than the 60-min submission bound, never 103 min
    expect(deadlineAt).toBeLessThanOrEqual(60 * MIN);
  });

  test("stream chunks reset the idle timer but cannot extend the hard deadline", () => {
    const hardDeadlineAt = 10 * MIN;
    // A chunk arrived 10s ago, idle budget 90s → still alive.
    expect(streamIdleVerdict({ lastChunkAt: 100_000, now: 110_000, hardDeadlineAt }).kind).toBe("running");
    // No chunk for >90s → idle-exhausted even though the hard deadline is far off.
    expect(streamIdleVerdict({ lastChunkAt: 100_000, now: 100_000 + 91_000, hardDeadlineAt }).kind).toBe(
      "stream-idle-exhausted",
    );
    // A fresh chunk past the HARD deadline cannot revive it.
    expect(streamIdleVerdict({ lastChunkAt: hardDeadlineAt + 1, now: hardDeadlineAt + 1, hardDeadlineAt }).kind).toBe(
      "deadline-exhausted",
    );
  });

  test("the absolute build deadline is persisted at admission and NOT recomputed from restart time", () => {
    const admittedAt = 1_000_000;
    const totalAllowanceMs = 60 * MIN;
    const persisted = persistedBuildDeadline(admittedAt, totalAllowanceMs);
    expect(persisted.deadlineAt).toBe(admittedAt + totalAllowanceMs);

    // After a cold restart 40 min later, the deadline is UNCHANGED — the hour
    // does not silently become a fresh hour (the F2-adjacent budget bug).
    const restartAt = admittedAt + 40 * MIN;
    const afterRestart = persistedBuildDeadline(admittedAt, totalAllowanceMs, restartAt);
    expect(afterRestart.deadlineAt).toBe(admittedAt + totalAllowanceMs);
    // work past the persisted deadline after restart is refused
    expect(afterRestart.expiredAt(admittedAt + totalAllowanceMs + 1)).toBe(true);
    expect(afterRestart.expiredAt(admittedAt + totalAllowanceMs - 1)).toBe(false);
  });
});
