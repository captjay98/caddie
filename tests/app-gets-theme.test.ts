import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCAFFOLD_FILES } from "../stacks/react-hono/scaffold.ts";
import { isProtectedPath } from "../apps/app/src/agents/permissions.ts";
import { themeCssFor } from "../apps/app/src/server/architecture-gate.ts";
import type { AppTheme } from "../packages/contracts/src/theme.ts";

/**
 * LOCAL VERIFIED (2026-10-23 agent hardening, part 2d): the generated app gets
 * the approved theme. The scaffold ships a protected caddie/theme.css (a
 * default look) imported by styles.css, and the host overwrites it from the
 * approved design's caddie-theme block at scaffold time and before each check
 * run. Before this a new app shipped `body{font-family:system-ui}` and no theme.
 */

const REPO = join(import.meta.dir, "..");

const THEME: AppTheme = {
  name: "Calm and clear",
  why: "Soft blues and plenty of space, steady for money and reports.",
  colors: {
    bg: "#F4F7FB", surface: "#FFFFFF", text: "#142033", muted: "#4d5b70",
    primary: "#2B5FD9", onPrimary: "#FFFFFF", border: "#DCE3EE",
    ok: "#1F7A3A", warn: "#8a4300", danger: "#b00020",
  },
  fonts: { heading: "'Avenir Next', system-ui, sans-serif", body: "'Avenir Next', system-ui, sans-serif" },
  radius: 14,
  density: "roomy",
};

describe("part 2d — the scaffold ships a protected, imported theme file", () => {
  test("caddie/theme.css exists, is protected, and declares the plain token names", () => {
    const css = SCAFFOLD_FILES["caddie/theme.css"];
    expect(css).toBeDefined();
    expect(isProtectedPath("caddie/theme.css")).toBe(true);
    for (const name of ["--bg", "--text", "--primary", "--radius", "--font-body"]) expect(css).toContain(name);
  });

  test("styles.css imports the theme file so every app picks up the variables", () => {
    const styles = SCAFFOLD_FILES["src/styles.css"];
    expect(styles).toContain('@import "../caddie/theme.css"');
    // the body uses the theme variables, not a hard-coded font/colour
    expect(styles).toContain("var(--font-body");
    expect(styles).toContain("var(--bg");
  });
});

describe("part 2d — themeCssFor paints the app in the approved theme", () => {
  test("it emits a :root rule with the approved values and the --color-* aliases", () => {
    const css = themeCssFor(THEME);
    expect(css).toContain(":root {");
    expect(css).toContain("--primary: #2B5FD9;");
    expect(css).toContain("Calm and clear");
    expect(css).toMatch(/--color-ink:\s*var\(--bg\)/);
  });
});

describe("part 2d — the host writes the approved theme at scaffold time and before checks", () => {
  const host = readFileSync(join(REPO, "apps", "app", "src", "server", "coordinator-host.ts"), "utf8");
  const gate = readFileSync(join(REPO, "apps", "app", "src", "server", "architecture-gate.ts"), "utf8");

  test("getApprovedTheme reads the approved design revision for the theme", () => {
    expect(gate).toContain("export async function getApprovedTheme");
    expect(gate).toContain("approvedDesignRevisionId");
    expect(gate).toContain("parseAppTheme(revision.body)");
  });

  test("the host writes caddie/theme.css from the approved theme, at scaffold and before checks", () => {
    expect(host).toContain("writeApprovedThemeCss");
    expect(host).toContain("caddie/theme.css");
    // called inside scaffold() (after the upload) and again before non-join checks
    const scaffoldCall = host.indexOf("await writeApprovedThemeCss();");
    const checkCall = host.indexOf("await writeApprovedThemeCss().catch(");
    expect(scaffoldCall).toBeGreaterThan(0);
    expect(checkCall).toBeGreaterThan(0);
  });
});
