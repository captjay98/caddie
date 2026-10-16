import { describe, test, expect } from "bun:test";
import type { ExperienceStage, ProjectExperience } from "@caddie/contracts";
import { projectCardFromExperience } from "../apps/app/src/client/workspace/project-status.ts";

/**
 * LOCAL VERIFIED: the Projects-list card reads the project's REAL workflow
 * stage, so it can never say "No updates yet" while Caddie is building.
 */
function exp(stage: ExperienceStage, version = 1_760_000_000_000, message = "server message"): ProjectExperience {
  return { projectId: "p", version, stage, plan: null, preview: null, message, actions: [] };
}

describe("projectCardFromExperience", () => {
  test("no workflow yet (version 0) falls back to the Brief summary", () => {
    expect(projectCardFromExperience(exp("planning", 0))).toBeNull();
  });

  test("a building project says Building with a live indicator, never 'No updates yet'", () => {
    const card = projectCardFromExperience(exp("building"))!;
    expect(card.label).toBe("Building");
    expect(card.working).toBe(true);
    expect(card.action).toEqual({ label: "See progress", target: "project" });
  });

  test("a ready plan routes straight to plan review", () => {
    expect(projectCardFromExperience(exp("review"))!.action).toEqual({ label: "Review plan", target: "plan" });
  });

  test("a plan stuck before approval is not shown as a stuck build", () => {
    const card = projectCardFromExperience(exp("planning_blocked"))!;
    expect(card.label).toBe("Plan needs another pass");
    expect(card.action.label).toBe("Continue the plan");
  });

  test("a build blocker shows the server's real reason", () => {
    expect(projectCardFromExperience(exp("blocked", 1, "The sandbox is not configured."))!.detail).toBe("The sandbox is not configured.");
  });

  test("every stage maps to exactly one action and a non-empty label", () => {
    const stages: ExperienceStage[] = ["planning", "review", "building", "checking", "repairing", "ready", "blocked", "planning_blocked", "stopped"];
    for (const stage of stages) {
      const card = projectCardFromExperience(exp(stage))!;
      expect(card.label.length).toBeGreaterThan(0);
      expect(card.action.label.length).toBeGreaterThan(0);
    }
  });
});
