/**
 * The "choose a look" step (owner-approved 2026-10-23,
 * docs/reviews/2026-10-23-look-and-feel-picker): after the plan is approved
 * Caddie proposes 2-3 distinct looks for the app, the owner picks one (or asks
 * for others), and the design brief is then written in the chosen look.
 *
 * A looks proposal is a plan note of kind "looks": prose, ONE fenced
 * ```caddie-looks JSON block, and ONE ```html-mock block holding the app's key
 * screen painted with the theme variables (--bg, --surface, --text, --muted,
 * --primary, --on-primary, --border, --ok, --warn, --danger, --radius,
 * --font-heading, --font-body). The picker paints that one screen in each look,
 * so the owner compares the same screen side by side.
 *
 * Each look is an AppTheme plus an `id`, validated by the SAME rules as the
 * design brief's caddie-theme block (hex colours, system fonts, WCAG AA).
 */
import * as v from 'valibot';
import { THEME_BLOCK_INFO, validateAppTheme, type AppTheme } from './theme.ts';
import { splitDesignMocks, type DesignMock } from './features.ts';

export const LOOKS_BLOCK_INFO = 'caddie-looks';
export const MIN_LOOKS = 2;
export const MAX_LOOKS = 3;

/** One proposed look: a full app theme plus a short id the choice refers to. */
export type Look = AppTheme & { id: string };

export interface LooksSet {
	/** Who uses the app and where, in plain words (from the plan). */
	audience: string;
	/** The id of the look Caddie recommends; the picker starts on it. */
	recommended: string;
	looks: Look[];
	/** The key screen every look is previewed on. */
	screen: DesignMock;
	/** The proposal's prose, with the blocks taken out. */
	display: string;
}

export type LooksParse = { ok: true; set: LooksSet } | { ok: false; error: string };

const Slug = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,23}$/, 'a look id is a short lowercase slug like "field" or "calm-blue"'));

const LooksEnvelopeSchema = v.strictObject({
	audience: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
	recommended: Slug,
	looks: v.pipe(
		v.array(v.looseObject({ id: Slug })),
		v.minLength(MIN_LOOKS, `propose ${MIN_LOOKS} or 3 looks`),
		v.maxLength(MAX_LOOKS, `propose ${MIN_LOOKS} or 3 looks`),
	),
});

// ```caddie-looks … ``` — the same fence shape as the other blocks.
const FENCE = new RegExp('^(`{3,}|~{3,})[ \\t]*' + LOOKS_BLOCK_INFO + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\\1[ \\t]*$', 'm');

/** Split a looks proposal into its prose and the raw caddie-looks JSON. */
export function splitLooksBlock(body: string): { display: string; raw: string | null } {
	const match = FENCE.exec(body);
	if (!match) return { display: body, raw: null };
	const display = (body.slice(0, match.index) + body.slice(match.index + match[0].length)).replace(/\n{3,}/g, '\n\n').trim();
	return { display, raw: match[2] ?? '' };
}

/**
 * Parse and validate a looks proposal. Never throws. Checks: the block exists
 * and is JSON; 2-3 looks; unique ids and names; every look passes the theme
 * rules (schema + contrast); the looks really differ (no two share both the
 * background and the main colour); the recommended look exists; and there is
 * one html-mock key screen to preview them on.
 */
export function parseLooks(body: string): LooksParse {
	const { display: withoutLooks, raw } = splitLooksBlock(body);
	if (raw === null) return { ok: false, error: `the looks proposal has no \`${LOOKS_BLOCK_INFO}\` block` };
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return { ok: false, error: `the ${LOOKS_BLOCK_INFO} block is not valid JSON (${error instanceof Error ? error.message : 'parse error'})` };
	}
	const envelope = v.safeParse(LooksEnvelopeSchema, json);
	if (!envelope.success) {
		const issue = envelope.issues[0];
		const path = issue?.path?.map((p) => String(p.key)).join('.') ?? '';
		return { ok: false, error: `the ${LOOKS_BLOCK_INFO} block is invalid${path ? ` at ${path}` : ''}: ${issue?.message ?? 'unknown problem'}` };
	}
	const looks: Look[] = [];
	for (const item of envelope.output.looks) {
		const { id, ...theme } = item as { id: string } & Record<string, unknown>;
		const checked = validateAppTheme(theme, `look "${id}"`);
		if (!checked.ok) return checked;
		looks.push({ ...checked.theme, id });
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const look of looks) {
		if (ids.has(look.id)) return { ok: false, error: `two looks share the id "${look.id}"; give each look its own id` };
		ids.add(look.id);
		const name = look.name.trim().toLowerCase();
		if (names.has(name)) return { ok: false, error: `two looks are both called "${look.name}"; give each look its own name` };
		names.add(name);
	}
	for (let i = 0; i < looks.length; i += 1)
		for (let j = i + 1; j < looks.length; j += 1) {
			const a = looks[i]!.colors;
			const b = looks[j]!.colors;
			if (a.bg.toLowerCase() === b.bg.toLowerCase() && a.primary.toLowerCase() === b.primary.toLowerCase())
				return { ok: false, error: `looks "${looks[i]!.id}" and "${looks[j]!.id}" use the same background and main colour; make each look clearly different` };
		}
	if (!ids.has(envelope.output.recommended))
		return { ok: false, error: `the recommended look "${envelope.output.recommended}" is not one of the proposed looks` };
	const { display, mocks } = splitDesignMocks(withoutLooks);
	const screen = mocks[0];
	if (!screen)
		return { ok: false, error: 'the looks proposal needs ONE ```html-mock block: the app\'s key screen, painted with the theme variables (--bg, --surface, --text, --primary, …)' };
	return { ok: true, set: { audience: envelope.output.audience, recommended: envelope.output.recommended, looks, screen, display } };
}

