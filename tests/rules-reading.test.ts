import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { discoverForActor } from '../apps/app/src/server/coordinator-context.ts';
import { evaluateEligibility } from '../apps/app/src/server/eligibility.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { upsertProfile } from '../apps/app/src/server/profiles.ts';
import { listClaims } from '../apps/app/src/server/evidence/claims.ts';
import { listSnapshots, listSources } from '../apps/app/src/server/evidence/sources.ts';
import {
	eligibilityExcerpt,
	locateVerbatim,
	overviewUrlFor,
	readRulesForCandidates,
	RULES_EXTRACTION_VERSION,
	rulesUrlFor,
} from '../apps/app/src/server/rules-reading.ts';

/**
 * Stage 4 — Tavily reads the rules pages; the model proposes eligibility
 * claims; only quotes found VERBATIM in the stored snapshot become claims.
 *
 * LOCAL VERIFIED (unit + service level over the real migrations in SQLite):
 * Tavily /extract and the Nebius chat endpoint are STUBBED. The Amazon rules
 * text is a verbatim excerpt of the real page (fetched 2026-10-13); the
 * US-only page is a clearly-marked SYNTHETIC fixture for the ineligible path.
 * Model behaviour is simulated — these tests prove the pipeline's guards, not
 * the model's extraction quality (that is Stage 6's live check).
 */

const AMAZON_RULES = readFileSync(new URL('./fixtures/devpost/amazon-rules.md', import.meta.url), 'utf8');
const US_ONLY_RULES = readFileSync(new URL('./fixtures/devpost/us-only-rules.md', import.meta.url), 'utf8');
const PAGES: Record<number, { hackathons: { title: string; url: string }[] }> = {
	1: JSON.parse(readFileSync(new URL('./fixtures/devpost/open-page1.json', import.meta.url), 'utf8')),
	2: JSON.parse(readFileSync(new URL('./fixtures/devpost/open-page2.json', import.meta.url), 'utf8')),
};
const AMAZON_URL = 'https://amazonappdev2026.devpost.com/';
const PAYPAL_URL = PAGES[1]!.hackathons.find((h) => h.title === 'PayPal AI Hackathon')!.url;

/** Synthetic overview-page prose (the main detail page the digest reads). It is
 * NOT a rules page and must never yield eligibility claims — only digest input. */
const OVERVIEW_PROSE = (title: string): string =>
	`# ${title}\n\nBuild something great this season. ${title} invites developers worldwide to ship ` +
	'an AI-powered project over a few focused weeks, with mentorship, workshops, and prizes for the ' +
	'strongest submissions. Themes span education, developer tooling, and applied machine learning. ' +
	'Solo builders and small teams are both welcome, and judging weighs originality, execution, and impact.';

// --- the world: real migrations over in-memory SQLite ------------------------

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
	sqlite.prepare('insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)')
		.run('alice', 'alice', 'alice@example.com', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
	const workspace = await createWorkspace(db, 'alice', { name: 'Alice workspace' });
	const project = await createProject(db, { actorId: 'alice', workspaceId: workspace.id }, { workspaceId: workspace.id, name: 'Hack', description: 'Find a hackathon' });
	const scope: Scope = { actorId: 'alice', workspaceId: workspace.id, projectId: project.id };
	return { db, sqlite, scope };
}

// --- stubbed network: Devpost API, Tavily /extract, Nebius chat --------------

interface Counters { extract: number; extractUrls: string[][]; model: number }

