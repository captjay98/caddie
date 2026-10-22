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

/**
 * How long an acquired merge lock is held before a crashed holder's lock may be
 * taken (plan review item 4). A single merge can run several repair ROUNDS, and
 * one round can outlast the old 10-minute window, so the TTL is 30 minutes and
 * the holder REFRESHES it before each step (see `refreshIntegrationLock`); the
 * TTL is the crash fallback, not the normal merge budget.
 */
export const MERGE_LOCK_TTL_MS = 30 * 60_000;

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

/**
 * Extend THIS holder's lock by a fresh TTL (plan review item 4). A merge round
 * can take longer than the TTL; without a refresh the lock would lapse
 * mid-merge, let a second merge in, and have the first merge's `release` delete
 * the second's lock. `refreshIntegrationLock` pushes `expiresAt` out only while
 * the given `holder` still owns the row — a stale holder whose lock was already
 * taken over refreshes nothing. Returns true when the holder's lock was extended.
 */
export async function refreshIntegrationLock(
	db: D1Database,
	projectId: string,
	buildSeq: number,
	holder: string,
	nowMs: number = Date.now(),
): Promise<boolean> {
	const expiresAt = new Date(nowMs + MERGE_LOCK_TTL_MS).toISOString();
	const res = (await db
		.prepare('update "integration_merge_locks" set "expiresAt" = ? where "projectId" = ? and "buildSeq" = ? and "holder" = ?')
		.bind(expiresAt, projectId, buildSeq, holder)
		.run()) as { meta?: { changes?: number } };
	return (res.meta?.changes ?? 0) === 1;
}

/**
 * Release the per-build integration lock, but ONLY when `holder` still owns it
 * (plan review item 4). If this holder's lock already lapsed and another merge
 * took it over, the row now names the new holder, so an unconditional delete
 * would wrongly free the new holder's lock. Scoping the delete to `holder`
 * means a stale releaser is a no-op and the live holder keeps the lock.
 * Best-effort; an absent row is a no-op.
 */
export async function releaseIntegrationLock(
	db: D1Database,
	projectId: string,
	buildSeq: number,
	holder: string,
): Promise<void> {
	await db
		.prepare('delete from "integration_merge_locks" where "projectId" = ? and "buildSeq" = ? and "holder" = ?')
		.bind(projectId, buildSeq, holder)
		.run();
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
	/**
	 * Snapshot the integration copy as it stands, returning a ref the merge can
	 * restore to (plan review item 2). The merge takes this BEFORE its first
	 * write so a module that ends "not merged" can be rolled back out of the
	 * integration copy — otherwise its half-merged files stay and poison every
	 * later merge. Optional: when absent, no rollback is taken (the restore is a
	 * no-op), which is only safe when the caller guarantees an isolated copy.
	 */
	readonly snapshotIntegration?: () => Promise<string>;
	/** Restore the integration copy to a ref taken by `snapshotIntegration` (item 2). */
	readonly restoreIntegration?: (ref: string) => Promise<void>;
	/** Run the full checks on the integration copy (install, tests, build, contracts, server start). */
	readonly runChecks: () => Promise<IntegrationCheckResult>;
	/** Make a save point on the integration copy with the given name; returns its ref. */
	readonly savePoint: (name: string) => Promise<string>;
	/**
	 * Dispatch a repair to a module's own copy (plan part Q); at-least-once.
	 * Returns the repaired module's NEW committed checkpoint ref, so the next
	 * merge round reads the FIXED snapshot instead of the stale one (plan review
	 * item 1). `null` means the repair produced no new snapshot — the module's
	 * current ref is kept and re-read, which can never land a fix, so the real
	 * wiring always returns the new ref on a repair that committed.
	 */
	readonly dispatchRepair: (input: { moduleId: string; failures: readonly CheckFailure[] }) => Promise<string | null>;
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
	/**
	 * True when this module did not merge itself but another holder's drain will
	 * (plan review item 3): the module was recorded "passed" and left for the
	 * holder, which merges every waiting module before it releases. A queued
	 * result is NOT a failure — the module merges, just on the holder's turn.
	 */
	readonly queued?: boolean;
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
 * Merge ONE module into the integration copy, under a lock the caller already
 * holds (plan review items 1, 2, 4, 5). This is the per-module body the drain
 * runs for each waiting module; it never touches the lock's lifecycle (acquire
 * or release) — the drain owns that — but it REFRESHES the lock before each
 * step so a long repair round cannot let the TTL lapse (item 4).
 *
 * The round loop reads every module in `refs` from its CURRENT ref and writes
 * their folders, so a repaired module's new snapshot is what round N+1 copies
 * (item 1). It snapshots the integration copy before the first write and, on a
 * module that ends "not merged", restores that snapshot so the failed module's
 * files never linger (item 2). On green it makes the save point FIRST and only
 * then marks the module "merged" — if the save point throws, the module stays
 * "passed" and is retried, never marked merged without its save point (item 5).
 */
