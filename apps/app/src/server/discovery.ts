import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { canonicalizeUrl } from './evidence/sources.ts';
import { deriveEvidenceId } from './evidence/identity.ts';
import { listClaims, surveyClaims, type ReconciliationClaim } from './evidence/claims.ts';
import {
	evaluateEligibility,
	type EligibilityEvaluation,
	type EligibilityProfile,
	type EligibilityRuleClaim,
} from './eligibility.ts';

/**
 * P11 slice 1 — discovery: the candidate feed, candidate identity, and
 * explainable fit (feature-ledger C10, IMPROVE over the carryover
 * discover/scout pair).
 *
 * Invariants (each pinned by a test):
 *   - Candidate identity is a DETERMINISTIC hash of (source, canonical URL)
 *     derived server-side at ingest — never client-supplied. The carryover
 *     scout bound candidates by prose-derived client ids; here
 *     {@link assertCandidateId} refuses any id that does not match the
 *     derivation, and every stored row re-checks it on read.
 *   - Source adapters are pluggable ({@link DiscoverySourceAdapter}); the
 *     local implementation reads seeded candidates from D1. A real Devpost
 *     adapter is documented as P17 live wiring — nothing here pretends to
 *     fetch Devpost.
 *   - Partial feed failure is VISIBLE: each source's outcome (succeeded /
 *     failed + reason) is recorded per feed run, so a failed source shows up
 *     as a named gap — never a silent drop.
 *   - Fit is EXPLAINABLE: every fit claim points at the P10 evidence claim ids
 *     it rests on (through the P10 authority reconciliation), or honestly
 *     records an assumption / unknown. Nothing is invented.
 *   - Ranking is conservative: hard-ineligible candidates can never rank as
 *     eligible, whatever their fit ({@link rankCandidateSummaries}).
 *
 * Every service takes its Scope as a MANDATORY parameter and re-verifies it
 * against D1 at entry (P02 pattern); every query leads with projectId.
 */

// --- shapes ---------------------------------------------------------------------

/** One requirement a candidate states, mapped to the evidence claim type that would establish it. */
export interface CandidateRequirement {
	readonly text: string;
	readonly claimType: string;
}

/** An adapter-raw candidate: NO id field — identity is derived server-side. */
export interface RawCandidate {
	readonly url: string;
	readonly title: string;
	readonly summary: string;
	readonly publishedAt?: string | null;
	readonly requirements?: readonly CandidateRequirement[];
}

export interface DiscoverySourceBatch {
	readonly candidates: readonly RawCandidate[];
}

/**
 * The pluggable source boundary (P11 packets text): implement this to add a
 * source. The LOCAL adapter reads the discovery_seed_candidates D1 table; the
 * real Devpost search/extract adapter is P17 live wiring with provenance and
 * call receipts — this interface is its seam, not a stand-in for it.
 */
export interface DiscoverySourceAdapter {
	readonly id: string;
	fetchCandidates(input: { projectId: string }): Promise<DiscoverySourceBatch>;
}

export type CandidateStatus = 'new' | 'accepted' | 'dismissed';

export interface CandidateRecord {
	readonly id: string;
	readonly projectId: string;
	readonly source: string;
	readonly url: string;
	readonly title: string;
	readonly summary: string;
	readonly publishedAt: string | null;
	readonly requirements: readonly CandidateRequirement[];
	readonly status: CandidateStatus;
	/** B01: the saved bookmark (its own axis, never a status). Null = not saved. */
	readonly savedAt: string | null;
	readonly feedRunId: string;
	readonly firstSeenAt: string;
	readonly updatedAt: string;
}

export type FeedSourceOutcome = 'succeeded' | 'failed';

export interface FeedSourceRecord {
	readonly id: string;
	readonly feedRunId: string;
	readonly source: string;
	readonly outcome: FeedSourceOutcome;
	/** Why the source failed — the visible gap (null when succeeded). */
	readonly failureReason: string | null;
	readonly candidateCount: number;
	readonly completedAt: string;
}