/** The simulated model: per page, a rule it reads correctly (lightly re-spaced) plus one it INVENTS. */
function modelReply(userText: string): string {
	if (userText.includes('Brazil')) {
		return JSON.stringify({ claims: [
			// Real rule, quote re-spaced by the model (double space, line break) — must still be located.
			{ type: 'eligibility.restricted_countries', value: 'BR, RU, CU, IR, KP', quote: '(including, but not limited to,  Brazil, Quebec, Russia,\nCrimea, Cuba, Iran, and North Korea' },
			// Invented rule: this sentence is NOT in the page — must be rejected.
			{ type: 'eligibility.restricted_countries', value: 'NG', quote: 'Residents of Nigeria are excluded from this hackathon.' },
			// Not a number → dropped by the grammar check (never a claim).
			{ type: 'eligibility.min_age', value: 'age of majority', quote: 'at least the age of majority where they reside' },
		] });
	}
	if (userText.includes('50 United States')) {
		return JSON.stringify({ claims: [
			{ type: 'eligibility.open_countries', value: 'US', quote: 'legal residents of the 50 United States and the District of Columbia' },
			{ type: 'eligibility.min_age', value: '18', quote: 'at least 18 years of age at the time of entry' },
		] });
	}
	return '{"claims":[]}';
}

function stubNetwork(counters: Counters, opts: { extractStatus?: number; modelStatus?: number } = {}): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.hostname === 'devpost.com' && url.pathname === '/api/hackathons') {
			const page = PAGES[Number(url.searchParams.get('page') ?? '1')] ?? { hackathons: [], meta: { total_count: 46 } };
			return new Response(JSON.stringify(page), { status: 200 });
		}
		if (url.hostname === 'api.tavily.com' && url.pathname === '/extract') {
			counters.extract += 1;
			const urls = (body['urls'] as string[]) ?? [];
			counters.extractUrls.push(urls);
			if (opts.extractStatus) return new Response('extract down', { status: opts.extractStatus });
			const results = urls.flatMap((u) => {
				// A /rules URL returns the rules text; the event's own landing page
				// (overview, no /rules) returns distinct overview prose — exactly as
				// Devpost serves them, so the overview snapshot is its own content.
				const isRules = u.endsWith('/rules');
				if (u.startsWith('https://amazonappdev2026.devpost.com')) {
					return [{ url: u, raw_content: isRules ? AMAZON_RULES : OVERVIEW_PROSE('Amazon Developer Hackathon') }];
				}
				if (u.startsWith(new URL(PAYPAL_URL).origin)) {
					return [{ url: u, raw_content: isRules ? US_ONLY_RULES : OVERVIEW_PROSE('PayPal AI Hackathon') }];
				}
				return [];
			});
			return new Response(JSON.stringify({ results }), { status: 200 });
		}
		if (url.hostname === 'api.tavily.com') return new Response(JSON.stringify({ results: [] }), { status: 200 });
		if (url.hostname === 'api.tokenfactory.nebius.com') {
			const messages = (body['messages'] as { role: string; content: string }[]) ?? [];
			const system = messages.find((m) => m.role === 'system')?.content ?? '';
			if (!system.includes('ELIGIBILITY')) {
				return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }), { status: 200 });
			}
			counters.model += 1;
			if (opts.modelStatus) return new Response('model down', { status: opts.modelStatus });
			const user = messages.find((m) => m.role === 'user')?.content ?? '';
			return new Response(JSON.stringify({ choices: [{ message: { content: modelReply(user) } }] }), { status: 200 });
		}
		return new Response('offline in unit tests', { status: 503 });
	}) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
const counters = (): Counters => ({ extract: 0, extractUrls: [], model: 0 });
const KEYS = { tavilyApiKey: 'tvly-test', nebiusApiKey: 'nebius-test' };

// --- pure helpers ---------------------------------------------------------------

describe('rules-reading helpers', () => {
	test('rulesUrlFor: only Devpost-hosted contests have a /rules page', () => {
		expect(rulesUrlFor(AMAZON_URL)).toBe('https://amazonappdev2026.devpost.com/rules');
		expect(rulesUrlFor('https://devpost.com/hackathons')).toBeNull();
		expect(rulesUrlFor('https://help.devpost.com/hc/articles/1')).toBeNull();
		expect(rulesUrlFor('https://naija-hack.devfolio.co/')).toBeNull();
		expect(rulesUrlFor('not a url')).toBeNull();
	});

	test('eligibilityExcerpt keeps the eligibility section and stops at the next heading', () => {
		const excerpt = eligibilityExcerpt(AMAZON_RULES);
		expect(excerpt).toContain('IS NOT open to');
		expect(excerpt).toContain('Brazil');
		expect(excerpt).not.toContain('How To Enter');
		expect(excerpt).not.toContain('Submission Period');
	});

	test('locateVerbatim returns the exact snapshot text for a re-spaced quote, null for an invented one', () => {
		const found = locateVerbatim(AMAZON_RULES, '(including, but not limited to,  Brazil, Quebec,\nRussia');
		expect(found).toBe('(including, but not limited to, Brazil, Quebec, Russia');
		expect(AMAZON_RULES.includes(found!)).toBe(true);
		expect(locateVerbatim(AMAZON_RULES, 'Residents of Nigeria are excluded from this hackathon.')).toBeNull();
		expect(locateVerbatim(AMAZON_RULES, 'too short')).toBeNull();
	});
});