async function mergeOneModule(
	db: D1Database,
	scope: Scope,
	deps: MergeDeps,
	holder: string,
	moduleId: string,
	startRef: string,
): Promise<MergeResult> {
	const { block, buildSeq } = deps;
	const maxRounds = deps.maxRepairRounds ?? MAX_MERGE_REPAIR_ROUNDS;
	const areas = moduleAreas(block, moduleId);
	const now = () => (deps.now ? deps.now() : Date.now());

	// item 1: a ref per module, so a repaired module is re-read from its FIXED
	// snapshot each round. It starts with the merging module at its passed ref.
	const refs = new Map<string, string>([[moduleId, startRef]]);

	// item 2: the integration copy as it stands, to roll back a "not merged".
	const rollback = deps.snapshotIntegration ? await deps.snapshotIntegration() : null;

	let strayFiles: string[] = [];
	let rounds = 0;

	for (;;) {
		// item 4: extend the lock before each round; a repair round can outlast
		// the TTL, and a lapsed lock would let a second merge corrupt this one.
		await refreshIntegrationLock(db, scope.projectId, buildSeq, holder, now());

		// 1. Read every tracked module's folders from its CURRENT ref and write
		//    them in one batch. The merging module's own files decide strays.
		const batch: { path: string; contentBase64: string }[] = [];
		for (const [id, ref] of refs) {
			const modulePort = deps.readModuleSnapshot(ref);
			const moduleManifest = await buildManifest(modulePort);
			if (id === moduleId) {
				const integrationManifest = deps.readIntegrationSnapshot ? await buildManifest(deps.readIntegrationSnapshot()) : null;
				strayFiles = await strayChanges(block, moduleId, moduleManifest, integrationManifest);
			}
			const modAreas = id === moduleId ? areas : moduleAreas(block, id);
			for (const file of moduleManifest.files.filter((f) => inModule(modAreas, f.path))) {
				batch.push({ path: file.path, contentBase64: await deps.readModuleFile(ref, file.path) });
			}
		}
		await deps.writeIntegration(batch);

		// 2. Run the full checks on the integration copy.
		await refreshIntegrationLock(db, scope.projectId, buildSeq, holder, now());
		const checks = await deps.runChecks();
		if (checks.passed) {
			// item 5: the save point FIRST, then "merged". A throw here leaves the
			// module "passed" (retried), never merged without its save point.
			const name = await mergedSavePointName(db, scope.projectId, buildSeq, moduleId, block.modules.map((m) => m.id));
			await deps.savePoint(name);
			// item 1: persist each repaired module's new ref on its row, so a later
			// read of the board sees the fixed snapshot, not the stale one.
			for (const [id, ref] of refs) {
				await setModuleStatus(db, scope.projectId, buildSeq, id, id === moduleId ? 'merged' : 'passed', { checkpointRef: ref });
			}
			return {
				moduleId,
				merged: true,
				savePoint: name,
				strayFiles,
				rounds,
				reason:
					strayFiles.length === 0
						? `Merged into the app.`
						: `Merged into the app; ${strayFiles.length} file(s) the builder changed outside its folders were left out.`,
				acquiredLock: true,
			};
		}

		// 3. Red: out of repair rounds → "not merged", rolled back out of the copy.
		if (rounds >= maxRounds) {
			if (rollback !== null && deps.restoreIntegration) await deps.restoreIntegration(rollback);
			await setModuleStatus(db, scope.projectId, buildSeq, moduleId, 'not-merged', { checkpointRef: refs.get(moduleId)! });
			const owners = [...new Set(checks.failures.map((f) => ownerModuleOfFailure(block, f)))];
			return {
				moduleId,
				merged: false,
				savePoint: null,
				strayFiles,
				rounds,
				reason: `Couldn't make "${moduleId}" work with the rest after ${maxRounds} tries (checks failed in: ${owners.join(', ')}). The rest of your app still works.`,
				acquiredLock: true,
			};
		}

		// Match each failure to its owning module, dispatch a repair to its own
		// copy, and record the NEW ref so the next round reads the fix (item 1).
		await refreshIntegrationLock(db, scope.projectId, buildSeq, holder, now());
		const byOwner = new Map<string, CheckFailure[]>();
		for (const failure of checks.failures) {
			const owner = ownerModuleOfFailure(block, failure);
			(byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)!).push(failure);
		}
		for (const [owner, failures] of byOwner) {
			const newRef = await deps.dispatchRepair({ moduleId: owner, failures });
			if (newRef) refs.set(owner, newRef);
			else if (!refs.has(owner)) refs.set(owner, refs.get(moduleId)!);
		}
		rounds += 1;
	}
}

