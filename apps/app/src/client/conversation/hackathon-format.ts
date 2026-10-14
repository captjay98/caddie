import type { HackathonCandidate } from '@caddie/contracts';

/**
 * Display formatting shared by the chat hackathon card and the Discover list,
 * so the two surfaces word the same event the same way. Pure, no I/O.
 *
 * Every helper is honest-nullable: a field the candidate does not carry yields
 * null (the caller omits it), never a placeholder or a guess.
 */

const PLATFORM_NAMES: readonly (readonly [string, string])[] = [
	['devpost.com', 'Devpost'],
	['devfolio.co', 'Devfolio'],
	['hackerearth.com', 'HackerEarth'],
	['dorahacks.io', 'DoraHacks'],
	['ethglobal.com', 'ETHGlobal'],
	['kaggle.com', 'Kaggle'],
];

/** "amazonappdev2026.devpost.com" -> "Devpost"; an unknown host is shown as-is. */
export function platformName(platform: string | null): string | null {
	if (!platform) return null;
	const host = platform.toLowerCase();
	return PLATFORM_NAMES.find(([root]) => host === root || host.endsWith(`.${root}`))?.[1] ?? platform;
}

/** 54752 -> "54.7k", 1303 -> "1.3k", 883 -> "883". */
export function compactCount(value: number): string {
	if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
	if (value >= 1_000) return `${trimDecimal(value / 1_000)}k`;
	return String(value);
}

function trimDecimal(value: number): string {
	// One decimal, floored so 54,752 reads 54.7k (never rounded up to 54.8k).
	const floored = Math.floor(value * 10) / 10;
	return Number.isInteger(floored) ? String(floored) : floored.toFixed(1);
}

/**
 * The prize in its OWN currency, compacted: "$138,000" -> "$138k",
 * "₹ 100,000" -> "₹100k", "$1,000,000" -> "$1M". Text it cannot read is
 * returned unchanged rather than reinterpreted.
 */
export function compactPrize(prize: string | null): string | null {
	if (!prize) return null;
	const match = /^\s*([^\d\s]*)\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{0,3})\s*$/.exec(prize);
	if (!match) return prize.trim();
	const amount = Number(match[2]!.replace(/,/g, ''));
	if (!Number.isFinite(amount) || amount <= 0) return prize.trim();
	const suffix = match[3] ? ` ${match[3]}` : '';
	return `${match[1]}${compactCount(amount)}${suffix}`;
}

function shortDate(iso: string): string {
	const date = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

/** "Aug 31 – Oct 23", or one date, or null. */
export function dateRange(candidate: HackathonCandidate): string | null {
	if (candidate.startsAt && candidate.endsAt && candidate.startsAt !== candidate.endsAt) {
		return `${shortDate(candidate.startsAt)} – ${shortDate(candidate.endsAt)}`;
	}
	const single = candidate.startsAt ?? candidate.endsAt ?? candidate.deadline;
	return single ? shortDate(single) : null;
}

/** The submission deadline ("Oct 23"), or null when no end date is known. */
export function deadline(candidate: HackathonCandidate): string | null {
	const end = candidate.deadline ?? candidate.endsAt;
	return end ? shortDate(end) : null;
}

export const FORMAT_LABEL: Readonly<Record<NonNullable<HackathonCandidate['format']>, string>> = {
	online: 'Online',
	'in-person': 'In person',
	hybrid: 'Hybrid',
};

/** One row's meta line: "$50k · 22.7k entered · ends Oct 30". */
export function rowFacts(candidate: HackathonCandidate): string[] {
	const facts: string[] = [];
	const prize = compactPrize(candidate.prize);
	if (prize) facts.push(prize);
	if (candidate.participants && candidate.participants > 0) facts.push(`${compactCount(candidate.participants)} entered`);
	const end = deadline(candidate);
	if (end) facts.push(`ends ${end}`);
	return facts;
}

/** A single labelled fact for the scannable meta strip. `tone` lets a surface
 *  accent the money/host without restating colour in the component. */
export interface MetaPart {
	readonly key: 'host' | 'format' | 'dates' | 'prize' | 'entries' | 'themes';
	/** Short caption shown above/with the value, e.g. "Prize", "When". */
	readonly label: string;
	/** The value itself, e.g. "$45k", "Oct 5 – Oct 27". */
	readonly value: string;
}

/**
 * The row/detail meta as DISCRETE labelled facts instead of one `·`-joined
 * string — so "what is what" is legible (host vs dates vs prize vs themes).
 * Honest-nullable: a field the candidate does not carry is omitted entirely,
 * never shown as an empty or guessed value. Themes are capped at two.
 */
export function metaParts(candidate: HackathonCandidate): MetaPart[] {
	const parts: MetaPart[] = [];
	const host = platformName(candidate.platform) ?? candidate.organizer;
	if (host) parts.push({ key: 'host', label: 'By', value: host });
	if (candidate.format) parts.push({ key: 'format', label: 'Where', value: FORMAT_LABEL[candidate.format] });
	const dates = dateRange(candidate);
	if (dates) parts.push({ key: 'dates', label: 'When', value: dates });
	const prize = compactPrize(candidate.prize);
	if (prize) parts.push({ key: 'prize', label: 'Prize', value: prize });
	if (candidate.participants && candidate.participants > 0) {
		parts.push({ key: 'entries', label: 'Entered', value: compactCount(candidate.participants) });
	}
	if (candidate.themes && candidate.themes.length > 0) {
		parts.push({ key: 'themes', label: 'Themes', value: candidate.themes.slice(0, 2).join(', ') });
	}
	return parts;
}

export type EligibilityState = 'eligible' | 'ineligible' | 'confirm' | 'unknown';

export interface EligibilityView {
	readonly state: EligibilityState;
	/** The full wording for a roomy card ("You can enter", "Open to US · confirm you're 18+"). */
	readonly label: string;
	/** The short chip for a dense row ("Can enter", "Confirm 13+", "Not checked"). */
	readonly short: string;
	/** The fold-out heading that explains the verdict, or null when there is nothing to explain. */
	readonly why: string | null;
}

/**
 * The eligibility wording. The VERDICT is the strict engine's and is never
 * softened here: "confirm" is an unknown verdict whose only open rules are
 * ones the profile cannot check (age, student status), and "Not checked"
 * means no rules page has been read for this event yet.
 */
export function eligibilityView(candidate: HackathonCandidate): EligibilityView {
	const note = candidate.eligibilityNote?.trim() ?? '';
	const hasQuote = Boolean(candidate.eligibilityQuote?.trim());
	if (candidate.eligibility === 'eligible') {
		return { state: 'eligible', label: note || 'You can enter', short: 'Can enter', why: hasQuote ? 'Why you can enter' : null };
	}
	if (candidate.eligibility === 'ineligible') {
		return { state: 'ineligible', label: note || "Can't enter", short: "Can't enter", why: hasQuote ? "Why you can't enter" : null };
	}
	if (candidate.eligibilityNeedsConfirm) {
		const ask = /confirm\s+(?:you(?:'|’)re\s+)?(.+)$/i.exec(note)?.[1]?.trim();
		const label = note ? note.charAt(0).toUpperCase() + note.slice(1) : 'Confirm the entry rules';
		return { state: 'confirm', label, short: ask ? `Confirm ${ask}` : 'Confirm rules', why: hasQuote ? 'What to confirm' : null };
	}
	if (note) return { state: 'unknown', label: note, short: note, why: hasQuote ? 'What the rules say' : null };
	return { state: 'unknown', label: 'Entry not checked yet', short: 'Not checked', why: null };
}
