import type { D1Database } from './auth.ts';
import type { Scope } from '@caddie/contracts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { authorityRank, isSourceAuthority } from './evidence/authority.ts';
import { deadlineInstantKey } from './evidence/deadlines.ts';
import type { SourceRecord } from './evidence/sources.ts';
import { getSource } from './evidence/sources.ts';

/**
 * P12 slice 2 — Sentinel (feature-ledger C12, IMPROVE): re-check a source's
 * rule claims by comparing the readings of its PREVIOUS snapshot against the
 * readings of its CURRENT snapshot, entirely inside the P10 evidence store.
 * The re-fetch/capture pass that produces the new snapshot on a schedule tick
 * is P09/P17 wiring — this module makes no external calls, ever.
 *
 * Invariants (each pinned by tests/sentinel.test.ts):
 *   - Verdicts are unchanged | changed | removed | added, decided on the
 *     claim SLOT (claimType + normalized locator) — never on claim ids, which
 *     embed the snapshot id in P10 and would turn every re-read into noise.
 *   - Cosmetic suppression: whitespace/case-only differences in a value,
 *     quote or locator are UNCHANGED. Equivalent instants written with
 *     different offsets/spellings are UNCHANGED (the deadlines.ts
 *     same-instant rule — the pinned fact is identical, the wording is not).
 *   - Severity rides the SOURCE's declared authority at check time:
 *     rules-tier sources (rank 1: binding_rules, organizer_message,
 *     official_faq) are material; every other authority is informational; a
 *     run with nothing to report is severity 'none'.
 *   - Old AND new evidence ids (and quotes) are retained on every diff,
 *     including unchanged ones — a verdict is always traceable to evidence.
 *   - Every run appends a sentinel_results row; rows are never updated or
 *     deleted by any path here.
 *   - EXPLICIT project/source ids only: the scoped entry derives the project
 *     from the verified scope; the system entry (cron tick — no session)
 *     takes explicit projectId/sourceId and validates both against D1. There
 *     is no "active project" fallback anywhere.
 */

// --- diff types ------------------------------------------------------------------

export type SentinelVerdict = 'unchanged' | 'changed' | 'removed' | 'added';

export interface ClaimLite {
	readonly id: string;
	readonly claimType: string;
	readonly value: string;
	readonly quote: string;
	readonly locator: string | null;
}

export interface ClaimDiff {
	readonly verdict: SentinelVerdict;
	readonly claimType: string;
	readonly locator: string | null;
	readonly oldValue: string | null;
	readonly newValue: string | null;
	/** Old/new EVIDENCE ids — both present when a claim survived the re-read. */
	readonly oldClaimId: string | null;
	readonly newClaimId: string | null;
	readonly oldQuote: string | null;
	readonly newQuote: string | null;
}

export type SentinelSeverity = 'material' | 'informational' | 'none';

export interface SentinelResultRecord {
	readonly id: string;
	readonly projectId: string;
	readonly sourceId: string;
	readonly scheduleId: string | null;
	readonly previousSnapshotId: string;
	readonly currentSnapshotId: string;
	readonly severity: SentinelSeverity;
	readonly changedCount: number;
	readonly changes: readonly ClaimDiff[];
	readonly createdAt: string;
}

// --- normalization ------------------------------------------------------------------

/**
 * Cosmetic normalization: case-folded, whitespace-collapsed. Two claims whose
 * normalized values (or quotes, or locators) agree differ only in surface
 * formatting — noise, never a rule change.
 */
