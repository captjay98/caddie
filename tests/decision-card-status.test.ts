import { describe, test, expect } from "bun:test";
import { statusLabel } from "../apps/app/src/client/brief/DecisionCard.tsx";
import type { DecisionCard } from "@caddie/contracts";

/**
 * LOCAL VERIFIED (R07 plain approval wording): the Brief/overview card pill
 * never shows the raw contract status (`needs-you`, `changed`, `blocked`,
 * `handled`) — it reads as plain language keyed to the card kind.
 */
function card(partial: Partial<DecisionCard>): DecisionCard {
  return {
    id: "c",
    projectId: "p",
    kind: "approval",
    headline: "h",
    summary: "s",
    evidenceIds: [],
    status: "needs-you",
    updatedAt: "2026-10-15T00:00:00.000Z",
    primaryAction: { label: "Review", kind: "review", targetId: "t" },
    ...partial,
  } as DecisionCard;
}

describe("DecisionCard statusLabel — plain language, never raw status", () => {
  test("an approval that needs you reads 'Plan ready', not 'needs-you'", () => {
    expect(statusLabel(card({ kind: "approval", status: "needs-you" }))).toBe("Plan ready");
  });
  test("a verified result that needs you reads 'Ready to try'", () => {
    expect(statusLabel(card({ kind: "result", status: "needs-you" }))).toBe("Ready to try");
  });
  test("a deadline that needs you reads 'Deadline'", () => {
    expect(statusLabel(card({ kind: "deadline", status: "needs-you" }))).toBe("Deadline");
  });
  test("blocked, changed and handled get plain words", () => {
    expect(statusLabel(card({ status: "blocked" }))).toBe("Needs attention");
    expect(statusLabel(card({ status: "changed" }))).toBe("Changes to review");
    expect(statusLabel(card({ status: "handled" }))).toBe("Done");
  });
  test("the raw machine status never leaks through", () => {
    const raw = ["needs-you", "changed", "handled", "blocked"];
    for (const kind of ["approval", "change", "deadline", "result"] as const) {
      for (const status of raw) {
        const label = statusLabel(card({ kind, status: status as DecisionCard["status"] }));
        expect(raw).not.toContain(label);
      }
    }
  });
});

 test('armed future schedules read Watching rather than Done', () => { expect(statusLabel(card({ kind: 'deadline', status: 'handled' }))).toBe('Watching'); });
