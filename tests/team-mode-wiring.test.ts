import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	InMemorySandboxPersistence,
	SandboxDriver,
} from '../apps/app/src/server/adapters/sandbox.ts';
import { ContreeClient } from '../apps/app/src/server/adapters/contree.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject, createPlanDocRevision } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import {
	startPart,
	finishPart,
	restoreFiles,
	activePart,
	clearActivePart,
} from '../apps/app/src/server/build-steps.ts';
import { snapshotReadPort, snapshotWritePort, type ImageInspect } from '../apps/app/src/server/part-snapshot.ts';
import { runTeamModeContractChecks } from '../apps/app/src/server/host-checks.ts';
import { recordRepairRound } from '../apps/app/src/server/runs.ts';
import {
	recordOutputContractReceipts,
	readOutputContractReceipts,
} from '../apps/app/src/server/output-contract-receipts.ts';
import { checkPublishSafety } from '../apps/app/src/server/publish-safety.ts';
import { featuresInContractScope, type BuildFeatureRow } from '../apps/app/src/server/build-features.ts';
import type { ArchitectureBlock, Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';

/**
 * Lane tm/wiring — the seams coordinator-host.ts connects, tested where the
 * host's own helpers delegate: the part-boundary flow over the REAL driver +
 * contree stub (so a script's change is caught exactly as the host's
 * finishActivePart catches it), the contract-check → repair-round recording,
 * and the per-output receipt round-trip that gates a team-mode publish.
 *
 * LOCAL VERIFIED for the driver↔contree transport (the local stub the P04/P05
 * contract suite uses) and the DB-backed flow; never evidence about the live
 * sandbox or a real model turn.
 */

const TOKEN = 'stub-token-local-only-not-a-secret';
const IMAGE_TAG = 'tag:base:1';
const WORKSPACE_ROOT = '/workspace';

const SMALL_BLOCK: ArchitectureBlock = {
	version: 2,
	signIn: 'required',
	team: null,
	modules: [{ id: 'app', plain: 'The app', dependsOn: [] }],
	tables: [],
	routes: [],
	screens: [],
	services: [],
	ai: [],
	payments: null,
	emails: [],
	jobs: [],
	screenOnly: [],
};

/** A project with an APPROVED design revision stamped (what the host reads). */
async function seedProject(): Promise<{ sqlite: Database; db: D1Database; scope: Scope; root: string; projectId: string }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Farm' });
	const scope = await projectScopeForUser(db, 'alice', project.id);
	const design = ['# Design', '```caddie-architecture', JSON.stringify(SMALL_BLOCK), '```'].join('\n');
	const revision = await createPlanDocRevision(db, scope, { kind: 'design', body: design });
	const now = new Date().toISOString();
	// A run binding, as a real build has (recordRepairRound scopes to it).
	await db
		.prepare(
			'insert into "run_bindings" ("runId","projectId","conversationId","submissionId","planRevision","stackId","payerId","modelRouteId","pricingVersion","createdBy","createdAt") ' +
				'values (?,?,?,?,?,?,?,?,?,?,?)',
		)
		.bind(`run_${project.id}`, project.id, `conv_${project.id}`, `sub_${project.id}`, revision.id, 'react-hono', 'alice', 'route', 'v1', 'alice', now)
		.run();
	await db
		.prepare(
			'insert into "build_workflows" ("projectId","runId","conversationId","intakeKey","brief","phase","updatedAt","teamMode","approvedDesignRevisionId") ' +
				'values (?,?,?,?,?,?,?,1,?)',
		)
		.bind(project.id, `run_${project.id}`, `conv_${project.id}`, `intake_${project.id}`, 'brief', 'building', now, revision.id)
		.run();
	return { sqlite, db, scope, root: `${WORKSPACE_ROOT}/${project.id}`, projectId: project.id };
}