// --- the pipeline ---------------------------------------------------------------

describe('readRulesForCandidates', () => {
	test('reads the rules page into the evidence store and keeps only verbatim claims', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const c = counters();
			stubNetwork(c);
			const result = await readRulesForCandidates(db, scope, [{ id: 'a', url: AMAZON_URL, title: 'Amazon Developer Hackathon' }], KEYS);
			expect(result.pagesRead).toBe(1);
			expect(result.claimsAdded).toBe(1); // the real restriction
			expect(result.quotesRejected).toBe(1); // the invented Nigeria rule
			expect(result.gaps).toEqual([]);
			// Overview prose for this candidate is captured and returned for the digest.
			expect(result.overviewByCandidateId.get('a')).toContain('invites developers worldwide');
			// Two sources now: the binding rules page AND the overview page.
			const sources = await listSources(db, scope);
			const rulesSource = sources.find((s) => s.authority === 'binding_rules')!;
			const overviewSource = sources.find((s) => s.authority === 'official_overview')!;
			expect(rulesSource.canonicalUrl).toBe('https://amazonappdev2026.devpost.com/rules');
			expect(overviewSource.canonicalUrl).toBe('https://amazonappdev2026.devpost.com/');
			// Snapshot: an immutable, processed copy labelled with its renderer.
			const [snapshot] = await listSnapshots(db, scope, rulesSource.id);
			expect(snapshot!.provenance).toBe('processed');
			expect(snapshot!.renderer).toBe('tavily-extract');
			expect(snapshot!.content).toContain('IS NOT open to');
			// The overview snapshot exists but carries the overview prose, not rules.
			const [overviewSnapshot] = await listSnapshots(db, scope, overviewSource.id);
			expect(overviewSnapshot!.content).toContain('invites developers worldwide');
			expect(overviewSnapshot!.content).not.toContain('IS NOT open to');
			// Claim: exact snapshot substring, never the model's re-spaced text.
			const claims = await listClaims(db, scope);
			expect(claims).toHaveLength(1);
			expect(claims[0]!.claimType).toBe('eligibility.restricted_countries');
			expect(claims[0]!.value).toBe('BR,RU,CU,IR,KP');
			expect(claims[0]!.extractionVersion).toBe(RULES_EXTRACTION_VERSION);
			expect(snapshot!.content.includes(claims[0]!.quote)).toBe(true);
			// The overview page never produces an eligibility claim.
			expect(claims.every((cl) => cl.snapshotId !== overviewSnapshot!.id)).toBe(true);
			expect(claims.some((cl) => cl.value.includes('NG'))).toBe(false);
		} finally { sqlite.close(); }
	});

	test('batches every page into ONE Tavily extract call and skips non-Devpost events', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const c = counters();
			stubNetwork(c);
			await readRulesForCandidates(db, scope, [
				{ id: 'a', url: AMAZON_URL, title: 'Amazon' },
				{ id: 'b', url: 'https://naija-hack.devfolio.co/', title: 'Naija Hack' },
				{ id: 'p', url: PAYPAL_URL, title: 'PayPal AI Hackathon' },
			], KEYS);
			expect(c.extract).toBe(1);
			// ONE call carries BOTH the rules pages and the overview pages (Extract
			// takes many URLs), so the overview enrichment adds no extra round-trip.
			// Non-Devpost events (no /rules) are skipped entirely — no overview either.
			expect(c.extractUrls[0]).toEqual([
				'https://amazonappdev2026.devpost.com/rules',
				`${new URL(PAYPAL_URL).origin}/rules`,
				'https://amazonappdev2026.devpost.com',
				new URL(PAYPAL_URL).origin,
			]);
		} finally { sqlite.close(); }
	});

	test('caps the read at 5 pages', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const c = counters();
			stubNetwork(c);
			const many = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, url: `https://event-${i}.devpost.com/`, title: `Event ${i}` }));
			await readRulesForCandidates(db, scope, many, KEYS);
			// The cap is 5 RULES pages; the one call also carries their 5 overview
			// pages, so 10 URLs total but still only the top-5 events are read.
			const rulesUrlsInCall = c.extractUrls[0]!.filter((u) => u.endsWith('/rules'));
			const overviewUrlsInCall = c.extractUrls[0]!.filter((u) => !u.endsWith('/rules'));
			expect(rulesUrlsInCall).toHaveLength(5);
			expect(overviewUrlsInCall).toHaveLength(5);
		} finally { sqlite.close(); }
	});

	test('a page read within 24h is reused: no second extract, no second model call', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const c = counters();
			stubNetwork(c);
			const amazon = [{ id: 'a', url: AMAZON_URL, title: 'Amazon' }];
			await readRulesForCandidates(db, scope, amazon, KEYS);
			const second = await readRulesForCandidates(db, scope, amazon, KEYS);
			expect(c.extract).toBe(1);
			expect(c.model).toBe(1);
			expect(second.pagesRead).toBe(0);
			expect(second.pagesAvailable).toBe(1);
			// After the window, the page is read again.
			const later = await readRulesForCandidates(db, scope, amazon, { ...KEYS, now: () => Date.now() + 25 * 60 * 60 * 1000 });
			expect(c.extract).toBe(2);
			expect(later.pagesRead).toBe(1);
		} finally { sqlite.close(); }
	});

	test('fail-soft: extract outage → a visible gap, nothing stored, never throws', async () => {
		const { db, sqlite, scope } = await world();
		try {
			stubNetwork(counters(), { extractStatus: 500 });
			const result = await readRulesForCandidates(db, scope, [{ id: 'a', url: AMAZON_URL, title: 'Amazon' }], KEYS);
			expect(result.claimsAdded).toBe(0);
			expect(result.gaps.join(' ')).toContain('Rules pages could not be read');
			expect(await listClaims(db, scope)).toHaveLength(0);
		} finally { sqlite.close(); }
	});

	test('fail-soft: no model key → page saved, gap says it was not analysed', async () => {
		const { db, sqlite, scope } = await world();
		try {
			stubNetwork(counters());
			const result = await readRulesForCandidates(db, scope, [{ id: 'a', url: AMAZON_URL, title: 'Amazon' }], { tavilyApiKey: 'tvly-test' });
			expect(result.pagesRead).toBe(1);
			expect(result.claimsAdded).toBe(0);
			expect(result.gaps.join(' ')).toContain('not analysed');
		} finally { sqlite.close(); }
	});

	test('fail-soft: model outage → gap naming the event, no guessed claims', async () => {
		const { db, sqlite, scope } = await world();
		try {
			stubNetwork(counters(), { modelStatus: 500 });
			const result = await readRulesForCandidates(db, scope, [{ id: 'a', url: AMAZON_URL, title: 'Amazon' }], KEYS);
			expect(result.claimsAdded).toBe(0);
			expect(result.gaps.join(' ')).toContain('Amazon');
			expect(await listClaims(db, scope)).toHaveLength(0);
		} finally { sqlite.close(); }
	});

	test('no Tavily key → nothing read, no network, no throw', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const c = counters();
			stubNetwork(c);
			const result = await readRulesForCandidates(db, scope, [{ id: 'a', url: AMAZON_URL, title: 'Amazon' }], { nebiusApiKey: 'nebius-test' });
			expect(result.pagesRead).toBe(0);
			expect(c.extract).toBe(0);
		} finally { sqlite.close(); }
	});
});

