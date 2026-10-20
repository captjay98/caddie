/**
 * The host-driven feature loop (build-loop Phase 1).
 *
 * The approved PRD's `caddie-features` block becomes one `build_features`
 * row per feature when that revision's build starts. The HOST owns the order:
 * the coordinator can only ask for the current feature (build_next_feature)
 * and ask the host to finish it (finish_feature, coordinator-host.ts), which
 * passes it only on green host checks plus new passing tests and then records
 * the sandbox image as that feature's save point. A rollback restarts the
 * build's sandbox from a save point and re-queues every later feature.
 *
 * Plans approved before feature lists existed build as one whole-plan
 * feature, so in-flight projects keep working.
 */

import {
	parsePlanFeatures,
	WHOLE_PLAN_FEATURE,
	type BuildFeatureStatus,
	type BuildFeatureView,
	type PlanDocRevision,
	type PlanFeature,
	type Scope,
} from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope, ScopeError } from './scope.ts';
import { lookupRunByConversation } from './runs.ts';
import { readWorkflow, workflowSnapshot, type WorkflowPhase } from './build-workflow.ts';

export interface BuildFeatureRow {
	readonly projectId: string;
	readonly runId: string;
	readonly planId: string;
	readonly featureId: string;
	readonly position: number;
	readonly title: string;
	readonly doneWhen: readonly string[];
	readonly status: BuildFeatureStatus;
	readonly attempts: number;
	readonly testsPassed: number | null;
	readonly checkpointRef: string | null;
	readonly passedAt: string | null;
}

const now = () => new Date().toISOString();
const NO_SUCH_TABLE = (error: unknown) => String(error).includes('no such table');

/** The features a plan revision builds: its block, or the whole plan as one. */
export function featuresForPlan(body: string): PlanFeature[] {
	const parsed = parsePlanFeatures(body);
	return parsed.ok ? parsed.features : [WHOLE_PLAN_FEATURE];
}

function toRow(row: Record<string, unknown>): BuildFeatureRow {
	let doneWhen: string[] = [];
	try {
		const parsed = JSON.parse(String(row['doneWhen'] ?? '[]'));
		if (Array.isArray(parsed)) doneWhen = parsed.map(String);
	} catch {
		doneWhen = [];
	}
	return {
		projectId: String(row['projectId']),
		runId: String(row['runId']),
		planId: String(row['planId']),
		featureId: String(row['featureId']),
		position: Number(row['position']),
		title: String(row['title']),
		doneWhen,
		status: String(row['status']) as BuildFeatureStatus,
		attempts: Number(row['attempts'] ?? 0),
		testsPassed: row['testsPassed'] == null ? null : Number(row['testsPassed']),
		checkpointRef: row['checkpointRef'] == null ? null : String(row['checkpointRef']),
		passedAt: row['passedAt'] == null ? null : String(row['passedAt']),
	};
}

/** This plan revision's feature rows in build order. Missing table → none. */
export async function listBuildFeatures(db: D1Database, projectId: string, planId: string): Promise<BuildFeatureRow[]> {
	try {
		const result = await db
			.prepare('select * from "build_features" where "projectId" = ? and "planId" = ? order by "position" asc')
			.bind(projectId, planId)
			.all();
		return ((result.results ?? []) as Record<string, unknown>[]).map(toRow);
	} catch (error) {
		if (NO_SUCH_TABLE(error)) return [];
		throw error;
	}
}

/** Create the rows for an approved plan revision once; later calls read them. */
export async function ensureBuildFeatures(
	db: D1Database,
	scope: Scope,
	runId: string,
	plan: Pick<PlanDocRevision, 'id' | 'body'>,
): Promise<BuildFeatureRow[]> {
	await assertProjectScope(db, scope);
	const existing = await listBuildFeatures(db, scope.projectId, plan.id);
	if (existing.length > 0) return existing;
	const stamp = now();
	await db.batch(
		featuresForPlan(plan.body).map((feature, index) =>
			db
				.prepare(
					'insert or ignore into "build_features" ("projectId","runId","planId","featureId","position","title","doneWhen","status","attempts","updatedAt") values (?,?,?,?,?,?,?,?,0,?)',
				)
				.bind(scope.projectId, runId, plan.id, feature.id, index + 1, feature.title, JSON.stringify(feature.doneWhen), 'pending', stamp),
		),
	);
	return listBuildFeatures(db, scope.projectId, plan.id);
}

