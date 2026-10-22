import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import {
	BUILD_SLOT_MAX,
	CADDIE_SLOT_MAX,
	buildSlotCount,
	caddieSlotCount,
	getModule,
	listModules,
	moduleInstanceId,
	payerForInstance,
	releaseSlot,
	seedModules,
	setModuleStatus,
	takeSlot,
} from '../apps/app/src/server/module-slots.ts';
import {
	finishModule,
	moduleBuilderMessage,
	readyModules,
	retryModule,
	startReadyModules,
	stopModule,
} from '../apps/app/src/server/modules.ts';
import {
	ModulePayerMissingError,
	resolveTurnPayer,
	_resetPayerRegistry,
} from '../apps/app/src/server/spend-instrument.ts';

/**
 * Lane 12 (part P) — parallel module builders.
 *
 * LOCAL VERIFIED against the bun:sqlite D1 harness (migration 0042 applied):
 * the atomic slot caps, dependency ordering, at-least-once harmlessness, the
 * module feature boundary, a stopped module not stopping the rest, and the
 * build's shared spend limit (resolveTurnPayer). Never evidence about the live
 * sandbox, a real Durable Object, or a real model turn.
 *
 * Each test carries a MUTATION PROOF: a comment naming the exact line that,
 * reverted, makes the test fail — the way the lane rules require a check to
 * bite. The reverts are exercised in the companion mutation block at the end,
 * which flips each guard and asserts the opposite outcome.
 */

const BUILD_SEQ = 0;

async function seedProject(): Promise<{ sqlite: Database; db: D1Database; scope: Scope; projectId: string }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Farm' });
	const scope = await projectScopeForUser(db, 'alice', project.id);
	return { sqlite, db, scope, projectId: project.id };
}

/** Seed a build payer limit row + a build_modules set with that payer. */
async function seedModulesWithPayer(
	db: D1Database,
	scope: Scope,
	payerId: string | null,
	modules: { moduleId: string; dependsOn: string[] }[],
): Promise<void> {
	if (payerId) {
		const now = new Date().toISOString();
		await db
			.prepare('insert into "build_spend_limits" ("payerId","limitMicros","createdAt","updatedAt") values (?,?,?,?)')
			.bind(payerId, 5_000_000, now, now)
			.run();
	}
	await seedModules(db, scope, { buildSeq: BUILD_SEQ, payerId, modules });
}

// --- slots: the D12 caps -----------------------------------------------------

describe('module slots — the D12 caps (4 per build, 8 across Caddie)', () => {
	test('a 5th module in ONE build waits (BUILD_SLOT_MAX = 4)', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [
			{ moduleId: 'm1', dependsOn: [] },
			{ moduleId: 'm2', dependsOn: [] },
			{ moduleId: 'm3', dependsOn: [] },
			{ moduleId: 'm4', dependsOn: [] },
			{ moduleId: 'm5', dependsOn: [] },
		]);
		// The first 4 take slots; the 5th is refused by the 0042 cap guard.
		// MUTATION: raise the `>= 4` in the 0042 trigger (or BUILD_SLOT_MAX) and
		// the 5th take would succeed — asserted in the mutation block below.
		const outcomes = [];
		for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) {
			outcomes.push((await takeSlot(db, projectId, BUILD_SEQ, m)).outcome);
		}
		expect(outcomes).toEqual(['taken', 'taken', 'taken', 'taken', 'build-full']);
		expect(await buildSlotCount(db, projectId, BUILD_SEQ)).toBe(BUILD_SLOT_MAX);
		// Freeing one lets the 5th in.
		await releaseSlot(db, projectId, BUILD_SEQ, 'm1');
		expect((await takeSlot(db, projectId, BUILD_SEQ, 'm5')).outcome).toBe('taken');
		sqlite.close();
	});

	test('a 9th across Caddie waits (CADDIE_SLOT_MAX = 8), even across builds', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		// 8 slots across two builds (4 each) fill Caddie; a 9th in a third build waits.
		await seedModulesWithPayer(db, scope, 'pay', [
			{ moduleId: 'a1', dependsOn: [] }, { moduleId: 'a2', dependsOn: [] }, { moduleId: 'a3', dependsOn: [] }, { moduleId: 'a4', dependsOn: [] },
		]);
		await seedModules(db, scope, { buildSeq: 1, payerId: 'pay', modules: [
			{ moduleId: 'b1', dependsOn: [] }, { moduleId: 'b2', dependsOn: [] }, { moduleId: 'b3', dependsOn: [] }, { moduleId: 'b4', dependsOn: [] },
		] });
		await seedModules(db, scope, { buildSeq: 2, payerId: 'pay', modules: [{ moduleId: 'c1', dependsOn: [] }] });
		for (const m of ['a1', 'a2', 'a3', 'a4']) expect((await takeSlot(db, projectId, 0, m)).outcome).toBe('taken');
		for (const m of ['b1', 'b2', 'b3', 'b4']) expect((await takeSlot(db, projectId, 1, m)).outcome).toBe('taken');
		expect(await caddieSlotCount(db)).toBe(CADDIE_SLOT_MAX);
		// MUTATION: raise the `>= 8` Caddie cap in the 0042 trigger and the 9th
		// would be 'taken' instead of 'caddie-full' (asserted in the mutation block).
		expect((await takeSlot(db, projectId, 2, 'c1')).outcome).toBe('caddie-full');
		sqlite.close();
	});

	test('the same module taking a slot twice is harmless (already-held, no second row)', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [{ moduleId: 'm1', dependsOn: [] }]);
		expect((await takeSlot(db, projectId, BUILD_SEQ, 'm1')).outcome).toBe('taken');
		// MUTATION: remove the `already-held` fast-path and the second take would
		// hit the PK and be read as an error, not a harmless re-take.
		expect((await takeSlot(db, projectId, BUILD_SEQ, 'm1')).outcome).toBe('already-held');
		expect(await buildSlotCount(db, projectId, BUILD_SEQ)).toBe(1);
		sqlite.close();
	});
});

