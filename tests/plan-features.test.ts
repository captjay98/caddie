import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MAX_DESIGN_MOCK_TITLE, MAX_PLAN_FEATURES, parsePlanFeatures, splitChatMocks, splitDesignMocks, splitFeatureBlock } from "../packages/contracts/src/features.ts";
import { featuresForPlan, featureViews, type BuildFeatureRow } from "../apps/app/src/server/build-features.ts";

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

describe("a stopped build never says a feature is \"Building now\" (plan 3.2)", () => {
  const row = (featureId: string, position: number, status: BuildFeatureRow["status"], attempts = 0): BuildFeatureRow => ({
    projectId: "p", runId: "r", planId: "plan", featureId, position, title: featureId, doneWhen: ["it works"],
    status, attempts, testsPassed: status === "passed" ? 3 : null, checkpointRef: status === "passed" ? "ref" : null, passedAt: null,
  });
  const rows = [row("f1", 1, "passed"), row("f2", 2, "building", 1), row("f3", 3, "pending")];

  test("while building, the feature in progress shows as building", () => {
    expect(featureViews({ rows }, "building").map((view) => view.status)).toEqual(["passed", "building", "pending"]);
  });

  test("once the build is stopped, paused, finished or back in planning, it is up next again", () => {
    for (const phase of ["blocked", "ready", "planning", "review", "design", "design-review"] as const) {
      expect({ phase, statuses: featureViews({ rows }, phase).map((view) => view.status) }).toEqual({ phase, statuses: ["passed", "pending", "pending"] });
    }
  });
});

describe("a design mock that lands in a chat reply is drawn, never printed as HTML (plan 4.5)", () => {
  const SCREEN = '<main class="screen">\n  <h1>Herd today</h1>\n  <p>3 goats need a look</p>\n</main>';

  test("a bare screen and a fenced one come out as mocks, in order, with the prose kept around them", () => {
    const reply = `Here is the home screen.\n\n${SCREEN}\n\nAnd when nothing is logged yet:\n\n\`\`\`html-mock Home · empty\n<main><p>No animals yet</p></main>\n\`\`\`\n\nTell me what to change.`;
    const { before, after, mocks, drawing } = splitChatMocks(reply);
    expect(mocks).toEqual([
      { title: "Screen 1", html: SCREEN },
      { title: "Home · empty", html: "<main><p>No animals yet</p></main>" },
    ]);
    expect(before).toBe("Here is the home screen.");
    expect(after).toBe("And when nothing is logged yet:\n\nTell me what to change.");
    expect(drawing).toBe(false);
  });

  test("a whole page, an html block and a style sheet before the screen are all part of the mock", () => {
    const page = "<!doctype html>\n<html><body><main><h1>Log feed</h1></main></body></html>";
    expect(splitChatMocks(`Look:\n\n${page}`).mocks).toEqual([{ title: "Screen 1", html: page }]);
    expect(splitChatMocks("```html\n<div class=\"card\"><b>12 kg</b></div>\n```").mocks).toEqual([{ title: "Screen 1", html: '<div class="card"><b>12 kg</b></div>' }]);
    const styled = "<style>h1{color:var(--color-action)}</style>\n<main><h1>Eggs</h1></main>";
    expect(splitChatMocks(styled)).toMatchObject({ before: "", after: "", mocks: [{ title: "Screen 1", html: styled }] });
  });

  test("code in another language and a tag named inside a sentence stay as they are", () => {
    const prose = "The `<main>` tag holds the page.\n\n```js\nconst page = `<main>hi</main>`;\n```";
    expect(splitChatMocks(prose)).toEqual({ before: prose, after: "", mocks: [], drawing: false });
  });

  test("a mock still being written is cut from the prose; once the reply is done it is drawn as it stands", () => {
    const streaming = splitChatMocks("Drawing it now.\n\n```html-mock Today\n<main><h1>Herd to", { complete: false });
    expect(streaming).toEqual({ before: "Drawing it now.", after: "", mocks: [], drawing: true });
    expect(splitChatMocks("Drawing it now.\n\n<main><h1>Herd to", { complete: false })).toMatchObject({ before: "Drawing it now.", mocks: [], drawing: true });
    expect(splitChatMocks("Done.\n\n```html-mock Today\n<main><h1>Herd today</h1>")).toEqual({
      before: "Done.", after: "", mocks: [{ title: "Today", html: "<main><h1>Herd today</h1>" }], drawing: false,
    });
  });
});

describe("mockups have one way onto the screen (plan 4.5)", () => {
  const read = (path: string) => readFileSync(new URL(`../apps/app/src/${path}`, import.meta.url), "utf8");

  test("chat replies and the build card's latest update draw their mockups", () => {
    expect(read("client/conversation/Channel.tsx")).toMatch(/<ReplyText text=\{part\.text\} streaming=\{part\.state === 'streaming'\} \/>/);
    expect(read("client/conversation/ProjectWorkflow.tsx")).toMatch(/<ReplyText key=\{i\} text=\{p\.text\} streaming=\{p\.state === "streaming"\} \/>/);
  });

  test("Caddie keeps mockups in the design brief and never pastes HTML into a reply", () => {
    expect(read("agents/coordinator.ts")).toContain("Never paste a mockup or any HTML into a reply: the card draws the brief's mockups");
  });
});
