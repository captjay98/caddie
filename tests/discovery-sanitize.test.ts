import { describe, expect, test } from 'bun:test';
import {
	parseEventDates,
	parseFormat,
	parseParticipants,
	parsePrizeUsd,
	sanitizeSummary,
} from '../apps/app/src/server/discovery.ts';
import { companyWeight, isEndedHackathon } from '../apps/app/src/server/discovery.ts';

/**
 * Stage 1 — clean the card content at the source (LOCAL VERIFIED, unit level).
 *
 * The cards rendered raw scraped Devpost page-text: nav crumbs ("Devpost
 * Devpost logo"), separator soup ("||| --- ||"), calendar-add chrome ("Apple
 * Google Outlook"), and "This hackathon has ended". These tests pin the
 * sanitizer + parsers against the EXACT ugly strings the screenshots showed,
 * so a regression that lets the soup back onto a card fails here.
 *
 * HONESTY contract asserted throughout: an unparseable field stays null — the
 * parsers never fabricate a prize, count, format or date.
 */

// The two verbatim summaries quoted from the screenshots.
const SOUP_1 = 'Apple Google Outlook ||| --- || Online | Public || $100 in cash';
const SOUP_2 = 'Devpost Devpost Devpost logo';

describe('sanitizeSummary — strips Devpost nav/boilerplate soup', () => {
	test('removes separator soup, calendar chrome, keeps real content', () => {
		const out = sanitizeSummary(SOUP_1);
		// Separator soup gone.
		expect(out).not.toContain('|||');
		expect(out).not.toContain('---');
		expect(out).not.toContain('||');
		// Calendar-add button row gone.
		expect(out.toLowerCase()).not.toContain('apple google outlook');
		// Real signal survives.
		expect(out.toLowerCase()).toContain('online');
		expect(out).toContain('$100 in cash');
		// No per-word ladder: it's readable prose, not a pile of lone bars.
		expect(out.trim().length).toBeGreaterThan(0);
	});

	test('collapses repeated nav labels and drops "logo"', () => {
		const out = sanitizeSummary(SOUP_2);
		// "Devpost Devpost Devpost logo" must not survive as repeated soup.
		expect(out.toLowerCase()).not.toContain('devpost devpost');
		expect(out.toLowerCase()).not.toContain('devpost logo');
	});

	test('strips "This hackathon has ended" and "View schedule"', () => {
		const out = sanitizeSummary('AI Builders Jam. This hackathon has ended. View schedule.');
		expect(out.toLowerCase()).not.toContain('this hackathon has ended');
		expect(out.toLowerCase()).not.toContain('view schedule');
		expect(out).toContain('AI Builders Jam');
	});

	test('strips HTML tags', () => {
		expect(sanitizeSummary('<p>By <b>NVIDIA</b></p>')).toBe('By NVIDIA');
	});

	test('falls back to a neutral line when nothing readable survives', () => {
		expect(sanitizeSummary('||| --- || | ·', 'Open hackathon on Devpost.')).toBe('Open hackathon on Devpost.');
		expect(sanitizeSummary(null)).toBe('Open hackathon.');
		expect(sanitizeSummary('')).toBe('Open hackathon.');
	});

	test('truncates on a word boundary with an ellipsis', () => {
		// Distinct words so the repeated-word dedupe does not collapse the input
		// before truncation runs (that collapse is desired behaviour, tested above).
		const long = Array.from({ length: 100 }, (_, i) => `token${i}`).join(' ');
		const out = sanitizeSummary(long, 'fallback', 60);
		expect(out.length).toBeLessThanOrEqual(61); // 60 + ellipsis
		expect(out.endsWith('…')).toBe(true);
		// cut on a space: the last token before the ellipsis is whole.
		expect(out).toMatch(/token\d+…$/);
	});
});

describe('parseParticipants', () => {
	test('reads counts in several phrasings', () => {
		expect(parseParticipants('1,234 participants')).toBe(1234);
		expect(parseParticipants('532 registrations')).toBe(532);
		expect(parseParticipants('88 teams')).toBe(88);
		expect(parseParticipants('participants: 90')).toBe(90);
		expect(parseParticipants('registrations - 400')).toBe(400);
	});
	test('returns the largest when several appear', () => {
		expect(parseParticipants('88 teams · 1,234 participants')).toBe(1234);
	});
	test('null when absent or implausible — never fabricated', () => {
		expect(parseParticipants('Online · Public · $100 in cash')).toBeNull();
		expect(parseParticipants(null)).toBeNull();
		expect(parseParticipants('held in 2026')).toBeNull(); // a bare year is not a count
	});
});

