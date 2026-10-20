import { describe, test, expect } from "bun:test";
import {
  buildTimeline,
  cleanCommand,
  fileArea,
  formatDuration,
  isTestCommand,
  parseTestCounts,
  planScope,
  relativePath,
  QUIET_AFTER_MS,
  type ActivityRow,
} from "../apps/app/src/server/build-timeline.ts";

/**
 * LOCAL VERIFIED (build timeline model): pure derivation from recorded
 * build_activity rows. No clock, no I/O — `nowMs` is injected.
 */
const T0 = Date.parse("2026-10-15T19:10:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function row(partial: Partial<ActivityRow> & Pick<ActivityRow, "kind" | "subject">, startMin: number, durMs = 2_000): ActivityRow {
  const startedAt = at(startMin);
  return {
    role: null,
    outcome: "ok",
    exitCode: null,
    testsPassed: null,
    testsFailed: null,
    bytes: null,
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + durMs).toISOString(),
    durationMs: durMs,
    ...partial,
  };
}

const ROOT = "/workspace/proj_cfcaa03cd8912ae9d65449360f9a9b6a";

describe("parsing helpers", () => {
  test("reads Bun's pass/fail summary and the passed/failed form; null when absent", () => {
    expect(parseTestCounts("bun test v1.3.14\n\n 12 pass\n 2 fail\n 40 expect() calls")).toEqual({ passed: 12, failed: 2 });
    expect(parseTestCounts(" 7 pass\n 0 fail")).toEqual({ passed: 7, failed: 0 });
    expect(parseTestCounts("Tests  3 passed | 1 failed")).toEqual({ passed: 3, failed: 1 });
    expect(parseTestCounts("error: Cannot find module 'react'")).toBeNull();
  });

  test("reads flutter test's summary line, its last one, and failures", () => {
    expect(parseTestCounts("00:01 +0: loading\n00:02 +1: first\n00:03 +2: All tests passed!")).toEqual({ passed: 2, failed: 0 });
    expect(parseTestCounts("00:02 +1: ok\n00:03 +1 -1: broken [E]\n00:04 +3 -1: Some tests failed.")).toEqual({ passed: 3, failed: 1 });
    expect(parseTestCounts("00:04 +2 ~1: All tests passed!")).toEqual({ passed: 2, failed: 0 });
    // A test file that does not compile: nothing passes, one failure.
    expect(parseTestCounts("00:05 +0 -1: Some tests failed.")).toEqual({ passed: 0, failed: 1 });
    // "Test directory test/app not found": no summary at all.
    expect(parseTestCounts('Test directory "test/app" not found.')).toBeNull();
  });

  test("sums a Flutter app's widget tests and its server's tests (caddie/run-tests.sh runs both)", () => {
    const both = "00:03 +4: All tests passed!\nbun test v1.4.2\n\n 3 pass\n 1 fail\n 9 expect() calls";
    expect(parseTestCounts(both)).toEqual({ passed: 7, failed: 1 });
    expect(parseTestCounts("00:03 +4: All tests passed!\n\n 3 pass\n 0 fail")).toEqual({ passed: 7, failed: 0 });
  });

  test("recognises test commands, including after a cd prefix", () => {
    expect(isTestCommand(`cd ${ROOT} && bun test src/ 2>&1 | head -80`)).toBe(true);
    expect(isTestCommand("bun run test")).toBe(true);
    expect(isTestCommand("bun install")).toBe(false);
    expect(isTestCommand("cat src/test-data.ts")).toBe(false);
  });

  test("buckets files into plain areas", () => {
    expect(fileArea("src/App.test.tsx")).toBe("test");
    expect(fileArea("src/styles.css")).toBe("style");
    expect(fileArea("package.json")).toBe("config");
    expect(fileArea("bunfig.toml")).toBe("config");
    expect(fileArea("src/server/routes.ts")).toBe("server");
    expect(fileArea("src/components/LogForm.tsx")).toBe("app");
  });

  test("strips the workspace root and cd prefix so paths and commands read as written", () => {
    expect(relativePath(`${ROOT}/src/App.tsx`)).toBe("src/App.tsx");
    expect(cleanCommand(`cd ${ROOT} && bun test src/ 2>&1 | head -80`)).toBe("bun test src/ 2>&1 | head -80");
  });

  test("collapses heredocs and multi-line commands to one readable line", () => {
    // A heredoc dumps a file's whole body into the command — keep the command,
    // mark that a block body followed, never the wall of text.
    expect(
      cleanCommand("cat > test/dom.preload.ts <<'EOF'\nimport './jsdom.setup';\nafterEach(() => cleanup());\nEOF"),
    ).toBe("cat > test/dom.preload.ts … (heredoc)");
    expect(cleanCommand(`cd ${ROOT} && cat > a.ts <<EOF\nbody\nEOF`)).toBe("cat > a.ts … (heredoc)");
    // A plain multi-line command keeps its first real line + an ellipsis.
    expect(cleanCommand("rm test/old.ts\nbun test src/")).toBe("rm test/old.ts …");
    // A single line is untouched (beyond the cd prefix + whitespace fold).
    expect(cleanCommand("bun install")).toBe("bun install");
  });

  test("formats durations compactly", () => {
    expect(formatDuration(40_000)).toBe("40 s");
    expect(formatDuration(4 * 60_000)).toBe("4 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 05 min");
  });
});