/**
 * Merge one finished module into the app, the hook the lead wires into
 * `onModuleFinished` (plan part Q). One merge at a time per build, under the
 * integration lock; copy only the module's folders; run the full checks; a
 * green save point, or up to 2 repair rounds then "not merged" with the rest of
 * the app left working.
 *
 * Lock contention never loses a module (plan review item 3): the finished
 * module is recorded "passed" (finished, awaiting merge) with its checkpoint
 * ref BEFORE the lock is tried. The caller that holds the lock DRAINS every
 * "passed" module — in the block's declared order — before it releases, and
 * re-checks after release in case another module finished during the drain. So
 * a module that could not take the lock is merged by whoever holds it, not
 * dropped: this call returns that module's own merge result, or `{ queued:
 * true }` when another holder will merge it.
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
	const now = () => (deps.now ? deps.now() : Date.now());

	// item 3: record the module "passed" with its ref FIRST, so whoever holds the
	// lock will drain it even if this call cannot take the lock itself.
	await setModuleStatus(db, scope.projectId, buildSeq, input.moduleId, 'passed', { checkpointRef: input.checkpointRef });

	const got = await acquireIntegrationLock(db, scope.projectId, buildSeq, holder, now());
	if (!got) {
		// Another merge holds the lock; its drain will merge this module.
		return {
			moduleId: input.moduleId,
			merged: false,
			savePoint: null,
			strayFiles: [],
			rounds: 0,
			reason: 'Another part is merging right now; this one will merge when the lock is free.',
			acquiredLock: false,
			queued: true,
		};
	}

	const results = new Map<string, MergeResult>();
	try {
		// Drain every "passed" module in block order, re-checking after each sweep
		// for a module that finished mid-drain, so none is left behind (item 3).
		for (;;) {
			const modules = await listModules(db, scope.projectId, buildSeq);
			const order = block.modules.map((m) => m.id);
			const waiting = modules
				.filter((m) => m.status === 'passed' && m.checkpointRef !== null && !results.has(m.moduleId))
				.sort((a, b) => order.indexOf(a.moduleId) - order.indexOf(b.moduleId));
			if (waiting.length === 0) break;
			for (const m of waiting) {
				results.set(m.moduleId, await mergeOneModule(db, scope, deps, holder, m.moduleId, m.checkpointRef!));
			}
		}
	} finally {
		await releaseIntegrationLock(db, scope.projectId, buildSeq, holder);
	}

	// This call's own module: either the drain merged it here, or (a race where
	// another holder took it first) it is already resolved — report queued.
	return (
		results.get(input.moduleId) ?? {
			moduleId: input.moduleId,
			merged: false,
			savePoint: null,
			strayFiles: [],
			rounds: 0,
			reason: 'Another part merged this one as part of its batch.',
			acquiredLock: true,
			queued: true,
		}
	);
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
