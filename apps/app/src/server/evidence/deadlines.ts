/**
 * P10 — deadline timezone normalization (feature-ledger H2, adapted from the
 * HackSteward reference domain/deadlines.py WITH the midnight fix).
 *
 * The signature failure this module exists to prevent: a deadline written as
 * "September 9, 2026 at 5:00 PM PT" and one written as "September 10, 01:00
 * UTC" are one hour apart, not a day apart. Comparing rendered text reports a
 * day's difference; comparing normalized instants reports the truth.
 *
 * Rules that keep it honest (all pinned by tests):
 *   1. A deadline without a stated timezone is never normalized by
 *      assumption. Assuming UTC (or the server's zone) would silently move a
 *      real deadline by hours; missing/unrecognized zone → AMBIGUOUS.
 *   2. THE HACKSTEWARD MIDNIGHT FIX: a date-only deadline keeps DATE-ONLY
 *      semantics. The reference normalized "September 21" to midnight in the
 *      stated zone — an invented time of day. Here the calendar date is
 *      recorded and the TIME STAYS UNKNOWN (no instant is produced), because
 *      a deadline that could land anywhere in a 24-hour window must not be
 *      narrowed by assumption.
 *   3. Only a deliberately narrow grammar is parsed; anything else is
 *      ambiguous rather than guessed at — a mis-parsed deadline is worse
 *      than an unparsed one.
 *   4. Same instant, different offsets (DST/offset equivalence) are EQUAL —
 *      {@link sameInstant} / {@link deadlineInstantKey} compare pinned
 *      instants, which is what lets equivalent wordings agree at
 *      reconciliation instead of conflicting.
 *
 * Timezone data comes from Intl (full ICU in both bun and workerd), so DST
 * is respected through the zone database, not by arithmetic.
 */

export type DeadlineStatus = 'resolved' | 'date_only' | 'ambiguous';

export interface NormalizedDeadline {
	readonly originalText: string;
	/** The zone USED for normalization, when one was stated and recognized. */
	readonly zone: string | null;
	readonly status: DeadlineStatus;
	/** ISO UTC instant — present ONLY when status is 'resolved'. */
	readonly utc: string | null;
	/** 'YYYY-MM-DD' calendar date — present for 'resolved' and 'date_only'. */
	readonly date: string | null;
	readonly hasTime: boolean;
	/** Why the deadline could not be pinned (null when resolved). */
	readonly reason: string | null;
}

// "September 9, 2026 at 5:00 PM", "Sep 10 2026, 01:00", "September 21, 2026".
// Time-of-day is OPTIONAL — but unlike the reference, a missing time stays
// unknown instead of collapsing to midnight (rule 2). The separator between
// date and time may be ", ", " at ", or any mix.
const DEADLINE_RE =
	/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:[\s,]+(?:at\s+)?)?[\s,]*(?:(\d{1,2}):(\d{2})(?:\s*([APap])\.?[Mm]?\.?)?)?/;

const MONTHS: Readonly<Record<string, number>> = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12,
};

function ambiguous(
	originalText: string,
	zoneName: string | null,
	reason: string,
): NormalizedDeadline {
	return { originalText, zone: zoneName, status: 'ambiguous', utc: null, date: null, hasTime: false, reason };
}

/** Offset (minutes) of `timeZone` in effect at `instant`. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
	const parts = new Map<string, number>();
	for (const part of dtf.formatToParts(instant)) {
		if (part.type !== 'literal') parts.set(part.type, Number(part.value));
	}
	const asUtc = Date.UTC(
		parts.get('year')!,
		parts.get('month')! - 1,
		parts.get('day')!,
		parts.get('hour')!,
		parts.get('minute')!,
		parts.get('second')!,
	);
	return (asUtc - instant.getTime()) / 60000;
}

/** UTC milliseconds for a wall-clock time in a zone (guess + refine). */
function zonedWallTimeToUtcMs(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
): number {
	const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
	const offset1 = tzOffsetMinutes(new Date(wallAsUtc), timeZone);
	const guess = wallAsUtc - offset1 * 60000;
	const offset2 = tzOffsetMinutes(new Date(guess), timeZone);
	return wallAsUtc - offset2 * 60000;
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
	const ms = Date.UTC(year, month - 1, day);
	const check = new Date(ms);
	return (
		check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
	);
}

/**
 * Pin a deadline representation to a UTC instant, keep it date-only, or
 * report exactly why it cannot be pinned.
 *
 * The zone is supplied separately from the text because the zone usually
 * arrives as page-level context ("all times PT") rather than inside the
 * sentence. Omitting it is the same as stating no zone, and both are
 * ambiguous — never a silently-assumed zone.
 */
