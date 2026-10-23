/**
 * Big-app builds (team mode, plan parts P and Q): which module builds each
 * feature, the foundation step that hands the other modules to their builders
 * once the foundation module is saved, and when the build as a whole is
 * settled.
 *
 * Only for a team-mode build with big apps on whose APPROVED design has more
 * than one module (`isBigBlock`). With one module, or big apps off, none of
 * this runs and today's single-builder loop is unchanged.
 *
 * One build = one spend payer. Every build (and every retry, which opens a
 * fresh spending limit) gets its own `buildSeq`, so a retry never inherits the
 * module rows, slots or instance ids of the build before it.
 *
 * The foundation module's row doubles as the integration copy's pointer: its
 * `checkpointRef` is the LATEST JOINED save point (the foundation first, then
 * each merge as it lands), which is the copy every newly started module is
 * restored from.
 */

import type { ArchitectureBlock, Scope } from '@caddie/contracts';
import { CORE_MODULE } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { getModule, listModules, seedModules, setModuleStatus, type ModuleRow, type ModuleStatus } from './module-slots.ts';
import { startReadyModules, type DispatchModuleBuilder } from './modules.ts';

/** A design whose app is built in parts: more than one module. */
export function isBigBlock(block: ArchitectureBlock | null | undefined): block is ArchitectureBlock {
	return Boolean(block && block.modules.length > 1);
}

/** The module built first, in the normal feature loop: `core`, else the design's first module. */
export function foundationModuleOf(block: ArchitectureBlock): string {
	return block.modules.some((m) => m.id === CORE_MODULE) ? CORE_MODULE : block.modules[0]!.id;
}

/**
 * The module that builds a feature: the module of the feature's first route.
 * A feature with no route (a screen-only feature, say) is built with the
 * foundation, so every feature has exactly one builder.
 */
export function moduleOfFeature(block: ArchitectureBlock, featureId: string): string {
	const known = new Set(block.modules.map((m) => m.id));
	const route = block.routes.find((r) => r.feature === featureId && known.has(r.module));
	return route ? route.module : foundationModuleOf(block);
}

/** Each module's features, in the plan's order; every module is present, possibly with none. */
export function moduleFeatureMap(block: ArchitectureBlock, featureIds: readonly string[]): Map<string, string[]> {
	const map = new Map<string, string[]>(block.modules.map((m) => [m.id, []]));
	for (const id of featureIds) map.get(moduleOfFeature(block, id))!.push(id);
	return map;
}

/** The build sequence already seeded for this payer (this build), or null before its foundation. */
export async function bigBuildSeq(db: D1Database, projectId: string, payerId: string | null): Promise<number | null> {
	const res = await db
		.prepare('select "buildSeq" from "build_modules" where "projectId" = ? and "payerId" is ? order by "buildSeq" desc limit 1')
		.bind(projectId, payerId)
		.all<{ buildSeq: number }>();
	const seq = res.results?.[0]?.buildSeq;
	return typeof seq === 'number' ? seq : null;
}

async function nextBuildSeq(db: D1Database, projectId: string): Promise<number> {
	const res = await db
		.prepare('select max("buildSeq") as "seq" from "build_modules" where "projectId" = ?')
		.bind(projectId)
		.all<{ seq: number | null }>();
	const seq = res.results?.[0]?.seq;
	return typeof seq === 'number' ? seq + 1 : 0;
}

/**
 * The foundation step (plan part P steps 1-2), run when the foundation
 * module's last feature has passed and been saved at `foundationRef`.
 *
 * The first time for this build (this payer): seed every module of the
 * approved design with its dependencies and the build's payer, and mark the
 * foundation module joined at the foundation save point. Every time: start
 * each module whose dependencies are all joined and that can take a builder
 * slot, restored from the latest joined save point. Idempotent, so the host
 * may call it again (a retried tool call, a re-entered build_next_feature)
 * without seeding twice or starting a module twice.
 */
