import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { ensureWorkflow } from '../apps/app/src/server/build-workflow.ts';
import {
	projectAppFeaturesOn,
	readSwitch,
	readSwitches,
	setSwitch,
	stampProjectModes,
	SwitchError,
} from '../apps/app/src/server/platform-switches.ts';
import { readFileSync } from 'node:fs';
import { createOperatorRouter } from '../apps/app/src/server/routes/operator.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * Software-team mode foundations (plan section 4): the platform-switch store,
 * project-mode stamping, ensureWorkflow's one-time stamp, and the operator
 * switches route. LOCAL VERIFIED in-process over the full migration set.
 */

const ORIGIN = 'https://caddie.example.com';
const now = '2026-10-22T00:00:00.000Z';

function activeJudge(sqlite: Database, userId: string, name: string): void {
	sqlite.prepare('insert into "judge_accounts" ("judgeName","userId","state","createdAt") values (?,?,?,?)').run(name, userId, 'active', now);
}

describe('platform switches: defaults, precedence, dependency, log', () => {
	let sqlite: Database;
	let db: D1Database;

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
	});
	afterEach(() => sqlite.close());

	test('defaults: first three off, last two on, when env is unset', async () => {
		expect(await readSwitch(db, {}, 'team_mode')).toBe('off');
		expect(await readSwitch(db, {}, 'big_apps')).toBe('off');
		expect(await readSwitch(db, {}, 'app_features')).toBe('off');
		expect(await readSwitch(db, {}, 'spend_enforcement')).toBe('on');
		expect(await readSwitch(db, {}, 'publish_safety')).toBe('on');
	});

	test('env gives the default and a stored value overrides env', async () => {
		const env = { TEAM_MODE: 'on', SPEND_ENFORCEMENT: 'off' };
		expect(await readSwitch(db, env, 'team_mode')).toBe('on');
		expect(await readSwitch(db, env, 'spend_enforcement')).toBe('off');
		// readSwitches reports the source.
		let readings = await readSwitches(db, env);
		expect(readings.find((r) => r.key === 'team_mode')).toEqual({ key: 'team_mode', value: 'on', source: 'env' });
		// A stored row wins, and its source is 'set'.
		await setSwitch(db, env, 'owner-1', 'team_mode', 'owner', now);
		expect(await readSwitch(db, env, 'team_mode')).toBe('owner');
		readings = await readSwitches(db, env);
		expect(readings.find((r) => r.key === 'team_mode')).toEqual({ key: 'team_mode', value: 'owner', source: 'set' });
	});

	test('an unknown or invalid value is refused', async () => {
		await expect(setSwitch(db, {}, 'owner-1', 'nope' as never, 'on' as never, now)).rejects.toBeInstanceOf(SwitchError);
		await expect(setSwitch(db, {}, 'owner-1', 'spend_enforcement', 'owner' as never, now)).rejects.toBeInstanceOf(SwitchError);
		await expect(setSwitch(db, {}, 'owner-1', 'team_mode', 'maybe' as never, now)).rejects.toBeInstanceOf(SwitchError);
	});

	test('big_apps/app_features cannot be on or owner while team_mode is off', async () => {
		await expect(setSwitch(db, {}, 'owner-1', 'big_apps', 'on', now)).rejects.toMatchObject({ code: 'team_mode_required' });
		await expect(setSwitch(db, {}, 'owner-1', 'app_features', 'owner', now)).rejects.toMatchObject({ code: 'team_mode_required' });
		// Turning team_mode off is refused while a dependent is on.
		await setSwitch(db, {}, 'owner-1', 'team_mode', 'on', now);
		await setSwitch(db, {}, 'owner-1', 'big_apps', 'on', now);
		await expect(setSwitch(db, {}, 'owner-1', 'team_mode', 'off', now)).rejects.toMatchObject({ code: 'dependents_on' });
		// With team_mode on, big_apps on is allowed (already set); turn it off, then team_mode off is fine.
		await setSwitch(db, {}, 'owner-1', 'big_apps', 'off', now);
		await expect(setSwitch(db, {}, 'owner-1', 'team_mode', 'off', now)).resolves.toMatchObject({ value: 'off' });
	});

	test('every flip writes exactly one log row with who, old and new', async () => {
		await setSwitch(db, {}, 'owner-1', 'team_mode', 'on', now);
		await setSwitch(db, {}, 'owner-1', 'team_mode', 'owner', now);
		const rows = sqlite.prepare('select key, oldValue, newValue, actorId from platform_switch_log').all() as Array<Record<string, unknown>>;
		expect(rows.length).toBe(2);
		// Both flips are stamped at the same `now`, so assert by content, not by
		// row order (same-instant rows have no guaranteed order).
		const first = rows.find((r) => r.newValue === 'on');
		const second = rows.find((r) => r.newValue === 'owner');
		// First flip: no prior stored value.
		expect(first).toMatchObject({ key: 'team_mode', oldValue: null, newValue: 'on', actorId: 'owner-1' });
		// Second flip: old is the previously stored value, not the env default.
		expect(second).toMatchObject({ key: 'team_mode', oldValue: 'on', newValue: 'owner', actorId: 'owner-1' });
	});
});

