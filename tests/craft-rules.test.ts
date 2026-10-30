import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_RECIPE_INSTRUCTION } from "../apps/app/src/agents/specialists.ts";

/**
 * LOCAL VERIFIED (2026-10-23 agent hardening, part 2f; updated 2026-10-24 for
 * the choose-a-look step): the craft rules are ADAPTED into the design skill,
 * the builder recipe, the planning skill and the coordinator, all pointed at
 * the app theme + the icon kit. Colours come only from theme variables. The
 * LOOK is now chosen in its own step before design: the coordinator's LOOKS
 * instruction forbids reaching for the same look every time, and the design
 * skill then carries the CHOSEN look's caddie-theme block unchanged.
 */

const REPO = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("part 2f — the design skill carries the chosen look and uses the app theme", () => {
  const skill = read("apps/app/src/agents/skills/design/SKILL.md");
  // Owner 2026-10-29: the looks ARE the design — three looks, each the app's
  // real first screen; the pick starts the build.
  test("the design skill makes the looks the design, with no later screens step", () => {
    expect(skill).toContain("The looks ARE the design");
    expect(skill).toContain("three looks");
    expect(skill).toContain("no later");
    expect(skill).toContain("structurally different");
  });
  test("the looks step names the audience and keeps the three looks different", () => {
    const coordinator = read("apps/app/src/agents/coordinator.ts");
    expect(coordinator).toContain("LOOKS STEP");
    expect(coordinator).toContain("exactly 3 looks");
    expect(coordinator.toLowerCase()).toContain("who the app is for");
  });
  test("it names one primary action per view and an intentional type scale", () => {
    expect(skill).toContain("One primary button");
    expect(skill.toLowerCase()).toContain("type scale");
  });
  test("mockups use the app theme's variables, and it says use the icon kit not emoji", () => {
    expect(skill).toContain("theme variables");
    expect(skill).toContain("caddie/icons.tsx");
    expect(skill).toContain("never");
    expect(skill).toContain("emoji");
  });
});

describe("part 2f — the builder recipe carries the adapted craft rules", () => {
  const r = BUILD_RECIPE_INSTRUCTION;
  test("theme variables and the icon kit, never literal hex", () => {
    expect(r).toContain("caddie/theme.css");
    expect(r).toContain('import { Icon } from "../caddie/icons"');
    expect(r).toContain("never a literal hex");
  });
  test("layout and motion rules", () => {
    expect(r).toContain("100dvh");
    expect(r).toContain("safe-area");
    expect(r).toContain("prefers-reduced-motion");
    expect(r).toContain("200ms");
  });
  test("states rules", () => {
    expect(r).toContain("tabular-nums");
    expect(r).toContain("every empty state one clear action");
    expect(r.toLowerCase()).toContain("confirm a destructive action");
  });
  test("accessibility and responsive rules, with no device-class assumption", () => {
    expect(r).toContain("44x44");
    expect(r).toContain("aria-label on every icon-only button");
    expect(r).toContain("320px");
    expect(r).toContain("Do not assume a device class");
  });
});

describe("part 2f — the planning skill asks who and where; the coordinator leaves the look to design", () => {
  test("the planning skill has the 'Who uses it and where' line", () => {
    const plan = read("apps/app/src/agents/skills/planning/SKILL.md");
    expect(plan).toContain("Who uses it and where");
  });
  test("the coordinator's PRD instruction names the audience and leaves the look to the design step", () => {
    const coordinator = read("apps/app/src/agents/coordinator.ts");
    expect(coordinator).toContain("who the app is for and where they use it");
    expect(coordinator).toContain("the looks step owns the app's look");
    expect(coordinator).not.toContain("concrete visual direction");
  });
});