/** The feature being built now: the first one that has not passed. */
export function currentFeature(rows: readonly BuildFeatureRow[]): BuildFeatureRow | null {
	return rows.find((row) => row.status !== 'passed') ?? null;
}

/** The passing-test count the last green feature reached (0 before any). */
export function testsBaseline(rows: readonly BuildFeatureRow[]): number {
	return rows.reduce((max, row) => (row.status === 'passed' && row.testsPassed !== null ? Math.max(max, row.testsPassed) : max), 0);
}

export async function markFeatureBuilding(db: D1Database, row: BuildFeatureRow): Promise<void> {
	await db
		.prepare('update "build_features" set "status" = \'building\', "updatedAt" = ? where "projectId" = ? and "planId" = ? and "featureId" = ? and "status" in (\'pending\', \'failed\')')
		.bind(now(), row.projectId, row.planId, row.featureId)
		.run();
}

/** A failed finish: one more attempt; `failed` once the repair pause stops it. */
export async function recordFeatureAttempt(db: D1Database, row: BuildFeatureRow, paused: boolean): Promise<void> {
	await db
		.prepare('update "build_features" set "attempts" = "attempts" + 1, "status" = ?, "updatedAt" = ? where "projectId" = ? and "planId" = ? and "featureId" = ? and "status" <> \'passed\'')
		.bind(paused ? 'failed' : 'building', now(), row.projectId, row.planId, row.featureId)
		.run();
}

export async function recordFeaturePassed(
	db: D1Database,
	row: BuildFeatureRow,
	result: { checkpointRef: string; testsPassed: number },
): Promise<void> {
	const stamp = now();
	await db
		.prepare('update "build_features" set "status" = \'passed\', "checkpointRef" = ?, "testsPassed" = ?, "passedAt" = ?, "updatedAt" = ? where "projectId" = ? and "planId" = ? and "featureId" = ?')
		.bind(result.checkpointRef, result.testsPassed, stamp, stamp, row.projectId, row.planId, row.featureId)
		.run();
}

/**
 * The read model the progress view shows. Before a build starts there are
 * no rows yet, so the plan's own list is shown as all pending — a read never
 * creates rows.
 */
export function featureViews(
	source: { rows: readonly BuildFeatureRow[] } | { planned: readonly PlanFeature[] },
	phase: WorkflowPhase,
): BuildFeatureView[] {
	if ('planned' in source) {
		return source.planned.map((feature, index) => ({
			id: feature.id,
			title: feature.title,
			doneWhen: feature.doneWhen,
			position: index + 1,
			status: 'pending',
			attempts: 0,
			testsPassed: null,
			passedAt: null,
			canRollBack: false,
		}));
	}
	const rows = source.rows;
	const settled = phase === 'ready' || phase === 'blocked';
	return rows.map((row) => ({
		id: row.featureId,
		title: row.title,
		doneWhen: row.doneWhen,
		position: row.position,
		// "Building now" only while the build is building: a stopped, paused or
		// re-planned build leaves its row at 'building' until it resumes (plan 3.2).
		status: row.status === 'building' && phase !== 'building' ? 'pending' : row.status,
		attempts: row.attempts,
		testsPassed: row.testsPassed,
		passedAt: row.passedAt,
		// A save point is worth offering only when work after it would be undone.
		canRollBack:
			settled &&
			row.status === 'passed' &&
			row.checkpointRef !== null &&
			rows.some((later) => later.position > row.position && later.status !== 'pending'),
	}));
}

/** Views for a workflow's current plan (read-only). */
export async function featureViewsFor(
	db: D1Database,
	projectId: string,
	phase: WorkflowPhase,
	plan: Pick<PlanDocRevision, 'id' | 'body'> | null,
): Promise<BuildFeatureView[]> {
	if (!plan) return [];
	const rows = await listBuildFeatures(db, projectId, plan.id);
	return rows.length > 0 ? featureViews({ rows }, phase) : featureViews({ planned: featuresForPlan(plan.body) }, phase);
}

