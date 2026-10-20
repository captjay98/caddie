import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { deriveEvidenceId, sha256Hex } from './evidence/identity.ts';
import { isSourceAuthority, authorityRank } from './evidence/authority.ts';
import { listClaims, type ClaimRecord } from './evidence/claims.ts';
import { roundDetailText } from './round-detail.ts';

/**
 * P13 slice 1 — judge coaching (feature-ledger C15, IMPROVE over the
 * carryover judge.py): a coaching scorecard is only ever built from THIS
 * project's recorded evidence, never from a generic rubric.
 *
 * Invariants (each pinned by a test in tests/judge.test.ts):
 *   - The rubric is EXTRACTED from real P10 requirement claims
 *     (claimType 'judging.criterion' / 'judging.criterion.weight'). An empty
 *     evidence record yields an EMPTY rubric with a warning — the carryover
 *     Design/Impact/Innovation/Presentation set cannot travel, and no
 *     universal video/repo assumption enters here either.
 *   - Weights come only from parseable weight claims ('<criterion>=<number>');
 *     an unparseable weight is a named warning and stays unset, never a guess.
 *   - A criterion reading restated by a newer claim supersedes the older
 *     wording (same criterion identity: overlapping significant tokens);
 *     equal-authority readings that contradict each other for the SAME
 *     criterion signature are a RETAINED conflict, never auto-resolved.
 *   - Declared vs verified evidence is separated at the type level. Verified
 *     evidence comes ONLY from passed run receipts (P05); a 'deployed:'
 *     receipt prefix is what marks deployed-level verification. A declared
 *     claim can never lift a criterion above 'declared'.
 *   - Structured scoring is validated strictly against the extracted rubric
 *     and the evidence assessment: unknown/duplicate/missing criteria,
 *     out-of-range or non-numeric scores, empty notes and invented evidence
 *     refs are rejected. The access level in a model result is IGNORED —
 *     access is recomputed from receipts.
 *   - Coaching is never an organizer prediction: there is no win probability
 *     field anywhere, and the score average carries an explicit
 *     not-a-prediction label.
 *
 * Every service takes its Scope as a MANDATORY parameter and re-verifies it
 * against D1 at entry (P02 pattern); every query leads with projectId.
 */

export const JUDGE_VERSION = 'judge-v1';

/** Where a criterion's supporting evidence stands (HackStearer access ladder). */
export type EvidenceAccess = 'unknown' | 'declared' | 'verified_local' | 'verified_deployed';

const ACCESS_ORDER: Readonly<Record<Exclude<EvidenceAccess, 'unknown'>, number>> = {
	declared: 1,
	verified_local: 2,
	verified_deployed: 3,
};

// --- shared token machinery -----------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
	'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at', 'by', 'for',
	'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after',
	'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
	'again', 'further', 'once', 'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more',
	'most', 'other', 'some', 'such', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
	'can', 'will', 'just', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
	'had', 'do', 'does', 'did', 'of', 'it', 'its', 'this', 'that', 'these', 'those', 'as',
	'we', 'our', 'your', 'they', 'their', 'his', 'her', 'them', 'he', 'she', 'you', 'i',
]);

/**
 * The significant tokens of a text: lowercased alphanumeric runs of length
 * >= 2 that are not stopwords. Stopword-only text yields NO tokens, so two
 * texts can never match on filler words alone.
 */
export function significantTokens(text: string): string[] {
	if (typeof text !== 'string') return [];
	const out: string[] = [];
	for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		if (raw.length < 2 || STOPWORDS.has(raw)) continue;
		out.push(raw);
	}
	return out;
}

/**
 * Deterministic requirement matching (NOT a model call): a piece of evidence
 * matches a requirement when they share at least one significant token.
 * Stopword-only evidence matches nothing.
 */
export function matchesRequirement(evidenceText: string, requirementText: string): boolean {
	const evidence = new Set(significantTokens(evidenceText));
	if (evidence.size === 0) return false;
	return significantTokens(requirementText).some((token) => evidence.has(token));
}

