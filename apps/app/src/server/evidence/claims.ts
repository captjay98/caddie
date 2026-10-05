import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../auth.ts';
import { ScopeError, assertProjectScope } from '../scope.ts';
import { authorityRank, isSourceAuthority } from './authority.ts';
import { deriveEvidenceId } from './identity.ts';
import { getSnapshot, type SnapshotRecord } from './sources.ts';

/**
 * P10 evidence slices 1+2 — claims: a deterministic READING of an immutable
 * snapshot (feature-ledger H1/C11, adapted from HackSteward domain/evidence.py).
 *
 * Invariants (each pinned by a test):
 *   - Deterministic identity: a claim id is derived from (project, snapshot,
 *     locator, quote, claim type), so repeated extraction of an unchanged
 *     reading lands on the SAME row — retries never duplicate evidence.
 *   - Audit defect #1: the quote attaches to the EXACT fetched snapshot id,
 *     the snapshot must really exist in this project, and the quoted text
 *     must actually occur in that snapshot's content. No marker rows.
 *   - Supersession: when the SAME source restates a claim key in a newer
 *     snapshot, the older reading becomes history (status 'superseded',
 *     supersededBy set) — the page changed its mind, it did not start
 *     contradicting a peer. History is retained, never deleted.
 *   - Extraction version is recorded on every claim: the provenance of the
 *     reading, not just of the bytes.
 *   - A confidence number is recorded (optionally) for tie-ordering only —
 *     it is never truth and the UI never presents it as one.
 *   - Authority reconciliation (slice 2, ported from HackSteward
 *     reconcile_claims_by_authority): strictly-higher authority wins with the
 *     loser retained; equal-authority disagreement is a RETAINED conflict,
 *     never auto-resolved; UNKNOWN authority has no rank and never wins.
 */

export type ClaimStatus = 'active' | 'superseded';

export interface ClaimRecord {
	readonly id: string;
	readonly projectId: string;
	readonly sourceId: string;
	readonly snapshotId: string;
	readonly claimType: string;
	readonly value: string;
	readonly quote: string;
	readonly locator: string | null;
	readonly extractionVersion: string;
	readonly confidence: number | null;
	readonly status: ClaimStatus;
	readonly supersededBy: string | null;
	readonly snapshotCapturedAt: string;
	readonly createdAt: string;
}

/** A claim joined with what a reader needs to weigh it (inspector payload). */
export interface ClaimWithEvidence extends ClaimRecord {
	readonly sourceAuthority: string;
	readonly snapshotContentHash: string;
	readonly snapshotProvenance: string;
	readonly canonicalUrl: string;
}

// --- helpers -----------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		fail(400, 'invalid_input', `${field} is required and must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') fail(400, 'invalid_input', `${field} must be a string`);
	return value.trim().length === 0 ? null : value;
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function claimFromRow(row: Record<string, unknown>): ClaimRecord {
	const status = row['status'];
	if (status !== 'active' && status !== 'superseded') {
		fail(500, 'invalid_row', `claim row carries an unknown status: ${String(status)}`);
	}
	const confidence = row['confidence'];
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		sourceId: String(row['sourceId']),
		snapshotId: String(row['snapshotId']),
		claimType: String(row['claimType']),
		value: String(row['value']),
		quote: String(row['quote']),
		locator: row['locator'] == null ? null : String(row['locator']),
		extractionVersion: String(row['extractionVersion']),
		confidence: confidence == null ? null : Number(confidence),
		status,
		supersededBy: row['supersededBy'] == null ? null : String(row['supersededBy']),
		snapshotCapturedAt: String(row['snapshotCapturedAt']),
		createdAt: String(row['createdAt']),
	};
}

const CLAIM_COLUMNS =
	'"id", "projectId", "sourceId", "snapshotId", "claimType", "value", "quote", "locator", ' +
	'"extractionVersion", "confidence", "status", "supersededBy", "snapshotCapturedAt", "createdAt"';

