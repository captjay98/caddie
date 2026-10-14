import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	cleanHackathonTitle,
	composeContestSummary,
	createDevpostDiscoveryAdapter,
	fetchOpenDevpostContests,
	normalizeDevpostContest,
	parseEventDates,
	parseFormat,
	parseParticipants,
	parsePrizeUsd,
} from '../apps/app/src/server/discovery.ts';

/**
 * Stage 2 — Devpost's open-contests API as the PRIMARY hackathon list.
 *
 * LOCAL VERIFIED (unit level): every test replays a REAL snapshot of
 * `GET https://devpost.com/api/hackathons?status[]=open&per_page=40` captured
 * 2026-10-13 (tests/fixtures/devpost/open-page{1,2}.json — 46 contests, 6 of
 * them invite-only). No network is touched; the live adapter is exercised in
 * Stage 6 separately.
 */

type RawPage = { hackathons: Record<string, unknown>[]; meta: { total_count: number; per_page: number } };
const PAGES: Record<number, RawPage> = {
	1: JSON.parse(readFileSync(new URL('./fixtures/devpost/open-page1.json', import.meta.url), 'utf8')) as RawPage,
	2: JSON.parse(readFileSync(new URL('./fixtures/devpost/open-page2.json', import.meta.url), 'utf8')) as RawPage,
};
const ALL_RAW = [...PAGES[1]!.hackathons, ...PAGES[2]!.hackathons];
const INVITE_ONLY_TITLES = ALL_RAW.filter((h) => h['invite_only'] === true).map((h) => String(h['title']));
const rawByTitle = (needle: string) => {
	const hit = ALL_RAW.find((h) => String(h['title']).includes(needle));
	if (!hit) throw new Error(`fixture has no contest titled like ${needle}`);
	return hit;
};

/** A fetch that serves the saved snapshot by `page`, recording each requested URL. */
function fixtureFetch(calls: string[], override?: (page: number) => Response | null): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		calls.push(url.toString());
		const page = Number(url.searchParams.get('page') ?? '1');
		const forced = override?.(page);
		if (forced) return forced;
		const body = PAGES[page] ?? { hackathons: [], meta: PAGES[1]!.meta };
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as unknown as typeof fetch;
}

describe('fetchOpenDevpostContests — every open, public contest', () => {
	test('pages at per_page=40 until total_count, in exactly two calls', async () => {
		const calls: string[] = [];
		await fetchOpenDevpostContests(fixtureFetch(calls));
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			const url = new URL(call);
			expect(url.searchParams.get('per_page')).toBe('40');
			expect(url.searchParams.get('status[]')).toBe('open');
		}
	});

	test('drops invite-only contests and keeps every other open one (46 - 6 = 40)', async () => {
		const contests = await fetchOpenDevpostContests(fixtureFetch([]));
		expect(INVITE_ONLY_TITLES.length).toBe(6);
		expect(contests).toHaveLength(ALL_RAW.length - INVITE_ONLY_TITLES.length);
		const titles = contests.map((c) => c.title);
		for (const hidden of INVITE_ONLY_TITLES) expect(titles).not.toContain(hidden);
	});

	test('surfaces the big-sponsor events web search missed', async () => {
		const titles = (await fetchOpenDevpostContests(fixtureFetch([]))).map((c) => c.title);
		for (const expected of ['Amazon Developer Hackathon', 'Nebius x NVIDIA', 'PayPal AI Hackathon', 'Meta VR Start']) {
			expect(titles.some((t) => t.includes(expected))).toBe(true);
		}
	});

	test('a failed FIRST page throws — a visible gap, never a silent empty list', async () => {
		const failing = fixtureFetch([], () => new Response('down', { status: 503 }));
		await expect(fetchOpenDevpostContests(failing)).rejects.toThrow('Devpost open-contests API unavailable');
	});

	test('a failed LATER page keeps what earlier pages returned', async () => {
		const flaky = fixtureFetch([], (page) => (page === 2 ? new Response('down', { status: 503 }) : null));
		const contests = await fetchOpenDevpostContests(flaky);
		const page1Public = PAGES[1]!.hackathons.filter((h) => h['invite_only'] !== true).length;
		expect(contests).toHaveLength(page1Public);
	});

	test('an empty feed throws rather than reporting "no hackathons exist"', async () => {
		const empty = (async () =>
			new Response(JSON.stringify({ hackathons: [], meta: { total_count: 0 } }), { status: 200 })) as unknown as typeof fetch;
		await expect(fetchOpenDevpostContests(empty)).rejects.toThrow('no open public hackathons');
	});
});

