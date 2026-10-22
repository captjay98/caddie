/**
 * Module orchestration (plan part P) — lane 12.
 *
 * The host side of building a big app with several builders at once: start the
 * modules whose dependencies are finished (in order), dispatch a ModuleBuilder
 * for each, finish a module at its last save point, keep going when one stops,
 * and offer a per-module "try again". The slot + row storage is in
 * `server/module-slots.ts`; the ModuleBuilder agent is `agents/module-builder.ts`.
 *
 * Team mode only, and only for a BIG app with more than one module: the caller
 * (the coordinator host, lane 1's wiring) invokes `startReadyModules` after the
 * core foundation save point, and `finishModule` / `retryModule` as each
 * module's build settles. With big-apps off or a single module, none of this
 * runs and today's single-builder loop is unchanged.
 *
 * Dispatch is Flue's at-least-once `dispatch(ModuleBuilder, { id, message,
 * initialData })` keyed by the module's instance id
 * `<projectId>:<buildSeq>:<moduleId>` (plan part P). Starting the same module
 * twice with the same id is harmless — the slot take returns `already-held` and
 * the dispatch joins the running instance — so a replay never doubles a module.
 */

import type { D1Database } from './auth.ts';
import type { Scope } from '@caddie/contracts';
import {
	type ModuleRow,
	type ModuleStatus,
	getModule,
	listModules,
	moduleInstanceId,
	releaseSlot,
	setModuleStatus,
	takeSlot,
} from './module-slots.ts';

/** The module scope a ModuleBuilder builds under — its id and its features. */
export interface ModuleBuildScope {
	readonly moduleId: string;
	readonly features: readonly string[];
}

/**
 * The hook lane 13 (part Q) replaces with the real merge. Until then, a
 * finished module counts as merged (see `finishModule`), so the signature MUST
 * stay stable: `(db, scope, { runId, moduleId, checkpointRef })`. The default
 * implementation is a no-op — merging is lane 13's, and part P only records the
 * save point and calls this one hook.
 */
export type OnModuleFinished = (
	db: D1Database,
	scope: Scope,
	input: { runId: string; moduleId: string; checkpointRef: string },
) => Promise<void> | void;

/** The default hook: nothing. Lane 13 passes its merge in `finishModule`'s opts. */
export const noopOnModuleFinished: OnModuleFinished = () => {};

/**
 * The dispatch seam: start (or continue) a ModuleBuilder instance. The real
 * wiring passes Flue's `dispatch(ModuleBuilder, …)`; tests pass a fake that
 * records the calls, so the orchestration is verifiable without a running
 * runtime. At-least-once: the same `instanceId` dispatched twice is harmless.
 */
export type DispatchModuleBuilder = (input: {
	instanceId: string;
	moduleId: string;
	features: readonly string[];
	message: string;
}) => Promise<void> | void;

/** The message a ModuleBuilder dispatch carries (part P). Plain, deterministic. */
export function moduleBuilderMessage(moduleId: string): string {
	return `Build the "${moduleId}" module: its features only, backend then frontend, its area, its tests and contract checks. Finish each feature with finish_feature; when all of its features pass, the module is done.`;
}

// --- what a module's dependencies tell us ------------------------------------

/** A module is READY to start when every module it depends on is finished. */
function isFinished(status: ModuleStatus): boolean {
	// A module counts as done for a dependent when it has passed or merged (the
	// merge is lane 13's; until then finished === passed, see finishModule).
	return status === 'passed' || status === 'merged';
}

/**
 * The modules that may start now: `pending`, with every dependency finished,
 * in the seeded order. A module whose dependency STOPPED or FAILED is NOT
 * ready — it never becomes ready, so the build ends partly built (a dependent
 * of a stopped module cannot be built). Core (no dependsOn) is always ready.
 */
export function readyModules(modules: readonly ModuleRow[]): ModuleRow[] {
	const byId = new Map(modules.map((m) => [m.moduleId, m]));
	return modules.filter((m) => {
		if (m.status !== 'pending') return false;
		return m.dependsOn.every((dep) => {
			const d = byId.get(dep);
			return d ? isFinished(d.status) : false;
		});
	});
}

