/**
 * Joining the parts into the app (plan part Q) — lane 13.
 *
 * When a module finishes (server/modules.ts calls the `onModuleFinished` hook),
 * the lead wires `mergeFinishedModule` in as that hook. It merges the finished
 * module into the app's single integration copy, ONE merge at a time per build
 * under the D1 integration lock (migration 0043), then runs the full checks on
 * the integration copy. Green makes a save point named "<A> + <B> merged"; red
 * matches the failure to the module that owns it, dispatches a repair to that
 * module's own copy and merges again, and after at most 2 rounds marks the
 * module "not merged" while the rest of the app keeps working.
 *
 * What makes the merge safe (plan review item 5): the module's folders are read
 * from its committed snapshot through Contree's INSPECT API — never a command —
 * and ONLY the module's folders (`src/server/<module>/**`, `src/screens/<module>/**`
 * and their tests) are copied. Anything the builder changed elsewhere is not
 * copied and is reported in a plain list. The in/out decision reuses the exact
 * area logic the part boundary uses (`areaFor` / `inArea` in part-manifests.ts),
 * so "the module's folders" means the same thing here as it does there.
 *
 * Everything that touches a running sandbox, the model (repair dispatch), the
 * check recipe and the save point is INJECTED through `deps`, so this file's
 * orchestration is tested end to end against the bun:sqlite D1 harness and a
 * fake inspect/driver with no running build, no real Durable Object and no
 * model turn. The lead supplies the real `deps` at wiring time.
 *
 * Team mode only, and only for a big app with more than one module: with
 * big-apps off or a single module, no module ever finishes this way and none of
 * this runs.
 */

import type { D1Database } from './auth.ts';
import type { Scope } from '@caddie/contracts';
import { type ArchitectureBlock, CORE_MODULE } from '@caddie/contracts';
import {
	type Area,
	type OutOfAreaChange,
	type PartManifest,
	type SnapshotReadPort,
	areaFor,
	buildManifest,
	inArea,
	normalizePath,
} from './part-manifests.ts';
import { getModule, listModules, setModuleStatus } from './module-slots.ts';

/** How many repair rounds a module gets before it is marked "not merged" (part Q). */
export const MAX_MERGE_REPAIR_ROUNDS = 2;

/** How long an acquired merge lock is held before a crashed holder's lock may be taken. */
export const MERGE_LOCK_TTL_MS = 10 * 60_000;

// --- the integration lock (migration 0043) -----------------------------------

const nowIso = (): string => new Date().toISOString();

/**
 * Acquire the per-build integration lock (plan part Q). One row per
 * (projectId, buildSeq) means a merge holds it; the primary key refuses a
 * second holder, so two concurrent merges on one build cannot both proceed. An
 * expired holder's lock (a crash mid-merge) is taken after its TTL. Returns
 * true when this caller now holds the lock.
 */
export async function acquireIntegrationLock(
	db: D1Database,
	projectId: string,
	buildSeq: number,
	holder: string,
	nowMs: number = Date.now(),
): Promise<boolean> {
	const stamp = new Date(nowMs).toISOString();
	// Clear a lapsed holder first, so a crashed merge never wedges the build.
	await db
		.prepare('delete from "integration_merge_locks" where "projectId" = ? and "buildSeq" = ? and "expiresAt" <= ?')
		.bind(projectId, buildSeq, stamp)
		.run();
	const expiresAt = new Date(nowMs + MERGE_LOCK_TTL_MS).toISOString();
	const res = (await db
		.prepare(
			'insert into "integration_merge_locks" ("projectId","buildSeq","holder","expiresAt","createdAt") values (?,?,?,?,?) ' +
				'on conflict ("projectId","buildSeq") do nothing',
		)
		.bind(projectId, buildSeq, holder, expiresAt, stamp)
		.run()) as { meta?: { changes?: number } };
	return (res.meta?.changes ?? 0) === 1;
}

/** Release the per-build integration lock (best-effort; an absent row is a no-op). */
export async function releaseIntegrationLock(db: D1Database, projectId: string, buildSeq: number): Promise<void> {
	await db.prepare('delete from "integration_merge_locks" where "projectId" = ? and "buildSeq" = ?').bind(projectId, buildSeq).run();
}