describe('stampProjectModes: on/owner/off x owner account, judge, Flutter', () => {
	let sqlite: Database;
	let db: D1Database;

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		addUser(sqlite, 'judge-1', 'judgey@judges.caddie.invalid');
		activeJudge(sqlite, 'judge-1', 'judgey');
	});
	afterEach(() => sqlite.close());

	test('on -> true for everyone; off -> false for everyone', async () => {
		const env = { TEAM_MODE: 'on', BIG_APPS: 'on', APP_FEATURES: 'off' };
		expect(await stampProjectModes(db, env, 'owner-1', 'react-hono')).toEqual({ teamMode: true, bigApps: true, appFeatures: false });
		expect(await stampProjectModes(db, env, 'judge-1', 'react-hono')).toEqual({ teamMode: true, bigApps: true, appFeatures: false });
	});

	test('owner -> true for an ordinary account, false for a judge', async () => {
		const env = { TEAM_MODE: 'owner', BIG_APPS: 'owner', APP_FEATURES: 'owner' };
		expect(await stampProjectModes(db, env, 'owner-1', 'react-hono')).toEqual({ teamMode: true, bigApps: true, appFeatures: true });
		expect(await stampProjectModes(db, env, 'judge-1', 'react-hono')).toEqual({ teamMode: false, bigApps: false, appFeatures: false });
	});

	test('a Flutter project is always all false, whatever the switches say', async () => {
		const env = { TEAM_MODE: 'on', BIG_APPS: 'on', APP_FEATURES: 'on' };
		expect(await stampProjectModes(db, env, 'owner-1', 'flutter')).toEqual({ teamMode: false, bigApps: false, appFeatures: false });
	});
});

describe('ensureWorkflow stamps once and never changes an existing workflow', () => {
	let sqlite: Database;
	let db: D1Database;

	async function makeProject(): Promise<{ projectId: string; scope: Awaited<ReturnType<typeof projectScopeForUser>> }> {
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		const project = await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Farm', description: 'A farm app' });
		const scope = await projectScopeForUser(db, 'owner-1', project.id);
		return { projectId: project.id, scope };
	}

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
	});
	afterEach(() => sqlite.close());

	test('a created workflow is stamped with the resolved modes', async () => {
		const { projectId, scope } = await makeProject();
		await ensureWorkflow(db, scope, { TEAM_MODE: 'on', BIG_APPS: 'owner' });
		const row = sqlite.prepare('select teamMode, bigApps, appFeatures from build_workflows where projectId = ?').get(projectId) as Record<string, number>;
		expect(row).toEqual({ teamMode: 1, bigApps: 1, appFeatures: 0 });
	});

	test('an existing workflow keeps its mode even if the switches change', async () => {
		const { projectId, scope } = await makeProject();
		await ensureWorkflow(db, scope, { TEAM_MODE: 'off' }); // created off
		expect((sqlite.prepare('select teamMode from build_workflows where projectId = ?').get(projectId) as { teamMode: number }).teamMode).toBe(0);
		// Switches flip on, but ensureWorkflow is called again for the same project.
		await ensureWorkflow(db, scope, { TEAM_MODE: 'on', BIG_APPS: 'on' });
		const row = sqlite.prepare('select teamMode, bigApps from build_workflows where projectId = ?').get(projectId) as Record<string, number>;
		expect(row).toEqual({ teamMode: 0, bigApps: 0 });
	});

	test('a Flutter project workflow is stamped all false', async () => {
		const { projectId, scope } = await makeProject();
		// Seed a flutter run binding so ensureWorkflow reads stackId='flutter'.
		sqlite
			.prepare('insert into run_bindings (runId, projectId, conversationId, submissionId, planRevision, stackId, payerId, modelRouteId, pricingVersion, createdBy, createdAt) values (?,?,?,?,?,?,?,?,?,?,?)')
			.run('run-f', projectId, 'conv-f', 'sub-f', 'rev-0', 'flutter', 'owner-1', 'route', 'pv', 'owner-1', now);
		await ensureWorkflow(db, scope, { TEAM_MODE: 'on', BIG_APPS: 'on', APP_FEATURES: 'on' });
		const row = sqlite.prepare('select teamMode, bigApps, appFeatures from build_workflows where projectId = ?').get(projectId) as Record<string, number>;
		expect(row).toEqual({ teamMode: 0, bigApps: 0, appFeatures: 0 });
	});
});

