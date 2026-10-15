import type { ProjectHackathonView } from '../queries.ts';

/**
 * Header chips for the hackathon a project is for (2026-10-15 redesign).
 * Pure so the wording is unit-tested. A chip with nothing true to say is
 * omitted, never filled with a guess.
 */
export interface HeaderChip {
	readonly id: 'event' | 'deadline' | 'eligibility';
	readonly text: string;
	readonly tone: 'accent' | 'neutral' | 'ok' | 'warn' | 'danger';
	readonly href?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 30" from an ISO date, without timezone drift. */
function shortDate(iso: string): string {
	const [, m, d] = iso.split('-').map(Number);
	return m && d ? `${MONTHS[m - 1]} ${d}` : iso;
}

export function deadlineText(hackathon: Pick<ProjectHackathonView, 'deadline' | 'daysLeft' | 'ended'>): string | null {
	if (!hackathon.deadline) return null;
	const date = shortDate(hackathon.deadline);
	if (hackathon.ended) return `Ended ${date}`;
	if (hackathon.daysLeft === 0) return `Ends today · ${date}`;
	if (hackathon.daysLeft === 1) return `Ends ${date} · 1 day left`;
	return hackathon.daysLeft === null ? `Ends ${date}` : `Ends ${date} · ${hackathon.daysLeft} days left`;
}

export function hackathonChips(hackathon: ProjectHackathonView | null): HeaderChip[] {
	if (!hackathon) return [];
	const chips: HeaderChip[] = [
		{ id: 'event', text: hackathon.title, tone: 'accent', ...(hackathon.url ? { href: hackathon.url } : {}) },
	];
	const deadline = deadlineText(hackathon);
	if (deadline) {
		const close = !hackathon.ended && hackathon.daysLeft !== null && hackathon.daysLeft <= 3;
		chips.push({ id: 'deadline', text: deadline, tone: hackathon.ended ? 'danger' : close ? 'warn' : 'neutral' });
	}
	// Only a CHECKED verdict earns a chip; "unknown" is not shown as a claim.
	if (hackathon.eligibility === 'eligible') chips.push({ id: 'eligibility', text: 'You can enter', tone: 'ok' });
	if (hackathon.eligibility === 'ineligible') chips.push({ id: 'eligibility', text: 'You may not be able to enter', tone: 'danger' });
	return chips;
}

/** First sentence of the idea, bounded — the header's one line. The full text stays in "Your idea". */
export function oneLineIdea(description: string | null | undefined, max = 120): string | null {
	const text = (description ?? '').replace(/\s+/g, ' ').trim();
	if (!text) return null;
	const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
	if (sentence.length <= max) return sentence;
	const cut = sentence.slice(0, max);
	const lastSpace = cut.lastIndexOf(' ');
	return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, '')}…`;
}
