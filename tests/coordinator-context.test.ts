import { describe, test, expect } from 'bun:test';
import { afterEach, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { actorContext, discoverForActor } from '../apps/app/src/server/coordinator-context.ts';
import { createWorkspace, createProject, createPlanDocRevision } from '../apps/app/src/server/projects.ts';
import { upsertProfile } from '../apps/app/src/server/profiles.ts';
import { addMemoryFact, proposeMemoryFact, retractMemoryFact } from '../apps/app/src/server/memory.ts';
import { recordPlanDecision } from '../apps/app/src/server/planning.ts';
import { createLocalSeedAdapter, listCandidates, runDiscoveryFeed, saveCandidate, seedCandidates } from '../apps/app/src/server/discovery.ts';
import { registerSource, captureSnapshot } from '../apps/app/src/server/evidence/sources.ts';
import { addClaim } from '../apps/app/src/server/evidence/claims.ts';

// These are offline unit tests: the live Devpost primary adapter must never
// reach the network here. Every outbound fetch answers 503, so the Devpost
// source records a visible gap and the stored catalog drives the assertions.
const realFetch = globalThis.fetch;
beforeEach(() => {
	globalThis.fetch = (async () => new Response('offline in unit tests', { status: 503 })) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** LOCAL VERIFIED: actual production services + migrations over SQLite.
 * No model, provider, live event refresh or remote sandbox is involved. */
async function world() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys=ON');
	for (const name of ['0001_product.sql', '0004_evidence.sql', '0008_profile.sql', '0009_discovery.sql', '0011_home_project.sql', '0013_discovery_saved.sql', '0015_plan_decisions.sql', '0017_profile_preferences.sql']) {
		sqlite.exec(readFileSync(new URL(`../apps/app/migrations/${name}`, import.meta.url), 'utf8'));
	}
	const db = {
		prepare(sql: string) {
			const stmt = sqlite.prepare(sql);
			return { bind(...args: never[]) { return {
				async all() { return { results: stmt.all(...args) }; },
				async run() { return stmt.run(...args); },
			}; } };
		},
		async batch(statements: { run(): unknown }[]) { return Promise.all(statements.map((stmt) => stmt.run())); },
	} as unknown as D1Database;
	for (const user of ['alice', 'bob']) sqlite.prepare('insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)')
		.run(user, user, `${user}@example.com`, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
	const workspace = await createWorkspace(db, 'alice', { name: 'Alice workspace' });
	const project = await createProject(db, { actorId: 'alice', workspaceId: workspace.id }, { workspaceId: workspace.id, name: 'Todo', description: 'A beautiful minimal todo app with saved tasks' });
	const scope: Scope = { actorId: 'alice', workspaceId: workspace.id, projectId: project.id };
	return { db, sqlite, scope };
}

async function quotedRule(db: D1Database, scope: Scope, url: string, claimType: string, value: string, authority = 'binding_rules') {
	const source = await registerSource(db, scope, { url, kind: 'page', authority });
	const quote = `${claimType}: ${value}`;
	const { snapshot } = await captureSnapshot(db, scope, source.id, { content: quote, mediaType: 'text/plain' });
	return addClaim(db, scope, { snapshotId: snapshot.id, claimType, value, quote, extractionVersion: 'context-test' });
}

describe('coordinator actor context', () => {
	test('uses saved profile, confirmed current memory, original brief and exact plan feedback', async () => {
		const { db, sqlite, scope } = await world();
		try {
			await upsertProfile(db, 'alice', { country: 'NG', weeklyHours: 8, skills: ['Design'], freeTextInterests: ['Education'], formatPreference: 'online', budget: { mode: 'free_only' } });
			await upsertProfile(db, 'bob', { freeTextInterests: ['Bob private interest'] });
			await addMemoryFact(db, 'alice', { kind: 'preference', content: 'I like calm interfaces' });
			await addMemoryFact(db, 'bob', { kind: 'fact', content: 'Bob private memory' });
			await proposeMemoryFact(db, 'alice', { kind: 'fact', content: 'Unconfirmed inference', sourceRunId: 'run-test' });
			await addMemoryFact(db, 'alice', { kind: 'fact', content: 'api_key=do-not-inject-this' });
			const deleted = await addMemoryFact(db, 'alice', { kind: 'fact', content: 'Deleted memory' });
			await retractMemoryFact(db, 'alice', deleted.id);
			const plan = await createPlanDocRevision(db, scope, { kind: 'prd', body: '# Todo plan\nUse saved tasks' });
			await recordPlanDecision(db, scope, { planRevisionId: plan.id, decision: 'changes', note: 'Please add keyboard shortcuts' });
			const { text } = await actorContext(db, scope);
			for (const expected of ['NG', 'Design', 'Education', 'calm interfaces', 'beautiful minimal todo', 'keyboard shortcuts', plan.id, 'never authorizes spending']) expect(text).toContain(expected);
			for (const hidden of ['Bob private', 'Unconfirmed inference', 'Deleted memory', 'do-not-inject-this']) expect(text).not.toContain(hidden);
			const second = await addMemoryFact(db, 'alice', { kind: 'fact', content: 'New fact' });
			expect((await actorContext(db, scope)).text).toContain('New fact');
			await retractMemoryFact(db, 'alice', second.id);
			expect((await actorContext(db, scope)).text).not.toContain('New fact');
		} finally { sqlite.close(); }
	});

	test('denies forged membership and bounds prompt data without breaking JSON', async () => {
		const { db, sqlite, scope } = await world();
		try {
			await expect(actorContext(db, { ...scope, actorId: 'bob' })).rejects.toThrow('membership');
			for (let i = 0; i < 30; i++) await addMemoryFact(db, 'alice', { kind: 'fact', content: `${i}: ${'"\\'.repeat(900)}` });
			await createPlanDocRevision(db, scope, { kind: 'kernel', body: '\\'.repeat(8000) });
			const result = await actorContext(db, scope);
			expect(result.text.length).toBeLessThanOrEqual(18000);
			expect(() => JSON.parse(result.text.slice(result.text.indexOf('\n') + 1))).not.toThrow();
		} finally { sqlite.close(); }
	});
});

describe('actor discovery', () => {
	test('ranks stored events by profile with honest unknown eligibility and source-specific rules', async () => {
		const { db, sqlite, scope } = await world();
		try {
			await upsertProfile(db, 'alice', { country: 'NG', formatPreference: 'online', freeTextInterests: ['Education'] });
			await seedCandidates(db, [
				{ source: 'catalog', url: 'https://events.example/education', title: 'Education builders', summary: 'Build education tools' },
				{ source: 'catalog', url: 'https://events.example/design', title: 'Design challenge', summary: 'Create a design app' },
				{ source: 'catalog', url: 'https://events.example/travel', title: 'Education campus', summary: 'Meet in person' },
			]);
			await quotedRule(db, scope, 'https://events.example/design/rules', 'eligibility.open_countries', 'US');
			await quotedRule(db, scope, 'https://events.example/travel/rules', 'event.format', 'in_person');
			const result = await discoverForActor(db, scope);
			expect(result.source).toBe('live-web+catalog');
			expect(result.liveWebSearch).toBe(true);
			expect(result.profileCountry).toBe('NG');
			expect(result.candidates.map((candidate) => candidate.title)).toEqual(['Education builders', 'Design challenge']);
			expect(result.candidates[0]?.interestMatches).toEqual(['education']);
			expect(result.candidates[0]?.eligibility.verdict).toBe('unknown');
			expect(result.candidates[1]?.eligibility.verdict).toBe('ineligible');
			expect(result.gaps.join(' ')).toContain('open-contests API');
			// The (stubbed-offline) Devpost primary is a visible named gap, never silent.
			expect(result.gaps.some((gap) => gap.startsWith('devpost:'))).toBe(true);
			expect(result.gaps.join(' ')).toContain('Solo participation');
		} finally { sqlite.close(); }
	});

	test('unverified claims and another event query cannot establish eligibility; short interests match complete words', async () => {
		const { db, sqlite, scope } = await world();
		try {
			await upsertProfile(db, 'alice', { country: 'NG', freeTextInterests: ['AI'] });
			await seedCandidates(db, [
				{ source: 'catalog', url: 'https://events.example/?event=a', title: 'AI challenge', summary: 'Build AI tools' },
				{ source: 'catalog', url: 'https://email.example/', title: 'Email challenge', summary: 'Build email tools' },
			]);
			await quotedRule(db, scope, 'https://events.example/?event=b', 'eligibility.open_countries', 'US');
			await quotedRule(db, scope, 'https://events.example/?event=a', 'eligibility.open_countries', 'US', 'community');
			const result = await discoverForActor(db, scope);
			expect(result.candidates[0]?.title).toBe('AI challenge');
			expect(result.candidates[0]?.interestMatches).toEqual(['ai']);
			expect(result.candidates[0]?.eligibility.verdict).toBe('unknown');
			expect(result.candidates[1]?.interestMatches).toEqual([]);
		} finally { sqlite.close(); }
	});

	test('never invents an event for an empty catalog and rejects caller identity injection', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const empty = await discoverForActor(db, scope);
			expect(empty.candidates).toEqual([]);
			expect(empty.gaps.join(' ')).toContain('does not mean no suitable hackathons exist');
			await expect(discoverForActor(db, { ...scope, actorId: 'bob' })).rejects.toThrow('membership');
			await expect(discoverForActor(db, scope, { actorId: 'bob' } as never)).rejects.toThrow('invalid discovery');
			await expect(discoverForActor(db, scope, { limit: 51 })).rejects.toThrow('invalid discovery');
		} finally { sqlite.close(); }
	});

	test('the stored catalog (Discover page load) drops junk web rows, ended events and mirrors, and carries saved', async () => {
		const { db, sqlite, scope } = await world();
		try {
			await upsertProfile(db, 'alice', { country: 'NG' });
			const today = new Date();
			const year = today.getUTCFullYear();
			await seedCandidates(db, [
				{ source: 'tavily', url: 'https://dorahacks.io/hackathon/ai-eduhack-season-2', title: 'AI EduHack', summary: 'Open for AI in education.' },
				{ source: 'tavily', url: 'https://dorahacks.io/buidl/30609/milestones', title: 'SafePhone NG | Buidls', summary: 'A project page.' },
				{ source: 'tavily', url: 'https://mlh.io/seasons/2026/events', title: '2026 Season Schedule // Major League Hacking', summary: 'Schedule.' },
				{ source: 'tavily', url: 'https://www.hackerearth.com/challenges/hackathon/frontier-2026', title: 'Frontier Challenge', summary: 'Open.' },
				{ source: 'tavily', url: 'https://www.hackerearth.com/community/challenges/hackathon/frontier-2026', title: 'Frontier Challenge', summary: 'Open.' },
				{ source: 'devpost', url: 'https://ended.devpost.com/', title: 'Ended Jam', summary: `By ACME · Jan 05 - Feb 01, ${year - 1} · 300 registered · Online` },
				{ source: 'devpost', url: 'https://live.devpost.com/', title: 'Live Jam', summary: `By ACME · Jan 05 - Dec 30, ${year + 1} · 300 registered · Online` },
			]);
			// Store them under their real source ids, as earlier live sweeps would have.
			await runDiscoveryFeed(db, scope, { adapters: [createLocalSeedAdapter(db, 'tavily'), createLocalSeedAdapter(db, 'devpost')] });
			const stored = await listCandidates(db, scope);
			const live = stored.find((candidate) => candidate.url === 'https://live.devpost.com/')!;
			await saveCandidate(db, scope, live.id);
			const result = await discoverForActor(db, scope, { refresh: false, limit: 50 }, { inspect: false });
			const urls = result.candidates.map((candidate) => candidate.url);
			expect(urls).toContain('https://dorahacks.io/hackathon/ai-eduhack-season-2');
			expect(urls).toContain('https://live.devpost.com/');
			expect(urls.filter((url) => url.includes('frontier-2026'))).toHaveLength(1);
			for (const dropped of ['https://dorahacks.io/buidl/30609/milestones', 'https://mlh.io/seasons/2026/events', 'https://ended.devpost.com/']) {
				expect(urls).not.toContain(dropped);
			}
			expect(result.candidates.find((candidate) => candidate.url === 'https://live.devpost.com/')?.saved).toBe(true);
			// No paid inspection on a page load, and no gap claiming it failed.
			expect(result.gaps.join(' ')).not.toContain('AI fit inspection');
		} finally { sqlite.close(); }
	});
});

describe('actor discovery — Devpost API as the primary list (Stage 2)', () => {
	const PAGES: Record<number, unknown> = {
		1: JSON.parse(readFileSync(new URL('./fixtures/devpost/open-page1.json', import.meta.url), 'utf8')),
		2: JSON.parse(readFileSync(new URL('./fixtures/devpost/open-page2.json', import.meta.url), 'utf8')),
	};
	/** Serve the saved real Devpost snapshot; everything else stays offline (503). */
	function serveDevpostFixture(): void {
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());
			if (url.hostname === 'devpost.com' && url.pathname === '/api/hackathons') {
				const body = PAGES[Number(url.searchParams.get('page') ?? '1')] ?? { hackathons: [], meta: { total_count: 46 } };
				return new Response(JSON.stringify(body), { status: 200 });
			}
			return new Response('offline in unit tests', { status: 503 });
		}) as unknown as typeof fetch;
	}

	test('a profile search is never empty while open contests exist, and big-sponsor AI events lead', async () => {
		const { db, sqlite, scope } = await world();
		try {
			serveDevpostFixture();
			await upsertProfile(db, 'alice', { country: 'NG', formatPreference: 'online', freeTextInterests: ['AI', 'Education'] });
			const result = await discoverForActor(db, scope, { limit: 10 });
			expect(result.candidates).toHaveLength(10);
			// Every card is a real Devpost contest page, not a help/listing page.
			for (const candidate of result.candidates) expect(new URL(candidate.url).hostname.endsWith('devpost.com')).toBe(true);
			// Online-preferring builder: no in-person venue events.
			for (const candidate of result.candidates) expect(candidate.format).not.toBe('in_person');
			// The old caddie's ladder: interests, then major organisers, then reach.
			const top3 = result.candidates.slice(0, 3).map((c) => c.title).join(' | ');
			expect(top3).toContain('Amazon Developer Hackathon');
			expect(top3).toContain('Nebius x NVIDIA');
			expect(top3).toContain('PayPal AI Hackathon');
			// Composed summaries, never scraped page chrome.
			for (const candidate of result.candidates) expect(candidate.summary).not.toMatch(/Devpost for Teams|\|\|\||<span/);
			expect(result.gaps.some((gap) => gap.startsWith('devpost:'))).toBe(false);
		} finally { sqlite.close(); }
	});

	test('chat filler words are not "interests"; a first-timer request adds the beginner signal', async () => {
		const { db, sqlite, scope } = await world();
		try {
			serveDevpostFixture();
			await upsertProfile(db, 'alice', { country: 'NG', formatPreference: 'online', freeTextInterests: ['AI'] });
			const result = await discoverForActor(db, scope, { query: 'Help me find my first hackathon on Devpost that fits what I like building', limit: 10 });
			const matched = new Set(result.candidates.flatMap((c) => c.interestMatches));
			for (const filler of ['help', 'find', 'hackathon', 'devpost', 'first', 'building', 'like']) expect(matched.has(filler)).toBe(false);
			expect(matched.has('ai')).toBe(true);
			// Devpost's own "Beginner Friendly" theme now counts for a first-timer.
			expect(matched.has('beginner')).toBe(true);
		} finally { sqlite.close(); }
	});

	test('rows stored by an earlier sweep never resurface (no ended/noisy leftovers)', async () => {
		const { db, sqlite, scope } = await world();
		try {
			// An older sweep stored a long-ended contest from web search.
			await runDiscoveryFeed(db, scope, {
				adapters: [{
					id: 'tavily',
					fetchCandidates: async () => ({ candidates: [{ url: 'https://covidathon.devpost.com/', title: 'COVIDathon', summary: 'Decentralized AI hackathon (2020).' }] }),
				}],
			});
			serveDevpostFixture();
			await upsertProfile(db, 'alice', { country: 'NG', freeTextInterests: ['AI'] });
			const result = await discoverForActor(db, scope, { limit: 20 });
			expect(result.candidates.length).toBeGreaterThan(0);
			expect(result.candidates.map((c) => c.title)).not.toContain('COVIDathon');
		} finally { sqlite.close(); }
	});

	test('one event, one card: a URL from several sources collapses to the Devpost row', async () => {
		const { db, sqlite, scope } = await world();
		try {
			serveDevpostFixture();
			await seedCandidates(db, [
				{ source: 'catalog', url: 'https://amazonappdev2026.devpost.com/', title: 'Amazon (stale catalog copy)', summary: 'old text' },
			]);
			const result = await discoverForActor(db, scope, { limit: 20 });
			const amazon = result.candidates.filter((c) => c.url.includes('amazonappdev2026'));
			expect(amazon).toHaveLength(1);
			expect(amazon[0]!.title).toBe('Build, Ship, Shape: Amazon Developer Hackathon');
		} finally { sqlite.close(); }
	});
});

