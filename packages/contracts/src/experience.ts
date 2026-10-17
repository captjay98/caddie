/**
 * Shared experience projection (R01, plan §5 "Deterministic state and
 * decisions").
 *
 * ONE server-derived projection consumed by chat cards, Brief, Projects and
 * the project workspace — never a per-UI guess from "the last message" or
 * "the last run". It is DERIVED from existing truth (build_workflows + the
 * latest prd revision + the durable approval record), not a second writable
 * copy of state. There is deliberately no table behind `ProjectExperience`.
 *
 * Authority never travels in this projection: it describes what the user may
 * SEE and which actions are OFFERED. Every action is re-authorized
 * server-side at effect time through the existing approvals gate
 * (checkApprovalForEffect) and the workflow's own conditional transitions —
 * a projection field can never grant an effect.
 */

import * as v from 'valibot';

// --- stage -------------------------------------------------------------------

/**
 * The user-facing stage. A SUPERSET refinement of the server's coarse
 * WorkflowPhase (planning|review|design|design-review|building|blocked|ready):
 * `blocked` splits into `stopped` (user asked to stop), `planning_blocked` (a
 * plan got stuck BEFORE approval — there is nothing built to retry, Caddie
 * must finish the plan) vs `blocked` (a build with an approved plan hit a
 * repair/limit/infra wall). `design` is Caddie writing the design brief after
 * the plan was approved; `design_review` is that brief waiting for the user.
 * `building` is the umbrella the UI narrates as building/checking/repairing
 * from the workflow detail. Kept small — the UI reads one field, not a table
 * per sub-state.
 */
export const ExperienceStage = v.union([
	v.literal('planning'),
	v.literal('review'),
	v.literal('design'),
	v.literal('design_review'),
	v.literal('building'),
	v.literal('checking'),
	v.literal('repairing'),
	v.literal('ready'),
	v.literal('blocked'),
	v.literal('planning_blocked'),
	v.literal('stopped'),
]);
export type ExperienceStage = v.InferOutput<typeof ExperienceStage>;

// --- actions -----------------------------------------------------------------

/** The kinds of main action a state can offer. One filled primary per state. */
export const ExperienceActionKind = v.union([
	v.literal('review_plan'),
	v.literal('approve_plan'),
	v.literal('review_design'),
	v.literal('suggest_change'),
	v.literal('stop'),
	v.literal('retry'),
	v.literal('open_preview'),
	v.literal('resolve_input'),
]);
export type ExperienceActionKind = v.InferOutput<typeof ExperienceActionKind>;

export const ExperienceActionSchema = v.pipe(
	v.strictObject({
		kind: ExperienceActionKind,
		label: v.string(),
		/** True = offered as an enabled control; false = shown disabled with a reason. */
		enabled: v.boolean(),
		/** Why it is disabled (user-facing), when enabled is false. */
		reason: v.optional(v.string()),
		/** True for exactly one action per state — the filled primary button. */
		primary: v.boolean(),
	}),
	v.readonly(),
);
export type ExperienceAction = v.InferOutput<typeof ExperienceActionSchema>;

// --- projection --------------------------------------------------------------

export const ProjectExperienceSchema = v.pipe(
	v.strictObject({
		projectId: v.string(),
		/**
		 * Monotonic optimistic-concurrency version. Derived from the workflow's
		 * updatedAt so a stale card can detect it is behind without a new
		 * column — any effect still re-checks durable state, this only drives
		 * refresh-on-conflict in the UI.
		 */
		version: v.pipe(v.number(), v.integer(), v.minValue(0)),
		stage: ExperienceStage,
		plan: v.nullable(
			v.strictObject({
				id: v.string(),
				revision: v.string(),
				approved: v.boolean(),
			}),
		),
		preview: v.nullable(
			v.strictObject({
				id: v.string(),
				revision: v.string(),
				/** True when this preview matches the current approved plan. */
				current: v.boolean(),
			}),
		),
		/** Bounded, user-facing, derived from actual state — never raw model prose. */
		message: v.string(),
		actions: v.array(ExperienceActionSchema),
	}),
	v.readonly(),
);
export type ProjectExperience = v.InferOutput<typeof ProjectExperienceSchema>;

// --- command boundary --------------------------------------------------------

/**
 * The approve-plan command (plan §5). Scope (actor/workspace) is derived
 * server-side from the authenticated session, NEVER from this body — the
 * strict object rejects any smuggled actor field. `expectedVersion` makes a
 * stale click a refreshable conflict; `idempotencyKey` makes a duplicate a
 * no-op. Buttons and an unambiguous conversational "approve this plan" invoke
 * the SAME command for the presented revision.
 */
export const ApprovePlanCommandSchema = v.pipe(
	v.strictObject({
		projectId: v.string(),
		planRevisionId: v.string(),
		expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(0)),
		idempotencyKey: v.pipe(v.string(), v.minLength(8), v.maxLength(160)),
	}),
	v.readonly(),
);
export type ApprovePlanCommand = v.InferOutput<typeof ApprovePlanCommandSchema>;

/** The uniform result shape every experience command returns. */
export const ExperienceCommandOutcome = v.union([
	v.literal('applied'),
	v.literal('noop'),
	v.literal('stale'),
	v.literal('denied'),
	v.literal('failed'),
]);
export type ExperienceCommandOutcome = v.InferOutput<typeof ExperienceCommandOutcome>;

export const ExperienceCommandResultSchema = v.pipe(
	v.strictObject({
		outcome: ExperienceCommandOutcome,
		/** The refreshed projection after the command (always current truth). */
		experience: ProjectExperienceSchema,
		/** A typed code when outcome is stale/denied/failed (e.g. STALE_PLAN). */
		code: v.optional(v.string()),
	}),
	v.readonly(),
);
export type ExperienceCommandResult = v.InferOutput<typeof ExperienceCommandResultSchema>;