export function normalizeClaimText(text: string): string {
	return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Cosmetic equality for any claim text (value, quote, locator). */
export function cosmeticallyEqual(a: string, b: string): boolean {
	return normalizeClaimText(a) === normalizeClaimText(b);
}

/**
 * Claim-value equality with the P10 instant rule: equal normalized text OR
 * two pin-able ISO instants denoting the same moment are EQUAL —
 * "2026-09-10T00:00Z" and "2026-09-10T00:00:00Z" are the same deadline fact.
 */
function claimValueEquals(a: string, b: string): boolean {
	if (cosmeticallyEqual(a, b)) return true;
	const keyA = deadlineInstantKey(a);
	const keyB = deadlineInstantKey(b);
	return keyA !== null && keyB !== null && keyA === keyB;
}

/** The diff slot of a claim: same slot = the same place making a claim. */
function slotKey(c: ClaimLite): string {
	return `${normalizeClaimText(c.claimType)}|${normalizeClaimText(c.locator ?? '')}`;
}

/**
 * Compare the old snapshot's claims against the new snapshot's claims.
 * Deterministic: sorted by slot key, ties by claim id. Unchanged pairs keep
 * both evidence ids; a claim only in the old set is REMOVED; only in the new
 * set is ADDED; same slot with a materially different value is CHANGED.
 */
export function compareClaimSets(oldClaims: ClaimLite[], newClaims: ClaimLite[]): ClaimDiff[] {
	const bySlot = (claims: ClaimLite[]): Map<string, ClaimLite> => {
		const map = new Map<string, ClaimLite>();
		for (const c of [...claims].sort((a, b) => (a.id < b.id ? -1 : 1))) {
			if (!map.has(slotKey(c))) map.set(slotKey(c), c);
		}
		return map;
	};
	const oldBySlot = bySlot(oldClaims);
	const newBySlot = bySlot(newClaims);
	const slots = [...new Set([...oldBySlot.keys(), ...newBySlot.keys()])].sort();
	const diffs: ClaimDiff[] = [];
	for (const slot of slots) {
		const oldClaim = oldBySlot.get(slot);
		const newClaim = newBySlot.get(slot);
		if (oldClaim && newClaim) {
			const unchanged = claimValueEquals(oldClaim.value, newClaim.value);
			diffs.push({
				verdict: unchanged ? 'unchanged' : 'changed',
				claimType: newClaim.claimType,
				locator: newClaim.locator ?? oldClaim.locator,
				oldValue: oldClaim.value,
				newValue: newClaim.value,
				oldClaimId: oldClaim.id,
				newClaimId: newClaim.id,
				oldQuote: oldClaim.quote,
				newQuote: newClaim.quote,
			});
		} else if (oldClaim) {
			diffs.push({
				verdict: 'removed',
				claimType: oldClaim.claimType,
				locator: oldClaim.locator,
				oldValue: oldClaim.value,
				newValue: null,
				oldClaimId: oldClaim.id,
				newClaimId: null,
				oldQuote: oldClaim.quote,
				newQuote: null,
			});
		} else if (newClaim) {
			diffs.push({
				verdict: 'added',
				claimType: newClaim.claimType,
				locator: newClaim.locator,
				oldValue: null,
				newValue: newClaim.value,
				oldClaimId: null,
				newClaimId: newClaim.id,
				oldQuote: null,
				newQuote: newClaim.quote,
			});
		}
	}
	return diffs;
}

/** Severity: material under rules-tier authority, informational otherwise, none when silent. */
function severityFor(source: SourceRecord, changedCount: number): SentinelSeverity {
	if (changedCount === 0) return 'none';
	const rank = isSourceAuthority(source.authority) ? authorityRank(source.authority) : null;
	return rank === 1 ? 'material' : 'informational';
}

// --- storage helpers ---------------------------------------------------------------

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

function claimLiteFromRow(row: Record<string, unknown>): ClaimLite {
	return {
		id: String(row['id']),
		claimType: String(row['claimType']),
		value: String(row['value']),
		quote: String(row['quote']),
		locator: row['locator'] == null ? null : String(row['locator']),
	};
}

/**
 * The check core over already-validated records. `source` MUST belong to
 * `projectId` (both entries validate that before calling); snapshots and
 * claims are read with projectId leading every query.
 */
async function checkSource(
	db: D1Database,
	projectId: string,
	source: SourceRecord,
	options: { scheduleId?: string; currentSnapshotId?: string },
): Promise<{ result: SentinelResultRecord; diffs: ClaimDiff[] }> {
	// The CURRENT snapshot: explicitly pinned, or the source's head observation.
	let current: Record<string, unknown> | undefined;
	if (options.currentSnapshotId !== undefined) {
		const rows = await queryAll(
			db,
			'select * from "evidence_snapshots" where "id" = ? and "projectId" = ? and "sourceId" = ?',
			options.currentSnapshotId,
			projectId,
			source.id,
		);
		current = rows[0];
		if (!current) {
			fail(404, 'snapshot_not_found', 'no such snapshot for this source in this project');
		}
	} else if (source.latestSnapshotId) {
		const rows = await queryAll(
			db,
			'select * from "evidence_snapshots" where "id" = ? and "projectId" = ?',
			source.latestSnapshotId,
			projectId,
		);
		current = rows[0];
	}
	if (!current) {
		fail(400, 'no_snapshot', 'this source has no snapshot to check — nothing to compare');
	}
	const currentId = String(current!['id']);
	const capturedAt = String(current!['capturedAt']);

	// The PREVIOUS snapshot: the newest observation strictly before the current
	// one. With a single snapshot the source is compared against itself — a
	// first observation reports no change (there is nothing else it could
	// honestly report).
	const previousRows = await queryAll(
		db,
		'select * from "evidence_snapshots" where "projectId" = ? and "sourceId" = ? and "capturedAt" < ? ' +
			'order by "capturedAt" desc, "id" desc limit 1',
		projectId,
		source.id,
		capturedAt,
	);
	const previousId = previousRows[0] ? String(previousRows[0]['id']) : currentId;

	// ALL claim statuses participate: supersession is cross-snapshot
	// bookkeeping, and the diff must see exactly what each snapshot said.
	const oldRows = await queryAll(
		db,
		'select * from "evidence_claims" where "projectId" = ? and "snapshotId" = ? order by "id" asc',
		projectId,
		previousId,
	);
	const newRows = await queryAll(
		db,
		'select * from "evidence_claims" where "projectId" = ? and "snapshotId" = ? order by "id" asc',
		projectId,
		currentId,
	);
	const diffs = compareClaimSets(oldRows.map(claimLiteFromRow), newRows.map(claimLiteFromRow));
	const changedCount = diffs.filter((d) => d.verdict !== 'unchanged').length;
	const severity = severityFor(source, changedCount);

	const id = `sen_${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	await db
		.prepare(
			'insert into "sentinel_results" ' +
				'("id","projectId","sourceId","scheduleId","previousSnapshotId","currentSnapshotId","severity","changedCount","changes","createdAt") ' +
				'values (?,?,?,?,?,?,?,?,?,?)',
		)
		.bind(
			id,
			projectId,
			source.id,
			options.scheduleId ?? null,
			previousId,
			currentId,
			severity,
			changedCount,
			JSON.stringify(diffs),
			now,
		)
		.run();

	return {
		result: {
			id,
			projectId,
			sourceId: source.id,
			scheduleId: options.scheduleId ?? null,
			previousSnapshotId: previousId,
			currentSnapshotId: currentId,
			severity,
			changedCount,
			changes: diffs,
			createdAt: now,
		},
		diffs,
	};
}

// --- entries -------------------------------------------------------------------------

export interface SentinelCheckOptions {
	/** Set when the check was triggered by a schedule (recorded on the row). */
	scheduleId?: string;
	/** Pin the CURRENT side of the comparison instead of the source's head. */
	currentSnapshotId?: string;
}

/**
 * Session-scoped entry: re-verify the scope, resolve the source INSIDE the
 * verified project (a foreign source id 404s — it does not leak existence),
 * then compare the source's snapshots.
 */
export async function runSentinelCheck(
	db: D1Database,
	scope: Scope,
	sourceId: string,
	options: SentinelCheckOptions = {},
): Promise<{ result: SentinelResultRecord; diffs: ClaimDiff[] }> {
	const verified = await assertProjectScope(db, scope);
	if (typeof sourceId !== 'string' || sourceId.length === 0) {
		fail(400, 'invalid_request', 'sourceId is required');
	}
	const source = await getSource(db, scope, sourceId);
	return checkSource(db, verified.projectId, source, options);
}

export interface SentinelCheckRef {
	/** EXPLICIT — the schedule's stored projectId, never "active". */
	projectId: string;
	/** EXPLICIT — the source the schedule watches. */
	sourceId: string;
	scheduleId?: string;
}

/**
 * System-level entry for the cron/dispatch path (no session exists on a tick).
 * Both ids are explicit arguments validated against D1: an unknown project or
 * a source outside that project is a typed 404. This is the same trust
 * boundary as the future P09/P17 timer — stored ids are the only targeting.
 */
export async function runSentinelCheckForSchedule(
	db: D1Database,
	ref: SentinelCheckRef,
	options: Omit<SentinelCheckOptions, 'scheduleId'> = {},
): Promise<{ result: SentinelResultRecord; diffs: ClaimDiff[] }> {
	if (typeof ref.projectId !== 'string' || ref.projectId.length === 0) {
		fail(400, 'invalid_request', 'projectId is required');
	}
	if (typeof ref.sourceId !== 'string' || ref.sourceId.length === 0) {
		fail(400, 'invalid_request', 'sourceId is required');
	}
	const projectRows = await queryAll(db, 'select "id" from "projects" where "id" = ?', ref.projectId);
	if (!projectRows[0]) fail(404, 'project_not_found', 'no such project');
	const sourceRows = await queryAll(
		db,
		'select * from "evidence_sources" where "id" = ? and "projectId" = ?',
		ref.sourceId,
		ref.projectId,
	);
	if (!sourceRows[0]) {
		fail(404, 'source_not_found', 'no such evidence source in this project');
	}
	const authority = String(sourceRows[0]['authority']);
	if (!isSourceAuthority(authority)) {
		fail(500, 'invalid_row', 'evidence source row carries an authority outside the shared vocabulary');
	}
	return checkSource(
		db,
		ref.projectId,
		{
			id: String(sourceRows[0]['id']),
			projectId: String(sourceRows[0]['projectId']),
			canonicalUrl: String(sourceRows[0]['canonicalUrl']),
			kind: String(sourceRows[0]['kind']) as SourceRecord['kind'],
			authority,
			displayName: sourceRows[0]['displayName'] == null ? null : String(sourceRows[0]['displayName']),
			latestSnapshotId:
				sourceRows[0]['latestSnapshotId'] == null ? null : String(sourceRows[0]['latestSnapshotId']),
			latestContentHash:
				sourceRows[0]['latestContentHash'] == null ? null : String(sourceRows[0]['latestContentHash']),
			lastOutcome: String(sourceRows[0]['lastOutcome']),
			lastFailureReason:
				sourceRows[0]['lastFailureReason'] == null ? null : String(sourceRows[0]['lastFailureReason']),
			observedAt: sourceRows[0]['observedAt'] == null ? null : String(sourceRows[0]['observedAt']),
			attemptedAt: sourceRows[0]['attemptedAt'] == null ? null : String(sourceRows[0]['attemptedAt']),
			createdAt: String(sourceRows[0]['createdAt']),
			updatedAt: String(sourceRows[0]['updatedAt']),
		},
		{ ...options, scheduleId: ref.scheduleId },
	);
}

/** A project's sentinel history for one (or all) sources, newest run first. */
export async function listSentinelResults(
	db: D1Database,
	scope: Scope,
	sourceId?: string,
): Promise<SentinelResultRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = sourceId !== undefined
		? await queryAll(
				db,
				'select * from "sentinel_results" where "projectId" = ? and "sourceId" = ? order by "createdAt" desc, "id" asc',
				verified.projectId,
				sourceId,
			)
		: await queryAll(
				db,
				'select * from "sentinel_results" where "projectId" = ? order by "createdAt" desc, "id" asc',
				verified.projectId,
			);
	return rows.map((row) => {
		let changes: ClaimDiff[] = [];
		try {
			const parsed: unknown = JSON.parse(String(row['changes']));
			if (Array.isArray(parsed)) changes = parsed as ClaimDiff[];
		} catch {
			fail(500, 'invalid_row', 'sentinel row carries an unparseable changes payload');
		}
		return {
			id: String(row['id']),
			projectId: String(row['projectId']),
			sourceId: String(row['sourceId']),
			scheduleId: row['scheduleId'] == null ? null : String(row['scheduleId']),
			previousSnapshotId: String(row['previousSnapshotId']),
			currentSnapshotId: String(row['currentSnapshotId']),
			severity: String(row['severity']) as SentinelSeverity,
			changedCount: Number(row['changedCount']),
			changes,
			createdAt: String(row['createdAt']),
		};
	});
}
