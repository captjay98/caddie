/**
 * P10 — THE one shared authority vocabulary (feature-ledger H1, audit defect
 * #6: the carryover system had several authority notions that could drift).
 *
 * This module is the single source of truth for source authority:
 *   - storage: the 0004 DDL `authority` check constraint enumerates exactly
 *     AUTHORITY_VALUES in this order (a unit test pins the agreement, so the
 *     vocabulary cannot drift between SQL and TypeScript);
 *   - logic: {@link authorityRank} feeds reconciliation in claims.ts;
 *   - UI: {@link authorityLabel} is what the evidence inspector renders.
 *
 * The levels carry over the HackSteward reference vocabulary
 * (SourceAuthority × AuthorityRank) with ONE correction: HackSteward mapped
 * `unknown` onto the UNVERIFIED rank, which let never-attributed content be
 * weighed as if someone had published it. Here `unknown` has NO rank — it can
 * never outrank anything and never wins reconciliation. Unknown is UNKNOWN,
 * never "low-confidence verified".
 *
 * A confidence number is not truth (contracts "UI and evidence"): authority
 * ranks order SOURCES by how they were published; they are not a probability
 * and the UI never presents them as one.
 *
 * Deliberately dependency-free: the client inspector imports this module too.
 */

export const AUTHORITY_TIERS = [
	'rules',
	'overview',
	'promotional',
	'unverified',
	'unknown',
] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

export interface AuthorityLevel {
	/** Storage value — the exact string in the DDL check constraint. */
	readonly value: string;
	/** Coarse tier, carried over from the HackSteward AuthorityRank names. */
	readonly tier: AuthorityTier;
	/**
	 * Reconciliation precedence: LOWER WINS (HackSteward AuthorityRank rule).
	 * `null` = UNKNOWN: never outranks, never wins, never treated as verified.
	 */
	readonly rank: number | null;
	/** Human label for the evidence inspector UI. */
	readonly label: string;
}

/** Strongest first. This exact order is mirrored by the 0004 DDL constraint. */
export const AUTHORITY_LEVELS: readonly AuthorityLevel[] = [
	{ value: 'binding_rules', tier: 'rules', rank: 1, label: 'Binding rules' },
	{ value: 'organizer_message', tier: 'rules', rank: 1, label: 'Organizer message' },
	{ value: 'official_faq', tier: 'rules', rank: 1, label: 'Official FAQ' },
	{ value: 'official_overview', tier: 'overview', rank: 2, label: 'Official overview' },
	{ value: 'sponsor_page', tier: 'promotional', rank: 3, label: 'Sponsor page' },
	{ value: 'community', tier: 'unverified', rank: 4, label: 'Community' },
	{ value: 'unknown', tier: 'unknown', rank: null, label: 'Unknown' },
] as const;

export const AUTHORITY_VALUES: readonly string[] = AUTHORITY_LEVELS.map((l) => l.value);

export type SourceAuthority = (typeof AUTHORITY_LEVELS)[number]['value'];

export const UNKNOWN_AUTHORITY: SourceAuthority = 'unknown';

const LEVELS_BY_VALUE: ReadonlyMap<string, AuthorityLevel> = new Map(
	AUTHORITY_LEVELS.map((level) => [level.value, level]),
);

export function isSourceAuthority(value: unknown): value is SourceAuthority {
	return typeof value === 'string' && LEVELS_BY_VALUE.has(value);
}

/** The single vocabulary entry for a stored authority value. */
export function authorityLevel(value: SourceAuthority): AuthorityLevel {
	const level = LEVELS_BY_VALUE.get(value);
	if (!level) {
		// Unreachable for values that passed isSourceAuthority / the DDL check.
		throw new Error(`authority value outside the shared vocabulary: ${String(value)}`);
	}
	return level;
}

/** Reconciliation precedence (lower wins); null for UNKNOWN. */
export function authorityRank(value: SourceAuthority): number | null {
	return authorityLevel(value).rank;
}

/** UI label — the ONLY authority rendering the inspector uses. */
export function authorityLabel(value: SourceAuthority): string {
	return authorityLevel(value).label;
}
