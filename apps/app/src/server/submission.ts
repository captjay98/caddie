import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { deriveEvidenceId, sha256Hex } from './evidence/identity.ts';
import {
	listClaims,
	surveyClaims,
	type ClaimRecord,
	type ReconciliationClaim,
} from './evidence/claims.ts';
import { matchesRequirement } from './judge.ts';

/**
 * P13 slice 2 — submission package (feature-ledger C16 + H11/H12, REBUILD of
 * the carryover submission_preparation.py / browser_handoff.py): a submission
 * package is derived ONLY from this project's cited requirement claims, and
 * the final external submission stays a HUMAN action that we merely record.
 *
 * Invariants (pinned by tests/judge.test.ts + tests/submission.test.ts):
 *   - Requirements version is a deterministic hash over the project's ACTIVE
 *     'submission.*' claims — a new or superseded rule moves it, unrelated
 *     claims do not, and another project's rules never do. A later rule
 *     change therefore invalidates a previously exported package's readiness.
 *   - The package title is the PROJECT title — never a contest/opportunity
 *     title assumption.
 *   - Checklist rows derive ONLY from cited claims (claimId + quote +
 *     canonical url). No claim, no row: an empty evidence record yields an
 *     EMPTY checklist — no universal video duration, public repo, or license
 *     assumption travels.
 *   - Missing fields stay missing: without a matching passed receipt or
 *     declared claim, an item's status is 'missing'. Unresolvable
 *     equal-authority rule conflicts surface as 'conflict' items, never a
 *     silent pick.
 *   - Reuse disclosure needs a HUMAN: a package requiring reuse disclosure
 *     cannot be exported until a session-derived actor confirms it.
 *   - The confirmed external submission is recorded in its OWN table
 *     (submission_confirmations), tied to the exact export hash — "prepared"
 *     and "confirmed submitted" can never blur, and nothing here submits.
 *
 * Every service takes its Scope as a MANDATORY parameter and re-verifies it
 * against D1 at entry (P02 pattern); every query leads with projectId.
 */

// --- requirements version ---------------------------------------------------------

/**
 * Deterministic requirements version over the project's active submission
 * rules: `reqver-<sha256 prefix>`. Adding/superseding a 'submission.*' claim
 * changes it; unrelated claims do not; it is project-scoped end to end.
 */
export async function computeRequirementsVersion(db: D1Database, scope: Scope): Promise<string> {
	await assertProjectScope(db, scope);
	const rows = await db
		.prepare(
			'select "id", "claimType", "value", "quote" from "evidence_claims" ' +
				'where "projectId" = ? and "status" = \'active\' and "claimType" like \'submission.%\' ' +
				'order by "claimType" asc, "id" asc',
		)
		.bind(scope.projectId)
		.all();
	const claims = ((rows.results ?? []) as Record<string, unknown>[]).map((row) => ({
		id: String(row['id']),
		claimType: String(row['claimType']),
		value: String(row['value']),
		quote: String(row['quote']),
	}));
	const payload = JSON.stringify({ projectId: scope.projectId, claims });
	return `reqver-${(await sha256Hex(payload)).slice(0, 32)}`;
}

// --- records -----------------------------------------------------------------------

export type ChecklistKind =
	| 'video'
	| 'repository'
	| 'license'
	| 'description'
	| 'host_proof'
	| 'reuse_disclosure'
	| 'other';

export type ChecklistStatus = 'missing' | 'declared' | 'verified' | 'conflict';

export interface SubmissionPackageRecord {
	readonly id: string;
	readonly projectId: string;
	/** The PROJECT title — never a contest title assumption. */
	readonly title: string;
	readonly description: {
		readonly summary: string | null;
		readonly requirements: readonly {
			readonly kind: ChecklistKind;
			readonly requirementText: string;
			readonly citation: ChecklistCitation;
		}[];
		readonly generatedFrom: string;
	};
	readonly reuseRequired: boolean;
	readonly reuseState: 'unconfirmed' | 'confirmed';
	readonly reuseConfirmedBy: string | null;
	readonly reuseConfirmedAt: string | null;
	readonly requirementsVersion: string;
	readonly createdBy: string;
	readonly createdAt: string;
}

