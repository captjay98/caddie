import * as v from 'valibot';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectScope, assertWorkspaceScope } from './scope.ts';
import {
	ArtifactCreateInputSchema,
	ArtifactRevisionSchema,
	PlanDocCreateInputSchema,
	PlanDocRevisionSchema,
	ProjectCreateInputSchema,
	ProjectSchema,
	ProjectUpdateInputSchema,
	RunBindingCreateInputSchema,
	RunBindingRecordSchema,
	WorkspaceCreateInputSchema,
	WorkspaceSchema,
} from '@caddie/contracts';
import type {
	ArtifactCreateInput,
	ArtifactRevision,
	PlanDocCreateInput,
	PlanDocRevision,
	Project,
	ProjectCreateInput,
	ProjectUpdateInput,
	RunBindingCreateInput,
	RunBindingRecord,
	Workspace,
	WorkspaceCreateInput,
} from '@caddie/contracts';
import type { WorkspaceScope } from './scope.ts';

/**
 * P02 project services: workspace/membership/project/plan-doc/run-binding/
 * artifact-revision persistence over D1.
 *
 * Authorization model: every service takes its scope as a MANDATORY parameter
 * (no optional owner params — audit defect #3 class) and re-verifies it
 * against D1 at entry ({@link assertWorkspaceScope} /
 * {@link assertProjectScope}), so a fabricated or tampered scope can never
 * authorize a row. Scope itself is derived only in `scope.ts` from the
 * verified session; nothing here accepts an actor or project identity from
 * caller input.
 *
 * Isolation model (feature-ledger C9, audit defect #2): every query over
 * plan-doc revisions, run bindings and artifact revisions filters by the
 * scope's projectId — "latest" is per PROJECT, never per user, and run
 * lookups go by the STORED project of the binding, never an active-project
 * inference.
 */

// --- small helpers -------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