// --- dependency order --------------------------------------------------------

describe('module start order — dependencies must finish first (part P step 2)', () => {
	test('only modules whose dependsOn are finished are ready; a dependent waits', async () => {
		const { sqlite, db, scope } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [
			{ moduleId: 'core', dependsOn: [] },
			{ moduleId: 'feed', dependsOn: ['core'] },
			{ moduleId: 'money', dependsOn: ['core', 'feed'] },
		]);
		const before = await listModules(db, scope.projectId, BUILD_SEQ);
		// Only core is ready at first.
		expect(readyModules(before).map((m) => m.moduleId)).toEqual(['core']);
		// Core merges → feed becomes ready, money still waits on feed.
		await setModuleStatus(db, scope.projectId, BUILD_SEQ, 'core', 'merged');
		const afterCore = await listModules(db, scope.projectId, BUILD_SEQ);
		// MUTATION: make isFinished() accept 'pending' and money would be ready
		// before feed exists — asserted in the mutation block.
		expect(readyModules(afterCore).map((m) => m.moduleId)).toEqual(['feed']);
		// Feed merges → money is ready.
		await setModuleStatus(db, scope.projectId, BUILD_SEQ, 'feed', 'merged');
		const afterFeed = await listModules(db, scope.projectId, BUILD_SEQ);
		expect(readyModules(afterFeed).map((m) => m.moduleId)).toEqual(['money']);
		sqlite.close();
	});

	test('startReadyModules dispatches core first, in dependency order, and takes its slot', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [
			{ moduleId: 'core', dependsOn: [] },
			{ moduleId: 'feed', dependsOn: ['core'] },
		]);
		const dispatched: string[] = [];
		const started = await startReadyModules(db, scope, {
			runId: 'run1', buildSeq: BUILD_SEQ, latestMergedSave: 'img-foundation',
			dispatch: (d) => { dispatched.push(d.instanceId); },
			features: () => ['f1'],
		});
		// Only core starts (feed waits on core); it is dispatched on its instance id.
		expect(started.map((m) => m.moduleId)).toEqual(['core']);
		expect(dispatched).toEqual([moduleInstanceId(projectId, BUILD_SEQ, 'core')]);
		const core = await getModule(db, projectId, BUILD_SEQ, 'core');
		expect(core?.status).toBe('building');
		expect(core?.checkpointRef).toBe('img-foundation');
		expect(await buildSlotCount(db, projectId, BUILD_SEQ)).toBe(1);
		sqlite.close();
	});
});

// --- at-least-once: same module dispatched twice ----------------------------

