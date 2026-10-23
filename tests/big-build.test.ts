import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import type { ArchitectureBlock, Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { getModule, listModules, setModuleStatus } from '../apps/app/src/server/module-slots.ts';
import {
	bigBuildOutcome,
	foundationModuleOf,
	isBigBlock,
	moduleFeatureMap,
	moduleOfFeature,
	startAfterFoundation,
} from '../apps/app/src/server/big-build.ts';

/**
 * Big-app builds, the foundation step (plan part P step 1-2): which module
 * builds each feature, seeding the other modules once the core module is
 * saved, and when the build as a whole is settled. LOCAL VERIFIED against the
 * bun:sqlite D1 harness with every migration applied; the dispatch is a fake
 * that records calls (no Durable Object, no model).
 */

function route(id: string, module: string, feature: string) {
	return { id, module, feature, op: 'create', method: 'POST', path: `/api/${id}`, table: null, plain: id, access: 'signed-in', request: [], response: [] };
}

/** A three-module design: core, feed and money (money depends on feed). */
function block(): ArchitectureBlock {
	return {
		modules: [
			{ id: 'core', plain: 'Farms, people and roles', dependsOn: [] },
			{ id: 'feed', plain: 'Feed stock and use', dependsOn: ['core'] },
			{ id: 'money', plain: 'Money in and out', dependsOn: ['core', 'feed'] },
		],
		routes: [route('farms.create', 'core', 'farms'), route('feed.create', 'feed', 'feed-log'), route('feed.use', 'feed', 'feed-use'), route('money.create', 'money', 'sales')],
	} as unknown as ArchitectureBlock;
}

async function seedProject(): Promise<{ db: D1Database; scope: Scope }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Farm' });
	return { db, scope: await projectScopeForUser(db, 'alice', project.id) };
}

async function payer(db: D1Database, payerId: string): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare('insert into "build_spend_limits" ("payerId","limitMicros","createdAt","updatedAt") values (?,?,?,?)').bind(payerId, 40_000_000, now, now).run();
}

describe('which module builds each feature', () => {
	test('a feature is built by the module of its routes; one with no route is built with the core', () => {
		const b = block();
		expect(moduleOfFeature(b, 'farms')).toBe('core');
		expect(moduleOfFeature(b, 'feed-use')).toBe('feed');
		expect(moduleOfFeature(b, 'sales')).toBe('money');
		expect(moduleOfFeature(b, 'settings-screen')).toBe('core');
		expect(moduleFeatureMap(b, ['farms', 'feed-log', 'feed-use', 'sales', 'settings-screen'])).toEqual(
			new Map([
				['core', ['farms', 'settings-screen']],
				['feed', ['feed-log', 'feed-use']],
				['money', ['sales']],
			]),
		);
	});

	test('only a design with more than one module is a big build; the foundation is core, else the first module', () => {
		expect(isBigBlock(block())).toBe(true);
		expect(isBigBlock({ ...block(), modules: [block().modules[0]!] } as ArchitectureBlock)).toBe(false);
		expect(isBigBlock(null)).toBe(false);
		expect(foundationModuleOf(block())).toBe('core');
		const noCore = { ...block(), modules: [{ id: 'farms', plain: 'Farms', dependsOn: [] }, ...block().modules.slice(1)] } as ArchitectureBlock;
		expect(foundationModuleOf(noCore)).toBe('farms');
	});
});

