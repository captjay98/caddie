import { describe, test, expect } from "bun:test";
import {
  normalizeFinishReason,
  classifyEmptyResult,
} from "../apps/app/src/server/build-empty-result.ts";

/**
 * B02 §C — empty results and finish reasons (the F1 incident: delegates
 * returned "(task completed with no text)" and the BUILD loop re-delegated the
 * same empty hand-off, burning the turn budget — FarmLog 2026-10-15: six empty
 * delegations, three false "saved" claims).
 *
 * The plan/looks/design loops already carry a plan_incomplete anti-re-delegate
 * signal; the build loop does not. This specifies a pure classifier the build
 * result handler consults:
 *   - unknown/NULL finish reasons stay unknown — never fabricate 'length' from
 *     an empty output alone (plan §C.1);
 *   - successful TOOL-ONLY work (receipts, code changed) is PRODUCTIVE, not a
 *     failed feature (§C.2);
 *   - output-cap truncation needs a BOUNDED change (headroom/context/task),
 *     not blind re-delegation (§C.2);
 *   - a genuine no-progress empty result is 'no-progress' and feeds the B03
 *     fingerprint (§C.2).
 *
 * Pure, no I/O, no clock. RED until build-empty-result.ts exists.
 */

describe("B02 §C — normalizeFinishReason (preserve unknown, never fabricate)", () => {
  test("a known provider reason passes through", () => {
    expect(normalizeFinishReason("stop")).toBe("stop");
    expect(normalizeFinishReason("length")).toBe("length");
    expect(normalizeFinishReason("tool_calls")).toBe("tool_calls");
  });

  test("an absent/null/unknown reason stays 'unknown' — not fabricated", () => {
    expect(normalizeFinishReason(null)).toBe("unknown");
    expect(normalizeFinishReason(undefined)).toBe("unknown");
    expect(normalizeFinishReason("")).toBe("unknown");
    expect(normalizeFinishReason("something_new")).toBe("unknown");
  });
});

describe("B02 §C — classifyEmptyResult", () => {
  test("empty text but tool receipts AND code changed = productive (do not re-delegate)", () => {
    const v = classifyEmptyResult({ finishReason: "stop", text: "", hadToolReceipts: true, codeChanged: true });
    expect(v.kind).toBe("productive");
    expect(v.reDelegate).toBe(false);
  });

  test("output-cap truncation (finish_reason length) = truncated, needs a bounded change", () => {
    const v = classifyEmptyResult({ finishReason: "length", text: "", hadToolReceipts: false, codeChanged: false });
    expect(v.kind).toBe("truncated");
    expect(v.reDelegate).toBe(false); // never blind re-delegation; the caller must shrink the task
    expect(v.action).toBe("reduce-scope");
  });

  test("empty text, no receipts, no code change, stop = genuine no-progress (feeds fingerprint)", () => {
    const v = classifyEmptyResult({ finishReason: "stop", text: "", hadToolReceipts: false, codeChanged: false });
    expect(v.kind).toBe("no-progress");
    expect(v.reDelegate).toBe(false); // never re-delegate the SAME empty hand-off
    expect(v.countsTowardFingerprint).toBe(true);
  });

  test("non-empty text is not an empty-result case at all", () => {
    const v = classifyEmptyResult({ finishReason: "stop", text: "done: added the form", hadToolReceipts: true, codeChanged: true });
    expect(v.kind).toBe("answered");
  });

  test("the literal '(task completed with no text)' sentinel counts as empty", () => {
    const v = classifyEmptyResult({ finishReason: "stop", text: "(task completed with no text)", hadToolReceipts: false, codeChanged: false });
    expect(v.kind).toBe("no-progress");
  });
});
