/**
 * B05 — restore the right work after interruption (PURE, no I/O).
 *
 * On a cold restart the host rebuilds scope + run and re-opens the sandbox
 * session, but a chat transcript alone is not enough to restore an execution
 * environment. Before any effect, the host must prove the restored workspace
 * still matches what the run was building: the same stack, the last verified
 * checkpoint still present and pointing where expected, and (when known) the
 * same recipe version. On any mismatch, effects are REFUSED with an actionable
 * reason rather than writing into an incompatible workspace (plan B05.2).
 *
 * This is the pure decision; the caller (resolveCoordinatorContext / the
 * feature loop) consults it before the first write on a resumed build.
 */

export interface RestoreCompatibilityInput {
	/** The stack the run was admitted with (run_bindings.stackId). */
	expectedStack: string;
	/** The stack the restored session actually provides. */
	restoredStack: string;
	/** The last verified checkpoint the feature expects, or null for none yet. */
	expectedCheckpointRef: string | null;
	/** The checkpoint actually available in the restored workspace, or null. */
	availableCheckpointRef: string | null;
	/** The recipe version the run used, when recorded. */
	expectedRecipeVersion?: string;
	/** The recipe version the restored environment provides, when recorded. */
	restoredRecipeVersion?: string;
}

export type RestoreCompatibility = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a restored build workspace may take effects. Strict on the
 * three identity dimensions the host can actually compare; permissive only
 * where a value is genuinely unknown (legacy runs without a recorded recipe
 * version are not blocked on that dimension).
 */
export function restoreCompatibility(input: RestoreCompatibilityInput): RestoreCompatibility {
	if (input.expectedStack !== input.restoredStack)
		return {
			ok: false,
			reason: `The restored workspace is a ${input.restoredStack} stack, but this build is ${input.expectedStack}. It cannot continue here.`,
		};
	// The last verified checkpoint must be present and be the exact one the
	// feature expects — a gone or moved checkpoint means the save point this
	// feature resumes from is no longer there.
	if (input.expectedCheckpointRef !== input.availableCheckpointRef)
		return {
			ok: false,
			reason:
				input.availableCheckpointRef === null
					? "The last verified checkpoint for this feature is no longer available in the restored workspace."
					: "The restored workspace's checkpoint does not match the one this feature was verified at.",
		};
	// Recipe version: only a blocker when BOTH are known and differ. An absent
	// value is a legacy run that never recorded one — do not refuse on unknown.
	if (
		input.expectedRecipeVersion !== undefined &&
		input.restoredRecipeVersion !== undefined &&
		input.expectedRecipeVersion !== input.restoredRecipeVersion
	)
		return {
			ok: false,
			reason: `The build recipe changed (was ${input.expectedRecipeVersion}, now ${input.restoredRecipeVersion}); the restored checkpoint may be incompatible.`,
		};
	return { ok: true };
}
