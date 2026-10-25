/**
 * B03 — progress detection by CONTENT fingerprint (PURE, no I/O).
 *
 * The repeat guard (coordinator-host.ts guardAction) flagged a repeated file
 * write when the last REPEATED_ACTION_LIMIT rows shared subject AND a byte
 * COUNT. Two different edits of the same length collided — a productive
 * equal-length edit was wrongly blocked — while genuine loops still had to
 * stop. This policy fingerprints an action by its CONTENT (file: subject +
 * content hash; command/check: subject + outcome) and stops only a true run of
 * identical fingerprints, over a bounded recent window.
 *
 * Distinguishes activity from progress (plan B03.4): a file whose bytes
 * actually changed, or a check whose outcome flipped, is progress even if the
 * subject repeats; an identical write or an unchanged failing command is not.
 */

export interface ActionInput {
	kind: "file" | "command" | "check";
	subject: string;
	/** File writes: a hash of the exact content. Omitted for command/check. */
	contentHash?: string;
	outcome: "ok" | "failed" | "cancelled";
}

/** An opaque, stable fingerprint string. Equal iff the actions are equivalent. */
export type ActionFingerprint = string;

/**
 * A stable fingerprint. A file is identified by its path AND content hash, so
 * an equal-length-but-different edit has a DIFFERENT fingerprint. A command or
 * check is identified by its subject AND outcome, so a flip (failed→ok) is a
 * different fingerprint (progress), while a repeated identical failure is the
 * same one.
 */
export function actionFingerprint(input: ActionInput): ActionFingerprint {
	if (input.kind === "file") return `file\u0000${input.subject}\u0000${input.contentHash ?? ""}`;
	return `${input.kind}\u0000${input.subject}\u0000${input.outcome}`;
}

export interface ProgressVerdict {
	kind: "proceed" | "no-progress";
	reason?: string;
}

/**
 * Decide whether `next` is genuine progress or a no-progress repeat. It is a
 * repeat ONLY when the last `limit` fingerprints in `recent` are ALL equal to
 * `next` (a contiguous run from the most recent end). Anything else — a
 * changed file, a flipped outcome, a different subject breaking the run, or
 * fewer than `limit` in the window — proceeds.
 *
 * O(limit): reads only the tail of `recent`, never the full history.
 */
export function progressVerdict(
	recent: readonly ActionFingerprint[],
	next: ActionFingerprint,
	limit: number,
): ProgressVerdict {
	if (limit <= 0) return { kind: "proceed" };
	if (recent.length < limit) return { kind: "proceed" };
	// The run already requires `limit` prior identical actions AND this one
	// repeating them; check the last `limit` entries of recent.
	for (let i = 0; i < limit; i++) {
		if (recent[recent.length - 1 - i] !== next) return { kind: "proceed" };
	}
	return {
		kind: "no-progress",
		reason:
			next.startsWith("file\u0000")
				? "the same file was written with identical content repeatedly — nothing changed"
				: "the same command repeated with the same outcome — nothing changed",
	};
}
