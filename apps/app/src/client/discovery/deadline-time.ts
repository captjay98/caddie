/** Date-only listings do not establish a closing hour or timezone. */
export function deadlineInstant(value: string | null | undefined): number | null {
	if (!value || !/\d[:.]\d{2}/.test(value)) return null;
	// Require an explicit offset or an unambiguous supported source zone.
	if (!/(?:Z|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT|PDT|PST|EDT|EST)\b)\s*$/i.test(value)) return null;
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
