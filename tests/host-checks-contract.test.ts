// Part E — the team-mode contract phase runner (host-checks.ts
// runTeamModeContractChecks). Unit tests of the gating logic with a stubbed
// phase runner: it must gate on BOTH the exit code AND the parsed counts, run
// the phases in order and stop at the first failure, map passed phases to the
// required checks, and produce a plain failure sentence.
//
// Classification: LOCAL VERIFIED.
import { describe, expect, test } from 'bun:test';
import {
	runTeamModeContractChecks,
	writeContractFiles,
	contractFailureReceipt,
	CONTRACT_PHASES,
	type ContractPhase,
} from '../apps/app/src/server/host-checks.ts';
import { NOTES_BLOCK, TEAM_BLOCK } from './fixtures/contract/notes-apps.ts';
import { FEATURES_BLOCK } from './fixtures/contract/features-apps.ts';
import type { ArchitectureBlock } from '@caddie/contracts';

/** A stub phase runner from a per-phase {exitCode, output} map. */
function runnerFrom(map: Partial<Record<ContractPhase, { exitCode: number; output: string }>>) {
	const seen: ContractPhase[] = [];
	const run = (phase: ContractPhase) => {
		seen.push(phase);
		return map[phase] ?? { exitCode: 0, output: '1 pass\n0 fail' };
	};
	return { run, seen };
}

describe('part E: runTeamModeContractChecks — gating', () => {
	test('every phase green -> passed, all checks green, phases run in order', async () => {
		const { run, seen } = runnerFrom({ 'test-mode': { exitCode: 0, output: 'ran 0 tests' } });
		const outcome = await runTeamModeContractChecks(run);
		expect(outcome.passed).toBe(true);
		expect(seen).toEqual([...CONTRACT_PHASES]);
		expect(outcome.checks).toEqual({ 'sign-in': true, 'second-person': true, restart: true });
		expect(outcome.failureSentence).toBeNull();
	});

	test('a non-zero exit on read fails, even when counts say pass (exit-code gate)', async () => {
		// MUTATION: read exits 1 but still prints "1 pass 0 fail".
		const { run, seen } = runnerFrom({ read: { exitCode: 1, output: '1 pass\n0 fail' } });
		const outcome = await runTeamModeContractChecks(run);
		expect(outcome.passed).toBe(false);
		expect(outcome.checks.restart).toBe(false);
		expect(outcome.failureSentence).toBe('Something you saved is gone after the app restarts.');
		// It stopped at read — the later phases never ran.
		expect(seen).toEqual(['create', 'read']);
	});

	test('a failing count on read fails even when the process exits 0 (counts gate)', async () => {
		// MUTATION: read exits 0 but prints "0 pass 1 fail".
		const { run } = runnerFrom({ read: { exitCode: 0, output: '0 pass\n1 fail' } });
		const outcome = await runTeamModeContractChecks(run);
		expect(outcome.passed).toBe(false);
		expect(outcome.checks.restart).toBe(false);
	});

	test('a core phase that ran ZERO tests fails (vacuous run rejected)', async () => {
		// MUTATION: create exits 0 but ran no tests at all.
		const { run } = runnerFrom({ create: { exitCode: 0, output: 'no tests found' } });
		const outcome = await runTeamModeContractChecks(run);
		expect(outcome.passed).toBe(false);
		expect(outcome.checks['sign-in']).toBe(false);
		expect(outcome.failureSentence).toContain("can't tell if your data is really saved");
	});

	test('the trailing test-mode phase may pass vacuously (nothing declared)', async () => {
		const { run } = runnerFrom({ 'test-mode': { exitCode: 0, output: 'ran 0 tests' } });
		const outcome = await runTeamModeContractChecks(run);
		expect(outcome.passed).toBe(true);
	});

	test('a failing privacy-screen phase maps to second-person and its sentence', async () => {
		const { run } = runnerFrom({ 'privacy-screen': { exitCode: 1, output: '0 pass\n1 fail' } });
		const outcome = await runTeamModeContractChecks(run);
		expect(outcome.passed).toBe(false);
		expect(outcome.checks['second-person']).toBe(false);
		expect(outcome.checks['sign-in']).toBe(true);
		expect(outcome.checks.restart).toBe(true);
		expect(outcome.failureSentence).toContain("One person can see another person's private data");
	});
});

