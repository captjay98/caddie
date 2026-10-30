import { describe, test, expect } from "bun:test";
import { headerBadge, statusLabel } from "../apps/app/src/client/brief/DecisionCard.tsx";
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
  test("an approval that needs you reads 'Needs you' (mockup 1 pill)", () => {
    expect(statusLabel(card({ kind: "approval", status: "needs-you" }))).toBe("Needs you");
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

 test('a handled hackathon deadline still reads its Deadline badge (mockup 5)', () => { expect(statusLabel(card({ kind: 'deadline', status: 'handled' }))).toBe('Deadline'); });
 test("a schedule-backed deadline card reads 'Scheduled', never a Deadline badge", () => { expect(statusLabel(card({ kind: 'deadline', status: 'handled', schedule: { name: 'Weekly check', nextRunLabel: 'Monday 08:00' } }))).toBe('Scheduled'); });

describe("headerBadge — one status in the card header (owner 2026-10-30)", () => {
  const live = (id: string, status: DecisionCard["status"], extra: Partial<DecisionCard> = {}) =>
    card({ id: `brf_workflow_${id}_x`, kind: "result", status, primaryAction: { label: "View activity", kind: "inspect", targetId: "run" }, ...extra });
  test("a build, a repair, a ready app and a found hackathon say it once, in the header label", () => {
    expect(headerBadge(live("build", "changed"))).toBe("");
    expect(headerBadge(live("repair", "changed"))).toBe("");
    expect(headerBadge(card({ id: "brf_workflow_preview_x", kind: "result", status: "handled", primaryAction: { label: "Try the app", kind: "preview", targetId: "out" } }))).toBe("");
    expect(headerBadge(card({ id: "brf_opportunity_x", kind: "change", status: "needs-you" }))).toBe("");
  });
  test("a decision, a deadline and a stopped build keep their badge", () => {
    expect(headerBadge(card({ kind: "approval", status: "needs-you" }))).toBe("Needs you");
    expect(headerBadge(card({ kind: "deadline", status: "needs-you" }))).toBe("Deadline");
    expect(headerBadge(live("blocked", "blocked"))).toBe("Needs attention");
  });
});
