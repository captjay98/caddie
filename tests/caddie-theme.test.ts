import { describe, expect, test } from "bun:test";
import {
  THEME_BLOCK_INFO,
  THEME_BLOCK_GUIDE,
  parseAppTheme,
  splitThemeBlock,
  themeToCssVars,
  type AppTheme,
} from "../packages/contracts/src/theme.ts";

/**
 * LOCAL VERIFIED (2026-10-23 agent hardening, part 2): the design brief carries
 * ONE validated ```caddie-theme block, so every generated app gets its own
 * look. Validation is deterministic — hex colours and WCAG AA contrast — and a
 * design save with no valid theme is refused with a plain message. Roles match
 * the owner-review mock.
 */

// A theme that passes: a light "field" look (dark text on light bg), AA-safe.
const GOOD: AppTheme = {
  name: "Field-ready",
  why: "Dark text on a light background with big buttons, easy to read in bright sun.",
  colors: {
    bg: "#F7F5EF",
    surface: "#FFFFFF",
    text: "#1B1F1A",
    muted: "#55604f",
    primary: "#1F7A3A",
    onPrimary: "#FFFFFF",
    border: "#D9D6CC",
    ok: "#1F7A3A",
    warn: "#8a4300",
    danger: "#b00020",
  },
  fonts: { heading: "system-ui, -apple-system, 'Segoe UI', sans-serif", body: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
  radius: 10,
  density: "comfortable",
};

function block(theme: unknown): string {
  return "# Design\n\nsome prose\n\n```" + THEME_BLOCK_INFO + "\n" + JSON.stringify(theme, null, 2) + "\n```\n\nmore prose";
}

describe("part 2 — the caddie-theme block parses out of a design brief", () => {
  test("splitThemeBlock lifts the block and leaves the prose", () => {
    const body = block(GOOD);
    const { display, raw } = splitThemeBlock(body);
    expect(raw).not.toBeNull();
    expect(display).toContain("some prose");
    expect(display).not.toContain(THEME_BLOCK_INFO);
  });

  test("a brief with no theme block degrades to raw null (old saved designs stay readable)", () => {
    const { raw } = splitThemeBlock("# Design\n\njust prose, no theme");
    expect(raw).toBeNull();
  });
});

describe("part 2 — parseAppTheme validates deterministically", () => {
  test("a good theme parses", () => {
    const parsed = parseAppTheme(block(GOOD));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.theme.name).toBe("Field-ready");
      expect(parsed.theme.colors.primary).toBe("#1F7A3A");
    }
  });

  test("a non-hex colour is refused", () => {
    const bad = { ...GOOD, colors: { ...GOOD.colors, primary: "rebeccapurple" } };
    const parsed = parseAppTheme(block(bad));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.toLowerCase()).toContain("hex");
  });

  test("text that does not meet 4.5:1 against its background is refused", () => {
    // light grey text on a near-white bg — well under AA.
    const bad = { ...GOOD, colors: { ...GOOD.colors, text: "#BBBBBB" } };
    const parsed = parseAppTheme(block(bad));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.toLowerCase()).toContain("contrast");
  });

  test("label text on the primary fill must meet 4.5:1 too", () => {
    // white onPrimary on a pale primary — fails.
    const bad = { ...GOOD, colors: { ...GOOD.colors, primary: "#CFE8D6", onPrimary: "#FFFFFF" } };
    const parsed = parseAppTheme(block(bad));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.toLowerCase()).toContain("contrast");
  });

  test("a web-font family (not a named system stack) is refused — the mock iframe has no web fonts", () => {
    const bad = { ...GOOD, fonts: { ...GOOD.fonts, heading: "url(https://fonts.example/x.woff2)" } };
    const parsed = parseAppTheme(block(bad));
    expect(parsed.ok).toBe(false);
  });

  test("a missing block is refused with a plain message naming the block", () => {
    const parsed = parseAppTheme("# Design\n\nno theme here");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(THEME_BLOCK_INFO);
  });
});

describe("part 2 — themeToCssVars emits plain token names and the --color-* aliases", () => {
  test("it emits the plain names and the old --color-* aliases to app values", () => {
    const css = themeToCssVars(GOOD);
    // plain names the mock + app use
    for (const name of ["--bg", "--surface", "--text", "--muted", "--primary", "--on-primary", "--border", "--ok", "--warn", "--danger", "--radius", "--font-heading", "--font-body"]) {
      expect(css).toContain(name);
    }
    // the old Caddie names, aliased to the app's values so older mock markup renders in the app theme
    expect(css).toContain("--color-ink");
    expect(css).toContain("--color-bright");
    expect(css).toContain("--color-action");
    // --color-ink is the page background -> aliases to --bg
    expect(css).toMatch(/--color-ink:\s*var\(--bg\)/);
    expect(css).toMatch(/--color-action:\s*var\(--primary\)/);
  });
});

describe("part 2 — the guide names the required roles for the designer", () => {
  test("the guide names the block, the colour roles and the font rule", () => {
    expect(THEME_BLOCK_GUIDE).toContain(THEME_BLOCK_INFO);
    for (const role of ["bg", "surface", "text", "primary", "onPrimary"]) expect(THEME_BLOCK_GUIDE).toContain(role);
    expect(THEME_BLOCK_GUIDE.toLowerCase()).toContain("system font");
  });
});
