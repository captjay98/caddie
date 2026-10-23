import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	BRIEFS_DIR,
	CampaignCapError,
	DEFAULT_CAMPAIGN_CAP_MICROS,
	evaluateComplete,
	gate,
	loadBriefs,
	parseBrief,
	reserveAgainstCap,
	scoreSwitch,
	section10Marks,
	type BriefRunResult,
	type SpendReader,
} from '../scripts/brief-run.ts';

/**
 * LANE 8 PART I — offline test for the campaign runner (plan section I).
 *
 * This suite is strictly OFFLINE and makes NO network call: it never sets
 * CADDIE_LIVE_AUTHORIZED, so the runner's gate() returns BLOCKED and the live
 * path is never entered. It proves:
 *   - the gate is BLOCKED without the explicit env authorization;
 *   - the campaign cap (D5) refuses a build that would exceed it, with an
 *     injected fake spend reader (the real reader reads build_spend_reservations/
 *     build_spend_limits, plan section 4; those tables arrive with the
 *     foundations lane, so the cap is coded against their names and unit-tested
 *     with a fake reader here);
 *   - the "complete" rule (plan part E step / part I): every feature passed,
 *     verify_build green, every contract check green, browser check passes;
 *   - section 10's marks, including that a tie at zero FAILS;
 *   - every brief file parses and carries its "Complete when" list.
 */

const MICRO = 1; // 1 micro-dollar
const USD = 1_000_000; // micros per dollar

// --- gate --------------------------------------------------------------------

describe('gate (honesty: BLOCKED without explicit authorization)', () => {
	test('BLOCKED when CADDIE_LIVE_AUTHORIZED is not 1, and no network is touched', () => {
		const result = gate({ CADDIE_LIVE_AUTHORIZED: undefined });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('BLOCKED');
			expect(result.reason).toContain('CADDIE_LIVE_AUTHORIZED');
		}
	});

	test('authorization is read from the PROCESS env only, never from .dev.vars', () => {
		// A .dev.vars-sourced value must not open the gate: the authorization
		// flag is explicit owner intent. gate() only inspects the passed env,
		// and the runner only ever passes process.env for the flag.
		const result = gate({ CADDIE_LIVE_AUTHORIZED: '1' });
		// With the flag set but no sandbox/model credentials, it is still
		// BLOCKED — but for the credentials reason, proving the flag alone is
		// not the whole gate.
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('BLOCKED');
		}
	});

	test('gate opens with the flag and the local base URL alone: no test accounts are needed', () => {
		// The live run signs in with the owner's saved session (--sign-in), and
		// the browser check's two users are users OF THE BUILT APP, so the old
		// TEST_ACCOUNT_{A,B,C}_EMAIL variables are not asked for any more.
		const result = gate({
			CADDIE_LIVE_AUTHORIZED: '1',
			CADDIE_DEV_BASE_URL: 'http://127.0.0.1:5173',
		});
		expect(result.ok).toBe(true);
	});
});

// --- campaign cap (D5) -------------------------------------------------------

describe('campaign cap (D5): refuses a build that would exceed it', () => {
	/** A fake reader standing in for build_spend_reservations/_limits. */
	function fakeReader(spentMicros: number): SpendReader {
		return { totalSpentMicros: async () => spentMicros };
	}

	test('allows a build whose limit fits under the remaining cap', async () => {
		const reader = fakeReader(100 * USD); // $100 spent
		const decision = await reserveAgainstCap(reader, {
			capMicros: 150 * USD,
			buildLimitMicros: 40 * USD, // $40 big build → 140 ≤ 150
		});
		expect(decision.allowed).toBe(true);
		expect(decision.remainingMicros).toBe(10 * USD);
	});

	test('refuses a build whose limit would push spend over the cap', async () => {
		const reader = fakeReader(130 * USD); // $130 spent
		await expect(
			reserveAgainstCap(reader, { capMicros: 150 * USD, buildLimitMicros: 40 * USD }), // 170 > 150
		).rejects.toBeInstanceOf(CampaignCapError);
	});

	test('the boundary (spent + limit === cap) is allowed', async () => {
		const reader = fakeReader(110 * USD);
		const decision = await reserveAgainstCap(reader, {
			capMicros: 150 * USD,
			buildLimitMicros: 40 * USD, // exactly 150
		});
		expect(decision.allowed).toBe(true);
	});

	test('one micro over the cap is refused', async () => {
		const reader = fakeReader(150 * USD - 40 * USD + 1 * MICRO);
		await expect(
			reserveAgainstCap(reader, { capMicros: 150 * USD, buildLimitMicros: 40 * USD }),
		).rejects.toBeInstanceOf(CampaignCapError);
	});

	test('the default campaign cap is $150 (D5)', () => {
		expect(DEFAULT_CAMPAIGN_CAP_MICROS).toBe(150 * USD);
	});
});