describe("planScope — what the plan says is being built", () => {
  test("takes the user stories under a bold label and trims 'As a …, I want to'", () => {
    const body = [
      "**Introduction**: FarmLog AI is a smartphone-first web app.",
      "",
      "**User Stories**:",
      "- As a farmer, I want to log daily feed amount (kg) so I can track intake.",
      "- As a farmer, I want to record average weight of fish/birds to monitor growth.",
      "- As a farmer, I want to receive alerts when FCR deviates beyond normal range.",
      "",
      "**Acceptance Criteria**: Log entries stored securely.",
      "- this bullet belongs to another section",
    ].join("\n");
    expect(planScope(body)).toEqual([
      "Log daily feed amount (kg) so I can track intake",
      "Record average weight of fish/birds to monitor growth",
      "Receive alerts when FCR deviates beyond normal range",
    ]);
  });

  test("reads a markdown Features heading and respects the limit", () => {
    const body = "# Todo\n\n## Features\n1. Add tasks\n2. Complete tasks\n3. Filter tasks\n\n## Out of scope\n- Sync";
    expect(planScope(body, 2)).toEqual(["Add tasks", "Complete tasks"]);
  });

  test("returns nothing rather than inventing scope", () => {
    expect(planScope("Just a paragraph with no list.")).toEqual([]);
    expect(planScope(null)).toEqual([]);
  });
});

