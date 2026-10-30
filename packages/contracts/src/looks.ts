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
import { AcceptanceJourneysSchema, journeyLintIssues, parseAcceptanceJourneys } from './acceptance-journeys.ts';

export const LOOKS_BLOCK_INFO = 'caddie-looks';
export const MIN_LOOKS = 2;
export const MAX_LOOKS = 3;
/** The merged look step proposes exactly this many looks (owner 2026-10-29: "create the 3 looks"). */
export const LOOK_COUNT = 3;

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
	/** Every screen the app needs, mapped to plan features (absent on older proposals). */
	inventory?: ScreenInventoryEntry[];
}

export type LooksParse = { ok: true; set: LooksSet } | { ok: false; error: string };

const Slug = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,23}$/, 'a look id is a short lowercase slug like "field" or "calm-blue"'));

/** Keys authors reach for when they mean a look's own composition. The strict
 * theme schema rejects them with an opaque "Invalid key", which sent the live
 * designer whipsawing between `screens` and extra ```html-mock blocks until the
 * looks step blocked (Street Food Share, 2026-10-28). */
const NEAR_MISS_SCREEN = /^(screens|screenhtml|screen_html|mock|mockup|preview|html)$/i;

const LookScreenSchema = v.strictObject({
	title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
	html: v.pipe(v.string(), v.trim(), v.minLength(1), v.check((html) => new TextEncoder().encode(html).byteLength <= 512 * 1024, 'a look screen must be at most 512 KiB')),
});

/** One row of the screen inventory: a screen of the app and the plan features it serves. */
const InventoryEntrySchema = v.strictObject({
	screen: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
	what: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
	features: v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(48))), v.minLength(1), v.maxLength(12)),
});
export type ScreenInventoryEntry = v.InferOutput<typeof InventoryEntrySchema>;

