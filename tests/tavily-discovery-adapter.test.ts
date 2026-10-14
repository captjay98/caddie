import { afterEach, describe, expect, test } from 'bun:test';
import { buildDiscoveryQueries, createTavilyDiscoveryAdapter, UNVERIFIED_OPEN_LABEL } from '../apps/app/src/server/discovery.ts';

/**
 * Stage 3 — Tavily's role in discovery (createTavilyDiscoveryAdapter),
 * unit-tested with a STUBBED global fetch; no real network.
 *
 * Contract (2026-10-13): the Devpost open-contests API is the primary list for
 * Devpost. Tavily searches the OTHER platforms and drops its own Devpost hits;
 * only in BACKUP mode (Devpost API unavailable) does it search devpost.com too,
 * labelling every such candidate "open status unverified". Invariants kept from
 * the earlier design: no key / empty search THROW (visible gaps), help/listing
 * noise is dropped, urls dedupe (canonical), ended events are dropped, and
 * summaries are the sanitized snippet "· via <platform>" — never invented.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface SearchCall {
	readonly query: string;
	readonly includeDomains: readonly string[];
}

/**
 * Stub Tavily search. `results` is either one list for every query, or a map
 * routed by a substring of the query. Records each call's query + domains.
 */
function stubTavily(results: unknown[] | Record<string, unknown[]>, calls: SearchCall[] = [], status = 200): SearchCall[] {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (!url.includes('api.tavily.com/search')) return new Response('unexpected fetch in unit test', { status: 599 });
		const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string; include_domains?: string[] };
		calls.push({ query: body.query ?? '', includeDomains: body.include_domains ?? [] });
		const routed = Array.isArray(results)
			? results
			: (Object.entries(results).find(([key]) => (body.query ?? '').includes(key))?.[1] ?? []);
		return new Response(JSON.stringify({ results: routed }), { status });
	}) as unknown as typeof fetch;
	return calls;
}

const adapter = (extra: Partial<Parameters<typeof createTavilyDiscoveryAdapter>[0]> = {}) =>
	createTavilyDiscoveryAdapter({ tavilyApiKey: 'k', ...extra });
const backupAdapter = (extra: Partial<Parameters<typeof createTavilyDiscoveryAdapter>[0]> = {}) =>
	adapter({ devpostBackup: () => true, ...extra });
const run = (a: ReturnType<typeof createTavilyDiscoveryAdapter>) => a.fetchCandidates({ projectId: 'p1' });

describe('normal mode — Tavily covers the platforms the Devpost API does not', () => {
	test('searches the other platforms only: devpost.com is NOT in include_domains', async () => {
		const calls = stubTavily([{ url: 'https://naija-hack.devfolio.co', title: 'Naija Hack', content: 'An open Devfolio event.' }]);
		await run(adapter());
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.includeDomains).not.toContain('devpost.com');
			for (const domain of ['devfolio.co', 'hackerearth.com', 'dorahacks.io', 'ethglobal.com', 'kaggle.com']) {
				expect(call.includeDomains).toContain(domain);
			}
			// MLH only lists events hosted elsewhere; searching it spent result slots on schedules.
			expect(call.includeDomains).not.toContain('mlh.io');
		}
	});

	test('drops Devpost hits — the API is authoritative for Devpost (no duplicates, no ended page soup)', async () => {
		stubTavily([
			{ url: 'https://covidathon.devpost.com/', title: 'COVIDathon - Devpost', content: 'Ray Ng, MD Ray Ng, MD Nth Opinion' },
			{ url: 'https://naija-hack.devfolio.co', title: 'Naija Hack', content: 'An open Devfolio event.' },
		]);
		const urls = (await run(adapter())).candidates.map((c) => c.url);
		expect(urls).toEqual(['https://naija-hack.devfolio.co']);
	});

	test('does not pay for the big-sponsor query (those events come from the Devpost API)', async () => {
		const calls = stubTavily([{ url: 'https://naija-hack.devfolio.co', title: 'Naija Hack', content: 'x' }]);
		await run(adapter({ terms: ['ai'], country: 'NG' }));
		expect(calls.some((c) => /nebius/i.test(c.query))).toBe(false);
		expect(calls).toHaveLength(3); // generic + ai topic + NG locality
	});

	test('a non-Devpost hit keeps its sanitized snippet, labelled "· via <platform>"', async () => {
		stubTavily([{ url: 'https://great-hack.devfolio.co', title: 'Great Hack', content: 'A great Devfolio event.', score: 0.7 }]);
		const hit = (await run(adapter())).candidates.find((c) => c.url === 'https://great-hack.devfolio.co')!;
		expect(hit.summary).toContain('A great Devfolio event.');
		expect(hit.summary).toContain('via devfolio.co');
		expect(hit.summary).not.toContain(UNVERIFIED_OPEN_LABEL);
		expect(hit.publishedAt).toBeNull();
		expect(hit.requirements).toEqual([]);
	});

	test('a candidate carries a parsed prize + company weight from its text', async () => {
		stubTavily([{ url: 'https://gcp-mlb.devfolio.co', title: 'Google Cloud x MLB Hackathon', content: 'Total prizes: $98,700. Overall Grand Prize: $40,200 cash.' }]);
		const c = (await run(adapter())).candidates[0]!;
		expect(c.prizeUsd).toBe(98_700); // largest figure wins
		expect(c.companyWeight).toBeGreaterThanOrEqual(3); // Google
	});

	test('platform-only results empty → throws a clear, named reason (visible gap)', async () => {
		stubTavily([]);
		await expect(run(adapter())).rejects.toThrow('no open events on the other platforms');
	});
});

