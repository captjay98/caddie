/**
 * Module builder slots (plan part P / D12) — lane 12.
 *
 * A big-app build runs several modules at once, but only so many at a time:
 * at most 4 slots per build, and 8 across all of Caddie. A slot is TAKEN
 * atomically when a module starts building, and RELEASED on finish, stop or
 * failure. The two caps are enforced in the INSERT itself by the migration-0042
 * trigger `build_module_slots_cap_guard`, so two concurrent takes serialize on
 * SQLite's write lock and the over-cap one aborts — the caps are hard, never a
 * read-then-write race.
 *
 * This module also owns the `build_modules` row lifecycle (the per-module
 * record 0040 created, with the attempts/dependsOn/payerId columns 0042 added):
 * seeding a build's modules from the approved design, moving a module through
 * its statuses, and reading the module board. The ORCHESTRATION (which module
 * to start next, the finish/stop/retry flow) lives in `server/modules.ts`; this
 * file is the storage + slot primitive it builds on, so it is tested directly
 * against the bun:sqlite D1 harness with no running build.
 *
 * Team mode only: nothing here runs unless big-apps is on and the plan has more
 * than one module (server/modules.ts gates on that). With it off, no module row
 * is ever created and today's single-builder loop is unchanged.
 */

import type { D1Database } from './auth.ts';
import type { Scope } from '@caddie/contracts';
import { ScopeError } from './scope.ts';

/** At most this many builder slots per build (D12). MUST match the 0042 trigger. */
export const BUILD_SLOT_MAX = 4;
/** At most this many builder slots across all of Caddie (D12). MUST match the 0042 trigger. */
export const CADDIE_SLOT_MAX = 8;

/** A module's lifecycle status, exactly the 0040 build_modules CHECK set. */
export type ModuleStatus = 'pending' | 'building' | 'stopped' | 'passed' | 'merged' | 'not-merged';