describe('actor discovery — Tavily for other platforms and as Devpost backup (Stage 3)', () => {
	const PAGES: Record<number, unknown> = {
		1: JSON.parse(readFileSync(new URL('./fixtures/devpost/open-page1.json', import.meta.url), 'utf8')),
		2: JSON.parse(readFileSync(new URL('./fixtures/devpost/open-page2.json', import.meta.url), 'utf8')),
	};
	const TAVILY_HITS = [
		// Tavily's own copy of a Devpost event (duplicate of the API's Amazon row).
		{ url: 'https://amazonappdev2026.devpost.com/', title: 'Build, Ship, Shape: Amazon Developer Hackathon: Build across Amazon Devices and shape what is next. - Devpost', content: 'Devpost for Teams Devpost for Teams Access your company' },
		// A genuine other-platform event only web search can find.
		{ url: 'https://naija-ai-hack.devfolio.co/', title: 'Naija AI Hack', content: 'An open AI hackathon on Devfolio for African builders: $50,000 in prizes, 12,000 registered, online.' },
	];

	/** Route the Devpost API (up or down) and Tavily search; record Tavily domains. */
	function serve(devpostUp: boolean, tavilyDomains: string[][]): void {
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());
			if (url.hostname === 'devpost.com' && url.pathname === '/api/hackathons') {
				if (!devpostUp) return new Response('down', { status: 503 });
				const body = PAGES[Number(url.searchParams.get('page') ?? '1')] ?? { hackathons: [], meta: { total_count: 46 } };
				return new Response(JSON.stringify(body), { status: 200 });
			}
			if (url.hostname === 'api.tavily.com' && url.pathname === '/extract') {
				return new Response(JSON.stringify({ results: [] }), { status: 200 }); // rules pages: none readable here
			}
			if (url.hostname === 'api.tavily.com') {
				const body = JSON.parse(String(init?.body ?? '{}')) as { include_domains?: string[] };
				tavilyDomains.push(body.include_domains ?? []);
				return new Response(JSON.stringify({ results: TAVILY_HITS }), { status: 200 });
			}
			return new Response('offline in unit tests', { status: 503 });
		}) as unknown as typeof fetch;
	}

	test('Devpost API up: Tavily adds other platforms, and its Devpost copies never reach a card', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const domains: string[][] = [];
			serve(true, domains);
			await upsertProfile(db, 'alice', { country: 'NG', formatPreference: 'online', freeTextInterests: ['AI'] });
			const result = await discoverForActor(db, scope, { limit: 20 }, { tavilyApiKey: 'test-key' });
			expect(domains.length).toBeGreaterThan(0);
			for (const call of domains) expect(call).not.toContain('devpost.com');
			const titles = result.candidates.map((c) => c.title);
			expect(titles).toContain('Naija AI Hack');
			const amazon = result.candidates.filter((c) => c.url.includes('amazonappdev2026'));
			expect(amazon).toHaveLength(1);
			expect(amazon[0]!.summary).toContain('By Amazon'); // the API row, not Tavily's page soup
			expect(result.gaps.join(' ')).not.toContain('unverified');
		} finally { sqlite.close(); }
	});

	test('Devpost API down: Tavily backup keeps the search non-empty, labelled unverified, with a visible gap', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const domains: string[][] = [];
			serve(false, domains);
			await upsertProfile(db, 'alice', { country: 'NG', freeTextInterests: ['AI'] });
			const result = await discoverForActor(db, scope, { limit: 20 }, { tavilyApiKey: 'test-key' });
			for (const call of domains) expect(call).toContain('devpost.com');
			expect(result.candidates.length).toBeGreaterThan(0);
			const amazon = result.candidates.find((c) => c.url.includes('amazonappdev2026'))!;
			expect(amazon.summary.startsWith('Open status unverified')).toBe(true);
			expect(amazon.title).toBe('Build, Ship, Shape: Amazon Developer Hackathon');
			expect(result.gaps.some((g) => g.startsWith('devpost:'))).toBe(true);
			expect(result.gaps.join(' ')).toContain('open status, dates and prizes are unverified');
		} finally { sqlite.close(); }
	});
});

