import { describe, expect, test } from 'bun:test';
import { cronToWords } from '../apps/app/src/client/tasks/cron-words.ts';

/**
 * Routines must read in words before cron (owner steering, 2026-10-15): a
 * farmer should see "daily at 09:00", never `0 9 * * *`. The words cover the
 * patterns Caddie's schedule creation emits; anything exotic returns null so
 * the raw cron stays the honest fallback — nothing is guessed.
 */
describe('cronToWords', () => {
	test('common patterns Caddie emits', () => {
		expect(cronToWords('*/30 * * * *')).toBe('every 30 min');
		expect(cronToWords('*/5 * * * *')).toBe('every 5 min');
		expect(cronToWords('0 * * * *')).toBe('hourly');
		expect(cronToWords('30 * * * *')).toBe('hourly at :30');
		expect(cronToWords('0 9 * * *')).toBe('daily at 09:00');
		expect(cronToWords('15 21 * * *')).toBe('daily at 21:15');
		expect(cronToWords('0 9 * * 1-5')).toBe('weekdays at 09:00');
		expect(cronToWords('* * * * *')).toBe('every minute');
	});

	test('out-of-range and exotic fields return null (raw cron stays visible)', () => {
		expect(cronToWords('0 9 15 * *')).toBeNull(); // day-of-month
		expect(cronToWords('0 9 * 3 *')).toBeNull(); // month
		expect(cronToWords('0 25 * * *')).toBeNull(); // hour out of range
		expect(cronToWords('99 * * * *')).toBeNull(); // minute out of range
		expect(cronToWords('0 9 * * 0')).toBeNull(); // single weekday not covered
		expect(cronToWords('not a cron')).toBeNull();
	});

	test('whitespace tolerance', () => {
		expect(cronToWords('  0   8 * * *  ')).toBe('daily at 08:00');
	});
});