describe('operator switches route: operators only', () => {
	let sqlite: Database;
	let db: D1Database;
	let actor: { id: string; email: string } | null;

	const router = createOperatorRouter({ actorFor: async () => actor });
	const env = () => ({ DB: db, OPERATOR_EMAILS: 'ops@example.com', TEAM_MODE: 'off' }) as never;
	const get = () => router.request(`${ORIGIN}/operator/switches`, {}, env());
	const post = (body: unknown, origin = ORIGIN) =>
		router.request(`${ORIGIN}/operator/switches`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }, env());

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'ops-1', 'ops@example.com');
		addUser(sqlite, 'owner-1', 'owner@example.com');
		addUser(sqlite, 'judge-1', 'judgey@judges.caddie.invalid');
		activeJudge(sqlite, 'judge-1', 'judgey');
		actor = { id: 'ops-1', email: 'ops@example.com' };
	});
	afterEach(() => sqlite.close());

	test('an operator can read the switches and their sources', async () => {
		const res = await get();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { switches: Array<{ key: string; value: string; source: string }> };
		expect(body.switches.find((s) => s.key === 'publish_safety')).toEqual({ key: 'publish_safety', value: 'on', source: 'env' });
	});

	test('an operator can flip a switch; it is recorded and read back', async () => {
		const res = await post({ key: 'team_mode', value: 'on' });
		expect(res.status).toBe(200);
		expect((await res.json()) as unknown).toEqual({ switch: { key: 'team_mode', value: 'on', source: 'set' } });
		expect((sqlite.prepare('select count(*) as n from platform_switch_log').get() as { n: number }).n).toBe(1);
		// The dependency rule is enforced through the route too.
		const bad = await post({ key: 'app_features', value: 'off' });
		expect(bad.status).toBe(200); // off is always allowed
	});

	test('a non-signed-in caller, a non-operator and a judge are all refused', async () => {
		actor = null;
		expect((await get()).status).toBe(401);
		actor = { id: 'owner-1', email: 'owner@example.com' };
		expect((await get()).status).toBe(403);
		expect((await post({ key: 'team_mode', value: 'on' })).status).toBe(403);
		// A judge signs in with their synthetic address, which is not an operator email.
		actor = { id: 'judge-1', email: 'judgey@judges.caddie.invalid' };
		expect((await get()).status).toBe(403);
		expect((await post({ key: 'team_mode', value: 'on' })).status).toBe(403);
		// Nothing was written by any refused call.
		expect((sqlite.prepare('select count(*) as n from platform_switch_log').get() as { n: number }).n).toBe(0);
	});

	test('a cross-origin post is refused, and an unknown switch is a 400', async () => {
		expect((await post({ key: 'team_mode', value: 'on' }, 'https://evil.example')).status).toBe(403);
		expect((await post({ key: 'nope', value: 'on' })).status).toBe(400);
	});
});

describe("projectAppFeaturesOn: the project's stamp, with the switch as a global stop", () => {
	let sqlite: Database;
	let db: D1Database;

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
	});
	afterEach(() => sqlite.close());

	async function projectStamped(appFeatures: boolean): Promise<string> {
		const ws = await createWorkspace(db, 'owner-1', { name: `W${appFeatures ? 1 : 0}` });
		const project = await createProject(db, { workspaceId: ws.id, actorId: 'owner-1' } as never, { workspaceId: ws.id, name: 'P' });
		sqlite
			.prepare('insert into "build_workflows" ("projectId","runId","conversationId","intakeKey","brief","phase","updatedAt","appFeatures") values (?,?,?,?,?,?,?,?)')
			.run(project.id, `run-${project.id}`, `conv-${project.id}`, `intake-${project.id}`, 'b', 'building', now, appFeatures ? 1 : 0);
		return project.id;
	}

	test('stamped on and the switch not off: on; stamped off, no workflow, or the switch off: off', async () => {
		const on = await projectStamped(true);
		const off = await projectStamped(false);
		expect(await projectAppFeaturesOn(db, { APP_FEATURES: 'on' }, on)).toBe(true);
		expect(await projectAppFeaturesOn(db, { APP_FEATURES: 'owner' }, on)).toBe(true);
		expect(await projectAppFeaturesOn(db, { APP_FEATURES: 'on' }, off)).toBe(false);
		expect(await projectAppFeaturesOn(db, { APP_FEATURES: 'on' }, 'no-such-project')).toBe(false);
		// MUTATION PROOF: ignore the switch and a project stamped on keeps photo
		// AI after the owner turns app features off everywhere.
		expect(await projectAppFeaturesOn(db, { APP_FEATURES: 'off' }, on)).toBe(false);
		await setSwitch(db, { TEAM_MODE: 'on', APP_FEATURES: 'on' }, 'owner-1', 'app_features', 'off');
		expect(await projectAppFeaturesOn(db, { TEAM_MODE: 'on', APP_FEATURES: 'on' }, on)).toBe(false);
	});

	test("both app AI entry points (preview and published) pass the project's app features", () => {
		const source = readFileSync(new URL('../apps/app/src/server/app-platform.ts', import.meta.url), 'utf8');
		// MUTATION PROOF: drop the call from either entry point and the count falls.
		expect(source.match(/appFeatures: await projectAppFeaturesOn\(this\.env\.DB, this\.env, projectId\)/g)?.length ?? 0).toBe(2);
	});
});