/** The sandbox session a build should use when it is not the default one. */
export async function buildSessionOverride(
	db: D1Database,
	projectId: string,
	runId: string,
): Promise<{ sessionKey: string; image: string; reason: string } | null> {
	try {
		const result = await db
			.prepare('select "sessionKey","image","runId","reason" from "build_sandbox_sessions" where "projectId" = ?')
			.bind(projectId)
			.all();
		const row = result.results[0] as { sessionKey: string; image: string; runId: string; reason: string } | undefined;
		return row && row.runId === runId ? { sessionKey: row.sessionKey, image: row.image, reason: row.reason } : null;
	} catch (error) {
		if (NO_SUCH_TABLE(error)) return null;
		throw error;
	}
}

/**
 * Roll the build back to the moment a feature went green. Owner-only, and
 * only while nothing is running (ready or blocked) — a live build must be
 * stopped first. Every later feature is re-queued, the preview is withdrawn,
 * and the next sandbox action starts a FRESH session from the save point's
 * image, so the files are exactly what passed then. Idempotent on `key`.
 * The workflow lands in `blocked` with a plain explanation; the existing
 * Retry continues from the first re-queued feature.
 */
export async function rollbackToFeature(
	db: D1Database,
	scope: Scope,
	input: { featureId: string; key: string },
) {
	await assertProjectScope(db, scope);
	if (typeof input.key !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(input.key))
		throw new ScopeError(400, 'invalid_rollback_key', 'An idempotent rollback key is required.');
	const workflow = await readWorkflow(db, scope);
	if (!workflow?.planId) throw new ScopeError(404, 'workflow_not_found', 'No build exists.');
	const run = await lookupRunByConversation(db, workflow.conversationId);
	if (run?.createdBy !== scope.actorId) throw new ScopeError(403, 'not_run_owner', 'Only the build owner can roll it back.');
	const sessionKey = `rollback:${workflow.runId}:${input.key}`;
	const replay = await buildSessionOverride(db, scope.projectId, workflow.runId);
	if (replay?.sessionKey === sessionKey) return workflowSnapshot(db, scope);
	if (workflow.phase !== 'ready' && workflow.phase !== 'blocked')
		throw new ScopeError(409, 'BUILD_RUNNING', 'Stop the build before rolling it back.');
	const rows = await listBuildFeatures(db, scope.projectId, workflow.planId);
	const target = rows.find((row) => row.featureId === input.featureId);
	if (!target || target.status !== 'passed' || !target.checkpointRef)
		throw new ScopeError(409, 'NOT_A_SAVE_POINT', 'That feature has no save point to roll back to.');
	const later = rows.filter((row) => row.position > target.position);
	// Same rule the view uses for canRollBack: a save point is offered only when
	// work after it would be undone.
	if (!later.some((row) => row.status !== 'pending'))
		throw new ScopeError(409, 'NOTHING_TO_UNDO', 'Nothing was built after that feature, so there is nothing to roll back.');
	const stamp = now();
	const requeued = later.length === 1 ? '1 later feature' : `${later.length} later features`;
	await db.batch([
		db
			.prepare('update "build_features" set "status" = \'pending\', "attempts" = 0, "testsPassed" = null, "checkpointRef" = null, "passedAt" = null, "updatedAt" = ? where "projectId" = ? and "planId" = ? and "position" > ?')
			.bind(stamp, scope.projectId, workflow.planId, target.position),
		// delete + insert, not ON CONFLICT: the local D1 emulator mishandles upserts (P08 note).
		db.prepare('delete from "build_sandbox_sessions" where "projectId" = ?').bind(scope.projectId),
		db
			.prepare('insert into "build_sandbox_sessions" ("projectId","runId","sessionKey","image","reason","updatedAt") values (?,?,?,?,?,?)')
			.bind(scope.projectId, workflow.runId, sessionKey, target.checkpointRef, `rollback:${target.featureId}`, stamp),
		db
			.prepare("update build_workflows set phase = 'blocked', previewId = null, pendingKey = null, pendingBody = null, detail = ?, updatedAt = ? where projectId = ? and phase in ('ready','blocked')")
			.bind(
				`Rolled back to just after “${target.title}”. The app's files are exactly as they were when it passed; ${requeued} will be built again when you press Retry.`,
				stamp,
				scope.projectId,
			),
	]);
	return workflowSnapshot(db, scope);
}