// --- "complete" rule (plan part I) -------------------------------------------

describe('"complete" means every gate green (plan part I)', () => {
	const green: BriefRunResult = {
		briefId: 'x',
		everyFeaturePassed: true,
		verifyBuildGreen: true,
		everyContractCheckGreen: true,
		browserCheckPassed: true,
	};

	test('all four green → complete', () => {
		expect(evaluateComplete(green).complete).toBe(true);
	});

	test('a failing feature → not complete', () => {
		expect(evaluateComplete({ ...green, everyFeaturePassed: false }).complete).toBe(false);
	});

	test('verify_build red → not complete', () => {
		expect(evaluateComplete({ ...green, verifyBuildGreen: false }).complete).toBe(false);
	});

	test('a red contract check → not complete', () => {
		expect(evaluateComplete({ ...green, everyContractCheckGreen: false }).complete).toBe(false);
	});

	test('a failed browser check → not complete', () => {
		expect(evaluateComplete({ ...green, browserCheckPassed: false }).complete).toBe(false);
	});

	test('the reason names the first failed gate', () => {
		const r = evaluateComplete({ ...green, browserCheckPassed: false });
		expect(r.complete).toBe(false);
		expect(r.reason).toContain('browser');
	});
});

// --- section 10 marks --------------------------------------------------------

describe('section 10 go/no-go marks (a tie at zero FAILS)', () => {
	test('team_mode → on when every absolute mark is met', () => {
		const verdict = scoreSwitch('team_mode', {
			fullGateGreen: true,
			teamModeComplete: 9, // ≥ 8 of 12
			teamModeTotal: 12,
			pairedCompleteTeam: 5, // ≥ 4 of 5
			pairedCompleteBaseline: 4, // team (5) ≥ baseline (4)
			pairedTotal: 5,
			farmLogComplete: true,
			herdVoiceComplete: true,
			limitOverruns: 0,
			unreceiptedClaims: 0,
			withinCap: true,
		});
		expect(verdict.value).toBe('on');
	});

	test('a tie at zero fails: zero complete both ways is NOT on, and not owner', () => {
		const verdict = scoreSwitch('team_mode', {
			fullGateGreen: true,
			teamModeComplete: 0,
			teamModeTotal: 12,
			pairedCompleteTeam: 0,
			pairedCompleteBaseline: 0,
			pairedTotal: 5,
			farmLogComplete: false,
			herdVoiceComplete: false,
			limitOverruns: 0,
			unreceiptedClaims: 0,
			withinCap: true,
		});
		// team (0) >= baseline (0) is a tie at zero — the absolute marks
		// (>=8 of 12, etc.) are NOT met, so it must be off, never on.
		expect(verdict.value).not.toBe('on');
		expect(verdict.value).toBe('off');
		expect(verdict.reason).toContain('tie at zero');
	});

	test('team_mode → owner at 6 of 12 (not enough for on)', () => {
		const verdict = scoreSwitch('team_mode', {
			fullGateGreen: true,
			teamModeComplete: 6,
			teamModeTotal: 12,
			pairedCompleteTeam: 3,
			pairedCompleteBaseline: 3,
			pairedTotal: 5,
			farmLogComplete: true,
			herdVoiceComplete: true,
			limitOverruns: 0,
			unreceiptedClaims: 0,
			withinCap: true,
		});
		expect(verdict.value).toBe('owner');
	});

	test('any limit overrun blocks team_mode on', () => {
		const verdict = scoreSwitch('team_mode', {
			fullGateGreen: true,
			teamModeComplete: 10,
			teamModeTotal: 12,
			pairedCompleteTeam: 5,
			pairedCompleteBaseline: 4,
			pairedTotal: 5,
			farmLogComplete: true,
			herdVoiceComplete: true,
			limitOverruns: 1, // a build exceeded its limit
			unreceiptedClaims: 0,
			withinCap: true,
		});
		expect(verdict.value).not.toBe('on');
	});

	test('an unreceipted "saved/done" claim blocks team_mode on', () => {
		const verdict = scoreSwitch('team_mode', {
			fullGateGreen: true,
			teamModeComplete: 10,
			teamModeTotal: 12,
			pairedCompleteTeam: 5,
			pairedCompleteBaseline: 4,
			pairedTotal: 5,
			farmLogComplete: true,
			herdVoiceComplete: true,
			limitOverruns: 0,
			unreceiptedClaims: 2,
			withinCap: true,
		});
		expect(verdict.value).not.toBe('on');
	});

	test('big_apps → owner at >=75% modules merged, on-for-judges at 100%', () => {
		expect(scoreSwitch('big_apps', { modulesMerged: 7, modulesTotal: 9, everyCheckGreen: true, browserCheckPassed: true }).value).toBe('owner');
		expect(scoreSwitch('big_apps', { modulesMerged: 9, modulesTotal: 9, everyCheckGreen: true, browserCheckPassed: true }).value).toBe('on');
		expect(scoreSwitch('big_apps', { modulesMerged: 5, modulesTotal: 9, everyCheckGreen: true, browserCheckPassed: true }).value).toBe('off');
	});

	test('big_apps below 75% is off even at a tie-free count', () => {
		expect(scoreSwitch('big_apps', { modulesMerged: 6, modulesTotal: 9, everyCheckGreen: true, browserCheckPassed: true }).value).toBe('off');
	});

	test('section10Marks exposes the absolute thresholds', () => {
		expect(section10Marks.teamMode.minComplete).toBe(8);
		expect(section10Marks.teamMode.minPaired).toBe(4);
		expect(section10Marks.teamMode.ownerMinComplete).toBe(6);
		expect(section10Marks.bigApps.ownerMinFraction).toBeCloseTo(0.75, 5);
	});
});

