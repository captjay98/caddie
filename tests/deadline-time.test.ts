import { describe, expect, test } from 'bun:test';
import { deadlineInstant, deadlineTime, deadlineRefreshInterval, deadlineCountdown, deadlineShortLocal } from '../apps/app/src/client/discovery/deadline-time.ts';

describe('the project header countdown (owner 2026-10-29)', () => {
	const closes = '2026-10-30T17:00:00Z';
	const at = (iso: string) => Date.parse(iso);
	test('counts down in days, then hours and minutes, then minutes', () => {
		expect(deadlineCountdown(closes, at('2026-10-27T12:00:00Z'))).toBe('Closes in 3 days');
		expect(deadlineCountdown(closes, at('2026-10-29T21:48:00Z'))).toBe('Closes in 19 h 12 min');
		expect(deadlineCountdown(closes, at('2026-10-30T07:00:00Z'))).toBe('Closes in 10 h');
		expect(deadlineCountdown(closes, at('2026-10-30T16:15:00Z'))).toBe('Closes in 45 min');
		expect(deadlineCountdown(closes, at('2026-10-30T16:59:30Z'))).toBe('Closes in under a minute');
		expect(deadlineCountdown(closes, at('2026-10-30T17:00:00Z'))).toBe('Closed');
	});
	test('a date-only listing gets no countdown (no invented closing hour)', () => {
		expect(deadlineCountdown('2026-10-30', at('2026-10-29T12:00:00Z'))).toBeNull();
		expect(deadlineShortLocal('2026-10-30', 'Africa/Lagos')).toBeNull();
	});
	test('the exact time follows in the person’s own zone', () => {
		expect(deadlineShortLocal(closes, 'Africa/Lagos')).toMatch(/Fri.*6:00/);
	});
});

describe('contest deadline presentation', () => {
	test('Amazon noon PDT is 8pm in Lagos, still open before that instant', () => {
		const raw = 'Oct 23, 2026 @ 12:00pm PDT';
		expect(deadlineInstant(raw)).toBe(Date.parse('2026-10-23T19:00:00Z'));
		const view = deadlineTime(raw, 'Africa/Lagos', new Date('2026-10-23T18:00:00Z'));
		expect(view.local).toMatch(/20:00|8:00/);
		expect(view.local).toContain('GMT+1');
		expect(view.today).toBe(true);
		expect(view.closed).toBe(false);
		expect(deadlineTime(raw, 'Africa/Lagos', new Date('2026-10-23T19:00:00Z')).closed).toBe(true);
	});
	test('date-only or unzoned times never invent an exact closing instant', () => {
		expect(deadlineTime('2026-10-23', 'Africa/Lagos', new Date('2026-10-23T22:00:00Z'))).toEqual({ local: null, today: true, closed: false });
		expect(deadlineInstant('Oct 23, 2026 12:00pm')).toBeNull();
		expect(deadlineInstant('2026-10-23')).toBeNull();
		expect(deadlineInstant('invalid')).toBeNull();
	});
	test('invalid ISO calendar dates do not normalize into a different deadline', () => {
		expect(deadlineInstant('2026-02-31T12:00:00Z')).toBeNull();
		expect(deadlineInstant('2026-04-31T12:00:00-07:00')).toBeNull();
		expect(deadlineInstant('Feb 31, 2026 @ 12:00pm PST')).toBeNull();
		expect(deadlineInstant('2024-02-29T12:00:00Z')).toBe(Date.parse('2024-02-29T12:00:00Z'));
	});
	test('local date can differ from the source calendar date', () => {
		const view = deadlineTime('2026-10-23T23:30:00-07:00', 'Africa/Lagos', new Date('2026-10-24T05:00:00Z'));
		expect(view.today).toBe(true);
		expect(view.closed).toBe(false);
		expect(view.local).toContain('24');
	});
	test('a sourced deadline is refreshed at its closing instant without polling date-only events', () => {
		const now = Date.parse('2026-10-30T16:59:50Z');
		expect(deadlineRefreshInterval('2026-10-30T17:00:00Z', false, now)).toBe(10_100);
		expect(deadlineRefreshInterval('2026-10-30T17:00:00Z', true, now)).toBe(false);
		expect(deadlineRefreshInterval('2026-10-30', false, now)).toBe(false);
		expect(deadlineRefreshInterval('2026-10-31T17:00:00Z', false, now)).toBe(300_000);
	});
});

test('a time and zone without a year is never guessed into an instant (2026-10-28 Nebius pane bug)', () => {
	// "October 30, 1:00pm EDT" (no year) must not render as "Oct 30, 2001".
	const view = deadlineTime('October 30, 1:00pm EDT', 'Africa/Lagos', new Date('2026-10-28T12:00:00Z'));
	expect(view.local).toBeNull();
	expect(view.closed).toBe(false);
	// A full value with an explicit year still resolves.
	const ok = deadlineTime('October 30, 2026 1:00pm EDT', 'Africa/Lagos', new Date('2026-10-28T12:00:00Z'));
	expect(ok.local).toMatch(/2026/);
});

test('a time and zone without a year is never guessed into an instant (2026-10-28 Nebius pane bug)', () => {
	// "October 30, 1:00pm EDT" (no year) must not render as "Oct 30, 2001":
	// Date.parse guesses year 2001 for year-less strings.
	expect(deadlineInstant('October 30, 1:00pm EDT')).toBeNull();
	const view = deadlineTime('October 30, 1:00pm EDT', 'Africa/Lagos', new Date('2026-10-28T12:00:00Z'));
	expect(view.local).toBeNull();
	expect(view.closed).toBe(false);
	// A full value with an explicit year still resolves.
	expect(deadlineInstant('October 30, 2026 1:00pm EDT')).not.toBeNull();
});
