import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockDocument } from "../apps/app/src/client/artifacts/DesignMockPreview.tsx";
import { themeToCssVars, type AppTheme } from "../packages/contracts/src/theme.ts";

/**
 * LOCAL VERIFIED (2026-10-23 agent hardening, part 2c): the design-mock preview
 * paints each mock in the APP's own validated theme, not Caddie's live
 * dashboard theme. Before this, readThemeTokens() copied Caddie's --color-*
 * into every mock, so every app's design looked like Caddie.
 */

const THEME: AppTheme = {
  name: "Warm and bold",
  why: "Dark background with amber highlights, gentle on the eyes at dawn and dusk.",
  colors: {
    bg: "#15120E",
    surface: "#221D17",
    text: "#F5EFE6",
    muted: "#B8AC9A",
    primary: "#F2A541",
    onPrimary: "#1A1208",
    border: "#3A3228",
    ok: "#8FD19E",
    warn: "#FFB86B",
    danger: "#FF8A8A",
  },
  fonts: { heading: "ui-rounded, system-ui, sans-serif", body: "ui-rounded, system-ui, sans-serif" },
  radius: 20,
  density: "comfortable",
};

describe("part 2c — the mock frame is painted with the app theme's tokens", () => {
  test("mockDocument injects the app theme's plain values and the --color-* aliases", () => {
    const doc = mockDocument("<main>hi</main>", themeToCssVars(THEME));
    // the app's own primary value is present…
    expect(doc).toContain("#F2A541");
    expect(doc).toContain("--primary: #F2A541;");
    // …and the old Caddie names alias to the app's values, so older mock markup
    // written against --color-ink/--color-action paints in THIS app's theme.
    expect(doc).toMatch(/--color-ink:\s*var\(--bg\)/);
    expect(doc).toMatch(/--color-action:\s*var\(--primary\)/);
    // and the frame still forbids scripts and network (unchanged safety).
    expect(doc).toContain("script-src 'none'");
  });
});

describe("part 2c — the call sites wire the app theme", () => {
  test("DesignMockPreview chooses the app theme when one is given, else today's tokens", () => {
    const src = readFileSync(join(import.meta.dir, "..", "apps", "app", "src", "client", "artifacts", "DesignMockPreview.tsx"), "utf8");
    // The component takes an optional theme and prefers it over readThemeTokens.
    expect(src).toContain("theme?: AppTheme | null");
    expect(src).toContain("theme ? themeToCssVars(theme) : readThemeTokens()");
  });

  test("the design-review card parses the brief's theme and passes it", () => {
    const src = readFileSync(join(import.meta.dir, "..", "apps", "app", "src", "client", "conversation", "ProjectWorkflow.tsx"), "utf8");
    expect(src).toContain("parseAppTheme(state.data.design.body)");
    expect(src).toContain("theme={appTheme}");
  });
});
