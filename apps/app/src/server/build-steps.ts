/**
 * Part boundary steps (plan part D) + the Try-again hook (plan part F).
 *
 * These are the DB-backed orchestration helpers the agent tools and the
 * coordinator host call. The pure area/manifest logic is in
 * `part-manifests.ts`; this file wires it to `part_manifests` (migration 0040)
 * and to the sandbox snapshot through a small read/write port, so it is tested
 * against the local contree stub with no running build.
 *
 * Team mode only. With teamMode = 0 the build loop never calls `startPart`, so
 * `activePart` returns null, the write-tool refusal is skipped, and finish is a
 * no-op — today's behaviour is unchanged.
 *
 * The model for enforcement:
 *   - `startPart` records a manifest (path + sha256) of the app's source
 *     folders FROM THE COMMITTED SNAPSHOT, and marks the active role+module.
 *   - the write tools (agents/tools.ts) refuse another role or an out-of-area
 *     path — early feedback only.
 *   - `finishPart` / `finishFeature` rebuild the manifest from the CURRENT
 *     snapshot and refuse any out-of-area change, listing the files. Because
 *     the check is on the snapshot, a change by a Node / Python / package
 *     script is caught the same way.
 *   - `restoreFiles(paths)` puts files back from the start-of-part snapshot in
 *     one batch.
 */

import type { D1Database } from './auth.ts';
import type { Scope } from '@caddie/contracts';
import { parseArchitectureBlock, type ArchitectureBlock } from '@caddie/contracts';
import { ScopeError } from './scope.ts';
import { REPAIR_PAUSE_THRESHOLD } from '../agents/permissions.ts';
import {
	type BuildFeatureRow,
	currentFeature,
	listBuildFeatures,
	rollbackToFeature,
} from './build-features.ts';
import { readWorkflow, retryWorkflow } from './build-workflow.ts';
import { STOP_SENTINEL } from './project-experience.ts';
import {
	type Area,
	type AreaRole,
	type OutOfAreaChange,
	type PartManifest,
	type SnapshotReadPort,
	AREA_ROLES,
	areaFor,
	buildManifest,
	diffAgainstManifest,
} from './part-manifests.ts';

/** The partKey under which the active-part pointer is stored (one per project). */
const ACTIVE_PART_KEY = '__active__';

function nowIso(): string {
	return new Date().toISOString();
}

/** The snapshot-write surface restore_files needs. Paths are workspace-relative. */
export interface SnapshotWritePort {
	/** Read a file's bytes (base64) from the START image. */
	readFromStart(path: string): Promise<string>;
	/** Write many files into the current session in one commit. */
	writeBatch(files: Array<{ path: string; contentBase64: string }>): Promise<void>;
}

/** What a started part remembers, stored as JSON in part_manifests.manifest. */
interface StoredPart {
	featureId: string;
	role: AreaRole;
	moduleId: string;
	/** The committed image the manifest was read from (restore reads from it). */
	startImage: string;
	manifest: PartManifest;
}

/** The active part for a project, resolved from the stored pointer. */
export interface ActivePart {
	featureId: string;
	role: AreaRole;
	moduleId: string;
	area: Area;
	startImage: string;
	manifest: PartManifest;
}

function isAreaRole(value: string): value is AreaRole {
	return (AREA_ROLES as readonly string[]).includes(value);
}

async function readApprovedBlock(db: D1Database, scope: Scope): Promise<ArchitectureBlock> {
	// The design revision bound to the build (parts B/E/G). Fall back to the
	// latest design revision when a build has not stamped one yet (tests, and
	// the first design-review pass).
	const bound = (
		await db
			.prepare(
				'select r.body as body from build_workflows w join plan_doc_revisions r on r.id = w.approvedDesignRevisionId where w.projectId = ?',
			)
			.bind(scope.projectId)
			.all<{ body: string }>()
	).results?.[0];
	const body =
		bound?.body ??
		(
			await db
				.prepare(
					"select body from plan_doc_revisions where projectId = ? and kind = 'design' order by revision desc limit 1",
				)
				.bind(scope.projectId)
				.all<{ body: string }>()
		).results?.[0]?.body;
	if (!body) throw new ScopeError(409, 'NO_DESIGN', 'There is no approved design to read the app areas from.');
	const parsed = parseArchitectureBlock(body);
	if (!parsed.ok) throw new ScopeError(409, 'NO_ARCHITECTURE', `The design has no usable architecture block: ${parsed.error}`);
	return parsed.block;
}