/** The refusal for saving an invalid looks proposal, or null when it is valid. */
export function looksSaveError(body: string): string | null {
	const parsed = parseLooks(body);
	return parsed.ok ? null : parsed.error;
}

/** The chosen look as the design brief's ```caddie-theme block (its id dropped). */
export function lookThemeBlock(look: Look): string {
	const { id: _id, ...theme } = look;
	return '```' + THEME_BLOCK_INFO + '\n' + JSON.stringify(theme, null, 2) + '\n```';
}

// The owner's choice is stored as a plan decision's note: "look:<id>" on the
// first line, then anything the owner typed.
const CHOICE = /^look:([a-z][a-z0-9-]{0,23})(?:\r?\n([\s\S]*))?$/;

export function encodeLookChoice(lookId: string, note: string): string {
	const extra = note.trim();
	return extra ? `look:${lookId}\n${extra}` : `look:${lookId}`;
}

export function decodeLookChoice(note: string | null | undefined): { lookId: string | null; note: string } {
	const match = CHOICE.exec((note ?? '').trim());
	if (!match) return { lookId: null, note: (note ?? '').trim() };
	return { lookId: match[1]!, note: (match[2] ?? '').trim() };
}

/** What the designer writes for the looks step (instructions and refusals). */
export const LOOKS_BLOCK_GUIDE =
	`Propose ${MIN_LOOKS} or 3 clearly different looks with ONE fenced ${LOOKS_BLOCK_INFO} JSON block: ` +
	'{ "audience": "who uses it and where, in plain words", "recommended": "<id of the look you recommend>", "looks": [ { "id": "field", ...the same fields as a caddie-theme block: name, why, colors, optional stateSurfaces, fonts, radius, density }, … ] }. ' +
	'Each look follows the caddie-theme rules (hex colours, named system font stacks, WCAG AA contrast). Make them really differ — different background and main colour, type and shape — and fit who uses the app and where; the "why" is one plain sentence a person who has never designed anything understands. ' +
	'Then add ONE ```html-mock block: the app\'s single most important screen with realistic content, styled ONLY with the theme variables (var(--bg), var(--surface), var(--text), var(--muted), var(--primary), var(--on-primary), var(--border), var(--ok), var(--warn), var(--danger), var(--radius), var(--font-heading), var(--font-body)) — never a literal colour — so the picker can paint it in each look.';
