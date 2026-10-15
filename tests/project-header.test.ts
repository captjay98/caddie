import { describe, expect, test } from 'bun:test';
import { deadlineText, hackathonChips, oneLineIdea } from '../apps/app/src/client/workspace/project-header.ts';
import { briefText } from '../apps/app/src/client/queries.ts';

/**
 * Project header + side cards (2026-10-15 redesign, Stage 3). The old header
 * printed the full 300-character idea, had no hackathon or days left, and hid
 * settings behind an unlabelled panel icon.
 */
const NEBIUS = {
	title: 'Nebius x NVIDIA Global AI Hackathon',
	url: 'https://nebiusglobalaihackathon.devpost.com',
	track: 'Coding and Agentic Engineering Track',
	deadline: '2026-10-30',
	daysLeft: 15,
	ended: false,
	eligibility: 'eligible' as const,
};

describe('hackathon chips', () => {
	test('event (linked), deadline with days left, and a checked "You can enter"', () => {
		expect(hackathonChips(NEBIUS)).toEqual([
			{ id: 'event', text: NEBIUS.title, tone: 'accent', href: NEBIUS.url },
			{ id: 'deadline', text: 'Ends Oct 30 · 15 days left', tone: 'neutral' },
			{ id: 'eligibility', text: 'You can enter', tone: 'ok' },
		]);
	});

	test('an unchecked verdict earns no chip, and an unknown deadline no deadline chip', () => {
		expect(hackathonChips({ ...NEBIUS, eligibility: 'unknown', deadline: null, daysLeft: null }).map((c) => c.id)).toEqual(['event']);
	});

	test('ineligible is said plainly; a near or past deadline is flagged', () => {
		expect(hackathonChips({ ...NEBIUS, eligibility: 'ineligible' }).at(-1)).toMatchObject({ text: 'You may not be able to enter', tone: 'danger' });
		expect(hackathonChips({ ...NEBIUS, daysLeft: 2 })[1]).toMatchObject({ text: 'Ends Oct 30 · 2 days left', tone: 'warn' });
		expect(hackathonChips({ ...NEBIUS, daysLeft: 0, ended: true })[1]).toMatchObject({ text: 'Ended Oct 30', tone: 'danger' });
	});

	test('no hackathon, no chips; no link, no href', () => {
		expect(hackathonChips(null)).toEqual([]);
		expect(hackathonChips({ ...NEBIUS, url: null })[0]).not.toHaveProperty('href');
	});

	test('deadline wording for today and tomorrow', () => {
		expect(deadlineText({ deadline: '2026-10-30', daysLeft: 0, ended: false })).toBe('Ends today · Oct 30');
		expect(deadlineText({ deadline: '2026-10-30', daysLeft: 1, ended: false })).toBe('Ends Oct 30 · 1 day left');
		expect(deadlineText({ deadline: null, daysLeft: null, ended: false })).toBeNull();
	});
});

describe('one-line idea', () => {
	test("FarmLog AI's long description becomes its first sentence, bounded at a word", () => {
		const description =
			'A smartphone-first web app for catfish and broiler farmers to log daily feed, weight, water quality and health observations; AI models on Nebius Token Factory compute feed-conversion ratios, detect abnormal trends and push early-warning alerts, while a dashboard and autonomous agent provide actionable insights.';
		const line = oneLineIdea(description)!;
		expect(line.length).toBeLessThanOrEqual(121);
		expect(line.endsWith('…')).toBe(true);
		expect(line.startsWith('A smartphone-first web app for catfish and broiler farmers')).toBe(true);
		expect(line).not.toMatch(/\s…$/);
	});

	test('a short first sentence is kept whole; empty stays null', () => {
		expect(oneLineIdea('Records for farmers. Then more detail here.')).toBe('Records for farmers.');
		expect(oneLineIdea('   ')).toBeNull();
		expect(oneLineIdea(null)).toBeNull();
	});
});

describe('brief text for "Read the full brief"', () => {
	test('an old brief prefixed with the last chat message shows only the brief Caddie wrote', () => {
		expect(briefText('1 and 3 are the most relaistic\n\nProject brief: Build a React + Bun + Hono app.')).toBe('Build a React + Bun + Hono app.');
	});
	test('a plain brief is unchanged; nothing is null', () => {
		expect(briefText('Build FarmLog AI.')).toBe('Build FarmLog AI.');
		expect(briefText(null)).toBeNull();
		expect(briefText('  ')).toBeNull();
	});
});