// --- rubric extraction -----------------------------------------------------------

export interface RubricCriterion {
	/** The criterion exactly as the current claim states it — never paraphrased. */
	readonly text: string;
	/** Claimed weight in percent, or null when no parseable weight claim exists. */
	readonly weight: number | null;
	/** The evidence claim ids this criterion reading rests on (reading + weights). */
	readonly claimIds: readonly string[];
}

export interface RubricConflict {
	readonly claimType: 'judging.criterion';
	/** The shared criterion signature the readings disagree on. */
	readonly criterionKey: string;
	readonly claimIds: readonly string[];
}

export interface Rubric {
	readonly criteria: readonly RubricCriterion[];
	readonly warnings: readonly string[];
	/** Equal-authority disagreements about the same criterion — retained, unresolved. */
	readonly conflicts: readonly RubricConflict[];
	/** sha256 over the canonical rubric content — stable across re-extraction. */
	readonly hash: string;
	readonly extractionVersion: string;
}

interface CriterionReading {
	readonly id: string;
	readonly value: string;
	readonly authority: string;
	readonly rank: number | null;
	readonly capturedAt: string;
	/** SQLite rowid — the true insertion order, a monotonic tie-break when two
	 * captures land in the same millisecond (capturedAt has ms precision). */
	readonly rowId: number;
}

interface CriterionCandidate {
	readonly text: string;
	readonly claimIds: readonly string[];
	readonly tokens: ReadonlySet<string>;
	readonly capturedAt: string;
	readonly rowId: number;
}

/** Internal, mutable cluster form used while merging restatements. */
interface MutableCriterionCandidate {
	text: string;
	claimIds: string[];
	tokens: Set<string>;
	capturedAt: string;
	rowId: number;
}

function criterionSignature(text: string): string {
	return significantTokens(text).sort().join('|');
}

function claimIdsOf(reading: CriterionReading): string[] {
	return [reading.id];
}

/** The reading's recency rank: capture instant, then true insertion order. */
function isNewerReading(a: { capturedAt: string; rowId: number }, b: { capturedAt: string; rowId: number }): boolean {
	return (
		a.capturedAt > b.capturedAt || (a.capturedAt === b.capturedAt && a.rowId > b.rowId)
	);
}

/**
 * Resolve one same-signature group of criterion readings to at most one
 * criterion candidate:
 *   - a strictly-higher-authority reading wins outright (loser retained in
 *     evidence, never deleted);
 *   - equal-authority readings that agree on the value corroborate one
 *     criterion (all claim ids kept);
 *   - equal-authority readings that disagree are a RETAINED conflict and
 *     produce no criterion.
 */
function resolveSignatureGroup(
	signature: string,
	readings: CriterionReading[],
	warnings: string[],
	conflicts: RubricConflict[],
): CriterionCandidate | null {
	const ranks = readings.map((r) => r.rank ?? Number.POSITIVE_INFINITY);
	const minRank = Math.min(...ranks);
	const best = readings.filter((_, i) => ranks[i] === minRank);
	if (minRank !== Number.POSITIVE_INFINITY && best.length < readings.length && best.length === 1) {
		const winner = best[0]!;
		return {
			text: winner.value,
			claimIds: claimIdsOf(winner),
			tokens: new Set(significantTokens(winner.value)),
			capturedAt: winner.capturedAt,
			rowId: winner.rowId,
		};
	}
	// Equal authority (or unrankable): agreement corroborates, disagreement conflicts.
	const normalized = new Set(readings.map((r) => r.value.trim().toLowerCase()));
	if (normalized.size === 1) {
		const newest = readings.reduce((acc, reading) => (isNewerReading(reading, acc) ? reading : acc));
		return {
			text: newest.value,
			claimIds: readings.map((r) => r.id).sort(),
			tokens: new Set(significantTokens(newest.value)),
			capturedAt: newest.capturedAt,
			rowId: newest.rowId,
		};
	}
	conflicts.push({
		claimType: 'judging.criterion',
		criterionKey: signature,
		claimIds: readings.map((r) => r.id).sort(),
	});
	warnings.push(
		`Equal-authority claims disagree about the criterion "${signature}" — the rubric omits it rather than resolving the conflict silently.`,
	);
	return null;
}