describe('hackathon_details — follow-ups read the stored, checked detail', () => {
	test('matchCandidateByTitle tolerates loose/typo titles and refuses a non-match', async () => {
		const { matchCandidateByTitle } = await import('../apps/app/src/server/coordinator-context.ts');
		const pool = [
			{ id: 'a', title: 'Nebius x NVIDIA Global AI Hackathon' },
			{ id: 'b', title: 'PayPal AI Hackathon' },
			{ id: 'c', title: 'Meta VR Start Developer Competition 2026' },
		];
		expect(matchCandidateByTitle(pool, 'the nebious x nvidia global ai hackathon')?.id).toBe('a');
		expect(matchCandidateByTitle(pool, 'paypal')?.id).toBe('b');
		expect(matchCandidateByTitle(pool, 'Meta VR')?.id).toBe('c');
		expect(matchCandidateByTitle(pool, 'Google Solution Challenge')).toBeNull();
		expect(matchCandidateByTitle(pool, 'the hackathon')).toBeNull();
	});

	test('returns the CHECKED verdict with its quoted rule, by title or id; unknown events are reported, not guessed', async () => {
		const { hackathonDetailsForActor } = await import('../apps/app/src/server/coordinator-context.ts');
		const { db, sqlite, scope } = await world();
		try {
			sqlite.exec(readFileSync(new URL('../apps/app/migrations/0020_discovery_digest_cache.sql', import.meta.url), 'utf8'));
			await upsertProfile(db, 'alice', { country: 'NG' });
			await seedCandidates(db, [
				{ source: 'catalog', url: 'https://events.example/design', title: 'Design challenge', summary: 'Create a design app' },
				{ source: 'catalog', url: 'https://events.example/education', title: 'Education builders', summary: 'Build education tools' },
			]);
			await quotedRule(db, scope, 'https://events.example/design/rules', 'eligibility.open_countries', 'US');
			await discoverForActor(db, scope); // ingests the catalog into this project, as find_hackathons does

			const byTitle = (await hackathonDetailsForActor(db, scope, { title: 'design chalenge' })) as Record<string, any>;
			expect(byTitle.found).toBe(true);
			expect(byTitle.title).toBe('Design challenge');
			expect(byTitle.url).toBe('https://events.example/design');
			expect(byTitle.eligibility.verdict).toBe('ineligible');
			expect(byTitle.eligibility.rulesRead).toBe(true);
			expect(byTitle.eligibility.rules.some((r: { quote: string }) => r.quote.includes('eligibility.open_countries: US'))).toBe(true);
			expect(byTitle.eligibility.note).toContain('CHECKED verdict');
			// No model key in this test: the digest is honestly absent, with its gap.
			expect(byTitle.digest).toBeNull();
			expect(String(byTitle.digestGap)).toContain('not configured');

			const byId = (await hackathonDetailsForActor(db, scope, { id: byTitle.id })) as Record<string, any>;
			expect(byId.found).toBe(true);
			expect(byId.eligibility.verdict).toBe('ineligible');

			const unread = (await hackathonDetailsForActor(db, scope, { title: 'Education builders' })) as Record<string, any>;
			expect(unread.eligibility.rulesRead).toBe(false);
			expect(unread.eligibility.note).toContain('not been read');

			const missing = (await hackathonDetailsForActor(db, scope, { title: 'Google Solution Challenge' })) as Record<string, any>;
			expect(missing.found).toBe(false);
			expect(String(missing.gap)).toContain('No stored hackathon');

			await expect(hackathonDetailsForActor(db, scope, {})).rejects.toThrow('needs an id or a title');
			await expect(hackathonDetailsForActor(db, { ...scope, actorId: 'bob' }, { title: 'Design' })).rejects.toThrow('membership');
		} finally { sqlite.close(); }
	});
});