describe('part E: writeContractFiles generates the protected files', () => {
	test('a small app gets contract.ts, api.ts, router.tsx, contract.test.ts and d1-file.ts', () => {
		const files = writeContractFiles(NOTES_BLOCK, 'small');
		expect(Object.keys(files).sort()).toEqual(
			['caddie/api.ts', 'caddie/contract.test.ts', 'caddie/contract.ts', 'caddie/router.tsx', 'test/setup/d1-file.ts'].sort(),
		);
		// Deterministic: the same block yields byte-identical files.
		const again = writeContractFiles(NOTES_BLOCK, 'small');
		expect(files['caddie/contract.ts']).toBe(again['caddie/contract.ts']);
		// The route table carries every declared route.
		for (const route of NOTES_BLOCK.routes) expect(files['caddie/contract.ts']).toContain(route.id);
	});

	test('a big app also gets caddie/modules.ts', () => {
		const files = writeContractFiles(NOTES_BLOCK, 'big');
		expect(files['caddie/modules.ts']).toBeDefined();
	});
});

describe('part E: the generated test is never vacuous and bites on declared features (steps 7-9)', () => {
	const gen = (block: ArchitectureBlock) => writeContractFiles(block, 'small')['caddie/contract.test.ts']!;

	test('no generated test is a test.skip or an early return standing in for a check (step 7 rule)', () => {
		for (const block of [NOTES_BLOCK, TEAM_BLOCK]) {
			const src = gen(block);
			expect(src.includes('test.skip'), 'a generated test must not be a test.skip').toBe(false);
		}
	});

	test('a block that declares payments: the guard locks the route (part J) and the test checks the 402, the cards and End now (step 9)', () => {
		const files = writeContractFiles(FEATURES_BLOCK, 'small');
		// The generated guard answers 402 on a locked route until the person has a plan.
		expect(files['caddie/contract.ts']).toContain('export const LOCKED: Record<string, string[]> = {"reports.export":["pro"]};');
		expect(files['caddie/contract.ts']).toContain('reason: "plan_required"');
		const meta = metaOf(files['caddie/contract.test.ts']!);
		expect((meta.payments as { locked: Array<{ id: string; plans: string[] }> }).locked.map((l) => [l.id, l.plans])).toEqual([['reports.export', ['pro']]]);
		expect(files['caddie/contract.test.ts']).toContain('4000 0000 0000 0002');
		expect(files['caddie/contract.test.ts']).toContain('/api/caddie/end-now');
	});

	test('a block that declares no test-mode feature gets no test-mode checks', () => {
		const files = writeContractFiles(NOTES_BLOCK, 'small');
		const meta = metaOf(files['caddie/contract.test.ts']!);
		expect(meta.payments).toBeNull();
		expect(meta.emails).toEqual([]);
		expect(meta.jobs).toEqual([]);
		expect(meta.files).toBe(false);
		expect(meta.unchecked).toEqual([]);
		expect(files['caddie/contract.ts']).toContain('export const LOCKED: Record<string, string[]> = {};');
	});

	test('step 9 waits for each feature: only built routes are checked while building; the final check covers all', () => {
		const scoped = metaOf(writeContractFiles(FEATURES_BLOCK, 'small', ['reports'])['caddie/contract.test.ts']!);
		expect(scoped.payments).toBeNull(); // the locked export is a later feature
		expect(scoped.emails).toEqual([]);
		expect(scoped.jobs).toEqual([]);
		expect(scoped.files).toBe(true); // the reports table, with its file field, is built
		const whole = metaOf(writeContractFiles(FEATURES_BLOCK, 'small')['caddie/contract.test.ts']!);
		expect((whole.emails as Array<{ id: string }>).map((e) => e.id)).toEqual(['share']);
		expect((whole.jobs as Array<{ id: string }>).map((x) => x.id)).toEqual(['nightly']);
	});

	test('caddie/contract.ts tells the builder the email template, the job rule, and how to mount payments and files', () => {
		const contract = writeContractFiles(FEATURES_BLOCK, 'small')['caddie/contract.ts']!;
		expect(contract).toContain('template: "share"');
		expect(contract).toContain('Job "nightly": the route jobs.nightly runs only from Caddie');
		expect(contract).toContain('mountPayments(app, { currency, plans })');
		expect(contract).toContain('mountFiles(app)');
	});

	test('a declared email whose route the design does not have fails the final check in plain words', () => {
		const broken: ArchitectureBlock = { ...FEATURES_BLOCK, emails: [{ id: 'share', plain: 'Shares a report', route: 'reports.mail', to: 'person' }] };
		const meta = metaOf(writeContractFiles(broken, 'small')['caddie/contract.test.ts']!);
		expect(meta.unchecked).toEqual(['the email "share" names the route reports.mail, which the design does not have']);
	});

	test('a team block embeds the full team subject so step 6 is exercised, not skipped', () => {
		const src = gen(TEAM_BLOCK);
		expect(src).toContain('teams and roles');
		expect(src).toContain('"hasTeam":true');
		// a team-role route and an admin route are both carried for step 6.
		expect(src).toContain('META.role');
		expect(src).toContain('META.admin');
	});
});

