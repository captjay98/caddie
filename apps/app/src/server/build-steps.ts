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
	SMALL_APP_MODULE,
	areaFor,
	buildManifest,
	diffAgainstManifest,
} from './part-manifests.ts';

/**
 * The partKey under which a module's active-part pointer is stored. Part P runs
 * up to 4 module builders at once, each on its OWN copy of the app, but they
 * share one project row — so the pointer is keyed BY MODULE, never one global
 * `__active__` that two module builders would overwrite. A small app has one
 * module (SMALL_APP_MODULE), so its pointer is `__active__:app`.
 */
function activeKey(moduleId: string): string {
	return `__active__:${moduleId}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

/** The snapshot-write surface restore_files needs. Paths are workspace-relative. */
export interface SnapshotWritePort {
	/** Read a file's bytes (base64) from the START image. */
	readFromStart(path: string): Promise<string>;
	/** Write many files into the current session in one commit. */
	writeBatch(files: Array<{ path: string; contentBase64: string }>): Promise<void>;
	/**
	 * Delete files from the current session WITHOUT a model-influenced command,
	 * if the driver can. OPTIONAL: the real SandboxDriver has no non-command
	 * delete (every write commits through a `true` run; a delete would need a
	 * model-visible `rm`), so its port omits this and `restoreFiles` REPORTS an
	 * out-of-area ADD for the builder to remove, rather than running a command.
	 */
	deleteBatch?(paths: string[]): Promise<void>;
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
 * Resolve the module a `moduleId?` input names, defaulting a small (one-module)
 * app to SMALL_APP_MODULE. A big app requires an explicit, real module id.
 */
function resolveModuleId(block: ArchitectureBlock, moduleId?: string): string {
	const bigApp = block.modules.length > 1;
	if (!bigApp) return moduleId ?? SMALL_APP_MODULE;
	if (!moduleId) throw new ScopeError(400, 'MODULE_REQUIRED', 'This is a big app: a module id is required.');
	if (!block.modules.some((m) => m.id === moduleId))
		throw new ScopeError(400, 'NO_SUCH_MODULE', `"${moduleId}" is not a module of this app.`);
	return moduleId;
}

/**
 * Start a part: record the source-folder manifest from the committed snapshot
 * and mark the active role+module. The coordinator / module builder MUST call
 * this before delegating a feature in team mode. `role` names the build role
 * whose area is active; `moduleId` is required for a big (multi-module) app.
 *
 * The active pointer is keyed by MODULE (`__active__:<moduleId>`), so up to 4
 * module builders working their own copies at once (part P) each keep their own
 * active part instead of overwriting a single project-wide one.
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
	const moduleId = resolveModuleId(block, input.moduleId);
	const area = areaFor(block, input.role, moduleId);
	const manifest = await buildManifest(port);
	const stored: StoredPart = {
		featureId: input.featureId,
		role: area.role,
		moduleId: area.moduleId,
		startImage: port.image,
		manifest,
	};
	// The manifest is also kept under a per-feature key for history; the active
	// pointer is keyed by MODULE so parallel module builders never collide.
	await saveStoredPart(db, scope.projectId, `feature:${area.moduleId}:${input.featureId}`, stored);
	await saveStoredPart(db, scope.projectId, activeKey(area.moduleId), stored);
	return { started: true, role: area.role, moduleId: area.moduleId, files: manifest.files.length };
}

/**
 * The active part for a MODULE, or null when none is started for it (team mode
 * off, or between parts). A small app passes no moduleId (SMALL_APP_MODULE is
 * assumed); a big app names the module whose part is being checked.
 */
export async function activePart(db: D1Database, scope: Scope, moduleId?: string): Promise<ActivePart | null> {
	// Resolve the module without needing the block when none is stored: a plain
	// small-app lookup (SMALL_APP_MODULE) must not require a design to exist.
	const moduleKey = moduleId ?? SMALL_APP_MODULE;
	const stored = await loadStoredPart(db, scope.projectId, activeKey(moduleKey));
	if (!stored) return null;
	const block = await readApprovedBlock(db, scope).catch(() => null);
	// Rebuild the area from the stored role+module. If the design is gone, fall
	// back to an empty allow list; the manifest diff still catches changes.
	const area = block ? areaFor(block, stored.role, stored.moduleId) : { role: stored.role, moduleId: stored.moduleId, allow: [] as string[] };
	return { featureId: stored.featureId, role: stored.role, moduleId: stored.moduleId, area, startImage: stored.startImage, manifest: stored.manifest };
}

/**
 * Compare the CURRENT snapshot with a module's active part start-of-part
 * manifest and return every out-of-area change. An empty list means the part
 * stayed in its area. Used by both finish_part and finish_feature.
 */
export async function checkPartBoundary(
	db: D1Database,
	scope: Scope,
	port: SnapshotReadPort,
	moduleId?: string,
): Promise<{ active: false } | { active: true; outOfArea: OutOfAreaChange[]; part: ActivePart }> {
	const part = await activePart(db, scope, moduleId);
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
	moduleId?: string,
): Promise<{ ok: true } | { ok: false; outOfArea: OutOfAreaChange[]; message: string }> {
	const result = await checkPartBoundary(db, scope, port, moduleId);
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
 * restore_files: act ONLY on the paths the boundary check currently reports
 * out of area (part D). For each requested path:
 *   - 'modified' / 'deleted' out-of-area → write the START-image content back;
 *   - 'added' out-of-area → delete it IF the write port can delete without a
 *     model-influenced command, otherwise REPORT it (the builder removes it);
 *   - anything else (in-area, unchanged, or generated/protected) → nothing,
 *     because the part check does not report it and restore must not touch a
 *     file the builder is legitimately changing.
 *
 * So `restore_files(['caddie/contract.ts'])` (generated, never out-of-area)
 * and an in-area path both change nothing. Both ports read/write the same
 * module's active part (the read port rebuilds the current manifest; the write
 * port reaches the start image and the current session).
 */
export async function restoreFiles(
	db: D1Database,
	scope: Scope,
	ports: { read: SnapshotReadPort; write: SnapshotWritePort },
	paths: string[],
	moduleId?: string,
): Promise<{ restored: string[]; deleted: string[]; reported: string[]; skipped: string[] }> {
	const boundary = await checkPartBoundary(db, scope, ports.read, moduleId);
	if (!boundary.active)
		throw new ScopeError(409, 'NO_ACTIVE_PART', 'No part is in progress, so there is nothing to restore.');
	// What the part check CURRENTLY reports out of area, by path.
	const outKind = new Map(boundary.outOfArea.map((c) => [c.path, c.kind] as const));
	const restored: string[] = [];
	const deleted: string[] = [];
	const reported: string[] = [];
	const skipped: string[] = [];
	const writeBatch: Array<{ path: string; contentBase64: string }> = [];
	const deleteBatch: string[] = [];
	for (const raw of paths) {
		const path = raw.replaceAll('\\', '/').replace(/^\.\//, '');
		const kind = outKind.get(path);
		if (kind === undefined) {
			// Not currently out of area: an in-area change, an unchanged file, or
			// a generated/protected path. Restore leaves it alone.
			skipped.push(path);
			continue;
		}
		if (kind === 'modified' || kind === 'deleted') {
			writeBatch.push({ path, contentBase64: await ports.write.readFromStart(path) });
			restored.push(path);
		} else {
			// 'added' out of area: delete only without a model-influenced command.
			if (ports.write.deleteBatch) {
				deleteBatch.push(path);
				deleted.push(path);
			} else {
				reported.push(path);
			}
		}
	}
	if (writeBatch.length > 0) await ports.write.writeBatch(writeBatch);
	if (deleteBatch.length > 0) await ports.write.deleteBatch!(deleteBatch);
	return { restored, deleted, reported, skipped };
}

/** Clear a module's active-part pointer (a feature finished cleanly, or a build reset). */
export async function clearActivePart(db: D1Database, scope: Scope, moduleId?: string): Promise<void> {
	await db
		.prepare('delete from "part_manifests" where "projectId" = ? and "partKey" = ?')
		.bind(scope.projectId, activeKey(moduleId ?? SMALL_APP_MODULE))
		.run();
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

/** A workflow snapshot shape the gate needs: phase, blocker detail, team mode. */
interface TryAgainWorkflow {
	phase: string;
	detail: string | null;
	/** 1 when the build is in team mode. Try-again is team mode only (part F). */
	teamMode?: number | null;
}

/**
 * Is the build stopped AFTER 3 failed tries on a feature — the only moment the
 * Try-again button shows? Pure, so it is unit-tested directly.
 *
 * TEAM MODE ONLY (review item 1): false unless the workflow's teamMode = 1, so
 * with team mode off nothing changes and the route refuses. Also requires: the
 * build is `blocked` (Caddie stopped it, not a user Stop — a user Stop carries
 * the STOP_SENTINEL detail), AND the current (first not-passed) feature has
 * reached the repair pause threshold of failed tries.
 */
export function canTryAgainFromSavePoint(
	workflow: TryAgainWorkflow | null,
	features: readonly BuildFeatureRow[],
): boolean {
	if (!workflow || workflow.phase !== 'blocked') return false;
	if (Number(workflow.teamMode ?? 0) !== 1) return false; // team mode only
	if ((workflow.detail ?? '').startsWith(STOP_SENTINEL)) return false;
	const current = currentFeature(features);
	if (!current) return false; // every feature passed — nothing to try again
	return current.attempts >= REPAIR_PAUSE_THRESHOLD;
}

/** One failed repair round for the stopped feature, as the ledger stored it. */
export interface FailedRound {
	issue: string;
	detail: string | null;
}

/** About this many characters of summary (the title + try count are always kept). */
const SUMMARY_CHAR_BUDGET = 600;

/**
 * The summary of what failed, built from the CHECK RECEIPTS (review item 2):
 * the stopped feature's failed repair rounds in run_rounds (round
 * 'repair_attempt', outcome 'failed', issue '<featureId>:<check>' or
 * '<featureId>:new-tests'; `detail` is the plain check sentence
 * coordinator-host writes). Newest first, de-duplicated by sentence, at most 3,
 * about 600 characters max — always keeping the title and the try count. The
 * blocker ('could not get the app checks passing after three attempts') names
 * nothing, so it is NOT used.
 */
export function failureSummary(feature: BuildFeatureRow, failedRounds: readonly FailedRound[]): string {
	const base = `Trying “${feature.title}” again from the last save point after ${feature.attempts} failed ${feature.attempts === 1 ? 'try' : 'tries'}.`;
	// Newest first (the caller orders newest→oldest), de-duplicated, at most 3.
	const seen = new Set<string>();
	const sentences: string[] = [];
	for (const round of failedRounds) {
		const detail = (round.detail ?? '').trim();
		if (!detail || seen.has(detail)) continue;
		seen.add(detail);
		sentences.push(detail);
		if (sentences.length >= 3) break;
	}
	if (sentences.length === 0) return base;
	// Keep base in full; append as many whole check sentences as the budget fits.
	let summary = `${base} What failed last time: `;
	const kept: string[] = [];
	for (const sentence of sentences) {
		const candidate = [...kept, sentence].join(' ');
		if ((summary + candidate).length > SUMMARY_CHAR_BUDGET && kept.length > 0) break;
		kept.push(sentence);
	}
	return `${summary}${kept.join(' ')}`.slice(0, Math.max(base.length, SUMMARY_CHAR_BUDGET));
}

/**
 * The stopped feature's failed repair rounds from run_rounds, newest first.
 * Matches both issue shapes coordinator-host writes for one feature:
 * `<featureId>:<check>` and `<featureId>:new-tests`.
 */
async function failedRoundsFor(
	db: D1Database,
	scope: Scope,
	runId: string,
	featureId: string,
): Promise<FailedRound[]> {
	const rows = (
		await db
			.prepare(
				'select "issue","detail" from "run_rounds" where "projectId" = ? and "runId" = ? and "round" = \'repair_attempt\' and "outcome" = \'failed\' and ("issue" = ? or "issue" like ?) order by "createdAt" desc, "id" desc',
			)
			.bind(scope.projectId, runId, `${featureId}:new-tests`, `${featureId}:%`)
			.all<{ issue: string; detail: string | null }>()
	).results ?? [];
	return rows.map((r) => ({ issue: String(r.issue), detail: r.detail == null ? null : String(r.detail) }));
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
 * then Retry carrying the failure summary built from the check receipts.
 * Idempotent on `key`. TEAM MODE ONLY — the gate refuses with team mode off.
 * The host (the Try-again route) calls this; it composes the existing,
 * separately-tested rollback and retry rather than reimplementing either.
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
	const features = await featuresFor(db, scope);
	if (!canTryAgainFromSavePoint(workflow, features)) {
		throw new ScopeError(
			409,
			'NO_TRY_AGAIN',
			'Try-again from the last save point is offered only when a team-mode build stopped after three failed tries on a feature.',
		);
	}
	const current = currentFeature(features)!;
	const failedRounds = workflow?.runId
		? await failedRoundsFor(db, scope, workflow.runId, current.featureId)
		: [];
	const summary = failureSummary(current, failedRounds);
	const target = previousSavePoint(features, current);
	// The existing rollback and the existing message-carrying retry, as ports so
	// the composition is verifiable without re-driving a whole build. They
	// default to the real functions (build-features.ts / build-workflow.ts).
	const rollback = ports?.rollback ?? ((featureId: string, key: string) => rollbackToFeature(db, scope, { featureId, key }));
	const retry = ports?.retry ?? ((key: string, request: string) => retryWorkflow(db, scope, key, request, env));
	// The active part (if any) is abandoned when we roll back / retry. Try-again
	// runs only after the build stopped (no module builder is live), so clearing
	// the default pointer is enough; a big-app retry re-plans from the top.
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