// --- writing claims --------------------------------------------------------------

export interface ClaimCreateInput {
	snapshotId: string;
	claimType: string;
	value: string;
	quote: string;
	locator?: string | null;
	extractionVersion: string;
	confidence?: number | null;
}

/**
 * Record a claim read off an immutable snapshot. Idempotent: the same
 * (snapshot, locator, quote, claimType) in the same project always produces
 * the same row. The quote is validated against the snapshot's actual content
 * before anything is written.
 */
export async function addClaim(
	db: D1Database,
	scope: Scope,
	input: ClaimCreateInput,
): Promise<ClaimRecord> {
	await assertProjectScope(db, scope);
	// The claim binds to the EXACT snapshot, resolved INSIDE the caller's
	// project — a snapshot id from another project 404s here (defect #1).
	const snapshot: SnapshotRecord = await getSnapshot(db, scope, input.snapshotId);
	const claimType = requireString(input.claimType, 'claimType');
	const value = requireString(input.value, 'value');
	const quote = requireString(input.quote, 'quote');
	const extractionVersion = requireString(input.extractionVersion, 'extractionVersion');
	const locator = optionalString(input.locator, 'locator');
	let confidence: number | null = null;
	if (input.confidence !== undefined && input.confidence !== null) {
		if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
			fail(400, 'invalid_input', 'confidence must be a number between 0 and 1');
		}
		if (input.confidence < 0 || input.confidence > 1) {
			fail(400, 'invalid_input', 'confidence must be a number between 0 and 1');
		}
		confidence = input.confidence;
	}
	if (!snapshot.content.includes(quote)) {
		// The quote must exist in the immutable actual snapshot — a citation to
		// text the snapshot does not carry is fabrication, not evidence.
		fail(400, 'quote_not_in_snapshot', 'quote does not occur in the referenced snapshot content');
	}
	const id = await deriveEvidenceId(
		'clm',
		scope.projectId,
		snapshot.id,
		locator ?? '',
		quote,
		claimType,
	);

	const existingRows = await queryAll(
		db,
		`select ${CLAIM_COLUMNS} from "evidence_claims" where "id" = ? and "projectId" = ?`,
		id,
		scope.projectId,
	);
	if (existingRows[0]) {
		// Repeated extraction: the reading already exists — return it unchanged.
		return claimFromRow(existingRows[0]!);
	}

	// Supersession: same source + same claim key. A NEWER reading supersedes
	// the older ones; a reading attached to an OLD snapshot (a historical
	// re-read) is born superseded by the source's newest word.
	const peerRows = await queryAll(
		db,
		`select ${CLAIM_COLUMNS} from "evidence_claims" ` +
			'where "projectId" = ? and "sourceId" = ? and "claimType" = ? and "status" = \'active\' and "id" <> ?',
		scope.projectId,
		snapshot.sourceId,
		claimType,
		id,
	);
	const peers = peerRows.map(claimFromRow);
	const newer = peers
		.filter((p) => p.snapshotCapturedAt > snapshot.capturedAt)
		.sort((a, b) =>
			a.snapshotCapturedAt === b.snapshotCapturedAt
				? a.id < b.id
					? -1
					: 1
				: a.snapshotCapturedAt > b.snapshotCapturedAt
					? -1
					: 1,
		);
	const older = peers.filter((p) => p.snapshotCapturedAt < snapshot.capturedAt);

	const status: ClaimStatus = newer.length > 0 ? 'superseded' : 'active';
	const supersededBy = newer.length > 0 ? newer[0]!.id : null;
	const now = nowIso();

	const statements = [
		db
			.prepare(
				'insert or ignore into "evidence_claims" ' +
					`(${CLAIM_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				scope.projectId,
				snapshot.sourceId,
				snapshot.id,
				claimType,
				value,
				quote,
				locator,
				extractionVersion,
				confidence,
				status,
				supersededBy,
				snapshot.capturedAt,
				now,
			),
		...older.map((peer) =>
			db
				.prepare(
					'update "evidence_claims" set "status" = \'superseded\', "supersededBy" = ? ' +
						'where "id" = ? and "status" = \'active\'',
				)
				.bind(id, peer.id),
		),
	];
	await db.batch(statements);
	return {
		id,
		projectId: scope.projectId,
		sourceId: snapshot.sourceId,
		snapshotId: snapshot.id,
		claimType,
		value,
		quote,
		locator,
		extractionVersion,
		confidence,
		status,
		supersededBy,
		snapshotCapturedAt: snapshot.capturedAt,
		createdAt: now,
	};
}

// --- reading claims ---------------------------------------------------------------

export async function getClaim(
	db: D1Database,
	scope: Scope,
	claimId: string,
): Promise<ClaimRecord> {
	await assertProjectScope(db, scope);
	if (typeof claimId !== 'string' || claimId.length === 0) {
		fail(400, 'invalid_request', 'claimId is required');
	}
	const rows = await queryAll(
		db,
		`select ${CLAIM_COLUMNS} from "evidence_claims" where "id" = ? and "projectId" = ?`,
		claimId,
		scope.projectId,
	);
	if (!rows[0]) fail(404, 'claim_not_found', 'no such evidence claim in this project');
	return claimFromRow(rows[0]!);
}

export interface ClaimFilter {
	claimType?: string;
	sourceId?: string;
	status?: ClaimStatus;
}

/** List the project's claims, newest reading first; history included. */
export async function listClaims(
	db: D1Database,
	scope: Scope,
	filter: ClaimFilter = {},
): Promise<ClaimRecord[]> {
	await assertProjectScope(db, scope);
	const conditions = ['"projectId" = ?'];
	const params: unknown[] = [scope.projectId];
	if (filter.claimType !== undefined) {
		conditions.push('"claimType" = ?');
		params.push(filter.claimType);
	}
	if (filter.sourceId !== undefined) {
		conditions.push('"sourceId" = ?');
		params.push(filter.sourceId);
	}
	if (filter.status !== undefined) {
		conditions.push('"status" = ?');
		params.push(filter.status);
	}
	const rows = await queryAll(
		db,
		`select ${CLAIM_COLUMNS} from "evidence_claims" where ${conditions.join(' and ')} ` +
			'order by "snapshotCapturedAt" desc, "id" asc',
		...params,
	);
	return rows.map(claimFromRow);
}

/** Claims joined with source authority and snapshot provenance (inspector payload). */
export async function listClaimsWithEvidence(
	db: D1Database,
	scope: Scope,
	filter: ClaimFilter = {},
): Promise<ClaimWithEvidence[]> {
	const claims = await listClaims(db, scope, filter);
	const out: ClaimWithEvidence[] = [];
	for (const claim of claims) {
		const sourceRows = await queryAll(
			db,
			'select "authority", "canonicalUrl" from "evidence_sources" where "id" = ? and "projectId" = ?',
			claim.sourceId,
			scope.projectId,
		);
		const snapshotRows = await queryAll(
			db,
			'select "contentHash", "provenance" from "evidence_snapshots" where "id" = ? and "projectId" = ?',
			claim.snapshotId,
			scope.projectId,
		);
		out.push({
			...claim,
			sourceAuthority: String(sourceRows[0]?.['authority'] ?? 'unknown'),
			canonicalUrl: String(sourceRows[0]?.['canonicalUrl'] ?? ''),
			snapshotContentHash: String(snapshotRows[0]?.['contentHash'] ?? ''),
			snapshotProvenance: String(snapshotRows[0]?.['provenance'] ?? 'original'),
		});
	}
	return out;
}

// --- authority reconciliation (ported from HackSteward evidence.py) ------------------

/**
 * A claim projected for reconciliation: the reading plus what weighs it —
 * the snapshot's capture instant and the SOURCE's declared authority rank.
 * Authority is resolved through the source at projection time (declared
 * authority belongs to the source, never to the snapshot bytes).
 */
export interface ReconciliationClaim {
	readonly claimId: string;
	readonly projectId: string;
	readonly claimType: string;
	readonly value: string;
	readonly confidence: number | null;
	readonly snapshotId: string;
	readonly sourceId: string;
	readonly capturedAt: string;
	/** Lower wins; null = UNKNOWN authority (never outranks, never wins). */
	readonly authorityRank: number | null;
}

export interface ConflictRecord {
	readonly conflictId: string;
	readonly projectId: string;
	readonly claimType: string;
	readonly claimIds: readonly string[];
}

function sortForReconciliation(claims: ReconciliationClaim[]): ReconciliationClaim[] {
	return [...claims].sort((a, b) => {
		const ra = a.authorityRank ?? Number.POSITIVE_INFINITY;
		const rb = b.authorityRank ?? Number.POSITIVE_INFINITY;
		if (ra !== rb) return ra - rb;
		const ca = a.confidence ?? Number.NEGATIVE_INFINITY;
		const cb = b.confidence ?? Number.NEGATIVE_INFINITY;
		if (ca !== cb) return cb - ca;
		return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0;
	});
}

/**
 * Only each source's NEWEST readings are that source's current word
 * (HackSteward current_readings): a monitored page supersedes itself, so
 * superseded readings do not participate in conflict detection. Readings
 * whose snapshot cannot be ordered are kept rather than guessed at.
 */
export function currentReadings(claims: ReconciliationClaim[]): ReconciliationClaim[] {
	const newestBySource = new Map<string, string>();
	for (const claim of claims) {
		const current = newestBySource.get(claim.sourceId);
		if (current === undefined || claim.capturedAt > current) {
			newestBySource.set(claim.sourceId, claim.capturedAt);
		}
	}
	return claims.filter((claim) => newestBySource.get(claim.sourceId) === claim.capturedAt);
}

export interface Reconciliation {
	winner: ReconciliationClaim | null;
	conflict: ConflictRecord | null;
}

/**
 * Deterministically reconcile claims by source authority (HackSteward
 * reconcile_claims_by_authority, with the defect-#6 correction that UNKNOWN
 * authority has no rank and can never win):
 *
 *   - same-source older readings are dropped first ({@link currentReadings});
 *   - agreement — including DST/offset equivalence when `instantKey` is
 *     supplied — returns the deterministically-ordered first reading;
 *   - a STRICTLY higher authority (lower rank) wins outright; the loser is
 *     retained in storage, never deleted;
 *   - equal-authority disagreement is a RETAINED CONFLICT, never auto-resolved;
 *   - disagreement among unrankable (UNKNOWN) claims is likewise retained.
 *
 * When `instantKey` yields a key for EVERY claim in the group, agreement is
 * decided on the pinned instant rather than the quoted text: two pages
 * stating "2026-08-31T20:00:00-04:00" and "2026-09-01T00:00:00Z" agree
 * instead of conflicting. One unpinnable reading falls the whole group back
 * to text comparison — a fact and a guess are not the same value.
 */
export async function reconcileClaimsByAuthority(
	allClaims: ReconciliationClaim[],
	instantKey?: (claim: ReconciliationClaim) => string | null,
): Promise<Reconciliation> {
	const claims = sortForReconciliation(currentReadings(allClaims));
	if (claims.length === 0) return { winner: null, conflict: null };
	if (claims.length === 1) return { winner: claims[0]!, conflict: null };

	let distinctValues: Set<string>;
	if (instantKey) {
		const keys = claims.map(instantKey);
		distinctValues =
			keys.every((k) => k !== null)
				? new Set(keys as string[])
				: new Set(claims.map((c) => c.value));
	} else {
		distinctValues = new Set(claims.map((c) => c.value));
	}
	if (distinctValues.size === 1) {
		return { winner: claims[0]!, conflict: null };
	}

	const best = claims[0]!;
	const second = claims[1]!;
	const bestRank = best.authorityRank ?? Number.POSITIVE_INFINITY;
	const secondRank = second.authorityRank ?? Number.POSITIVE_INFINITY;
	if (bestRank < secondRank) {
		// Strictly higher authority outranks; the loser stays on record.
		return { winner: best, conflict: null };
	}

	// Equal-rank (or unrankable) contradiction -> retained conflict with a
	// deterministic id derived from exactly the conflicting set.
	const conflictId = await deriveEvidenceId(
		'conflict',
		best.projectId,
		best.claimType,
		...claims.map((c) => c.claimId).sort(),
	);
	return {
		winner: null,
		conflict: {
			conflictId,
			projectId: best.projectId,
			claimType: best.claimType,
			claimIds: claims.map((c) => c.claimId),
		},
	};
}

/**
 * Project the stored claims (optionally by type) into reconciliation inputs,
 * resolving each snapshot's authority through its SOURCE. Blank/off-vocabulary
 * authorities project as UNKNOWN (rank null) — never as verified weight.
 */
export async function projectForReconciliation(
	db: D1Database,
	scope: Scope,
	claimType?: string,
): Promise<ReconciliationClaim[]> {
	await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select c."id" as claimId, c."projectId", c."claimType", c."value", c."confidence", ' +
			'c."snapshotId", s."sourceId", s."capturedAt", src."authority" as authority ' +
			'from "evidence_claims" c ' +
			'join "evidence_snapshots" s on s."id" = c."snapshotId" and s."projectId" = c."projectId" ' +
			'join "evidence_sources" src on src."id" = s."sourceId" and src."projectId" = c."projectId" ' +
			'where c."projectId" = ?' +
			(claimType !== undefined ? ' and c."claimType" = ?' : ''),
		...(claimType !== undefined ? [scope.projectId, claimType] : [scope.projectId]),
	);
	return rows.map((row) => {
		const authority = String(row['authority'] ?? 'unknown');
		return {
			claimId: String(row['claimId']),
			projectId: String(row['projectId']),
			claimType: String(row['claimType']),
			value: String(row['value']),
			confidence: row['confidence'] == null ? null : Number(row['confidence']),
			snapshotId: String(row['snapshotId']),
			sourceId: String(row['sourceId']),
			capturedAt: String(row['capturedAt']),
			authorityRank: isSourceAuthority(authority) ? authorityRank(authority) : null,
		};
	});
}

export interface ClaimTypeSurvey {
	readonly claimType: string;
	/** The reconciled current reading, when one source outranks the rest. */
	readonly winner: ReconciliationClaim | null;
	/** The RETAINED conflict, when equal-authority readings disagree. */
	readonly conflict: ConflictRecord | null;
}

/**
 * Survey the project's claims by claim type: per type, the reconciled
 * winner and/or the retained conflict. `instantKey` (see deadlines.ts
 * {@link deadlineInstantKey}) lets equivalent instants agree.
 */
export async function surveyClaims(
	db: D1Database,
	scope: Scope,
	options: { claimType?: string; instantKey?: (claim: ReconciliationClaim) => string | null } = {},
): Promise<ClaimTypeSurvey[]> {
	const projected = await projectForReconciliation(db, scope, options.claimType);
	const byType = new Map<string, ReconciliationClaim[]>();
	for (const claim of projected) {
		const group = byType.get(claim.claimType) ?? [];
		group.push(claim);
		byType.set(claim.claimType, group);
	}
	const surveys: ClaimTypeSurvey[] = [];
	for (const [claimType, group] of [...byType.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		const result = await reconcileClaimsByAuthority(group, options.instantKey);
		surveys.push({ claimType, winner: result.winner, conflict: result.conflict });
	}
	return surveys;
}
