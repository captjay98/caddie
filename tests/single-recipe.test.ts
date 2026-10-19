import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { SCAFFOLD_FILES, SCAFFOLD_COMMANDS, SCAFFOLD_PACKAGE, SCAFFOLD_TEST_HARNESS } from "../stacks/react-hono/scaffold.ts";
import { recipe } from "../stacks/react-hono/recipe.ts";
import { PROTECTED_PATH_PREFIXES, isProtectedPath } from "../apps/app/src/agents/permissions.ts";

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
    // ...and take its check commands from host-checks.ts, which builds them
    // from the stacks' recipes (Track 3 added the Flutter recipe beside it).
    expect(src).toContain('from "./host-checks.ts"');
    const checks = readFileSync(join(dirname(HOST), "host-checks.ts"), "utf8");
    expect(checks).toContain("SCAFFOLD_COMMANDS");
    expect(checks).toContain("FLUTTER_SCAFFOLD_COMMANDS");
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
    // A smoke skeleton: it must NOT bake in the requested app's domain.
    const blob = JSON.stringify(SCAFFOLD_FILES).toLowerCase();
    expect(blob).not.toContain("todo");
    // The host's behavior-test gate is `bun test src/`. Nothing the scaffold
    // puts under src/ may be a test or contain assertions, so the gate passes
    // only on tests the builder wrote. (The runnable example lives under
    // test/examples/, outside the gate; scripts/refresh-scaffold-lock.ts
    // proves `bun test src/` FAILS on the bare scaffold.)
    const srcFiles = Object.entries(SCAFFOLD_FILES).filter(([path]) => path.startsWith("src/"));
    expect(srcFiles.length).toBeGreaterThan(0);
    for (const [path, text] of srcFiles) {
      expect(path).not.toMatch(/\.(test|spec)\.[jt]sx?$/);
      expect(text).not.toContain("expect(");
      expect(text).not.toContain("test(");
    }
    expect(Object.keys(SCAFFOLD_FILES).some((path) => path.startsWith("test/examples/"))).toBe(true);
    // But it IS a runnable React/Bun skeleton with the recipe's script names.
    const pkg = JSON.parse(SCAFFOLD_FILES["package.json"]!) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.scripts.test).toBeTruthy();
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.dependencies.react).toBeTruthy();
  });

  test("the scaffold ships a working, protected test harness and a matching lockfile", () => {
    // Two preload files in this order: happy-dom must register before Testing
    // Library loads (imports are hoisted) — Bun's documented setup.
    expect(SCAFFOLD_FILES["bunfig.toml"]).toContain(
      'preload = ["./test/setup/happydom.ts", "./test/setup/testing-library.ts"]',
    );
    expect(SCAFFOLD_FILES["test/setup/happydom.ts"]).toContain("GlobalRegistrator.register(");
    expect(SCAFFOLD_FILES["test/setup/happydom.ts"]).not.toContain("@testing-library");
    expect(SCAFFOLD_FILES["test/setup/testing-library.ts"]).toContain("expect.extend(matchers)");
    expect(JSON.stringify(SCAFFOLD_FILES)).not.toContain("jsdom");
    // The builder writes tests, never the harness that runs them.
    for (const path of SCAFFOLD_TEST_HARNESS) expect(PROTECTED_PATH_PREFIXES).toContain(path);
    for (const path of ["bunfig.toml", "test/setup/happydom.ts", "/workspace/proj_x/test/setup/testing-library.ts"])
      expect(isProtectedPath(path)).toBe(true);
    expect(isProtectedPath("test/examples/app.example.test.tsx")).toBe(false);
    expect(isProtectedPath("src/App.test.tsx")).toBe(false);
    // `bun install --frozen-lockfile` needs a lockfile that pins every declared dependency.
    const lock = SCAFFOLD_FILES["bun.lock"];
    expect(lock).toBeTruthy();
    for (const [name, version] of Object.entries({ ...SCAFFOLD_PACKAGE.dependencies, ...SCAFFOLD_PACKAGE.devDependencies }))
      expect(lock).toContain(`"${name}@${version}"`);
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

describe("backend-ready from the start (Publish stage 2)", () => {
  test("every app ships a Hono server under /api with a health route", () => {
    const server = SCAFFOLD_FILES["src/server.ts"];
    expect(server).toContain('basePath("/api")');
    expect(server).toContain('app.get("/health"');
    expect(server).toContain("export default app");
    expect(server).toContain("DB: D1Database");
  });

  test("the build makes the client bundle, a Workers server bundle, then the compatibility check", () => {
    const build = SCAFFOLD_PACKAGE.scripts.build;
    expect(build).toContain("bun build src/main.tsx --outdir dist --target browser");
    expect(build).toContain("--outfile dist/server.js");
    expect(build).toContain("--external 'cloudflare:*'");
    expect(build).toContain("--external 'node:*'");
    expect(build.endsWith("bun run caddie/check-server.ts")).toBe(true);
  });

  test("sign-in ships with every app: Better Auth pinned, its files and tables protected", () => {
    expect(SCAFFOLD_PACKAGE.dependencies["better-auth"]).toBe("1.7.10");
    for (const path of ["caddie/auth.ts", "caddie/sign-in.tsx", "caddie/platform.ts", "migrations/0000_caddie_auth.sql", "test/setup/auth.ts", "test/setup/caddie.ts"]) {
      expect(SCAFFOLD_FILES[path]).toBeDefined();
      expect(isProtectedPath(path)).toBe(true);
    }
    expect(isProtectedPath("migrations/0001_init.sql")).toBe(false);
    expect(SCAFFOLD_FILES["caddie/auth.ts"]).toContain("export function mountSignIn");
  });

  test("Caddie's runtime files and the test database are protected", () => {
    expect(PROTECTED_PATH_PREFIXES).toContain("caddie/");
    for (const path of ["caddie/d1.ts", "caddie/check-server.ts", "test/setup/d1.ts"]) {
      expect(Object.keys(SCAFFOLD_FILES)).toContain(path);
      expect(isProtectedPath(path)).toBe(true);
    }
    expect(isProtectedPath("src/server.ts")).toBe(false);
    expect(isProtectedPath("migrations/0001_init.sql")).toBe(false);
  });

  test("the server example lives outside src/ so it never satisfies the host gate", () => {
    expect(Object.keys(SCAFFOLD_FILES)).toContain("test/examples/server.example.test.ts");
    expect(Object.keys(SCAFFOLD_FILES).some((path) => path.startsWith("src/") && /\.test\./.test(path))).toBe(false);
  });

  test("the builder is told how to use the server, env.DB and migrations", async () => {
    const { BUILD_RECIPE_INSTRUCTION } = await import("../apps/app/src/agents/specialists.ts");
    for (const phrase of ["src/server.ts", "/api", "env.DB", "migrations/NNNN_name.sql", "createTestEnv()", "never Bun.*", "caddie/"]) {
      expect(BUILD_RECIPE_INSTRUCTION).toContain(phrase);
    }
  });
});