async function sha256Tagged(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `sha256-${hex}`;
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

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

/** Insert that maps a uniqueness violation to a typed 409 conflict. */
async function insertOrConflict(
	db: D1Database,
	conflictCode: string,
	sql: string,
	...params: unknown[]
): Promise<void> {
	try {
		await db.prepare(sql).bind(...params).run();
	} catch (error) {
		if (String(error).includes('UNIQUE constraint failed')) {
			throw new ScopeError(409, conflictCode, `conflict: ${String(error)}`);
		}
		throw error;
	}
}

function requireActorId(actorId: unknown): string {
	if (typeof actorId !== 'string' || actorId.length === 0) {
		throw new ScopeError(
			500,
			'missing_actor',
			'actor id is mandatory and must come from a verified session',
		);
	}
	return actorId;
}

// --- row -> contract mapping (strict parse at the boundary) ----------------------

function workspaceFromRow(row: Record<string, unknown>): Workspace {
	return parseOr400(WorkspaceSchema, {
		id: row['id'],
		name: row['name'],
		createdAt: row['createdAt'],
	});
}

function projectFromRow(row: Record<string, unknown>): Project {
	return parseOr400(ProjectSchema, {
		id: row['id'],
		workspaceId: row['workspaceId'],
		name: row['name'],
		description: row['description'] ?? null,
		contestId: row['contestId'] ?? null,
		contestUrl: row['contestUrl'] ?? null,
		status: row['status'],
		kind: row['kind'] ?? 'standard',
		createdAt: row['createdAt'],
		updatedAt: row['updatedAt'],
	});
}

function planDocRevisionFromRow(row: Record<string, unknown>): PlanDocRevision {
	return parseOr400(PlanDocRevisionSchema, {
		id: row['id'],
		projectId: row['projectId'],
		kind: row['kind'],
		revision: Number(row['revision']),
		bodyHash: row['bodyHash'],
		body: row['body'],
		createdBy: row['createdBy'],
		createdAt: row['createdAt'],
	});
}

function runBindingRecordFromRow(row: Record<string, unknown>): RunBindingRecord {
	return parseOr400(RunBindingRecordSchema, {
		runId: row['runId'],
		projectId: row['projectId'],
		conversationId: row['conversationId'],
		submissionId: row['submissionId'],
		planRevision: row['planRevision'],
		stackId: row['stackId'],
		payerId: row['payerId'],
		modelRouteId: row['modelRouteId'],
		pricingVersion: row['pricingVersion'],
		createdBy: row['createdBy'],
		createdAt: row['createdAt'],
	});
}

function artifactRevisionFromRow(row: Record<string, unknown>): ArtifactRevision {
	return parseOr400(ArtifactRevisionSchema, {
		id: row['id'],
		projectId: row['projectId'],
		artifactId: row['artifactId'],
		kind: row['kind'],
		revision: Number(row['revision']),
		metadataHash: row['metadataHash'],
		metadata: row['metadata'],
		createdBy: row['createdBy'],
		createdAt: row['createdAt'],
	});
}

// --- workspaces ----------------------------------------------------------------

/**
 * Create a workspace and bind the (session-verified) creator as owner. The
 * actor id always comes from the verified session at the route layer.
 */
export async function createWorkspace(
	db: D1Database,
	actorId: string,
	input: unknown,
): Promise<Workspace> {
	const verifiedActor = requireActorId(actorId);
	const parsed = parseOr400(WorkspaceCreateInputSchema, input);
	const workspace: Workspace = {
		id: newId('ws'),
		name: parsed.name,
		createdAt: nowIso(),
	};
	// Workspace + owner membership commit atomically: an orphaned workspace
	// row without its owner membership would be unreachable by anyone.
	await db.batch([
		db
			.prepare('insert into "workspaces" ("id","name","createdAt") values (?,?,?)')
			.bind(workspace.id, workspace.name, workspace.createdAt),
		db
			.prepare(
				'insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values (?,?,?,?,?)',
			)
			.bind(newId('mem'), workspace.id, verifiedActor, 'owner', workspace.createdAt),
	]);
	return workspace;
}

// --- projects --------------------------------------------------------------------

/** Create a workspace-owned project. The contest link is optional (nullable). */
export async function createProject(
	db: D1Database,
	scope: WorkspaceScope,
	input: unknown,
): Promise<Project> {
	const verified = await assertWorkspaceScope(db, scope);
	const parsed = parseOr400(ProjectCreateInputSchema, input);
	if (parsed.workspaceId !== verified.workspaceId) {
		throw new ScopeError(
			403,
			'project_out_of_scope',
			'create scope does not match the target workspace',
		);
	}
	const project: Project = {
		id: newId('proj'),
		workspaceId: verified.workspaceId,
		name: parsed.name,
		description: parsed.description ?? null,
		contestId: parsed.contestId ?? null,
		contestUrl: parsed.contestUrl ?? null,
		status: 'active',
		kind: 'standard',
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	await db
		.prepare(
			'insert into "projects" ("id","workspaceId","name","description","contestId","contestUrl","status","kind","createdAt","updatedAt") values (?,?,?,?,?,?,?,?,?,?)',
		)
		.bind(
			project.id,
			project.workspaceId,
			project.name,
			project.description,
			project.contestId,
			project.contestUrl,
			project.status,
			project.kind,
			project.createdAt,
			project.updatedAt,
		)
		.run();
	return project;
}

/**
 * The actor's Home project — the direct conversation with Caddie that exists
 * outside any build project (kind='home', one per workspace, partial unique
 * index in migration 0011). Created lazily on first use; a concurrent
 * creator loses the unique insert and re-selects. Membership mirrors
 * createProject: the actor joins the workspace if not already a member.
 */
export async function ensureHomeProject(db: D1Database, actorId: string): Promise<Project> {
	const verifiedActor = requireActorId(actorId);
	const existing = await queryAll(
		db,
		`select p.* from "projects" p
		 join "workspace_memberships" m on m."workspaceId" = p."workspaceId"
		 where m."userId" = ? and p."kind" = 'home'
		 order by p."createdAt" asc limit 1`,
		verifiedActor,
	);
	if (existing[0]) return projectFromRow(existing[0]);

	// Oldest membership's workspace is the actor's personal one; a brand-new
	// actor has none, so create it.
	let rows = await queryAll(
		db,
		'select "workspaceId" from "workspace_memberships" where "userId" = ? order by "createdAt" asc limit 1',
		verifiedActor,
	);
	let workspaceId = rows[0]?.['workspaceId'] as string | undefined;
	if (!workspaceId) {
		workspaceId = newId('ws');
		await db
			.prepare('insert into "workspaces" ("id","name","createdAt") values (?,?,?)')
			.bind(workspaceId, 'Home', nowIso())
			.run();
		await db
			.prepare('insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values (?,?,?,?,?)')
			.bind(newId('mem'), workspaceId, verifiedActor, 'owner', nowIso())
			.run();
	}

	const project: Project = {
		id: newId('proj'),
		workspaceId,
		name: 'Home',
		description: 'Your direct line to Caddie — talk without picking a project.',
		contestId: null,
		contestUrl: null,
		status: 'active',
		kind: 'home',
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	try {
		await db
			.prepare(
				'insert into "projects" ("id","workspaceId","name","description","contestId","contestUrl","status","kind","createdAt","updatedAt") values (?,?,?,?,?,?,?,?,?,?)',
			)
			.bind(
				project.id,
				project.workspaceId,
				project.name,
				project.description,
				project.contestId,
				project.contestUrl,
				project.status,
				project.kind,
				project.createdAt,
				project.updatedAt,
			)
			.run();
	} catch (error) {
		// The partial unique index allows exactly one home per workspace: a
		// concurrent ensure lost the race — return the winner.
		const message = String(error);
		if (message.includes('projects_home_per_workspace_idx')) {
			const winner = await queryAll(
				db,
				`select p.* from "projects" p
				 join "workspace_memberships" m on m."workspaceId" = p."workspaceId"
				 where m."userId" = ? and p."kind" = 'home'
				 order by p."createdAt" asc limit 1`,
				verifiedActor,
			);
			if (winner[0]) return projectFromRow(winner[0]);
		}
		throw error;
	}
	// The workspace membership was ensured above (or pre-existed with the
	// actor already a member — inserting again would violate the unique
	// (workspaceId, userId) index, so only insert when we created the space).
	if (!rows[0]) return project;
	await db
		.prepare(
			'insert or ignore into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values (?,?,?,?,?)',
		)
		.bind(newId('mem'), workspaceId, verifiedActor, 'owner', nowIso())
		.run();
	return project;
}

async function projectRow(db: D1Database, projectId: string): Promise<Record<string, unknown>> {
	const rows = await queryAll(db, 'select * from "projects" where "id" = ?', projectId);
	const row = rows[0];
	if (!row) throw new ScopeError(404, 'project_not_found', 'no such project');
	return row;
}

export async function getProject(db: D1Database, scope: Scope): Promise<Project> {
	const verified = await assertProjectScope(db, scope);
	return projectFromRow(await projectRow(db, verified.projectId));
}

/**
 * Update a project. Workspace ownership and status are NOT patchable: the
 * strict input schema rejects smuggled keys (400) and the scope is
 * re-verified against the project's real workspace before any write.
 */
export async function updateProject(
	db: D1Database,
	scope: Scope,
	patch: unknown,
): Promise<Project> {
	const verified = await assertProjectScope(db, scope);
	const parsed = parseOr400(ProjectUpdateInputSchema, patch);
	const sets: string[] = [];
	const params: unknown[] = [];
	if (parsed.name !== undefined) {
		sets.push('"name" = ?');
		params.push(parsed.name);
	}
	if (parsed.description !== undefined) {
		sets.push('"description" = ?');
		params.push(parsed.description);
	}
	if (parsed.contestId !== undefined) {
		sets.push('"contestId" = ?');
		params.push(parsed.contestId);
	}
	if (parsed.contestUrl !== undefined) {
		sets.push('"contestUrl" = ?');
		params.push(parsed.contestUrl);
	}
	if (sets.length > 0) {
		sets.push('"updatedAt" = ?');
		params.push(nowIso());
		params.push(verified.projectId);
		await db
			.prepare(`update "projects" set ${sets.join(', ')} where "id" = ?`)
			.bind(...params)
			.run();
	}
	return projectFromRow(await projectRow(db, verified.projectId));
}

/**
 * Archive is a status transition, never a deletion: rows remain and stay
 * readable by members (rollback of a packet must never delete user data).
 */
export async function archiveProject(db: D1Database, scope: Scope): Promise<Project> {
	const verified = await assertProjectScope(db, scope);
	await db
		.prepare('update "projects" set "status" = \'archived\', "updatedAt" = ? where "id" = ?')
		.bind(nowIso(), verified.projectId)
		.run();
	return projectFromRow(await projectRow(db, verified.projectId));
}

/** List projects in the scoped workspace (membership re-verified). */
export async function listProjectsInWorkspace(
	db: D1Database,
	scope: WorkspaceScope,
): Promise<Project[]> {
	const verified = await assertWorkspaceScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "projects" where "workspaceId" = ? order by "createdAt" desc',
		verified.workspaceId,
	);
	return rows.map(projectFromRow);
}

/** List every project in workspaces the actor is a member of (membership join). */
export async function listProjectsForActor(
	db: D1Database,
	actorId: string,
): Promise<Project[]> {
	const verifiedActor = requireActorId(actorId);
	const rows = await queryAll(
		db,
		`select p.* from "projects" p
		 join "workspace_memberships" m on m."workspaceId" = p."workspaceId"
		 where m."userId" = ?
		 order by p."createdAt" desc`,
		verifiedActor,
	);
	return rows.map(projectFromRow);
}

// --- plan-doc revisions -----------------------------------------------------------

/**
 * Append an immutable plan-doc revision. Revision numbers are allocated per
 * (project, kind); a concurrent allocation loses with a typed 409 instead of
 * overwriting history.
 */
export async function createPlanDocRevision(
	db: D1Database,
	scope: Scope,
	input: unknown,
): Promise<PlanDocRevision> {
	const verified = await assertProjectScope(db, scope);
	const parsed = parseOr400(PlanDocCreateInputSchema, input);
	const nextRows = await queryAll(
		db,
		'select coalesce(max("revision"), 0) + 1 as "next" from "plan_doc_revisions" where "projectId" = ? and "kind" = ?',
		verified.projectId,
		parsed.kind,
	);
	const revision = Number(nextRows[0]?.['next'] ?? 1);
	const record: PlanDocRevision = {
		id: newId('pdr'),
		projectId: verified.projectId,
		kind: parsed.kind,
		revision,
		bodyHash: await sha256Tagged(parsed.body),
		body: parsed.body,
		createdBy: verified.actorId,
		createdAt: nowIso(),
	};
	await insertOrConflict(
		db,
		'revision_conflict',
		'insert into "plan_doc_revisions" ("id","projectId","kind","revision","bodyHash","body","createdBy","createdAt") values (?,?,?,?,?,?,?,?)',
		record.id,
		record.projectId,
		record.kind,
		record.revision,
		record.bodyHash,
		record.body,
		record.createdBy,
		record.createdAt,
	);
	return record;
}

/**
 * List a project's plan-doc revisions, newest first — latest is per PROJECT
 * (optionally per (project, kind)), never per user (audit defect #2).
 */
export async function listPlanDocRevisions(
	db: D1Database,
	scope: Scope,
	kind?: string,
): Promise<PlanDocRevision[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = kind
		? await queryAll(
				db,
				'select * from "plan_doc_revisions" where "projectId" = ? and "kind" = ? order by "revision" desc',
				verified.projectId,
				kind,
			)
		: await queryAll(
				db,
				'select * from "plan_doc_revisions" where "projectId" = ? order by "revision" desc',
				verified.projectId,
			);
	return rows.map(planDocRevisionFromRow);
}

// --- run bindings ------------------------------------------------------------------

/**
 * Create a run binding. projectId is the scope's project — stored at creation
 * as part of the run's durable identity; the create input has no project field
 * to accept (strict schema rejects one even if a caller smuggles it).
 */
export async function createRunBinding(
	db: D1Database,
	scope: Scope,
	input: unknown,
): Promise<RunBindingRecord> {
	const verified = await assertProjectScope(db, scope);
	const parsed = parseOr400(RunBindingCreateInputSchema, input);
	const record: RunBindingRecord = {
		runId: parsed.runId ?? newId('run'),
		projectId: verified.projectId,
		conversationId: parsed.conversationId,
		submissionId: parsed.submissionId,
		planRevision: parsed.planRevision,
		stackId: parsed.stackId,
		payerId: parsed.payerId,
		modelRouteId: parsed.modelRouteId,
		pricingVersion: parsed.pricingVersion,
		createdBy: verified.actorId,
		createdAt: nowIso(),
	};
	await insertOrConflict(
		db,
		'run_id_conflict',
		'insert into "run_bindings" ("runId","projectId","conversationId","submissionId","planRevision","stackId","payerId","modelRouteId","pricingVersion","createdBy","createdAt") values (?,?,?,?,?,?,?,?,?,?,?)',
		record.runId,
		record.projectId,
		record.conversationId,
		record.submissionId,
		record.planRevision,
		record.stackId,
		record.payerId,
		record.modelRouteId,
		record.pricingVersion,
		record.createdBy,
		record.createdAt,
	);
	return record;
}

/**
 * Look a run up by its id UNDER THE SCOPED PROJECT. A binding stored under a
 * different project is invisible here (null), even for the same actor from
 * another project scope — there is no active-project inference.
 */
export async function getRunBinding(
	db: D1Database,
	scope: Scope,
	runId: string,
): Promise<RunBindingRecord | null> {
	const verified = await assertProjectScope(db, scope);
	if (typeof runId !== 'string' || runId.length === 0) {
		throw new ScopeError(400, 'invalid_request', 'runId is required');
	}
	const rows = await queryAll(
		db,
		'select * from "run_bindings" where "runId" = ? and "projectId" = ?',
		runId,
		verified.projectId,
	);
	const row = rows[0];
	return row ? runBindingRecordFromRow(row) : null;
}

/** List the scoped project's run bindings, newest first. */
export async function listRunBindings(
	db: D1Database,
	scope: Scope,
): Promise<RunBindingRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "run_bindings" where "projectId" = ? order by "createdAt" desc',
		verified.projectId,
	);
	return rows.map(runBindingRecordFromRow);
}