describe('team-mode wiring — part boundary over the real driver + contree stub', () => {
	let stub: SandboxStub;
	beforeAll(async () => {
		stub = new SandboxStub({ expectedToken: TOKEN });
		stub.seedImage(IMAGE_TAG);
		await stub.start();
	});
	afterAll(async () => {
		await stub.stop();
	});

	function makeDriver(): { driver: SandboxDriver; inspect: ImageInspect } {
		const driver = new SandboxDriver(
			{
				contree: { baseUrl: stub.url, apiToken: TOKEN, platformProjectId: 'platform-project-test' },
				quotas: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 64 * 1024, maxCommandTimeoutMs: 30_000 },
				workspaceRoot: WORKSPACE_ROOT,
				pollIntervalMs: 5,
				dispatchTimeoutMs: 2_000,
			},
			new InMemorySandboxPersistence(),
		);
		const inspect = new ContreeClient({ baseUrl: stub.url, apiToken: TOKEN, platformProjectId: 'platform-project-test' }) as unknown as ImageInspect;
		return { driver, inspect };
	}

	async function sessionImage(driver: SandboxDriver, sessionId: string): Promise<string> {
		const persistence = (driver as unknown as { persistence: { load(key: string): Promise<{ image: string | null } | null> } }).persistence;
		const record = await persistence.load(`session:${sessionId}`);
		if (!record?.image) throw new Error('no session image');
		return record.image;
	}

	test('item 1: a frontend write during a BACKEND part is refused by finishPart, and restore_files fixes it', async () => {
		const world = await seedProject();
		const { db, scope, root, projectId } = world;
		const { driver, inspect } = makeDriver();
		const { sessionId } = await driver.ensureSession({ sessionKey: `session:run_${projectId}`, image: IMAGE_TAG, projectId, runId: `run_${projectId}` });
		await driver.uploadFiles(sessionId, [
			{ path: `${root}/src/server.ts`, contentBase64: Buffer.from('export const api = 1;', 'utf8').toString('base64') },
			{ path: `${root}/src/App.tsx`, contentBase64: Buffer.from('export const App = () => null;', 'utf8').toString('base64') },
		]);
		const startImage = await sessionImage(driver, sessionId);

		// Hand-out: start a BACKEND part from the committed image (as the host's
		// ensureActivePart does on the builder's first write).
		const started = await startPart(db, scope, snapshotReadPort(inspect, startImage, root), { featureId: 'f1', role: 'backend' });
		expect(started.role).toBe('backend');

		// A frontend file is changed (out of the backend area) via a write-tool
		// path — upload a new src/App.tsx into the session and commit.
		await driver.writeFile(sessionId, `${root}/src/App.tsx`, Buffer.from('export const App = () => "edited";', 'utf8').toString('base64'));
		const current = await sessionImage(driver, sessionId);
		expect(current).not.toBe(startImage);

		// finishPart on the CURRENT image refuses and lists the out-of-area file.
		const refused = await finishPart(db, scope, snapshotReadPort(inspect, current, root));
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.outOfArea.map((c) => c.path)).toEqual(['src/App.tsx']);
			expect(refused.message).toContain('src/App.tsx');
		}

		// restore_files puts it back from the start image (write port over the driver).
		const write = snapshotWritePort(inspect, startImage, driver, sessionId, root);
		const result = await restoreFiles(db, scope, { read: snapshotReadPort(inspect, await sessionImage(driver, sessionId), root), write }, ['src/App.tsx']);
		expect(result.restored).toEqual(['src/App.tsx']);

		// Now finishPart is clean.
		const after = await finishPart(db, scope, snapshotReadPort(inspect, await sessionImage(driver, sessionId), root));
		expect(after).toEqual({ ok: true });
		world.sqlite.close();
	});

	test('item 2: a SCRIPT change (sandbox_exec) outside the area is caught by finishPart', async () => {
		const world = await seedProject();
		const { db, scope, root, projectId } = world;
		const { driver, inspect } = makeDriver();
		const { sessionId } = await driver.ensureSession({ sessionKey: `session:run_${projectId}`, image: IMAGE_TAG, projectId, runId: `run_${projectId}` });
		await driver.uploadFiles(sessionId, [
			{ path: `${root}/src/server.ts`, contentBase64: Buffer.from('export const api = 1;', 'utf8').toString('base64') },
			{ path: `${root}/src/App.tsx`, contentBase64: Buffer.from('export const App = () => null;', 'utf8').toString('base64') },
		]);
		const startImage = await sessionImage(driver, sessionId);
		await startPart(db, scope, snapshotReadPort(inspect, startImage, root), { featureId: 'f1', role: 'backend' });

		// A build SCRIPT (what sandbox_exec runs) rewrites the frontend file.
		stub.setBehavior('generate-ui', { exitCode: 0, writes: { [`${root}/src/App.tsx`]: 'export const App = () => "by a script";' } });
		await driver.execute({ sessionId, command: 'node scripts/generate-ui.mjs', operationKey: 'op-script', timeoutMs: 10_000 });

		const refused = await finishPart(db, scope, snapshotReadPort(inspect, await sessionImage(driver, sessionId), root));
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.outOfArea.map((c) => `${c.path}:${c.kind}`)).toEqual(['src/App.tsx:modified']);
		world.sqlite.close();
	});

	test('a clean backend part finishes and clears its active pointer', async () => {
		const world = await seedProject();
		const { db, scope, root, projectId } = world;
		const { driver, inspect } = makeDriver();
		const { sessionId } = await driver.ensureSession({ sessionKey: `session:run_${projectId}`, image: IMAGE_TAG, projectId, runId: `run_${projectId}` });
		await driver.uploadFiles(sessionId, [{ path: `${root}/src/server.ts`, contentBase64: Buffer.from('export const api = 1;', 'utf8').toString('base64') }]);
		const startImage = await sessionImage(driver, sessionId);
		await startPart(db, scope, snapshotReadPort(inspect, startImage, root), { featureId: 'f1', role: 'backend' });
		// An IN-AREA change (src/server/...) is fine.
		await driver.writeFile(sessionId, `${root}/src/server/handler.ts`, Buffer.from('export const h = 1;', 'utf8').toString('base64'));
		const current = await sessionImage(driver, sessionId);
		expect(await finishPart(db, scope, snapshotReadPort(inspect, current, root))).toEqual({ ok: true });
		await clearActivePart(db, scope);
		expect(await activePart(db, scope)).toBeNull();
		world.sqlite.close();
	});
});

