/**
 * "How your app looks" — the theme block (2026-10-23 agent hardening, part 2).
 *
 * A plan's DESIGN document carries ONE fenced block with the info string
 * `caddie-theme` holding a JSON object that gives the app ITS OWN look: a
 * palette, two font stacks, a corner radius and a density. Like the
 * `caddie-features` and `caddie-architecture` blocks it lives inside the design
 * the user approves, so the approval binds to exactly this look.
 *
 * Why it exists: before this, every generated app was painted with Caddie's own
 * dashboard theme (the mock iframe copied Caddie's live CSS variables, the
 * design skill mandated Caddie's --color-* names, and a new app shipped a bare
 * `body{font-family:system-ui}`), so every app looked like Caddie. This block
 * is the single source of each app's colours and type.
 *
 * This file is the SHAPE and the DETERMINISTIC VALIDATION only — no I/O. Roles
 * match the owner-review mock ($KIROCREW_SCRATCH/lookfeel-mock.html). The
 * host-side wiring (refuse a design save with no valid theme; write the theme
 * into the scaffold's caddie/theme.css; inject it into the mock preview) reads
 * the helpers here.
 */

import * as v from 'valibot';

export const THEME_BLOCK_INFO = 'caddie-theme';

/** A 3- or 6-digit hex colour, like #1F7A3A or #fff. */
const Hex = v.pipe(
	v.string(),
	v.regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'a colour must be a hex value like "#1F7A3A" or "#fff"'),
);

/**
 * A font family must be a NAMED SYSTEM FONT STACK — the mock iframe's CSP is
 * `font-src data:`, so a web font (a url(), an @import, an unknown single
 * family) would silently fall back. We accept a comma-separated list whose
 * members are quoted or bare family names ending in a generic keyword or one of
 * the known system stacks. No url(), no parentheses, no http.
 */
const GENERIC_FAMILIES = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded']);
const FontStack = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1),
	v.maxLength(240),
	v.check((value) => !/url\(|@import|https?:|[(){}<>;]/i.test(value), 'a font must be a named system font stack, never a web font (no url(), @import or http)'),
	v.check((value) => {
		const families = value.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '').toLowerCase()).filter(Boolean);
		if (families.length === 0) return false;
		// The stack must END in a generic family (so there is always a system
		// fallback the iframe can paint) — the documented "named system font
		// stack" rule.
		return GENERIC_FAMILIES.has(families[families.length - 1]!);
	}, 'a font stack must end in a generic family like system-ui, sans-serif or serif'),
);

const Plain = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));

/**
 * The colour roles. The ten required roles match the mock; `stateSurfaces`
 * carries any tinted state backgrounds the designer needs (e.g. a warn-bg), and
 * each is validated for AA against its own foreground where one is given.
 */
export const ThemeColorsSchema = v.strictObject({
	/** The page background. */
	bg: Hex,
	/** A card / raised surface on the page. */
	surface: Hex,
	/** The main text colour, on bg and surface. */
	text: Hex,
	/** Secondary text, on bg and surface. */
	muted: Hex,
	/** The one primary action's fill. */
	primary: Hex,
	/** The label on the primary fill. */
	onPrimary: Hex,
	/** Borders and hairlines. */
	border: Hex,
	/** State colours, shown on a surface. */
	ok: Hex,
	warn: Hex,
	danger: Hex,
});
export type ThemeColors = v.InferOutput<typeof ThemeColorsSchema>;

/** A documented tinted state surface, with the foreground shown on it. */
export const StateSurfaceSchema = v.strictObject({
	/** A short slug naming the surface, e.g. "warnBg" or "dangerBg". */
	name: v.pipe(v.string(), v.regex(/^[a-z][a-zA-Z0-9]{0,31}$/, 'a state-surface name is a short camelCase slug like "warnBg"')),
	bg: Hex,
	/** The foreground painted on this surface; its AA contrast is checked. */
	fg: Hex,
	/** One plain line on what it is for. */
	plain: Plain,
});
export type StateSurface = v.InferOutput<typeof StateSurfaceSchema>;

export const DENSITIES = ['compact', 'comfortable', 'roomy'] as const;
export type Density = (typeof DENSITIES)[number];

export const AppThemeSchema = v.strictObject({
	/** The look's name, e.g. "Field-ready". */
	name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
	/**
	 * One plain sentence on why this look fits the app's audience. Up to 320
	 * characters: a 224-character sentence used to cost a whole looks round
	 * (EggOps Nigeria, 2026-10-30); the picker wraps it.
	 */
	why: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(320)),
	colors: ThemeColorsSchema,
	stateSurfaces: v.optional(v.pipe(v.array(StateSurfaceSchema), v.maxLength(8))),
	fonts: v.strictObject({ heading: FontStack, body: FontStack }),
	/** Corner radius in px (0 square, up to 32). */
	radius: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(32)),
	density: v.picklist(DENSITIES, 'density must be compact, comfortable or roomy'),
});
export type AppTheme = v.InferOutput<typeof AppThemeSchema>;