describe("buildTimeline — stages, timing and honesty", () => {
  const writing: ActivityRow[] = [
    row({ kind: "setup", subject: "react-hono scaffold (9 files)" }, 0, 3_000),
    row({ kind: "file", subject: `${ROOT}/src/App.tsx`, bytes: 1200 }, 2),
    row({ kind: "file", subject: `${ROOT}/src/components/LogForm.tsx`, bytes: 900 }, 4),
    row({ kind: "file", subject: `${ROOT}/src/App.test.tsx`, bytes: 700 }, 6),
    row({ kind: "file", subject: `${ROOT}/src/App.tsx`, bytes: 1500 }, 8),
  ];

  test("before any action: nothing recorded, workspace being prepared", () => {
    const t = buildTimeline({ phase: "building", rows: [], nowMs: T0 });
    expect(t.startedAt).toBeNull();
    expect(t.summary).toBe("Caddie is getting the workspace ready.");
    expect(t.stages.every((s) => s.state === "pending")).toBe(true);
  });

  test("a working copy started again from a saved version says where it continued from", () => {
    const setup = (rows: ActivityRow[]) => buildTimeline({ phase: "building", rows, nowMs: T0 + 30 * 60_000 }).stages.find((s) => s.key === "setup")!;
    expect(setup(writing).detail).toBeNull();
    const resumed = [...writing, row({ kind: "setup", subject: "Continued from version 3; 1 feature built again" }, 20)];
    expect(setup(resumed).detail).toBe("Continued from version 3; 1 feature built again");
  });

  test("while writing: files are de-duplicated, newest first, and the write stage is active with live time", () => {
    const now = T0 + 9 * 60_000;
    const t = buildTimeline({ phase: "building", rows: writing, nowMs: now });
    expect(t.files.map((f) => f.path)).toEqual(["src/App.tsx", "src/App.test.tsx", "src/components/LogForm.tsx"]);
    expect(t.files[0]!.writes).toBe(2);
    expect(t.files[0]!.bytes).toBe(1500);
    expect(t.fileAreas).toMatchObject({ app: 2, test: 1 });
    const byKey = Object.fromEntries(t.stages.map((s) => [s.key, s]));
    expect(byKey.setup!.state).toBe("done");
    expect(byKey.write!.state).toBe("active");
    expect(byKey.write!.durationMs).toBe(7 * 60_000); // 19:12 → now (19:19)
    expect(byKey.write!.detail).toBe("3 files");
    expect(byKey.test!.state).toBe("pending");
    expect(t.elapsedMs).toBe(9 * 60_000);
    expect(t.summary).toBe("Writing the app — 3 files so far.");
    expect(t.quiet).toBe(false);
  });

  test("Caddie's own scratch files are not listed or counted as files written", () => {
    const rows = [
      ...writing,
      row({ kind: "file", subject: `${ROOT}/.caddie-scratch/probe.ts`, bytes: 300 }, 7),
      row({ kind: "file", subject: `${ROOT}/scratch-check.ts`, bytes: 200 }, 7),
    ];
    const t = buildTimeline({ phase: "building", rows, nowMs: T0 + 9 * 60_000 });
    expect(t.files.map((f) => f.path)).toEqual(["src/App.tsx", "scratch-check.ts", "src/App.test.tsx", "src/components/LogForm.tsx"]);
    expect(t.stages.find((s) => s.key === "write")!.detail).toBe("4 files");
  });

  test("a failing test run is reported with real counts and stays 'failed' after work loops back to writing", () => {
    const rows = [
      ...writing,
      row({ kind: "command", subject: `cd ${ROOT} && bun test src/`, outcome: "failed", exitCode: 1, testsPassed: 4, testsFailed: 2 }, 10, 30_000),
    ];
    const testing = buildTimeline({ phase: "building", rows, nowMs: T0 + 11 * 60_000 });
    expect(testing.tests).toEqual({ passed: 4, failed: 2, at: rows.at(-1)!.finishedAt });
    expect(testing.stages.find((s) => s.key === "test")!.state).toBe("active");
    expect(testing.summary).toBe("Its own tests: 4 passing, 2 failing. Caddie is fixing them.");
    expect(testing.commands[0]!.command).toBe("bun test src/");

    const fixing = buildTimeline({
      phase: "building",
      rows: [...rows, row({ kind: "file", subject: `${ROOT}/src/App.tsx` }, 12)],
      nowMs: T0 + 13 * 60_000,
    });
    expect(fixing.stages.find((s) => s.key === "write")!.state).toBe("active");
    expect(fixing.stages.find((s) => s.key === "test")!.state).toBe("failed");
    expect(fixing.stages.find((s) => s.key === "test")!.detail).toBe("4 passing · 2 failing");
  });

  test("long silence while building is reported as silence, not progress", () => {
    const t = buildTimeline({ phase: "building", rows: writing, nowMs: Date.parse(writing.at(-1)!.finishedAt) + QUIET_AFTER_MS + 60_000 });
    expect(t.quiet).toBe(true);
    expect(t.summary).toMatch(/^No activity for 6 min\./);
  });

  test("host checks: the latest attempt is shown, and a failed one names what failed", () => {
    const rows = [
      ...writing,
      row({ kind: "check", subject: "dependencies" }, 20, 40_000),
      row({ kind: "check", subject: "behavior-tests", outcome: "failed", exitCode: 1 }, 21, 20_000),
    ];
    const t = buildTimeline({ phase: "building", rows, nowMs: T0 + 22 * 60_000 });
    expect(t.checks.map((c) => [c.label, c.passed])).toEqual([["Install packages", true], ["Behaviour tests", false]]);
    expect(t.stages.find((s) => s.key === "check")!.detail).toBe("1 of 2 passed");
    expect(t.summary).toBe("A final check failed (behaviour tests). Caddie is fixing it.");
  });

  test("host checks are counted per attempt, the stage says which attempt, and attempts never mix (plan 3.4)", () => {
    const attempt = (start: number, testsPass: boolean) => [
      row({ kind: "check", subject: "dependencies" }, start, 30_000),
      row({ kind: "check", subject: "behavior-tests", outcome: testsPass ? "ok" : "failed", exitCode: testsPass ? 0 : 1 }, start + 1, 20_000),
      ...(testsPass ? [row({ kind: "check", subject: "browser-bundle" }, start + 2, 10_000)] : []),
    ];
    const rows = [
      ...writing,
      ...attempt(20, true),
      row({ kind: "file", subject: `${ROOT}/src/App.tsx`, bytes: 1200 }, 24),
      ...attempt(25, false),
      row({ kind: "file", subject: `${ROOT}/src/App.tsx`, bytes: 1300 }, 28),
      ...attempt(29, false),
    ];
    const t = buildTimeline({ phase: "building", rows, nowMs: T0 + 31 * 60_000 });
    expect(t.checks.map((c) => [c.label, c.passed])).toEqual([["Install packages", true], ["Behaviour tests", false]]);
    expect(t.stages.find((s) => s.key === "check")!.detail).toBe("Attempt 3: 1 of 2 passed");
    // More work after the attempt: still that attempt's own checks, never a mix with the one before.
    const after = buildTimeline({ phase: "building", rows: [...rows, row({ kind: "file", subject: `${ROOT}/src/App.tsx`, bytes: 1400 }, 32)], nowMs: T0 + 33 * 60_000 });
    expect(after.checks).toHaveLength(2);
    expect(after.stages.find((s) => s.key === "check")!.detail).toBe("Attempt 3: 1 of 2 passed");
  });

  test("'Run its own tests' counts the app's own tests from Caddie's check, since shell test runs are refused (plan 3.4)", () => {
    const rows = [
      row({ kind: "file", subject: `${ROOT}/src/App.tsx`, bytes: 900 }, 1),
      row({ kind: "check", subject: "dependencies" }, 5, 30_000),
      row({ kind: "check", subject: "behavior-tests", outcome: "failed", exitCode: 1, testsPassed: 7, testsFailed: 2 }, 6, 20_000),
    ];
    const failing = buildTimeline({ phase: "blocked", rows, nowMs: T0 + 8 * 60_000 });
    expect(failing.tests).toEqual({ passed: 7, failed: 2, at: rows[2]!.finishedAt });
    const stage = failing.stages.find((s) => s.key === "test")!;
    expect([stage.state, stage.detail]).toEqual(["failed", "7 passing · 2 failing"]);
    const fixed = [
      ...rows,
      row({ kind: "file", subject: `${ROOT}/src/App.tsx`, bytes: 950 }, 9),
      row({ kind: "check", subject: "dependencies" }, 10, 30_000),
      row({ kind: "check", subject: "behavior-tests", testsPassed: 9, testsFailed: 0 }, 11, 20_000),
    ];
    const passing = buildTimeline({ phase: "building", rows: fixed, nowMs: T0 + 12 * 60_000 });
    expect(passing.stages.find((s) => s.key === "test")!.detail).toBe("9 passing");
    expect(passing.stages.find((s) => s.key === "test")!.state).toBe("done");
  });

  test("ready: every recorded stage is done, the preview is ready, elapsed stops at the last action", () => {
    const rows = [
      ...writing,
      row({ kind: "command", subject: "bun test", testsPassed: 9, testsFailed: 0, exitCode: 0 }, 10, 20_000),
      row({ kind: "check", subject: "dependencies" }, 12),
      row({ kind: "check", subject: "behavior-tests" }, 13),
      row({ kind: "check", subject: "browser-bundle" }, 14),
    ];
    const t = buildTimeline({ phase: "ready", rows, nowMs: T0 + 90 * 60_000 });
    expect(t.stages.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(t.elapsedMs).toBe(14 * 60_000 + 2_000);
    expect(t.summary).toBe("Built and checked in 14 min. Your app is ready to try.");
    expect(t.idleMs).toBeNull();
  });

  test("blocked: the summary is the host's real blocker text", () => {
    const t = buildTimeline({ phase: "blocked", rows: writing, nowMs: T0 + 30 * 60_000, blockedDetail: "Caddie could not get the app checks passing after three attempts." });
    expect(t.summary).toBe("Caddie could not get the app checks passing after three attempts.");
    expect(t.stages.find((s) => s.key === "preview")!.state).toBe("pending");
  });

  test("scope never ticks off a plan item from file writes", () => {
    const t = buildTimeline({
      phase: "building",
      rows: writing,
      planBody: "**User Stories**:\n- As a farmer, I want to log feed.\n",
      nowMs: T0 + 9 * 60_000,
    });
    expect(t.scope).toEqual(["Log feed"]);
    // Scope entries are plain strings — there is no per-item done flag to fake.
    expect(typeof t.scope[0]).toBe("string");
  });
});