/**
 * Extract the judging rubric from this project's REAL requirement claims.
 * Never returns a generic rubric: with no judging claims on record the
 * rubric is empty and the warning says so.
 */
export async function extractRubric(db: D1Database, scope: Scope): Promise<Rubric> {
	await assertProjectScope(db, scope);
	const warnings: string[] = [];
	const conflicts: RubricConflict[] = [];

	const rows = await db
		.prepare(
			'select c."rowid" as rowId, c."id" as id, c."value" as value, c."snapshotCapturedAt" as capturedAt, src."authority" as authority ' +
				'from "evidence_claims" c join "evidence_sources" src on src."id" = c."sourceId" and src."projectId" = c."projectId" ' +
				'where c."projectId" = ? and c."claimType" = \'judging.criterion\' and c."status" = \'active\' ' +
				'order by c."snapshotCapturedAt" asc, c."rowid" asc',
		)
		.bind(scope.projectId)
		.all();
	const readings: CriterionReading[] = (rows.results ?? []).map((row) => {
		const authority = String(row['authority'] ?? 'unknown');
		return {
			id: String(row['id']),
			value: String(row['value']),
			authority,
			rank: isSourceAuthority(authority) ? authorityRank(authority) : null,
			capturedAt: String(row['capturedAt']),
			rowId: Number(row['rowId']),
		};
	});

	// Group same-signature readings, then merge signature groups whose token
	// sets overlap: a newer claim rewording an existing criterion (e.g. "old
	// wording" -> "current wording") SUPERSEDES the older reading instead of
	// multiplying criteria. Genuinely disjoint token sets are distinct criteria.
	const bySignature = new Map<string, CriterionReading[]>();
	for (const reading of readings) {
		const signature = criterionSignature(reading.value);
		if (signature.length === 0) {
			warnings.push(
				`A judging criterion claim ("${reading.id}") has no significant words in its value — it is skipped rather than guessed into a criterion.`,
			);
			continue;
		}
		const group = bySignature.get(signature) ?? [];
		group.push(reading);
		bySignature.set(signature, group);
	}

	const candidates: MutableCriterionCandidate[] = [];
	for (const [signature, group] of [...bySignature.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		const candidate = resolveSignatureGroup(signature, group, warnings, conflicts);
		if (!candidate) continue;
		const cluster = candidates.find((existing) =>
			[...candidate.tokens].some((token) => existing.tokens.has(token)),
		);
		if (cluster) {
			// Restatement: the newer wording is the criterion; the older reading
			// is history (its ids stay on the underlying claims, not the rubric).
			// Recency is (capturedAt, insertion order) — deterministic even when
			// two captures share a millisecond.
			const newerWins = isNewerReading(candidate, cluster);
			cluster.tokens = new Set([...cluster.tokens, ...candidate.tokens]);
			if (newerWins) {
				cluster.text = candidate.text;
				cluster.claimIds = [...candidate.claimIds];
				cluster.capturedAt = candidate.capturedAt;
				cluster.rowId = candidate.rowId;
			}
		} else {
			candidates.push({
				text: candidate.text,
				claimIds: [...candidate.claimIds],
				tokens: new Set(candidate.tokens),
				capturedAt: candidate.capturedAt,
				rowId: candidate.rowId,
			});
		}
	}

	// Weights: only parseable '<criterion>=<number>' claims attach; everything
	// else is a named warning and the weight stays unset (never an equal-weight
	// guess).
	const weightRows = await db
		.prepare(
			'select "id", "value" from "evidence_claims" ' +
				'where "projectId" = ? and "claimType" = \'judging.criterion.weight\' and "status" = \'active\' ' +
				'order by "snapshotCapturedAt" asc, "id" asc',
		)
		.bind(scope.projectId)
		.all();
	const criteria: { text: string; weight: number | null; claimIds: string[] }[] = candidates
		.map((candidate) => ({
			text: candidate.text,
			weight: null,
			claimIds: [...candidate.claimIds],
		}))
		.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
	for (const row of (weightRows.results ?? []) as Record<string, unknown>[]) {
		const claimId = String(row['id']);
		const raw = String(row['value'] ?? '');
		const separator = raw.lastIndexOf('=');
		const label = separator > 0 ? raw.slice(0, separator).trim() : '';
		const numberText = separator > 0 ? raw.slice(separator + 1).trim().replace(/%\s*$/, '') : '';
		const parsed = numberText.length > 0 ? Number(numberText) : Number.NaN;
		const target =
			(label.length > 0 && Number.isFinite(parsed) && parsed > 0 && parsed <= 100
				? criteria.find((c) => c.text === label) ??
					criteria.find((c) => c.text.toLowerCase() === label.toLowerCase())
				: undefined) ?? null;
		if (target && target.weight === null) {
			target.weight = parsed;
			target.claimIds.push(claimId);
		} else if (target) {
			warnings.push(
				`Criterion "${target.text}" already has a claimed weight — the later claim "${raw}" is recorded but ignored rather than averaged in.`,
			);
		} else {
			warnings.push(
				`Criterion weight claim "${raw}" could not be attached to a criterion as a percentage — the weight stays unset rather than guessed.`,
			);
		}
	}

	if (criteria.length === 0) {
		warnings.push(
			'No judging criteria are on record in this project\'s evidence — the rubric stays EMPTY instead of assuming a generic criterion set.',
		);
	}

	const hashPayload = JSON.stringify({
		extractionVersion: JUDGE_VERSION,
		criteria: criteria.map((c) => ({ text: c.text, weight: c.weight, claimIds: [...c.claimIds].sort() })),
		conflicts: [...conflicts].sort((a, b) => (a.criterionKey < b.criterionKey ? -1 : 1)),
	});
	const hash = `sha256-${await sha256Hex(hashPayload)}`;
	return {
		criteria,
		warnings,
		conflicts,
		hash,
		extractionVersion: JUDGE_VERSION,
	};
}

// --- evidence assessment: declared vs verified --------------------------------------

export interface EvidenceRef {
	readonly level: Exclude<EvidenceAccess, 'unknown'>;
	readonly ref: {
		readonly id: string;
		/** 'receipt' = passed run verification; 'claim' = declared evidence claim. */
		readonly kind: 'receipt' | 'claim';
		readonly text: string;
	};
}

export interface CriterionEvidence {
	readonly criterionText: string;
	/** Passed run receipts ONLY — a declared claim can never appear here. */
	readonly verified: readonly EvidenceRef[];
	/** Declared ('evidence.delivered') claims — separate list, never merged. */
	readonly declared: readonly EvidenceRef[];
	/** The strongest VERIFIED level wins; declared alone reads 'declared'. */
	readonly access: EvidenceAccess;
}

interface ReceiptRow {
	readonly id: string;
	readonly check: string;
	readonly evidence: string;
	readonly level: 'verified_local' | 'verified_deployed';
}

async function loadPassedReceipts(db: D1Database, scope: Scope): Promise<ReceiptRow[]> {
	const rows = await db
		.prepare(
			'select "id", "check", "evidence" from "run_verifications" ' +
				'where "projectId" = ? and "passed" = 1 order by "createdAt" asc, "id" asc',
		)
		.bind(scope.projectId)
		.all();
	return ((rows.results ?? []) as Record<string, unknown>[]).map((row) => {
		const check = String(row['check'] ?? '');
		return {
			id: String(row['id']),
			check,
			evidence: String(row['evidence'] ?? ''),
			// Only a 'deployed:' receipt prefix marks deployed-level verification.
			level: /^\s*deployed\s*:/i.test(check) ? 'verified_deployed' : 'verified_local',
		};
	});
}

/**
 * Assess each rubric criterion against the project's evidence:
 * receipts (run_verifications, passed only) are VERIFIED evidence; active
 * 'evidence.delivered' claims that match the criterion are DECLARED evidence.
 * The two never mix, and access comes only from receipts. When ANY receipt
 * matches a criterion, the project's full passed-receipt ledger is that
 * criterion's verified set — receipts verify the delivered artifact, not a
 * paraphrase of one criterion.
 */
export async function assessCriterionEvidence(
	db: D1Database,
	scope: Scope,
	rubric: Rubric,
): Promise<CriterionEvidence[]> {
	await assertProjectScope(db, scope);
	const receipts = await loadPassedReceipts(db, scope);
	const declaredClaims: ClaimRecord[] = await listClaims(db, scope, {
		claimType: 'evidence.delivered',
		status: 'active',
	});

	return rubric.criteria.map((criterion) => {
		const covered = receipts.some((receipt) =>
			matchesRequirement(`${receipt.check} ${receipt.evidence}`, criterion.text),
		);
		const verified: EvidenceRef[] = covered
			? receipts.map((receipt) => ({
					level: receipt.level,
					ref: { id: receipt.id, kind: 'receipt', text: `${receipt.check} — ${receipt.evidence}` },
				}))
			: [];
		const declared: EvidenceRef[] = declaredClaims
			.filter((claim) => matchesRequirement(`${claim.value} ${claim.quote}`, criterion.text))
			.map((claim) => ({
				level: 'declared' as const,
				ref: { id: claim.id, kind: 'claim' as const, text: claim.value },
			}));
		const access: EvidenceAccess = verified.some((v) => v.level === 'verified_deployed')
			? 'verified_deployed'
			: verified.length > 0
				? 'verified_local'
				: declared.length > 0
					? 'declared'
					: 'unknown';
		return { criterionText: criterion.text, verified, declared, access };
	});
}

function strongestAccess(verified: readonly EvidenceRef[]): EvidenceAccess {
	if (verified.length === 0) return 'unknown';
	let strongest: EvidenceAccess = 'verified_local';
	for (const ref of verified) {
		if (ACCESS_ORDER[ref.level] > ACCESS_ORDER[strongest]) strongest = ref.level;
	}
	return strongest;
}

// --- structured scoring -----------------------------------------------------------

export interface ScorecardCriterion {
	readonly criterion: string;
	/** Integer 0–10, validated against the extracted rubric. */
	readonly score: number;
	readonly notes: string;
	/** Recomputed from receipts/claims — never trusted from the raw result. */
	readonly access: EvidenceAccess;
	readonly evidenceRefIds: readonly string[];
}

export interface Scorecard {
	readonly criteria: readonly ScorecardCriterion[];
	readonly topRisks: readonly string[];
	/** Mean score across criteria — explicitly NOT a prediction. */
	readonly coachingAverage: number;
	readonly averageLabel: string;
	readonly scoringVersion: string;
}

function scoringError(message: string): never {
	throw new ScopeError(400, 'invalid_scoring', message);
}

function requireScorecardString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		scoringError(`scoring result field '${field}' must be a non-empty string`);
	}
	return value;
}