async function loadStoredPart(db: D1Database, projectId: string, partKey: string): Promise<StoredPart | null> {
	const row = (
		await db
			.prepare('select "manifest" from "part_manifests" where "projectId" = ? and "partKey" = ?')
			.bind(projectId, partKey)
			.all<{ manifest: string }>()
	).results?.[0];
	if (!row) return null;
	try {
		return JSON.parse(row.manifest) as StoredPart;
	} catch {
		return null;
	}
}

async function saveStoredPart(db: D1Database, projectId: string, partKey: string, stored: StoredPart): Promise<void> {
	const stamp = nowIso();
	// delete + insert, not ON CONFLICT: the local D1 emulator mishandles
	// upserts (the same P08 note the rollback path records).
	await db.batch([
		db.prepare('delete from "part_manifests" where "projectId" = ? and "partKey" = ?').bind(projectId, partKey),
		db
			.prepare('insert into "part_manifests" ("id","projectId","partKey","manifest","createdAt") values (?,?,?,?,?)')
			.bind(`pm_${crypto.randomUUID()}`, projectId, partKey, JSON.stringify(stored), stamp),
	]);
}

/**
 * Start a part: record the source-folder manifest from the committed snapshot
 * and mark the active role+module. The coordinator / module builder MUST call
 * this before delegating a feature in team mode. `role` names the build role
 * whose area is active; `moduleId` is required for a big (multi-module) app.
 */
export async function startPart(
	db: D1Database,
	scope: Scope,
	port: SnapshotReadPort & { image: string },
	input: { featureId: string; role: string; moduleId?: string },
): Promise<{ started: true; role: AreaRole; moduleId: string; files: number }> {
	if (!isAreaRole(input.role) || input.role === 'other')
		throw new ScopeError(400, 'BAD_ROLE', `A part is started for a write role (backend, frontend or mobile), not "${input.role}".`);
	const block = await readApprovedBlock(db, scope);
	const bigApp = block.modules.length > 1;
	if (bigApp && !input.moduleId)
		throw new ScopeError(400, 'MODULE_REQUIRED', 'This is a big app: start_part needs the module id.');
	if (input.moduleId && !block.modules.some((m) => m.id === input.moduleId))
		throw new ScopeError(400, 'NO_SUCH_MODULE', `"${input.moduleId}" is not a module of this app.`);
	const area = areaFor(block, input.role, input.moduleId);
	const manifest = await buildManifest(port);
	const stored: StoredPart = {
		featureId: input.featureId,
		role: area.role,
		moduleId: area.moduleId,
		startImage: port.image,
		manifest,
	};
	// The manifest is keyed by featureId; the active pointer names the current one.
	await saveStoredPart(db, scope.projectId, input.featureId, stored);
	await saveStoredPart(db, scope.projectId, ACTIVE_PART_KEY, stored);
	return { started: true, role: area.role, moduleId: area.moduleId, files: manifest.files.length };
}

/** The active part for a project, or null when none is started (team mode off, or between parts). */
export async function activePart(db: D1Database, scope: Scope): Promise<ActivePart | null> {
	const stored = await loadStoredPart(db, scope.projectId, ACTIVE_PART_KEY);
	if (!stored) return null;
	const block = await readApprovedBlock(db, scope).catch(() => null);
	// Rebuild the area from the stored role+module. If the design is gone, fall
	// back to the stored manifest's own area by re-deriving from a one-module
	// shape is impossible without the block; in that case refuse nothing new
	// (the manifest diff still catches changes) — but normally the block is here.
	const area = block ? areaFor(block, stored.role, stored.moduleId) : { role: stored.role, moduleId: stored.moduleId, allow: [] as string[] };
	return { featureId: stored.featureId, role: stored.role, moduleId: stored.moduleId, area, startImage: stored.startImage, manifest: stored.manifest };
}

/**
 * Compare the CURRENT snapshot with the active part's start-of-part manifest
 * and return every out-of-area change. An empty list means the part stayed in
 * its area. Used by both finish_part and finish_feature (same check).
 */
