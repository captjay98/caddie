/**
 * B04 — meaningful feature completion (PURE, no I/O).
 *
 * finishFeature gated a feature on `passing <= baseline` → reject. That made
 * the test COUNT the proxy for done-ness, with two failures (research doc
 * finding 2): a valid existing-test REPAIR (fixes a bug, adds no test) was
 * rejected, and a MEANINGLESS extra test was accepted even when a real check
 * still failed.
 *
 * This policy decides from what host-check receipts actually expose:
 *   - `checksPassed`: did every required host check pass this attempt;
 *   - `passing` vs `baseline`: the test COUNT now vs the protected baseline;
 *   - `priorFailingCheckNowGreen`: a check that was failing is now green (a
 *     real repair), even if the count did not grow.
 *
 * LIMITATION (documented, not faked): receipts carry counts + per-check
 * pass/fail, NOT per-test NAMES, so this cannot verify "a named test exists
 * per doneWhen criterion". That guarantee needs per-test identity the host
 * does not record today; see docs/evidence/2026-10-25-build-reliability.md.
 */

export interface AcceptanceInput {
	/** Every required host check (install / behaviour tests / bundle) passed. */
	checksPassed: boolean;
	/** Passing test count on this attempt. */
	passing: number;
	/** The protected baseline count (earlier features / before this attempt). */
	baseline: number;
	/** A check that was failing is now green — a real repair, not inflation. */
	priorFailingCheckNowGreen: boolean;
}

export interface AcceptanceVerdict {
	kind: "accept" | "reject";
	reason: string;
}

export function acceptanceVerdict(input: AcceptanceInput): AcceptanceVerdict {
	if (!input.checksPassed)
		return { kind: "reject", reason: "A required check still fails — the feature is not done yet." };
	if (input.passing < input.baseline)
		return {
			kind: "reject",
			reason: "The passing-test count dropped — a baseline test was weakened or deleted. Restore it.",
		};
	if (input.passing > input.baseline)
		return { kind: "accept", reason: "Checks pass and the feature added new passing tests." };
	// Flat count (passing === baseline) with all checks green.
	if (input.priorFailingCheckNowGreen)
		return {
			kind: "accept",
			reason: "Checks pass: a failing check was repaired. A valid existing-test repair needs no added test.",
		};
	return {
		kind: "reject",
		reason: "Nothing changed — no new coverage and no failing check was repaired. Add a test for the feature or report a blocker.",
	};
}