const LooksEnvelopeSchema = v.strictObject({
	audience: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
	recommended: Slug,
	looks: v.pipe(
		v.array(v.looseObject({ id: Slug })),
		v.minLength(MIN_LOOKS, `propose ${MIN_LOOKS} or 3 looks`),
		v.maxLength(MAX_LOOKS, `propose ${MIN_LOOKS} or 3 looks`),
	),
	/** Every screen the app needs and the plan features each one serves (merged look step, 2026-10-29). */
	inventory: v.optional(v.pipe(v.array(InventoryEntrySchema), v.minLength(1), v.maxLength(16))),
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
	const { display: withLooks } = splitChecksBlock(body);
	const { display: withoutLooks, raw } = splitLooksBlock(withLooks);
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
		const misplaced = Object.keys(theme).filter((key) => NEAR_MISS_SCREEN.test(key));
		if (misplaced.length)
			errors.push(
				`look "${String(id ?? index)}" has ${misplaced.map((key) => `"${key}"`).join(', ')}: each look carries one "screen" object — the singular key \`screen\` with exactly {"title", "html"}.`,
			);
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
	return {
		ok: true,
		set: {
			audience: envelope.output.audience,
			recommended: envelope.output.recommended,
			looks,
			screen,
			display,
			...(envelope.output.inventory ? { inventory: envelope.output.inventory } : {}),
		},
	};
}

// ```caddie-checks … ``` — the browser-check manifest the build is held to.
const CHECKS_FENCE = /^(`{3,}|~{3,})[ \t]*caddie-checks[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/m;

/** Split the proposal's caddie-checks manifest out of its prose. */
export function splitChecksBlock(body: string): { display: string; raw: string | null } {
	const match = CHECKS_FENCE.exec(body);
	if (!match) return { display: body, raw: null };
	const display = (body.slice(0, match.index) + body.slice(match.index + match[0].length)).replace(/\n{3,}/g, '\n\n').trim();
	return { display, raw: match[2] ?? '' };
}

/** A fence longer than any backtick run inside the content, so markup can't close it early. */
function fenceFor(content: string): string {
	const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((run) => run[0].length));
	return '`'.repeat(longest + 1);
}

/**
 * The approved design for one chosen look (merged look step, owner
 * 2026-10-29): the owner picks a look that is already drawn as the app's real
 * first screen, so there is no second "design the screens" pass. The design
 * the build is held to is composed here, by the host, from the saved proposal:
 * the look's theme, its screen as the key html-mock, the screen inventory and
 * the browser-check manifest. Deterministic, so the approval binds to exactly
 * what the owner chose.
 */
export function designFromLook(proposal: string, set: LooksSet, look: Look, note = ''): string {
	const screen = look.screen ?? set.screen;
	const checks = splitChecksBlock(proposal).raw;
	const inventory = (set.inventory ?? []).map((row) => `- **${row.screen}** — ${row.what} (features: ${row.features.join(', ')})`);
	const words = note.trim();
	const parts = [
		`# ${look.name}`,
		'',
		`Chosen look for ${set.audience}. ${look.why}`,
		...(set.display ? ['', set.display] : []),
		...(inventory.length ? ['', '## Screens', '', ...inventory] : []),
		...(words ? ['', "## The owner's note about the look", '', words] : []),
		'',
		lookThemeBlock(look),
		'',
		`${fenceFor(screen.html)}html-mock ${screen.title.slice(0, 60)}`,
		screen.html,
		fenceFor(screen.html),
	];
	if (checks !== null) parts.push('', '```caddie-checks', normalizedChecks(checks, screen.title.slice(0, 60).trim()), '```');
	return parts.join('\n');
}

/**
 * The composed design has exactly one screen, so its browser checks keep
 * exactly one "states" entry for it: the first entry with that title. A
 * designer who also listed loading/empty/error entries under the same title
 * (Farm Ops, 2026-10-29) no longer loses the whole step to a duplicate.
 * Anything that is not JSON is left as written; the save check reports it.
 */
function normalizedChecks(raw: string, title: string): string {
	try {
		const manifest = JSON.parse(raw) as { states?: { title?: string }[] };
		if (!Array.isArray(manifest.states)) return raw.trim();
		const first = manifest.states.find((state) => typeof state?.title === 'string' && state.title.trim() === title);
		return JSON.stringify({ ...manifest, states: first ? [first] : manifest.states });
	} catch {
		return raw.trim();
	}
}

/** Tags that are never self-closed in HTML; a "<div/>" is an OPENING tag to the browser. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Machine checks on one static screen (owner 2026-10-29: "turn the incident
 * rules into code checks"). Each rule here used to be a paragraph in the
 * designer's prompt after a live failure; now the save is refused with the
 * exact fix instead.
 */
export function mockHtmlIssues(html: string, subject: string): string[] {
	const issues: string[] = [];
	const selfClosed = [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*?\/>/g)]
		.map((match) => match[1]!.toLowerCase())
		.filter((tag) => !VOID_TAGS.has(tag) && !['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop'].includes(tag));
	if (selfClosed.length)
		issues.push(`${subject} self-closes ${[...new Set(selfClosed)].map((tag) => `<${tag}/>`).join(', ')}: browsers read that as an opening tag that swallows the rest of the screen. Write <${selfClosed[0]}></${selfClosed[0]}>.`);
	if (/<script\b/i.test(html) || /\son[a-z]+\s*=/i.test(html)) issues.push(`${subject} has a script or an on…= handler; screens are static, remove it.`);
	// A colour is a 3/4/6/8-digit hex; an HTML entity such as &#8594; (→) is
	// text, not a colour (EggOps Nigeria, 2026-10-30: every look was refused
	// for "hard-coding #8594", its arrow).
	const hex = [...new Set([...html.matchAll(/(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)].map((match) => match[0]))];
	if (hex.length) issues.push(`${subject} hard-codes ${hex.slice(0, 4).join(', ')}; use the theme variables (var(--primary), var(--text), …) so the look applies.`);
	const elements = (html.match(/<[a-zA-Z]/g) ?? []).length;
	if (elements < 12) issues.push(`${subject} has only ${elements} elements; draw the real first screen (about 12-40 elements with real data), not a sketch.`);
	if (!/<button\b/i.test(html)) issues.push(`${subject} has no <button>; give the screen its one clear primary action.`);
	if (/lorem ipsum|\bitem \d\b|placeholder text/i.test(html)) issues.push(`${subject} uses filler text; use real-looking data from the plan.`);
	return issues;
}

/** The exact JSON of every browser-check step (shown in the guide and in refusals). */
export const CHECK_STEP_SHAPES: Record<string, string> = {
	open: '{"kind":"open","path":"/"}',
	fill: '{"kind":"fill","label":"Feed (kg)","value":"12"}',
	click: '{"kind":"click","name":"Save"}',
	expect: '{"kind":"expect","text":"12 kg","visible":true}',
	actor: '{"kind":"actor","user":"a"} (user is "a" or "b": two different signed-in people, e.g. a = the owner, b = a worker)',
	offline: '{"kind":"offline","value":true}',
	reload: '{"kind":"reload"}',
	restart: '{"kind":"restart"}',
	fault: '{"kind":"fault","path":"/api/logs","mode":"fail"}',
};

/** Schema problems in a caddie-checks manifest, each naming where it is and what to write. */
export function checksSchemaIssues(manifest: unknown): string[] {
	const parsed = v.safeParse(AcceptanceJourneysSchema, manifest);
	if (parsed.success) return [];
	const source = manifest as { criteria?: { featureId?: string; steps?: { kind?: string }[] }[]; states?: { steps?: { kind?: string }[] }[] };
	// The same wrong step usually repeats (one per criterion): say it once, with where.
	const grouped = new Map<string, string[]>();
	for (const issue of parsed.issues) {
		const path = issue.path?.map((p) => p.key) ?? [];
		const [list, index, field, stepIndex] = path as [string?, number?, string?, number?];
		if ((list !== 'criteria' && list !== 'states') || typeof index !== 'number' || field !== 'steps' || typeof stepIndex !== 'number') continue;
		const row = list === 'criteria' ? source.criteria?.[index] : source.states?.[index];
		const kind = row?.steps?.[stepIndex]?.kind;
		const fix = kind && CHECK_STEP_SHAPES[kind] ? `every "${kind}" step must be exactly ${CHECK_STEP_SHAPES[kind]}` : `a step has an unknown kind; use only: ${Object.values(CHECK_STEP_SHAPES).join(' ')}`;
		const at = `${list}[${index}] step ${stepIndex + 1}`;
		const places = grouped.get(fix) ?? [];
		if (!places.includes(at)) places.push(at);
		grouped.set(fix, places);
	}
	if (grouped.size) return [...grouped].map(([fix, places]) => `caddie-checks: ${fix} (fix ${places.length} place${places.length > 1 ? 's' : ''}: ${places.slice(0, 5).join(', ')}${places.length > 5 ? ', …' : ''}).`);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const issue of parsed.issues) {
		const path = issue.path?.map((p) => p.key) ?? [];
		const [list, index, field, stepIndex] = path as [string?, number?, string?, number?];
		let where = path.map(String).join('.') || 'the manifest';
		let fix = issue.message;
		if ((list === 'criteria' || list === 'states') && typeof index === 'number' && field === 'steps' && typeof stepIndex === 'number') {
			const row = list === 'criteria' ? source.criteria?.[index] : source.states?.[index];
			const kind = row?.steps?.[stepIndex]?.kind;
			where = `${list}[${index}]${list === 'criteria' && source.criteria?.[index]?.featureId ? ` (${source.criteria[index]!.featureId})` : ''} step ${stepIndex + 1}${kind ? ` "${kind}"` : ''}`;
			fix = kind && CHECK_STEP_SHAPES[kind] ? `write it exactly as ${CHECK_STEP_SHAPES[kind]}` : `use one of the step shapes: ${Object.values(CHECK_STEP_SHAPES).join(' ')}`;
		}
		const key = `${where}|${fix}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(`caddie-checks ${where}: ${fix}`);
	}
	if (out.length > 6) return [...out.slice(0, 6), `…and ${out.length - 6} more like these in the caddie-checks block.`];
	return out;
}

/** What the merged look step must carry, checked by the host before anything is saved. */
export interface LookProposalContext {
	/** The approved plan's features (id + doneWhen), when it has a feature list. */
	features: readonly { id: string; doneWhen: readonly string[] }[];
}

/**
 * Every structural machine check on a merged-step looks proposal, all at once
 * so one correction fixes everything: exactly three looks, each drawn as the
 * same real first screen; static-HTML rules; a screen inventory that covers
 * every plan feature; and a browser-check manifest that maps every approved
 * doneWhen to a journey. Returns [] when the proposal is ready to save.
 */
export function lookProposalIssues(body: string, context: LookProposalContext): string[] {
	const parsed = parseLooks(body);
	if (!parsed.ok) return parsed.error.split('\n');
	const { set } = parsed;
	const issues: string[] = [];
	if (set.looks.length !== LOOK_COUNT) issues.push(`propose exactly ${LOOK_COUNT} looks (this has ${set.looks.length}).`);
	const missingScreen = set.looks.filter((look) => !look.screen).map((look) => look.id);
	if (missingScreen.length)
		issues.push(`look${missingScreen.length > 1 ? 's' : ''} ${missingScreen.map((id) => `"${id}"`).join(', ')} need${missingScreen.length > 1 ? '' : 's'} its own "screen": every look is drawn as the app's real first screen.`);
	const titles = new Set(set.looks.map((look) => (look.screen ?? set.screen).title.trim()));
	if (titles.size > 1) issues.push(`every look draws the SAME first screen, so give each look.screen the same title (now: ${[...titles].map((t) => `"${t}"`).join(', ')}).`);
	for (const look of set.looks) {
		const screen = look.screen ?? set.screen;
		if (screen.title.trim().length > 60) issues.push(`look "${look.id}" screen title is over 60 characters.`);
		issues.push(...mockHtmlIssues(screen.html, `look "${look.id}" screen`));
	}
	const known = new Set(context.features.map((feature) => feature.id));
	if (known.size) {
		if (!set.inventory) issues.push('add "inventory" to the caddie-looks JSON: [{"screen","what","features":[feature ids]}] listing every screen the app needs.');
		else {
			const covered = new Set(set.inventory.flatMap((row) => row.features));
			const unknown = [...covered].filter((id) => !known.has(id));
			const uncovered = [...known].filter((id) => !covered.has(id));
			if (unknown.length) issues.push(`the inventory names features the plan does not have: ${unknown.join(', ')}. Use the plan's feature ids.`);
			if (uncovered.length) issues.push(`every plan feature needs a screen, including the ones marked "later" (the owner adds them after the first version from this same design); the inventory leaves out ${uncovered.join(', ')}.`);
		}
		const raw = splitChecksBlock(body).raw;
		if (raw === null) issues.push('add ONE ```caddie-checks block mapping every approved doneWhen to a browser journey, plus one "states" entry for the first screen\'s title.');
		else {
			type Manifest = { criteria?: { featureId?: unknown; text?: unknown }[] };
			const manifest = ((): Manifest | null => {
				try { return JSON.parse(raw) as Manifest; } catch { issues.push('the caddie-checks block is not valid JSON.'); return null; }
			})();
			const rows = Array.isArray(manifest?.criteria) ? manifest.criteria : [];
			const provided = new Set(rows.map((row) => JSON.stringify([row.featureId, row.text])));
			const missing = context.features.flatMap((feature) => feature.doneWhen.map((text) => ({ id: feature.id, text }))).filter((row) => !provided.has(JSON.stringify([row.id, row.text])));
			if (manifest && missing.length)
				issues.push(`the caddie-checks block must copy each approved doneWhen exactly, including those of features marked "later"; missing ${missing.length}: ${missing.slice(0, 4).map((row) => `${row.id} "${row.text}"`).join('; ')}${missing.length > 4 ? '; …' : ''}.`);
			const look = set.looks[0];
			// Name the exact step and the exact shape, never "the manifest is
			// invalid": the Farm Ops designer wrote {"kind":"actor","value":"b"}
			// three times against that opaque line and the step blocked
			// (2026-10-29). Each refusal now says where and what to write.
			const schema = manifest ? checksSchemaIssues(manifest) : [];
			issues.push(...schema);
			if (manifest && !missing.length && !schema.length && look) {
				try {
					parseAcceptanceJourneys(designFromLook(body, set, look), context.features.flatMap((feature) => feature.doneWhen.map((text) => ({ featureId: feature.id, text }))));
				} catch (error) {
					issues.push(`the caddie-checks block is invalid: ${error instanceof Error ? error.message : 'unknown error'}. "states" must list exactly the first screen's title ("${(look.screen ?? set.screen).title}"), once.`);
				}
			}
		}
	}
	return issues;
}

/**
 * Browser checks in the proposal that can never pass (see journeyLintIssues).
 * Applied when the looks are SAVED only, never when an already-saved proposal
 * is approved, so a design saved before this rule keeps its flow.
 */
export function checksLintIssues(body: string): string[] {
	const raw = splitChecksBlock(body).raw;
	if (raw === null) return [];
	let manifest: unknown;
	try {
		manifest = JSON.parse(raw);
	} catch {
		return [];
	}
	const parsed = v.safeParse(AcceptanceJourneysSchema, manifest);
	return parsed.success ? journeyLintIssues(parsed.output) : [];
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
// Complete schema-valid seed; designers change the content. The example is
// parsed by tests (lookProposalIssues) so the guidance cannot silently drift.
const CANONICAL_THEME: AppTheme = {
	name: 'Field-ready', why: 'Dark text and big controls stay readable outside in bright sun.',
	colors: { bg: '#F7F5EF', surface: '#FFFFFF', text: '#1B1F1A', muted: '#55604F', primary: '#1F7A3A', onPrimary: '#FFFFFF', border: '#D9D6CC', ok: '#1F7A3A', warn: '#8A4300', danger: '#B00020' },
	fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' }, radius: 12, density: 'comfortable',
};
const MAIN = 'background:var(--bg);color:var(--text);font-family:var(--font-body);min-height:100%;margin:0;padding:16px;display:grid;gap:12px;align-content:start';
const CARD = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px';
const LABEL = 'margin:0;color:var(--muted);font-size:13px';
const BIG = 'margin:4px 0 0;font-family:var(--font-heading);font-size:28px;font-weight:700;font-variant-numeric:tabular-nums';
const PRIMARY = 'min-height:48px;background:var(--primary);color:var(--on-primary);border:0;border-radius:var(--radius);font-size:16px;font-weight:600;font-family:var(--font-heading)';
const ROW = `${CARD};display:flex;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px`;
/** Three structurally different first screens for the same app and task. */
export const CANONICAL_LOOK_SCREENS: Record<'field' | 'list' | 'number', string> = {
	field: `<main style='${MAIN}'><header style='display:flex;justify-content:space-between;align-items:center'><h1 style='font-family:var(--font-heading);font-size:22px;margin:0'>Today</h1><span style='${LABEL}'>Pen A · 480 birds</span></header><section style='display:grid;grid-template-columns:1fr 1fr;gap:10px'><div style='${CARD}'><p style='${LABEL}'>Feed left</p><p style='${BIG}'>6 days</p></div><div style='${CARD}'><p style='${LABEL}'>Lost today</p><p style='${BIG};color:var(--danger)'>2</p></div></section><p style='margin:0;padding:10px 12px;border:1px solid var(--warn);border-radius:var(--radius);color:var(--warn);font-weight:600'>Feed runs out Tuesday</p><ul style='list-style:none;margin:0;padding:0;display:grid;gap:8px'><li style='${ROW}'><span>Morning check</span><time style='${LABEL}'>07:40</time></li><li style='${ROW}'><span>Water topped up</span><time style='${LABEL}'>09:15</time></li></ul><button style='${PRIMARY}'>Log today</button></main>`,
	list: `<main style='${MAIN}'><h1 style='font-family:var(--font-heading);font-size:22px;margin:0'>Today</h1><nav style='display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px'><button style='min-height:44px;border:0;border-radius:var(--radius);background:var(--primary);color:var(--on-primary);font-weight:600'>Pen A</button><button style='min-height:44px;border:0;background:transparent;color:var(--text)'>Pen B</button><button style='min-height:44px;border:0;background:transparent;color:var(--text)'>Pen C</button></nav><ul style='list-style:none;margin:0;padding:0;display:grid;gap:8px'><li style='${ROW}'><span>Feed left</span><b style='font-variant-numeric:tabular-nums'>6 days</b></li><li style='${ROW}'><span>Lost today</span><b style='color:var(--danger)'>2</b></li><li style='${ROW}'><span>Eggs collected</span><b>412</b></li></ul><p style='margin:0;color:var(--warn);font-weight:600'>Feed runs out Tuesday</p><button style='${PRIMARY}'>Log today</button></main>`,
	number: `<main style='${MAIN}'><header style='display:flex;justify-content:space-between;align-items:baseline'><h1 style='font-family:var(--font-heading);font-size:22px;margin:0'>Today</h1><span style='${LABEL}'>Thu 29 Oct</span></header><section style='${CARD};padding:20px;text-align:center'><p style='${LABEL}'>Feed left</p><p style='margin:4px 0;font-family:var(--font-heading);font-size:56px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums'>6</p><p style='margin:0;font-weight:600'>days · runs out Tuesday</p></section><div style='display:grid;grid-template-columns:1fr 1fr;gap:10px'><p style='${CARD};margin:0'>Lost today <b style='color:var(--danger)'>2</b></p><p style='${CARD};margin:0'>Eggs <b>412</b></p></div><button style='${PRIMARY}'>Log today</button></main>`,
};
/** The example plan features the canonical proposal maps (tests use the same list). */
export const CANONICAL_LOOK_FEATURES = [
	{ id: 'log-day', doneWhen: ['Saving 2 birds lost shows "2 lost today" on Today after a restart'] },
	{ id: 'feed-alert', doneWhen: ['With 2 days of feed left, Today shows "Feed runs out"'] },
] as const;
const CANONICAL_CHECKS = {
	version: 1,
	criteria: [
		{ featureId: 'log-day', text: CANONICAL_LOOK_FEATURES[0].doneWhen[0], steps: [{ kind: 'open', path: '/' }, { kind: 'click', name: 'Log today' }, { kind: 'fill', label: 'Birds lost', value: '2' }, { kind: 'click', name: 'Save' }, { kind: 'restart' }, { kind: 'expect', text: '2 lost today' }] },
		{ featureId: 'feed-alert', text: CANONICAL_LOOK_FEATURES[1].doneWhen[0], steps: [{ kind: 'open', path: '/' }, { kind: 'click', name: 'Log today' }, { kind: 'fill', label: 'Feed left (days)', value: '2' }, { kind: 'click', name: 'Save' }, { kind: 'expect', text: 'Feed runs out' }] },
	],
	states: [{ title: 'Today', steps: [{ kind: 'open', path: '/' }, { kind: 'expect', text: 'Today' }] }],
};
/** A complete proposal that passes every machine check (parsed by tests). */
export const CANONICAL_LOOKS_PROPOSAL =
	'```' + LOOKS_BLOCK_INFO + '\n' + JSON.stringify({
		audience: 'Poultry farmers on a phone in the pen', recommended: 'field',
		inventory: [
			{ screen: 'Today', what: 'The day at a glance and the one action: log today', features: ['log-day', 'feed-alert'] },
			{ screen: 'Log today', what: 'A short form: birds lost, feed left, eggs', features: ['log-day'] },
		],
		looks: [
			{ id: 'field', ...CANONICAL_THEME, screen: { title: 'Today', html: CANONICAL_LOOK_SCREENS.field } },
			{ id: 'list', ...CANONICAL_THEME, name: 'Pen by pen', why: 'One pen at a time, each number on its own row.', colors: { ...CANONICAL_THEME.colors, bg: '#F4F7FB', primary: '#2B5FD9', ok: '#1D6B35' }, screen: { title: 'Today', html: CANONICAL_LOOK_SCREENS.list } },
			{ id: 'number', ...CANONICAL_THEME, name: 'One big number', why: 'The number that matters most, readable from arm\u2019s length.', colors: { ...CANONICAL_THEME.colors, bg: '#FFF8EE', primary: '#9A3412', ok: '#1D6B35' }, radius: 16, screen: { title: 'Today', html: CANONICAL_LOOK_SCREENS.number } },
		],
	}) + '\n```\n```caddie-checks\n' + JSON.stringify(CANONICAL_CHECKS) + '\n```';
export const LOOKS_BLOCK_GUIDE =
	`\nThe looks ARE the design. Propose exactly ${LOOK_COUNT} looks; each is a full theme plus the app's real first screen drawn in it, as look.screen {"title","html"}. The owner picks one and the build starts from it — there is no later screens step, so draw the screen as it will ship. ` +
	// Staged builds (owner 2026-10-30): the owner adds "later" items one at a
	// time from this same design, so it covers the whole approved list.
	'The inventory and the caddie-checks cover EVERY feature in the plan\'s list, including the ones marked "later": the first version is built first and the rest are added one at a time from this same design. ' +
	'Make the three structurally different (cards first, list first, one big number…), never recolours. Craft: one clear headline or number, real data from the plan, an 8px spacing rhythm, at most two font weights, 44px+ tap targets, one primary button, fits 390px wide and uses a wide screen too (from about 900px cards sit in 2-3 columns; never a phone-width strip with empty sides). ' +
	'Same screen title in all three. In the screen html write attributes with single quotes (style=\'…\'), so the JSON string needs no escaped quotes. Theme rules: camelCase onPrimary; density compact|comfortable|roomy; fonts end in a generic family; colours only through var(--bg) var(--surface) var(--text) var(--muted) var(--primary) var(--on-primary) var(--border) var(--ok) var(--warn) var(--danger) var(--radius) var(--font-heading) var(--font-body). ' +
	'Add "inventory" (every screen the app needs, each with the plan feature ids it serves; every feature covered) and ONE caddie-checks block: copy every approved doneWhen exactly, give each 2-6 short browser steps ending in an expect, and one states entry with the first screen\'s title. Steps, exactly these shapes: ' + Object.values(CHECK_STEP_SHAPES).join(' ') + '. Keep the JSON compact (no indentation). ' +
	'The host measures contrast, tap sizes and sideways scrolling on the rendered screens and refuses a save with the exact fixes; correct them all together. Example (replace every value with this app\'s):\n' +
	CANONICAL_LOOKS_PROPOSAL;
