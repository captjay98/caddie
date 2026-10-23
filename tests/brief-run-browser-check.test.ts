import { describe, expect, test } from 'bun:test';
import { judgeBrowserCheck } from '../scripts/brief-run/browser-check.ts';
import { FakeClock } from '../scripts/brief-run/clock.ts';

/** LANE 8 STEP 4 — the browser check's persistence + isolation judgement. */
describe('judgeBrowserCheck (step 4)', () => {
	test('passes only when A persisted AND B is isolated', () => {
		expect(judgeBrowserCheck(true, true).passed).toBe(true);
	});

	test("fails when A's record did not survive a reload", () => {
		const r = judgeBrowserCheck(false, true);
		expect(r.passed).toBe(false);
		expect(r.reason).toMatch(/survive a reload/);
	});

	test("fails when B could see A's record (isolation broke)", () => {
		const r = judgeBrowserCheck(true, false);
		expect(r.passed).toBe(false);
		expect(r.reason).toMatch(/isolation/);
	});

	test('both failing still fails, naming persistence first', () => {
		expect(judgeBrowserCheck(false, false).passed).toBe(false);
	});
});

describe('FakeClock advances virtual time (step 2 support)', () => {
	test('sleep advances now() without real waiting', async () => {
		const clock = new FakeClock(0);
		expect(clock.now()).toBe(0);
		await clock.sleep(5000);
		await clock.sleep(5000);
		expect(clock.now()).toBe(10000);
	});

	test('the per-sleep hook runs on each tick', async () => {
		let ticks = 0;
		const clock = new FakeClock(0, () => ticks++);
		await clock.sleep(1000);
		await clock.sleep(1000);
		expect(ticks).toBe(2);
	});
});
