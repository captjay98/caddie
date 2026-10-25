/** Legacy test-count compatibility gate. A prior red bundle, dependency or test
 * summary is NOT evidence that a new feature works. Flat-count repairs require
 * independent host-owned criteria evidence; the author cannot supply that flag.
 * Count growth remains a legacy compatibility signal, not a production-readiness claim.
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
  /** Host-owned criteria receipt, distinct from the app author’s test suite. */
  independentCriteriaPassed?: boolean;
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
	if (input.independentCriteriaPassed === true)
		return {
			kind: "accept",
			reason: "Independent feature criteria pass. A verified existing-test repair needs no added test.",
		};
	return {
		kind: "reject",
		reason: "No independent feature evidence was recorded. A repaired check alone does not prove this feature works.",
	};
}
