import { describe, test, expect } from "bun:test";
import { acceptanceVerdict } from "../apps/app/src/server/feature-acceptance.ts";

/** A repaired generic check is not proof of a feature. Legacy count growth
 * remains compatible; flat counts need independent host-owned evidence. */
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

  test("an independently checked repair with a flat count is accepted", () => {
    const v = acceptanceVerdict({ checksPassed: true, passing: 5, baseline: 5, priorFailingCheckNowGreen: true, independentCriteriaPassed: true });
    expect(v.kind).toBe("accept");
    expect(v.reason).toMatch(/repair/i);
  });

  test("a flat count with nothing repaired and no new coverage is rejected", () => {
    const v = acceptanceVerdict({ checksPassed: true, passing: 5, baseline: 5, priorFailingCheckNowGreen: false });
    expect(v.kind).toBe("reject");
  });
});

test('a prior red bundle or a deleted failing test cannot prove a new feature', () => {
 expect(acceptanceVerdict({checksPassed:true,passing:1,baseline:1,priorFailingCheckNowGreen:true}).kind).toBe('reject');
});