describe('the foundation step (part P steps 1-2)', () => {
	test('seeds every module, marks the foundation joined, and starts only the modules whose dependencies are joined', async () => {
		const { db, scope } = await seedProject();
		await payer(db, 'pay-1');
		const dispatched: Array<{ instanceId: string; moduleId: string; buildSeq: number; features: readonly string[] }> = [];
		const out = await startAfterFoundation(db, scope, {
			runId: 'run-1',
			block: block(),
			featureIds: ['farms', 'feed-log', 'feed-use', 'sales'],
			payerId: 'pay-1',
			foundationRef: 'ckpt-foundation',
			dispatch: (input) => {
				dispatched.push(input);
			},
		});
		expect(out.buildSeq).toBe(0);
		const rows = await listModules(db, scope.projectId, 0);
		expect(rows.map((r) => [r.moduleId, r.status])).toEqual([
			['core', 'merged'],
			['feed', 'building'],
			['money', 'pending'],
		]);
		expect((await getModule(db, scope.projectId, 0, 'core'))?.checkpointRef).toBe('ckpt-foundation');
		// feed waits only on core (joined) so it starts; money also waits on feed.
		expect(dispatched.map((d) => [d.moduleId, d.buildSeq, [...d.features]])).toEqual([['feed', 0, ['feed-log', 'feed-use']]]);
		expect(dispatched[0]?.instanceId).toBe(`${scope.projectId}:0:feed`);
		// Every module carries the build's payer, so the spend limit covers its builder.
		expect(rows.every((r) => r.payerId === 'pay-1')).toBe(true);
	});

	test('a module with no planned features has nothing to build: it is joined at once and never takes a builder', async () => {
		const { db, scope } = await seedProject();
		await payer(db, 'pay-1');
		const dispatched: string[] = [];
		// No planned feature belongs to feed, so feed is joined at the foundation
		// save point and money (which waits on core and feed) starts right away.
		await startAfterFoundation(db, scope, {
			runId: 'run-1',
			block: block(),
			featureIds: ['farms', 'sales'],
			payerId: 'pay-1',
			foundationRef: 'ckpt-foundation',
			dispatch: (d) => {
				dispatched.push(d.moduleId);
			},
		});
		const rows = await listModules(db, scope.projectId, 0);
		expect(rows.map((r) => [r.moduleId, r.status])).toEqual([
			['core', 'merged'],
			['feed', 'merged'],
			['money', 'building'],
		]);
		expect((await getModule(db, scope.projectId, 0, 'feed'))?.checkpointRef).toBe('ckpt-foundation');
		expect(dispatched).toEqual(['money']);
	});

	test('running the foundation step again for the same build is harmless: no second seed, no second start', async () => {
		const { db, scope } = await seedProject();
		await payer(db, 'pay-1');
		const dispatched: string[] = [];
		const input = {
			runId: 'run-1',
			block: block(),
			featureIds: ['farms', 'feed-log', 'feed-use', 'sales'],
			payerId: 'pay-1',
			foundationRef: 'ckpt-foundation',
			dispatch: (d: { moduleId: string }) => {
				dispatched.push(d.moduleId);
			},
		};
		await startAfterFoundation(db, scope, input);
		const again = await startAfterFoundation(db, scope, input);
		expect(again.buildSeq).toBe(0);
		expect((await listModules(db, scope.projectId, 0)).length).toBe(3);
		expect(dispatched).toEqual(['feed']);
	});

	test('a retry with a fresh spending limit is a new build with its own module rows', async () => {
		const { db, scope } = await seedProject();
		await payer(db, 'pay-1');
		await payer(db, 'pay-2');
		const base = { runId: 'run-1', block: block(), featureIds: ['farms', 'feed-log', 'feed-use', 'sales'], foundationRef: 'ckpt-foundation', dispatch: () => {} };
		expect((await startAfterFoundation(db, scope, { ...base, payerId: 'pay-1' })).buildSeq).toBe(0);
		expect((await startAfterFoundation(db, scope, { ...base, payerId: 'pay-2' })).buildSeq).toBe(1);
		expect((await listModules(db, scope.projectId, 1)).every((r) => r.payerId === 'pay-2')).toBe(true);
	});
});

