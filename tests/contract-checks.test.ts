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
import { CONTRACT_FIXTURES, LOCALSTORAGE_SCREEN, CORRECT_SCREEN } from './fixtures/contract/notes-apps.ts';
import { checkScreensUseApi } from '../apps/app/src/server/contract-files.ts';

const SLOW = 240_000;

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

describe('part E: the contract check runs the real test apps', () => {
	let app: FixtureApp;

	beforeAll(() => {
		app = materializeFixtureApp();
	}, SLOW);

	afterAll(() => {
		app?.cleanup();
	});

	for (const fixture of CONTRACT_FIXTURES) {
		test(
			`${fixture.id}: ${fixture.plain}`,
			() => {
				applyFixture(app, fixture);

				// Phase order is the real order; the restart lives between create and read.
				const create = runPhase(app, 'create');
				const read = runPhase(app, 'read');
				const privacy = runPhase(app, 'privacy-screen');

				const phaseGreen: Record<string, boolean> = {
					create: create.ok && create.passed > 0 && create.failed === 0,
					read: read.ok && read.passed > 0 && read.failed === 0,
					'privacy-screen': privacy.ok && privacy.passed > 0 && privacy.failed === 0,
				};

				if (fixture.mustFail.length === 0) {
					// The correct app passes every phase.
					expect(phaseGreen.create, `create failed:\n${create.out}`).toBe(true);
					expect(phaseGreen.read, `read failed:\n${read.out}`).toBe(true);
					expect(phaseGreen['privacy-screen'], `privacy-screen failed:\n${privacy.out}`).toBe(true);
				} else {
					// Each named phase must be RED, and it must be the phase part E says.
					for (const phase of fixture.mustFail) {
						expect(phaseGreen[phase], `${fixture.id} should FAIL the ${phase} phase but it passed:\ncreate=${create.out}\nread=${read.out}\nprivacy=${privacy.out}`).toBe(false);
					}
					// A failure must be an earlier phase passing then the named one biting —
					// never a phase that simply never ran (which would be a false pass).
					if (fixture.mustFail.includes('read')) {
						expect(phaseGreen.create, `${fixture.id}: create should PASS so the read failure is real:\n${create.out}`).toBe(true);
					}
					if (fixture.mustFail.includes('privacy-screen')) {
						expect(phaseGreen.create, `${fixture.id}: create should pass:\n${create.out}`).toBe(true);
						expect(phaseGreen.read, `${fixture.id}: read should pass:\n${read.out}`).toBe(true);
					}
				}
			},
			SLOW,
		);
	}
});