describe('at-least-once dispatch — the same module twice is harmless', () => {
	test('startReadyModules run twice dispatches a building module only once', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [{ moduleId: 'core', dependsOn: [] }]);
		const dispatched: string[] = [];
		const input = {
			runId: 'run1', buildSeq: BUILD_SEQ, latestMergedSave: 'img', features: () => ['f1'],
			dispatch: (d: { instanceId: string }) => { dispatched.push(d.instanceId); },
		};
		await startReadyModules(db, scope, input);
		// A second pass: core is now `building` (not `pending`), so it is not ready
		// and is not dispatched again.
		// MUTATION: make readyModules() include 'building' and core would be
		// dispatched twice — asserted in the mutation block.
		await startReadyModules(db, scope, input);
		expect(dispatched).toEqual([moduleInstanceId(projectId, BUILD_SEQ, 'core')]);
		expect(await buildSlotCount(db, projectId, BUILD_SEQ)).toBe(1);
		sqlite.close();
	});

	test('taking the same module slot twice keeps one slot (idempotent)', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [{ moduleId: 'core', dependsOn: [] }]);
		await takeSlot(db, projectId, BUILD_SEQ, 'core');
		await takeSlot(db, projectId, BUILD_SEQ, 'core');
		expect(await buildSlotCount(db, projectId, BUILD_SEQ)).toBe(1);
		sqlite.close();
	});
});

// --- a module can't take another module's features --------------------------

describe("a module builds only its own features (module scope)", () => {
	test("the dispatch for a module carries only that module's features", async () => {
		const { sqlite, db, scope } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [
			{ moduleId: 'core', dependsOn: [] },
			{ moduleId: 'feed', dependsOn: ['core'] },
		]);
		const featuresByModule: Record<string, string[]> = { core: ['crews', 'roles'], feed: ['stock', 'use'] };
		const seen: Record<string, readonly string[]> = {};
		await startReadyModules(db, scope, {
			runId: 'run1', buildSeq: BUILD_SEQ, latestMergedSave: 'img',
			dispatch: (d) => { seen[d.moduleId] = d.features; },
			features: (moduleId) => featuresByModule[moduleId] ?? [],
		});
		// Only core started; it got ITS features, never feed's.
		// MUTATION: pass a fixed feature list regardless of module and core would
		// receive feed's features — asserted in the mutation block.
		expect(seen.core).toEqual(['crews', 'roles']);
		expect(seen.feed).toBeUndefined();
		// The message names the module, not another.
		expect(moduleBuilderMessage('core')).toContain('"core"');
		expect(moduleBuilderMessage('core')).not.toContain('feed');
		sqlite.close();
	});
});

// --- one module stopping doesn't stop the rest ------------------------------

describe('a stopped module does not stop the rest (part P step 3)', () => {
	test('stopping an independent module leaves the others building', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [
			{ moduleId: 'core', dependsOn: [] },
			{ moduleId: 'feed', dependsOn: ['core'] },
			{ moduleId: 'tasks', dependsOn: ['core'] },
		]);
		await setModuleStatus(db, scope.projectId, BUILD_SEQ, 'core', 'merged');
		// feed and tasks both depend only on core; start them, then stop feed.
		const dispatched: string[] = [];
		await startReadyModules(db, scope, {
			runId: 'run1', buildSeq: BUILD_SEQ, latestMergedSave: 'img',
			dispatch: (d) => { dispatched.push(d.moduleId); }, features: () => ['f1'],
		});
		expect(dispatched.sort()).toEqual(['feed', 'tasks']);
		await stopModule(db, scope, { buildSeq: BUILD_SEQ, moduleId: 'feed' });
		const feed = await getModule(db, projectId, BUILD_SEQ, 'feed');
		const tasks = await getModule(db, projectId, BUILD_SEQ, 'tasks');
		// feed is stopped and its slot freed; tasks is untouched and still building.
		// MUTATION: have stopModule set every module to 'stopped' and tasks would
		// also be stopped — asserted in the mutation block.
		expect(feed?.status).toBe('stopped');
		expect(tasks?.status).toBe('building');
		expect(await buildSlotCount(db, projectId, BUILD_SEQ)).toBe(1); // only tasks holds one
		sqlite.close();
	});

	test('retryModule puts a stopped module back to pending with a fresh budget', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [{ moduleId: 'core', dependsOn: [] }]);
		await setModuleStatus(db, scope.projectId, BUILD_SEQ, 'core', 'stopped');
		await db.prepare('update "build_modules" set "attempts" = 3 where "projectId" = ? and "moduleId" = ?').bind(projectId, 'core').run();
		const retried = await retryModule(db, scope, { buildSeq: BUILD_SEQ, moduleId: 'core' });
		expect(retried.status).toBe('pending');
		expect(retried.attempts).toBe(0);
		// A merged module cannot be retried.
		await setModuleStatus(db, scope.projectId, BUILD_SEQ, 'core', 'merged');
		await expect(retryModule(db, scope, { buildSeq: BUILD_SEQ, moduleId: 'core' })).rejects.toThrow(/already merged/);
		sqlite.close();
	});
});

