import * as v from 'valibot';
import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

/**
 * P14 living builder memory (feature-ledger H10) — personal and
 * project-scoped memory facts over D1.
 *
 * AUTHORIZATION SURFACE: NONE. Memory informs what the agent SAYS (context
 * about preferences, facts and corrections); it must never change what the
 * agent is ALLOWED to do. This module therefore exports only typed data
 * functions over D1 — no capability, scope, policy or executor type exists
 * here, no function returns an authorization decision, and the input schemas
 * are strict objects that reject any smuggled authorization field. Effects
 * are authorized exclusively by the P02 scope system (scope.ts), which this
 * module does not import for enforcement — it performs its own membership
 * checks only to decide which ROWS are visible.
 *
 * Visibility model:
 *   - Personal facts (projectId NULL) belong to their owner and are visible
 *     to that owner only.
 *   - Project-scoped facts are shared project memory: visible to members of
 *     the fact's project workspace, but only ever MUTATED (confirm, retract,
 *     correct) by the fact's owner (userId must match the session actor).
 *
 * Deletion model: there is no hard delete. "Deletion" sets status='retracted'
 * and every live read and injection path excludes retracted rows, so
 * interrupted or reversed deletions never lose history (P14 acceptance:
 * "memory deletion stops future injection").
 *
 * Correction model: an explicit user edit creates a NEW fact (kind
 * 'correction', status 'confirmed', correctsId = old id) and retracts the old
 * row. History is always retained.
 *
 * Injection model: only 'confirmed' facts are injected (proposals await user
 * confirmation; retracted facts are gone from every future injection).
 * Injection output can never contain a row outside the caller's reach: it is
 * the owner's personal facts plus confirmed facts of projects the actor is a
 * member of.
 */

const MAX_CONTENT_LENGTH = 2000;

// --- validation ------------------------------------------------------------------

const ContentSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1, 'content must not be empty'),
	v.maxLength(MAX_CONTENT_LENGTH, `content must be at most ${MAX_CONTENT_LENGTH} characters`),
);

const ProjectIdSchema = v.union([v.pipe(v.string(), v.trim(), v.minLength(1)), v.null()]);

/** User-authored fact: starts confirmed. Kinds are preference|fact — the
 * 'correction' kind is reserved for the correction service. */
export const MemoryAddInputSchema = v.strictObject({
	projectId: v.optional(ProjectIdSchema),
	kind: v.picklist(['preference', 'fact'], "kind must be 'preference' or 'fact'"),
	content: ContentSchema,
});

/** Agent-proposed fact: starts proposed; the source run id is mandatory so a
 * proposal can always be traced back to where it came from. */
export const MemoryProposalInputSchema = v.strictObject({
	projectId: v.optional(ProjectIdSchema),
	kind: v.picklist(['preference', 'fact'], "kind must be 'preference' or 'fact'"),
	content: ContentSchema,
	sourceRunId: v.pipe(v.string(), v.trim(), v.minLength(1, 'sourceRunId is required for proposals')),
});

export const MemoryCorrectionInputSchema = v.strictObject({
	content: ContentSchema,
});

export type MemoryKind = 'preference' | 'fact' | 'correction';
export type MemoryStatus = 'proposed' | 'confirmed' | 'retracted';

export interface MemoryFact {
	id: string;
	userId: string;
	projectId: string | null;
	kind: MemoryKind;
	content: string;
	status: MemoryStatus;
	sourceRunId: string | null;
	correctsId: string | null;
	createdAt: string;
	updatedAt: string;
}

// --- helpers ---------------------------------------------------------------------

function requireActorId(actorId: unknown): string {
	if (typeof actorId !== 'string' || actorId.length === 0) {
		throw new ScopeError(
			500,
			'missing_actor',
			'memory actor id is mandatory and must come from a verified session',
		);
	}
	return actorId;
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

function parseOr400<S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
	schema: S,
	input: unknown,
): v.InferOutput<S> {
	const result = v.safeParse(schema, input);
	if (!result.success) {
		const first = result.issues[0];
		const path = first?.path?.map((p) => String(p.key)).join('.') ?? '(body)';
		throw new ScopeError(
			400,
			'invalid_input',
			`invalid input at ${path}: ${first?.message ?? 'validation failed'}`,
		);
	}
	return result.output;
}

