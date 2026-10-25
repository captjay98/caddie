/**
 * The "choose a look" step (owner-approved 2026-10-23,
 * docs/reviews/2026-10-23-look-and-feel-picker): after the plan is approved
 * Caddie proposes 2-3 distinct looks for the app, the owner picks one (or asks
 * for others), and the design brief is then written in the chosen look.
 *
 * A looks proposal is a plan note of kind "looks": prose, ONE fenced
 * ```caddie-looks JSON block, with optional per-look screen compositions or
 * ONE shared ```html-mock key screen painted with theme variables (--bg, --surface, --text, --muted,
 * --primary, --on-primary, --border, --ok, --warn, --danger, --radius,
 * --font-heading, --font-body). Compare the same user task and capabilities
 * across looks, allowing different hierarchy or navigation where useful.
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
export type Look = AppTheme & { id: string; screen?: DesignMock };

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

const LookScreenSchema = v.strictObject({
	title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
	html: v.pipe(v.string(), v.trim(), v.minLength(1), v.check((html) => new TextEncoder().encode(html).byteLength <= 512 * 1024, 'a look screen must be at most 512 KiB')),
});

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
 * a static key screen for each look, using the shared html-mock as a fallback.
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
	const errors: string[] = [];
	if (!envelope.success) for (const issue of envelope.issues) {
		const path = issue.path?.map((p) => String(p.key)).join('.') ?? '';
		errors.push(`the ${LOOKS_BLOCK_INFO} block is invalid${path ? ` at ${path}` : ''}: ${issue.message}`);
	}
	const source = json && typeof json === 'object' ? json as Record<string, unknown> : {};
	const looks: Look[] = [];
	// Continue checking other looks even when an independent envelope field fails.
	for (const [index, item] of (Array.isArray(source.looks) ? source.looks : []).entries()) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
		const { id, screen: rawScreen, ...theme } = item as Record<string, unknown>;
		const checked = validateAppTheme(theme, `look "${String(id ?? index)}"`);
		const screen = rawScreen === undefined ? null : v.safeParse(LookScreenSchema, rawScreen);
		if (!checked.ok) errors.push(checked.error);
		if (screen && !screen.success) for (const issue of screen.issues) {
			const path = issue.path?.map((p) => String(p.key)).join('.') ?? '';
			errors.push(`look "${String(id ?? index)}" screen${path ? `.${path}` : ''}: ${issue.message}`);
		}
		if (checked.ok && typeof id === 'string' && (!screen || screen.success))
			looks.push({ ...checked.theme, id, ...(screen?.success ? { screen: screen.output } : {}) });
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const item of Array.isArray(source.looks) ? source.looks : []) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
		const { id, name: rawName } = item as Record<string, unknown>;
		if (typeof id === 'string') {
			if (ids.has(id)) errors.push(`two looks share the id "${id}"; give each look its own id`);
			ids.add(id);
		}
		if (typeof rawName === 'string') {
			const name = rawName.trim().toLowerCase();
			if (names.has(name)) errors.push(`two looks are both called "${rawName}"; give each look its own name`);
			names.add(name);
		}
	}
	for (let i = 0; i < looks.length; i += 1)
		for (let j = i + 1; j < looks.length; j += 1) {
			const a = looks[i]!.colors;
			const b = looks[j]!.colors;
			if (a.bg.toLowerCase() === b.bg.toLowerCase() && a.primary.toLowerCase() === b.primary.toLowerCase())
				errors.push(`looks "${looks[i]!.id}" and "${looks[j]!.id}" use the same background and main colour; make each look clearly different`);
		}
	if (typeof source.recommended === 'string' && !ids.has(source.recommended))
		errors.push(`the recommended look "${source.recommended}" is not one of the proposed looks`);
	const { display, mocks } = splitDesignMocks(withoutLooks);
	const sharedScreen = mocks[0];
	if (!sharedScreen && looks.some((look) => !look.screen))
		errors.push('the looks proposal needs ONE ```html-mock block for looks without their own screen');
	if (mocks.length > 1) errors.push('use ONE shared html-mock block; put different compositions in each look.screen');
	const screen = sharedScreen ?? looks[0]?.screen;
	if (!screen) errors.push('the looks proposal needs an html-mock key screen or a screen for every look');
	if (!envelope.success || errors.length || !screen) return { ok: false, error: errors.join('\n') };
	return { ok: true, set: { audience: envelope.output.audience, recommended: envelope.output.recommended, looks, screen, display } };
}

/** The refusal for saving an invalid looks proposal, or null when it is valid. */
export function looksSaveError(body: string): string | null {
	const parsed = parseLooks(body);
	return parsed.ok ? null : parsed.error;
}

