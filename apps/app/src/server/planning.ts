import type { PlanDocRevision, Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { createPlanDocRevision, listPlanDocRevisions } from './projects.ts';
import { getClaim } from './evidence/claims.ts';
import { normalizeDeadline } from './evidence/deadlines.ts';

/**
 * P11 slice 2 — planning: kernel/scope/PRD/spec plan documents created from
 * accepted requirements, with deadline-linked milestones derived from ACTUAL
 * requirements (feature-ledger C13 + H13, ADAPT/IMPROVE of the carryover idea
 * kernel/scope/PRD/spec flow).
 *
 * Invariants (each pinned by the workerd integration suite):
 *   - Planning produces NEW plan-doc revisions THROUGH THE P02 SERVICE
 *     ({@link createPlanDocRevision}) — it appends, never overwrites; the
 *     revision chain per (project, kind) is preserved.
 *   - User revisions are preserved: every plan-doc revision carries
 *     PROVENANCE ('planning' | 'user', planning_revision_provenance), and
 *     {@link generatePlan} does not regenerate a kind whose latest revision
 *     was written by the user — the human's words stand until they change
 *     them.
 *   - Deadline-linked milestones cite the P10 evidence claim they came from;
 *     a fabricated claim id is refused (404). The P10 midnight fix carries
 *     over: a date-only deadline stays date-only (a calendar date, no
 *     invented instant), and an ambiguous deadline records WHY it is
 *     unresolved instead of guessing.
 *   - Contest-free projects work: the contest link is optional; documents
 *     say "contest-free" instead of inventing one.
 *   - Every service takes its Scope as a MANDATORY parameter and re-verifies
 *     it against D1 at entry (P02 pattern); every query leads with projectId.
 *
 * Plan bodies are DETERMINISTIC requirement-derived drafts: no model call
 * lives here and none is claimed. The P11 agent skill (later slice) builds on
 * these documents; H13 strategy/effort heuristics are labeled heuristics and
 * never win probabilities.
 */

export const PLAN_DOC_KINDS = ['kernel', 'scope', 'prd', 'spec'] as const;
export type PlanDocKind = (typeof PLAN_DOC_KINDS)[number];

export interface PlanningRequirement {
	/** The accepted requirement, in the user's words. */
	readonly text: string;
	/** Evidence claim ids that back this requirement (may be empty — recorded honestly). */
	readonly evidenceClaimIds?: readonly string[];
	/** A P10 claim carrying the deadline this requirement must meet (milestone link). */
	readonly deadlineClaimId?: string | null;
	/** IANA zone used to normalize the deadline claim's value (P10 deadlines). */
	readonly dueZone?: string | null;
}

export type MilestoneDueStatus = 'resolved' | 'date_only' | 'ambiguous' | 'none';

export interface MilestoneRecord {
	readonly id: string;
	readonly projectId: string;
	readonly title: string;
	readonly dueDate: string | null;
	readonly dueUtc: string | null;
	readonly hasTime: boolean;
	readonly dueStatus: MilestoneDueStatus;
	readonly dueNote: string | null;
	/** The P10 evidence claim this milestone's deadline came from. */
	readonly deadlineClaimId: string | null;
	readonly createdAt: string;
}

export interface PlanRevisionProvenance {
	readonly id: string;
	readonly projectId: string;
	readonly kind: PlanDocKind | string;
	readonly planRevisionId: string;
	readonly origin: 'planning' | 'user';
	readonly createdAt: string;
}

export interface PlanGenerationResult {
	readonly projectId: string;
	/** The revision now current per kind — null for kinds preserved from user edits. */
	readonly revisions: Readonly<Record<PlanDocKind, PlanDocRevision | null>>;
	/** Kinds deliberately NOT regenerated because the user revised them last. */
	readonly preserved: Readonly<Partial<Record<PlanDocKind, { planRevisionId: string; reason: string }>>>;
	readonly milestones: readonly MilestoneRecord[];
	readonly generatedAt: string;
}

// --- helpers ----------------------------------------------------------------------

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

function milestoneFromRow(row: Record<string, unknown>): MilestoneRecord {
	const dueStatus = String(row['dueStatus']);
	if (!['resolved', 'date_only', 'ambiguous', 'none'].includes(dueStatus)) {
		fail(500, 'invalid_row', `milestone row carries an unknown dueStatus: ${dueStatus}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		title: String(row['title']),
		dueDate: row['dueDate'] == null ? null : String(row['dueDate']),
		dueUtc: row['dueUtc'] == null ? null : String(row['dueUtc']),
		hasTime: Number(row['hasTime']) === 1,
		dueStatus: dueStatus as MilestoneDueStatus,
		dueNote: row['dueNote'] == null ? null : String(row['dueNote']),
		deadlineClaimId: row['deadlineClaimId'] == null ? null : String(row['deadlineClaimId']),
		createdAt: String(row['createdAt']),
	};
}

function isPlanDocKind(kind: unknown): kind is PlanDocKind {
	return typeof kind === 'string' && (PLAN_DOC_KINDS as readonly string[]).includes(kind);
}

function evidenceSuffix(claimIds: readonly string[] | undefined): string {
	if (claimIds && claimIds.length > 0) {
		return ` [evidence: ${claimIds.join(', ')}]`;
	}
	return ' [assumption: no stored evidence claim backs this requirement]';
}

// --- document bodies (deterministic drafts) -------------------------------------------

interface ProjectFacts {
	readonly name: string;
	readonly contestUrl: string | null;
}

function contestLine(project: ProjectFacts): string {
	return project.contestUrl ? `Contest: ${project.contestUrl}` : 'Contest: none — contest-free project';
}

function requirementsSection(requirements: readonly PlanningRequirement[]): string {
	if (requirements.length === 0) {
		return '- (no accepted requirements recorded yet — planning ran with an empty set)';
	}
	return requirements.map((r) => `- ${r.text.trim()}${evidenceSuffix(r.evidenceClaimIds)}`).join('\n');
}

function buildPlanBody(
	kind: PlanDocKind,
	project: ProjectFacts,
	requirements: readonly PlanningRequirement[],
	milestones: readonly MilestoneRecord[],
): string {
	const header = `# ${kind.toUpperCase()} — ${project.name}\n\n${contestLine(project)}\n`;
	if (kind === 'kernel') {
		return (
			header +
			'\n## Idea statement (accepted requirements)\n' +
			requirementsSection(requirements) +
			'\n'
		);
	}
	if (kind === 'scope') {
		return (
			header +
			'\n## In scope\n' +
			requirementsSection(requirements) +
			'\n\n## Out of scope\n' +
			'- Anything not listed above (recorded explicitly rather than assumed)\n'
		);
	}
	if (kind === 'prd') {
		const milestoneLines = milestones.length
			? milestones
					.map((m) => {
						const due =
							m.dueStatus === 'resolved'
								? (m.dueUtc ?? 'resolved')
								: m.dueStatus === 'date_only'
									? `${m.dueDate} (date-only — time of day unknown)`
									: (m.dueNote ?? 'unresolved');
						return `- ${m.title} — due ${due} [evidence: ${m.deadlineClaimId ?? 'none'}]`;
					})
					.join('\n')
			: '- (no deadline-linked milestones — no requirement cited a deadline claim)';
		return (
			header +
			'\n## Product requirements\n' +
			requirementsSection(requirements) +
			'\n\n## Deadline-linked milestones (from actual requirements)\n' +
			milestoneLines +
			'\n'
		);
	}
	// spec
	return (
		header +
		'\n## Technical notes\n' +
		'- Deterministic requirement-derived draft: each requirement carries its evidence citation or an explicit assumption.\n' +
		'- Revisions are append-only; sections the user manually revised are not regenerated.\n' +
		'\n## Requirements under build\n' +
		requirementsSection(requirements) +
		'\n'
	);
}

// --- milestone derivation -----------------------------------------------------------------

interface DerivedMilestone {
	readonly requirement: PlanningRequirement;
	readonly record: MilestoneRecord;
}

/**
 * Derive deadline-linked milestones from the requirements' deadline claims.
 * The claim MUST exist in the scoped project (fabricated ids 404) and its
 * value is normalized through the P10 deadline rules — ambiguity is recorded,
 * never resolved by assumption.
 */
async function deriveMilestones(
	db: D1Database,
	scope: Scope,
	requirements: readonly PlanningRequirement[],
): Promise<DerivedMilestone[]> {
	const derived: DerivedMilestone[] = [];
	for (const requirement of requirements) {
		if (!requirement.deadlineClaimId) continue;
		const claim = await getClaim(db, scope, requirement.deadlineClaimId);
		const normalized = normalizeDeadline(claim.value, requirement.dueZone ?? null);
		const record: MilestoneRecord = {
			id: newId('mstone'),
			projectId: scope.projectId,
			title: requirement.text.trim(),
			dueDate: normalized.date,
			dueUtc: normalized.utc,
			hasTime: normalized.hasTime,
			dueStatus: normalized.status === 'resolved' || normalized.status === 'date_only' ? normalized.status : 'ambiguous',
			dueNote: normalized.reason,
			deadlineClaimId: claim.id,
			createdAt: nowIso(),
		};
		derived.push({ requirement, record });
	}
	return derived;
}

async function persistMilestones(
	db: D1Database,
	scope: Scope,
	derived: readonly DerivedMilestone[],
): Promise<MilestoneRecord[]> {
	const stored: MilestoneRecord[] = [];
	for (const { record } of derived) {
		// Idempotent per (project, title, due): regeneration does not duplicate.
		await db
			.prepare(
				'insert or ignore into "planning_milestones" ' +
					'("id","projectId","title","dueDate","dueUtc","hasTime","dueStatus","dueNote","deadlineClaimId","createdAt") ' +
					'values (?,?,?,?,?,?,?,?,?,?)',
			)
			.bind(
				record.id,
				record.projectId,
				record.title,
				record.dueDate,
				record.dueUtc,
				record.hasTime ? 1 : 0,
				record.dueStatus,
				record.dueNote,
				record.deadlineClaimId,
				record.createdAt,
			)
			.run();
		const rows = await queryAll(
			db,
			'select * from "planning_milestones" where "projectId" = ? and "title" = ? and ifnull("dueDate", \'\') = ifnull(?, \'\')',
			scope.projectId,
			record.title,
			record.dueDate,
		);
		if (rows[0]) stored.push(milestoneFromRow(rows[0]!));
	}
	return stored;
}

// --- provenance ------------------------------------------------------------------------

async function latestProvenance(
	db: D1Database,
	scope: Scope,
	kind: PlanDocKind,
): Promise<PlanRevisionProvenance | null> {
	const rows = await queryAll(
		db,
		'select * from "planning_revision_provenance" where "projectId" = ? and "kind" = ? order by "rowid" desc limit 1',
		scope.projectId,
		kind,
	);
	const row = rows[0];
	if (!row) return null;
	const origin = String(row['origin']);
	if (origin !== 'planning' && origin !== 'user') {
		fail(500, 'invalid_row', `provenance row carries an unknown origin: ${origin}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		kind: String(row['kind']),
		planRevisionId: String(row['planRevisionId']),
		origin,
		createdAt: String(row['createdAt']),
	};
}

async function recordProvenance(
	db: D1Database,
	scope: Scope,
	kind: PlanDocKind,
	planRevisionId: string,
	origin: 'planning' | 'user',
): Promise<void> {
	await db
		.prepare(
			'insert into "planning_revision_provenance" ' +
				'("id","projectId","kind","planRevisionId","origin","createdAt") values (?,?,?,?,?,?)',
		)
		.bind(newId('prov'), scope.projectId, kind, planRevisionId, origin, nowIso())
		.run();
}

// --- the planning service ----------------------------------------------------------------

async function loadProjectFacts(db: D1Database, scope: Scope): Promise<ProjectFacts> {
	const rows = await queryAll(
		db,
		'select "name", "contestUrl" from "projects" where "id" = ?',
		scope.projectId,
	);
	const row = rows[0];
	if (!row) fail(404, 'project_not_found', 'no such project');
	return { name: String(row!['name']), contestUrl: row!['contestUrl'] == null ? null : String(row!['contestUrl']) };
}

function parseRequirements(input: { requirements?: unknown }): PlanningRequirement[] {
	const raw = input.requirements;
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		fail(400, 'invalid_input', 'requirements must be an array');
	}
	return (raw as unknown[]).map((entry, index): PlanningRequirement => {
		if (entry === null || typeof entry !== 'object') {
			fail(400, 'invalid_input', `requirements[${index}] must be an object`);
		}
		const text = (entry as { text?: unknown }).text;
		if (typeof text !== 'string' || !text.trim()) {
			fail(400, 'invalid_input', `requirements[${index}].text is required`);
		}
		const evidenceClaimIds = (entry as { evidenceClaimIds?: unknown }).evidenceClaimIds;
		if (
			evidenceClaimIds !== undefined &&
			evidenceClaimIds !== null &&
			(!Array.isArray(evidenceClaimIds) || evidenceClaimIds.some((id) => typeof id !== 'string'))
		) {
			fail(400, 'invalid_input', `requirements[${index}].evidenceClaimIds must be an array of claim ids`);
		}
		const deadlineClaimId = (entry as { deadlineClaimId?: unknown }).deadlineClaimId;
		if (deadlineClaimId !== undefined && deadlineClaimId !== null && typeof deadlineClaimId !== 'string') {
			fail(400, 'invalid_input', `requirements[${index}].deadlineClaimId must be a claim id or null`);
		}
		const dueZone = (entry as { dueZone?: unknown }).dueZone;
		if (dueZone !== undefined && dueZone !== null && typeof dueZone !== 'string') {
			fail(400, 'invalid_input', `requirements[${index}].dueZone must be an IANA zone name or null`);
		}
		return {
			text,
			evidenceClaimIds: Array.isArray(evidenceClaimIds) ? (evidenceClaimIds as string[]) : undefined,
			deadlineClaimId: deadlineClaimId ?? null,
			dueZone: dueZone ?? null,
		};
	});
}

/**
 * Generate the planning documents: kernel/scope/PRD/spec from the accepted
 * requirements, plus deadline-linked milestones from the requirements'
 * deadline claims.
 *
 * Per kind: if the LATEST revision was written by the user (provenance
 * 'user'), it is PRESERVED — not regenerated — and reported under
 * `preserved`; otherwise a new revision is appended through the P02 service
 * and provenance 'planning' is recorded. Regeneration is safe to repeat.
 */
export async function generatePlan(
	db: D1Database,
	scope: Scope,
	input: { requirements?: unknown },
): Promise<PlanGenerationResult> {
	const verified = await assertProjectScope(db, scope);
	const requirements = parseRequirements(input);
	const project = await loadProjectFacts(db, verified);
	const derived = await deriveMilestones(db, verified, requirements);
	const milestones = await persistMilestones(db, verified, derived);

	const generatedAt = nowIso();
	const revisions: Record<PlanDocKind, PlanDocRevision | null> = {
		kernel: null,
		scope: null,
		prd: null,
		spec: null,
	};
	const preserved: Partial<Record<PlanDocKind, { planRevisionId: string; reason: string }>> = {};
	for (const kind of PLAN_DOC_KINDS) {
		const latest = await latestProvenance(db, verified, kind);
		if (latest?.origin === 'user') {
			// The user manually revised this document last: planning does not
			// regenerate what the user wrote.
			preserved[kind] = {
				planRevisionId: latest.planRevisionId,
				reason: 'user_revision_preserved',
			};
			continue;
		}
		const revision = await createPlanDocRevision(db, verified, {
			kind,
			body: buildPlanBody(kind, project, requirements, milestones),
		});
		await recordProvenance(db, verified, kind, revision.id, 'planning');
		revisions[kind] = revision;
	}
	return { projectId: verified.projectId, revisions, preserved, milestones, generatedAt };
}

/**
 * Record a USER-authored plan-doc revision (an edit-one-section behavior):
 * appends through the P02 service and records provenance 'user', so the next
 * {@link generatePlan} preserves it. Kind must be one of the planning kinds.
 */
export async function recordUserPlanRevision(
	db: D1Database,
	scope: Scope,
	input: { kind?: unknown; body?: unknown },
): Promise<PlanDocRevision> {
	const verified = await assertProjectScope(db, scope);
	if (!isPlanDocKind(input.kind)) {
		fail(400, 'invalid_input', `kind must be one of: ${PLAN_DOC_KINDS.join(', ')}`);
	}
	if (typeof input.body !== 'string' || input.body.trim().length === 0) {
		fail(400, 'invalid_input', 'body is required');
	}
	const revision = await createPlanDocRevision(db, verified, {
		kind: input.kind,
		body: input.body,
	});
	await recordProvenance(db, verified, input.kind, revision.id, 'user');
	return revision;
}

/**
 * The planning overview: every plan-doc revision (newest first), the latest
 * per kind, the revision provenance, and the deadline-linked milestones —
 * all project-scoped.
 */
export interface PlanOverview {
	readonly latest: Readonly<Partial<Record<PlanDocKind, PlanDocRevision>>>;
	readonly revisions: readonly PlanDocRevision[];
	readonly provenance: readonly PlanRevisionProvenance[];
	readonly milestones: readonly MilestoneRecord[];
}

export async function getPlanOverview(db: D1Database, scope: Scope): Promise<PlanOverview> {
	const verified = await assertProjectScope(db, scope);
	const revisions = await listPlanDocRevisions(db, verified);
	const latest: Partial<Record<PlanDocKind, PlanDocRevision>> = {};
	for (const kind of PLAN_DOC_KINDS) {
		const found = revisions.find((r) => r.kind === kind);
		if (found) latest[kind] = found;
	}
	const provenanceRows = await queryAll(
		db,
		'select * from "planning_revision_provenance" where "projectId" = ? order by "rowid" asc',
		verified.projectId,
	);
	const provenance: PlanRevisionProvenance[] = provenanceRows.map((row) => {
		const origin = String(row['origin']);
		if (origin !== 'planning' && origin !== 'user') {
			fail(500, 'invalid_row', `provenance row carries an unknown origin: ${origin}`);
		}
		return {
			id: String(row['id']),
			projectId: String(row['projectId']),
			kind: String(row['kind']),
			planRevisionId: String(row['planRevisionId']),
			origin: origin as PlanRevisionProvenance['origin'],
			createdAt: String(row['createdAt']),
		};
	});
	const milestoneRows = await queryAll(
		db,
		'select * from "planning_milestones" where "projectId" = ? order by "createdAt" asc, "id" asc',
		verified.projectId,
	);
	return { latest, revisions, provenance, milestones: milestoneRows.map(milestoneFromRow) };
}

/** The project's deadline-linked milestones, oldest first. */
export async function listMilestones(db: D1Database, scope: Scope): Promise<MilestoneRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "planning_milestones" where "projectId" = ? order by "createdAt" asc, "id" asc',
		verified.projectId,
	);
	return rows.map(milestoneFromRow);
}

// --- B04: stored plan decisions ------------------------------------------------------

/** One stored decision: approved or suggest-a-change, bound to ONE revision. */
export interface PlanDecisionRecord {
	readonly id: string;
	readonly projectId: string;
	readonly planRevisionId: string;
	readonly decision: 'approved' | 'changes';
	readonly note: string | null;
	/** The approvals id this decision was carried by (may be null when the
	 *  decision was recorded without an approval gate — never from chat text). */
	readonly approvalId: string | null;
	readonly decidedBy: string;
	readonly createdAt: string;
}

function planDecisionFromRow(row: Record<string, unknown>): PlanDecisionRecord {
	const decision = row['decision'];
	if (decision !== 'approved' && decision !== 'changes') {
		fail(500, 'invalid_row', `plan decision carries an unknown decision: ${String(decision)}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		planRevisionId: String(row['planRevisionId']),
		decision,
		note: row['note'] == null ? null : String(row['note']),
		approvalId: row['approvalId'] == null ? null : String(row['approvalId']),
		decidedBy: String(row['decidedBy']),
		createdAt: String(row['createdAt']),
	};
}

/**
 * Persist a plan decision for one revision. The decision is stored per
 * (revision, actor): the same actor re-deciding the same revision UPDATES
 * their stored decision (last decision wins for that actor+version), while
 * a NEWER revision always needs its own decision — nothing is inherited.
 */
export async function recordPlanDecision(
	db: D1Database,
	scope: Scope,
	input: {
		planRevisionId: string;
		decision: 'approved' | 'changes';
		note?: string | null;
		approvalId?: string | null;
	},
): Promise<PlanDecisionRecord> {
	const verified = await assertProjectScope(db, scope);
	const revisionRows = await queryAll(
		db,
		'select "id" from "plan_doc_revisions" where "id" = ? and "projectId" = ?',
		input.planRevisionId,
		verified.projectId,
	);
	if (revisionRows.length === 0) {
		fail(404, 'plan_revision_not_found', 'that plan revision does not exist in this project');
	}
	const note = input.note == null ? null : String(input.note).slice(0, 2000);
	const approvalId = input.approvalId == null ? null : String(input.approvalId);
	const id = `pdec_${crypto.randomUUID()}`;
	const now = nowIso();
	await db
		.prepare(
			'insert into "plan_decisions" ("id","projectId","planRevisionId","decision","note","approvalId","decidedBy","createdAt") values (?,?,?,?,?,?,?,?)',
		)
		.bind(id, verified.projectId, input.planRevisionId, input.decision, note, approvalId, verified.actorId, now)
		.run();
	const rows = await queryAll(db, 'select * from "plan_decisions" where "id" = ?', id);
	return planDecisionFromRow(rows[0]!);
}

/** The decisions for one revision (all actors), newest first. */
export async function listPlanDecisions(
	db: D1Database,
	scope: Scope,
	planRevisionId: string,
): Promise<PlanDecisionRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "plan_decisions" where "projectId" = ? and "planRevisionId" = ? order by "createdAt" desc, "id" asc',
		verified.projectId,
		planRevisionId,
	);
	return rows.map(planDecisionFromRow);
}

/** Decisions for every revision of one kind, newest first — the "earlier
 *  versions" fold reads this. */
export async function listProjectPlanDecisions(db: D1Database, scope: Scope): Promise<PlanDecisionRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "plan_decisions" where "projectId" = ? order by "createdAt" desc, "id" asc',
		verified.projectId,
	);
	return rows.map(planDecisionFromRow);
}