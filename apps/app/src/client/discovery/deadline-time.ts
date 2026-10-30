/** Date-only listings do not establish a closing hour or timezone. */
export function deadlineInstant(value: string | null | undefined): number | null {
	if (!value || !/\d[:.]\d{2}/.test(value)) return null;
	// Date.parse normalizes impossible calendar dates (e.g. February 31) into a
	// different month. Never present that guessed day as the contest deadline.
	const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:T|\s)/.exec(value);
	const namedDate = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(value);
	if (isoDate || namedDate) {
		const year = Number(isoDate ? isoDate[1] : namedDate![3]);
		const month = isoDate ? Number(isoDate[2]) : ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(namedDate![1]!.toLowerCase()) + 1;
		const day = Number(isoDate ? isoDate[3] : namedDate![2]);
		const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
		const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
		if (month < 1 || month > 12 || day < 1 || day > lengths[month - 1]!) return null;
	}
	// Require an explicit offset or an unambiguous supported source zone.
	if (!/(?:Z|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT|PDT|PST|EDT|EST)\b)\s*$/i.test(value)) return null;
	// Require an explicit 4-digit year: without one, Date.parse guesses 2001
	// ("October 30, 1:00pm EDT" rendered as "Oct 30, 2001" — the 2026-10-28
	// Nebius pane bug). A time+zone without a year is unconfirmed, the same
	// rule as a date without a time.
	if (!/(?:^|\D)\d{4}(?:\D|$)/.test(value)) return null;
	const parsed = Date.parse(value.replace(/\s*@\s*/, ' ').replace(/(\d)(am|pm)\b/i, '$1 $2'));
	return Number.isFinite(parsed) ? parsed : null;
}

export function deadlineTime(value: string | null | undefined, timeZone?: string, now = new Date()): {
	local: string | null; today: boolean; closed: boolean;
} {
	if (timeZone) {
		try { new Intl.DateTimeFormat(undefined, { timeZone }); } catch { timeZone = undefined; }
	}
	const instant = deadlineInstant(value);
	const dayKey = (date: Date) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(date);
	if (instant !== null) {
		const at = new Date(instant);
		return {
			local: new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone }).format(at),
			today: dayKey(at) === dayKey(now), closed: instant <= now.getTime(),
		};
	}
	// Compare calendar components, not a guessed midnight UTC closing time.
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
	const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(now);
	const current = (part: string) => parts.find(p => p.type === part)?.value;
	return { local: null, today: Boolean(dateOnly && dateOnly[1] === current('year') && dateOnly[2] === current('month') && dateOnly[3] === current('day')), closed: false };
}

/** Recheck a sourced instant when it closes; date-only events stay unguessed. */
export function deadlineRefreshInterval(value: string | null | undefined, ended: boolean, nowMs = Date.now()): number | false {
	if (ended) return false;
	const instant = deadlineInstant(value);
	if (instant === null) return false;
	return Math.max(1000, Math.min(instant - nowMs + 100, 300_000));
}

/**
 * "Closes in 19 h 12 min" for a sourced closing instant (owner 2026-10-29: a
 * countdown reads faster than "Oct 30, 2026, 6:00 PM GMT+1 · Your time").
 * Days once two or more are left, hours and minutes inside two days, minutes
 * in the last hour. Null when the listing gives no exact closing time, so the
 * caller keeps its date-only wording rather than inventing an hour.
 */
export function deadlineCountdown(value: string | null | undefined, nowMs = Date.now()): string | null {
	const instant = deadlineInstant(value);
	if (instant === null) return null;
	const left = instant - nowMs;
	if (left <= 0) return 'Closed';
	const minutes = Math.floor(left / 60_000);
	if (minutes < 1) return 'Closes in under a minute';
	if (minutes < 60) return `Closes in ${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `Closes in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
	return `Closes in ${Math.floor(hours / 24)} days`;
}

/** "Fri 6:00 PM" in the person's own zone: the quiet partner of the countdown. */
export function deadlineShortLocal(value: string | null | undefined, timeZone?: string): string | null {
	const instant = deadlineInstant(value);
	if (instant === null) return null;
	if (timeZone) {
		try { new Intl.DateTimeFormat(undefined, { timeZone }); } catch { timeZone = undefined; }
	}
	return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(instant));
}
