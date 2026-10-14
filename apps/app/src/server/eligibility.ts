import { ScopeError } from './scope.ts';

/**
 * P11 slice 1 — conservative eligibility checks (feature-ledger H3, adapted
 * from the HackSteward reference domain/eligibility_rules.py).
 *
 * The rules this module encodes, each pinned by a test:
 *
 *   1. QUOTED RULES DECIDE — every input is a P10 evidence claim (claim id +
 *      quoted rule text off an immutable snapshot). There is deliberately NO
 *      prompt channel: a model's impression or a user's hunch can never make a
 *      candidate eligible; only quoted rule evidence can. With no quoted rule
 *      at all the verdict is unknown, never eligible.
 *
 *   2. INELIGIBILITY REQUIRES A POSITIVE MISMATCH — a quoted rule must
 *      affirmatively exclude the user (an explicit restriction that matches,
 *      or an allowlist the user is known to fall outside). Absence of
 *      inclusion is not exclusion.
 *
 *   3. UNKNOWN IS UNKNOWN — a rule the narrow interpreter does not support, or
 *      one that needs a personal attribute the Caddie profile does not carry
 *      (date of birth, student status), yields 'unknown'. A conservative
 *      engine never guesses its way to 'eligible'.
 *
 *   4. PERSONAL FIT NEVER OVERRIDES HARD RESTRICTIONS — this module does not
 *      even accept fit as an input; the ranking layer (discovery.ts
 *      rankCandidateSummaries) demotes hard-ineligible candidates below every
 *      eligible one, so a perfect fit cannot relabel a restricted candidate.
 *
 * The interpreter is a deliberately narrow grammar over claim types (the same
 * posture as P10 deadlines: a mis-parsed rule is worse than an unparsed one).
 */

export type EligibilityVerdict = 'eligible' | 'ineligible' | 'unknown';

export type EligibilityRuleBasis =
	| 'quoted_rule'
	| 'unsupported_interpretation'
	| 'missing_profile_attribute';

/** The exact claim types this interpreter understands. Nothing else parses. */
export const ELIGIBILITY_RULE_TYPES: readonly string[] = [
	'eligibility.open_countries',
	'eligibility.restricted_countries',
	'eligibility.min_age',
	'eligibility.student_only',
];

/**
 * A quoted eligibility rule: a P10 claim (id + type + value + the verbatim
 * quote that anchors it to an immutable snapshot).
 */
export interface EligibilityRuleClaim {
	readonly claimId: string;
	readonly claimType: string;
	readonly value: string;
	readonly quote: string;
}

/**
 * The personal attributes eligibility may consult — EXACTLY the attributes
 * the P14 profile actually carries. Date of birth / student status are
 * deliberately absent: rules needing them fall to 'missing_profile_attribute'
 * instead of being silently assumed satisfied.
 */
export interface EligibilityProfile {
	readonly country: string | null;
}

export interface EligibilityRuleOutcome {
	readonly claimId: string;
	readonly claimType: string;
	readonly quote: string;
	readonly verdict: EligibilityVerdict;
	readonly basis: EligibilityRuleBasis;
	readonly reason: string;
}

export interface EligibilityEvaluation {
	readonly verdict: EligibilityVerdict;
	readonly rules: readonly EligibilityRuleOutcome[];
	/** Bump when the interpretation grammar changes (provenance of the read). */
	readonly evaluationVersion: string;
}

export const ELIGIBILITY_EVALUATION_VERSION = 'p11-eligibility-1';

function rule(
	claim: EligibilityRuleClaim,
	verdict: EligibilityVerdict,
	basis: EligibilityRuleBasis,
	reason: string,
): EligibilityRuleOutcome {
	return { claimId: claim.claimId, claimType: claim.claimType, quote: claim.quote, verdict, basis, reason };
}

/** ISO-3166 alpha-2 codes separated by commas, whitespace or semicolons. */
function parseCountryCodes(value: string): string[] | null {
	const codes = value
		.split(/[,;\s]+/)
		.map((c) => c.trim().toUpperCase())
		.filter((c) => c.length > 0);
	if (codes.length === 0) return null;
	for (const code of codes) {
		if (!/^[A-Z]{2}$/.test(code)) return null;
	}
	return codes;
}