describe('team-mode wiring — contract check gating (part E, item 3)', () => {
	test('a failing contract phase blocks the feature and its plain sentence is recorded as a repair round', async () => {
		const { sqlite, db, scope } = await seedProject();
		// The host runs the phases through runTeamModeContractChecks; a failing
		// `read` phase (the restart check) yields a plain sentence.
		const outcome = await runTeamModeContractChecks(async (phase) => {
			if (phase === 'create') return { exitCode: 0, output: '1 pass\n0 fail' };
			if (phase === 'read') return { exitCode: 1, output: '0 pass\n1 fail' };
			return { exitCode: 0, output: '1 pass\n0 fail' };
		});
		expect(outcome.passed).toBe(false);
		expect(outcome.failureSentence).toBe('Something you saved is gone after the app restarts.');
		// restart (from `read`) is red; sign-in (from `create`) is green.
		expect(outcome.checks['sign-in']).toBe(true);
		expect(outcome.checks.restart).toBe(false);

		// The host records the sentence as a repair round (exactly what
		// runHostChecks does on a failed contract check).
		const round = await recordRepairRound(db, scope, `run_${scope.projectId}`, {
			issue: 'f1:contract',
			round: 'repair_attempt',
			outcome: 'failed',
			detail: outcome.failureSentence!,
		});
		expect(round).toBeTruthy();
		const rows = (
			await db
				.prepare('select "issue","detail" from "run_rounds" where "projectId" = ? and "round" = \'repair_attempt\' and "outcome" = \'failed\'')
				.bind(scope.projectId)
				.all<{ issue: string; detail: string }>()
		).results ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.issue).toBe('f1:contract');
		expect(rows[0]!.detail).toBe('Something you saved is gone after the app restarts.');
		sqlite.close();
	});
});

