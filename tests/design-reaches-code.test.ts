import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_RECIPE_INSTRUCTION,
  FLUTTER_RECIPE_INSTRUCTION,
  FEATURE_DELEGATION_RULE,
} from "../apps/app/src/agents/specialists.ts";
import { makeReadProjectContext, makeWritePlanNote } from "../apps/app/src/agents/tools.ts";

/**
 * LOCAL VERIFIED (2026-10-23 agent hardening, part 1): the approved design
 * brief actually reaches the build. Before this, builders were told to read
 * "the full brief, prd, spec and feedback" and never the approved design, and
 * every feature hand-off passed only {id,title,doneWhen}. These guards pin the
 * design into the recipes, the delegation rule, the tool descriptions, and
 * every server-side per-feature hand-off string.
 */

const REPO = join(import.meta.dir, "..");

describe("part 1 — the build recipes point builders at the approved design", () => {
  for (const [label, recipe] of [
    ["react/hono", BUILD_RECIPE_INSTRUCTION],
    ["flutter", FLUTTER_RECIPE_INSTRUCTION],
  ] as const) {
    test(`the ${label} recipe tells the builder to read the approved design and match it`, () => {
      // Reads the design through read_project_context with the "design" kind…
      expect(recipe).toContain('read_project_context ["design"]');
      // …and builds each screen the feature touches to match the brief's
      // layout, components and empty/loading/error states.
      expect(recipe).toContain("approved design");
      expect(recipe).toContain("empty, loading and error");
    });
  }
});

describe("part 1 — the feature delegation rule carries the approved design", () => {
  test("a delegate is told to match the approved design brief's screens", () => {
    expect(FEATURE_DELEGATION_RULE).toContain("approved design");
  });
});

describe("part 1 — read_project_context lists the real kinds, by name not file", () => {
  test("the description names the readable plan kinds and says to pass kind names", () => {
    const tool = makeReadProjectContext({ readPlanNote: async () => null }) as unknown as {
      description: string;
    };
    for (const kind of ["prd", "design", "spec"]) expect(tool.description).toContain(kind);
    // It must steer agents away from guessing file names (transcripts showed
    // "AGENTS.md", "prd.md", "/kernel.txt"): the description names them as what
    // NOT to pass and tells the agent to pass a kind name instead.
    expect(tool.description.toLowerCase()).toContain("kind");
    expect(tool.description).toContain("never a path or file name");
  });
});

describe("part 1 — write_plan_note's description includes design", () => {
  test("the description lists design among the kinds", () => {
    const tool = makeWritePlanNote({ writePlanNote: async () => {} }) as unknown as {
      description: string;
    };
    expect(tool.description).toContain("design");
  });
});

describe("part 1 — every server-side feature hand-off references the design", () => {
  test("buildNextFeature's next string tells the delegate to match the approved design", () => {
    const host = readFileSync(join(REPO, "apps", "app", "src", "server", "coordinator-host.ts"), "utf8");
    // The per-feature `next` string the host returns from buildNextFeature.
    expect(host).toContain("Delegate ONLY this feature");
    expect(host).toContain("approved design");
  });

  test("the coordinator's per-feature build nudge references the approved design", () => {
    const coordinator = readFileSync(join(REPO, "apps", "app", "src", "agents", "coordinator.ts"), "utf8");
    expect(coordinator).toContain("approved design");
  });

  test("the module builder's per-feature loop instruction references the approved design", () => {
    const moduleBuilder = readFileSync(join(REPO, "apps", "app", "src", "agents", "module-builder.ts"), "utf8");
    expect(moduleBuilder).toContain("approved design");
  });
});