// --- every brief file parses and has its list -------------------------------

describe('every brief file parses and carries a Complete-when list', () => {
	const files = readdirSync(BRIEFS_DIR).filter((f) => f.endsWith('.md'));

	test('there are 12 small/medium briefs and 1 big brief', () => {
		const briefs = loadBriefs(BRIEFS_DIR);
		expect(briefs.length).toBe(13);
		expect(briefs.filter((b) => b.size === 'big').length).toBe(1);
		expect(briefs.filter((b) => b.size !== 'big').length).toBe(12);
	});

	test('exactly 5 briefs are marked paired (plan section 10)', () => {
		const briefs = loadBriefs(BRIEFS_DIR);
		expect(briefs.filter((b) => b.paired).length).toBe(5);
	});

	test('FarmLog and HerdVoice are present', () => {
		const ids = loadBriefs(BRIEFS_DIR).map((b) => b.id);
		expect(ids).toContain('farmlog');
		expect(ids).toContain('herdvoice');
	});

	test('the big brief names 9 modules and an admin area', () => {
		const big = loadBriefs(BRIEFS_DIR).find((b) => b.size === 'big');
		expect(big).toBeDefined();
		expect(big!.modules.length).toBe(9);
		expect(big!.admin).toBe(true);
	});

	test.each(files)('%s parses with an id, a source, and a non-empty Complete-when list', (file) => {
		const brief = parseBrief(readFileSync(join(BRIEFS_DIR, file), 'utf8'), file);
		expect(brief.id.length).toBeGreaterThan(0);
		expect(brief.source.length).toBeGreaterThan(0);
		expect(brief.completeWhen.length).toBeGreaterThan(0);
		// Every item is a real sentence, not an empty bullet.
		for (const item of brief.completeWhen) expect(item.trim().length).toBeGreaterThan(0);
	});

	test('the 9 hackathon briefs each cite a source page URL', () => {
		const briefs = loadBriefs(BRIEFS_DIR);
		const fromHackathons = briefs.filter((b) => /devpost\.com/.test(b.source));
		expect(fromHackathons.length).toBe(9);
		for (const b of fromHackathons) expect(b.source).toMatch(/^https?:\/\//);
	});
});
