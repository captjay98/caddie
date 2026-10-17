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
