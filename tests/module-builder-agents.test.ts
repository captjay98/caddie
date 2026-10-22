import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
	InMemorySandboxPersistence,
	SandboxDriver,
} from '../apps/app/src/server/adapters/sandbox.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import { finishModule } from '../apps/app/src/server/modules.ts';
import { getModule, moduleInstanceId, seedModules } from '../apps/app/src/server/module-slots.ts';
import {
	type BootedModules,
	type ModuleHostSeam,
	type ScriptedReply,
	ModuleBuilder,
	bootModules,
	init,
	registerSeam,
	resetSeams,
} from '../apps/app/test-support/module-run-harness.ts';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';

/**
 * Gap 4 (plan part P / S3, strengthened) — two ModuleBuilder agents run FOR REAL
 * through the Flue node runtime with a scripted provider, each on its own copy
 * at the same time. Each calls only its module's build_next_feature /
 * finish_feature, ends with its own save point, and triggers exactly one
 * onModuleFinished call. Overlap is proven with wall-clock timestamps.
 *
 * LOCAL VERIFIED (SIMULATED model + host-check seam): the model is scripted and
 * the module host behind the tools is a seam that writes the module's file into
 * its OWN real SandboxDriver session (the P04/P05 contree stub transport),
 * checkpoints it, and calls the real finishModule. The full host's run_checks /
 * contract-check pipeline is NOT exercised here — this is evidence about the
 * parallel-builder orchestration (own copy, own save point, one hook, the
 * module-feature boundary), never about the live sandbox or a paid model turn.
 */

const TOKEN = 'stub-token-local-only-not-a-secret';
const IMAGE_TAG = 'tag:base:1';
const WORKSPACE_ROOT = '/workspace';
const BUILD_SEQ = 0;

async function seedProject(): Promise<{ sqlite: ReturnType<typeof migratedDatabase>['sqlite']; db: D1Database; scope: Scope; projectId: string; root: string }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Farm' });
	const scope = await projectScopeForUser(db, 'alice', project.id);
	return { sqlite, db, scope, projectId: project.id, root: `${WORKSPACE_ROOT}/${project.id}` };
}

