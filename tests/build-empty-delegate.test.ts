import { describe, test, expect } from "bun:test";
import { FEATURE_DELEGATION_RULE } from "../apps/app/src/agents/delegation.ts";
import { EMPTY_RESULT_SENTINEL } from "../apps/app/src/server/build-empty-result.ts";

/**
 * B02 §C wiring — the build loop is model-driven through tools (the
 * coordinator calls a delegate, reads its text, then calls finish_feature or
 * re-delegates). There is no host-side seam that observes a delegate's
 * finishReason/receipts; the plan/looks/design loops guard the same situation
 * with an INSTRUCTION signal (plan_incomplete), so the build loop needs the
 * equivalent in FEATURE_DELEGATION_RULE: an empty delegate return
 * ("(task completed with no text)") must NOT be re-delegated unchanged — the
 * coordinator finishes the feature (the host reports the real failed check) or
 * reports a blocker. This locks that guidance into the shared rule text.
 */
describe("B02 §C wiring — the build loop does not re-delegate an empty hand-off", () => {
  test("FEATURE_DELEGATION_RULE names the empty-result sentinel", () => {
    expect(FEATURE_DELEGATION_RULE).toContain(EMPTY_RESULT_SENTINEL);
  });

  test("it forbids re-delegating the same empty hand-off", () => {
    expect(FEATURE_DELEGATION_RULE.toLowerCase()).toContain("do not re-delegate");
  });

  test("it points at finish_feature / report_blocker instead of a blind retry", () => {
    expect(FEATURE_DELEGATION_RULE).toMatch(/finish_feature|report_blocker/);
  });
});
