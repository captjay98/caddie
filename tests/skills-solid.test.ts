import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SPECIALIST_CATALOG, SPECIALIST_INSTRUCTIONS } from "../apps/app/src/agents/specialists.ts";

/**
 * LOCAL VERIFIED (2026-10-23 agent hardening, part 3): every agent's skills are
 * solid — build-verify is written around run_checks (shell test commands are
 * refused), QA carries only what it can do, mobile claims only what its tools
 * can, backend/frontend/tech-lead carry real discipline, the dead planned-stack
 * skills are gone, and the manifest hashes match the packaged SKILL.md files.
 */

const REPO = join(import.meta.dir, "..");
const SKILLS = join(REPO, "apps", "app", "src", "agents", "skills");
const skill = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

describe("part 3 — build-verify is written around run_checks", () => {
  const bv = skill("build-verify");
  test("it names run_checks as the one way to run checks, and keeps 'a self-report is never success'", () => {
    expect(bv).toContain("run_checks");
    expect(bv.toLowerCase()).toContain("self-report is never success");
  });
  test("it drops the tests/acceptance guidance for generated apps", () => {
    expect(bv).not.toContain("tests/acceptance/**");
    expect(bv).toContain("Generated apps have no");
    expect(bv).toContain("tests/acceptance/");
    expect(bv).toContain("do not write one");
  });
  test("it does not tell the builder to run tests through sandbox_exec", () => {
    expect(bv).not.toContain("sandbox_exec");
  });
});

describe("part 3 — QA carries only what its job uses", () => {
  test("QA no longer carries the submission skill (its job is verify_build)", () => {
    const qa = SPECIALIST_CATALOG.find((d) => d.role === "qa")!;
    expect(qa.skills).toEqual(["build-verify"]);
    expect(qa.skills).not.toContain("submission");
  });
});

describe("part 3 — mobile claims only what its tools can do", () => {
  const m = SPECIALIST_INSTRUCTIONS.mobile;
  test("the impossible 'real device evidence beats screenshots' line is gone", () => {
    expect(m).not.toContain("Real device evidence beats screenshots");
  });
  test("it verifies through run_checks and disclaims device/emulator/screenshots", () => {
    expect(m).toContain("run_checks");
    expect(m).toContain("no device, emulator or adb");
  });
});

describe("part 3 — backend and frontend carry real discipline", () => {
  test("backend: Hono + D1 discipline", () => {
    const b = SPECIALIST_INSTRUCTIONS.backend;
    expect(b).toContain("requireUser(c)");
    expect(b).toContain("integer minor units");
    expect(b).toContain("validate every input");
    expect(b).toContain("never put a secret");
  });
  test("frontend: matches the design using the theme and the icon kit", () => {
    const f = SPECIALIST_INSTRUCTIONS.frontend;
    expect(f).toContain('read_project_context ["design"]');
    expect(f).toContain("caddie/theme.css");
    expect(f).toContain('import { Icon } from "../caddie/icons"');
    expect(f).toContain("44px");
  });
  test("tech-lead checks every PRD feature has a screen in the approved design", () => {
    const t = SPECIALIST_INSTRUCTIONS["tech-lead"];
    expect(t).toContain("every PRD feature must have a screen in the design brief");
    expect(t).toContain("caddie-theme");
  });
});

describe("part 3 — the dead planned-stack skills are deleted", () => {
  for (const dead of ["fastapi-react", "tanstack-start", "laravel-inertia", "flutter"]) {
    test(`${dead}/SKILL.md is gone (no code or test referenced it, and flutter contradicted the live recipe)`, () => {
      expect(existsSync(join(SKILLS, dead, "SKILL.md"))).toBe(false);
    });
  }
});

describe("part 3 — the manifest hashes match the packaged SKILL.md files", () => {
  const manifest = JSON.parse(readFileSync(join(SKILLS, "manifest.json"), "utf8")) as {
    skills: { name: string; path: string; sha256: string; version: string }[];
  };
  test("every manifest entry's sha256 is the real file hash, and the file exists", () => {
    for (const entry of manifest.skills) {
      const content = readFileSync(join(SKILLS, entry.path), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash, `${entry.name} hash`).toBe(entry.sha256);
      expect(entry.version.length).toBeGreaterThan(0);
    }
  });
  test("the manifest lists exactly the five packaged skills", () => {
    expect(manifest.skills.map((s) => s.name).sort()).toEqual(
      ["build-verify", "delivery-checklist", "design", "planning", "submission"].sort(),
    );
  });
});