export async function checkPartBoundary(
	db: D1Database,
	scope: Scope,
	port: SnapshotReadPort,
): Promise<{ active: false } | { active: true; outOfArea: OutOfAreaChange[]; part: ActivePart }> {
	const part = await activePart(db, scope);
	if (!part) return { active: false };
	const current = await buildManifest(port);
	const outOfArea = diffAgainstManifest(part.area, part.manifest, current);
	return { active: true, outOfArea, part };
}

/**
 * finish_part / finish_feature: the boundary check, turned into a typed
 * refusal when anything is out of area. The files are listed so the builder
 * (or restore_files) can put them back.
 */
export async function finishPart(
	db: D1Database,
	scope: Scope,
	port: SnapshotReadPort,
): Promise<{ ok: true } | { ok: false; outOfArea: OutOfAreaChange[]; message: string }> {
	const result = await checkPartBoundary(db, scope, port);
	if (!result.active) return { ok: true };
	if (result.outOfArea.length === 0) return { ok: true };
	const files = result.outOfArea.map((c) => `${c.path} (${c.kind})`).join(', ');
	return {
		ok: false,
		outOfArea: result.outOfArea,
		message: `This part may change only its own area (${result.part.role}${result.part.moduleId ? ` · ${result.part.moduleId}` : ''}). These changes are outside it and must be put back (restore_files) before finishing: ${files}.`,
	};
}

/**
 * restore_files: put each path back to its start-of-part content, in ONE
 * batch. A path that was ABSENT at start is deleted again is out of scope here
 * (the builder removes it); restore handles files that existed at start. Only
 * paths the start manifest knew are restorable.
 */
