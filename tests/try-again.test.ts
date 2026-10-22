import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import type { BuildFeatureRow } from '../apps/app/src/server/build-features.ts';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import { STOP_SENTINEL } from '../apps/app/src/server/project-experience.ts';
import {
	canTryAgainFromSavePoint,
	failureSummary,
	tryAgainFromSavePoint,
} from '../apps/app/src/server/build-steps.ts';

/**
 * Lane 5, part F: the stopped-build card offers "Try this feature again from
 * the last save point" ONLY when the build stopped after 3 failed tries. It
 * uses the existing rollback (build-features.ts, which only works when the
 * build is stopped) then the existing message-carrying retry, carrying a
 * summary of what failed from the check receipts. For the first feature it
 * starts again from the plan.
 *
 * LOCAL VERIFIED for the pure gate, the summary, and the composition (which
 * featureId is rolled back to and the exact summary the retry carries) over a
 * bun:sqlite D1 with injected rollback/retry ports. The real rollback and
 * retry are proven in tests/build-workflow.test.ts; this proves part F wires
 * them correctly.
 */

const REPAIR_PAUSE_THRESHOLD = 3;

function feature(partial: Partial<BuildFeatureRow> & { featureId: string; position: number }): BuildFeatureRow {
	return {
		projectId: 'p',
		runId: 'r',
		planId: 'pl',
		featureId: partial.featureId,
		position: partial.position,
		title: partial.title ?? partial.featureId,
		doneWhen: partial.doneWhen ?? [],
		status: partial.status ?? 'pending',
		attempts: partial.attempts ?? 0,
		testsPassed: partial.testsPassed ?? null,
		checkpointRef: partial.checkpointRef ?? null,
		passedAt: partial.passedAt ?? null,
	};
}

// --- the gate ----------------------------------------------------------------

describe('part F — canTryAgainFromSavePoint (the button appears only on a stopped build)', () => {
	const stuck = [feature({ featureId: 'f2', position: 2, status: 'building', attempts: REPAIR_PAUSE_THRESHOLD })];

	test('offered when the build is blocked (Caddie stopped it) after 3 failed tries', () => {
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: 'checks failed three times' }, stuck)).toBe(true);
	});

	test('NOT offered while the build is running', () => {
		expect(canTryAgainFromSavePoint({ phase: 'building', detail: null }, stuck)).toBe(false);
		expect(canTryAgainFromSavePoint({ phase: 'ready', detail: null }, stuck)).toBe(false);
	});

	test('NOT offered when the user stopped the build (STOP_SENTINEL detail)', () => {
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: STOP_SENTINEL }, stuck)).toBe(false);
	});

	test('NOT offered before 3 failed tries', () => {
		const earlier = [feature({ featureId: 'f2', position: 2, status: 'building', attempts: 2 })];
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: 'one failure' }, earlier)).toBe(false);
	});

	test('NOT offered when every feature already passed (nothing to try again)', () => {
		const done = [feature({ featureId: 'f1', position: 1, status: 'passed', attempts: 1 })];
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: 'x' }, done)).toBe(false);
	});
});

// --- the summary -------------------------------------------------------------

describe('part F — failureSummary carries what failed', () => {
	test('includes the feature title, the try count and the blocker detail', () => {
		const f = feature({ featureId: 'f2', position: 2, title: 'Save a todo', attempts: 3 });
		const summary = failureSummary(f, 'Caddie could not get the app checks passing after three attempts.');
		expect(summary).toContain('Save a todo');
		expect(summary).toContain('3 failed tries');
		expect(summary).toContain('Caddie could not get the app checks passing');
	});

	test('reads correctly with no blocker detail', () => {
		const summary = failureSummary(feature({ featureId: 'f1', position: 1, title: 'A', attempts: 3 }), null);
		expect(summary).toContain('A');
		expect(summary).not.toContain('What failed last time');
	});
});

// --- the composition: rollback + retry carry the summary ---------------------