export interface ChecklistCitation {
	readonly claimId: string;
	readonly quote: string;
	readonly url: string;
}

export interface ChecklistItemRecord {
	readonly id: string;
	readonly packageId: string;
	readonly projectId: string;
	readonly kind: ChecklistKind;
	readonly requirementText: string;
	readonly citation: ChecklistCitation;
	readonly status: ChecklistStatus;
	readonly evidence: readonly {
		readonly refId: string;
		readonly basis: 'receipt' | 'claim';
	}[];
	readonly createdAt: string;
}

export interface SubmissionExportRecord {
	readonly id: string;
	readonly packageId: string;
	readonly projectId: string;
	readonly exportHash: string;
	readonly requirementsVersion: string;
	readonly packageJson: string;
	readonly createdBy: string;
	readonly createdAt: string;
}

export interface SubmissionConfirmationRecord {
	readonly id: string;
	readonly projectId: string;
	readonly exportId: string;
	readonly exportHash: string;
	readonly attestations: readonly string[];
	readonly note: string | null;
	readonly confirmedBy: string;
	readonly confirmedAt: string;
}

export type ReadinessStatus = 'no_export' | 'stale' | 'blocked' | 'ready';

export interface ReadinessRecord {
	readonly status: ReadinessStatus;
	readonly currentRequirementsVersion: string;
	readonly latestExport: SubmissionExportRecord | null;
	readonly reasons: readonly string[];
}

// --- helpers -------------------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

