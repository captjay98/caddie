import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	InMemorySandboxPersistence,
	SandboxDriver,
} from '../apps/app/src/server/adapters/sandbox.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import {
	finishModule,
	startReadyModules,
} from '../apps/app/src/server/modules.ts';
import {
	getModule,
	moduleInstanceId,
	seedModules,
} from '../apps/app/src/server/module-slots.ts';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';

/**
 * S3 spike (plan §6, part P) — two ModuleBuilders build one feature each on
 * their OWN copies AT THE SAME TIME; both finish with their own save point and
 * one onModuleFinished hook call each. Local, no model, no cost: each "builder"
 * is a scripted routine that writes its module's file into its own sandbox
 * session (the REAL SandboxDriver over the local contree stub) and checkpoints,
 * so the two copies are genuinely independent images.
 *
 * OVERLAP is proven with timestamps: each builder records when it started and
 * finished its work around a short awaited gap, and the test asserts the two
 * intervals overlap in wall-clock time (neither ran strictly before the other).
 *
 * LOCAL VERIFIED (SIMULATED builders): the driver↔contree transport is the
 * local stub the P04/P05 contract suite uses; this is evidence about the
 * orchestration's concurrency, the per-copy save points, and the one-hook-per-
 * module contract — never about the live sandbox or a real model turn. The
 * MERGE is lane 13's; this spike stops at each module's own save point + hook.
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

describe('S3 — two ModuleBuilders build in parallel on their own copies', () => {
	let stub: SandboxStub;
	beforeAll(async () => {
		stub = new SandboxStub({ expectedToken: TOKEN });
		stub.seedImage(IMAGE_TAG);
		await stub.start();
	});
	afterAll(async () => {
		await stub.stop();
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

	test('both modules build one feature concurrently; each ends with its own save point and one hook call', async () => {
		const { sqlite, db, scope, projectId, root } = await seedProject();
		await seedModules(db, scope, {
			buildSeq: BUILD_SEQ,
			payerId: 'build:run1:1',
			modules: [
				{ moduleId: 'feed', dependsOn: [] },
				{ moduleId: 'tasks', dependsOn: [] },
			],
		});

		// Start both (no dependencies) — the orchestration takes a slot for each
		// and records them building on their own session key. The dispatch just
		// records which modules launched; the scripted builders run below.
		const launched: string[] = [];
		const started = await startReadyModules(db, scope, {
			runId: 'run1', buildSeq: BUILD_SEQ, latestMergedSave: IMAGE_TAG,
			dispatch: (d) => { launched.push(d.moduleId); },
			features: (m) => [`${m}-feature`],
		});
		expect(started.map((m) => m.moduleId).sort()).toEqual(['feed', 'tasks']);
		expect(launched.sort()).toEqual(['feed', 'tasks']);

		// Each scripted builder: restore its own copy from the foundation image,
		// write its module's file into ITS session, pause (so the two overlap),
		// checkpoint its own image, then finishModule with that save point. The
		// pauses make the intervals overlap regardless of scheduling.
		const hookCalls: { moduleId: string; checkpointRef: string }[] = [];
		const interval: Record<string, { start: number; end: number }> = {};

		async function buildOneModule(moduleId: string): Promise<string> {
			const start = Date.now();
			const driver = makeDriver();
			const sessionKey = `module:run1:${moduleId}`;
			// Each module's own copy, restored from the shared foundation image.
			const { sessionId } = await driver.ensureSession({ sessionKey, image: IMAGE_TAG, projectId, runId: 'run1' });
			await driver.writeFile(
				sessionId,
				`${root}/src/server/${moduleId}/handler.ts`,
				Buffer.from(`export const ${moduleId} = 1;`, 'utf8').toString('base64'),
			);
			// A short awaited gap so both builders are in-flight at once.
			await new Promise((r) => setTimeout(r, 40));
			const { checkpointRef } = await driver.checkpoint(sessionId);
			const end = Date.now();
			interval[moduleId] = { start, end };
			await finishModule(
				db, scope,
				{ runId: 'run1', buildSeq: BUILD_SEQ, moduleId, checkpointRef },
				{ onModuleFinished: (_db, _scope, input) => { hookCalls.push({ moduleId: input.moduleId, checkpointRef: input.checkpointRef }); } },
			);
			return checkpointRef;
		}

		// Run BOTH at the same time.
		const [feedImage, tasksImage] = await Promise.all([buildOneModule('feed'), buildOneModule('tasks')]);

		// Overlap: neither interval ran strictly before the other.
		const overlap = interval.feed.start <= interval.tasks.end && interval.tasks.start <= interval.feed.end;
		expect(overlap).toBe(true);

		// Each module has its OWN save point (two distinct images), and each
		// hook fired exactly once.
		expect(feedImage).not.toBe(tasksImage);
		expect(hookCalls.map((c) => c.moduleId).sort()).toEqual(['feed', 'tasks']);
		expect(hookCalls).toHaveLength(2);

		const feed = await getModule(db, projectId, BUILD_SEQ, 'feed');
		const tasks = await getModule(db, projectId, BUILD_SEQ, 'tasks');
		expect(feed?.status).toBe('merged'); // finished === merged until lane 13
		expect(tasks?.status).toBe('merged');
		expect(feed?.checkpointRef).toBe(feedImage);
		expect(tasks?.checkpointRef).toBe(tasksImage);
		// Each builder's instance id is its own.
		expect(moduleInstanceId(projectId, BUILD_SEQ, 'feed')).not.toBe(moduleInstanceId(projectId, BUILD_SEQ, 'tasks'));
		sqlite.close();
	});
});