// --- the module's folders -----------------------------------------------------

/**
 * The combined area a module owns across its backend and frontend roles — the
 * folders `src/server/<module>/**`, `src/screens/<module>/**` and their tests
 * (part-manifests.ts `areaFor`). Core's frontend also owns `src/App.tsx`,
 * `src/main.tsx` and `src/styles.css`, which `areaFor` already folds in.
 */
export function moduleAreas(block: ArchitectureBlock, moduleId: string): Area[] {
	return [areaFor(block, 'backend', moduleId), areaFor(block, 'frontend', moduleId)];
}

/** Is a path inside this module's folders (either its backend or its frontend area)? */
export function inModule(areas: readonly Area[], path: string): boolean {
	return areas.some((area) => inArea(area, path));
}

// --- failure → owning module --------------------------------------------------

/** One failing check, as the injected check runner reports it. */
export interface CheckFailure {
	/** The check that failed (e.g. "behavior-tests", "contract-create", "server-starts"). */
	readonly check: string;
	/** The source file the failure points at, workspace-relative, when known. */
	readonly file?: string;
	/** The route id the failure points at, when known. */
	readonly route?: string;
	/** The raw output, kept for the repair receipt. */
	readonly output?: string;
}

/** The outcome of running the full checks on the integration copy. */
export interface IntegrationCheckResult {
	readonly passed: boolean;
	/** The failures, when red; empty when green. */
	readonly failures: readonly CheckFailure[];
}

/**
 * Which module owns a failing check. A failing FILE is matched by the same area
 * logic the merge uses (the module whose folders contain it); a failing ROUTE
 * is matched by the block's `routes[].module`. When neither resolves, the
 * failure is attributed to `core` — core carries the shell every module runs
 * in, so an unattributable failure is core's to repair. Returns the moduleId.
 */
export function ownerModuleOfFailure(block: ArchitectureBlock, failure: CheckFailure): string {
	if (failure.file) {
		const path = normalizePath(failure.file);
		for (const mod of block.modules) {
			if (inModule(moduleAreas(block, mod.id), path)) return mod.id;
		}
	}
	if (failure.route) {
		const route = block.routes.find((r) => r.id === failure.route);
		if (route) return route.module;
	}
	return CORE_MODULE;
}

// --- the deps the lead wires --------------------------------------------------

/**
 * Everything the merge needs from the running build, injected so the
 * orchestration is testable without a sandbox, a model or a real check run.
 */
export interface MergeDeps {
	/** The approved architecture block (its modules, routes and screens). */
	readonly block: ArchitectureBlock;
	/** Which build this is (0040's buildSeq); scopes the lock and the module board. */
	readonly buildSeq: number;
	/**
	 * A read port over the FINISHED MODULE's committed snapshot (its checkpoint
	 * image) — `part-snapshot.ts#snapshotReadPort(inspect, checkpointRef, root)`.
	 * The merge reads the module's folders through this.
	 */
	readonly readModuleSnapshot: (checkpointRef: string) => SnapshotReadPort & { image: string };
	/**
	 * A read port over the INTEGRATION copy's current snapshot, for the stray
	 * report (what the module changed OUTSIDE its folders, versus the app as it
	 * stands). Optional: when absent, a stray is reported purely from the
	 * module snapshot's out-of-folder files (every one counts as a stray).
	 */
	readonly readIntegrationSnapshot?: () => SnapshotReadPort & { image: string };
	/**
	 * Read one file's raw bytes from the module snapshot, base64, for the write.
	 * (`part-snapshot.ts` reads bytes through the same inspect image.)
	 */
	readonly readModuleFile: (checkpointRef: string, path: string) => Promise<string>;
	/** Write a batch of files into the integration copy in ONE commit (no command). */
	readonly writeIntegration: (files: ReadonlyArray<{ path: string; contentBase64: string }>) => Promise<void>;
	/** Run the full checks on the integration copy (install, tests, build, contracts, server start). */
	readonly runChecks: () => Promise<IntegrationCheckResult>;
	/** Make a save point on the integration copy with the given name; returns its ref. */
	readonly savePoint: (name: string) => Promise<string>;
	/** Dispatch a repair to a module's own copy (plan part Q); at-least-once. */
	readonly dispatchRepair: (input: { moduleId: string; failures: readonly CheckFailure[] }) => Promise<void>;
	/** How many repair rounds before "not merged" (default MAX_MERGE_REPAIR_ROUNDS). */
	readonly maxRepairRounds?: number;
	/** The lock holder label; defaults to the merging module's instance. */
	readonly lockHolder?: string;
	/** Injected clock, for deterministic lock-expiry tests. */
	readonly now?: () => number;
}