describe('backup mode — Devpost API unavailable, Tavily takes over Devpost (unverified)', () => {
	test('devpostBackup is read at sweep time: devpost.com joins include_domains, plus the sponsor sweep', async () => {
		let devpostDown = false;
		const lazy = adapter({ devpostBackup: () => devpostDown });
		devpostDown = true; // flipped AFTER construction — as the Devpost adapter does mid-sweep
		const calls = stubTavily([{ url: 'https://amazonappdev2026.devpost.com/', title: 'Amazon Developer Hackathon', content: 'Build across Amazon devices.' }]);
		await run(lazy);
		for (const call of calls) expect(call.includeDomains).toContain('devpost.com');
		expect(calls.some((c) => /nebius/i.test(c.query) && /paypal/i.test(c.query))).toBe(true);
	});

	test('keeps Devpost hits but labels each "open status unverified", with a cleaned title', async () => {
		stubTavily([
			{ url: 'https://amazonappdev2026.devpost.com/', title: 'Build, Ship, Shape: Amazon Developer Hackathon: Build across Amazon Devices and shape what is next. - Devpost', content: 'Build across Amazon devices.' },
			{ url: 'https://naija-hack.devfolio.co', title: 'Naija Hack', content: 'An open Devfolio event.' },
		]);
		const batch = await run(backupAdapter());
		const amazon = batch.candidates.find((c) => c.url.includes('amazonappdev2026'))!;
		expect(amazon.summary.startsWith(UNVERIFIED_OPEN_LABEL)).toBe(true);
		expect(amazon.title).toBe('Build, Ship, Shape: Amazon Developer Hackathon');
		// Non-Devpost hits are not mislabelled.
		const devfolio = batch.candidates.find((c) => c.url.includes('devfolio'))!;
		expect(devfolio.summary).not.toContain(UNVERIFIED_OPEN_LABEL);
	});

	test('still drops help-center / category / homepage / listing noise', async () => {
		stubTavily([
			{ url: 'https://help.devpost.com/hc/en-us/articles/123', title: 'How do I set up the Submission Period?', content: 'docs' },
			{ url: 'https://help.hackerearth.com/registering', title: 'Registering for a hackathon', content: 'docs' },
			{ url: 'https://devpost.com/c/artificial-intelligence', title: 'AI hackathons category', content: 'listing' },
			{ url: 'https://devpost.com/', title: 'Devpost - The home for hackathons', content: 'homepage' },
			{ url: 'https://devpost.com/hackathons', title: 'New & upcoming hackathons', content: 'listing' },
			{ url: 'https://mlh.io', title: 'MLH', content: 'homepage' },
			{ url: 'https://uncommon-hacks-2026.devpost.com', title: 'Uncommon Hacks 2026', content: 'A real contest.' },
		]);
		const urls = (await run(backupAdapter())).candidates.map((c) => c.url);
		expect(urls).toEqual(['https://uncommon-hacks-2026.devpost.com']);
	});

	test('keeps the event on its contest subdomain; drops the platform listing and submission pages', async () => {
		stubTavily([
			{ url: 'https://devpost.com/hackathons', title: 'Listing', content: 'listing' },
			{ url: 'https://cool-2026.devpost.com/', title: 'Cool 2026', content: 'The event itself, on its own subdomain.' },
			{ url: 'https://cool-2026.devpost.com/software/my-entry', title: 'Cool 2026 entry', content: 'One team’s submission page.' },
		]);
		const urls = (await run(backupAdapter())).candidates.map((c) => c.url);
		expect(urls).toContain('https://cool-2026.devpost.com/');
		// A submission page under the event is not the event.
		expect(urls).not.toContain('https://cool-2026.devpost.com/software/my-entry');
		expect(urls).not.toContain('https://devpost.com/hackathons');
	});

	test('drops an event whose own text says it ended', async () => {
		stubTavily([
			{ url: 'https://ended-2025.devpost.com', title: 'Ended Jam 2025', content: 'This hackathon has ended' },
			{ url: 'https://open-2026.devpost.com', title: 'Open Jam 2026', content: 'Accepting submissions' },
		]);
		const urls = (await run(backupAdapter())).candidates.map((c) => c.url);
		expect(urls).toContain('https://open-2026.devpost.com');
		expect(urls).not.toContain('https://ended-2025.devpost.com');
	});

	test('empty backup search → throws, naming that Devpost was also down', async () => {
		stubTavily([]);
		await expect(run(backupAdapter())).rejects.toThrow('Devpost API was also unavailable');
	});
});

