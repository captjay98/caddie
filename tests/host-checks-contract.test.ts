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
	CONTRACT_PHASES,
	type ContractPhase,
} from '../apps/app/src/server/host-checks.ts';
import { NOTES_BLOCK, TEAM_BLOCK } from './fixtures/contract/notes-apps.ts';
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
		expect(outcome.failureSentence).toBe('An animal you add is gone after the app restarts.');
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

	test('a block that declares payments makes the test-mode phase FAIL with a plain sentence (step 9)', () => {
		const withPayments: ArchitectureBlock = {
			...NOTES_BLOCK,
			payments: { plan: 'pro', plain: 'Pro plan', interval: 'month', amount: 500, currency: 'usd' } as unknown as ArchitectureBlock['payments'],
		};
		const src = gen(withPayments);
		// The test-mode phase names payments and the must-be-checked sentence.
		expect(src).toContain('META.features.payments');
		expect(src).toContain('those are not checked yet');
		// And the feature flag is actually set in the embedded META for this block.
		expect(src).toContain('"payments":true');
	});

	test('a block that declares no test-mode feature does not force a test-mode failure', () => {
		const src = gen(NOTES_BLOCK);
		expect(src).toContain('"payments":false');
		expect(src).toContain('"emails":false');
		expect(src).toContain('"jobs":false');
		expect(src).toContain('"files":false');
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

/** The META object embedded in a generated contract test. */
function metaOf(src: string): Record<string, unknown> {
	const line = src.split('\n').find((l) => l.startsWith('const META = '));
	if (!line) throw new Error('no META line in the generated test');
	return JSON.parse(line.slice('const META = '.length, line.lastIndexOf(' as const;'))) as Record<string, unknown>;
}

describe('part E: the check covers the features built so far (passed plus the current one)', () => {
	test('scoped to crews+admin: no team record subject, no role route, no screen yet; the admin route is kept', () => {
		const src = writeContractFiles(TEAM_BLOCK, 'small', ['crews', 'admin'])['caddie/contract.test.ts']!;
		const meta = metaOf(src);
		expect(meta.scoped).toBe(true);
		expect(meta.hasTeam).toBe(true); // crews.create is built, so T1 can be started
		expect(meta.team).toBeNull(); // logs routes are a later feature
		expect(meta.role).toBeNull(); // the boss-only route is a logs route
		expect(meta.admin).not.toBeNull();
		expect(meta.screens).toEqual([]);
	});

	test('the whole design (the final check) drives everything and is not scoped', () => {
		const meta = metaOf(writeContractFiles(TEAM_BLOCK, 'small')['caddie/contract.test.ts']!);
		expect(meta.scoped).toBe(false);
		expect((meta.team as { table: string }).table).toBe('logs');
		expect(meta.role).not.toBeNull();
		expect(meta.screens).toEqual([{ id: 'logs', path: '#/logs', kind: 'team' }]);
	});

	test('the route table in caddie/contract.ts stays whole, so every route is registered from feature 1', () => {
		const scoped = writeContractFiles(TEAM_BLOCK, 'small', ['crews'])['caddie/contract.ts']!;
		const whole = writeContractFiles(TEAM_BLOCK, 'small')['caddie/contract.ts']!;
		expect(scoped).toBe(whole);
	});

	test('a scope with no team feature yet runs the person checks only', () => {
		const meta = metaOf(writeContractFiles(TEAM_BLOCK, 'small', ['admin'])['caddie/contract.test.ts']!);
		expect(meta.hasTeam).toBe(false);
		expect(meta.person).toBeNull();
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

	test('a screen of another table is not checked against the notes record', () => {
		const meta = metaOf(writeContractFiles(twoTables, 'small')['caddie/contract.test.ts']!);
		expect((meta.person as { table: string }).table).toBe('notes');
		expect(meta.screens).toEqual([{ id: 'notes', path: '#/notes', kind: 'person' }]);
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
