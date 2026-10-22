// Part E — the contract check, run for real against the test-app fixtures
// (plan part E: "Test apps that must fail" + one correct app). The generated
// caddie/contract.test.ts is run in phases across SEPARATE processes on one
// file database, so create -> restart -> read is a true restart. Each bad app
// must fail the check part E names; the correct app must pass every one. The
// static check (screens reach the server only through caddie/api.ts) is tested
// directly against checkScreensUseApi.
//
// Classification: LOCAL VERIFIED.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { materializeFixtureApp, applyFixture, runPhase, type FixtureApp } from './support/contract-fixtures-app.ts';
import {
	CONTRACT_FIXTURES,
	TEAM_FIXTURES,
	TEAM_BLOCK,
	NOTES_BLOCK,
	LOCALSTORAGE_SCREEN,
	CORRECT_SCREEN,
	type ContractFixture,
} from './fixtures/contract/notes-apps.ts';
import { checkScreensUseApi } from '../apps/app/src/server/contract-files.ts';
import type { ArchitectureBlock } from '@caddie/contracts';

const SLOW = 240_000;
const PHASES = ['create', 'read', 'privacy-screen', 'test-mode'] as const;

describe('part E: the static check — screens reach the server only through caddie/api.ts', () => {
	test('a screen using caddie/api.ts passes; one reading localStorage or calling fetch fails', () => {
		expect(checkScreensUseApi({ 'src/NotesScreen.tsx': CORRECT_SCREEN })).toHaveLength(0);

		const storageProblems = checkScreensUseApi({ 'src/NotesScreen.tsx': LOCALSTORAGE_SCREEN });
		expect(storageProblems.length).toBeGreaterThan(0);
		expect(storageProblems[0]).toContain('browser storage');

		// MUTATION: a screen that calls fetch() directly is caught too.
		const directFetch = 'export function S(){ fetch("/api/notes"); return null; }';
		const fetchProblems = checkScreensUseApi({ 'src/S.tsx': directFetch });
		expect(fetchProblems.some((p) => p.includes('fetch()'))).toBe(true);
	});
});

/** Assert a fixture passes the phases it should and fails exactly the ones it must. */
function assertFixture(app: FixtureApp, fixture: ContractFixture, block: ArchitectureBlock): void {
	applyFixture(app, fixture, block);
	const g: Record<string, { ok: boolean; out: string }> = {};
	for (const phase of PHASES) {
		const r = runPhase(app, phase);
		g[phase] = { ok: r.ok && r.failed === 0 && r.passed > 0, out: r.out };
	}
	const must = new Set<string>(fixture.mustFail);
	if (must.size === 0) {
		for (const phase of PHASES) {
			expect(g[phase]!.ok, `${fixture.id}: ${phase} should PASS but failed:\n${g[phase]!.out}`).toBe(true);
		}
	} else {
		// Each named phase must be RED; every earlier phase must be GREEN so the
		// failure is a real bite, not a phase that never ran.
		for (let i = 0; i < PHASES.length; i++) {
			const phase = PHASES[i]!;
			if (must.has(phase)) {
				expect(g[phase]!.ok, `${fixture.id}: should FAIL ${phase} but it passed:\n${g[phase]!.out}`).toBe(false);
				for (let k = 0; k < i; k++) {
					const earlier = PHASES[k]!;
					if (!must.has(earlier)) {
						expect(g[earlier]!.ok, `${fixture.id}: ${earlier} should PASS so the ${phase} failure is real:\n${g[earlier]!.out}`).toBe(true);
					}
				}
			}
		}
	}
}

describe('part E: the contract check runs the real test apps (person-owned)', () => {
	let app: FixtureApp;
	beforeAll(() => {
		app = materializeFixtureApp();
	}, SLOW);
	afterAll(() => app?.cleanup());

	for (const fixture of CONTRACT_FIXTURES) {
		test(`${fixture.id}: ${fixture.plain}`, () => assertFixture(app, fixture, NOTES_BLOCK), SLOW);
	}
});

describe('part E: the contract check runs the real team apps', () => {
	let app: FixtureApp;
	beforeAll(() => {
		app = materializeFixtureApp();
	}, SLOW);
	afterAll(() => app?.cleanup());

	for (const fixture of TEAM_FIXTURES) {
		test(`${fixture.id}: ${fixture.plain}`, () => assertFixture(app, fixture, TEAM_BLOCK), SLOW);
	}
});
