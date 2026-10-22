/**
 * Software-team mode: the shared names every lane imports (plan section 4).
 *
 * One source of truth for the switch keys and values, the build-module
 * lifecycle, the spend-reservation lifecycle, the job-run lifecycle and the
 * email modes. These are the exact literals migration 0040's CHECK constraints
 * and server/platform-switches.ts enforce, so a lane that imports from here can
 * never drift from the column a value lands in. Serializable literals only — no
 * I/O, no app state.
 */

// --- platform switches -------------------------------------------------------

/** The five platform switches, flipped through the operator route without a redeploy. */
export const SWITCH_KEYS = ['team_mode', 'big_apps', 'app_features', 'spend_enforcement', 'publish_safety'] as const;
export type SwitchKey = (typeof SWITCH_KEYS)[number];

/**
 * Every value a switch may hold. `team_mode`, `big_apps` and `app_features` use
 * all three; `spend_enforcement` and `publish_safety` use only `on`/`off`. The
 * per-key allowed set is enforced in server/platform-switches.ts.
 */
export const SWITCH_VALUES = ['off', 'owner', 'on'] as const;
export type SwitchValue = (typeof SWITCH_VALUES)[number];

/** The two switches that are only ever on or off. */
export const BINARY_SWITCH_VALUES = ['on', 'off'] as const;
export type BinarySwitchValue = (typeof BINARY_SWITCH_VALUES)[number];

/** Which values each switch may take. */
export const SWITCH_ALLOWED_VALUES = {
	team_mode: SWITCH_VALUES,
	big_apps: SWITCH_VALUES,
	app_features: SWITCH_VALUES,
	spend_enforcement: BINARY_SWITCH_VALUES,
	publish_safety: BINARY_SWITCH_VALUES,
} as const satisfies Record<SwitchKey, readonly SwitchValue[]>;

/** Where a switch's current value came from: the env default, or a stored row. */
export const SWITCH_SOURCES = ['env', 'set'] as const;
export type SwitchSource = (typeof SWITCH_SOURCES)[number];

// --- build modules (part P/Q) ------------------------------------------------

/** A big-app module's lifecycle (build_modules.status). */
export const BUILD_MODULE_STATUSES = ['pending', 'building', 'stopped', 'passed', 'merged', 'not-merged'] as const;
export type BuildModuleStatus = (typeof BUILD_MODULE_STATUSES)[number];

// --- spend reservations (part A) ---------------------------------------------

/** A spend reservation's lifecycle (build_spend_reservations.status). */
export const RESERVATION_STATUSES = ['reserved', 'settled', 'released'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

// --- job runs (part N) -------------------------------------------------------

/** A "Run now" job run's lifecycle (app_job_runs.status). */
export const JOB_RUN_STATUSES = ['running', 'done', 'failed'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

// --- emails (part K) ---------------------------------------------------------

/** The mode an app's test email was produced in (app_test_emails.mode). */
export const EMAIL_MODES = ['preview', 'live'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];