export async function startAfterFoundation(
	db: D1Database,
	scope: Scope,
	input: {
		runId: string;
		block: ArchitectureBlock;
		featureIds: readonly string[];
		payerId: string | null;
		foundationRef: string;
		dispatch: DispatchModuleBuilder;
	},
): Promise<{ buildSeq: number; started: ModuleRow[] }> {
	const foundation = foundationModuleOf(input.block);
	const features = moduleFeatureMap(input.block, input.featureIds);
	let buildSeq = await bigBuildSeq(db, scope.projectId, input.payerId);
	if (buildSeq === null) {
		buildSeq = await nextBuildSeq(db, scope.projectId);
		await seedModules(db, scope, {
			buildSeq,
			payerId: input.payerId,
			modules: input.block.modules.map((m) => ({ moduleId: m.id, dependsOn: m.dependsOn })),
		});
		await setModuleStatus(db, scope.projectId, buildSeq, foundation, 'merged', { checkpointRef: input.foundationRef });
		// A module none of the plan's features belong to has nothing to build:
		// it is joined as it stands (the foundation), so it never holds a
		// builder slot and its dependents are not kept waiting on it.
		for (const m of input.block.modules) {
			if (m.id !== foundation && (features.get(m.id)?.length ?? 0) === 0)
				await setModuleStatus(db, scope.projectId, buildSeq, m.id, 'merged', { checkpointRef: input.foundationRef });
		}
	}
	const latestJoined = (await getModule(db, scope.projectId, buildSeq, foundation))?.checkpointRef ?? input.foundationRef;
	const started = await startReadyModules(db, scope, {
		runId: input.runId,
		buildSeq,
		latestMergedSave: latestJoined,
		dispatch: input.dispatch,
		features: (moduleId) => features.get(moduleId) ?? [],
	});
	return { buildSeq, started };
}

/** Why a module of a settled build is not in the app. */
export type MissingReason = 'stopped' | 'not-merged' | 'waits-on-missing';

/**
 * The ready card's line for an app finished without some of its parts (plan
 * part P step 3: "partly built, with a plain list of what's missing and the
 * Try-again button for that module"). Plain part names from the design.
 */
export function partlyBuiltDetail(block: ArchitectureBlock, missing: ReadonlyArray<{ moduleId: string; reason: MissingReason }>): string {
	const plain = (id: string) => block.modules.find((m) => m.id === id)?.plain ?? id;
	const why = (reason: MissingReason) =>
		reason === 'not-merged' ? "it couldn't be joined into the app" : reason === 'stopped' ? 'it stopped' : 'it needs a part that is missing';
	const list = missing.map((m) => `${plain(m.moduleId)} (${why(m.reason)})`).join(', ');
	return missing.length === 1
		? `Your app is ready without one part: ${list}. Press Try again on that part to build it again.`
		: `Your app is ready without ${missing.length} parts: ${list}. Press Try again on a part to build it again.`;
}

/**
 * Where the big build stands. `done` when no module can make progress any
 * more: each is joined, stopped or not joined — or waits (directly or through
 * another module) on one that is stopped or not joined, so it can never start.
 * `missing` names every module that is not in the app, with why, in the
 * design's order.
 */
export async function bigBuildOutcome(
	db: D1Database,
	projectId: string,
	buildSeq: number,
): Promise<{ done: boolean; allMerged: boolean; missing: Array<{ moduleId: string; reason: MissingReason }>; rows: ModuleRow[] }> {
	const rows = await listModules(db, projectId, buildSeq);
	const status = new Map<string, ModuleStatus>(rows.map((r) => [r.moduleId, r.status]));
	const byId = new Map(rows.map((r) => [r.moduleId, r]));
	const blocked = new Map<string, boolean>();
	const isBlocked = (moduleId: string, seen: Set<string>): boolean => {
		const known = blocked.get(moduleId);
		if (known !== undefined) return known;
		if (seen.has(moduleId)) return false;
		seen.add(moduleId);
		const row = byId.get(moduleId);
		const result =
			!row ||
			row.status === 'stopped' ||
			row.status === 'not-merged' ||
			(row.status === 'pending' && row.dependsOn.some((dep) => isBlocked(dep, seen)));
		blocked.set(moduleId, result);
		return result;
	};
	const missing: Array<{ moduleId: string; reason: MissingReason }> = [];
	let done = rows.length > 0;
	for (const row of rows) {
		const s = status.get(row.moduleId)!;
		if (s === 'merged') continue;
		if (s === 'stopped' || s === 'not-merged') {
			missing.push({ moduleId: row.moduleId, reason: s });
			continue;
		}
		if (s === 'pending' && isBlocked(row.moduleId, new Set())) {
			missing.push({ moduleId: row.moduleId, reason: 'waits-on-missing' });
			continue;
		}
		done = false; // pending (can still start), building, or passed (joining)
	}
	return { done, allMerged: done && missing.length === 0, missing, rows };
}
