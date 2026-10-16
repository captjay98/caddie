/**
 * Cron → plain words. Routines store a real cron (P12), but a farmer should
 * never have to read `0 9 * * 1-5`. Covers the patterns Caddie's own schedule
 * creation actually emits; anything exotic returns null and the raw cron
 * stays available in the row's developer fold — never hidden, never faked.
 * Pure: no React, no fetch, unit-testable.
 */

/** "every 30 min" / "hourly at :05" / "daily at 09:00" / "weekdays at 09:00" — or null. */
export function cronToWords(cron: string): string | null {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as readonly string[];
	if (minute === undefined || hour === undefined || dayOfMonth === undefined || month === undefined || dayOfWeek === undefined) return null;
	if (dayOfMonth !== '*' || month !== '*') return null; // "15th of March" etc. stays raw.

	const at = (h: string, m: string): string | null => {
		const hi = Number(h);
		const mi = Number(m);
		if (!Number.isInteger(hi) || !Number.isInteger(mi) || hi > 23 || mi > 59) return null;
		return `at ${String(hi).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
	};

	// Every minute / every N minutes: `*/N * * * *`.
	const stepMinute = /^\*\/(\d+)$/.exec(minute);
	if (stepMinute && hour === '*') {
		const every = Number(stepMinute[1]);
		if (every === 0) return null;
		return every === 1 ? 'every minute' : `every ${every} min`;
	}
	if (minute === '*' && hour === '*') return 'every minute';

	// Hourly: `M * * * *` (and `*/1`-style hours fall through to raw).
	if (hour === '*' && dayOfWeek === '*') {
		const mi = Number(minute);
		if (!Number.isInteger(mi) || mi > 59) return null;
		return mi === 0 ? 'hourly' : `hourly at :${String(mi).padStart(2, '0')}`;
	}

	// Daily: `M H * * *`.
	if (dayOfWeek === '*') {
		const words = at(hour, minute);
		return words ? `daily ${words}` : null;
	}

	// Weekdays: `M H * * 1-5`.
	if (dayOfWeek === '1-5') {
		const words = at(hour, minute);
		return words ? `weekdays ${words}` : null;
	}
	return null;
}