// --- starting modules --------------------------------------------------------

/**
 * Start every module that is ready and can take a slot, in dependency order
 * (plan part P step 2). For each, in order: take a builder slot (D12 caps); if
 * none is free, stop (the remaining ready modules wait for a slot to free);
 * else mark it `building`, record its own copy's session key, and dispatch a
 * ModuleBuilder on its instance id. Returns the modules actually started.
 *
 * `latestMergedSave` is the save point each module's copy is restored from (the
 * latest merged save point — the foundation, then each merge as it lands); the
 * caller supplies it from the build state. A module keeps its slot until it
 * finishes, stops or fails.
 */
export async function startReadyModules(
	db: D1Database,
	scope: Scope,
	input: {
		runId: string;
		buildSeq: number;
		latestMergedSave: string;
		dispatch: DispatchModuleBuilder;
		/** The feature ids a module owns (injected so this module needs no contracts dep). */
		features: (moduleId: string) => readonly string[];
	},
): Promise<ModuleRow[]> {
	const started: ModuleRow[] = [];
	// Re-read the board between takes so each take sees the slots the previous
	// one held (the cap is per-build and per-Caddie).
	for (;;) {
		const modules = await listModules(db, scope.projectId, input.buildSeq);
		const ready = readyModules(modules);
		const next = ready.find((m) => !started.some((s) => s.moduleId === m.moduleId));
		if (!next) break;
		const slot = await takeSlot(db, scope.projectId, input.buildSeq, next.moduleId);
		// build-full / caddie-full: this module (and the rest) wait for a slot.
		if (slot.outcome === 'build-full' || slot.outcome === 'caddie-full') break;
		const instanceId = moduleInstanceId(scope.projectId, input.buildSeq, next.moduleId);
		const sessionKey = `module:${input.runId}:${next.moduleId}`;
		await setModuleStatus(db, scope.projectId, input.buildSeq, next.moduleId, 'building', {
			sessionKey,
			builderId: instanceId,
			checkpointRef: input.latestMergedSave,
		});
		await input.dispatch({
			instanceId,
			moduleId: next.moduleId,
			features: input.features(next.moduleId),
			message: moduleBuilderMessage(next.moduleId),
		});
		const row = await getModule(db, scope.projectId, input.buildSeq, next.moduleId);
		if (row) started.push(row);
	}
	return started;
}

// --- finishing a module ------------------------------------------------------

/**
 * finish_module (plan part P step 3): record the module's last save point,
 * release its slot, and call the one `onModuleFinished` hook (lane 13 adds the
 * merge there). Until lane 13 lands, a finished module counts as MERGED — so
 * here the status is set to `merged`, a dependent of it becomes ready, and the
 * build can complete. (A comment, as the task asks: finished === merged until
 * lane 13's Q wires a real merge into onModuleFinished and flips the final
 * status itself.)
 *
 * Idempotent: a module already `merged`/`passed` is left alone (the hook is not
 * called twice), so the at-least-once finish of a module is safe.
 */
export async function finishModule(
	db: D1Database,
	scope: Scope,
	input: { runId: string; buildSeq: number; moduleId: string; checkpointRef: string },
	opts: { onModuleFinished?: OnModuleFinished } = {},
): Promise<{ finished: boolean; status: ModuleStatus }> {
	const row = await getModule(db, scope.projectId, input.buildSeq, input.moduleId);
	if (!row) throw new Error(`no such module "${input.moduleId}" in build ${input.buildSeq}`);
	if (isFinished(row.status)) return { finished: false, status: row.status };
	// Record the save point, then — because the merge is lane 13's and a
	// finished module counts as merged until then — mark it merged and free its
	// slot. Lane 13's Q will take the module from `passed` through its merge and
	// set the final status; keeping the hook's signature stable is what lets it.
	await setModuleStatus(db, scope.projectId, input.buildSeq, input.moduleId, 'merged', { checkpointRef: input.checkpointRef });
	await releaseSlot(db, scope.projectId, input.buildSeq, input.moduleId);
	const hook = opts.onModuleFinished ?? noopOnModuleFinished;
	await hook(db, scope, { runId: input.runId, moduleId: input.moduleId, checkpointRef: input.checkpointRef });
	return { finished: true, status: 'merged' };
}

