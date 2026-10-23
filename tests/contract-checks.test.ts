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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { materializeFixtureApp, applyFixture, runPhase, type FixtureApp } from './support/contract-fixtures-app.ts';
import { genericAppFiles } from './fixtures/contract/generic-app.ts';
import {
	CONTRACT_FIXTURES,
	TEAM_FIXTURES,
	TEAM_SCOPED_FIXTURES,
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

/**
 * Why each bad app must fail: the first failing phase's output must carry this
 * sentence, so a check that breaks for an unrelated reason can't stand in for
 * the check the defect targets.
 */
const WHY: Readonly<Record<string, string>> = {
	'kept-in-memory': "reading A's record after restart failed",
	'dummy-row-serves-memory': "reading A's record after restart failed",
	'no-owner-filter': "B can read A's record",
	'update-not-saved': 'the change was not saved',
	'screen-reads-localstorage': 'does not show a record the server saved',
	'team-route-without-team-filter': 'the route does not filter by team',
	'team-update-not-saved': 'the change was not saved',
	'team-screen-reads-localstorage': "does not show the team's saved record",
	'team-delete-without-team-filter': "B deleted A's record through B's own team",
	'team-crews-built-whole-design': 'This route is not built yet',
	// Every table is checked (not only the first), and each screen against its own table.
	'second-table-kept-in-memory': "tasks: reading A's record after restart failed",
	'second-table-no-owner-filter': "tasks: B can read A's record",
	'second-screen-shows-another-table': 'The tasks screen does not show a record the server saved',
	'team-second-table-without-team-filter': "tools: A's record leaks into B's own-team list",
	'team-teammate-reads-personal': "notes: a teammate can read A's personal record",
};

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
		const why = WHY[fixture.id];
		expect(why, `${fixture.id}: a bad app needs its expected failure sentence in WHY`).toBeDefined();
		const firstRed = PHASES.find((phase) => must.has(phase))!;
		expect(g[firstRed]!.out, `${fixture.id}: ${firstRed} failed, but not for the reason its defect should give`).toContain(why!);
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

describe('part E: the check covers only the features built so far (passed plus the current one)', () => {
	let app: FixtureApp;
	beforeAll(() => {
		app = materializeFixtureApp();
	}, SLOW);
	afterAll(() => app?.cleanup());

	for (const fixture of TEAM_SCOPED_FIXTURES) {
		test(`${fixture.id}: ${fixture.plain}`, () => assertFixture(app, fixture, TEAM_BLOCK), SLOW);
	}
});

/**
 * The big farm design (37 tables, 38 screens, 186 routes). Step 9 (payments,
 * emails, jobs and file uploads) is checked separately, so this copy leaves
 * those four out; everything else is the design as approved.
 */
const FARM = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/architecture/farm-block.json'), 'utf8')) as ArchitectureBlock;
const FARM_CORE: ArchitectureBlock = {
	...FARM,
	payments: null,
	emails: [],
	jobs: [],
	tables: FARM.tables.map((t) => ({ ...t, fields: t.fields.map((f) => (f.type === 'file' ? { ...f, type: 'text' as const } : f)) })),
};

describe('part E: a correct big app (the 37-table farm design) passes every phase, in time', () => {
	let app: FixtureApp;
	beforeAll(() => {
		app = materializeFixtureApp();
	}, SLOW);
	afterAll(() => app?.cleanup());

	test('every table and screen is checked, every phase passes, and each phase stays under 60 s', () => {
		const fixture: ContractFixture = { id: 'farm-generic', plain: 'A generic correct app for the farm design.', mustFail: [], files: genericAppFiles(FARM_CORE) };
		applyFixture(app, fixture, FARM_CORE);
		const ms: Record<string, number> = {};
		for (const phase of PHASES) {
			const started = performance.now();
			const r = runPhase(app, phase);
			ms[phase] = Math.round(performance.now() - started);
			expect(r.ok && r.failed === 0 && r.passed > 0, `${phase} should PASS on a correct big app:\n${r.out.slice(-4000)}`).toBe(true);
		}
		console.log(`farm design phase times (ms): ${JSON.stringify(ms)}`);
		// The host stops a phase at 120 s; a sandbox may be slower than this machine.
		for (const phase of PHASES) expect(ms[phase]!, `${phase} took ${ms[phase]} ms`).toBeLessThan(60_000);
	}, 600_000);
});
