/**
 * The build's feature list (Phase 1 of the build-loop redesign).
 *
 * A plan's PRD carries ONE fenced block with the info string
 * `caddie-features` holding a JSON array of features. It lives inside the PRD
 * body on purpose: the user's approval is bound to the PRD revision hash, so
 * approving the plan approves exactly this list — the host never builds a
 * feature the user did not see. The UI renders the block as a checklist
 * (splitFeatureBlock) instead of showing raw JSON.
 *
 * The host builds the list ONE feature at a time: a feature passes only when
 * the host-run checks are green AND the builder added passing tests for it;
 * each passed feature leaves a sandbox checkpoint the user can roll back to.
 */

import * as v from 'valibot';

export const FEATURE_BLOCK_INFO = 'caddie-features';

export const MAX_PLAN_FEATURES = 12;

export const PlanFeatureSchema = v.strictObject({
	/** Stable slug, unique within the plan: `add-task`, `daily-feed-log`. */
	id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'id must be a short lowercase slug like "daily-feed-log"')),
	/** What the user gets, in their words. */
	title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
	/** Observable behaviors that prove it works; each becomes at least one test. */
	doneWhen: v.pipe(
		v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240))),
		v.minLength(1, 'each feature needs at least one "doneWhen" check'),
		v.maxLength(6),
	),
});

export type PlanFeature = v.InferOutput<typeof PlanFeatureSchema>;

export const PlanFeatureListSchema = v.pipe(
	v.array(PlanFeatureSchema),
	v.minLength(1, 'the list needs at least one feature'),
	v.maxLength(MAX_PLAN_FEATURES, `at most ${MAX_PLAN_FEATURES} features`),
	v.check((list) => new Set(list.map((f) => f.id)).size === list.length, 'feature ids must be unique'),
);

/** The exact format the planner must follow (shown in instructions and refusals). */
export const FEATURE_BLOCK_GUIDE =
	'End the PRD with ONE fenced code block whose info string is caddie-features, holding a JSON array of 1-12 features in build order, ' +
	'each {"id": "short-lowercase-slug", "title": "what the user gets", "doneWhen": ["an observable behavior a test can check", ...1-6]}. Example:\n' +
	'```caddie-features\n' +
	'[{"id":"log-feed","title":"Log daily feed","doneWhen":["Entering 12 kg and saving shows 12 kg in today\'s list","The entry is still there after a reload"]}]\n' +
	'```';