describe('shared invariants', () => {
	test('no Tavily key → throws (visible hard gap, never a silent empty)', async () => {
		stubTavily([{ url: 'https://x.devfolio.co', title: 'X', content: 'x' }]);
		await expect(createTavilyDiscoveryAdapter({}).fetchCandidates({ projectId: 'p1' })).rejects.toThrow();
	});

	test('dedupes repeated urls, and canonical variants of one event', async () => {
		stubTavily([
			{ url: 'https://dup.devfolio.co', title: 'Dup A', content: 'x' },
			{ url: 'https://dup.devfolio.co', title: 'Dup B', content: 'y' },
			{ url: 'https://dup-event.devfolio.co/?utm_source=newsletter', title: 'Dup Event', content: 'a' },
			{ url: 'https://dup-event.devfolio.co/', title: 'Dup Event', content: 'b' },
		]);
		const urls = (await run(adapter())).candidates.map((c) => c.url);
		expect(urls.filter((u) => u === 'https://dup.devfolio.co')).toHaveLength(1);
		expect(urls.filter((u) => u.includes('dup-event.devfolio.co'))).toHaveLength(1);
	});

	test('runs one search per query and UNIONs their hits (breadth), deduping across queries', async () => {
		const shared = { url: 'https://shared-2026.devfolio.co', title: 'Shared', content: 'x' };
		const calls = stubTavily({
			'accepting registrations': [{ url: 'https://generic-event.devfolio.co', title: 'Generic', content: 'x' }, shared],
			'ai agents': [{ url: 'https://dorahacks.io/hackathon/ai-agents-2026', title: 'AI Agents', content: 'y' }, shared],
			'open to NG': [{ url: 'https://naija-hack.devfolio.co', title: 'Naija Hack', content: 'z' }],
		});
		const urls = (await run(adapter({ terms: ['ai agents'], country: 'NG' }))).candidates.map((c) => c.url);
		expect(calls).toHaveLength(3);
		for (const expected of ['https://generic-event.devfolio.co', 'https://dorahacks.io/hackathon/ai-agents-2026', 'https://naija-hack.devfolio.co']) {
			expect(urls).toContain(expected);
		}
		expect(urls.filter((u) => u === shared.url)).toHaveLength(1);
	});
});

describe('buildDiscoveryQueries (profile-aware query set)', () => {
	test('no terms, no country → exactly the generic sweep', () => {
		expect(buildDiscoveryQueries()).toEqual(['open hackathon accepting registrations and submissions']);
	});

	test('sponsorSweep (backup mode only) appends the big-sponsor query', () => {
		const qs = buildDiscoveryQueries({ sponsorSweep: true });
		expect(qs[0]).toBe('open hackathon accepting registrations and submissions');
		expect(qs.some((q) => /nebius/i.test(q) && /paypal/i.test(q))).toBe(true);
		expect(qs).toHaveLength(2);
	});

	test('interests/skills add topic queries ALONGSIDE the generic sweep', () => {
		const qs = buildDiscoveryQueries({ terms: ['ai agents', 'typescript'], country: null });
		expect(qs[0]).toBe('open hackathon accepting registrations and submissions');
		expect(qs.some((q) => q.includes('ai agents'))).toBe(true);
		expect(qs.some((q) => q.includes('typescript'))).toBe(true);
	});

	test('country adds one locality query', () => {
		expect(buildDiscoveryQueries({ country: 'NG' }).some((q) => q.includes('NG'))).toBe(true);
	});

	test('query set is deduped and capped at 6, with a 2-char term floor', () => {
		const qs = buildDiscoveryQueries({ terms: ['a', 'ai', 'ml', 'web', 'blockchain', 'fintech', 'games'], country: 'NG', sponsorSweep: true });
		expect(qs.length).toBeLessThanOrEqual(6);
		expect(new Set(qs).size).toBe(qs.length);
		expect(qs.some((q) => q === 'a hackathon online open registration')).toBe(false);
	});
});