function parsePositiveInteger(value: string): number | null {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return Number(trimmed);
}

function interpretRule(claim: EligibilityRuleClaim, profile: EligibilityProfile): EligibilityRuleOutcome {
	const fail = (
		basis: EligibilityRuleBasis,
		reason: string,
	): EligibilityRuleOutcome => rule(claim, 'unknown', basis, reason);

	switch (claim.claimType) {
		case 'eligibility.open_countries': {
			const codes = parseCountryCodes(claim.value);
			if (!codes) {
				return fail('unsupported_interpretation', `allowlist value ${JSON.stringify(claim.value)} is not a list of 2-letter country codes`);
			}
			if (profile.country === null) {
				return fail('missing_profile_attribute', 'the rule names an eligible-country set but the profile carries no country — eligibility is never assumed from a missing attribute');
			}
			const user = profile.country.toUpperCase();
			if (codes.includes(user)) {
				return rule(claim, 'eligible', 'quoted_rule', `quoted allowlist includes ${user}`);
			}
			return rule(claim, 'ineligible', 'quoted_rule', `quoted allowlist ${codes.join(', ')} does not include ${user} — positive mismatch`);
		}
		case 'eligibility.restricted_countries': {
			const codes = parseCountryCodes(claim.value);
			if (!codes) {
				return fail('unsupported_interpretation', `restriction value ${JSON.stringify(claim.value)} is not a list of 2-letter country codes`);
			}
			if (profile.country === null) {
				return fail('missing_profile_attribute', 'the rule names restricted countries but the profile carries no country — eligibility is never assumed from a missing attribute');
			}
			const user = profile.country.toUpperCase();
			if (codes.includes(user)) {
				return rule(claim, 'ineligible', 'quoted_rule', `quoted rule restricts ${codes.join(', ')} and the profile country is ${user} — positive mismatch`);
			}
			return rule(claim, 'eligible', 'quoted_rule', `quoted restriction ${codes.join(', ')} does not include ${user}`);
		}
		case 'eligibility.min_age': {
			const minAge = parsePositiveInteger(claim.value);
			if (minAge === null) {
				return fail('unsupported_interpretation', `min-age value ${JSON.stringify(claim.value)} is not a whole number`);
			}
			// The Caddie profile deliberately carries no date of birth: an age
			// gate can be seen, never applied.
			return fail('missing_profile_attribute', `quoted rule requires age >= ${minAge} but the profile carries no date of birth — the check is never assumed`);
		}
		case 'eligibility.student_only': {
			const normalized = claim.value.trim().toLowerCase();
			if (normalized !== 'true' && normalized !== 'false' && normalized !== 'yes' && normalized !== 'no') {
				return fail('unsupported_interpretation', `student-only value ${JSON.stringify(claim.value)} is not a boolean`);
			}
			return fail('missing_profile_attribute', 'quoted rule requires student status but the profile carries no enrollment attribute — the check is never assumed');
		}
		default:
			return fail('unsupported_interpretation', `claim type ${JSON.stringify(claim.claimType)} is outside the eligibility interpreter's narrow grammar`);
	}
}

/**
 * Evaluate quoted eligibility rules for one candidate against the profile.
 *
 * Aggregation (conservative ladder):
 *   - any rule renders the candidate INELIGIBLE → 'ineligible' (hard result);
 *   - else every rule rendered ELIGIBLE (there was at least one) → 'eligible';
 *   - else (any unknown, and no exclusion) → 'unknown' — never assume
 *     eligible.
 */
export function evaluateEligibility(
	claims: readonly EligibilityRuleClaim[],
	profile: EligibilityProfile,
): EligibilityEvaluation {
	if (profile === null || typeof profile !== 'object') {
		throw new ScopeError(400, 'invalid_input', 'an eligibility profile is required (use { country: null } when none is known)');
	}
	const rules = claims.map((claim) => interpretRule(claim, profile));
	let verdict: EligibilityVerdict;
	if (rules.some((r) => r.verdict === 'ineligible')) {
		verdict = 'ineligible';
	} else if (rules.length > 0 && rules.every((r) => r.verdict === 'eligible')) {
		verdict = 'eligible';
	} else {
		verdict = 'unknown';
	}
	return { verdict, rules, evaluationVersion: ELIGIBILITY_EVALUATION_VERSION };
}