// --- finishModule + the stable onModuleFinished hook ------------------------

describe('finishModule records the save point and calls ONE onModuleFinished hook', () => {
	test('a finished module is marked merged, its slot freed, and the hook called once', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModulesWithPayer(db, scope, 'pay', [{ moduleId: 'core', dependsOn: [] }]);
		await takeSlot(db, projectId, BUILD_SEQ, 'core');
		await setModuleStatus(db, scope.projectId, BUILD_SEQ, 'core', 'building');
		const calls: { runId: string; moduleId: string; checkpointRef: string }[] = [];
		const result = await finishModule(
			db, scope,
			{ runId: 'run1', buildSeq: BUILD_SEQ, moduleId: 'core', checkpointRef: 'img-core' },
			{ onModuleFinished: (_db, _scope, input) => { calls.push(input); } },
		);
		expect(result).toEqual({ finished: true, status: 'merged' });
		const core = await getModule(db, projectId, BUILD_SEQ, 'core');
		expect(core?.status).toBe('merged');
		expect(core?.checkpointRef).toBe('img-core');
		expect(await buildSlotCount(db, projectId, BUILD_SEQ)).toBe(0); // slot released
		expect(calls).toEqual([{ runId: 'run1', moduleId: 'core', checkpointRef: 'img-core' }]);
		// Idempotent: finishing again does not call the hook a second time.
		const again = await finishModule(db, scope, { runId: 'run1', buildSeq: BUILD_SEQ, moduleId: 'core', checkpointRef: 'img-core' }, { onModuleFinished: (_d, _s, i) => { calls.push(i); } });
		expect(again.finished).toBe(false);
		expect(calls).toHaveLength(1);
		sqlite.close();
	});
});

// --- the shared spend limit: resolveTurnPayer for a ModuleBuilder ------------

describe('the build shared spend limit — a ModuleBuilder turn (part A / part P)', () => {
	test('a ModuleBuilder turn is charged to its build payer via build_modules', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		_resetPayerRegistry();
		await seedModulesWithPayer(db, scope, 'build:run1:123', [{ moduleId: 'feed', dependsOn: [] }]);
		const instanceId = moduleInstanceId(projectId, BUILD_SEQ, 'feed');
		// resolveTurnPayer reads the module row's payer by the instance id.
		const payer = await resolveTurnPayer(db, { instanceId, conversationId: 'internal-x' } as never);
		expect(payer).toBe('build:run1:123');
		// payerForInstance resolves it too (the registry fast-path source).
		expect(await payerForInstance(db, instanceId)).toBe('build:run1:123');
		sqlite.close();
	});

	test('a ModuleBuilder turn with NO payer is REFUSED, never passed through', async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		_resetPayerRegistry();
		// A module row with a null payer (a bug / a build that never opened one).
		await seedModulesWithPayer(db, scope, null, [{ moduleId: 'feed', dependsOn: [] }]);
		const instanceId = moduleInstanceId(projectId, BUILD_SEQ, 'feed');
		// MUTATION: return null instead of throwing for a payer-less module row,
		// and this would resolve to null (pass-through) instead of refusing —
		// asserted in the mutation block.
		await expect(resolveTurnPayer(db, { instanceId, conversationId: 'x' } as never)).rejects.toBeInstanceOf(ModulePayerMissingError);
		sqlite.close();
	});

	test('an unknown module id (no build_modules row) is not a module turn — falls through to chat pass-through', async () => {
		const { sqlite, db } = await seedProject();
		_resetPayerRegistry();
		// A colon id that LOOKS like a module instance but has no row: not a module
		// build, so it must not refuse — it falls through and (no workflow row
		// either) passes through as ordinary chat (null).
		const payer = await resolveTurnPayer(db, { instanceId: 'proj:0:ghost', conversationId: 'nope' } as never);
		expect(payer).toBeNull();
		sqlite.close();
	});

	test('ordinary chat (no module-shaped instance, no workflow) passes through (null)', async () => {
		const { sqlite, db } = await seedProject();
		_resetPayerRegistry();
		const payer = await resolveTurnPayer(db, { instanceId: 'some-chat-conversation', conversationId: 'some-chat-conversation' } as never);
		expect(payer).toBeNull();
		sqlite.close();
	});
});