async function seedBlockedBuild(features: BuildFeatureRow[], detail: string): Promise<{
	sqlite: Database;
	db: D1Database;
	scope: Scope;
}> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Todo' });
	const scope = await projectScopeForUser(db, 'alice', project.id);
	const stamp = new Date().toISOString();
	// A blocked workflow with a plan id and feature rows — enough for the
	// handler's featuresFor/currentFeature and the gate. (The real rollback and
	// retry are injected as ports, so no approval/sandbox is needed here.)
	sqlite
		.prepare(
			'insert into build_workflows (projectId,runId,conversationId,intakeKey,brief,phase,planId,detail,teamMode,bigApps,appFeatures,updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?)',
		)
		.run(project.id, 'run1', 'conv1', `k:${project.id}`, 'brief', 'blocked', 'pl', detail, 1, 0, 0, stamp);
	for (const f of features) {
		sqlite
			.prepare(
				'insert into build_features (projectId,runId,planId,featureId,position,title,doneWhen,status,attempts,testsPassed,checkpointRef,passedAt,updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
			)
			.run(project.id, 'run1', 'pl', f.featureId, f.position, f.title, JSON.stringify(f.doneWhen), f.status, f.attempts, f.testsPassed, f.checkpointRef, f.passedAt, stamp);
	}
	return { sqlite, db, scope };
}

describe('part F — tryAgainFromSavePoint composes rollback + message-carrying retry', () => {
	let world: Awaited<ReturnType<typeof seedBlockedBuild>>;
	afterEach(() => world?.sqlite.close());

	test('rolls back to the previous passed feature and retries carrying the summary', async () => {
		const features = [
			feature({ featureId: 'f1', position: 1, status: 'passed', attempts: 1, checkpointRef: 'ckpt-f1' }),
			feature({ featureId: 'f2', position: 2, status: 'building', title: 'Save a todo', attempts: 3 }),
		];
		world = await seedBlockedBuild(features, 'Caddie could not get the app checks passing after three attempts.');
		const calls: { rollbackTo?: string; retryMessage?: string } = {};
		const result = await tryAgainFromSavePoint(
			world.db,
			world.scope,
			{ key: 'k12345678' },
			undefined,
			{
				rollback: async (featureId) => {
					calls.rollbackTo = featureId;
				},
				retry: async (_key, request) => {
					calls.retryMessage = request;
				},
			},
		);
		expect(result.startedFrom).toBe('save-point');
		// Rolled back to the previous PASSED feature (f1), not the stuck one.
		expect(calls.rollbackTo).toBe('f1');
		// The retry carries the failure summary (feature + blocker).
		expect(calls.retryMessage).toContain('Save a todo');
		expect(calls.retryMessage).toContain('Caddie could not get the app checks passing');
		expect(calls.retryMessage).toBe(result.summary);
	});

	test('the first feature has no save point: starts again from the plan, retry still carries the summary', async () => {
		const features = [feature({ featureId: 'f1', position: 1, status: 'building', title: 'First feature', attempts: 3 })];
		world = await seedBlockedBuild(features, 'checks failed');
		const calls: { rolledBack: boolean; retryMessage?: string } = { rolledBack: false };
		const result = await tryAgainFromSavePoint(
			world.db,
			world.scope,
			{ key: 'k87654321' },
			undefined,
			{
				rollback: async () => {
					calls.rolledBack = true;
				},
				retry: async (_key, request) => {
					calls.retryMessage = request;
				},
			},
		);
		expect(result.startedFrom).toBe('plan');
		expect(calls.rolledBack).toBe(false); // no rollback for the first feature
		expect(calls.retryMessage).toContain('First feature');
	});

	test('refused when the build is not stopped after 3 tries', async () => {
		const features = [feature({ featureId: 'f1', position: 1, status: 'building', attempts: 1 })];
		world = await seedBlockedBuild(features, 'one failure');
		let code: string | undefined;
		try {
			await tryAgainFromSavePoint(world.db, world.scope, { key: 'knotready' }, undefined, { rollback: async () => {}, retry: async () => {} });
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe('NO_TRY_AGAIN');
	});
});
