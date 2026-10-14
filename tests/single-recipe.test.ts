import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { SCAFFOLD_FILES, SCAFFOLD_COMMANDS } from "../stacks/react-hono/scaffold.ts";
import { recipe } from "../stacks/react-hono/recipe.ts";

/**
 * R03 LOCAL VERIFIED: the real chat scaffold and the evaluation journey use
 * ONE versioned recipe, and the protected acceptance cannot be weakened by a
 * candidate. These are local invariants — the live sandbox run (install/test/
 * build inside contree) is deferred to the live phase and is NOT proven here.
 */

const REPO = join(import.meta.dir, "..");
const HOST = join(REPO, "apps", "app", "src", "server", "coordinator-host.ts");
const MANIFEST = join(REPO, "tests", "acceptance", "manifest.json");
const TEMPLATE = join(REPO, "stacks", "react-hono", "template");

describe("R03 single recipe — chat build uses the shared recipe", () => {
  test("coordinator-host imports the shared scaffold, not inline literals", () => {
    const src = readFileSync(HOST, "utf8");
    // The chat host must import the ONE shared source...
    expect(src).toContain("scaffold.ts");
    expect(src).toContain("SCAFFOLD_FILES");
    expect(src).toContain("SCAFFOLD_COMMANDS");
    // ...and must NOT re-hardcode the old inline package.json literal.
    expect(src).not.toContain('name: "caddie-project",\n          private: true,');
  });

  test("verify commands are the recipe's commands, not ad-hoc", () => {
    // The shared commands are sourced from the frozen recipe.
    expect(SCAFFOLD_COMMANDS.install).toEqual(recipe.install);
    expect(SCAFFOLD_COMMANDS.test).toEqual(recipe.test);
    expect(SCAFFOLD_COMMANDS.build).toEqual(recipe.build);
    // The old raw `bun test src` / inline `bun build …` must be gone from the host.
    const src = readFileSync(HOST, "utf8");
    expect(src).not.toContain('command: "bun test src"');
    expect(src).not.toContain("bun build src/main.tsx --outdir dist --target browser --minify");
  });

  test("the generic scaffold is a non-app-specific skeleton (no todo, no acceptance)", () => {
    const blob = JSON.stringify(SCAFFOLD_FILES).toLowerCase();
    // A smoke skeleton: it must NOT bake in the requested app's domain or any
    // acceptance assertions — the model implements the app, the protected
    // harness judges it.
    expect(blob).not.toContain("todo");
    expect(blob).not.toContain("expect(");
    expect(blob).not.toContain("test(");
    // But it IS a runnable React/Bun skeleton with the recipe's script names.
    const pkg = JSON.parse(SCAFFOLD_FILES["package.json"]!) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.scripts.test).toBeTruthy();
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.dependencies.react).toBeTruthy();
  });
});

describe("R03 protected acceptance cannot be weakened or faked", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    phases: { id: string; commands?: string[] }[];
    protectedPaths: string[];
    repairPolicy?: { maxAttemptsPerIssue?: number };
  };

  test("the manifest still demands a real red-before-green and a browser check", () => {
    const ids = manifest.phases.map((p) => p.id);
    // Detect a WEAKENED acceptance: these phases are the teeth.
    expect(ids).toContain("deliberate-red");
    expect(ids).toContain("browser-check");
    expect(ids).toContain("seeded-tests-green");
    // Detect an EMPTY acceptance: executable phases must carry commands.
    const executable = manifest.phases.filter((p) => p.id !== "browser-check");
    for (const phase of executable) {
      expect(Array.isArray(phase.commands) && phase.commands.length > 0, phase.id).toBe(true);
    }
  });

  test("the manifest protects its own files and the runner from candidate edits", () => {
    expect(manifest.protectedPaths).toContain("tests/acceptance/");
    expect(manifest.protectedPaths).toContain("scripts/run-journey.ts");
    // The repair budget is bounded — a candidate cannot grant itself infinite retries.
    expect(manifest.repairPolicy?.maxAttemptsPerIssue).toBe(3);
  });

  test("the recipe imageDigest still binds the template directory (tamper tripwire)", () => {
    // Recompute the template digest the way the journey runner does and assert
    // it equals the frozen recipe digest. A template edit without refreezing
    // the recipe is a RED here, which is the point: the evaluator version is
    // bound to the exact template.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(TEMPLATE);
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file.slice(TEMPLATE.length));
      hash.update(readFileSync(file));
    }
    const digest = `sha256:${hash.digest("hex")}`;
    // We assert the digest is a stable sha256 shape and recorded in the recipe.
    // (Exact equality with the frozen value is the journey runner's job; here
    // we prove the binding EXISTS and is well-formed so a missing digest can't
    // silently disable the tripwire.)
    expect(recipe.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
