import { describe, test, expect } from "bun:test";
import { acceptanceVerdict } from "../apps/app/src/server/feature-acceptance.ts";

/**
 * B04 — make feature completion meaningful (research doc finding 2: "test
 * count is a proxy"). finishFeature gated a feature on `passing <= baseline`
 * → reject, which (a) rejected a valid existing-test REPAIR that fixes a bug
 * without adding a test, and (b) accepted a MEANINGLESS extra test that proves
 * nothing about the feature's criteria.
 *
 * This pure policy decides acceptance from what host-check receipts actually
 * expose — per-check pass/fail and passed/baseline COUNTS. (Receipts do not
 * carry per-test NAMES, so "a named test per doneWhen criterion" is a
 * documented limitation, not asserted here — see the evidence ledger.)
 *
 * Rules:
 *   - a required check still failing        → reject (not done)
 *   - the baseline count dropped            → reject (a test was weakened/deleted)
 *   - checks green AND count grew            → accept (new passing tests)
 *   - checks green, flat count, a prior
 *     failing check is now green             → accept (valid repair, no inflation)
 *   - checks green, flat count, nothing
 *     was repaired                           → reject (no new coverage, no repair)
 */
describe("B04 — feature acceptance policy", () => {
  test("a required check still failing is rejected regardless of count", () => {
    const v = acceptanceVerdict({ checksPassed: false, passing: 10, baseline: 5, priorFailingCheckNowGreen: true });
    expect(v.kind).toBe("reject");
  });

  test("a dropped baseline count is rejected (weakened/deleted test)", () => {
    const v = acceptanceVerdict({ checksPassed: true, passing: 4, baseline: 5, priorFailingCheckNowGreen: true });
    expect(v.kind).toBe("reject");
    expect(v.reason).toMatch(/baseline|weakened|deleted|regress/i);
  });

  test("checks green and the count grew is accepted (new passing tests)", () => {
    const v = acceptanceVerdict({ checksPassed: true, passing: 7, baseline: 5, priorFailingCheckNowGreen: false });
    expect(v.kind).toBe("accept");
  });

  test("a valid existing-test REPAIR with a FLAT count is accepted (the fix vs today)", () => {
    const v = acceptanceVerdict({ checksPassed: true, passing: 5, baseline: 5, priorFailingCheckNowGreen: true });
    expect(v.kind).toBe("accept");
    expect(v.reason).toMatch(/repair/i);
  });

  test("a flat count with nothing repaired and no new coverage is rejected", () => {
    const v = acceptanceVerdict({ checksPassed: true, passing: 5, baseline: 5, priorFailingCheckNowGreen: false });
    expect(v.kind).toBe("reject");
  });
});