// --- end to end through discovery -------------------------------------------------

describe('discoverForActor — quoted rules decide eligibility', () => {
	test('NG builder: Amazon becomes "eligible" with its rule quoted; a US-only event becomes "ineligible" and sinks', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const c = counters();
			stubNetwork(c);
			await upsertProfile(db, 'alice', { country: 'NG', formatPreference: 'online', freeTextInterests: ['AI', 'Education'] });
			const result = await discoverForActor(db, scope, { limit: 20 }, KEYS);
			const amazon = result.candidates.find((x) => x.url === AMAZON_URL)!;
			// Amazon: the quoted restriction list does not include NG → eligible.
			expect(amazon.eligibility.verdict).toBe('eligible');
			expect(amazon.eligibility.rules[0]!.quote).toContain('Brazil');
			expect(amazon.eligibilityNote).toBe('You can enter');
			expect(amazon.eligibilityQuote).toContain('Brazil');
			expect(amazon.rulesUrl).toBe('https://amazonappdev2026.devpost.com/rules');
			expect(result.gaps.join(' ')).toContain('official rules pages (via Tavily)');
			// US-only rules: NG is outside the quoted allowlist → ineligible, so the
			// event sinks below ~30 eligible/unknown events and out of the top 20.
			expect(result.candidates.find((x) => x.url === PAYPAL_URL)).toBeUndefined();
			expect(result.candidates.every((x) => x.eligibility.verdict !== 'ineligible')).toBe(true);
			const usAllowlist = (await listClaims(db, scope)).find((cl) => cl.claimType === 'eligibility.open_countries');
			expect(usAllowlist?.value).toBe('US');
			expect(evaluateEligibility([{ claimId: usAllowlist!.id, claimType: usAllowlist!.claimType, value: usAllowlist!.value, quote: usAllowlist!.quote }], { country: 'NG' }).verdict).toBe('ineligible');
			// Events whose rules were not read stay honestly unknown.
			expect(result.candidates.some((x) => x.eligibility.verdict === 'unknown')).toBe(true);
			// Bounded: one extract call; at most 5 rules pages for the top 5
			// (their overview pages ride along in the same call).
			expect(c.extract).toBe(1);
			expect(c.extractUrls[0]!.filter((u) => u.endsWith('/rules')).length).toBeLessThanOrEqual(5);
		} finally { sqlite.close(); }
	});

	test('a US builder sees the same US-only event as eligible — the verdict is per-profile, from the quote', async () => {
		const { db, sqlite, scope } = await world();
		try {
			stubNetwork(counters());
			await upsertProfile(db, 'alice', { country: 'US', formatPreference: 'online', freeTextInterests: ['AI', 'Education'] });
			const result = await discoverForActor(db, scope, { limit: 10 }, KEYS);
			const paypal = result.candidates.find((x) => x.url === PAYPAL_URL)!;
			// open_countries US → eligible; min_age 18 → unknown (no date of birth on
			// the profile), so the strict aggregate stays 'unknown' — never assumed.
			expect(paypal.eligibility.rules.find((r) => r.claimType === 'eligibility.open_countries')!.verdict).toBe('eligible');
			expect(paypal.eligibility.rules.find((r) => r.claimType === 'eligibility.min_age')!.basis).toBe('missing_profile_attribute');
			expect(paypal.eligibility.verdict).toBe('unknown');
			expect(paypal.eligibilityNeedsConfirm).toBe(true);
			expect(paypal.eligibilityNote).toBe("Open to US · confirm you're 18+");
			expect(result.candidates.find((x) => x.url === AMAZON_URL)!.eligibility.verdict).toBe('eligible');
		} finally { sqlite.close(); }
	});

	test('refresh=false never spends on rules reading', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const c = counters();
			stubNetwork(c);
			await discoverForActor(db, scope, { refresh: false }, KEYS);
			expect(c.extract).toBe(0);
			expect(c.model).toBe(0);
		} finally { sqlite.close(); }
	});
});
