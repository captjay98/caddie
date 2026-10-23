import { describe, expect, test } from 'bun:test';
import { deadlineInstant, deadlineTime } from '../apps/app/src/client/discovery/deadline-time.ts';

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
	test('local date can differ from the source calendar date', () => {
		const view = deadlineTime('2026-10-23T23:30:00-07:00', 'Africa/Lagos', new Date('2026-10-24T05:00:00Z'));
		expect(view.today).toBe(true);
		expect(view.closed).toBe(false);
		expect(view.local).toContain('24');
	});
});