// --- artifact revisions -------------------------------------------------------------

/** Append a project-scoped artifact metadata revision. */
export async function createArtifactRevision(
	db: D1Database,
	scope: Scope,
	input: unknown,
): Promise<ArtifactRevision> {
	const verified = await assertProjectScope(db, scope);
	const parsed = parseOr400(ArtifactCreateInputSchema, input);
	const artifactId = parsed.artifactId ?? newId('artif');
	const nextRows = await queryAll(
		db,
		'select coalesce(max("revision"), 0) + 1 as "next" from "artifact_revisions" where "projectId" = ? and "artifactId" = ?',
		verified.projectId,
		artifactId,
	);
	const revision = Number(nextRows[0]?.['next'] ?? 1);
	const record: ArtifactRevision = {
		id: newId('artrev'),
		projectId: verified.projectId,
		artifactId,
		kind: parsed.kind,
		revision,
		metadataHash: await sha256Tagged(parsed.metadata),
		metadata: parsed.metadata,
		createdBy: verified.actorId,
		createdAt: nowIso(),
	};
	await insertOrConflict(
		db,
		'revision_conflict',
		'insert into "artifact_revisions" ("id","projectId","artifactId","kind","revision","metadataHash","metadata","createdBy","createdAt") values (?,?,?,?,?,?,?,?,?)',
		record.id,
		record.projectId,
		record.artifactId,
		record.kind,
		record.revision,
		record.metadataHash,
		record.metadata,
		record.createdBy,
		record.createdAt,
	);
	return record;
}

/** List a project's artifact revisions, newest first, optionally per artifact. */
export async function listArtifactRevisions(
	db: D1Database,
	scope: Scope,
	artifactId?: string,
): Promise<ArtifactRevision[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = artifactId
		? await queryAll(
				db,
				'select * from "artifact_revisions" where "projectId" = ? and "artifactId" = ? order by "revision" desc',
				verified.projectId,
				artifactId,
			)
		: await queryAll(
				db,
				'select * from "artifact_revisions" where "projectId" = ? order by "revision" desc',
				verified.projectId,
			);
	return rows.map(artifactRevisionFromRow);
}