/**
 * A module stopped (plan part P step 3): mark it `stopped` and free its slot. A
 * stopped module does NOT stop the rest — the next `startReadyModules` simply
 * skips it and the modules that don't depend on it keep going.
 */
export async function stopModule(db: D1Database, scope: Scope, input: { buildSeq: number; moduleId: string }): Promise<void> {
	await setModuleStatus(db, scope.projectId, input.buildSeq, input.moduleId, 'stopped');
	await releaseSlot(db, scope.projectId, input.buildSeq, input.moduleId);
}

/**
 * A module failed to build (its own 3-try limit was spent): mark it `stopped`
 * and free its slot, same as a manual stop — the rest keep going and the module
 * offers Try-again. (Kept distinct from `stopModule` for the caller's intent;
 * the stored status is the same `stopped`.)
 */
export async function failModule(db: D1Database, scope: Scope, input: { buildSeq: number; moduleId: string }): Promise<void> {
	await stopModule(db, scope, input);
}

/**
 * retry_module (plan part P / part F per module): put a stopped/not-merged
 * module back to `pending` and free any slot it holds, so the next
 * `startReadyModules` starts it again from the latest merged save point. Its
 * attempts counter is reset to 0 so it gets a fresh 3-try budget. Refuses a
 * module that is currently building or already merged.
 */
export async function retryModule(db: D1Database, scope: Scope, input: { buildSeq: number; moduleId: string }): Promise<ModuleRow> {
	const row = await getModule(db, scope.projectId, input.buildSeq, input.moduleId);
	if (!row) throw new Error(`no such module "${input.moduleId}" in build ${input.buildSeq}`);
	if (row.status === 'building') throw new Error(`"${input.moduleId}" is still building; stop it before trying again.`);
	if (row.status === 'merged') throw new Error(`"${input.moduleId}" is already merged; nothing to try again.`);
	await releaseSlot(db, scope.projectId, input.buildSeq, input.moduleId);
	await db
		.prepare('update "build_modules" set "status" = \'pending\', "attempts" = 0, "updatedAt" = ? where "projectId" = ? and "buildSeq" = ? and "moduleId" = ?')
		.bind(new Date().toISOString(), scope.projectId, input.buildSeq, input.moduleId)
		.run();
	const updated = await getModule(db, scope.projectId, input.buildSeq, input.moduleId);
	return updated!;
}

// --- the build board ---------------------------------------------------------

/** One row of the plain per-module list the user sees (part P "user sees"). */
export interface ModuleBoardItem {
	readonly moduleId: string;
	readonly status: ModuleStatus;
	readonly dependsOn: readonly string[];
}

/**
 * The plain per-module list for the partly-built end (plan part P step 3): one
 * item per module with its status and dependencies, so the UI can show
 * "Farms ✓ · Feed: building · Money: waiting for Farms", and the honest list of
 * what is missing when the build ends partly built.
 */
export async function moduleBoard(db: D1Database, projectId: string, buildSeq: number): Promise<ModuleBoardItem[]> {
	const modules = await listModules(db, projectId, buildSeq);
	return modules.map((m) => ({ moduleId: m.moduleId, status: m.status, dependsOn: m.dependsOn }));
}

/** Is the build done — every module merged, or settled (merged/stopped/not-merged)? */
export function buildOutcome(modules: readonly ModuleRow[]): { done: boolean; allMerged: boolean; unfinished: string[] } {
	const unfinished = modules.filter((m) => m.status === 'pending' || m.status === 'building').map((m) => m.moduleId);
	const allMerged = modules.length > 0 && modules.every((m) => m.status === 'merged');
	return { done: unfinished.length === 0, allMerged, unfinished };
}