/**
 * Validate a raw structured scoring result (as a model would emit it) against
 * the extracted rubric and the recorded evidence assessment. STRICT:
 *   - the body must be an object with a criteria array and a topRisks array;
 *   - every rubric criterion scored exactly once — unknown or missing ones reject;
 *   - scores are integers 0–10; notes are non-empty;
 *   - evidenceRefIds (optional) must cite refs that exist in THIS assessment;
 *   - the raw per-criterion access level is IGNORED — access is recomputed
 *     from receipts/claims, so a result cannot upgrade its own evidence.
 * The average is a coaching aid and is labeled not-a-prediction; no win
 * probability exists anywhere in the output.
 */
export function validateScoringResult(
	rubric: Rubric,
	assessment: readonly CriterionEvidence[],
	raw: unknown,
): Scorecard {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		scoringError('scoring result must be a JSON object');
	}
	const body = raw as Record<string, unknown>;
	if (!Array.isArray(body['criteria'])) {
		scoringError("scoring result field 'criteria' must be an array");
	}
	if (rubric.criteria.length === 0) {
		scoringError('the extracted rubric has no criteria to score');
	}
	if (!Array.isArray(body['topRisks'])) {
		scoringError("scoring result field 'topRisks' must be an array");
	}
	const topRisks = body['topRisks'].map((risk) => {
		if (typeof risk !== 'string' || risk.trim().length === 0) {
			scoringError('every topRisk must be a non-empty string');
		}
		return risk.trim();
	});

	const assessmentByText = new Map(assessment.map((entry) => [entry.criterionText, entry]));
	const seen = new Set<string>();
	const scored: ScorecardCriterion[] = [];
	for (const entry of body['criteria']) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			scoringError('every criteria entry must be a JSON object');
		}
		const record = entry as Record<string, unknown>;
		const criterion = requireScorecardString(record['criterion'], 'criterion');
		const rubricCriterion = rubric.criteria.find((c) => c.text === criterion);
		if (!rubricCriterion) {
			scoringError(`scoring result names criterion "${criterion}" which is not in the extracted rubric`);
		}
		if (seen.has(criterion)) {
			scoringError(`criterion "${criterion}" is scored more than once`);
		}
		seen.add(criterion);
		const score = record['score'];
		if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10) {
			scoringError(`score for "${criterion}" must be an integer from 0 to 10`);
		}
		const notes = requireScorecardString(record['notes'], 'notes').trim();
		const entry_ = assessmentByText.get(criterion);
		if (!entry_) {
			scoringError(`no evidence assessment exists for criterion "${criterion}"`);
		}
		let evidenceRefIds: string[] = [];
		if (record['evidenceRefIds'] !== undefined && record['evidenceRefIds'] !== null) {
			if (!Array.isArray(record['evidenceRefIds'])) {
				scoringError(`evidenceRefIds for "${criterion}" must be an array of ref ids`);
			}
			const available = new Set(
				[...entry_!.verified, ...entry_!.declared].map((ref) => ref.ref.id),
			);
			evidenceRefIds = record['evidenceRefIds'].map((id) => {
				if (typeof id !== 'string' || !available.has(id)) {
					scoringError(`evidenceRefIds for "${criterion}" cite "${String(id)}" which is not evidence for that criterion`);
				}
				return id;
			});
		}
		// Access comes from the RECORDED evidence, never from the raw result.
		scored.push({
			criterion,
			score,
			notes,
			access: entry_!.access ?? strongestAccess(entry_!.verified),
			evidenceRefIds,
		});
	}
	const missing = rubric.criteria.filter((c) => !seen.has(c.text)).map((c) => c.text);
	if (missing.length > 0) {
		scoringError(`scoring result is missing rubric criteria: ${missing.join(', ')}`);
	}

	const average =
		Math.round((scored.reduce((sum, c) => sum + c.score, 0) / scored.length) * 100) / 100;
	return {
		criteria: scored,
		topRisks,
		coachingAverage: average,
		averageLabel:
			`Coaching average across ${scored.length} criteria — not a prediction of contest outcomes, judge scoring, or placement.`,
		scoringVersion: JUDGE_VERSION,
	};
}