const FENCE = new RegExp('^(`{3,}|~{3,})[ \\t]*' + FEATURE_BLOCK_INFO + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\\1[ \\t]*$', 'm');

/** Split a PRD into the prose a person reads and the raw feature JSON. */
export function splitFeatureBlock(body: string): { display: string; raw: string | null } {
	const match = FENCE.exec(body);
	if (!match) return { display: body, raw: null };
	const display = (body.slice(0, match.index) + body.slice(match.index + match[0].length)).replace(/\n{3,}/g, '\n\n').trim();
	return { display, raw: match[2] ?? '' };
}

/** The info string the designer uses to mark a renderable mockup in a design brief. */
export const DESIGN_MOCK_INFO = 'html-mock';

/** Longest screen title shown on the review card's screen picker. */
export const MAX_DESIGN_MOCK_TITLE = 60;

/** One mocked screen: the title from the fence's info string, and its static HTML. */
export interface DesignMock {
	title: string;
	html: string;
}

// ```html-mock Today · empty   <- the optional title follows the info string
const DESIGN_MOCK_FENCES = new RegExp(
	'^(`{3,}|~{3,})[ \\t]*' +
		DESIGN_MOCK_INFO +
		'(?:[ \\t]+([^\\r\\n]*?))?[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\\1[ \\t]*$',
	'gm',
);

/**
 * Split a DESIGN brief into the prose a person reads and its mocked screens.
 * The designer embeds one titled ```html-mock block per screen or state (the
 * key screen, then its empty / error states); the review card shows each in a
 * locked-down sandbox. A brief with no mockup degrades to prose-only, an empty
 * block counts as absent, and an untitled block is named "Screen N".
 */
export function splitDesignMocks(body: string): { display: string; mocks: DesignMock[] } {
	const mocks: DesignMock[] = [];
	const display = body
		.replace(DESIGN_MOCK_FENCES, (_whole: string, _fence: string, title: string | undefined, html: string | undefined) => {
			const markup = (html ?? '').trim();
			if (markup) {
				const named = (title ?? '').trim().slice(0, MAX_DESIGN_MOCK_TITLE);
				mocks.push({ title: named || `Screen ${mocks.length + 1}`, html: markup });
			}
			return '';
		})
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return { display, mocks };
}

/** A chat reply split around its mockups (plan 4.5). */
export interface ChatMockSplit {
	/** Prose before the first mockup (all of it when there is none). */
	before: string;
	/** Prose after the first mockup, with every later mockup taken out. */
	after: string;
	/** Every mockup in the reply, in the order it appears. */
	mocks: DesignMock[];
	/** A mockup is still being written at the end of the reply. */
	drawing: boolean;
}

// Any closed fenced block: its info string and its body.
const ANY_FENCE = /^(`{3,}|~{3,})([^\r\n]*)\r?\n(?:([\s\S]*?)\r?\n)?\1[ \t]*$/gm;
// The info string of a fence that holds a screen: html-mock (the designer's)
// or html, with an optional screen title after it.
const MOCK_FENCE_INFO = /^[ \t]*(?:html-mock|html?)(?![\w-])[ \t]*(.*?)[ \t]*$/i;
// A screen written straight into the reply, which Markdown would print as raw
// HTML: a whole page, a <body> or a <main>, with an optional <style> before it.
const BARE_SCREEN =
	/^[ \t]*((?:<style\b[^>]*>[\s\S]*?<\/style>\s*)?(?:<!doctype\s+html\b[^>]*>[\s\S]*?<\/html>|<html\b[\s\S]*?<\/html>|<body\b[\s\S]*?<\/body>|<main\b[\s\S]*?<\/main>))/gim;
// The start of a mockup that has not been closed yet.
const OPEN_MOCK_FENCE = /^(`{3,}|~{3,})[ \t]*(?:html-mock|html?)(?![\w-])([^\r\n]*)(?:\r?\n([\s\S]*))?$/im;
const OPEN_BARE_SCREEN =
	/^[ \t]*(?:(?:<style\b[^>]*>[\s\S]*?<\/style>\s*)?<(?:!doctype\s+html|html|body|main)\b|<style\b(?![\s\S]*<\/style>))/im;

/**
 * Split a chat reply around the design mockups in it (plan 4.5), so each is
 * drawn in the styled preview frame and never printed as HTML: a titled
 * ```html-mock block, an ```html block (Caddie's readers are not developers:
 * HTML in a reply is a screen to look at, not code to copy), or a screen
 * written straight into the reply. Code in any other language, and a tag named
 * inside a sentence, stay as they are. A mockup still being written at the end
 * is cut from the prose and flagged `drawing`; once the reply is `complete`
 * (the default) it is drawn as it stands.
 */
export function splitChatMocks(text: string, options: { complete?: boolean } = {}): ChatMockSplit {
	const complete = options.complete ?? true;
	const mocks: DesignMock[] = [];
	const MARK = '\u0000mock\u0000';
	const add = (title: string | undefined, html: string | undefined): string => {
		const markup = (html ?? '').trim();
		if (!markup) return '';
		const named = (title ?? '').trim().slice(0, MAX_DESIGN_MOCK_TITLE);
		mocks.push({ title: named || `Screen ${mocks.length + 1}`, html: markup });
		return MARK;
	};
	// Set every closed fence and every bare screen aside (indexed), so a screen
	// inside code is never looked at and mockups are numbered in reading order.
	const fences: { info: string; body: string | undefined; block: string }[] = [];
	const bare: string[] = [];
	let masked = text.replace(ANY_FENCE, (block: string, _fence: string, info: string, body: string | undefined) => {
		fences.push({ info, body, block });
		return `\u0000F${fences.length - 1}\u0000`;
	});
	masked = masked.replace(BARE_SCREEN, (_whole: string, screen: string) => {
		bare.push(screen);
		return `\u0000B${bare.length - 1}\u0000`;
	});
	// A mockup still open at the end: whichever opens first.
	let tail: { title: string | undefined; html: string | undefined } | null = null;
	const fence = OPEN_MOCK_FENCE.exec(masked);
	const screen = OPEN_BARE_SCREEN.exec(masked);
	const cut = Math.min(fence?.index ?? Infinity, screen?.index ?? Infinity);
	if (cut !== Infinity) {
		tail = cut === fence?.index ? { title: fence[2], html: fence[3] } : { title: undefined, html: masked.slice(cut) };
		masked = masked.slice(0, cut);
	}
	const restore = (part: string) => part.replace(/\u0000F(\d+)\u0000/g, (_m: string, i: string) => fences[Number(i)]!.block);
	const restoreAll = (part: string) => restore(part).replace(/\u0000B(\d+)\u0000/g, (_m: string, i: string) => bare[Number(i)]!);
	let joined = masked.replace(/\u0000([FB])(\d+)\u0000/g, (whole: string, kind: string, i: string) => {
		if (kind === 'B') return add(undefined, bare[Number(i)]);
		const entry = fences[Number(i)]!;
		const info = MOCK_FENCE_INFO.exec(entry.info);
		return info ? add(info[1], entry.body) : whole;
	});
	let drawing = false;
	if (tail) {
		if (complete) joined += add(tail.title, restoreAll(tail.html ?? ''));
		else drawing = true;
	}
	const tidy = (part: string) => restore(part).replace(/\n{3,}/g, '\n\n').trim();
	const at = joined.indexOf(MARK);
	if (at === -1) return { before: tidy(joined), after: '', mocks, drawing };
	return { before: tidy(joined.slice(0, at)), after: tidy(joined.slice(at + MARK.length).split(MARK).join('')), mocks, drawing };
}

export type FeatureParse = { ok: true; features: PlanFeature[] } | { ok: false; error: string };

/** Parse and validate the PRD's feature block. Never throws. */
export function parsePlanFeatures(body: string): FeatureParse {
	const { raw } = splitFeatureBlock(body);
	if (raw === null) return { ok: false, error: `the PRD has no \`${FEATURE_BLOCK_INFO}\` block` };
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return { ok: false, error: `the ${FEATURE_BLOCK_INFO} block is not valid JSON (${error instanceof Error ? error.message : 'parse error'})` };
	}
	const parsed = v.safeParse(PlanFeatureListSchema, json);
	if (!parsed.success) {
		const issue = parsed.issues[0];
		const path = issue?.path?.map((p) => String(p.key)).join('.') ?? '';
		return { ok: false, error: `the ${FEATURE_BLOCK_INFO} block is invalid${path ? ` at ${path}` : ''}: ${issue?.message ?? 'unknown problem'}` };
	}
	return { ok: true, features: parsed.output };
}

/**
 * Plans approved before feature lists existed build as ONE feature, so an
 * in-flight project keeps working under the host-driven loop.
 */
export const WHOLE_PLAN_FEATURE: PlanFeature = {
	id: 'whole-plan',
	title: 'Everything in the approved plan',
	doneWhen: ['The app does what the approved plan describes'],
};

export const BUILD_FEATURE_STATUSES = ['pending', 'building', 'passed', 'failed'] as const;
export type BuildFeatureStatus = (typeof BUILD_FEATURE_STATUSES)[number];

/** One feature's live state, as the build progress view reads it. */
export interface BuildFeatureView {
	readonly id: string;
	readonly title: string;
	readonly doneWhen: readonly string[];
	/** 1-based build order. */
	readonly position: number;
	readonly status: BuildFeatureStatus;
	/** Failed check rounds spent on this feature. */
	readonly attempts: number;
	/** Passing tests in the project when this feature went green (null until then). */
	readonly testsPassed: number | null;
	readonly passedAt: string | null;
	/** True when this feature left a save point the user can roll back to right now. */
	readonly canRollBack: boolean;
}