export async function restoreFiles(
	db: D1Database,
	scope: Scope,
	port: SnapshotWritePort,
	paths: string[],
): Promise<{ restored: string[]; absentAtStart: string[] }> {
	const part = await activePart(db, scope);
	if (!part) throw new ScopeError(409, 'NO_ACTIVE_PART', 'No part is in progress, so there is nothing to restore.');
	const known = new Map(part.manifest.files.map((f) => [f.path, f.sha256] as const));
	const restored: string[] = [];
	const absentAtStart: string[] = [];
	const batch: Array<{ path: string; contentBase64: string }> = [];
	for (const raw of paths) {
		const path = raw.replaceAll('\\', '/').replace(/^\.\//, '');
		if (!known.has(path)) {
			absentAtStart.push(path);
			continue;
		}
		batch.push({ path, contentBase64: await port.readFromStart(path) });
		restored.push(path);
	}
	if (batch.length > 0) await port.writeBatch(batch);
	return { restored, absentAtStart };
}

/** Clear the active-part pointer (a feature finished cleanly, or a build reset). */
export async function clearActivePart(db: D1Database, scope: Scope): Promise<void> {
	await db.prepare('delete from "part_manifests" where "projectId" = ? and "partKey" = ?').bind(scope.projectId, ACTIVE_PART_KEY).run();
}

// --- Part F: "Try this feature again from the last save point" ---------------
//
// The stopped-build card offers ONE extra button, and only when the build
// stopped AFTER 3 failed tries on a feature. It is built entirely on the
// existing machinery: the rollback to the previous feature's save point
// (build-features.ts rollbackToFeature, which only works while the build is
// stopped, so no builder is running), then the existing message-carrying
// Retry (retryWorkflow's `request` argument, added in 3407bb5), carrying a
// summary of what failed taken from the stopped feature and the blocker.
//
// For the FIRST feature there is no earlier save point, so it starts again
// from the plan — which is exactly what Retry does when nothing has passed
// (rollback would refuse with NOTHING_TO_UNDO), so part F skips the rollback
// and goes straight to the message-carrying Retry.

/** A workflow snapshot shape the gate needs (phase + blocker detail). */
interface TryAgainWorkflow {
	phase: string;
	detail: string | null;
}

/**
 * Is the build stopped AFTER 3 failed tries on a feature — the only moment the
 * Try-again button shows? Pure, so it is unit-tested directly.
 *
 * True requires: the build is `blocked` (Caddie stopped it, not a user Stop —
 * a user Stop carries the STOP_SENTINEL detail), AND the current (first
 * not-passed) feature has reached the repair pause threshold of failed tries.
 * A build that is ready, running, or stopped by the user never offers it.
 */
export function canTryAgainFromSavePoint(
	workflow: TryAgainWorkflow | null,
	features: readonly BuildFeatureRow[],
): boolean {
	if (!workflow || workflow.phase !== 'blocked') return false;
	if ((workflow.detail ?? '').startsWith(STOP_SENTINEL)) return false;
	const current = currentFeature(features);
	if (!current) return false; // every feature passed — nothing to try again
	return current.attempts >= REPAIR_PAUSE_THRESHOLD;
}

/** The summary of what failed, taken from the stopped feature and the blocker. */
export function failureSummary(feature: BuildFeatureRow, detail: string | null): string {
	const blocker = (detail ?? '').trim();
	const base = `Trying “${feature.title}” again from the last save point after ${feature.attempts} failed ${feature.attempts === 1 ? 'try' : 'tries'}.`;
	return blocker ? `${base} What failed last time: ${blocker}` : base;
}

/**
 * The previous feature's save point to roll back to: the latest PASSED feature
 * before the current one. Null when none passed (the current feature is the
 * first), in which case the build starts again from the plan.
 */
function previousSavePoint(features: readonly BuildFeatureRow[], current: BuildFeatureRow): BuildFeatureRow | null {
	const earlierPassed = features
		.filter((row) => row.position < current.position && row.status === 'passed' && row.checkpointRef)
		.sort((a, b) => b.position - a.position);
	return earlierPassed[0] ?? null;
}

/**
 * Seam for testing the composition: the existing rollback and retry as ports.
 * Both default to the real functions, so production wiring passes nothing.
 */
export interface TryAgainPorts {
	rollback?: (featureId: string, key: string) => Promise<unknown>;
	retry?: (key: string, request: string) => Promise<unknown>;
}

/**
 * Part F handler: roll back to the previous feature's save point (if any),
 * then Retry carrying the failure summary. Idempotent on `key`. The host
 * (coordinator-host / the Try-again route the lead registers) calls this; it
 * composes the existing, separately-tested rollback and retry rather than
 * reimplementing either.
 *
 * `env` is passed straight to retryWorkflow (its spend-limit bundle); kept
 * `unknown` here exactly as retryWorkflow's own signature does.
 */
export async function tryAgainFromSavePoint(
	db: D1Database,
	scope: Scope,
	input: { key: string },
	env?: unknown,
	ports?: TryAgainPorts,
): Promise<{ startedFrom: 'save-point' | 'plan'; summary: string }> {
	const workflow = await readWorkflow(db, scope);
	if (!canTryAgainFromSavePoint(workflow, await featuresFor(db, scope))) {
		throw new ScopeError(
			409,
			'NO_TRY_AGAIN',
			'Try-again from the last save point is offered only when a build stopped after three failed tries on a feature.',
		);
	}
	const features = await featuresFor(db, scope);
	const current = currentFeature(features)!;
	const summary = failureSummary(current, workflow?.detail ?? null);
	const target = previousSavePoint(features, current);
	// The existing rollback and the existing message-carrying retry, as ports so
	// the composition is verifiable without re-driving a whole build. They
	// default to the real functions (build-features.ts / build-workflow.ts).
	const rollback = ports?.rollback ?? ((featureId: string, key: string) => rollbackToFeature(db, scope, { featureId, key }));
	const retry = ports?.retry ?? ((key: string, request: string) => retryWorkflow(db, scope, key, request, env));
	// The active part (if any) is abandoned when we roll back / retry.
	await clearActivePart(db, scope).catch(() => {});
	if (target) {
		// Roll back to just after the previous feature passed, then retry from
		// the first re-queued feature carrying the summary.
		await rollback(target.featureId, `tryagain-rb:${input.key}`);
		await retry(`tryagain:${input.key}`, summary);
		return { startedFrom: 'save-point', summary };
	}
	// First feature: no earlier save point — start again from the plan.
	await retry(`tryagain:${input.key}`, summary);
	return { startedFrom: 'plan', summary };
}

/** The current plan's feature rows, or [] when there is no plan yet. */
async function featuresFor(db: D1Database, scope: Scope): Promise<BuildFeatureRow[]> {
	const workflow = await readWorkflow(db, scope);
	if (!workflow?.planId) return [];
	return listBuildFeatures(db, scope.projectId, workflow.planId);
}