// --- deterministic WCAG contrast --------------------------------------------

/** Expand #abc to #aabbcc, then to [r,g,b] 0..255. */
function rgb(hex: string): [number, number, number] {
	let h = hex.slice(1);
	if (h.length === 3) h = h.split('').map((c) => c + c).join('');
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Relative luminance (WCAG 2.1). */
function luminance(hex: string): number {
	const channel = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const [r, g, b] = rgb(hex);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio between two hex colours (1..21). */
export function contrastRatio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal text. */
export const AA_CONTRAST = 4.5;

/**
 * Every contrast pair that must meet AA, as [foreground, background, label].
 * Matches the brief: text/bg, text/surface, muted/bg, muted/surface,
 * onPrimary/primary, and each state colour on bg and surface.
 */
function contrastPairs(colors: ThemeColors): [string, string, string][] {
	return [
		[colors.text, colors.bg, 'text on the background'],
		[colors.text, colors.surface, 'text on a surface'],
		[colors.muted, colors.bg, 'muted text on the background'],
		[colors.muted, colors.surface, 'muted text on a surface'],
		[colors.onPrimary, colors.primary, 'the label on the primary button'],
		[colors.ok, colors.surface, 'the "ok" colour on a surface'],
		[colors.warn, colors.surface, 'the "warn" colour on a surface'],
		[colors.danger, colors.surface, 'the "danger" colour on a surface'],
	];
}

export type ThemeParse = { ok: true; theme: AppTheme } | { ok: false; error: string };

// ```caddie-theme … ``` — the same fence shape the other blocks use.
const FENCE = new RegExp('^(`{3,}|~{3,})[ \\t]*' + THEME_BLOCK_INFO + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\\1[ \\t]*$', 'm');

/** Split a design brief into the prose a person reads and the raw theme JSON. */
export function splitThemeBlock(body: string): { display: string; raw: string | null } {
	const match = FENCE.exec(body);
	if (!match) return { display: body, raw: null };
	const display = (body.slice(0, match.index) + body.slice(match.index + match[0].length)).replace(/\n{3,}/g, '\n\n').trim();
	return { display, raw: match[2] ?? '' };
}

/**
 * Parse and validate the design brief's theme block. Never throws. Checks, in
 * order: the block exists, is JSON, matches the schema (hex colours, system
 * fonts), and every required contrast pair meets WCAG AA (4.5:1).
 */
export function parseAppTheme(body: string): ThemeParse {
	const { raw } = splitThemeBlock(body);
	if (raw === null) return { ok: false, error: `the design brief has no \`${THEME_BLOCK_INFO}\` block` };
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return { ok: false, error: `the ${THEME_BLOCK_INFO} block is not valid JSON (${error instanceof Error ? error.message : 'parse error'})` };
	}
	return validateAppTheme(json, `the ${THEME_BLOCK_INFO} block`);
}

/**
 * Validate one theme object (already parsed JSON): the schema (hex colours,
 * system fonts, radius, density), then every required contrast pair at WCAG AA.
 * `subject` names it in the error, e.g. 'the caddie-theme block' or 'look "calm"'.
 * Never throws. Shared by the design brief's theme block and each proposed look.
 */
export function validateAppTheme(json: unknown, subject = 'the theme'): ThemeParse {
	const parsed = v.safeParse(AppThemeSchema, json);
	const errors: string[] = [];
	if (!parsed.success) {
		for (const issue of parsed.issues) {
			const path = issue.path?.map((p) => String(p.key)).join('.') ?? '';
			errors.push(`${subject} is invalid${path ? ` at ${path}` : ''}: ${issue.message}`);
		}
	}
	// Report independent contrast failures even when another field (e.g. density)
	// is invalid. Only compare colours that have passed their strict schema.
	const source = json && typeof json === 'object' ? json as Record<string, unknown> : {};
	const colors = source.colors && typeof source.colors === 'object' ? source.colors as ThemeColors : null;
	if (colors) for (const [fg, bg, label] of contrastPairs(colors)) {
		if (!v.safeParse(Hex, fg).success || !v.safeParse(Hex, bg).success) continue;
		const ratio = contrastRatio(fg, bg);
		if (ratio < AA_CONTRAST)
			errors.push(`${subject}: not enough contrast for ${label}: ${fg} on ${bg} is ${ratio.toFixed(1)}:1, but ${AA_CONTRAST}:1 is needed so it stays readable. Pick a darker or lighter colour.`);
	}
	for (const item of Array.isArray(source.stateSurfaces) ? source.stateSurfaces : []) {
		const checked = v.safeParse(StateSurfaceSchema, item);
		if (!checked.success) continue;
		const surface = checked.output;
		const ratio = contrastRatio(surface.fg, surface.bg);
		if (ratio < AA_CONTRAST)
			errors.push(`${subject}: not enough contrast on the "${surface.name}" surface: ${surface.fg} on ${surface.bg} is ${ratio.toFixed(1)}:1, but ${AA_CONTRAST}:1 is needed.`);
	}
	if (!parsed.success || errors.length) return { ok: false, error: errors.join('\n') };
	const theme = parsed.output;
	return { ok: true, theme };
}

/**
 * Emit the theme as CSS custom properties, under the plain names the app and
 * the mock use (--bg, --surface, …) AND the old Caddie --color-* names aliased
 * to the app's values, so older mock markup renders in the app's theme instead
 * of Caddie's. The output is the body of a `:root { … }` rule.
 */
export function themeToCssVars(theme: AppTheme): string {
	const c = theme.colors;
	const lines: string[] = [
		`--bg: ${c.bg};`,
		`--surface: ${c.surface};`,
		`--text: ${c.text};`,
		`--muted: ${c.muted};`,
		`--primary: ${c.primary};`,
		`--on-primary: ${c.onPrimary};`,
		`--border: ${c.border};`,
		`--ok: ${c.ok};`,
		`--warn: ${c.warn};`,
		`--danger: ${c.danger};`,
		`--radius: ${theme.radius}px;`,
		`--font-heading: ${theme.fonts.heading};`,
		`--font-body: ${theme.fonts.body};`,
	];
	for (const surface of theme.stateSurfaces ?? []) {
		lines.push(`--${surface.name}: ${surface.bg};`);
		lines.push(`--${surface.name}-fg: ${surface.fg};`);
	}
	// Aliases: the old Caddie dashboard names mapped onto the app's own values,
	// so a mock written with --color-ink/--color-bright/… paints in THIS app's
	// theme. --color-ink is the PAGE BACKGROUND, --color-bright the main text.
	lines.push(
		`--color-ink: var(--bg);`,
		`--color-bright: var(--text);`,
		`--color-muted: var(--muted);`,
		`--color-panel: var(--surface);`,
		`--color-raised: var(--surface);`,
		`--color-line: var(--border);`,
		`--color-line-soft: var(--border);`,
		`--color-action: var(--primary);`,
		`--color-ok: var(--ok);`,
		`--color-warn: var(--warn);`,
		`--color-danger: var(--danger);`,
		`--font-ui: var(--font-body);`,
	);
	return lines.join('\n');
}

/**
 * The refusal message for saving a design with no valid theme, or null when the
 * body carries a valid theme. The host throws `THEME_INVALID: not saved — …`
 * from writePlanNote for kind "design", mirroring the PRD demo-contract
 * refusal, so the designer gets a plain line it can fix. Reading an older design
 * with no theme never calls this, so old saved designs stay readable.
 */
export function themeSaveError(body: string): string | null {
	const parsed = parseAppTheme(body);
	return parsed.ok ? null : parsed.error;
}

/** What the designer must write (shown in instructions and refusals). */
export const THEME_BLOCK_GUIDE =
	`Give the app its OWN look with ONE fenced ${THEME_BLOCK_INFO} block in the design brief, a JSON object:\n` +
	'```' + THEME_BLOCK_INFO + '\n' +
	JSON.stringify(
		{
			name: 'Field-ready',
			why: 'Dark text on a light background with big buttons, easy to read in bright sun.',
			colors: { bg: '#F7F5EF', surface: '#FFFFFF', text: '#1B1F1A', muted: '#55604f', primary: '#1F7A3A', onPrimary: '#FFFFFF', border: '#D9D6CC', ok: '#1F7A3A', warn: '#8A4300', danger: '#B00020' },
			fonts: { heading: "system-ui, -apple-system, 'Segoe UI', sans-serif", body: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
			radius: 10,
			density: 'comfortable',
		},
		null,
		2,
	) +
	'\n```\n' +
	'Rules: every colour is a hex value; fonts are NAMED SYSTEM FONT STACKS only (ending in a generic family like system-ui or sans-serif — no web fonts, the preview blocks them); radius is px (0-32); density is compact, comfortable or roomy. ' +
	'The look must fit who uses the app and where, and must NOT be the same every time. Colours must stay readable: text and muted text must contrast at least 4.5:1 against both the background and a surface, the label must contrast 4.5:1 against the primary fill, and each state colour 4.5:1 on a surface — Caddie refuses a design whose colours fail this. ' +
	'Add tinted state surfaces (e.g. a warn background) under "stateSurfaces", each with its own foreground and one plain line, and they are contrast-checked too.';
