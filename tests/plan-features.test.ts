import { describe, expect, test } from "bun:test";
import { MAX_DESIGN_MOCK_TITLE, MAX_PLAN_FEATURES, parsePlanFeatures, splitDesignMocks, splitFeatureBlock } from "../packages/contracts/src/features.ts";
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

describe("design brief mockup extraction", () => {
  const fenceBlock = (info: string, html: string, fence = "```") => `${fence}${info}\n${html}\n${fence}`;

  test("extracts every titled html-mock block in order and returns the prose without them", () => {
    const body = [
      "# Design", "", "Screen inventory first.", "",
      fenceBlock("html-mock Today", "<main>today</main>"), "",
      "## States", "",
      fenceBlock("html-mock Today · empty", "<main>empty</main>", "~~~"), "",
      fenceBlock("html-mock   Add entry · error  ", "<main>error</main>"), "",
      "Accessibility note.",
    ].join("\n");
    const { display, mocks } = splitDesignMocks(body);
    expect(mocks).toEqual([
      { title: "Today", html: "<main>today</main>" },
      { title: "Today · empty", html: "<main>empty</main>" },
      { title: "Add entry · error", html: "<main>error</main>" },
    ]);
    expect(display).toBe("# Design\n\nScreen inventory first.\n\n## States\n\nAccessibility note.");
  });

  test("an untitled block is named by position, an empty block counts as absent", () => {
    const body = [fenceBlock("html-mock", "<b>a</b>"), fenceBlock("html-mock Blank", "   "), fenceBlock("html-mock", "<b>c</b>")].join("\n\n");
    expect(splitDesignMocks(body).mocks).toEqual([
      { title: "Screen 1", html: "<b>a</b>" },
      { title: "Screen 2", html: "<b>c</b>" },
    ]);
  });

  test("a brief with no mockup degrades to prose-only (never errors)", () => {
    const prose = "# Design\n\nAll words, no mock.";
    expect(splitDesignMocks(prose)).toEqual({ display: prose, mocks: [] });
  });

  test("look-alike fences are not mockups and stay in the prose", () => {
    for (const info of ["html", "html-mockup Today", "caddie-features"]) {
      const body = fenceBlock(info, "<b>x</b>");
      const { display, mocks } = splitDesignMocks(body);
      expect(mocks).toEqual([]);
      expect(display).toBe(body);
    }
  });

  test("an overlong title is cut to the picker's limit", () => {
    const { mocks } = splitDesignMocks(fenceBlock(`html-mock ${"x".repeat(200)}`, "<b>x</b>"));
    expect(mocks[0]?.title).toHaveLength(MAX_DESIGN_MOCK_TITLE);
  });
});
