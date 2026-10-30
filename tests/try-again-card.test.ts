import { fixtureLegacyQualityPolicy } from './fixtures/migrations.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { ExperienceAction, ExperienceStage, ProjectExperience, Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { nowPanelModel } from '../apps/app/src/client/project/now-panel.ts';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import {
	ensureHomeProject,
	createPlanDocRevision,
} from '../apps/app/src/server/projects.ts';
import { createRun } from '../apps/app/src/server/runs.ts';
import {
	startProjectFromChat,
	decideWorkflow,
	setWorkflowBlocker,
	workflowSnapshot,
} from '../apps/app/src/server/build-workflow.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import { projectExperience } from '../apps/app/src/server/project-experience.ts';

/**
 * Lane 5, part F / review item 6: the stopped-build card's "Try this feature
 * again" button. Two surfaces:
 *   - the Now panel ROUTES a try_again action to POST workflow/try-again;
 *   - the server EMITS a try_again action on a stopped team-mode build after
 *     three failed tries, and only then.
 *
 * LOCAL VERIFIED: the route mapping is pure; the emission runs the REAL
 * approve→blocked flow over production migrations on bun:sqlite.
 */

const NOW = Date.parse('2026-10-22T18:00:00Z');

function experience(stage: ExperienceStage, actions: ExperienceAction[], version = NOW - 60_000): ProjectExperience {
	return { projectId: 'p1', version, stage, plan: null, preview: null, message: `msg:${stage}`, actions };
}

describe('part F — the Now panel routes try_again to workflow/try-again', () => {
	test('a try_again action becomes a POST workflow/try-again button', () => {
		const model = nowPanelModel(
			experience('blocked', [
				{ kind: 'try_again', label: 'Try this feature again', enabled: true, primary: true },
				{ kind: 'retry', label: 'Resume the build', enabled: true, primary: false },
			]),
			NOW,
		);
		const tryAgain = model?.buttons.find((b) => b.kind === 'try_again');
		expect(tryAgain?.route).toEqual({ kind: 'post', path: 'workflow/try-again' });
		// The ordinary resume still routes to workflow/retry.
		expect(model?.buttons.find((b) => b.kind === 'retry')?.route).toEqual({ kind: 'post', path: 'workflow/retry' });
	});

	// Mutation proof: if routeFor mapped try_again to workflow/retry (the easy
	// copy-paste bug), this flips.
	test('try_again does NOT route to workflow/retry', () => {
		const model = nowPanelModel(experience('blocked', [{ kind: 'try_again', label: 'x', enabled: true, primary: true }]), NOW);
		expect(model?.buttons[0]?.route).not.toEqual({ kind: 'post', path: 'workflow/retry' });
	});
});

// --- the server emits try_again only when the gate holds ---------------------

const REPAIR_PAUSE_THRESHOLD = 3;

/**
 * The REAL path to a stopped, approved-plan, team-mode build: start a project,
 * save a plan, approve it, then force teamMode on the row and seed a feature
 * that has failed `attempts` times, and set the blocker.
 */
async function seedStoppedBuild(opts: {
	teamMode: number;
	attempts: number;
}): Promise<{ sqlite: Database; db: D1Database; scope: Scope }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const home = await ensureHomeProject(db, 'alice');
	const homeScope = await projectScopeForUser(db, 'alice', home.id);
	const homeRun = await createRun(db, homeScope, {
		modelRouteId: 'nemotron-3-super',
		payerId: 'alice',
		conversationId: 'conv-home-alice',
	});
	const started = await startProjectFromChat(db, homeScope, {
		name: 'Todo app',
		description: 'A todo app',
		brief: 'Build a modern minimal todo app with saved tasks. Show me the plan first.',
		operationKey: 'tool-create-one',
		sourceConversationId: homeRun.conversationId,
	});
	const scope = await projectScopeForUser(db, 'alice', started.project.id);
// Fixture models a project from before the default-on quality policy (see fixtureLegacyQualityPolicy).
fixtureLegacyQualityPolicy(sqlite, scope.projectId);
	const plan = await createPlanDocRevision(db, scope, { kind: 'prd', body: '# Todo\n\nAdd and save tasks.' });
	await workflowSnapshot(db, scope); // planning -> review
	await decideWorkflow(db, scope, { planId: plan.id, decision: 'approved' }); // approved plan
	// Force team mode on this build (the switch is off by default in tests).
	sqlite.prepare('update build_workflows set teamMode = ? where projectId = ?').run(opts.teamMode, started.project.id);
	// A feature that has failed `attempts` times, and the blocker that stops it.
	const workflow = (sqlite.prepare('select runId from build_workflows where projectId = ?').get(started.project.id) as { runId: string });
	const stamp = new Date().toISOString();
	sqlite
		.prepare(
			'insert into build_features (projectId,runId,planId,featureId,position,title,doneWhen,status,attempts,testsPassed,checkpointRef,passedAt,updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
		)
		.run(started.project.id, workflow.runId, plan.id, 'f2', 2, 'Save a todo', '[]', 'building', opts.attempts, null, null, null, stamp);
	await setWorkflowBlocker(db, scope, 'Caddie could not get the app checks passing after three attempts.');
	return { sqlite, db, scope };
}

describe('part F — projectExperience emits try_again only on a stopped team-mode build after 3 tries', () => {
	let world: Awaited<ReturnType<typeof seedStoppedBuild>>;
	afterEach(() => world?.sqlite.close());

	test('team mode on, 3 failed tries: a primary try_again action plus a secondary resume', async () => {
		world = await seedStoppedBuild({ teamMode: 1, attempts: REPAIR_PAUSE_THRESHOLD });
		const exp = await projectExperience(world.db, world.scope);
		expect(exp.stage).toBe('blocked');
		const tryAgain = exp.actions.find((a) => a.kind === 'try_again');
		expect(tryAgain).toBeDefined();
		expect(tryAgain?.primary).toBe(true);
		// The resume is still offered, as a secondary.
		expect(exp.actions.find((a) => a.kind === 'retry')?.primary).toBe(false);
	});

	// Item 1 at the surface: team mode OFF never shows the button (unchanged).
	test('team mode off: no try_again action, only the plain Retry build', async () => {
		world = await seedStoppedBuild({ teamMode: 0, attempts: REPAIR_PAUSE_THRESHOLD });
		const exp = await projectExperience(world.db, world.scope);
		expect(exp.actions.some((a) => a.kind === 'try_again')).toBe(false);
		expect(exp.actions.map((a) => a.kind)).toEqual(['retry']);
	});

	test('team mode on but fewer than 3 tries: no try_again yet', async () => {
		world = await seedStoppedBuild({ teamMode: 1, attempts: 2 });
		const exp = await projectExperience(world.db, world.scope);
		expect(exp.actions.some((a) => a.kind === 'try_again')).toBe(false);
	});
});
