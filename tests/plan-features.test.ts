import { describe, expect, test } from "bun:test";
import { MAX_PLAN_FEATURES, parsePlanFeatures, splitFeatureBlock } from "../packages/contracts/src/features.ts";
import { featuresForPlan } from "../apps/app/src/server/build-features.ts";

/** The PRD's `caddie-features` block: what the user approves is what gets built. */
const block = (json: string, fence = "```") => `# Plan\n\nProse first.\n\n${fence}caddie-features\n${json}\n${fence}\n\nClosing note.`;
const one = JSON.stringify([{ id: "log-feed", title: "Log daily feed", doneWhen: ["Saving 12 kg shows it in the list"] }]);

describe("plan feature list", () => {
  test("parses a valid block and keeps build order", () => {
    const two = JSON.stringify([
      { id: "log-feed", title: "Log daily feed", doneWhen: ["a"] },
      { id: "dashboard", title: "Dashboard", doneWhen: ["b", "c"] },
    ]);
    const parsed = parsePlanFeatures(block(two));
    expect(parsed.ok && parsed.features.map((f) => f.id)).toEqual(["log-feed", "dashboard"]);
    expect(parsePlanFeatures(block(one, "~~~")).ok).toBe(true);
  });

  test("the reader sees prose without the JSON block", () => {
    const { display, raw } = splitFeatureBlock(block(one));
    expect(raw).toBe(one);
    expect(display).toBe("# Plan\n\nProse first.\n\nClosing note.");
    expect(splitFeatureBlock("# Just prose").raw).toBeNull();
    // A plain json block is not the feature list.
    expect(splitFeatureBlock("```json\n[]\n```").raw).toBeNull();
  });

  test("refuses missing, malformed and unsafe lists with a readable reason", () => {
    const cases: Array<[string, string]> = [
      ["# Just prose", "no `caddie-features` block"],
      [block("[{"), "not valid JSON"],
      [block("[]"), "at least one feature"],
      [block(JSON.stringify([{ id: "Bad Id", title: "x", doneWhen: ["a"] }])), "slug"],
      [block(JSON.stringify([{ id: "a", title: "x", doneWhen: [] }])), "doneWhen"],
      [block(JSON.stringify([{ id: "a", title: "x", doneWhen: ["y"] }, { id: "a", title: "z", doneWhen: ["y"] }])), "unique"],
      [block(JSON.stringify([{ id: "a", title: "x", doneWhen: ["y"], extra: true }])), "invalid"],
      [block(JSON.stringify(Array.from({ length: MAX_PLAN_FEATURES + 1 }, (_, i) => ({ id: `f${i}`, title: "x", doneWhen: ["y"] })))), `${MAX_PLAN_FEATURES}`],
    ];
    for (const [body, reason] of cases) {
      const parsed = parsePlanFeatures(body);
      expect(parsed.ok, body).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(reason);
    }
  });

  test("a plan without a list builds as one whole-plan feature", () => {
    expect(featuresForPlan("# Old plan").map((f) => f.id)).toEqual(["whole-plan"]);
    expect(featuresForPlan(block(one)).map((f) => f.id)).toEqual(["log-feed"]);
  });
});