export function normalizeDeadline(originalText: string, zoneName?: string | null): NormalizedDeadline {
	const text = originalText.trim();
	if (!text) {
		return ambiguous(originalText, zoneName ?? null, 'deadline text is blank');
	}
	const match = DEADLINE_RE.exec(text);
	if (!match) {
		return ambiguous(
			originalText,
			zoneName ?? null,
			'deadline text does not match a supported date format',
		);
	}
	const monthName = match[1]!.toLowerCase();
	const month = MONTHS[monthName];
	if (month === undefined) {
		return ambiguous(
			originalText,
			zoneName ?? null,
			`unrecognized month name: ${match[1]}`,
		);
	}
	const day = Number(match[2]);
	const year = Number(match[3]);
	const hasTime = match[4] !== undefined;
	const statedZone = zoneName?.trim() ? zoneName.trim() : null;

	if (!statedZone) {
		return ambiguous(
			originalText,
			null,
			'no timezone stated; assuming one would move a real deadline (missing timezone stays unknown)',
		);
	}
	try {
		// RangeError on unknown zones — the Intl ICU database is the authority.
		new Intl.DateTimeFormat('en-US', { timeZone: statedZone });
	} catch {
		return ambiguous(originalText, statedZone, `unrecognized timezone ${JSON.stringify(statedZone)}`);
	}
	if (!isRealCalendarDate(year, month, day)) {
		return ambiguous(originalText, statedZone, `not a real calendar date: ${monthName} ${day}, ${year}`);
	}
	const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

	if (!hasTime) {
		// THE MIDNIGHT FIX: date-only stays date-only. The calendar date is
		// recorded; no time of day is invented and no instant is produced.
		return {
			originalText,
			zone: statedZone,
			status: 'date_only',
			utc: null,
			date,
			hasTime: false,
			reason: 'date-only deadline: the time of day is unknown and is never assumed',
		};
	}

	let hour = Number(match[4]);
	const minute = Number(match[5]);
	const meridiem = match[6]?.toUpperCase();
	if (meridiem) {
		if (hour < 1 || hour > 12) {
			return ambiguous(originalText, statedZone, `hour ${hour} is invalid on a 12-hour clock`);
		}
		if (meridiem === 'P' && hour !== 12) hour += 12;
		else if (meridiem === 'A' && hour === 12) hour = 0;
	} else if (hour > 23) {
		return ambiguous(originalText, statedZone, `hour ${hour} is invalid on a 24-hour clock`);
	}

	const utcMs = zonedWallTimeToUtcMs(year, month, day, hour, minute, statedZone);
	return {
		originalText,
		zone: statedZone,
		status: 'resolved',
		utc: new Date(utcMs).toISOString(),
		date,
		hasTime: true,
		reason: null,
	};
}

/**
 * Distance between two RESOLVED deadlines in milliseconds. `null` when either
 * side is not a pinned instant: the distance between a fact and a guess is
 * not a number (and a date-only deadline has no instant to measure).
 */
export function deadlineGap(left: NormalizedDeadline, right: NormalizedDeadline): number | null {
	if (left.utc === null || right.utc === null) return null;
	return Math.abs(Date.parse(left.utc) - Date.parse(right.utc));
}

/**
 * Whether two instant strings denote the SAME moment — the DST/offset
 * equivalence rule. "2026-08-31T20:00:00-04:00" and "2026-09-01T00:00:00Z"
 * are one instant. Anything unparsable on either side is NOT equal (never
 * `true` by accident).
 */
export function sameInstant(a: string, b: string): boolean {
	const left = Date.parse(a);
	const right = Date.parse(b);
	return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

// An ISO-8601 datetime WITH an explicit UTC offset or Z — the only shape that
// pins an instant by itself. Date-only or offset-less strings never match.
const ISO_INSTANT_SEARCH_RE =
	/\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})/;

/**
 * The reconciliation instant key for a claim value (claims.ts
 * `instantKey`): the pinned epoch-milliseconds string when the value carries
 * an ISO instant with an explicit offset, else null — a date-only wording or
 * prose pins nothing and falls back to text comparison.
 */
export function deadlineInstantKey(value: string): string | null {
	const match = ISO_INSTANT_SEARCH_RE.exec(value);
	if (!match) return null;
	const ms = Date.parse(match[0]);
	return Number.isFinite(ms) ? String(ms) : null;
}