describe('find_hackathons does not wait for the digest pre-warm', () => {
	test('runBounded keeps at most `limit` jobs in flight and swallows failures', async () => {
		const { runBounded } = await import('../apps/app/src/server/coordinator-context.ts');
		let inFlight = 0;
		let peak = 0;
		const job = (fail: boolean) => async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
			if (fail) throw new Error('boom');
		};
		const ok = await runBounded([job(false), job(true), job(false), job(false), job(true)], 2);
		expect(peak).toBe(2);
		expect(ok).toBe(3);
		expect(await runBounded([], 2)).toBe(0);
	});

	test('the search resolves while every digest call is still hanging; the pre-warm finishes later in the background', async () => {
		const { db, sqlite, scope } = await world();
		try {
			sqlite.exec(readFileSync(new URL('../apps/app/migrations/0020_discovery_digest_cache.sql', import.meta.url), 'utf8'));
			await upsertProfile(db, 'alice', { country: 'NG', formatPreference: 'online', freeTextInterests: ['AI'] });
			await seedCandidates(db, [
				{ source: 'catalog', url: 'https://events.example/ai-one', title: 'AI builders one', summary: 'Build AI tools online' },
				{ source: 'catalog', url: 'https://events.example/ai-two', title: 'AI builders two', summary: 'Build AI agents online' },
				{ source: 'catalog', url: 'https://events.example/ai-three', title: 'AI builders three', summary: 'Build AI apps online' },
			]);

			// Digest calls (the pre-warm) hang until released; every other model
			// call (fit inspection) answers at once. Track digest concurrency.
			let releaseDigests!: () => void;
			const digestsReleased = new Promise<void>((resolve) => { releaseDigests = resolve; });
			let digestInFlight = 0;
			let digestPeak = 0;
			let digestStarted = 0;
			globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(typeof input === 'string' ? input : input.toString());
				if (url.hostname === 'api.tavily.com') return new Response(JSON.stringify({ results: [] }), { status: 200 });
				if (url.pathname.endsWith('/chat/completions')) {
					const isDigest = String(init?.body ?? '').includes('digest of ONE hackathon');
					if (!isDigest) return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }), { status: 200 });
					digestStarted += 1;
					digestInFlight += 1;
					digestPeak = Math.max(digestPeak, digestInFlight);
					await digestsReleased;
					digestInFlight -= 1;
					return new Response(JSON.stringify({ choices: [{ message: { content: '{"headline":"Warm.","bullets":["A → b"]}' } }] }), { status: 200 });
				}
				return new Response('offline in unit tests', { status: 503 });
			}) as unknown as typeof fetch;

			const background: Promise<unknown>[] = [];
			const result = await discoverForActor(db, scope, { limit: 8 }, {
				tavilyApiKey: 'test-key',
				nebiusApiKey: 'model-key',
				background: (task) => { background.push(task); },
			});
			// Returned with the digests still blocked: the card never waited for them.
			expect(result.candidates.length).toBeGreaterThan(0);
			expect(background).toHaveLength(1);
			// The background jobs reach their (blocked) model call shortly after.
			for (let i = 0; i < 200 && digestInFlight < Math.min(2, result.candidates.length); i++) await new Promise((r) => setTimeout(r, 5));
			expect(digestStarted).toBeGreaterThan(0);
			expect(digestInFlight).toBeGreaterThan(0);

			releaseDigests();
			await Promise.all(background);
			expect(digestInFlight).toBe(0);
			expect(digestPeak).toBeLessThanOrEqual(2);
			expect(digestStarted).toBe(Math.min(5, result.candidates.length));
		} finally { sqlite.close(); }
	});
});