// --- the result ---------------------------------------------------------------

/** The plain per-module result of a merge (plan part Q step 3). */
export interface MergeResult {
	readonly moduleId: string;
	/** True when the module merged green; false when it ended "not merged". */
	readonly merged: boolean;
	/** The save point's name when merged, else null. */
	readonly savePoint: string | null;
	/** Files the builder changed OUTSIDE its folders — reported, never copied. */
	readonly strayFiles: string[];
	/** How many repair rounds were spent (0 when it merged first try). */
	readonly rounds: number;
	/** A plain reason, for the build card. */
	readonly reason: string;
	/** False only when the lock could not be taken (another merge holds it). */
	readonly acquiredLock: boolean;
}

// --- the stray report ---------------------------------------------------------

/**
 * The files the module's snapshot changed OUTSIDE its own folders, versus the
 * integration copy as it stands — reported, never copied (plan part Q step 1).
 * With no integration snapshot to diff against, every out-of-folder file in the
 * module snapshot is reported (the safe, strict reading).
 */
async function strayChanges(
	block: ArchitectureBlock,
	moduleId: string,
	moduleManifest: PartManifest,
	integrationManifest: PartManifest | null,
): Promise<string[]> {
	const areas = moduleAreas(block, moduleId);
	const base = integrationManifest ? new Map(integrationManifest.files.map((f) => [f.path, f.sha256])) : null;
	const strays: string[] = [];
	for (const file of moduleManifest.files) {
		if (inModule(areas, file.path)) continue; // in-folder: the builder's own work
		if (base) {
			const before = base.get(file.path);
			if (before !== undefined && before === file.sha256) continue; // unchanged vs the app
		}
		strays.push(file.path);
	}
	return [...new Set(strays)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// --- the save-point name ------------------------------------------------------

/**
 * The save-point name a green merge makes: the merged modules joined with
 * " + " then " merged" (plan part Q, e.g. "farms + feed merged"). It lists every
 * module already merged plus the one that just merged, ordered by `order` (the
 * block's declared module order) so the name is DETERMINISTIC — the board's row
 * order can tie on timestamp, the declared order never does.
 */
export async function mergedSavePointName(
	db: D1Database,
	projectId: string,
	buildSeq: number,
	justMerged: string,
	order?: readonly string[],
): Promise<string> {
	const modules = await listModules(db, projectId, buildSeq);
	const merged = new Set(modules.filter((m) => m.status === 'merged').map((m) => m.moduleId));
	merged.add(justMerged);
	const sequence = order && order.length > 0 ? order.filter((id) => merged.has(id)) : [...merged];
	// Any merged module the order list did not name (defensive) trails, sorted.
	for (const id of [...merged].sort()) if (!sequence.includes(id)) sequence.push(id);
	return `${sequence.join(' + ')} merged`;
}

// --- the merge ----------------------------------------------------------------

/**
 * Merge one finished module into the app, the hook the lead wires into
 * `onModuleFinished` (plan part Q). One merge at a time per build, under the
 * integration lock; copy only the module's folders; run the full checks; a
 * green save point, or up to 2 repair rounds then "not merged" with the rest of
 * the app left working.
 *
 * The signature the hook needs is `(db, scope, { runId, moduleId, checkpointRef })`
 * plus the injected `deps` (supplied in the lead's wiring closure). It never
 * throws for a red merge — a failed module is a RESULT ("not merged"), not an
 * error, so one module's failure never stops the build.
 */
export async function mergeFinishedModule(
	db: D1Database,
	scope: Scope,
	input: { runId: string; moduleId: string; checkpointRef: string },
	deps: MergeDeps,
): Promise<MergeResult> {
	const { block, buildSeq } = deps;
	const holder = deps.lockHolder ?? `${scope.projectId}:${buildSeq}:${input.moduleId}`;
	const nowMs = deps.now ? deps.now() : Date.now();

	const got = await acquireIntegrationLock(db, scope.projectId, buildSeq, holder, nowMs);
	if (!got) {
		return {
			moduleId: input.moduleId,
			merged: false,
			savePoint: null,
			strayFiles: [],
			rounds: 0,
			reason: 'Another part is merging right now; this one will merge when the lock is free.',
			acquiredLock: false,
		};
	}

	try {
		const maxRounds = deps.maxRepairRounds ?? MAX_MERGE_REPAIR_ROUNDS;
		const areas = moduleAreas(block, input.moduleId);
		let strayFiles: string[] = [];
		let rounds = 0;

		// Round 0 is the initial merge + checks; each red round dispatches one
		// repair and tries again, up to maxRounds repairs.
		for (;;) {
			// 1. Read the module's folders from its snapshot and write them in one batch.
			const modulePort = deps.readModuleSnapshot(input.checkpointRef);
			const moduleManifest = await buildManifest(modulePort);
			const integrationManifest = deps.readIntegrationSnapshot ? await buildManifest(deps.readIntegrationSnapshot()) : null;
			strayFiles = await strayChanges(block, input.moduleId, moduleManifest, integrationManifest);

			const inFolder = moduleManifest.files.filter((f) => inModule(areas, f.path));
			const batch: { path: string; contentBase64: string }[] = [];
			for (const file of inFolder) {
				batch.push({ path: file.path, contentBase64: await deps.readModuleFile(input.checkpointRef, file.path) });
			}
			await deps.writeIntegration(batch);

			// 2. Run the full checks on the integration copy.
			const checks = await deps.runChecks();
			if (checks.passed) {
				await setModuleStatus(db, scope.projectId, buildSeq, input.moduleId, 'merged', { checkpointRef: input.checkpointRef });
				const name = await mergedSavePointName(db, scope.projectId, buildSeq, input.moduleId, block.modules.map((m) => m.id));
				await deps.savePoint(name);
				return {
					moduleId: input.moduleId,
					merged: true,
					savePoint: name,
					strayFiles,
					rounds,
					reason: strayFiles.length === 0 ? `Merged into the app.` : `Merged into the app; ${strayFiles.length} file(s) the builder changed outside its folders were left out.`,
					acquiredLock: true,
				};
			}

			// 3. Red: out of repair rounds → "not merged", the rest keeps working.
			if (rounds >= maxRounds) {
				await setModuleStatus(db, scope.projectId, buildSeq, input.moduleId, 'not-merged', { checkpointRef: input.checkpointRef });
				const owners = [...new Set(checks.failures.map((f) => ownerModuleOfFailure(block, f)))];
				return {
					moduleId: input.moduleId,
					merged: false,
					savePoint: null,
					strayFiles,
					rounds,
					reason: `Couldn't make "${input.moduleId}" work with the rest after ${maxRounds} tries (checks failed in: ${owners.join(', ')}). The rest of your app still works.`,
					acquiredLock: true,
				};
			}

			// Match each failure to its owning module and dispatch a repair to its
			// own copy, then try the merge again.
			const byOwner = new Map<string, CheckFailure[]>();
			for (const failure of checks.failures) {
				const owner = ownerModuleOfFailure(block, failure);
				(byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)!).push(failure);
			}
			for (const [owner, failures] of byOwner) {
				await deps.dispatchRepair({ moduleId: owner, failures });
			}
			rounds += 1;
		}
	} finally {
		await releaseIntegrationLock(db, scope.projectId, buildSeq);
	}
}

/**
 * A convenience over `mergeFinishedModule` matching the `onModuleFinished` hook
 * exactly: `(db, scope, { runId, moduleId, checkpointRef })`. The lead binds
 * `deps` in a closure and passes this as the hook, so `server/modules.ts` keeps
 * calling the one stable-signature hook.
 */
export function makeMergeHook(deps: MergeDeps) {
	return (db: D1Database, scope: Scope, input: { runId: string; moduleId: string; checkpointRef: string }): Promise<void> =>
		mergeFinishedModule(db, scope, input, deps).then(() => undefined);
}

export type { OutOfAreaChange };
