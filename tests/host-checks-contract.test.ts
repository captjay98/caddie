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
import { NOTES_BLOCK } from './fixtures/contract/notes-apps.ts';

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