/** What a card shows for eligibility: a short note, the deciding quote, and whether the user must confirm something. */
export interface EligibilityDisplay {
	/** Short user-facing line, e.g. "You can enter", "Only open to US", "Open to NG · confirm you're 18+". '' when no rules were read. */
	readonly note: string;
	/** The verbatim rule text that decided it (or the first relevant one); null when none. */
	readonly quote: string | null;
	/** True when the only open questions are attributes the profile cannot carry (age, student status). */
	readonly needsConfirm: boolean;
}

/**
 * Describe an evaluation for a card WITHOUT changing it: the verdict stays the
 * strict engine verdict. The one nuance it surfaces is the common Devpost case —
 * the country rules pass but an age/student rule cannot be checked from the
 * profile — as "Open to NG · confirm you're 18+" with `needsConfirm`, rather than
 * a bare "unknown" (or, worse, an assumed "eligible").
 *
 * `values` maps claimId → the claim's value (the evaluation carries the quote
 * and reason but not the raw value, e.g. the minimum age).
 */
export function describeEligibility(
	evaluation: EligibilityEvaluation,
	values: ReadonlyMap<string, string>,
	country: string | null,
): EligibilityDisplay {
	const rules = evaluation.rules;
	if (rules.length === 0) return { note: '', quote: null, needsConfirm: false };
	const codes = (rule: EligibilityRuleOutcome) => (values.get(rule.claimId) ?? '').toUpperCase().split(/[,;\s]+/).filter(Boolean);
	const blocking = rules.find((r) => r.verdict === 'ineligible');
	if (evaluation.verdict === 'ineligible' && blocking) {
		const listed = codes(blocking);
		const note =
			blocking.claimType === 'eligibility.open_countries'
				? `Only open to ${listed.slice(0, 4).join(', ')}${listed.length > 4 ? '…' : ''}`
				: blocking.claimType === 'eligibility.restricted_countries' && country
					? `Not open to residents of ${country.toUpperCase()}`
					: 'Not eligible';
		return { note, quote: blocking.quote, needsConfirm: false };
	}
	const countryRule = rules.find(
		(r) => (r.claimType === 'eligibility.open_countries' || r.claimType === 'eligibility.restricted_countries') && r.verdict === 'eligible',
	);
	if (evaluation.verdict === 'eligible') {
		return { note: 'You can enter', quote: (countryRule ?? rules[0]!).quote, needsConfirm: false };
	}
	// verdict 'unknown': is it ONLY profile-dependent attributes left?
	const open = rules.filter((r) => r.verdict === 'unknown');
	const onlyAttributes = open.length > 0 && open.every((r) => r.basis === 'missing_profile_attribute' &&
		(r.claimType === 'eligibility.min_age' || r.claimType === 'eligibility.student_only'));
	if (onlyAttributes) {
		const ask: string[] = [];
		const age = open.find((r) => r.claimType === 'eligibility.min_age');
		if (age) ask.push(`confirm you're ${values.get(age.claimId) ?? '18'}+`);
		if (open.some((r) => r.claimType === 'eligibility.student_only')) ask.push('confirm you are a student');
		const prefix = countryRule && country ? `Open to ${country.toUpperCase()} · ` : '';
		const text = `${prefix}${ask.join(' and ')}`;
		return { note: text.charAt(0).toUpperCase() + text.slice(1), quote: (countryRule ?? age ?? open[0]!).quote, needsConfirm: true };
	}
	// Something genuinely undecidable (no profile country, an unreadable rule).
	const firstOpen = open[0];
	const note =
		firstOpen?.basis === 'missing_profile_attribute' && (firstOpen.claimType.endsWith('_countries'))
			? 'Add your country to check'
			: 'Check the rules';
	return { note, quote: firstOpen?.quote ?? null, needsConfirm: false };
}
