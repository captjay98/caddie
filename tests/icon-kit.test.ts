import { describe, expect, test } from "bun:test";
import { KIT_FILES } from "../stacks/react-hono/kit-files.ts";
import { SCAFFOLD_FILES } from "../stacks/react-hono/scaffold.ts";
import { isProtectedPath } from "../apps/app/src/agents/permissions.ts";

/**
 * LOCAL VERIFIED (2026-10-23 agent hardening, part 2e): every app ships a small
 * inline-SVG icon kit, so the design skill's "use the Icon set — never emoji"
 * rule is possible. Before this, apps had no icon set at all. No npm dependency
 * is added; the glyphs are hand-authored in the 24px geometric stroke style
 * (Lucide is ISC; its notice is included).
 */

const icons = KIT_FILES["caddie/icons.tsx"] ?? "";

describe("part 2e — the inline-SVG icon kit ships in every app", () => {
  test("caddie/icons.tsx ships in the scaffold and is protected", () => {
    expect(SCAFFOLD_FILES["caddie/icons.tsx"]).toBeDefined();
    expect(isProtectedPath("caddie/icons.tsx")).toBe(true);
  });

  test("it exports an Icon component and a name union", () => {
    expect(icons).toContain("export function Icon");
    expect(icons).toContain("export type IconName");
  });

  test("the Icon is decorative (aria-hidden) by default and takes a label", () => {
    expect(icons).toContain("aria-hidden={label ? undefined : true}");
    expect(icons).toContain('role={label ? "img" : undefined}');
    expect(icons).toContain("aria-label={label}");
  });

  test("at least ~30 glyphs are defined as inline SVG", () => {
    expect(icons).toContain("<svg");
    // Count the glyph entries in the PATHS record (each `name: <...>` line).
    const names = [...icons.matchAll(/^\s{2}[a-zA-Z]+:\s*<(path|g|circle|rect)/gm)];
    expect(names.length).toBeGreaterThanOrEqual(30);
  });

  test("it adds NO icon library and uses no emoji — only this file's own SVG paths", () => {
    const imports = [...icons.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
    // Only React types are imported — no lucide, no @heroicons, no react-icons.
    expect(imports.every((i) => i === "react")).toBe(true);
    for (const banned of ["lucide", "heroicons", "react-icons", "@fortawesome"]) expect(icons).not.toContain(banned === "lucide" ? "from \"lucide" : banned);
    // No emoji anywhere in the glyph set (the whole point).
    expect(/\p{Extended_Pictographic}/u.test(icons)).toBe(false);
  });

  test("the Lucide ISC licence notice is included (provenance of the visual style)", () => {
    expect(icons).toContain("lucide.dev/license");
    expect(icons.toUpperCase()).toContain("ISC");
  });
});