describe('parseFormat', () => {
	test('maps the common phrasings', () => {
		expect(parseFormat('Online · Public')).toBe('online');
		expect(parseFormat('Virtual event')).toBe('online');
		expect(parseFormat('In-person in Lagos')).toBe('in-person');
		expect(parseFormat('On-site at the venue')).toBe('in-person');
		expect(parseFormat('Hybrid: online and in person')).toBe('hybrid');
	});
	test('both online and in-person present → hybrid', () => {
		expect(parseFormat('Join online or in person')).toBe('hybrid');
	});
	test('null when not determinable; no false "person" match', () => {
		expect(parseFormat('A personal challenge')).toBeNull();
		expect(parseFormat('$100 in cash')).toBeNull();
		expect(parseFormat(null)).toBeNull();
	});
});

describe('parseEventDates', () => {
	test('range across two months', () => {
		expect(parseEventDates('Oct 03 - Nov 24, 2026')).toEqual({
			startsAt: '2026-10-03',
			endsAt: '2026-11-24',
			deadline: '2026-11-24',
		});
	});
	test('range within one month (en-dash)', () => {
		expect(parseEventDates('October 3–24, 2026')).toEqual({
			startsAt: '2026-10-03',
			endsAt: '2026-10-24',
			deadline: '2026-10-24',
		});
	});
	test('single date', () => {
		expect(parseEventDates('Nov 1, 2026')).toEqual({
			startsAt: '2026-11-01',
			endsAt: null,
			deadline: '2026-11-01',
		});
	});
	test('null everywhere when no date — never today', () => {
		expect(parseEventDates('Online · Public · $100 in cash')).toEqual({
			startsAt: null,
			endsAt: null,
			deadline: null,
		});
		expect(parseEventDates(null)).toEqual({ startsAt: null, endsAt: null, deadline: null });
	});
});

describe('parsePrizeUsd still parses the soup prize (regression)', () => {
	test('reads $100 out of the ugly summary', () => {
		expect(parsePrizeUsd(SOUP_1)).toBe(100);
	});
});

// --- Stage 4: discovery quality ---------------------------------------------

describe('isEndedHackathon — drops closed events, conservatively', () => {
	test('explicit non-open feed state → ended', () => {
		expect(isEndedHackathon({ openState: 'ended' })).toBe(true);
		expect(isEndedHackathon({ openState: 'closed' })).toBe(true);
	});
	test('ended phrases in text → ended', () => {
		expect(isEndedHackathon({ text: 'This hackathon has ended' })).toBe(true);
		expect(isEndedHackathon({ text: 'Submissions are closed' })).toBe(true);
		expect(isEndedHackathon({ text: 'Registration is closed for this event' })).toBe(true);
	});
	test('open or unknown → NOT ended (never guesses a close)', () => {
		expect(isEndedHackathon({ openState: 'open' })).toBe(false);
		expect(isEndedHackathon({ openState: null, text: 'Open · accepting submissions' })).toBe(false);
		expect(isEndedHackathon({})).toBe(false);
		// "upcoming" is not-open but is NOT ended — do not drop a future event here.
		expect(isEndedHackathon({ openState: 'upcoming' })).toBe(false);
	});
});

describe('companyWeight — surfaces the sponsors the user expects', () => {
	test('Nebius and PayPal now score (were missing)', () => {
		expect(companyWeight('Nebius AI Hackathon')).toBeGreaterThan(0);
		expect(companyWeight('PayPal Fintech Jam')).toBeGreaterThan(0);
	});
	test('existing big names still score; unknown scores 0', () => {
		expect(companyWeight('Google Cloud Challenge')).toBeGreaterThan(0);
		expect(companyWeight('Amazon AWS Builders')).toBeGreaterThan(0);
		expect(companyWeight('A tiny indie jam')).toBe(0);
	});
});