/** One module of a big-app build, as stored (0040 columns + 0042 adds). */
export interface ModuleRow {
	readonly id: string;
	readonly projectId: string;
	readonly buildSeq: number;
	readonly moduleId: string;
	readonly status: ModuleStatus;
	readonly sessionKey: string | null;
	readonly checkpointRef: string | null;
	readonly builderId: string | null;
	readonly attempts: number;
	readonly dependsOn: readonly string[];
	readonly payerId: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

const now = (): string => new Date().toISOString();

/** The ModuleBuilder instance id for a module (plan part P): `<projectId>:<buildSeq>:<moduleId>`. */
export function moduleInstanceId(projectId: string, buildSeq: number, moduleId: string): string {
	return `${projectId}:${buildSeq}:${moduleId}`;
}

/** The per-build slot key the D12 "4 per build" cap counts: `<projectId>:<buildSeq>`. */
export function buildKeyOf(projectId: string, buildSeq: number): string {
	return `${projectId}:${buildSeq}`;
}

function toRow(raw: Record<string, unknown>): ModuleRow {
	let dependsOn: string[] = [];
	try {
		const parsed = JSON.parse(String(raw['dependsOn'] ?? '[]'));
		if (Array.isArray(parsed)) dependsOn = parsed.map(String);
	} catch {
		dependsOn = [];
	}
	return {
		id: String(raw['id']),
		projectId: String(raw['projectId']),
		buildSeq: Number(raw['buildSeq']),
		moduleId: String(raw['moduleId']),
		status: String(raw['status']) as ModuleStatus,
		sessionKey: raw['sessionKey'] == null ? null : String(raw['sessionKey']),
		checkpointRef: raw['checkpointRef'] == null ? null : String(raw['checkpointRef']),
		builderId: raw['builderId'] == null ? null : String(raw['builderId']),
		attempts: Number(raw['attempts'] ?? 0),
		dependsOn,
		payerId: raw['payerId'] == null ? null : String(raw['payerId']),
		createdAt: String(raw['createdAt']),
		updatedAt: String(raw['updatedAt']),
	};
}

// --- the module board --------------------------------------------------------

/**
 * Every module row of a build, in the order they were seeded. One seed shares
 * one createdAt stamp and the ids are random, so the insertion order (rowid)
 * is what keeps the design's module order.
 */
export async function listModules(db: D1Database, projectId: string, buildSeq: number): Promise<ModuleRow[]> {
	const res = await db
		.prepare('select * from "build_modules" where "projectId" = ? and "buildSeq" = ? order by "createdAt", "rowid"')
		.bind(projectId, buildSeq)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(toRow);
}

/** One module row, or null when it does not exist. */
export async function getModule(db: D1Database, projectId: string, buildSeq: number, moduleId: string): Promise<ModuleRow | null> {
	const res = await db
		.prepare('select * from "build_modules" where "projectId" = ? and "buildSeq" = ? and "moduleId" = ?')
		.bind(projectId, buildSeq, moduleId)
		.all<Record<string, unknown>>();
	const row = res.results?.[0];
	return row ? toRow(row) : null;
}

/**
 * Seed a build's modules from the approved design, once. Each module starts
 * `pending` with its dependsOn and the build's shared payer, so modules.ts can
 * start the ones whose dependencies are met. Idempotent on (projectId,
 * buildSeq, moduleId): a replay leaves existing rows alone.
 */
export async function seedModules(
	db: D1Database,
	scope: Scope,
	input: {
		buildSeq: number;
		payerId: string | null;
		modules: readonly { moduleId: string; dependsOn: readonly string[] }[];
	},
): Promise<ModuleRow[]> {
	const stamp = now();
	for (const m of input.modules) {
		await db
			.prepare(
				'insert into "build_modules" ("id","projectId","buildSeq","moduleId","status","dependsOn","payerId","attempts","createdAt","updatedAt") ' +
					'values (?,?,?,?,\'pending\',?,?,0,?,?) on conflict ("projectId","buildSeq","moduleId") do nothing',
			)
			.bind(
				`bm_${crypto.randomUUID()}`,
				scope.projectId,
				input.buildSeq,
				m.moduleId,
				JSON.stringify([...m.dependsOn]),
				input.payerId,
				stamp,
				stamp,
			)
			.run();
	}
	return listModules(db, scope.projectId, input.buildSeq);
}

/** Set a module's status (and optionally its session/checkpoint/builder). */
export async function setModuleStatus(
	db: D1Database,
	projectId: string,
	buildSeq: number,
	moduleId: string,
	status: ModuleStatus,
	fields: { sessionKey?: string; checkpointRef?: string; builderId?: string } = {},
): Promise<void> {
	const sets: string[] = ['"status" = ?', '"updatedAt" = ?'];
	const binds: unknown[] = [status, now()];
	if (fields.sessionKey !== undefined) {
		sets.push('"sessionKey" = ?');
		binds.push(fields.sessionKey);
	}
	if (fields.checkpointRef !== undefined) {
		sets.push('"checkpointRef" = ?');
		binds.push(fields.checkpointRef);
	}
	if (fields.builderId !== undefined) {
		sets.push('"builderId" = ?');
		binds.push(fields.builderId);
	}
	binds.push(projectId, buildSeq, moduleId);
	await db
		.prepare(`update "build_modules" set ${sets.join(', ')} where "projectId" = ? and "buildSeq" = ? and "moduleId" = ?`)
		.bind(...binds)
		.run();
}

/** Bump a module's failed-try count by one (its own 3-try limit, part P). */
export async function recordModuleAttempt(db: D1Database, projectId: string, buildSeq: number, moduleId: string): Promise<number> {
	await db
		.prepare('update "build_modules" set "attempts" = "attempts" + 1, "updatedAt" = ? where "projectId" = ? and "buildSeq" = ? and "moduleId" = ?')
		.bind(now(), projectId, buildSeq, moduleId)
		.run();
	const row = await getModule(db, projectId, buildSeq, moduleId);
	return row?.attempts ?? 0;
}

// --- slots -------------------------------------------------------------------

/** The outcome of taking a slot. */
export type TakeSlotResult =
	/** A slot was taken (the module may start building). */
	| { outcome: 'taken' }
	/** This module already holds a slot — harmless, it may proceed. */
	| { outcome: 'already-held' }
	/** The build already holds BUILD_SLOT_MAX slots; the module waits. */
	| { outcome: 'build-full' }
	/** CADDIE_SLOT_MAX slots are held across Caddie; the module waits. */
	| { outcome: 'caddie-full' };

/** The SQLite error messages the 0042 trigger raises for each cap. */
const BUILD_CAP_MESSAGE = 'module_slot_build_cap';
const CADDIE_CAP_MESSAGE = 'module_slot_caddie_cap';

/**
 * Take a builder slot for a module, atomically (plan part P / D12). The INSERT
 * is refused by the migration-0042 trigger when the build already holds 4 slots
 * or 8 are held across Caddie; both surface here as a `*-full` wait, never an
 * error. Re-taking a slot this module already holds returns `already-held`, so
 * the at-least-once dispatch starting a module twice is harmless.
 */
export async function takeSlot(db: D1Database, projectId: string, buildSeq: number, moduleId: string): Promise<TakeSlotResult> {
	const instanceId = moduleInstanceId(projectId, buildSeq, moduleId);
	const existing = (
		await db.prepare('select "instanceId" from "build_module_slots" where "instanceId" = ?').bind(instanceId).all<{ instanceId: string }>()
	).results?.[0];
	if (existing) return { outcome: 'already-held' };
	try {
		await db
			.prepare('insert into "build_module_slots" ("instanceId","buildKey","projectId","buildSeq","moduleId","createdAt") values (?,?,?,?,?,?)')
			.bind(instanceId, buildKeyOf(projectId, buildSeq), projectId, buildSeq, moduleId, now())
			.run();
		return { outcome: 'taken' };
	} catch (error) {
		if (error instanceof Error && error.message.includes(BUILD_CAP_MESSAGE)) return { outcome: 'build-full' };
		if (error instanceof Error && error.message.includes(CADDIE_CAP_MESSAGE)) return { outcome: 'caddie-full' };
		// A primary-key conflict means a concurrent take for the same module won
		// the race: that module holds the slot, so this caller may proceed.
		if (error instanceof Error && /unique|primary key|constraint/i.test(error.message)) return { outcome: 'already-held' };
		throw error;
	}
}

/** Release a module's slot (finish, stop or failure). Best-effort; absent is a no-op. */
export async function releaseSlot(db: D1Database, projectId: string, buildSeq: number, moduleId: string): Promise<void> {
	await db
		.prepare('delete from "build_module_slots" where "instanceId" = ?')
		.bind(moduleInstanceId(projectId, buildSeq, moduleId))
		.run();
}

/** How many slots a build currently holds. */
export async function buildSlotCount(db: D1Database, projectId: string, buildSeq: number): Promise<number> {
	const res = await db
		.prepare('select count(*) as "n" from "build_module_slots" where "buildKey" = ?')
		.bind(buildKeyOf(projectId, buildSeq))
		.all<{ n: number }>();
	return Number(res.results?.[0]?.n ?? 0);
}

/** How many slots are held across all of Caddie. */
export async function caddieSlotCount(db: D1Database): Promise<number> {
	const res = await db.prepare('select count(*) as "n" from "build_module_slots"').all<{ n: number }>();
	return Number(res.results?.[0]?.n ?? 0);
}

/** Resolve the payer for a ModuleBuilder instance id — its build's shared payer. */
export async function payerForInstance(db: D1Database, instanceId: string): Promise<string | null> {
	const res = await db
		.prepare('select "payerId" from "build_modules" where ? = ("projectId" || \':\' || "buildSeq" || \':\' || "moduleId")')
		.bind(instanceId)
		.all<{ payerId: string | null }>();
	return res.results?.[0]?.payerId ?? null;
}

export { ScopeError };