function requireBool(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') fail(400, 'invalid_input', `${field} must be a boolean`);
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

/** The submission rule kind a claimType maps to; unknown rule types stay honest ('other'). */
function kindForClaimType(claimType: string): ChecklistKind {
	if (claimType === 'submission.video') return 'video';
	if (claimType === 'submission.repository') return 'repository';
	if (claimType === 'submission.license') return 'license';
	if (claimType === 'submission.description') return 'description';
	if (claimType === 'submission.host') return 'host_proof';
	if (claimType === 'submission.reuse') return 'reuse_disclosure';
	return 'other';
}

async function canonicalUrlFor(db: D1Database, scope: Scope, sourceId: string): Promise<string> {
	const rows = await queryAll(
		db,
		'select "canonicalUrl" from "evidence_sources" where "id" = ? and "projectId" = ?',
		sourceId,
		scope.projectId,
	);
	return String(rows[0]?.['canonicalUrl'] ?? '');
}

async function getClaimRow(db: D1Database, scope: Scope, claimId: string): Promise<ClaimRecord> {
	const rows = await queryAll(
		db,
		'select "id", "projectId", "sourceId", "snapshotId", "claimType", "value", "quote", "locator", ' +
			'"extractionVersion", "confidence", "status", "supersededBy", "snapshotCapturedAt", "createdAt" ' +
			'from "evidence_claims" where "id" = ? and "projectId" = ?',
		claimId,
		scope.projectId,
	);
	if (!rows[0]) fail(404, 'claim_not_found', 'no such evidence claim in this project');
	return {
		id: String(rows[0]!['id']),
		projectId: String(rows[0]!['projectId']),
		sourceId: String(rows[0]!['sourceId']),
		snapshotId: String(rows[0]!['snapshotId']),
		claimType: String(rows[0]!['claimType']),
		value: String(rows[0]!['value']),
		quote: String(rows[0]!['quote']),
		locator: rows[0]!['locator'] == null ? null : String(rows[0]!['locator']),
		extractionVersion: String(rows[0]!['extractionVersion']),
		confidence: rows[0]!['confidence'] == null ? null : Number(rows[0]!['confidence']),
		status: String(rows[0]!['status']) as ClaimRecord['status'],
		supersededBy: rows[0]!['supersededBy'] == null ? null : String(rows[0]!['supersededBy']),
		snapshotCapturedAt: String(rows[0]!['snapshotCapturedAt']),
		createdAt: String(rows[0]!['createdAt']),
	};
}

interface CitedRule {
	readonly claimType: string;
	readonly kind: ChecklistKind;
	readonly requirementText: string;
	readonly citation: ChecklistCitation;
	readonly conflict: boolean;
}

/**
 * The project's cited submission rules: per 'submission.*' claim type, the
 * reconciled current reading (winner) or the retained conflict — every rule
 * keeps its exact claim citation. No claim type on record, no rule.
 */
async function citedRules(db: D1Database, scope: Scope): Promise<CitedRule[]> {
	const surveys = await surveyClaims(db, scope);
	const rules: CitedRule[] = [];
	for (const survey of surveys) {
		if (!survey.claimType.startsWith('submission.')) continue;
		const kind = kindForClaimType(survey.claimType);
		if (survey.winner) {
			const claim = await getClaimRow(db, scope, survey.winner.claimId);
			rules.push({
				claimType: survey.claimType,
				kind,
				requirementText: claim.value,
				citation: {
					claimId: claim.id,
					quote: claim.quote,
					url: await canonicalUrlFor(db, scope, claim.sourceId),
				},
				conflict: false,
			});
		}
		if (survey.conflict) {
			// Equal-authority disagreement: surfaced, not silently resolved.
			const firstId = survey.conflict.claimIds[0] ?? '';
			const claim = firstId ? await getClaimRow(db, scope, firstId) : null;
			rules.push({
				claimType: survey.claimType,
				kind,
				requirementText: `CONFLICTING RULES on record for ${survey.claimType} — resolve against the cited sources before submitting`,
				citation: {
					claimId: firstId,
					quote: claim?.quote ?? '',
					url: claim ? await canonicalUrlFor(db, scope, claim.sourceId) : '',
				},
				conflict: true,
			});
		}
	}
	return rules.sort((a, b) => (a.claimType < b.claimType ? -1 : a.claimType > b.claimType ? 1 : 0));
}

/** Passed run receipts: the only 'verified' basis for a checklist item. */
async function passedReceipts(db: D1Database, scope: Scope): Promise<{ id: string; text: string }[]> {
	const rows = await queryAll(
		db,
		'select "id", "check", "evidence" from "run_verifications" where "projectId" = ? and "passed" = 1',
		scope.projectId,
	);
	return rows.map((row) => ({
		id: String(row['id']),
		text: `${String(row['check'])} ${String(row['evidence'])}`,
	}));
}

function buildDescription(
	summary: string | null,
	rules: readonly CitedRule[],
): SubmissionPackageRecord['description'] {
	return {
		summary,
		requirements: rules.map((rule) => ({
			kind: rule.kind,
			requirementText: rule.requirementText,
			citation: rule.citation,
		})),
		generatedFrom:
			'This description is generated ONLY from the cited requirement claims on record. Anything the contest requires that is not evidenced here is omitted, not invented.',
	};
}

// --- packages ---------------------------------------------------------------------

export interface PackageCreateInput {
	/** Whether submitting requires disclosing reused/scaffolded work. */
	reuseRequired: boolean;
}

/**
 * Create (or return the existing) submission package for the project. The
 * title is the PROJECT's own title from the projects row; the description is
 * generated only from cited rules; reuse disclosure starts 'unconfirmed'.
 */
export async function createSubmissionPackage(
	db: D1Database,
	scope: Scope,
	input: PackageCreateInput,
): Promise<SubmissionPackageRecord> {
	await assertProjectScope(db, scope);
	const reuseRequired = requireBool(input.reuseRequired, 'reuseRequired');
	const projectRows = await queryAll(
		db,
		'select "name", "description" from "projects" where "id" = ?',
		scope.projectId,
	);
	if (!projectRows[0]) fail(404, 'project_not_found', 'no such project');
	const title = String(projectRows[0]!['name']);
	const summary = projectRows[0]!['description'] == null ? null : String(projectRows[0]!['description']);

	const existing = await queryAll(
		db,
		'select * from "submission_packages" where "projectId" = ? order by "createdAt" asc, "id" asc',
		scope.projectId,
	);
	if (existing[0]) return packageFromRow(scope, existing[0]!);

	const id = `subpkg_${crypto.randomUUID()}`;
	const requirementsVersion = await computeRequirementsVersion(db, scope);
	const rules = await citedRules(db, scope);
	const createdAt = nowIso();
	await db
		.prepare(
			'insert into "submission_packages" ' +
				'("id", "projectId", "title", "descriptionJson", "reuseRequired", "reuseState", "requirementsVersion", "createdBy", "createdAt") ' +
				'values (?, ?, ?, ?, ?, \'unconfirmed\', ?, ?, ?)',
		)
		.bind(
			id,
			scope.projectId,
			title,
			JSON.stringify(buildDescription(summary, rules)),
			reuseRequired ? 1 : 0,
			requirementsVersion,
			scope.actorId,
			createdAt,
		)
		.run();
	return {
		id,
		projectId: scope.projectId,
		title,
		description: buildDescription(summary, rules),
		reuseRequired,
		reuseState: 'unconfirmed',
		reuseConfirmedBy: null,
		reuseConfirmedAt: null,
		requirementsVersion,
		createdBy: scope.actorId,
		createdAt,
	};
}

function packageFromRow(scope: Scope, row: Record<string, unknown>): SubmissionPackageRecord {
	let description: SubmissionPackageRecord['description'];
	try {
		description = JSON.parse(String(row['descriptionJson'])) as SubmissionPackageRecord['description'];
	} catch {
		fail(500, 'invalid_row', `package ${String(row['id'])} carries an unparseable description`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		title: String(row['title']),
		description,
		reuseRequired: Number(row['reuseRequired']) === 1,
		reuseState: String(row['reuseState']) as SubmissionPackageRecord['reuseState'],
		reuseConfirmedBy: row['reuseConfirmedBy'] == null ? null : String(row['reuseConfirmedBy']),
		reuseConfirmedAt: row['reuseConfirmedAt'] == null ? null : String(row['reuseConfirmedAt']),
		requirementsVersion: String(row['requirementsVersion']),
		createdBy: String(row['createdBy']),
		createdAt: String(row['createdAt']),
	};
}

async function getPackageRow(db: D1Database, scope: Scope, packageId: string): Promise<Record<string, unknown>> {
	if (typeof packageId !== 'string' || packageId.length === 0) {
		fail(400, 'invalid_request', 'packageId is required');
	}
	const rows = await queryAll(
		db,
		'select * from "submission_packages" where "id" = ? and "projectId" = ?',
		packageId,
		scope.projectId,
	);
	if (!rows[0]) fail(404, 'package_not_found', 'no such submission package in this project');
	return rows[0]!;
}

export async function getPackage(
	db: D1Database,
	scope: Scope,
	packageId: string,
): Promise<{
	package: SubmissionPackageRecord;
	checklist: readonly ChecklistItemRecord[];
	exports: readonly SubmissionExportRecord[];
	confirmations: readonly SubmissionConfirmationRecord[];
	readiness: ReadinessRecord;
}> {
	await assertProjectScope(db, scope);
	const row = await getPackageRow(db, scope, packageId);
	return {
		package: packageFromRow(scope, row),
		checklist: await listChecklist(db, scope, packageId),
		exports: await listExports(db, scope, packageId),
		confirmations: await listConfirmations(db, scope, packageId),
		readiness: await getReadiness(db, scope, packageId),
	};
}

export async function listPackages(db: D1Database, scope: Scope): Promise<SubmissionPackageRecord[]> {
	await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "submission_packages" where "projectId" = ? order by "createdAt" desc, "id" asc',
		scope.projectId,
	);
	return rows.map((row) => packageFromRow(scope, row));
}

// --- checklist ----------------------------------------------------------------------

async function listChecklist(db: D1Database, scope: Scope, packageId: string): Promise<ChecklistItemRecord[]> {
	const rows = await queryAll(
		db,
		'select * from "submission_checklist_items" where "packageId" = ? and "projectId" = ? order by "kind" asc, "id" asc',
		packageId,
		scope.projectId,
	);
	return rows.map((row) => {
		let evidence: ChecklistItemRecord['evidence'];
		try {
			evidence = JSON.parse(String(row['evidenceJson'] ?? '[]')) as ChecklistItemRecord['evidence'];
		} catch {
			fail(500, 'invalid_row', `checklist item ${String(row['id'])} carries unparseable evidence JSON`);
		}
		return {
			id: String(row['id']),
			packageId: String(row['packageId']),
			projectId: String(row['projectId']),
			kind: String(row['kind']) as ChecklistKind,
			requirementText: String(row['requirementText']),
			citation: {
				claimId: String(row['citationClaimId']),
				quote: String(row['citationQuote']),
				url: String(row['citationUrl']),
			},
			status: String(row['status']) as ChecklistStatus,
			evidence,
			createdAt: String(row['createdAt']),
		};
	});
}

/**
 * Derive the package checklist from the project's cited submission rules
 * (P10 authority reconciliation). Idempotent: the same rule reading maps to
 * the same row, whose status is refreshed from receipts/claims. With no
 * submission claims on record the checklist is EMPTY — missing stays missing.
 *
 * Status derivation (honest, deterministic):
 *   'conflict' — equal-authority rules disagree;
 *   'verified' — a PASSED run receipt matches the requirement;
 *   'declared' — an active 'evidence.delivered' claim matches it;
 *   'missing'  — nothing on record satisfies it (the default).
 */
export async function buildChecklist(
	db: D1Database,
	scope: Scope,
	packageId: string,
): Promise<ChecklistItemRecord[]> {
	await assertProjectScope(db, scope);
	await getPackageRow(db, scope, packageId);
	const rules = await citedRules(db, scope);
	const receipts = await passedReceipts(db, scope);
	const delivered = await listClaims(db, scope, { claimType: 'evidence.delivered', status: 'active' });
	const createdAt = nowIso();

	for (const rule of rules) {
		const matchedReceipts = receipts
			.filter((receipt) => matchesRequirement(receipt.text, rule.requirementText))
			.map((receipt) => ({ refId: receipt.id, basis: 'receipt' as const }));
		const matchedClaims = delivered
			.filter((claim) => matchesRequirement(`${claim.value} ${claim.quote}`, rule.requirementText))
			.map((claim) => ({ refId: claim.id, basis: 'claim' as const }));
		const status: ChecklistStatus = rule.conflict
			? 'conflict'
			: matchedReceipts.length > 0
				? 'verified'
				: matchedClaims.length > 0
					? 'declared'
					: 'missing';
		const evidence = [...matchedReceipts, ...matchedClaims];
		const id = await deriveEvidenceId(
			'subchk',
			scope.projectId,
			packageId,
			rule.claimType,
			rule.conflict ? `conflict:${rule.citation.claimId}` : rule.citation.claimId,
		);
		await db
			.prepare(
				'insert into "submission_checklist_items" ' +
					'("id", "packageId", "projectId", "kind", "requirementText", "citationClaimId", "citationQuote", "citationUrl", "status", "evidenceJson", "createdAt") ' +
					'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'on conflict("id") do update set "status" = excluded."status", "evidenceJson" = excluded."evidenceJson"',
			)
			.bind(
				id,
				packageId,
				scope.projectId,
				rule.kind,
				rule.requirementText,
				rule.citation.claimId,
				rule.citation.quote,
				rule.citation.url,
				status,
				JSON.stringify(evidence),
				createdAt,
			)
			.run();
	}
	return listChecklist(db, scope, packageId);
}

// --- reuse confirmation (human gate) -----------------------------------------------------

/**
 * The HUMAN reuse-disclosure confirmation. The actor comes from the verified
 * session-derived scope; there is no service path that confirms reuse
 * without one. Idempotent once confirmed.
 */
export async function confirmReuse(db: D1Database, scope: Scope, packageId: string): Promise<SubmissionPackageRecord> {
	await assertProjectScope(db, scope);
	const row = await getPackageRow(db, scope, packageId);
	const record = packageFromRow(scope, row);
	if (record.reuseState === 'confirmed') return record;
	await db
		.prepare(
			'update "submission_packages" set "reuseState" = \'confirmed\', "reuseConfirmedBy" = ?, "reuseConfirmedAt" = ? ' +
				'where "id" = ? and "projectId" = ? and "reuseState" = \'unconfirmed\'',
		)
		.bind(scope.actorId, nowIso(), packageId, scope.projectId)
		.run();
	const updated = await getPackageRow(db, scope, packageId);
	return packageFromRow(scope, updated);
}

// --- exports --------------------------------------------------------------------------------

async function listExports(db: D1Database, scope: Scope, packageId: string): Promise<SubmissionExportRecord[]> {
	const rows = await queryAll(
		db,
		'select * from "submission_exports" where "packageId" = ? and "projectId" = ? order by "createdAt" desc, "id" asc',
		packageId,
		scope.projectId,
	);
	return rows.map((row) => ({
		id: String(row['id']),
		packageId: String(row['packageId']),
		projectId: String(row['projectId']),
		exportHash: String(row['exportHash']),
		requirementsVersion: String(row['requirementsVersion']),
		packageJson: String(row['packageJson']),
		createdBy: String(row['createdBy']),
		createdAt: String(row['createdAt']),
	}));
}

async function listConfirmations(
	db: D1Database,
	scope: Scope,
	packageId: string,
): Promise<SubmissionConfirmationRecord[]> {
	const rows = await queryAll(
		db,
		'select c.* from "submission_confirmations" c join "submission_exports" e on e."id" = c."exportId" ' +
			'where e."packageId" = ? and c."projectId" = ? order by c."confirmedAt" desc, c."id" asc',
		packageId,
		scope.projectId,
	);
	return rows.map((row) => ({
		id: String(row['id']),
		projectId: String(row['projectId']),
		exportId: String(row['exportId']),
		exportHash: String(row['exportHash']),
		attestations: JSON.parse(String(row['attestationsJson'] ?? '[]')) as string[],
		note: row['note'] == null ? null : String(row['note']),
		confirmedBy: String(row['confirmedBy']),
		confirmedAt: String(row['confirmedAt']),
	}));
}

/**
 * Export the package as a copyable snapshot: title (project title), cited
 * requirements with checklist state, reuse disclosure state. Records the
 * export content hash and the requirements version it was prepared against.
 * A package whose reuse disclosure is required but unconfirmed CANNOT be
 * exported — the human gate comes first.
 */
export async function exportPackage(
	db: D1Database,
	scope: Scope,
	packageId: string,
): Promise<SubmissionExportRecord> {
	await assertProjectScope(db, scope);
	const record = packageFromRow(scope, await getPackageRow(db, scope, packageId));
	if (record.reuseRequired && record.reuseState !== 'confirmed') {
		fail(
			409,
			'reuse_unconfirmed',
			'this package requires a reuse disclosure and the human confirmation has not been given — export is blocked',
		);
	}
	const checklist = await listChecklist(db, scope, packageId);
	const packageJson = JSON.stringify({
		title: record.title,
		description: record.description,
		requirements: checklist.map((item) => ({
			kind: item.kind,
			requirementText: item.requirementText,
			status: item.status,
			citation: item.citation,
			evidence: item.evidence,
		})),
		reuse: {
			required: record.reuseRequired,
			state: record.reuseState,
			confirmedBy: record.reuseConfirmedBy,
			confirmedAt: record.reuseConfirmedAt,
		},
		projectId: record.projectId,
		exportedAt: nowIso(),
	});
	const exportHash = `sha256-${await sha256Hex(packageJson)}`;
	const requirementsVersion = await computeRequirementsVersion(db, scope);
	const id = `subexp_${crypto.randomUUID()}`;
	const createdAt = nowIso();
	await db
		.prepare(
			'insert into "submission_exports" ' +
				'("id", "packageId", "projectId", "exportHash", "requirementsVersion", "packageJson", "createdBy", "createdAt") ' +
				'values (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(id, packageId, scope.projectId, exportHash, requirementsVersion, packageJson, scope.actorId, createdAt)
		.run();
	return {
		id,
		packageId,
		projectId: scope.projectId,
		exportHash,
		requirementsVersion,
		packageJson,
		createdBy: scope.actorId,
		createdAt,
	};
}

// --- readiness + human submission record --------------------------------------------------------

/**
 * Readiness of a package for submission, honestly derived:
 *   no_export — nothing exported yet;
 *   stale     — the rules changed after the latest export (version mismatch):
 *               a later rule change INVALIDATES readiness;
 *   blocked   — export is current but checklist gaps (missing/conflict items)
 *               or an unconfirmed reuse disclosure remain;
 *   ready     — current export, every cited requirement satisfied or resolved,
 *               reuse disclosure confirmed. This is still only "prepared".
 */
export async function getReadiness(db: D1Database, scope: Scope, packageId: string): Promise<ReadinessRecord> {
	await assertProjectScope(db, scope);
	await getPackageRow(db, scope, packageId);
	const currentVersion = await computeRequirementsVersion(db, scope);
	const exports = await listExports(db, scope, packageId);
	const latest = exports[0] ?? null;
	if (!latest) {
		return { status: 'no_export', currentRequirementsVersion: currentVersion, latestExport: null, reasons: ['nothing has been exported yet'] };
	}
	const reasons: string[] = [];
	if (latest.requirementsVersion !== currentVersion) {
		reasons.push('submission rules changed after this export — re-derive the checklist and export again');
		return { status: 'stale', currentRequirementsVersion: currentVersion, latestExport: latest, reasons };
	}
	const checklist = await listChecklist(db, scope, packageId);
	for (const item of checklist) {
		if (item.status === 'missing') reasons.push(`${item.kind}: requirement still missing — ${item.requirementText}`);
		if (item.status === 'conflict') reasons.push(`${item.kind}: conflicting rules on record need human resolution`);
	}
	const record = packageFromRow(scope, await getPackageRow(db, scope, packageId));
	if (record.reuseRequired && record.reuseState !== 'confirmed') {
		reasons.push('reuse disclosure has not been confirmed by a human');
	}
	return {
		status: reasons.length === 0 ? 'ready' : 'blocked',
		currentRequirementsVersion: currentVersion,
		latestExport: latest,
		reasons,
	};
}

export interface ConfirmationInput {
	exportId: string;
	/** The human's own attestations (e.g. "I submitted this to <contest>"). */
	attestations: readonly string[];
	note?: string | null;
}

/**
 * RECORD the human's confirmation that they submitted the package externally.
 * Deliberately a separate table from packages/exports: "prepared" and
 * "confirmed submitted" can never blur, and nothing here performs the
 * external submission — that stays a human action, attested here.
 */
export async function recordConfirmation(
	db: D1Database,
	scope: Scope,
	input: ConfirmationInput,
): Promise<SubmissionConfirmationRecord> {
	await assertProjectScope(db, scope);
	if (typeof input.exportId !== 'string' || input.exportId.length === 0) {
		fail(400, 'invalid_request', 'exportId is required');
	}
	const exportRows = await queryAll(
		db,
		'select * from "submission_exports" where "id" = ? and "projectId" = ?',
		input.exportId,
		scope.projectId,
	);
	if (!exportRows[0]) fail(404, 'export_not_found', 'no such submission export in this project');
	const exportRow = exportRows[0]!;
	if (!Array.isArray(input.attestations) || input.attestations.length === 0) {
		fail(400, 'invalid_input', 'attestations must be a non-empty array of non-empty strings');
	}
	const attestations = input.attestations.map((attestation) => {
		if (typeof attestation !== 'string' || attestation.trim().length === 0) {
			fail(400, 'invalid_input', 'attestations must be a non-empty array of non-empty strings');
		}
		return attestation.trim();
	});
	const note = optionalString(input.note, 'note');
	const id = `subcnf_${crypto.randomUUID()}`;
	const confirmedAt = nowIso();
	await db
		.prepare(
			'insert into "submission_confirmations" ' +
				'("id", "projectId", "exportId", "exportHash", "attestationsJson", "note", "confirmedBy", "confirmedAt") ' +
				'values (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(
			id,
			scope.projectId,
			input.exportId,
			String(exportRow['exportHash']),
			JSON.stringify(attestations),
			note,
			scope.actorId,
			confirmedAt,
		)
		.run();
	return {
		id,
		projectId: scope.projectId,
		exportId: input.exportId,
		exportHash: String(exportRow['exportHash']),
		attestations,
		note,
		confirmedBy: scope.actorId,
		confirmedAt,
	};
}

// Re-export for route/fixture convenience.
export type { ReconciliationClaim };