export interface DiscoveryFeedRecord {
	readonly id: string;
	readonly projectId: string;
	readonly requestedBy: string;
	readonly requestedAt: string;
	readonly sources: readonly FeedSourceRecord[];
	/** Candidates stored under this run's derived ids (dedupe: re-runs repeat rows, never duplicate them). */
	readonly candidates: readonly CandidateRecord[];
}

// --- fit ------------------------------------------------------------------------

export type FitVerdict = 'supported' | 'conflict' | 'unmatched' | 'unknown';

export interface FitClaim {
	/** The candidate requirement this claim explains. */
	readonly requirement: string;
	readonly claimType: string;
	readonly verdict: FitVerdict;
	readonly statement: string;
	/** The P10 evidence claim ids this claim rests on (empty only with an honest assumption). */
	readonly evidenceClaimIds: readonly string[];
	/** Recorded assumptions — what the claim would need but does not have. */
	readonly assumptions: readonly string[];
}

export interface FitResult {
	readonly candidateId: string;
	/** Crude heuristic count of supported requirements — an ordering label, NOT a probability. */
	readonly matchedRequirements: number;
	readonly claims: readonly FitClaim[];
	readonly fitVersion: string;
}

export const FIT_VERSION = 'p11-fit-1';

// --- helpers --------------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function candidateFromRow(row: Record<string, unknown>): CandidateRecord {
	const status = row['status'];
	if (status !== 'new' && status !== 'accepted' && status !== 'dismissed') {
		fail(500, 'invalid_row', `candidate row carries an unknown status: ${String(status)}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		source: String(row['source']),
		url: String(row['url']),
		title: String(row['title']),
		summary: String(row['summary']),
		publishedAt: row['publishedAt'] == null ? null : String(row['publishedAt']),
		requirements: parseRequirementsJson(row['requirementsJson']),
		status,
		savedAt: row['savedAt'] == null ? null : String(row['savedAt']),
		feedRunId: String(row['feedRunId']),
		firstSeenAt: String(row['firstSeenAt']),
		updatedAt: String(row['updatedAt']),
	};
}

/** JSON column: a corrupt value degrades to an empty mapping, never a crash. */
function parseRequirementsJson(raw: unknown): readonly CandidateRequirement[] {
	if (typeof raw !== 'string') return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((entry): CandidateRequirement[] => {
			if (entry === null || typeof entry !== 'object') return [];
			const text = (entry as { text?: unknown }).text;
			const claimType = (entry as { claimType?: unknown }).claimType;
			if (typeof text !== 'string' || typeof claimType !== 'string' || !text.trim() || !claimType.trim()) {
				return [];
			}
			return [{ text, claimType }];
		});
	} catch {
		return [];
	}
}

// --- candidate identity ------------------------------------------------------------

/**
 * The deterministic candidate id: a hash of (source, canonical URL) via the
 * P10 URL canonicalization, so tracking-parameter variants are one candidate.
 * Callers cannot supply an id anywhere — this function IS the identity.
 */
export async function deriveCandidateId(source: string, url: string): Promise<string> {
	if (typeof source !== 'string' || source.trim().length === 0) {
		fail(400, 'invalid_input', 'candidate source is required');
	}
	if (typeof url !== 'string' || url.trim().length === 0) {
		fail(400, 'invalid_input', 'candidate url is required');
	}
	const canonical = canonicalizeUrl(url);
	return deriveEvidenceId('cand', source.trim(), canonical);
}

/**
 * Refuse any candidate id that does not match the derivation for its
 * (source, URL) — candidate binding can never be driven by a client-invented
 * or prose-derived identity.
 */
export async function assertCandidateId(candidateId: string, source: string, url: string): Promise<void> {
	const derived = await deriveCandidateId(source, url);
	if (candidateId !== derived) {
		fail(
			400,
			'fabricated_candidate_id',
			`candidate id does not match the deterministic derivation for (source, url) — fabricated ids are rejected`,
		);
	}
}

// --- local seed source adapter ------------------------------------------------------

export interface SeedCandidateInput {
	source: string;
	url: string;
	title: string;
	summary: string;
	publishedAt?: string | null;
	requirements?: readonly CandidateRequirement[];
}

/**
 * Seed the LOCAL source adapter's D1 table. This is the local implementation
 * of the pluggable feed (no external calls); a real Devpost adapter is P17
 * live wiring. Idempotent per (source, url).
 */
export async function seedCandidates(db: D1Database, inputs: readonly SeedCandidateInput[]): Promise<number> {
	let inserted = 0;
	for (const input of inputs) {
		if (typeof input.source !== 'string' || !input.source.trim()) {
			fail(400, 'invalid_input', 'seed source is required');
		}
		if (typeof input.url !== 'string' || !input.url.trim()) {
			fail(400, 'invalid_input', 'seed url is required');
		}
		if (typeof input.title !== 'string' || !input.title.trim()) {
			fail(400, 'invalid_input', 'seed title is required');
		}
		if (typeof input.summary !== 'string' || !input.summary.trim()) {
			fail(400, 'invalid_input', 'seed summary is required');
		}
		const result = await db
			.prepare(
				'insert or ignore into "discovery_seed_candidates" ' +
					'("id","source","url","title","summary","publishedAt","requirementsJson","createdAt") ' +
					'values (?,?,?,?,?,?,?,?)',
			)
			.bind(
				newId('seed'),
				input.source.trim(),
				canonicalizeUrl(input.url),
				input.title.trim(),
				input.summary.trim(),
				input.publishedAt ?? null,
				JSON.stringify(input.requirements ?? []),
				nowIso(),
			)
			.run();
		const meta = (result as { meta?: { changes?: number } }).meta;
		if ((meta?.changes ?? 0) > 0) inserted += 1;
	}
	return inserted;
}

/**
 * The LOCAL {@link DiscoverySourceAdapter}: returns the seeded candidates for
 * one source id (all sources when omitted). Deliberately boring — its job is
 * to prove the feed/identity/failure machinery, not to impersonate Devpost.
 */
export function createLocalSeedAdapter(db: D1Database, sourceId?: string): DiscoverySourceAdapter {
	return {
		id: sourceId ?? 'local-seed',
		async fetchCandidates(): Promise<DiscoverySourceBatch> {
			const rows = sourceId
				? await queryAll(
						db,
						'select * from "discovery_seed_candidates" where "source" = ? order by "createdAt" asc, "id" asc',
						sourceId,
					)
				: await queryAll(db, 'select * from "discovery_seed_candidates" order by "createdAt" asc, "id" asc');
			return {
				candidates: rows.map((row) => ({
					url: String(row['url']),
					title: String(row['title']),
					summary: String(row['summary']),
					publishedAt: row['publishedAt'] == null ? null : String(row['publishedAt']),
					requirements: parseRequirementsJson(row['requirementsJson']),
				})),
			};
		},
	};
}

// --- the feed -----------------------------------------------------------------------

/**
 * Run the candidate feed: execute every adapter, record each source's outcome
 * (a thrown adapter becomes a named FAILED gap with its reason — a partial
 * failure is visible, never silently dropped), and ingest candidates under
 * their derived ids. Ingest is idempotent per (project, source, url): re-runs
 * land on the same rows.
 *
 * A candidate whose URL cannot be canonicalized fails its whole source run —
 * the failure is visible at the source level rather than a junk row slipping
 * through with a guessed identity.
 */
export async function runDiscoveryFeed(
	db: D1Database,
	scope: Scope,
	options: { adapters: readonly DiscoverySourceAdapter[] },
): Promise<DiscoveryFeedRecord> {
	const verified = await assertProjectScope(db, scope);
	const feedRunId = newId('feed');
	const requestedAt = nowIso();
	await db
		.prepare(
			'insert into "discovery_feed_runs" ("id","projectId","requestedBy","requestedAt","candidateCount") values (?,?,?,?,0)',
		)
		.bind(feedRunId, verified.projectId, verified.actorId, requestedAt)
		.run();

	const derivedIds: string[] = [];
	let totalSeen = 0;
	for (const adapter of options.adapters) {
		const sourceStartedAt = nowIso();
		let seen = 0;
		let failureReason: string | null = null;
		try {
			const batch = await adapter.fetchCandidates({ projectId: verified.projectId });
			for (const raw of batch.candidates) {
				const canonicalUrl = canonicalizeUrl(raw.url); // throws -> source-level failure, no junk rows
				const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fail(400, 'invalid_input', 'candidate title is required');
				const summary =
					typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : fail(400, 'invalid_input', 'candidate summary is required');
				const id = await deriveCandidateId(adapter.id, canonicalUrl);
				await db
					.prepare(
						'insert or ignore into "discovery_candidates" ' +
							'("id","projectId","source","url","title","summary","publishedAt","requirementsJson","status","feedRunId","firstSeenAt","updatedAt") ' +
							'values (?,?,?,?,?,?,?,?,?,?,?,?)',
					)
					.bind(
						id,
						verified.projectId,
						adapter.id,
						canonicalUrl,
						title,
						summary,
						raw.publishedAt ?? null,
						JSON.stringify(raw.requirements ?? []),
						'new',
						feedRunId,
						requestedAt,
						requestedAt,
					)
					.run();
				if (!derivedIds.includes(id)) derivedIds.push(id);
				seen += 1;
			}
		} catch (error) {
			failureReason = error instanceof Error ? error.message : String(error);
		}
		totalSeen += seen;
		await db
			.prepare(
				'insert into "discovery_feed_sources" ' +
					'("id","feedRunId","projectId","source","outcome","failureReason","candidateCount","completedAt") ' +
					'values (?,?,?,?,?,?,?,?)',
			)
			.bind(
				newId('feedsrc'),
				feedRunId,
				verified.projectId,
				adapter.id,
				failureReason === null ? 'succeeded' : 'failed',
				failureReason,
				seen,
				sourceStartedAt,
			)
			.run();
	}

	await db
		.prepare('update "discovery_feed_runs" set "candidateCount" = ? where "id" = ? and "projectId" = ?')
		.bind(totalSeen, feedRunId, verified.projectId)
		.run();

	return (await getFeedRun(db, verified, feedRunId, derivedIds))!;
}

/**
 * One feed run with its per-source outcomes (the gaps) and its candidates, or
 * null. `derivedIds` (set by {@link runDiscoveryFeed}) lists the candidates
 * THIS run derived ids for: on a re-run nothing new is stored (the row keeps
 * its first-seen run), but the run still reports the candidates it saw.
 */
export async function getFeedRun(
	db: D1Database,
	scope: Scope,
	feedRunId: string,
	derivedIds?: readonly string[],
): Promise<DiscoveryFeedRecord | null> {
	const verified = await assertProjectScope(db, scope);
	if (typeof feedRunId !== 'string' || feedRunId.length === 0) {
		fail(400, 'invalid_request', 'feedRunId is required');
	}
	const runs = await queryAll(
		db,
		'select * from "discovery_feed_runs" where "id" = ? and "projectId" = ?',
		feedRunId,
		verified.projectId,
	);
	const run = runs[0];
	if (!run) return null;
	const sourceRows = await queryAll(
		db,
		'select * from "discovery_feed_sources" where "feedRunId" = ? and "projectId" = ? order by "completedAt" asc, "id" asc',
		feedRunId,
		verified.projectId,
	);
	const candidateRows =
		derivedIds && derivedIds.length > 0
			? await queryAll(
					db,
					`select * from "discovery_candidates" where "projectId" = ? and "id" in (${derivedIds.map(() => '?').join(', ')}) ` +
						'order by "firstSeenAt" asc, "id" asc',
					verified.projectId,
					...derivedIds,
				)
			: await queryAll(
					db,
					'select * from "discovery_candidates" where "feedRunId" = ? and "projectId" = ? order by "firstSeenAt" asc, "id" asc',
					feedRunId,
					verified.projectId,
				);
	return {
		id: String(run['id']),
		projectId: String(run['projectId']),
		requestedBy: String(run['requestedBy']),
		requestedAt: String(run['requestedAt']),
		sources: sourceRows.map((row) => ({
			id: String(row['id']),
			feedRunId: String(row['feedRunId']),
			source: String(row['source']),
			outcome: String(row['outcome']) as FeedSourceOutcome,
			failureReason: row['failureReason'] == null ? null : String(row['failureReason']),
			candidateCount: Number(row['candidateCount']),
			completedAt: String(row['completedAt']),
		})),
		candidates: candidateRows.map(candidateFromRow),
	};
}

/** The project's feed runs, newest first (records only; use getFeedRun for detail). */
export async function listFeedRuns(db: D1Database, scope: Scope): Promise<DiscoveryFeedRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select "id" from "discovery_feed_runs" where "projectId" = ? order by "requestedAt" desc, "id" asc',
		verified.projectId,
	);
	const out: DiscoveryFeedRecord[] = [];
	for (const row of rows) {
		const record = await getFeedRun(db, verified, String(row['id']));
		if (record) out.push(record);
	}
	return out;
}

// --- candidates -----------------------------------------------------------------------

export async function listCandidates(db: D1Database, scope: Scope): Promise<CandidateRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "discovery_candidates" where "projectId" = ? order by "firstSeenAt" desc, "id" asc',
		verified.projectId,
	);
	return rows.map(candidateFromRow);
}

/**
 * One project-scoped candidate, or 404. The stored id is re-checked against
 * its (source, url) derivation on every read: a row whose identity does not
 * match its content is refused rather than served.
 */
export async function getCandidate(db: D1Database, scope: Scope, candidateId: string): Promise<CandidateRecord> {
	const verified = await assertProjectScope(db, scope);
	if (typeof candidateId !== 'string' || candidateId.length === 0) {
		fail(400, 'invalid_request', 'candidateId is required');
	}
	const rows = await queryAll(
		db,
		'select * from "discovery_candidates" where "id" = ? and "projectId" = ?',
		candidateId,
		verified.projectId,
	);
	const row = rows[0];
	if (!row) fail(404, 'candidate_not_found', 'no such candidate in this project');
	await assertCandidateId(String(row!['id']), String(row!['source']), String(row!['url']));
	return candidateFromRow(row!);
}

/** Mark a candidate accepted (the id must be the derived identity — see assertCandidateId). */
export async function acceptCandidate(db: D1Database, scope: Scope, candidateId: string): Promise<CandidateRecord> {
	const candidate = await getCandidate(db, scope, candidateId);
	await db
		.prepare('update "discovery_candidates" set "status" = \'accepted\', "updatedAt" = ? where "id" = ? and "projectId" = ?')
		.bind(nowIso(), candidate.id, scope.projectId)
		.run();
	return getCandidate(db, scope, candidateId);
}

/**
 * B01 — save/unsave a candidate WITHOUT accepting it (HANDOFF §8.1).
 * `savedAt` is its own axis: saving bookmarks the candidate on the project's
 * shortlist and never touches `status`, never creates a project, and never
 * starts a run. Unsave clears the bookmark.
 */
export async function saveCandidate(db: D1Database, scope: Scope, candidateId: string): Promise<CandidateRecord> {
	const candidate = await getCandidate(db, scope, candidateId);
	await db
		.prepare('update "discovery_candidates" set "savedAt" = ?, "updatedAt" = ? where "id" = ? and "projectId" = ?')
		.bind(nowIso(), nowIso(), candidate.id, scope.projectId)
		.run();
	return getCandidate(db, scope, candidateId);
}

export async function unsaveCandidate(db: D1Database, scope: Scope, candidateId: string): Promise<CandidateRecord> {
	const candidate = await getCandidate(db, scope, candidateId);
	await db
		.prepare('update "discovery_candidates" set "savedAt" = NULL, "updatedAt" = ? where "id" = ? and "projectId" = ?')
		.bind(nowIso(), candidate.id, scope.projectId)
		.run();
	return getCandidate(db, scope, candidateId);
}

/** The project's saved shortlist, newest saved first. Project-scoped by the
 *  same scope checks as every other candidate read. */
export async function listSavedCandidates(db: D1Database, scope: Scope): Promise<CandidateRecord[]> {
	await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "discovery_candidates" where "projectId" = ? and "savedAt" is not null order by "savedAt" desc, "id" asc',
		scope.projectId,
	);
	return rows.map(candidateFromRow);
}

// --- explainable fit --------------------------------------------------------------------

/**
 * Compute the explainable fit for one candidate against the project's P10
 * evidence. Each requirement maps to a claim type; the P10 authority
 * reconciliation decides what the project's evidence currently says:
 *
 *   - a reconciled winner    → 'supported', citing that claim id;
 *   - a retained conflict    → 'conflict', citing the conflicting claim ids;
 *   - no stored evidence     → 'unknown' with a recorded assumption — nothing
 *     is invented and no claim is fabricated.
 */
export async function computeFit(db: D1Database, scope: Scope, candidate: CandidateRecord): Promise<FitResult> {
	await assertProjectScope(db, scope);
	const claims: FitClaim[] = [];
	for (const requirement of candidate.requirements) {
		const surveys = await surveyClaims(db, scope, { claimType: requirement.claimType });
		const survey = surveys.find((s) => s.claimType === requirement.claimType);
		if (survey?.conflict) {
			claims.push({
				requirement: requirement.text,
				claimType: requirement.claimType,
				verdict: 'conflict',
				statement: `equal-authority evidence disagrees about ${requirement.claimType} — retained conflict, not auto-resolved`,
				evidenceClaimIds: [...survey.conflict.claimIds],
				assumptions: ['the conflict must be resolved against the sources before this requirement is treated as met'],
			});
			continue;
		}
		if (survey?.winner) {
			const winner: ReconciliationClaim = survey.winner;
			claims.push({
				requirement: requirement.text,
				claimType: requirement.claimType,
				verdict: 'supported',
				statement: `stored evidence: ${requirement.claimType} = ${winner.value}`,
				evidenceClaimIds: [winner.claimId],
				assumptions: [],
			});
			continue;
		}
		claims.push({
			requirement: requirement.text,
			claimType: requirement.claimType,
			verdict: 'unknown',
			statement: `no stored evidence for ${requirement.claimType}`,
			evidenceClaimIds: [],
			assumptions: [`the project holds no evidence claim of type ${requirement.claimType} — capture the rule before treating this as met`],
		});
	}
	return {
		candidateId: candidate.id,
		matchedRequirements: claims.filter((c) => c.verdict === 'supported').length,
		claims,
		fitVersion: FIT_VERSION,
	};
}

// --- eligibility read-model --------------------------------------------------------------

/**
 * Evaluate a candidate's eligibility from the project's quoted rules (P10
 * claims of type `eligibility.*`) and the caller-supplied profile. All rule
 * inputs are quoted claims — there is no prompt channel (eligibility.ts).
 */
export async function evaluateCandidateEligibility(
	db: D1Database,
	scope: Scope,
	candidate: CandidateRecord,
	profile: EligibilityProfile,
): Promise<EligibilityEvaluation> {
	await assertProjectScope(db, scope);
	void candidate; // eligibility is a property of the project's rules + profile; the candidate identifies the read
	const all = await listClaims(db, scope);
	const ruleClaims: EligibilityRuleClaim[] = all
		.filter((claim) => claim.status === 'active' && claim.claimType.startsWith('eligibility.'))
		.map((claim) => ({
			claimId: claim.id,
			claimType: claim.claimType,
			value: claim.value,
			quote: claim.quote,
		}));
	return evaluateEligibility(ruleClaims, profile);
}

/** One candidate's full read model for the UI: fit + eligibility, both explainable. */
export interface CandidateEvaluation {
	readonly candidate: CandidateRecord;
	readonly fit: FitResult;
	readonly eligibility: EligibilityEvaluation;
}

export async function evaluateCandidate(
	db: D1Database,
	scope: Scope,
	candidateId: string,
	profile: EligibilityProfile,
): Promise<CandidateEvaluation> {
	const candidate = await getCandidate(db, scope, candidateId);
	const [fit, eligibility] = await Promise.all([
		computeFit(db, scope, candidate),
		evaluateCandidateEligibility(db, scope, candidate, profile),
	]);
	return { candidate, fit, eligibility };
}

export interface CandidateListEvaluation {
	readonly evaluations: readonly CandidateEvaluation[];
	/** Conservative ranking: eligible first, unknown, ineligible last (rankCandidateSummaries). */
	readonly ranked: readonly CandidateSummary[];
	/** The profile country the eligibility read used (honesty about the input). */
	readonly profileCountry: string | null;
}

/**
 * Evaluate every project candidate (fit + eligibility) and rank them
 * conservatively. Used by the evaluated list endpoint; the profile is the
 * ACTOR's P14 profile — the route layer resolves it from the verified session.
 */
export async function listCandidateEvaluations(
	db: D1Database,
	scope: Scope,
	profile: EligibilityProfile,
): Promise<CandidateListEvaluation> {
	const candidates = await listCandidates(db, scope);
	const evaluations: CandidateEvaluation[] = [];
	for (const candidate of candidates) {
		const [fit, eligibility] = [
			await computeFit(db, scope, candidate),
			await evaluateCandidateEligibility(db, scope, candidate, profile),
		];
		evaluations.push({ candidate, fit, eligibility });
	}
	const ranked = rankCandidateSummaries(
		evaluations.map((e) => ({
			candidateId: e.candidate.id,
			matchedRequirements: e.fit.matchedRequirements,
			verdict: e.eligibility.verdict,
		})),
	);
	return { evaluations, ranked, profileCountry: profile.country };
}

// --- conservative ranking --------------------------------------------------------------------

export interface CandidateSummary {
	readonly candidateId: string;
	readonly matchedRequirements: number;
	readonly verdict: 'eligible' | 'ineligible' | 'unknown';
}

const VERDICT_ORDER: Readonly<Record<CandidateSummary['verdict'], number>> = {
	eligible: 0,
	unknown: 1,
	ineligible: 2,
};

/**
 * Conservative ranking: eligible candidates first (better fit first), then
 * unknown, then ineligible LAST — a hard-ineligible candidate can never rank
 * as eligible, whatever its fit (its true verdict is retained, never
 * relabeled). Deterministic: ties break on candidateId.
 */
export function rankCandidateSummaries(entries: readonly CandidateSummary[]): CandidateSummary[] {
	return [...entries].sort((a, b) => {
		const va = VERDICT_ORDER[a.verdict] ?? Number.MAX_SAFE_INTEGER;
		const vb = VERDICT_ORDER[b.verdict] ?? Number.MAX_SAFE_INTEGER;
		if (va !== vb) return va - vb;
		if (a.matchedRequirements !== b.matchedRequirements) return b.matchedRequirements - a.matchedRequirements;
		return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
	});
}