// --- persistence -----------------------------------------------------------------

export interface ScorecardRecord {
	readonly id: string;
	readonly projectId: string;
	readonly rubricHash: string;
	readonly rubricJson: string;
	readonly result: Scorecard;
	readonly scoringVersion: string;
	readonly createdBy: string;
	readonly createdAt: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Persist a validated scorecard WITH the exact rubric snapshot it was scored
 * against (rubricHash + rubricJson), so a later rubric change can never
 * silently reinterpret an old score.
 */
export async function recordScorecard(
	db: D1Database,
	scope: Scope,
	scorecard: Scorecard,
	rubric: Rubric,
): Promise<ScorecardRecord> {
	await assertProjectScope(db, scope);
	const id = `judge_${crypto.randomUUID()}`;
	const createdAt = nowIso();
	await db
		.prepare(
			'insert into "judge_scorecards" ' +
				'("id", "projectId", "rubricHash", "rubricJson", "resultJson", "scoringVersion", "createdBy", "createdAt") ' +
				'values (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(
			id,
			scope.projectId,
			rubric.hash,
			JSON.stringify(rubric),
			JSON.stringify(scorecard),
			scorecard.scoringVersion,
			scope.actorId,
			createdAt,
		)
		.run();
	return {
		id,
		projectId: scope.projectId,
		rubricHash: rubric.hash,
		rubricJson: JSON.stringify(rubric),
		result: scorecard,
		scoringVersion: scorecard.scoringVersion,
		createdBy: scope.actorId,
		createdAt,
	};
}

export async function listScorecards(db: D1Database, scope: Scope): Promise<ScorecardRecord[]> {
	await assertProjectScope(db, scope);
	const rows = await db
		.prepare(
			'select "id", "projectId", "rubricHash", "rubricJson", "resultJson", "scoringVersion", "createdBy", "createdAt" ' +
				'from "judge_scorecards" where "projectId" = ? order by "createdAt" desc, "id" asc',
		)
		.bind(scope.projectId)
		.all();
	return ((rows.results ?? []) as Record<string, unknown>[]).map((row) => {
		let result: Scorecard;
		try {
			result = JSON.parse(String(row['resultJson'])) as Scorecard;
		} catch {
			throw new ScopeError(500, 'invalid_row', `scorecard ${String(row['id'])} carries an unparseable result`);
		}
		return {
			id: String(row['id']),
			projectId: String(row['projectId']),
			rubricHash: String(row['rubricHash']),
			rubricJson: String(row['rubricJson']),
			result,
			scoringVersion: String(row['scoringVersion']),
			createdBy: String(row['createdBy']),
			createdAt: String(row['createdAt']),
		};
	});
}

// --- coaching materials: demo script / friction log / pre-mortem ----------------------

export interface DemoStep {
	readonly text: string;
	readonly claimId: string;
	readonly locator: string | null;
}

export interface DemoScript {
	readonly steps: readonly DemoStep[];
	/** Honest provenance / gap note — never an invented step. */
	readonly note: string;
}

export interface FrictionEntry {
	readonly id: string;
	readonly issue: string;
	readonly outcome: 'started' | 'succeeded' | 'failed';
	readonly detail: string | null;
	readonly occurredAt: string;
}

export interface PreMortemItem {
	readonly risk: string;
	/** Non-empty citations: claim / receipt / round ids the risk derives from. */
	readonly refs: readonly string[];
}

export interface CoachingMaterials {
	readonly demoScript: DemoScript;
	readonly frictionLog: readonly FrictionEntry[];
	readonly preMortem: readonly PreMortemItem[];
	readonly disclaimer: string;
	readonly coachingVersion: string;
}

/**
 * Coaching materials derived ENTIRELY from this project's records:
 *   - demo script: 'demo.step' claims ordered by their numeric locator;
 *   - friction log: the real 'repair_attempt' run rounds — not a narrative;
 *   - pre-mortem: failed receipts, failed repair rounds and criteria whose
 *     evidence is missing or declared-only, each citing its sources.
 * No invented content, no predictions, no win probability.
 */
export async function buildCoachingMaterials(
	db: D1Database,
	scope: Scope,
): Promise<CoachingMaterials> {
	await assertProjectScope(db, scope);

	// Demo script from demo.step claims.
	const demoClaims = await listClaims(db, scope, { claimType: 'demo.step', status: 'active' });
	const steps: DemoStep[] = demoClaims
		.map((claim) => ({
			text: claim.value,
			claimId: claim.id,
			locator: claim.locator,
			order: claim.locator !== null && claim.locator !== '' && Number.isFinite(Number(claim.locator))
				? Number(claim.locator)
				: Number.POSITIVE_INFINITY,
		}))
		.sort((a, b) =>
			a.order === b.order ? (a.claimId < b.claimId ? -1 : 1) : a.order - b.order,
		)
		.map(({ text, claimId, locator }) => ({ text, claimId, locator }));
	const demoScript: DemoScript = {
		steps,
		note:
			steps.length === 0
				? 'No demo.step claims are on record for this project — the demo script stays empty rather than inventing steps.'
				: `Derived from ${steps.length} demo.step claim(s); the order follows each claim's recorded locator.`,
	};

	// Friction log from real repair_attempt rounds.
	const roundRows = await db
		.prepare(
			'select "id", "issue", "outcome", "detail", "createdAt" from "run_rounds" ' +
				'where "projectId" = ? and "round" = \'repair_attempt\' order by "createdAt" asc, "id" asc',
		)
		.bind(scope.projectId)
		.all();
	const frictionLog: FrictionEntry[] = ((roundRows.results ?? []) as Record<string, unknown>[]).map(
		(row) => ({
			id: String(row['id']),
			issue: String(row['issue']),
			outcome: String(row['outcome']) as FrictionEntry['outcome'],
			detail: roundDetailText(row['detail'] == null ? null : String(row['detail'])),
			occurredAt: String(row['createdAt']),
		}),
	);

	// Pre-mortem from failed receipts, unresolved friction and evidence gaps.
	const preMortem: PreMortemItem[] = [];
	const failedReceipts = await db
		.prepare(
			'select "id", "check", "evidence" from "run_verifications" ' +
				'where "projectId" = ? and "passed" = 0 order by "createdAt" asc, "id" asc',
		)
		.bind(scope.projectId)
		.all();
	for (const row of (failedReceipts.results ?? []) as Record<string, unknown>[]) {
		preMortem.push({
			risk: `Verification failed on record: "${String(row['check'])}" (${String(row['evidence'])}) — judges may probe exactly this.`,
			refs: [String(row['id'])],
		});
	}
	for (const entry of frictionLog.filter((f) => f.outcome !== 'succeeded')) {
		preMortem.push({
			risk: `Unresolved friction on record: "${entry.issue}" (last repair attempt did not succeed).`,
			refs: [entry.id],
		});
	}
	const rubric = await extractRubric(db, scope);
	const assessment = await assessCriterionEvidence(db, scope, rubric);
	for (const entry of assessment) {
		if (entry.access === 'unknown') {
			preMortem.push({
				risk: `${entry.criterionText}: no evidence on record — neither receipts nor declared claims support this criterion yet.`,
				refs: rubric.criteria.find((c) => c.text === entry.criterionText)?.claimIds ?? [],
			});
		} else if (entry.access === 'declared') {
			preMortem.push({
				risk: `${entry.criterionText}: declared but unverified — only claims assert it and no receipt confirms it.`,
				refs: entry.declared.map((ref) => ref.ref.id),
			});
		}
	}

	return {
		demoScript,
		frictionLog,
		preMortem,
		disclaimer:
			'Coaching materials describe the current state of recorded evidence only. They are not a prediction of contest outcomes, judge scoring, or placement.',
		coachingVersion: JUDGE_VERSION,
	};
}

// Re-export so route/fixture layers can derive related ids without reaching
// into the evidence module directly.
export { deriveEvidenceId };
