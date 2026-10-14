import { describe, test, expect } from "bun:test";
import { deriveEnrichment, describeEnrichment, type EnrichmentFile } from "../apps/app/src/server/profile-enrichment.ts";

/**
 * Stage 3 (Caddie learns you — infer from GitHub) LOCAL VERIFIED: the PURE
 * inference from a repo manifest. No network, no DB, nothing written — it
 * returns PROPOSALS the coordinator surfaces for the user to confirm (CL1
 * confirmation rule). This proves the derivation only; a live repo import is
 * the separate live gate.
 */

const files = (paths: string[]): EnrichmentFile[] => paths.map((p) => ({ path: p, size: 100 }));

describe("deriveEnrichment — language skills", () => {
  test("ranks languages by file count with confidence", () => {
    const result = deriveEnrichment(files([
      "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts",
      "scripts/x.py", "scripts/y.py",
      "main.go",
    ]));
    const ts = result.skills.find((s) => s.skill === "TypeScript");
    expect(ts?.confidence).toBe("high"); // 6 files
    const py = result.skills.find((s) => s.skill === "Python");
    expect(py?.confidence).toBe("medium"); // 2 files
    const go = result.skills.find((s) => s.skill === "Go");
    expect(go?.confidence).toBe("low"); // 1 file
    // top-3 only
    expect(result.skills.length).toBeLessThanOrEqual(3);
  });
});

describe("deriveEnrichment — stack from dependency manifests", () => {
  test("react + hono in package.json -> react-hono (high)", () => {
    const result = deriveEnrichment(files(["src/main.tsx"]), { packageJsonDeps: ["react", "react-dom", "hono"] });
    const stack = result.stacks.find((s) => s.stackId === "react-hono");
    expect(stack?.confidence).toBe("high");
  });

  test("flutter pubspec -> flutter stack", () => {
    const result = deriveEnrichment(files(["lib/main.dart"]), { pubspec: "dependencies:\n  flutter:\n    sdk: flutter\n" });
    expect(result.stacks.some((s) => s.stackId === "flutter")).toBe(true);
  });

  test("laravel composer -> laravel-inertia stack", () => {
    const result = deriveEnrichment(files(["app/Http/Kernel.php"]), { composer: '{"require":{"laravel/framework":"^11.0"}}' });
    expect(result.stacks.some((s) => s.stackId === "laravel-inertia")).toBe(true);
  });

  test("react alone (no hono) does not claim a stack it cannot verify", () => {
    const result = deriveEnrichment(files(["src/main.tsx"]), { packageJsonDeps: ["react", "react-dom"] });
    expect(result.stacks.find((s) => s.stackId === "react-hono")).toBeUndefined();
  });
});

describe("deriveEnrichment — working-style note from tests", () => {
  test("test files present -> writes-tests fact", () => {
    const result = deriveEnrichment(files(["src/a.ts", "src/b.ts", "src/c.ts", "src/a.test.ts", "tests/b_test.py"]));
    expect(result.notes.some((n) => n.content.includes("automated tests"))).toBe(true);
  });

  test("no test files in a real codebase -> gentle 'may value help adding tests'", () => {
    const result = deriveEnrichment(files(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]));
    expect(result.notes.some((n) => n.content.includes("no test files"))).toBe(true);
  });
});

describe("deriveEnrichment — honest empty + describe", () => {
  test("an empty / non-code repo yields an empty proposal, not invented facts", () => {
    const result = deriveEnrichment(files(["README.md", "LICENSE", "docs/guide.md"]));
    expect(result.empty).toBe(true);
    expect(result.skills).toHaveLength(0);
    expect(result.stacks).toHaveLength(0);
    expect(describeEnrichment(result)).toContain("could not infer");
  });

  test("describe reads back as a confirmation ask, never a silent write", () => {
    const result = deriveEnrichment(files(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]), { packageJsonDeps: ["react", "hono"] });
    const summary = describeEnrichment(result);
    expect(summary).toContain("Want me to remember");
  });
});