/** The chosen look as the design brief's ```caddie-theme block (its id dropped). */
export function lookThemeBlock(look: Look): string {
	const { id: _id, screen: _screen, ...theme } = look;
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
// Complete schema-valid seed; designers change the content and compare the same
// user task. The example is parsed by tests so guidance cannot silently drift.
const CANONICAL_THEME: AppTheme = {
	name: 'Field-ready', why: 'Clear text and large controls are easy to use outside.',
	colors: { bg: '#F7F5EF', surface: '#FFFFFF', text: '#1B1F1A', muted: '#55604F', primary: '#1F7A3A', onPrimary: '#FFFFFF', border: '#D9D6CC', ok: '#1F7A3A', warn: '#8A4300', danger: '#B00020' },
	fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' }, radius: 10, density: 'comfortable',
};
export const LOOKS_BLOCK_GUIDE =
	`Propose ${MIN_LOOKS} or 3 clearly different looks using this complete valid structure. Replace the sample audience and content with the actual app. Keep audience and why at most 200 characters, name at most 60. Use camelCase onPrimary; density is compact, comfortable or roomy. Optional stateSurfaces is an array of {name, bg, fg, plain}, never an object. All colours must pass WCAG AA; fonts must end in a system generic family.\n` +
	'```' + LOOKS_BLOCK_INFO + '\n' + JSON.stringify({
		audience: 'Farmers using a phone outdoors', recommended: 'field', looks: [
			{ id: 'field', ...CANONICAL_THEME },
			{ id: 'overview', ...CANONICAL_THEME, name: 'Overview first', why: 'See the day at a glance before recording an observation.', colors: { ...CANONICAL_THEME.colors, bg: '#F4F7FB', primary: '#2B5FD9' } },
		],
	}, null, 2) + '\n```\n' +
	'```html-mock Today\n<main style="background:var(--bg);color:var(--text);font-family:var(--font-body);padding:16px;display:grid;gap:12px"><header style="display:flex;justify-content:space-between;align-items:center"><h1 style="font-family:var(--font-heading);font-size:20px;margin:0">Today on your farm</h1><span style="display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px"><i style="width:8px;height:8px;border-radius:50%;background:var(--ok)" />Synced</span></header><section style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px"><p style="margin:0;color:var(--muted);font-size:12px;text-transform:uppercase">Days of feed left</p><p style="margin:2px 0 0;font-family:var(--font-heading);font-size:28px;font-weight:700">14</p><p style="margin:0;color:var(--muted);font-size:12px">~52 kg per day</p></div><div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px"><p style="margin:0;color:var(--muted);font-size:12px;text-transform:uppercase">Mortality today</p><p style="margin:2px 0 0;font-family:var(--font-heading);font-size:28px;font-weight:700;color:var(--danger)">5</p><p style="margin:0;color:var(--muted);font-size:12px">Spike above baseline</p></div></section><span style="justify-self:start;border:1px solid var(--warn);color:var(--warn);border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600">Water gap in Pen 2</span><ul style="margin:0;padding:0;list-style:none;display:grid;gap:8px"><li style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;display:flex;justify-content:space-between"><span>Feed refilled, Pen 1</span><time style="color:var(--muted);font-size:12px">07:40</time></li><li style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;display:flex;justify-content:space-between"><span>Water gap logged, Pen 2</span><time style="color:var(--muted);font-size:12px">09:15</time></li></ul><button style="background:var(--primary);color:var(--on-primary);border:0;border-radius:var(--radius);padding:16px;font-size:16px;font-weight:600;font-family:var(--font-heading)">Record an observation</button></main>\n```\n' +
	'EVERY look must carry its own screen: {title, html} showing the SAME user task and capabilities as the shared html-mock above, presented differently. A look without a screen is an invalid set. The looks must differ STRUCTURALLY, not just in colours: vary the information hierarchy, the navigation pattern (tabs, card stack, list-first, map-first, stepper, voice-first…) and the density. If two looks differ only in palette, the set is rejected. Each screen must read like a real product key screen — real data values (never lorem or "Item 1"), roughly 10-15 elements with ONE clear primary action, at least one data or list region, and the theme applied to every surface and its text together. A toy mock (a heading plus a button) is rejected. Use only theme variables, never hardcoded colours or scripts. Each screen is at most 512 KiB. These are static appearance previews, not proof of saving, offline operation or integrations. Check the whole payload before saving and correct all reported errors together.';