// --- lead fixes: feature scope, screen subjects, the current team ------------

/** [table, kind] for each subject the generated test drives, in order. */
function subjectsOf(meta: Record<string, unknown>): Array<[string, string]> {
	return (meta.subjects as Array<{ table: string; kind: string }>).map((x) => [x.table, x.kind]);
}

/** The META object embedded in a generated contract test. */
function metaOf(src: string): Record<string, unknown> {
	const line = src.split('\n').find((l) => l.startsWith('const META'));
	if (!line) throw new Error('no META line in the generated test');
	return JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)) as Record<string, unknown>;
}

describe('part E: the check covers the features built so far (passed plus the current one)', () => {
	test('scoped to crews+admin: no team record subject, no role route, no screen yet; the admin route is kept', () => {
		const src = writeContractFiles(TEAM_BLOCK, 'small', ['crews', 'admin'])['caddie/contract.test.ts']!;
		const meta = metaOf(src);
		expect(meta.scoped).toBe(true);
		expect(meta.hasTeam).toBe(true); // crews.create is built, so T1 can be started
		expect(meta.subjects).toEqual([]); // logs, tools and notes are later features
		expect(meta.role).toBeNull(); // the boss-only route is a logs route
		expect(meta.admin).not.toBeNull();
		expect(meta.screens).toEqual([]);
	});

	test('the whole design (the final check) drives everything and is not scoped', () => {
		const meta = metaOf(writeContractFiles(TEAM_BLOCK, 'small')['caddie/contract.test.ts']!);
		expect(meta.scoped).toBe(false);
		// EVERY team-owned record table and every person-owned table is a subject.
		expect(subjectsOf(meta)).toEqual([['logs', 'team'], ['tools', 'team'], ['notes', 'person']]);
		expect(meta.role).not.toBeNull();
		// Each table screen is checked against ITS OWN table's record.
		expect(meta.screens).toEqual([
			{ id: 'logs', path: '#/logs', kind: 'team', table: 'logs' },
			{ id: 'tools', path: '#/tools', kind: 'team', table: 'tools' },
		]);
	});

	test('the route table in caddie/contract.ts stays whole, so every route is registered from feature 1', () => {
		const scoped = writeContractFiles(TEAM_BLOCK, 'small', ['crews'])['caddie/contract.ts']!;
		const whole = writeContractFiles(TEAM_BLOCK, 'small')['caddie/contract.ts']!;
		expect(scoped).toBe(whole);
	});

	test('a scope with no team feature yet runs the person checks only', () => {
		const meta = metaOf(writeContractFiles(TEAM_BLOCK, 'small', ['admin'])['caddie/contract.test.ts']!);
		expect(meta.hasTeam).toBe(false);
		expect(meta.subjects).toEqual([]);
	});

	test('before the team can be started, team records wait; a personal table in scope is checked now', () => {
		const meta = metaOf(writeContractFiles(TEAM_BLOCK, 'small', ['admin', 'notes', 'tools'])['caddie/contract.test.ts']!);
		expect(meta.hasTeam).toBe(false);
		expect(subjectsOf(meta)).toEqual([['notes', 'person']]);
	});
});

