/**
 * P02 project-domain contracts: workspaces, projects, plan-doc revisions,
 * run-binding records and artifact revisions.
 *
 * Source of truth: docs/plans/2026-10-03-fresh-build/contracts.md ("Scope,
 * authorization and run identity") plus feature-ledger row C9 (workspace ->
 * project -> runs, optional contest link, A/B isolation). Serializable schemas
 * and pure helpers only — no I/O, no app state. All object schemas are strict
 * (unknown keys rejected) so body-supplied authorization fields can never ride
 * through a contract; projectId in particular is always server-derived and is
 * therefore absent from every create-input schema.
 *
 * The run-binding record MIRRORS the frozen `RunBinding` contract in
 * `./index.ts` (same nine fields, same shapes) plus storage-audit fields
 * (createdBy/createdAt). The type-only import below is erased at runtime, so
 * adding `export * from './projects.ts'` to index.ts introduces no runtime
 * cycle.
 */

import type { StackId } from './index.ts';
import * as v from 'valibot';

const isoTimestamp = () => v.pipe(v.string(), v.isoTimestamp());
const nonEmpty = () => v.pipe(v.string(), v.minLength(1));

// --- workspace ---------------------------------------------------------------

export const WorkspaceSchema = v.pipe(
	v.strictObject({
		id: v.string(),
		name: nonEmpty(),
		createdAt: isoTimestamp(),
	}),
	v.readonly(),
);
export type Workspace = v.InferOutput<typeof WorkspaceSchema>;

export const WorkspaceCreateInputSchema = v.pipe(
	v.strictObject({
		name: nonEmpty(),
	}),
	v.readonly(),
);
export type WorkspaceCreateInput = v.InferOutput<typeof WorkspaceCreateInputSchema>;

// --- project ------------------------------------------------------------------

export const ProjectStatusSchema = v.picklist(['active', 'archived']);
export type ProjectStatus = v.InferOutput<typeof ProjectStatusSchema>;

/**
 * `home` marks the actor's direct conversation project — the project-less
 * chat surface backed by the same run machinery. Exactly one per workspace
 * (partial unique index, migration 0011).
 */
export const ProjectKindSchema = v.picklist(['standard', 'home']);
export type ProjectKind = v.InferOutput<typeof ProjectKindSchema>;

/**
 * A project is workspace-owned; the contest link is OPTIONAL (nullable) — a
 * project never requires a contest (feature-ledger C9). Archived projects keep
 * their rows: archive is a status, never a deletion.
 */
export const ProjectSchema = v.pipe(
	v.strictObject({
		id: v.string(),
		workspaceId: v.string(),
		name: nonEmpty(),
		description: v.nullable(v.string()),
		contestId: v.nullable(v.string()),
		contestUrl: v.nullable(v.string()),
		status: ProjectStatusSchema,
		kind: v.optional(ProjectKindSchema, 'standard'),
		createdAt: isoTimestamp(),
		updatedAt: isoTimestamp(),
	}),
	v.readonly(),
);
export type Project = v.InferOutput<typeof ProjectSchema>;

export const ProjectCreateInputSchema = v.pipe(
	v.strictObject({
		workspaceId: v.string(),
		name: nonEmpty(),
		description: v.optional(v.string()),
		contestId: v.optional(v.string()),
		contestUrl: v.optional(v.string()),
	}),
	v.readonly(),
);
export type ProjectCreateInput = v.InferOutput<typeof ProjectCreateInputSchema>;

/**
 * Update patch: workspace ownership and status are NOT patchable — moving a
 * project across workspaces or sneaking an archive through an update is
 * rejected by strict parsing (archive is its own explicit transition).
 */
export const ProjectUpdateInputSchema = v.pipe(
	v.strictObject({
		name: v.optional(nonEmpty()),
		description: v.optional(v.nullable(v.string())),
		contestId: v.optional(v.nullable(v.string())),
		contestUrl: v.optional(v.nullable(v.string())),
	}),
	v.readonly(),
);
export type ProjectUpdateInput = v.InferOutput<typeof ProjectUpdateInputSchema>;

// --- plan-doc revisions --------------------------------------------------------

export const PlanDocRevisionSchema = v.pipe(
	v.strictObject({
		id: v.string(),
		projectId: v.string(),
		kind: nonEmpty(),
		revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
		bodyHash: nonEmpty(),
		body: v.string(),
		createdBy: v.string(),
		createdAt: isoTimestamp(),
	}),
	v.readonly(),
);
export type PlanDocRevision = v.InferOutput<typeof PlanDocRevisionSchema>;

export const PlanDocCreateInputSchema = v.pipe(
	v.strictObject({
		kind: nonEmpty(),
		body: v.string(),
	}),
	v.readonly(),
);
export type PlanDocCreateInput = v.InferOutput<typeof PlanDocCreateInputSchema>;

// --- run bindings ---------------------------------------------------------------

/** Local literal set for the five contract stacks (mirrors index `StackId`). */
const STACK_ID_VALUES = [
	'react-hono',
	'tanstack-start',
	'laravel-inertia',
	'fastapi-react',
	'flutter',
] as const satisfies readonly StackId[];

export const StackIdSchema = v.picklist([...STACK_ID_VALUES]);

/**
 * Stored run-binding record: the frozen RunBinding contract plus audit fields.
 * projectId is part of the durable identity of a run ("Never report a run
 * started without durable identity") — run lookups go by the STORED project,
 * never by an "active project" inference.
 */
export const RunBindingRecordSchema = v.pipe(
	v.strictObject({
		runId: v.string(),
		projectId: v.string(),
		conversationId: v.string(),
		submissionId: v.string(),
		planRevision: v.string(),
		stackId: StackIdSchema,
		payerId: v.string(),
		modelRouteId: v.string(),
		pricingVersion: v.string(),
		createdBy: v.string(),
		createdAt: isoTimestamp(),
	}),
	v.readonly(),
);
export type RunBindingRecord = v.InferOutput<typeof RunBindingRecordSchema>;

/**
 * Create input for a run binding: projectId is server-derived from the scope
 * and never accepted from the body; runId is optional (generated server-side
 * when absent) because the caller may bring a stable idempotency identity.
 */
export const RunBindingCreateInputSchema = v.pipe(
	v.strictObject({
		runId: v.optional(v.string()),
		conversationId: nonEmpty(),
		submissionId: nonEmpty(),
		planRevision: nonEmpty(),
		stackId: StackIdSchema,
		payerId: nonEmpty(),
		modelRouteId: nonEmpty(),
		pricingVersion: nonEmpty(),
	}),
	v.readonly(),
);
export type RunBindingCreateInput = v.InferOutput<typeof RunBindingCreateInputSchema>;

// --- artifact revisions ----------------------------------------------------------

export const ArtifactRevisionSchema = v.pipe(
	v.strictObject({
		id: v.string(),
		projectId: v.string(),
		artifactId: v.string(),
		kind: nonEmpty(),
		revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
		metadataHash: nonEmpty(),
		/** Serialized JSON metadata snapshot for this revision. */
		metadata: v.string(),
		createdBy: v.string(),
		createdAt: isoTimestamp(),
	}),
	v.readonly(),
);
export type ArtifactRevision = v.InferOutput<typeof ArtifactRevisionSchema>;

export const ArtifactCreateInputSchema = v.pipe(
	v.strictObject({
		artifactId: v.optional(v.string()),
		kind: nonEmpty(),
		metadata: v.string(),
	}),
	v.readonly(),
);
export type ArtifactCreateInput = v.InferOutput<typeof ArtifactCreateInputSchema>;