describe('normalizeDevpostContest — structured fields, honestly', () => {
	test('Amazon: org, dates, display prize, ordering prize, entries, online', () => {
		const amazon = normalizeDevpostContest(rawByTitle('Amazon Developer Hackathon') as never)!;
		expect(amazon.organization).toBe('Amazon');
		expect(amazon.dates).toBe('Aug 31 - Oct 23, 2026');
		expect(amazon.prize).toBe('$138,000');
		expect(amazon.prizeUsd).toBe(138_000);
		expect(amazon.registrations).toBeGreaterThan(50_000);
		expect(amazon.format).toBe('online');
		expect(amazon.location).toBeNull();
		expect(amazon.themes).toContain('Machine Learning/AI');
	});

	test('a $0 prize is shown as no prize, not "$0"', () => {
		const zero = normalizeDevpostContest(rawByTitle('WarriorHacks') as never)!;
		expect(zero.prize).toBeNull();
		expect(zero.prizeUsd).toBeNull();
	});

	test('a non-USD prize keeps its own currency for display', () => {
		const inr = normalizeDevpostContest(rawByTitle('Multimodal AI Hackathon') as never)!;
		expect(inr.prize).toContain('₹');
	});

	test('an in-person event carries its venue', () => {
		const venue = normalizeDevpostContest(rawByTitle('Bengaluru') as never)!;
		expect(venue.format).toBe('in-person');
		expect(venue.location).toContain('Bengaluru');
	});

	test('ended or invite-only entries are rejected', () => {
		const base = rawByTitle('Amazon Developer Hackathon');
		expect(normalizeDevpostContest({ ...base, open_state: 'ended' } as never)).toBeNull();
		expect(normalizeDevpostContest({ ...base, invite_only: true } as never)).toBeNull();
		expect(normalizeDevpostContest({ ...base, url: undefined } as never)).toBeNull();
	});
});

describe('composeContestSummary — the card chips read real fields back out', () => {
	test('round-trips dates, prize, entries and format through the chip parsers', () => {
		const amazon = normalizeDevpostContest(rawByTitle('Amazon Developer Hackathon') as never)!;
		const summary = composeContestSummary(amazon);
		expect(summary).toContain('By Amazon');
		expect(summary).toContain('$138,000 in prizes');
		expect(summary).toContain('Online');
		expect(parseEventDates(summary)).toEqual({ startsAt: '2026-08-31', endsAt: '2026-10-23', deadline: '2026-10-23' });
		expect(parsePrizeUsd(summary)).toBe(138_000);
		expect(parseParticipants(summary)).toBe(amazon.registrations);
		expect(parseFormat(summary)).toBe('online');
	});

	test('in-person summary says so, so an online-only builder can filter it', () => {
		const venue = normalizeDevpostContest(rawByTitle('Bengaluru') as never)!;
		const summary = composeContestSummary(venue);
		expect(summary).toContain('In person');
		expect(parseFormat(summary)).toBe('in-person');
	});

	test('a cross-year contest reports the real (next-year) deadline', () => {
		const long = normalizeDevpostContest(rawByTitle('Code for Humanity') as never)!;
		expect(long.dates).toBe('Jul 16, 2026 - Jan 15, 2027');
		expect(parseEventDates(composeContestSummary(long))).toEqual({
			startsAt: '2026-07-16',
			endsAt: '2027-01-15',
			deadline: '2027-01-15',
		});
	});
});

describe('cleanHackathonTitle', () => {
	test('strips " - Devpost" and a sentence tagline from page titles', () => {
		expect(cleanHackathonTitle('All In Hackathon: At this 24-hour hackathon sponsored by GitHub, we are challenging you - Devpost')).toBe('All In Hackathon');
		expect(cleanHackathonTitle('PayPal AI Hackathon - Devpost')).toBe('PayPal AI Hackathon');
	});
	test('keeps a real colon title whole (with and without a tagline)', () => {
		expect(cleanHackathonTitle('Build, Ship, Shape: Amazon Developer Hackathon')).toBe('Build, Ship, Shape: Amazon Developer Hackathon');
		expect(cleanHackathonTitle('Build, Ship, Shape: Amazon Developer Hackathon - Devpost')).toBe('Build, Ship, Shape: Amazon Developer Hackathon');
		expect(
			cleanHackathonTitle('Build, Ship, Shape: Amazon Developer Hackathon: Build across Amazon Devices and shape what is next. - Devpost'),
		).toBe('Build, Ship, Shape: Amazon Developer Hackathon');
	});
});

describe('createDevpostDiscoveryAdapter', () => {
	test('yields candidates with composed summaries and major-organiser weights', async () => {
		const batch = await createDevpostDiscoveryAdapter({ fetchImpl: fixtureFetch([]) }).fetchCandidates({ projectId: 'p1' });
		expect(batch.candidates).toHaveLength(40);
		const amazon = batch.candidates.find((c) => c.title.includes('Amazon Developer Hackathon'))!;
		expect(amazon.url).toBe('https://amazonappdev2026.devpost.com/');
		expect(amazon.summary).not.toMatch(/Devpost for Teams|\|\|\||<span/);
		expect(amazon.companyWeight).toBeGreaterThanOrEqual(3);
		expect(amazon.participants).toBeGreaterThan(50_000);
		const nebius = batch.candidates.find((c) => c.title.includes('Nebius'))!;
		expect(nebius.companyWeight).toBeGreaterThanOrEqual(3);
	});
});