describe('part E: each screen is checked against the record of the table it shows', () => {
	const twoTables: ArchitectureBlock = {
		...NOTES_BLOCK,
		tables: [
			...NOTES_BLOCK.tables,
			{ name: 'tags', module: 'app', plain: 'A tag', owner: 'person', fields: [{ name: 'label', type: 'text', references: null }] },
		],
		routes: [
			...NOTES_BLOCK.routes,
			{ id: 'tags.create', module: 'app', feature: 'tags', op: 'create', method: 'POST', path: '/api/tags', table: 'tags', plain: 'Add a tag', access: 'person', request: [{ name: 'label', type: 'text', example: 'Urgent' }], response: ['id', 'label'] },
		] as ArchitectureBlock['routes'],
		screens: [...NOTES_BLOCK.screens, { id: 'tags', module: 'app', path: '#/tags', plain: 'Your tags', shows: ['tags'] }],
	};

	test('every person-owned table is a subject, and each screen is checked against its own table', () => {
		const meta = metaOf(writeContractFiles(twoTables, 'small')['caddie/contract.test.ts']!);
		expect(subjectsOf(meta)).toEqual([['notes', 'person'], ['tasks', 'person'], ['tags', 'person']]);
		expect(meta.screens).toEqual([
			{ id: 'notes', path: '#/notes', kind: 'person', table: 'notes' },
			{ id: 'tasks', path: '#/tasks', kind: 'person', table: 'tasks' },
			{ id: 'tags', path: '#/tags', kind: 'person', table: 'tags' },
		]);
	});

	test('a table another one points at is saved first, and the pointer is filled with the saved id', () => {
		const reversed: ArchitectureBlock = { ...NOTES_BLOCK, tables: [...NOTES_BLOCK.tables].reverse() };
		const meta = metaOf(writeContractFiles(reversed, 'small')['caddie/contract.test.ts']!);
		// tasks is declared first but points at notes, so notes is created first.
		expect(subjectsOf(meta)).toEqual([['notes', 'person'], ['tasks', 'person']]);
		const tasks = (meta.subjects as Array<{ table: string; refs: unknown }>).find((x) => x.table === 'tasks')!;
		expect(tasks.refs).toEqual([{ field: 'noteId', table: 'notes' }]);
	});

	test('a change touches one text field and leaves numbers and yes/no fields valid', () => {
		const mixed: ArchitectureBlock = {
			...NOTES_BLOCK,
			routes: NOTES_BLOCK.routes.map((r) =>
				r.id === 'notes.update' ? { ...r, request: [{ name: 'count', type: 'integer', example: '3' }, { name: 'done', type: 'boolean', example: 'false' }, { name: 'body', type: 'text', example: 'Buy more feed' }] } : r,
			) as ArchitectureBlock['routes'],
		};
		const meta = metaOf(writeContractFiles(mixed, 'small')['caddie/contract.test.ts']!);
		const notes = (meta.subjects as Array<{ table: string; updateField: string; updateBody: Record<string, string> }>).find((x) => x.table === 'notes')!;
		expect(notes.updateField).toBe('body');
		expect(notes.updateBody).toEqual({ count: '3', done: 'false', body: 'Buy more feed (changed)' });
	});
});

describe('part E: team screens show the current team', () => {
	test('caddie/api.ts carries currentTeamId and setCurrentTeamId, and the check sets the team before opening a team screen', () => {
		const files = writeContractFiles(TEAM_BLOCK, 'small');
		expect(files['caddie/api.ts']).toContain('export function currentTeamId()');
		expect(files['caddie/api.ts']).toContain('export function setCurrentTeamId(');
		expect(files['caddie/contract.test.ts']).toContain('localStorage.setItem(TEAM_KEY');
	});
});

// --- lead fix: the builder sees WHY a contract phase failed -------------------
describe('part E: a failed contract phase reaches the builder as a receipt with its error lines', () => {
	test('the first failing phase becomes a contract-<phase> receipt carrying the test\'s error lines', async () => {
		const failingRead = [
			'caddie/contract.test.ts:',
			'error: reading A\'s record after restart failed: 404',
			'',
			'Expected: 200',
			'Received: 404',
			'(fail) after a restart, A reads the saved record by id and in the list (step 3) [11.94ms]',
			'',
			' 0 pass',
			' 1 fail',
		].join('\n');
		const { run } = runnerFrom({ read: { exitCode: 1, output: failingRead } });
		const outcome = await runTeamModeContractChecks(run);
		const receipt = contractFailureReceipt(outcome, 'contract:run1:a1');
		expect(receipt).not.toBeNull();
		expect(receipt!.check).toBe('contract-read');
		expect(receipt!.passed).toBe(false);
		expect(receipt!.exitCode).toBe(1);
		expect(receipt!.operationKey).toBe('contract:run1:a1:read');
		expect(receipt!.stdout).toContain("error: reading A's record after restart failed: 404");
		expect(receipt!.stdout).toContain('(fail) after a restart, A reads the saved record');
	});

	test('all phases green: no receipt', async () => {
		const { run } = runnerFrom({});
		expect(contractFailureReceipt(await runTeamModeContractChecks(run), 'k')).toBeNull();
	});
});