describe('gap 4 — two real ModuleBuilder agents build in parallel on their own copies', () => {
	let stub: SandboxStub;
	let booted: BootedModules | null = null;
	beforeAll(async () => {
		stub = new SandboxStub({ expectedToken: TOKEN });
		stub.seedImage(IMAGE_TAG);
		await stub.start();
	});
	afterAll(async () => {
		await stub.stop();
	});
	afterEach(async () => {
		if (booted) {
			await booted.stop();
			booted = null;
		}
		resetSeams();
	});

	function makeDriver(): SandboxDriver {
		return new SandboxDriver(
			{
				contree: { baseUrl: stub.url, apiToken: TOKEN, platformProjectId: 'platform-project-test' },
				quotas: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 64 * 1024, maxCommandTimeoutMs: 30_000 },
				workspaceRoot: WORKSPACE_ROOT,
				pollIntervalMs: 5,
				dispatchTimeoutMs: 2_000,
			},
			new InMemorySandboxPersistence(),
		);
	}

	test('each agent only touches its own feature, ends with its own save point, fires one hook, and the two overlap', async () => {
		const { sqlite, db, scope, projectId, root } = await seedProject();
		await seedModules(db, scope, {
			buildSeq: BUILD_SEQ,
			payerId: 'build:run1:1',
			modules: [{ moduleId: 'feed', dependsOn: [] }, { moduleId: 'tasks', dependsOn: [] }],
		});

		// Each module's own feature ids, and the id the model is "allowed" to build.
		const featuresByModule: Record<string, string[]> = { feed: ['feed-feature'], tasks: ['tasks-feature'] };
		const hookCalls: { moduleId: string; checkpointRef: string }[] = [];
		const interval: Record<string, { start: number; end: number }> = {};
		const featureSeen: Record<string, string[]> = { feed: [], tasks: [] };

		// Build a host seam per module instance: build_next_feature hands out the
		// module's single feature; finish_feature writes the module's file into
		// its OWN real session, checkpoints, and calls the real finishModule.
		function seamFor(moduleId: string): ModuleHostSeam {
			const driver = makeDriver();
			const sessionKey = `module:run1:${moduleId}`;
			let currentFeature: string | null = null;
			return {
				async buildNextFeature() {
					const featureId = featuresByModule[moduleId]![0]!;
					currentFeature = featureId;
					featureSeen[moduleId]!.push(featureId);
					return { done: false, featureId };
				},
				async finishFeature() {
					const featureId = currentFeature;
					// The module boundary: a builder may only finish ITS module's feature.
					if (!featureId || !featuresByModule[moduleId]!.includes(featureId)) {
						throw new Error(`module ${moduleId} cannot build another module's feature ${featureId}`);
					}
					const start = Date.now();
					const { sessionId } = await driver.ensureSession({ sessionKey, image: IMAGE_TAG, projectId, runId: 'run1' });
					await driver.writeFile(
						sessionId,
						`${root}/src/server/${moduleId}/handler.ts`,
						Buffer.from(`export const ${moduleId} = 1;`, 'utf8').toString('base64'),
					);
					// A short awaited gap so both builders are in-flight at once.
					await new Promise((r) => setTimeout(r, 40));
					const { checkpointRef } = await driver.checkpoint(sessionId);
					interval[moduleId] = { start, end: Date.now() };
					await finishModule(
						db, scope,
						{ runId: 'run1', buildSeq: BUILD_SEQ, moduleId, checkpointRef },
						{ onModuleFinished: (_d, _s, input) => { hookCalls.push({ moduleId: input.moduleId, checkpointRef: input.checkpointRef }); } },
					);
					return { passed: true, checkpointRef };
				},
			};
		}

		// Register a seam per instance id (the dispatch instance id the agent reads).
		const feedId = moduleInstanceId(projectId, BUILD_SEQ, 'feed');
		const tasksId = moduleInstanceId(projectId, BUILD_SEQ, 'tasks');
		registerSeam(feedId, seamFor('feed'));
		registerSeam(tasksId, seamFor('tasks'));

		// Each module's own deterministic model-call queue (its own provider):
		// build_next_feature → finish_feature → plain "done".
		const steps: ScriptedReply[] = [
			{ toolCall: { id: 'b', name: 'build_next_feature', arguments: {} }, input: 50, output: 10 },
			{ toolCall: { id: 'f', name: 'finish_feature', arguments: {} }, input: 50, output: 10 },
			{ text: 'done', input: 20, output: 5 },
		];
		booted = await bootModules({ scripts: { feed: [...steps], tasks: [...steps] } });

		// Dispatch BOTH instances and run them AT THE SAME TIME. initialData
		// rides the instance's first message ({ message, initialData }).
		const feed = init(ModuleBuilder, { id: feedId });
		const tasks = init(ModuleBuilder, { id: tasksId });
		await Promise.all([
			feed.read(await feed.dispatch({ message: 'Build your module.', initialData: { moduleId: 'feed' } })),
			tasks.read(await tasks.dispatch({ message: 'Build your module.', initialData: { moduleId: 'tasks' } })),
		]);

		// Each provider served exactly 3 model calls for its own instance.
		expect(booted.callCount('feed')).toBe(3);
		expect(booted.callCount('tasks')).toBe(3);

		// Each builder saw ONLY its own feature (the module boundary held).
		expect(featureSeen.feed).toEqual(['feed-feature']);
		expect(featureSeen.tasks).toEqual(['tasks-feature']);

		// Each module ended with its OWN distinct save point, merged, one hook each.
		const feedRow = await getModule(db, projectId, BUILD_SEQ, 'feed');
		const tasksRow = await getModule(db, projectId, BUILD_SEQ, 'tasks');
		expect(feedRow?.status).toBe('merged');
		expect(tasksRow?.status).toBe('merged');
		expect(feedRow?.checkpointRef).not.toBe(tasksRow?.checkpointRef);
		expect(hookCalls.map((c) => c.moduleId).sort()).toEqual(['feed', 'tasks']);
		expect(hookCalls).toHaveLength(2);

		// Overlap: neither module's build interval ran strictly before the other's.
		const overlap = interval.feed!.start <= interval.tasks!.end && interval.tasks!.start <= interval.feed!.end;
		expect(overlap).toBe(true);

		sqlite.close();
	});

	test("a builder that asks to finish another module's feature is refused by the boundary", async () => {
		const { sqlite, db, scope, projectId } = await seedProject();
		await seedModules(db, scope, { buildSeq: BUILD_SEQ, payerId: 'build:run1:1', modules: [{ moduleId: 'feed', dependsOn: [] }] });
		const feedId = moduleInstanceId(projectId, BUILD_SEQ, 'feed');
		// A seam whose build_next_feature hands out ANOTHER module's feature id;
		// finish_feature refuses it (the boundary). The agent turn still settles
		// (Flue hands a tool error back to the model, which then replies), so the
		// proof is the REFUSAL fired and the module never finished — not a thrown read.
		let refusedForeignFeature = false;
		registerSeam(feedId, {
			async buildNextFeature() {
				return { done: false, featureId: 'tasks-feature' }; // not feed's
			},
			async finishFeature() {
				// The seam handed out 'tasks-feature'; feed may not finish it.
				refusedForeignFeature = true;
				throw new Error(`module feed cannot build tasks-feature`);
			},
		});
		booted = await bootModules({
			scripts: {
				feed: [
					{ toolCall: { id: 'b1', name: 'build_next_feature', arguments: {} }, input: 50, output: 10 },
					{ toolCall: { id: 'f1', name: 'finish_feature', arguments: {} }, input: 50, output: 10 },
					{ text: 'done', input: 20, output: 5 },
				],
			},
		});
		const feed = init(ModuleBuilder, { id: feedId });
		await feed.read(await feed.dispatch({ message: 'Build your module.', initialData: { moduleId: 'feed' } }));
		// The boundary refused the foreign feature, and feed never merged — no
		// finishModule ran, so its save point was never recorded.
		expect(refusedForeignFeature).toBe(true);
		const feedRow = await getModule(db, projectId, BUILD_SEQ, 'feed');
		expect(feedRow?.status).not.toBe('merged');
		expect(feedRow?.checkpointRef).toBeNull();
		sqlite.close();
	});
});
