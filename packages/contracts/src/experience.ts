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
	// Team mode (part F): "Try this feature again from the last save point",
	// offered on a stopped team-mode build after three failed tries.
	v.literal('try_again'),
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
		/** The filled main button: true for at most one action, and for none
		 *  while Caddie builds (nothing needs the person then). */
		primary: v.boolean(),
	}),
	v.readonly(),
);
export type ExperienceAction = v.InferOutput<typeof ExperienceActionSchema>;

// --- "How your app works" (team mode, plan part B / section 7) ---------------
//
// A plain-words projection of the approved `caddie-architecture` block, for the
// Design review screen a non-technical person reads. Every field is derived
// from the real block and the real architect review; a section the block
// leaves empty is simply absent (never a bare heading). Serializable only.

/** One section of the summary: a heading and its plain lines (never empty). */
export const DesignSectionSchema = v.pipe(
	v.strictObject({
		key: v.union([
			v.literal('saves'),
			v.literal('access'),
			v.literal('sign-in'),
			v.literal('services'),
			v.literal('ai'),
			v.literal('test-mode'),
		]),
		heading: v.string(),
		lines: v.pipe(v.array(v.string()), v.minLength(1)),
	}),
	v.readonly(),
);
export type DesignSection = v.InferOutput<typeof DesignSectionSchema>;

/** One screen the app has, in plain words (what it is for). */
export const DesignScreenSchema = v.pipe(
	v.strictObject({
		plain: v.string(),
		/** The module this screen belongs to, for grouping a big app. */
		module: v.string(),
	}),
	v.readonly(),
);
export type DesignScreen = v.InferOutput<typeof DesignScreenSchema>;

/** One module (part/"module") of a big app, in plain words. */
export const DesignModuleSchema = v.pipe(
	v.strictObject({
		id: v.string(),
		plain: v.string(),
	}),
	v.readonly(),
);
export type DesignModule = v.InferOutput<typeof DesignModuleSchema>;

/**
 * The architect's review findings (part B). Security issues BLOCK approval;
 * advisory issues are shown and never block. The screen shows the two apart so
 * the person sees that a security issue must be fixed before building starts.
 */
export const DesignReviewFindingsSchema = v.pipe(
	v.strictObject({
		/** True when open security issues block the design from approval. */
		blocks: v.boolean(),
		/** Plain sentences of the issues that block (empty when none). */
		security: v.array(v.string()),
		/** Plain sentences of the advisory issues (empty when none). */
		advisory: v.array(v.string()),
	}),
	v.readonly(),
);
export type DesignReviewFindings = v.InferOutput<typeof DesignReviewFindingsSchema>;

export const DesignOverviewSchema = v.pipe(
	v.strictObject({
		/** A one-module app is 'small'; several modules is 'big'. */
		app: v.union([v.literal('small'), v.literal('big')]),
		/** What the app stores / who can see what / sign-in / services / AI /
		 *  test-mode — only the sections the block populates. */
		sections: v.array(DesignSectionSchema),
		/** The app's screens, in plain words. */
		screens: v.array(DesignScreenSchema),
		/** The app's parts (modules) — present only for a big app (2+ modules). */
		modules: v.optional(v.array(DesignModuleSchema)),
		/** The architect review's findings. Absent before the architect has run. */
		review: v.optional(DesignReviewFindingsSchema),
		/** Whether the person approved this exact design revision, so the screen
		 *  can word it "before you approve" or "what you approved". */
		approved: v.boolean(),
	}),
	v.readonly(),
);
export type DesignOverview = v.InferOutput<typeof DesignOverviewSchema>;

// --- big-app module board (team mode, plan part P / section 7) ---------------

/**
 * One module on the build-progress board, with its state in the plain word the
 * person reads: waiting (a dependency or a slot is not ready), building (a
 * builder is on it), built (its own checks passed; it is joined into the app
 * next), joined (merged into the app), not joined (a round of joining failed),
 * or stopped (it stopped and the rest kept going).
 */
export const ModuleProgressState = v.union([
	v.literal('waiting'),
	v.literal('building'),
	v.literal('built'),
	v.literal('joined'),
	v.literal('not-joined'),
	v.literal('stopped'),
]);
export type ModuleProgressState = v.InferOutput<typeof ModuleProgressState>;

export const ModuleProgressItemSchema = v.pipe(
	v.strictObject({
		id: v.string(),
		/** The module's plain name, e.g. "Feed stock and use". */
		plain: v.string(),
		state: ModuleProgressState,
		/** The modules this one waits for, for the "waiting for Farms" line. */
		waitingFor: v.optional(v.array(v.string())),
		/**
		 * The person who started the build may press Try again on this part
		 * (it stopped or could not be joined). Absent otherwise.
		 */
		canRetry: v.optional(v.boolean()),
	}),
	v.readonly(),
);
export type ModuleProgressItem = v.InferOutput<typeof ModuleProgressItemSchema>;

// --- spending-limit stop (team mode, plan part A / section 7) ----------------

/**
 * The spending-limit stop. Present only when a build stopped at its limit. The
 * stop sentence itself ("This build reached its spending limit of $5.00. Your
 * plan and files are saved.") is already the build's blocker message, shown by
 * every blocked view, so this carries only what that sentence leaves out: what
 * retrying does.
 */
export const SpendStopSchema = v.pipe(
	v.strictObject({
		/** "Retrying starts the build again with a new spending limit." */
		note: v.string(),
	}),
	v.readonly(),
);
export type SpendStop = v.InferOutput<typeof SpendStopSchema>;

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
		/**
		 * "How your app works" (team mode, plan part B / section 7, screen 1).
		 * The approved `caddie-architecture` block in plain words, for the Design
		 * review screen. OPTIONAL and read-only: filled by the server only when
		 * a team-mode project has an approved design block, left ABSENT
		 * otherwise, so the screen renders nothing (never a bare heading).
		 * Nothing here is guessed — every line comes from the real block, and
		 * the review findings from the real architect rounds.
		 */
		design: v.optional(DesignOverviewSchema),
		/**
		 * The big-app module board (team mode, plan part P / section 7, screen 2).
		 * One row per module with its plain name and build state, so the build
		 * progress screen shows the parts side by side. ABSENT for a small app
		 * (one module) — the small app then shows its server and screens parts
		 * instead. Each state is the plain word the person reads, derived from
		 * the stored module status.
		 */
		modules: v.optional(v.array(ModuleProgressItemSchema)),
		/**
		 * The spending-limit stop (team mode, plan part A / section 7, screen 2).
		 * Present ONLY when a build stopped because it reached its limit: the
		 * limit message and what is saved. ABSENT otherwise. Derived from the
		 * real workflow detail + the payer's limit, never a made-up number.
		 */
		spendStop: v.optional(SpendStopSchema),
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
