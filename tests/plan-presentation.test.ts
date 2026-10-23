import { test, expect } from "bun:test";
import {
  parsePlanSections,
  planSectionGroup,
  embeddedPlanCaveats,
  planOverview,
  planJourneys,
} from "../apps/app/src/client/planning/plan-sections.ts";
import { buildSentence } from "../apps/app/src/client/runs/run-status.ts";

test("scope, assumptions and contest requirements stay in the approval reading flow", () => {
  expect(planSectionGroup("Non-goals")).toBe("scope");
  expect(planSectionGroup("Technical assumptions")).toBe("limitations");
  expect(planSectionGroup("Hackathon requirements")).toBe("limitations");
  expect(planSectionGroup("What your app will do")).toBe("outcomes");
  expect(planSectionGroup("Included in this version / left for later")).toBe(
    "scope",
  );
  expect(planSectionGroup("How Caddie will check it works")).toBe("checks");
  expect(planSectionGroup("API surface")).toBe("technical");
  expect(planSectionGroup("Unfamiliar but important notes")).toBe("other");
});
test("the plan parser preserves sources and nested headings without making up missing sections", () => {
  const parsed = parsePlanSections(
    "# Herd\n\nFor farmers.\n\n## Non-goals\nNo payments.\n### Later\n[Rules](https://example.org/rules)\n## API surface\nPOST /cases",
  );
  expect(parsed.intro).toBe("# Herd\n\nFor farmers.");
  expect(parsed.sections).toHaveLength(2);
  expect(parsed.sections[0]!.body).toContain(
    "### Later\n[Rules](https://example.org/rules)",
  );
  expect(parsePlanSections("A brief without headings").sections).toHaveLength(
    0,
  );
});
test("explicit text-only compromises inside technical sections are surfaced verbatim", () => {
  const sections = [
    {
      heading: "AI / integrations",
      body: "Model: supported.\n\nAssumption: text-only symptom triage; no photo analysis.\n\nPOST /triage",
    },
  ];
  expect(embeddedPlanCaveats(sections)).toEqual([
    "Assumption: text-only symptom triage; no photo analysis.",
  ]);
});
test("wrapped assumptions retain their complete paragraph", () => {
  const paragraph =
    "**Assumptions:**\nVoice input requires a connection.\nPhoto analysis is excluded.";
  expect(
    embeddedPlanCaveats([{ heading: "AI / integrations", body: paragraph }]),
  ).toEqual([paragraph]);
});
test("a saved build request never claims that execution or successful checks occurred", () => {
  expect(buildSentence("recorded", "9h ago")).toBe(
    "Build request recorded 9h ago. Its result is not confirmed here.",
  );
  expect(buildSentence("completed", "9h ago")).toContain(
    "Check the app’s results",
  );
  expect(buildSentence("failed", "9h ago")).toContain("marked failed");
});

test("the main overview is one excerpt and journeys omit the technical backbone", () => {
  const sections = [
    {
      heading: "Overview",
      body: "**Who it’s for:** Farmers.\n\nFarmhand keeps farm records together. Implementation details follow.",
    },
    {
      heading: "User stories and flows",
      body: "### Flow 1 — Voice Farmhand (core, demo spine)\nSpeak an observation.\n### Flow 2 — Feed Runway\nCheck feed.\n### Shared backbone (CRUD + sync queue)\nTables and endpoints.",
    },
  ];
  expect(
    planOverview("# Farmhand — Product Requirements Document (v2)", sections),
  ).toBe("Farmhand keeps farm records together.");
  expect(planJourneys(sections).map((s) => s.heading)).toEqual([
    "Voice Farmhand",
    "Feed Runway",
  ]);
});
