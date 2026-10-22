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
	type FailedRound,
} from '../apps/app/src/server/build-steps.ts';

/**
 * Lane 5, part F (+ review items 1 & 2): the stopped-build card offers "Try
 * this feature again from the last save point" ONLY on a TEAM-MODE build that
 * stopped after 3 failed tries. It uses the existing rollback (build-features,
 * which only works when the build is stopped) then the existing
 * message-carrying retry, carrying a summary built from the CHECK RECEIPTS
 * (run_rounds), not the blocker. For the first feature it starts from the plan.
 *
 * LOCAL VERIFIED for the pure gate (team mode + 3-fail), the receipt-derived
 * summary, and the composition (which featureId is rolled back to and the exact
 * summary the retry carries) over a bun:sqlite D1 with injected rollback/retry
 * ports. The real rollback and retry are proven in build-workflow.test.ts.
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

// --- the gate (item 1: team mode only) ---------------------------------------

describe('part F — canTryAgainFromSavePoint (team-mode, stopped, 3 failed tries)', () => {
	const stuck = [feature({ featureId: 'f2', position: 2, status: 'building', attempts: REPAIR_PAUSE_THRESHOLD })];

	test('offered on a TEAM-MODE build blocked after 3 failed tries', () => {
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: 'checks failed', teamMode: 1 }, stuck)).toBe(true);
	});

	// Item 1: team mode only. With teamMode 0 (or absent) the gate is false, so
	// behaviour with team mode off is unchanged and the route refuses.
	test('NOT offered when team mode is off (teamMode 0 or absent)', () => {
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: 'checks failed', teamMode: 0 }, stuck)).toBe(false);
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: 'checks failed' }, stuck)).toBe(false);
	});

	test('NOT offered while the build is running', () => {
		expect(canTryAgainFromSavePoint({ phase: 'building', detail: null, teamMode: 1 }, stuck)).toBe(false);
		expect(canTryAgainFromSavePoint({ phase: 'ready', detail: null, teamMode: 1 }, stuck)).toBe(false);
	});

	test('NOT offered when the user stopped the build (STOP_SENTINEL detail)', () => {
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: STOP_SENTINEL, teamMode: 1 }, stuck)).toBe(false);
	});

	test('NOT offered before 3 failed tries', () => {
		const earlier = [feature({ featureId: 'f2', position: 2, status: 'building', attempts: 2 })];
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: 'one failure', teamMode: 1 }, earlier)).toBe(false);
	});

	test('NOT offered when every feature already passed (nothing to try again)', () => {
		const done = [feature({ featureId: 'f1', position: 1, status: 'passed', attempts: 1 })];
		expect(canTryAgainFromSavePoint({ phase: 'blocked', detail: 'x', teamMode: 1 }, done)).toBe(false);
	});
});

// --- the summary (item 2: from the check receipts) ---------------------------

describe('part F — failureSummary is built from the check receipts', () => {
	test('keeps title + try count and names the failed checks, newest first, de-duplicated, max 3', () => {
		const f = feature({ featureId: 'f2', position: 2, title: 'Save a todo', attempts: 3 });
		const rounds: FailedRound[] = [
			{ issue: 'f2:behavior-tests', detail: 'The behavior tests fail: 2 of 5 tests failed.' },
			{ issue: 'f2:browser-build', detail: 'The app does not build: Could not resolve "./missing".' },
			{ issue: 'f2:behavior-tests', detail: 'The behavior tests fail: 2 of 5 tests failed.' }, // duplicate
			{ issue: 'f2:new-tests', detail: 'No new tests were added for this feature.' },
		];
		const summary = failureSummary(f, rounds);
		expect(summary).toContain('Save a todo');
		expect(summary).toContain('3 failed tries');
		// Named checks (the receipts), not the vague blocker.
		expect(summary).toContain('The behavior tests fail');
		expect(summary).toContain('does not build');
		// De-duplicated: the repeated behavior-tests sentence appears once.
		expect(summary.match(/The behavior tests fail/g)?.length).toBe(1);
		expect(summary).not.toContain('could not get the app checks passing');
	});

	test('at most 3 distinct check sentences, about 600 characters max', () => {
		const f = feature({ featureId: 'f2', position: 2, title: 'A feature', attempts: 3 });
		const rounds: FailedRound[] = Array.from({ length: 6 }, (_, i) => ({
			issue: `f2:check-${i}`,
			detail: `Check ${i} failed with a long sentence padded out `.repeat(6),
		}));
		const summary = failureSummary(f, rounds);
		expect(summary.length).toBeLessThanOrEqual(600);
		expect(summary).toContain('A feature'); // the base is always kept
	});

	test('reads correctly with no failed rounds (base only)', () => {
		const summary = failureSummary(feature({ featureId: 'f1', position: 1, title: 'A', attempts: 3 }), []);
		expect(summary).toContain('A');
		expect(summary).not.toContain('What failed last time');
	});
});

// --- the composition: rollback + retry carry the receipt summary -------------

async function seedBlockedBuild(
	features: BuildFeatureRow[],
	detail: string,
	opts: { teamMode?: number; rounds?: Array<{ issue: string; detail: string }> } = {},
): Promise<{ sqlite: Database; db: D1Database; scope: Scope; runId: string }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Todo' });
	const scope = await projectScopeForUser(db, 'alice', project.id);
	const stamp = new Date().toISOString();
	const runId = 'run1';
	sqlite
		.prepare(
			'insert into build_workflows (projectId,runId,conversationId,intakeKey,brief,phase,planId,detail,teamMode,bigApps,appFeatures,updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?)',
		)
		.run(project.id, runId, 'conv1', `k:${project.id}`, 'brief', 'blocked', 'pl', detail, opts.teamMode ?? 1, 0, 0, stamp);
	for (const f of features) {
		sqlite
			.prepare(
				'insert into build_features (projectId,runId,planId,featureId,position,title,doneWhen,status,attempts,testsPassed,checkpointRef,passedAt,updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
			)
			.run(project.id, runId, 'pl', f.featureId, f.position, f.title, JSON.stringify(f.doneWhen), f.status, f.attempts, f.testsPassed, f.checkpointRef, f.passedAt, stamp);
	}
	// The failed repair rounds the summary is built from (run_rounds, 0005).
	let i = 0;
	for (const round of opts.rounds ?? []) {
		sqlite
			.prepare(
				'insert into run_rounds (id,runId,projectId,issue,round,outcome,detail,createdAt) values (?,?,?,?,?,?,?,?)',
			)
			.run(`rr_${i}`, runId, project.id, round.issue, 'repair_attempt', 'failed', round.detail, new Date(Date.now() + i).toISOString());
		i += 1;
	}
	return { sqlite, db, scope, runId };
}

describe('part F — tryAgainFromSavePoint composes rollback + message-carrying retry', () => {
	let world: Awaited<ReturnType<typeof seedBlockedBuild>>;
	afterEach(() => world?.sqlite.close());

	test('rolls back to the previous passed feature and retries carrying the RECEIPT summary', async () => {
		const features = [
			feature({ featureId: 'f1', position: 1, status: 'passed', attempts: 1, checkpointRef: 'ckpt-f1' }),
			feature({ featureId: 'f2', position: 2, status: 'building', title: 'Save a todo', attempts: 3 }),
		];
		world = await seedBlockedBuild(features, 'Caddie could not get the app checks passing after three attempts.', {
			teamMode: 1,
			rounds: [
				{ issue: 'f2:behavior-tests', detail: 'The behavior tests fail: 2 of 5 tests failed.' },
				{ issue: 'f2:new-tests', detail: 'No new tests were added for this feature.' },
			],
		});
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
		expect(calls.rollbackTo).toBe('f1'); // the previous PASSED feature, not the stuck one
		// The retry carries the RECEIPT-derived summary (named checks), not the blocker.
		expect(calls.retryMessage).toContain('Save a todo');
		expect(calls.retryMessage).toContain('The behavior tests fail');
		expect(calls.retryMessage).not.toContain('could not get the app checks passing');
		expect(calls.retryMessage).toBe(result.summary);
	});

	test('the first feature has no save point: starts from the plan, retry still carries the summary', async () => {
		const features = [feature({ featureId: 'f1', position: 1, status: 'building', title: 'First feature', attempts: 3 })];
		world = await seedBlockedBuild(features, 'checks failed', {
			teamMode: 1,
			rounds: [{ issue: 'f1:browser-build', detail: 'The app does not build.' }],
		});
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
		expect(calls.rolledBack).toBe(false);
		expect(calls.retryMessage).toContain('First feature');
		expect(calls.retryMessage).toContain('does not build');
	});

	test('refused when the build is not stopped after 3 tries', async () => {
		const features = [feature({ featureId: 'f1', position: 1, status: 'building', attempts: 1 })];
		world = await seedBlockedBuild(features, 'one failure', { teamMode: 1 });
		let code: string | undefined;
		try {
			await tryAgainFromSavePoint(world.db, world.scope, { key: 'knotready' }, undefined, { rollback: async () => {}, retry: async () => {} });
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe('NO_TRY_AGAIN');
	});

	// Item 1: the route-level refusal when team mode is OFF (gate false → throw).
	test('refused when team mode is off, even after 3 failed tries', async () => {
		const features = [
			feature({ featureId: 'f1', position: 1, status: 'passed', attempts: 1, checkpointRef: 'ckpt-f1' }),
			feature({ featureId: 'f2', position: 2, status: 'building', attempts: 3 }),
		];
		world = await seedBlockedBuild(features, 'checks failed', { teamMode: 0 });
		let code: string | undefined;
		try {
			await tryAgainFromSavePoint(world.db, world.scope, { key: 'koffmode1' }, undefined, { rollback: async () => {}, retry: async () => {} });
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe('NO_TRY_AGAIN');
	});
});