function factFromRow(row: Record<string, unknown>): MemoryFact {
	return {
		id: String(row['id']),
		userId: String(row['userId']),
		projectId: row['projectId'] == null ? null : String(row['projectId']),
		kind: String(row['kind']) as MemoryKind,
		content: String(row['content']),
		status: String(row['status']) as MemoryStatus,
		sourceRunId: row['sourceRunId'] == null ? null : String(row['sourceRunId']),
		correctsId: row['correctsId'] == null ? null : String(row['correctsId']),
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

async function queryOne(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown> | undefined> {
	return (await queryAll(db, sql, ...params))[0];
}

/**
 * Verify the actor is a member of the project's workspace. The workspace
 * binding is taken from the PROJECT ROW, never from caller input (same rule
 * as scope.ts projectScopeForUser).
 */
async function requireProjectMembership(
	db: D1Database,
	actorId: string,
	projectId: string,
): Promise<string> {
	const project = await queryOne(db, 'select "workspaceId" from "projects" where "id" = ?', projectId);
	if (!project) {
		throw new ScopeError(404, 'project_not_found', 'no such project');
	}
	const workspaceId = String(project['workspaceId']);
	const membership = await queryOne(
		db,
		'select "id" from "workspace_memberships" where "workspaceId" = ? and "userId" = ?',
		workspaceId,
		actorId,
	);
	if (!membership) {
		throw new ScopeError(403, 'not_a_member', 'actor has no membership in this project workspace');
	}
	return workspaceId;
}

async function insertFact(db: D1Database, fact: MemoryFact): Promise<void> {
	await db
		.prepare(
			`insert into "memory_facts"
				("id","userId","projectId","kind","content","status","sourceRunId","correctsId","createdAt","updatedAt")
			 values (?,?,?,?,?,?,?,?,?,?)`,
		)
		.bind(
			fact.id,
			fact.userId,
			fact.projectId,
			fact.kind,
			fact.content,
			fact.status,
			fact.sourceRunId,
			fact.correctsId,
			fact.createdAt,
			fact.updatedAt,
		)
		.run();
}

/**
 * Fetch a fact applying the VISIBILITY rules (owner for personal; membership
 * for project facts). Used by read paths; 404 when invisible.
 */
async function visibleFactOr404(
	db: D1Database,
	actorId: string,
	factId: string,
): Promise<MemoryFact> {
	if (typeof factId !== 'string' || factId.length === 0) {
		throw new ScopeError(400, 'invalid_request', 'memory fact id is required');
	}
	const row = await queryOne(db, 'select * from "memory_facts" where "id" = ?', factId);
	if (!row) {
		throw new ScopeError(404, 'memory_not_found', 'no such memory fact');
	}
	const fact = factFromRow(row);
	if (fact.projectId !== null) {
		await requireProjectMembership(db, actorId, fact.projectId);
	} else if (fact.userId !== actorId) {
		// someone else's personal fact: invisible, do not reveal existence
		throw new ScopeError(404, 'memory_not_found', 'no such memory fact');
	}
	return fact;
}

/** Owner check for MUTATIONS (stricter than visibility): only the fact's own
 * user may confirm, retract or correct it — even a fellow project member
 * cannot. A foreign personal fact reads as 404 (not revealed); a project
 * fact a non-owner member can see still reads as 403. */
async function ownedFactOrThrow(
	db: D1Database,
	actorId: string,
	factId: string,
): Promise<MemoryFact> {
	if (typeof factId !== 'string' || factId.length === 0) {
		throw new ScopeError(400, 'invalid_request', 'memory fact id is required');
	}
	const row = await queryOne(db, 'select * from "memory_facts" where "id" = ?', factId);
	if (!row) {
		throw new ScopeError(404, 'memory_not_found', 'no such memory fact');
	}
	const fact = factFromRow(row);
	if (fact.userId !== actorId) {
		if (fact.projectId === null) {
			// someone else's personal fact: do not reveal existence
			throw new ScopeError(404, 'memory_not_found', 'no such memory fact');
		}
		await requireProjectMembership(db, actorId, fact.projectId);
		throw new ScopeError(403, 'not_permitted', 'only the fact\u2019s owner can change it');
	}
	return fact;
}

// --- creation --------------------------------------------------------------------

/** Add a user-authored fact (status 'confirmed'). */
export async function addMemoryFact(
	db: D1Database,
	actorId: string,
	input: unknown,
): Promise<MemoryFact> {
	const verified = requireActorId(actorId);
	const parsed = parseOr400(MemoryAddInputSchema, input);
	if (parsed.projectId) {
		await requireProjectMembership(db, verified, parsed.projectId);
	}
	const fact: MemoryFact = {
		id: newId('mem'),
		userId: verified,
		projectId: parsed.projectId ?? null,
		kind: parsed.kind,
		content: parsed.content,
		status: 'confirmed',
		sourceRunId: null,
		correctsId: null,
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	await insertFact(db, fact);
	return fact;
}

/** Record an agent-proposed fact (status 'proposed', source run traced). */
export async function proposeMemoryFact(
	db: D1Database,
	actorId: string,
	input: unknown,
): Promise<MemoryFact> {
	const verified = requireActorId(actorId);
	const parsed = parseOr400(MemoryProposalInputSchema, input);
	if (parsed.projectId) {
		await requireProjectMembership(db, verified, parsed.projectId);
	}
	const fact: MemoryFact = {
		id: newId('mem'),
		userId: verified,
		projectId: parsed.projectId ?? null,
		kind: parsed.kind,
		content: parsed.content,
		status: 'proposed',
		sourceRunId: parsed.sourceRunId,
		correctsId: null,
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	await insertFact(db, fact);
	return fact;
}

// --- lifecycle --------------------------------------------------------------------

/** Confirm a proposed fact (proposed → confirmed). Owner-only. */
export async function confirmMemoryFact(
	db: D1Database,
	actorId: string,
	factId: string,
): Promise<MemoryFact> {
	const verified = requireActorId(actorId);
	const fact = await ownedFactOrThrow(db, verified, factId);
	if (fact.status !== 'proposed') {
		throw new ScopeError(409, 'invalid_transition', `a ${fact.status} fact cannot be confirmed`);
	}
	await db
		.prepare('update "memory_facts" set "status" = \'confirmed\', "updatedAt" = ? where "id" = ?')
		.bind(nowIso(), fact.id)
		.run();
	return { ...fact, status: 'confirmed', updatedAt: nowIso() };
}

/**
 * Retract a fact — this IS deletion: the row stays (history is never
 * destroyed) but every live read and injection path excludes it from now on.
 * Owner-only. Idempotent: retracting an already-retracted fact is a no-op.
 */
export async function retractMemoryFact(
	db: D1Database,
	actorId: string,
	factId: string,
): Promise<MemoryFact> {
	const verified = requireActorId(actorId);
	const fact = await ownedFactOrThrow(db, verified, factId);
	if (fact.status === 'retracted') return fact;
	await db
		.prepare('update "memory_facts" set "status" = \'retracted\', "updatedAt" = ? where "id" = ?')
		.bind(nowIso(), fact.id)
		.run();
	return { ...fact, status: 'retracted', updatedAt: nowIso() };
}

/**
 * Explicit correction: the user edits a fact. Creates a NEW confirmed
 * 'correction' fact pointing at the old row (correctsId) and retracts the old
 * row. Both rows are retained. Owner-only; correcting a retracted fact is
 * rejected (history is final).
 */
export async function correctMemoryFact(
	db: D1Database,
	actorId: string,
	factId: string,
	input: unknown,
): Promise<MemoryFact> {
	const verified = requireActorId(actorId);
	const parsed = parseOr400(MemoryCorrectionInputSchema, input);
	const fact = await ownedFactOrThrow(db, verified, factId);
	if (fact.status === 'retracted') {
		throw new ScopeError(409, 'invalid_transition', 'a retracted fact is history and cannot be corrected');
	}
	const corrected: MemoryFact = {
		id: newId('mem'),
		userId: verified,
		projectId: fact.projectId,
		kind: 'correction',
		content: parsed.content,
		status: 'confirmed',
		sourceRunId: null,
		correctsId: fact.id,
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	await db.batch([
		// new version first; the old row is retracted, never removed
		db
			.prepare(
				`insert into "memory_facts"
					("id","userId","projectId","kind","content","status","sourceRunId","correctsId","createdAt","updatedAt")
				 values (?,?,?,?,?,?,?,?,?,?)`,
			)
			.bind(
				corrected.id,
				corrected.userId,
				corrected.projectId,
				corrected.kind,
				corrected.content,
				corrected.status,
				corrected.sourceRunId,
				corrected.correctsId,
				corrected.createdAt,
				corrected.updatedAt,
			),
		db
			.prepare('update "memory_facts" set "status" = \'retracted\', "updatedAt" = ? where "id" = ?')
			.bind(nowIso(), fact.id),
	]);
	return corrected;
}

// --- reads ------------------------------------------------------------------------

export interface ListMemoryOptions {
	/** Omit for the caller's personal facts; pass a project id for that
	 * project's shared facts (membership required). */
	projectId?: string;
	/** Include retracted history (management view). Default: live facts only. */
	includeRetracted?: boolean;
}

/**
 * List memory facts under the caller's reach. Personal view (no projectId):
 * the caller's own personal facts. Project view: the project's shared facts
 * (any member's authorship) — membership is required and verified here.
 */
export async function listMemoryFacts(
	db: D1Database,
	actorId: string,
	options: ListMemoryOptions = {},
): Promise<MemoryFact[]> {
	const verified = requireActorId(actorId);
	const retractedClause = options.includeRetracted ? '' : ' and "status" != \'retracted\'';
	if (options.projectId) {
		await requireProjectMembership(db, verified, options.projectId);
		const rows = await queryAll(
			db,
			`select * from "memory_facts" where "projectId" = ?${retractedClause} order by "createdAt" desc, "id" desc`,
			options.projectId,
		);
		return rows.map(factFromRow);
	}
	const rows = await queryAll(
		db,
		`select * from "memory_facts" where "userId" = ? and "projectId" is null${retractedClause}
		 order by "createdAt" desc, "id" desc`,
		verified,
	);
	return rows.map(factFromRow);
}

/** Fetch one fact under the visibility rules (owner for personal, membership
 * for project facts). 404 when invisible — existence is never revealed. */
export async function getMemoryFact(
	db: D1Database,
	actorId: string,
	factId: string,
): Promise<MemoryFact> {
	const verified = requireActorId(actorId);
	return visibleFactOr404(db, verified, factId);
}

/**
 * The injection view used when building agent context: ONLY confirmed facts,
 * never proposed (they await user confirmation) and NEVER retracted (that is
 * what "deletion stops future injection" means). With a project context this
 * is the caller's personal facts plus the project's confirmed shared facts;
 * without one, just the caller's personal facts. No fact outside the caller's
 * reach can appear — personal facts filter on the caller's userId, project
 * facts require verified membership.
 */
export async function memoryForInjection(
	db: D1Database,
	actorId: string,
	projectId?: string | null,
): Promise<MemoryFact[]> {
	const verified = requireActorId(actorId);
	if (projectId) {
		await requireProjectMembership(db, verified, projectId);
		const rows = await queryAll(
			db,
			`select * from "memory_facts"
			 where "status" = 'confirmed'
			   and (("projectId" = ?) or ("projectId" is null and "userId" = ?))
			 order by "createdAt" desc, "id" desc`,
			projectId,
			verified,
		);
		return rows.map(factFromRow);
	}
	const rows = await queryAll(
		db,
		`select * from "memory_facts"
		 where "status" = 'confirmed' and "projectId" is null and "userId" = ?
		 order by "createdAt" desc, "id" desc`,
		verified,
	);
	return rows.map(factFromRow);
}
