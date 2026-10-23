import { describe, expect, test } from 'bun:test';
import {
	type AppUserPage,
	type InboxReader,
	judgeTwoUserCheck,
	notApplicable,
	signInAppUser,
} from '../scripts/brief-run/browser-check.ts';
import type { TestInbox } from '../scripts/brief-run/app-users.ts';
import { FakeClock } from '../scripts/brief-run/clock.ts';

/**
 * LANE 8 ITEM 2 — the two-APP-user browser check. Strictly OFFLINE: no browser,
 * no network. The flow is driven over a fake page that replays the REAL sign-in
 * screen and test-inbox shapes. Proves:
 *   - the judgement: pass needs A persisted AND B's screen rendered AND B
 *     isolated; a blank B screen can't fake isolation;
 *   - signInAppUser requests a code, reads the newest code for its email from
 *     the real test-inbox shape, and enters it;
 *   - "not applicable" is its own verdict (never passed).
 */

// --- the judgement -----------------------------------------------------------

describe('judgeTwoUserCheck (item 2)', () => {
	test('passes only when A persisted AND B rendered AND B is isolated', () => {
		const r = judgeTwoUserCheck(true, true, true);
		expect(r.verdict).toBe('pass');
		expect(r.passed).toBe(true);
	});

	test("fails when A's record did not survive a reload (named first)", () => {
		const r = judgeTwoUserCheck(false, true, true);
		expect(r.passed).toBe(false);
		expect(r.reason).toMatch(/survive a reload/);
	});

	test("fails when B's own screen did not render (a blank screen can't fake isolation)", () => {
		const r = judgeTwoUserCheck(true, false, true);
		expect(r.passed).toBe(false);
		expect(r.reason).toMatch(/did not render/);
	});

	test("fails when B could see A's record (isolation broke)", () => {
		const r = judgeTwoUserCheck(true, true, false);
		expect(r.passed).toBe(false);
		expect(r.reason).toMatch(/isolation/);
	});

	test('not-applicable is its own verdict and is NOT passed', () => {
		const r = notApplicable('no person-owned table with a screen');
		expect(r.verdict).toBe('not-applicable');
		expect(r.passed).toBe(false);
	});
});

// --- signInAppUser over a fake page replaying the real shapes ----------------

/** A fake app-user page that records the steps the flow drives. */
function fakePage(): AppUserPage & { steps: string[] } {
	const page = {
		steps: [] as string[],
		async requestCode(email: string) {
			page.steps.push(`requestCode:${email}`);
		},
		async enterCode(code: string) {
			page.steps.push(`enterCode:${code}`);
		},
		async createRecord(screenPath: string, markerField: string, marker: string) {
			page.steps.push(`create:${screenPath}:${markerField}:${marker}`);
		},
		async reload() {
			page.steps.push('reload');
		},
		async markerVisible() {
			return true;
		},
	};
	return page;
}

describe('signInAppUser (item 2): email-code sign-in through the generated app', () => {
	test('requests a code, reads the newest code for its email from the test inbox, enters it', async () => {
		const page = fakePage();
		// The inbox gains the code only on the 2nd read (the app takes a moment).
		let reads = 0;
		const inboxes: TestInbox[] = [
			{ messages: [] },
			{
				messages: [
					{ to: 'a@campaign.test', code: '111111', createdAt: '2026-10-26T10:00:00.000Z' },
					{ to: 'a@campaign.test', code: '222222', createdAt: '2026-10-26T10:00:05.000Z' }, // newest wins
					{ to: 'b@campaign.test', code: '999999', createdAt: '2026-10-26T10:00:06.000Z' },
				],
			},
		];
		const readInbox: InboxReader = async () => inboxes[Math.min(reads++, inboxes.length - 1)];
		await signInAppUser(page, readInbox, { projectId: 'proj_1', email: 'a@campaign.test', attempts: 5 });
		expect(page.steps).toEqual(['requestCode:a@campaign.test', 'enterCode:222222']);
	});

	test('throws a plain error when no code arrives within the attempts', async () => {
		const page = fakePage();
		const readInbox: InboxReader = async () => ({ messages: [] });
		await expect(signInAppUser(page, readInbox, { projectId: 'proj_1', email: 'a@campaign.test', attempts: 3, sleep: async () => {} })).rejects.toThrow(/no sign-in code arrived/);
	});

	test('never enters a code that was already in the inbox before asking, and waits between reads', async () => {
		// An earlier try left a code for the same address. Entering it would
		// fail (it is used or expired), so only a code that arrives AFTER this
		// request counts. The new code lands on the 2nd read after asking.
		// MUTATION: drop the "already there" exclusion and 111111 is entered.
		const page = fakePage();
		const stale = { to: 'a@campaign.test', code: '111111', createdAt: '2026-10-26T09:00:00.000Z' };
		const fresh = { to: 'a@campaign.test', code: '333333', createdAt: '2026-10-26T10:00:00.000Z' };
		const inboxes: TestInbox[] = [{ messages: [stale] }, { messages: [stale] }, { messages: [fresh, stale] }];
		let reads = 0;
		const readInbox: InboxReader = async () => inboxes[Math.min(reads++, inboxes.length - 1)];
		const slept: number[] = [];
		await signInAppUser(page, readInbox, { projectId: 'proj_1', email: 'a@campaign.test', attempts: 5, sleep: async (ms) => void slept.push(ms) });
		expect(page.steps).toEqual(['requestCode:a@campaign.test', 'enterCode:333333']);
		// One real pause between the two reads after asking (never a busy loop).
		expect(slept).toEqual([500]);
	});
});

// --- FakeClock (step 2 support, retained) ------------------------------------

describe('FakeClock advances virtual time (step 2 support)', () => {
	test('sleep advances now() without real waiting', async () => {
		const clock = new FakeClock(0);
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