describe('team-mode wiring — publish receipts (part G, item 4)', () => {
	const bundle = { js: 'console.log(1)', css: 'body{}', server: 'export default {}' };
	const base = { ...bundle, savedKeyNames: [] as string[], teamMode: true, publishSafety: 'on' as const };

	test('a publish with GREEN receipts for THAT output passes; recorded via the store and read back', async () => {
		const { sqlite, db, scope } = await seedProject();
		await recordOutputContractReceipts(db, scope.projectId, 'out-1', { 'sign-in': true, 'second-person': true, restart: true });
		const receipts = await readOutputContractReceipts(db, scope.projectId, 'out-1');
		expect(receipts).toEqual({ outputId: 'out-1', checks: { 'sign-in': true, 'second-person': true, restart: true } });
		const result = checkPublishSafety({ outputId: 'out-1', ...base, receipts });
		expect(result.refused).toBe(false);
		sqlite.close();
	});

	test('a publish with NO receipt for the output is refused in team mode', async () => {
		const { sqlite, db, scope } = await seedProject();
		const receipts = await readOutputContractReceipts(db, scope.projectId, 'out-missing');
		expect(receipts).toBeNull();
		const result = checkPublishSafety({ outputId: 'out-missing', ...base, receipts });
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'missing-receipt')).toBe(true);
		sqlite.close();
	});

	test('a GREEN receipt for a DIFFERENT output does not count (bound to the output id)', async () => {
		const { sqlite, db, scope } = await seedProject();
		await recordOutputContractReceipts(db, scope.projectId, 'out-other', { 'sign-in': true, 'second-person': true, restart: true });
		// Reading for the output being published returns null (no receipt for it).
		const forThis = await readOutputContractReceipts(db, scope.projectId, 'out-under-publish');
		expect(forThis).toBeNull();
		const result = checkPublishSafety({ outputId: 'out-under-publish', ...base, receipts: forThis });
		expect(result.refused).toBe(true);
		sqlite.close();
	});

	test('a RED check in the receipt refuses the publish', async () => {
		const { sqlite, db, scope } = await seedProject();
		await recordOutputContractReceipts(db, scope.projectId, 'out-red', { 'sign-in': true, 'second-person': false, restart: true });
		const receipts = await readOutputContractReceipts(db, scope.projectId, 'out-red');
		const result = checkPublishSafety({ outputId: 'out-red', ...base, receipts });
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'red-receipt')).toBe(true);
		sqlite.close();
	});
});

describe('team-mode wiring — the contract check covers the features built so far (part E)', () => {
	const row = (featureId: string, position: number, status: BuildFeatureRow['status']): BuildFeatureRow => ({
		projectId: 'p',
		runId: 'r',
		planId: 'plan',
		featureId,
		position,
		title: featureId,
		doneWhen: [],
		status,
		attempts: 0,
		testsPassed: null,
		checkpointRef: null,
		passedAt: null,
	});

	test('passed features plus the one being built; later features are left out', () => {
		expect(featuresInContractScope([row('crews', 0, 'passed'), row('logs', 1, 'building'), row('admin', 2, 'pending')])).toEqual(['crews', 'logs']);
	});

	test('a feature that failed a try is still the current one', () => {
		expect(featuresInContractScope([row('crews', 0, 'passed'), row('logs', 1, 'failed'), row('admin', 2, 'pending')])).toEqual(['crews', 'logs']);
	});

	test('before any feature passes, only the first; when all have passed, all of them', () => {
		expect(featuresInContractScope([row('crews', 0, 'pending'), row('logs', 1, 'pending')])).toEqual(['crews']);
		expect(featuresInContractScope([row('crews', 0, 'passed'), row('logs', 1, 'passed')])).toEqual(['crews', 'logs']);
	});
});