describe('when the big build as a whole is settled', () => {
	test('it is done when every module is joined, stopped or not joined', async () => {
		const { db, scope } = await seedProject();
		await payer(db, 'pay-1');
		await startAfterFoundation(db, scope, { runId: 'run-1', block: block(), featureIds: ['farms', 'feed-log', 'sales'], payerId: 'pay-1', foundationRef: 'f', dispatch: () => {} });
		expect((await bigBuildOutcome(db, scope.projectId, 0)).done).toBe(false);
		await setModuleStatus(db, scope.projectId, 0, 'feed', 'merged');
		await setModuleStatus(db, scope.projectId, 0, 'money', 'merged');
		const out = await bigBuildOutcome(db, scope.projectId, 0);
		expect(out).toMatchObject({ done: true, allMerged: true, missing: [] });
	});

	test('a module waiting on a stopped module can never start, so it counts as settled and is named as missing', async () => {
		const { db, scope } = await seedProject();
		await payer(db, 'pay-1');
		await startAfterFoundation(db, scope, { runId: 'run-1', block: block(), featureIds: ['farms', 'feed-log', 'sales'], payerId: 'pay-1', foundationRef: 'f', dispatch: () => {} });
		await setModuleStatus(db, scope.projectId, 0, 'feed', 'stopped');
		const out = await bigBuildOutcome(db, scope.projectId, 0);
		expect(out.done).toBe(true);
		expect(out.allMerged).toBe(false);
		expect(out.missing).toEqual([
			{ moduleId: 'feed', reason: 'stopped' },
			{ moduleId: 'money', reason: 'waits-on-missing' },
		]);
	});
});

// --- the agent files (source guards: Flue agents don't run in a unit test) ----

describe('the agents wire the big build', () => {
	const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

	test("the coordinator's finish hook settles without a nudge while the parts build", () => {
		// A nudge here would spend the per-feature budget and then block a
		// build whose parts are still being built by their own builders.
		const src = read('../apps/app/src/agents/coordinator.ts');
		const settle = src.indexOf('if (progress?.waitingOnParts) return;');
		const nudge = src.indexOf('const focus = progress?.current ? `feature:');
		expect(settle).toBeGreaterThan(-1);
		expect(nudge).toBeGreaterThan(settle);
	});

	test('the coordinator host gets a real ModuleBuilder dispatcher carrying the seed data the builder validates', () => {
		const src = read('../apps/app/src/agents/host-context.ts');
		expect(src).toContain('resolveCoordinatorContext(env, conversationId, { dispatchModuleBuilder: moduleBuilderDispatcher(conversationId) })');
		expect(src).toMatch(
			/dispatch\(ModuleBuilder, \{\s*id: input\.instanceId,\s*message: input\.message,\s*initialData: \{ conversationId, moduleId: input\.moduleId, buildSeq: input\.buildSeq, features: \[\.\.\.input\.features\] \},/,
		);
		// ...which matches the builder's own seed schema field for field.
		const builder = read('../apps/app/src/agents/module-builder.ts');
		for (const field of ['conversationId:', 'moduleId:', 'buildSeq:', 'features:']) expect(builder).toContain(field);
	});

	test("a part's builder has finish_module, and its host can start parts and tell the coordinator once (keyed)", () => {
		const src = read('../apps/app/src/agents/module-builder.ts');
		expect(src).toContain('name: "finish_module"');
		expect(src).toContain('host.finishModuleBuild(ctx.toolCallId, ctx.signal)');
		// The host gets both deps; the coordinator is imported lazily (a static
		// import would be a cycle through host-context.ts), and its message is
		// keyed so a resend is the same one turn.
		expect(src).toContain('}, hostDeps(seed.conversationId));');
		expect(src).toContain('await import("./coordinator.ts")');
		expect(src).toMatch(/dispatch\(Coordinator, \{ id: conversationId, message: \{ kind: "user", body: message \}, idempotencyKey: key \}\)/);
		expect(src).not.toMatch(/^import (?!type )[^\n]*from "\.\/coordinator\.ts";$/m);
		// The builder is told to join its part when every feature has passed.
		expect(src).toContain('call finish_module to join the part into the app');
	});
});
