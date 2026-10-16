import type { Scope } from '@caddie/contracts';
import { DEVPOST_TIMEOUT_MS, timeoutSignal } from './http-timeouts.ts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { canonicalizeUrl, listSources, getSnapshot } from './evidence/sources.ts';
import { deriveEvidenceId, sha256Hex } from './evidence/identity.ts';
import { listClaims, surveyClaims, type ReconciliationClaim } from './evidence/claims.ts';
import {
	evaluateEligibility,
	type EligibilityEvaluation,
	type EligibilityProfile,
	type EligibilityRuleClaim,
} from './eligibility.ts';
import { tavilySearch, TavilyNotConfiguredError, type TavilySearchResult } from './tavily.ts';
import { DIGEST_VERSION, digestCandidate, type CandidateDigest, type InspectionProfile } from './candidate-inspection.ts';
import { readRulesForCandidates, overviewUrlFor } from './rules-reading.ts';

/**
 * P11 slice 1 — discovery: the candidate feed, candidate identity, and
 * explainable fit (feature-ledger C10, IMPROVE over the carryover
 * discover/scout pair).
 *
 * Invariants (each pinned by a test):
 *   - Candidate identity is a DETERMINISTIC hash of (source, canonical URL)
 *     derived server-side at ingest — never client-supplied. The carryover
 *     scout bound candidates by prose-derived client ids; here
 *     {@link assertCandidateId} refuses any id that does not match the
 *     derivation, and every stored row re-checks it on read.
 *   - Source adapters are pluggable ({@link DiscoverySourceAdapter}); the
 *     local implementation reads seeded candidates from D1, and the REQUIRED
 *     PRIMARY {@link createTavilyDiscoveryAdapter} runs a live multi-platform
 *     Tavily search (Devpost / Devfolio / MLH / …) with the Devpost public feed
 *     as a structured enricher. Both run behind the same seam.
 *   - Partial feed failure is VISIBLE: each source's outcome (succeeded /
 *     failed + reason) is recorded per feed run, so a failed source shows up
 *     as a named gap — never a silent drop.
 *   - Fit is EXPLAINABLE: every fit claim points at the P10 evidence claim ids
 *     it rests on (through the P10 authority reconciliation), or honestly
 *     records an assumption / unknown. Nothing is invented.
 *   - Ranking is conservative: hard-ineligible candidates can never rank as
 *     eligible, whatever their fit ({@link rankCandidateSummaries}).
 *
 * Every service takes its Scope as a MANDATORY parameter and re-verifies it
 * against D1 at entry (P02 pattern); every query leads with projectId.
 */

// --- shapes ---------------------------------------------------------------------

/** One requirement a candidate states, mapped to the evidence claim type that would establish it. */
export interface CandidateRequirement {
	readonly text: string;
	readonly claimType: string;
}

/** An adapter-raw candidate: NO id field — identity is derived server-side. */
export interface RawCandidate {
	readonly url: string;
	readonly title: string;
	readonly summary: string;
	readonly publishedAt?: string | null;
	readonly requirements?: readonly CandidateRequirement[];
	/** Ranking signal (Stage 2): parsed USD-ordering prize value, null when none found. */
	readonly prizeUsd?: number | null;
	/** Ranking signal (Stage 2): known-company weight (0 when none recognised). */
	readonly companyWeight?: number;
	/**
	 * Parsed DISPLAY fields (Stage 1: clean content at the source) — real values
	 * extracted from the raw/enriched text so the card renders CHIPS, not scraped
	 * soup. Every one is honest-nullable: a value we cannot parse stays null and
	 * the card omits that chip rather than fabricating one.
	 */
	readonly participants?: number | null;
	readonly format?: EventFormat | null;
	readonly startsAt?: string | null;
	readonly endsAt?: string | null;
	readonly deadline?: string | null;
}

/** How the event is attended, parsed from text. null = not determinable. */
export type EventFormat = 'online' | 'in-person' | 'hybrid';

export interface DiscoverySourceBatch {
	readonly candidates: readonly RawCandidate[];
}

/**
 * The pluggable source boundary (P11 packets text): implement this to add a
 * source. The LOCAL adapter reads the discovery_seed_candidates D1 table; the
 * REQUIRED PRIMARY {@link createTavilyDiscoveryAdapter} runs a live
 * multi-platform Tavily search (Devpost enrichment within it) through this same
 * seam.
 */
export interface DiscoverySourceAdapter {
	readonly id: string;
	fetchCandidates(input: { projectId: string }): Promise<DiscoverySourceBatch>;
}

export type CandidateStatus = 'new' | 'accepted' | 'dismissed';

export interface CandidateRecord {
	readonly id: string;
	readonly projectId: string;
	readonly source: string;
	readonly url: string;
	readonly title: string;
	readonly summary: string;
	readonly publishedAt: string | null;
	readonly requirements: readonly CandidateRequirement[];
	readonly status: CandidateStatus;
	/** B01: the saved bookmark (its own axis, never a status). Null = not saved. */
	readonly savedAt: string | null;
	readonly feedRunId: string;
	readonly firstSeenAt: string;
	readonly updatedAt: string;
}

export type FeedSourceOutcome = 'succeeded' | 'failed';

export interface FeedSourceRecord {
	readonly id: string;
	readonly feedRunId: string;
	readonly source: string;
	readonly outcome: FeedSourceOutcome;
	/** Why the source failed — the visible gap (null when succeeded). */
	readonly failureReason: string | null;
	readonly candidateCount: number;
	readonly completedAt: string;
}

export interface DiscoveryFeedRecord {
	readonly id: string;
	readonly projectId: string;
	readonly requestedBy: string;
	readonly requestedAt: string;
	readonly sources: readonly FeedSourceRecord[];
	/** Candidates stored under this run's derived ids (dedupe: re-runs repeat rows, never duplicate them). */
	readonly candidates: readonly CandidateRecord[];
}

// --- fit ------------------------------------------------------------------------

export type FitVerdict = 'supported' | 'conflict' | 'unmatched' | 'unknown';

export interface FitClaim {
	/** The candidate requirement this claim explains. */
	readonly requirement: string;
	readonly claimType: string;
	readonly verdict: FitVerdict;
	readonly statement: string;
	/** The P10 evidence claim ids this claim rests on (empty only with an honest assumption). */
	readonly evidenceClaimIds: readonly string[];
	/** Recorded assumptions — what the claim would need but does not have. */
	readonly assumptions: readonly string[];
}

export interface FitResult {
	readonly candidateId: string;
	/** Crude heuristic count of supported requirements — an ordering label, NOT a probability. */
	readonly matchedRequirements: number;
	readonly claims: readonly FitClaim[];
	readonly fitVersion: string;
}

export const FIT_VERSION = 'p11-fit-1';

// --- helpers --------------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function candidateFromRow(row: Record<string, unknown>): CandidateRecord {
	const status = row['status'];
	if (status !== 'new' && status !== 'accepted' && status !== 'dismissed') {
		fail(500, 'invalid_row', `candidate row carries an unknown status: ${String(status)}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		source: String(row['source']),
		url: String(row['url']),
		title: String(row['title']),
		summary: String(row['summary']),
		publishedAt: row['publishedAt'] == null ? null : String(row['publishedAt']),
		requirements: parseRequirementsJson(row['requirementsJson']),
		status,
		savedAt: row['savedAt'] == null ? null : String(row['savedAt']),
		feedRunId: String(row['feedRunId']),
		firstSeenAt: String(row['firstSeenAt']),
		updatedAt: String(row['updatedAt']),
	};
}

/** JSON column: a corrupt value degrades to an empty mapping, never a crash. */
function parseRequirementsJson(raw: unknown): readonly CandidateRequirement[] {
	if (typeof raw !== 'string') return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((entry): CandidateRequirement[] => {
			if (entry === null || typeof entry !== 'object') return [];
			const text = (entry as { text?: unknown }).text;
			const claimType = (entry as { claimType?: unknown }).claimType;
			if (typeof text !== 'string' || typeof claimType !== 'string' || !text.trim() || !claimType.trim()) {
				return [];
			}
			return [{ text, claimType }];
		});
	} catch {
		return [];
	}
}

// --- candidate identity ------------------------------------------------------------

/**
 * The deterministic candidate id: a hash of (source, canonical URL) via the
 * P10 URL canonicalization, so tracking-parameter variants are one candidate.
 * Callers cannot supply an id anywhere — this function IS the identity.
 */
export async function deriveCandidateId(source: string, url: string): Promise<string> {
	if (typeof source !== 'string' || source.trim().length === 0) {
		fail(400, 'invalid_input', 'candidate source is required');
	}
	if (typeof url !== 'string' || url.trim().length === 0) {
		fail(400, 'invalid_input', 'candidate url is required');
	}
	const canonical = canonicalizeUrl(url);
	return deriveEvidenceId('cand', source.trim(), canonical);
}

/**
 * Refuse any candidate id that does not match the derivation for its
 * (source, URL) — candidate binding can never be driven by a client-invented
 * or prose-derived identity.
 */
export async function assertCandidateId(candidateId: string, source: string, url: string): Promise<void> {
	const derived = await deriveCandidateId(source, url);
	if (candidateId !== derived) {
		fail(
			400,
			'fabricated_candidate_id',
			`candidate id does not match the deterministic derivation for (source, url) — fabricated ids are rejected`,
		);
	}
}

// --- local seed source adapter ------------------------------------------------------

export interface SeedCandidateInput {
	source: string;
	url: string;
	title: string;
	summary: string;
	publishedAt?: string | null;
	requirements?: readonly CandidateRequirement[];
}

/**
 * Seed the LOCAL source adapter's D1 table. This is the local implementation
 * of the pluggable feed (no external calls); a real Devpost adapter is P17
 * live wiring. Idempotent per (source, url).
 */
export async function seedCandidates(db: D1Database, inputs: readonly SeedCandidateInput[]): Promise<number> {
	let inserted = 0;
	for (const input of inputs) {
		if (typeof input.source !== 'string' || !input.source.trim()) {
			fail(400, 'invalid_input', 'seed source is required');
		}
		if (typeof input.url !== 'string' || !input.url.trim()) {
			fail(400, 'invalid_input', 'seed url is required');
		}
		if (typeof input.title !== 'string' || !input.title.trim()) {
			fail(400, 'invalid_input', 'seed title is required');
		}
		if (typeof input.summary !== 'string' || !input.summary.trim()) {
			fail(400, 'invalid_input', 'seed summary is required');
		}
		const result = await db
			.prepare(
				'insert or ignore into "discovery_seed_candidates" ' +
					'("id","source","url","title","summary","publishedAt","requirementsJson","createdAt") ' +
					'values (?,?,?,?,?,?,?,?)',
			)
			.bind(
				newId('seed'),
				input.source.trim(),
				canonicalizeUrl(input.url),
				input.title.trim(),
				input.summary.trim(),
				input.publishedAt ?? null,
				JSON.stringify(input.requirements ?? []),
				nowIso(),
			)
			.run();
		const meta = (result as { meta?: { changes?: number } }).meta;
		if ((meta?.changes ?? 0) > 0) inserted += 1;
	}
	return inserted;
}

/**
 * The LOCAL {@link DiscoverySourceAdapter}: returns the seeded candidates for
 * one source id (all sources when omitted). Deliberately boring — its job is
 * to prove the feed/identity/failure machinery, not to impersonate Devpost.
 */
export function createLocalSeedAdapter(db: D1Database, sourceId?: string): DiscoverySourceAdapter {
	return {
		id: sourceId ?? 'local-seed',
		async fetchCandidates(): Promise<DiscoverySourceBatch> {
			const rows = sourceId
				? await queryAll(
						db,
						'select * from "discovery_seed_candidates" where "source" = ? order by "createdAt" asc, "id" asc',
						sourceId,
					)
				: await queryAll(db, 'select * from "discovery_seed_candidates" order by "createdAt" asc, "id" asc');
			return {
				candidates: rows.map((row) => ({
					url: String(row['url']),
					title: String(row['title']),
					summary: String(row['summary']),
					publishedAt: row['publishedAt'] == null ? null : String(row['publishedAt']),
					requirements: parseRequirementsJson(row['requirementsJson']),
				})),
			};
		},
	};
}

// --- the LIVE discovery adapters: Devpost API primary + Tavily breadth/backup -----
//
// DESIGN (2026-10-13, supersedes "Tavily primary + Devpost enricher"):
//   - Devpost's open-contests API is the PRIMARY list for Devpost (see the
//     Devpost section below) — structured, complete, verified-open.
//   - Tavily searches the OTHER platforms (Devfolio, HackerEarth,
//     DoraHacks, ETHGlobal, Kaggle) — breadth no single site's feed gives — and
//     drops its own Devpost hits, which the API already covers authoritatively
//     (web-search Devpost hits were the source of ended contests, page chrome
//     and subpage duplicates).
//   - BACKUP: only when the Devpost API is unavailable, Tavily also searches
//     devpost.com; those candidates are labelled "open status unverified" and the
//     caller adds a visible gap. Tavily stays required for discovery either way.
//
// HONESTY (unchanged invariants, each pinned by a test):
//   - summary is COMPOSED from whatever structured/snippet text a source
//     actually carries — never invented;
//   - publishedAt stays null unless a source genuinely provides a publish date;
//   - requirements stay [] — eligibility is read from quoted rules, never here;
//   - no Tavily key THROWS (TavilyNotConfiguredError) and an unreachable search
//     THROWS — runDiscoveryFeed records either as a VISIBLE named gap, never a
//     silent empty list.

/** Every platform discovery knows about. */
const HACKATHON_DOMAINS = [
	'devpost.com',
	'devfolio.co',
	'mlh.io',
	'hackerearth.com',
	'dorahacks.io',
	'ethglobal.com',
	'kaggle.com',
] as const;

/**
 * What Tavily searches normally: everything EXCEPT Devpost (the API covers it)
 * and MLH (a directory of events hosted elsewhere — its pages are season
 * schedules, never an event page, so searching it only spends result slots).
 */
const OTHER_PLATFORM_DOMAINS: readonly string[] = HACKATHON_DOMAINS.filter((d) => d !== 'devpost.com' && d !== 'mlh.io');

/** The sweep query — broad enough for breadth, narrow enough to mean "open contest". */
const DISCOVERY_QUERY = 'open hackathon accepting registrations and submissions';

/** Big-sponsor sweep — only needed when Devpost (where these events live) must be web-searched. */
const SPONSOR_SWEEP_QUERY = 'AI hackathon sponsored by Nebius OR AWS OR Google OR Microsoft OR OpenAI OR PayPal open registration';

/**
 * Build the set of searches the Tavily sweep runs. ALWAYS includes the generic
 * sweep (breadth); profile terms (interests/skills) add up to 3 topic-targeted
 * queries, and a country adds one locality query — alongside the generic sweep,
 * not instead of it. `sponsorSweep` (Devpost-backup mode only) adds the
 * big-sponsor query: in normal mode those events come from the Devpost API, so
 * paying for a query that targets them would be waste. Deduped and capped.
 */
export function buildDiscoveryQueries(
	input: { terms?: readonly string[]; country?: string | null; sponsorSweep?: boolean } = {},
): string[] {
	const queries: string[] = [DISCOVERY_QUERY];
	const terms = [...new Set((input.terms ?? []).map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : '')).filter((t) => t.length >= 2))];
	for (const term of terms.slice(0, 3)) queries.push(`${term} hackathon online open registration`);
	const country = typeof input.country === 'string' ? input.country.trim() : '';
	if (country) queries.push(`online hackathon open to ${country} participants`);
	if (input.sponsorSweep) queries.push(SPONSOR_SWEEP_QUERY);
	// Dedupe (a term could coincide with the generic phrasing) and cap total.
	return [...new Set(queries)].slice(0, 6);
}

interface DevpostRawHackathon {
	title?: string;
	url?: string;
	open_state?: string;
	displayed_location?: { location?: string; icon?: string } | null;
	submission_period_dates?: string | null;
	time_left_to_submission?: string | null;
	themes?: { name?: string }[] | null;
	prize_amount?: string | null;
	registrations_count?: number | null;
	featured?: boolean;
	organization_name?: string | null;
	invite_only?: boolean;
}

function stripHtml(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const text = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
	return text || null;
}

/** Normalize a Devpost feed URL to an absolute https url (feed gives // or / prefixes). */
function normalizeDevpostUrl(url: string): string {
	if (url.startsWith('//')) return 'https:' + url;
	if (url.startsWith('/')) return 'https://devpost.com' + url;
	return url;
}

/** Which platform a result URL belongs to, for an honest source label in the summary. */
function platformLabel(url: string): string | null {
	try {
		const host = new URL(url).hostname.replace(/^www\./, '');
		for (const d of HACKATHON_DOMAINS) if (host === d || host.endsWith(`.${d}`)) return d;
		return host;
	} catch {
		return null;
	}
}

// --- prize + organization extraction (Stage 2 ranking signals) --------------------
//
// The user wants the BIGGEST-prize, BIGGER-company hackathons first. Prize/org
// are not reliably in the Devpost feed match (only ~URL-key matches enriched),
// so parse them from WHATEVER text a hit carries — the feed's prize_amount when
// enriched, otherwise the search snippet. Honest: a prize we cannot parse stays
// null (never guessed), and the numeric value is for RANKING only, never shown
// as if authoritative.

/**
 * Parse the largest USD-equivalent prize figure mentioned in free text.
 * Recognises `$40,200`, `$1.2M`, `50k USD`, `USD 7,000`. Non-USD currencies
 * (₹, €, £) are recognised as prizes but converted ROUGHLY to a USD-ish
 * magnitude only for ORDERING (documented as approximate — it never claims a
 * real conversion). Returns null when no monetary figure is present.
 */
export function parsePrizeUsd(text: string | null | undefined): number | null {
	return parsePrize(text)?.usd ?? null;
}

/**
 * The largest prize mentioned in free text, as BOTH its ordering value and its
 * ORIGINAL text ("$138,000", "₹ 100,000", "€10,680"). Cards display `display`
 * — never `usd`, which is a rough cross-currency ORDERING magnitude, not a
 * conversion. Null when no monetary figure is present.
 */
export function parsePrize(text: string | null | undefined): { usd: number; display: string } | null {
	if (!text) return null;
	// Rough non-USD → USD ordering factors (ordering only; not a real FX rate).
	const CURRENCY_FACTOR: Record<string, number> = { '$': 1, usd: 1, '€': 1.05, eur: 1.05, '£': 1.25, gbp: 1.25, '₹': 0.012, inr: 0.012 };
	const magOf = (word: string): number => {
		const w = word.toLowerCase();
		if (w.startsWith('m')) return 1_000_000;
		if (w.startsWith('b')) return 1_000_000_000;
		if (w.startsWith('k') || w.startsWith('t')) return 1_000; // k / thousand
		return 1;
	};
	let best: { usd: number; display: string } | null = null;
	const consider = (sym: string, digitsRaw: string, magWord: string, matched: string) => {
		const factor = CURRENCY_FACTOR[sym.toLowerCase()] ?? 1;
		const digits = Number(digitsRaw.replace(/,/g, '').replace(/\.$/, ''));
		if (!Number.isFinite(digits)) return;
		const usd = Math.round(digits * magOf(magWord) * factor);
		if (best === null || usd > best.usd) best = { usd, display: matched.trim().replace(/[.,]$/, '') };
	};
	// Pass 1 — currency BEFORE the amount: "$40,200", "USD 7,000", "$1.2M".
	// The magnitude word must END at a word boundary, so "$50,000 more" is not
	// misread as $50 billion ("m…") — a real bug class for prose snippets.
	const before = /(\$|€|£|₹|usd|eur|gbp|inr)\s?([\d][\d,.]*)\s?(?:(k|m|b|million|thousand|billion)\b)?/gi;
	let m: RegExpExecArray | null;
	while ((m = before.exec(text)) !== null) consider(m[1]!, m[2]!, m[3] ?? '', m[0]);
	// Pass 2 — amount BEFORE the currency word: "50k USD", "5,000 USD", "₹50,000".
	const after = /([\d][\d,.]*)\s?(?:(k|m|b|million|thousand|billion)\b)?\s?(\$|€|£|₹|usd|eur|gbp|inr)\b/gi;
	while ((m = after.exec(text)) !== null) consider(m[3]!, m[1]!, m[2] ?? '', m[0]);
	return best;
}

// --- Stage 1: clean the card content at the source --------------------------
//
// A live Tavily snippet (the NON-feed-enriched path, which is the common case)
// carries raw scraped Devpost page-text: repeated nav labels ("Devpost Devpost
// logo"), separator soup ("||| --- ||"), and UI chrome ("View schedule", "This
// hackathon has ended"). The screenshots showed this verbatim on the cards.
// These helpers turn that soup into readable prose + real parsed fields. Every
// one is CONSERVATIVE and HONEST: it strips only known-noise tokens and leaves
// a value null when it cannot parse it, never fabricating one.

/**
 * Known Devpost/scrape boilerplate removed from a summary. Ordered longest-first
 * where overlapping so the more specific phrase wins. Each entry is a token the
 * live transcript/screenshots actually produced; adding one here is the single
 * place to teach the sanitizer new noise.
 */
const SUMMARY_NOISE_PATTERNS: readonly RegExp[] = [
	/\bdevpost\s+logo\b/gi,			// "Devpost logo"
	/\bdevpost(?:\s+devpost)+\b/gi,	// repeated "Devpost Devpost Devpost"
	/\bthis\s+hackathon\s+has\s+ended\b/gi,
	/\bview\s+schedule\b/gi,
	/\bview\s+full\s+schedule\b/gi,
	/\bback\s+to\s+(?:all\s+)?hackathons\b/gi,
	/\bsign\s*up\b/gi,
	/\blog\s*in\b/gi,
	/\bregister(?:\s+now)?\b/gi,
	/\bmanage\s+hackathons?\b/gi,
	/\bhost\s+(?:a\s+)?hackathons?\b/gi,
	/\bhome\s+for\s+hackathons\b/gi,
	/\bapple\s+google\s+outlook\b/gi, // the calendar-add button row from the screenshot
	/\badd\s+to\s+calendar\b/gi,
];

/**
 * Turn a raw scraped summary into readable prose. Strips HTML, known nav/chrome
 * noise and separator soup ("|", "---", repeated punctuation), collapses
 * whitespace, de-duplicates immediately-repeated words ("Devpost Devpost"), and
 * trims to a sane length on a word boundary. Returns a cleaned string; when
 * nothing readable survives it returns `fallback` (an honest neutral line)
 * rather than empty soup.
 */
export function sanitizeSummary(
	raw: string | null | undefined,
	fallback = 'Open hackathon.',
	maxLen = 260,
): string {
	const base = stripHtml(raw ?? null);
	if (!base) return fallback;
	let text = base;
	for (const p of SUMMARY_NOISE_PATTERNS) text = text.replace(p, ' ');
	text = text
		// Separator soup: runs of | / - · and their mixes → a single bullet separator.
		.replace(/\s*(?:\|{1,}|-{2,}|·|•|–|—|\/{2,})\s*/g, ' · ')
		// Collapse repeated separators left by stripped noise ("·  ·  ·").
		.replace(/(?:\s*·\s*){2,}/g, ' · ')
		.replace(/\s{2,}/g, ' ')
		// Immediately-repeated word ("Devpost Devpost", "Online Online") → one.
		.replace(/\b(\w{2,})(?:\s+\1\b)+/gi, '$1')
		.trim()
		// Strip leading/trailing bullet separators left by edge stripping.
		.replace(/^(?:\s*·\s*)+|(?:\s*·\s*)+$/g, '')
		.trim();
	if (!text) return fallback;
	if (text.length > maxLen) {
		const cut = text.slice(0, maxLen);
		const lastSpace = cut.lastIndexOf(' ');
		text = (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
	}
	return text;
}

/**
 * Parse a participant/registration count from free text. Recognises
 * "1,234 participants", "532 registrations", "participants: 88", "88 teams".
 * Returns the largest plausible count, or null when none is present. Caps at a
 * sane upper bound so a stray large number (a prize, a year) is not misread.
 */
export function parseParticipants(text: string | null | undefined): number | null {
	if (!text) return null;
	let best: number | null = null;
	const take = (digitsRaw: string) => {
		const n = Number(digitsRaw.replace(/,/g, ''));
		if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return;
		if (best === null || n > best) best = n;
	};
	// "1,234 participants" / "532 registrations" / "88 teams" / "90 hackers".
	const noun = /([\d][\d,]*)\s+(participants?|registrations?|registered|teams?|hackers?|attendees?|members?)\b/gi;
	let m: RegExpExecArray | null;
	while ((m = noun.exec(text)) !== null) take(m[1]!);
	// "participants: 88" / "registrations - 532".
	const label = /(participants?|registrations?|registered|teams?|hackers?|attendees?)\s*[:\-–]\s*([\d][\d,]*)/gi;
	while ((m = label.exec(text)) !== null) take(m[2]!);
	return best;
}

/**
 * Parse the event FORMAT from free text. "online"/"virtual"/"remote" → online,
 * "in person"/"on-site"/"onsite" → in-person, both present → hybrid. null when
 * nothing determinable. Word-boundary matched so "personal" never trips
 * "person".
 */
export function parseFormat(text: string | null | undefined): EventFormat | null {
	if (!text) return null;
	const t = text.toLowerCase();
	const online = /\b(online|virtual|remote)\b/.test(t);
	const inPerson = /\b(in[-\s]?person|on[-\s]?site|onsite|offline)\b/.test(t);
	if (/\bhybrid\b/.test(t)) return 'hybrid';
	if (online && inPerson) return 'hybrid';
	if (online) return 'online';
	if (inPerson) return 'in-person';
	return null;
}

/**
 * Parse event dates from Devpost's `submission_period_dates`-style text, e.g.
 * "Oct 03 - Oct 24, 2026", "October 3–24, 2026", "Nov 1, 2026". Returns ISO
 * date strings (YYYY-MM-DD) for start/end when parseable; `deadline` mirrors the
 * end date (the submission deadline). Honest: an unparseable or absent date is
 * null, never today's date or a guess.
 */
export function parseEventDates(text: string | null | undefined): {
	startsAt: string | null;
	endsAt: string | null;
	deadline: string | null;
} {
	const none = { startsAt: null, endsAt: null, deadline: null };
	if (!text) return none;
	const MONTHS: Record<string, number> = {
		jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
	};
	const monthNum = (name: string): number | null => {
		const key = name.slice(0, 3).toLowerCase();
		return key in MONTHS ? MONTHS[key]! : null;
	};
	const iso = (y: number, mo: number, d: number): string | null => {
		if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
		return `${y.toString().padStart(4, '0')}-${(mo + 1).toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
	};
	// Cross-year range, each side carrying its own year (Devpost uses this when a
	// contest spans New Year): "Jul 16, 2026 - Jan 15, 2027". Checked FIRST — the
	// shorter patterns below would otherwise read only "Jul 16, 2026" and report
	// the START as the deadline.
	const crossYear = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})\s*[-–—]\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})/;
	let m = crossYear.exec(text);
	if (m) {
		const mo1 = monthNum(m[1]!), mo2 = monthNum(m[4]!);
		if (mo1 !== null && mo2 !== null) {
			const startsAt = iso(Number(m[3]), mo1, Number(m[2]));
			const endsAt = iso(Number(m[6]), mo2, Number(m[5]));
			return { startsAt, endsAt, deadline: endsAt };
		}
	}
	// Range with two month names: "Oct 03 - Nov 24, 2026" / "October 3 – November 24, 2026".
	const twoMonth = /([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-–—to]+\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})/;
	m = twoMonth.exec(text);
	if (m) {
		const mo1 = monthNum(m[1]!), mo2 = monthNum(m[3]!), year = Number(m[5]);
		if (mo1 !== null && mo2 !== null) {
			const startsAt = iso(year, mo1, Number(m[2]));
			const endsAt = iso(year, mo2, Number(m[4]));
			return { startsAt, endsAt, deadline: endsAt };
		}
	}
	// Range with one month name: "Oct 03 - 24, 2026" / "October 3–24, 2026".
	const oneMonth = /([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-–—to]+\s*(\d{1,2}),?\s*(\d{4})/;
	m = oneMonth.exec(text);
	if (m) {
		const mo = monthNum(m[1]!), year = Number(m[4]);
		if (mo !== null) {
			const startsAt = iso(year, mo, Number(m[2]));
			const endsAt = iso(year, mo, Number(m[3]));
			return { startsAt, endsAt, deadline: endsAt };
		}
	}
	// Single date: "Nov 1, 2026" / "November 1 2026".
	const single = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})/;
	m = single.exec(text);
	if (m) {
		const mo = monthNum(m[1]!), year = Number(m[3]);
		if (mo !== null) {
			const d = iso(year, mo, Number(m[2]));
			return { startsAt: d, endsAt: null, deadline: d };
		}
	}
	return none;
}

/**
 * Decide whether a hackathon has ENDED (so the discovery sweep can drop it —
 * the user saw closed events on the cards). CONSERVATIVE: returns true only on
 * an EXPLICIT ended signal, never on absence. An event with no signal is kept
 * (honest — we do not guess an event is closed and silently hide it). Signals:
 *   - the Devpost feed's `open_state` is a non-open value ("ended"/"upcoming"
 *     are not "open"); only an explicit non-open string closes it, a missing
 *     open_state does NOT;
 *   - the raw text says it ended / submissions closed / registration closed.
 */
export function isEndedHackathon(input: {
	openState?: string | null;
	text?: string | null;
}): boolean {
	const state = (input.openState ?? '').trim().toLowerCase();
	// Explicit non-open feed state. "open" / "" (unknown) are NOT ended.
	if (state && state !== 'open') {
		if (/(ended|closed|finished|complete|past)/.test(state)) return true;
	}
	const text = (input.text ?? '').toLowerCase();
	if (!text) return false;
	return (
		/\bthis\s+hackathon\s+has\s+ended\b/.test(text) ||
		/\bhackathon\s+(?:has\s+)?ended\b/.test(text) ||
		/\bsubmissions?\s+(?:are\s+)?closed\b/.test(text) ||
		/\bregistration\s+(?:is\s+)?closed\b/.test(text) ||
		/\bevent\s+(?:has\s+)?ended\b/.test(text)
	);
}


/**
 * Known larger organizations whose hackathons the user wants surfaced first.
 * A match in title/org/summary adds a ranking weight — it NEVER changes
 * eligibility and never fabricates a prize. Conservative word-boundary match
 * so "Google Cloud" scores but a stray "go" does not.
 */
const KNOWN_COMPANIES: readonly { name: string; pattern: RegExp; weight: number }[] = [
	{ name: 'Google', pattern: /\bgoogle\b/i, weight: 3 },
	{ name: 'Microsoft', pattern: /\bmicrosoft\b/i, weight: 3 },
	{ name: 'Amazon/AWS', pattern: /\b(amazon|aws)\b/i, weight: 3 },
	{ name: 'Meta', pattern: /\b(meta|facebook)\b/i, weight: 3 },
	{ name: 'NVIDIA', pattern: /\bnvidia\b/i, weight: 3 },
	{ name: 'OpenAI', pattern: /\bopenai\b/i, weight: 3 },
	{ name: 'Apple', pattern: /\bapple\b/i, weight: 3 },
	{ name: 'IBM', pattern: /\bibm\b/i, weight: 2 },
	{ name: 'Elastic', pattern: /\bel(astic|asticsearch)\b/i, weight: 2 },
	{ name: 'Docusign', pattern: /\bdocusign\b/i, weight: 2 },
	{ name: 'Tableau/Salesforce', pattern: /\b(tableau|salesforce)\b/i, weight: 2 },
	{ name: 'MLB', pattern: /\bmlb\b/i, weight: 2 },
	{ name: 'Cloudflare', pattern: /\bcloudflare\b/i, weight: 2 },
	// Added for the card redesign / discovery-quality pass — sponsors the user
	// specifically expected to see surfaced (Nebius, PayPal) plus adjacent AI-era
	// big names. Weight mirrors the tier of the names already above.
	{ name: 'Nebius', pattern: /\bnebius\b/i, weight: 3 },
	{ name: 'PayPal', pattern: /\bpaypal\b/i, weight: 3 },
	{ name: 'Anthropic', pattern: /\banthropic\b/i, weight: 3 },
	{ name: 'Mistral', pattern: /\bmistral\b/i, weight: 2 },
	{ name: 'Hugging Face', pattern: /\bhugging\s?face\b/i, weight: 2 },
	{ name: 'MLH', pattern: /\b(mlh|major league hacking)\b/i, weight: 2 },
	{ name: 'OpenCV', pattern: /\bopencv\b/i, weight: 2 },
	{ name: 'GitLab', pattern: /\bgitlab\b/i, weight: 2 },
];

/** The highest known-company weight any of the given texts match (0 = none known). */
export function companyWeight(...texts: (string | null | undefined)[]): number {
	const haystack = texts.filter(Boolean).join(' ');
	let weight = 0;
	for (const c of KNOWN_COMPANIES) if (c.pattern.test(haystack) && c.weight > weight) weight = c.weight;
	return weight;
}

// --- Devpost open-contests API: the PRIMARY hackathon list -------------------------
//
// DESIGN (2026-10-13, supersedes "Tavily is the primary source"): which Devpost
// contests are OPEN is answered by Devpost's own public JSON API — the feed the
// devpost.com listing renders from — not by web search. Web search returned
// ended contests (COVIDathon 2020), page chrome ("Devpost for Teams…") and
// subpage duplicates while missing the current big-sponsor events (Amazon,
// Nebius x NVIDIA, PayPal, Meta). The API carries structured open_state, dates,
// prize, registrations, organiser, themes and location, so every card fact is a
// real field — nothing is scraped. This is the old caddie's proven design.
// Tavily keeps two real jobs (see Stage 3/4): searching the OTHER platforms and
// reading each contest's rules page for eligibility.

const DEVPOST_API_URL = 'https://devpost.com/api/hackathons';
/** The API's per-page cap is 40 (probed 2026-10-13: per_page=50 returns 40). */
const DEVPOST_PER_PAGE = 40;
/** Hard ceiling on pages per sweep (40 × 5 = 200 contests) — bounds cost if total_count balloons. */
const DEVPOST_MAX_PAGES = 5;

/** A normalized OPEN, PUBLIC Devpost contest — every field straight from the API. */
export interface DevpostContest {
	readonly title: string;
	readonly url: string;
	readonly organization: string | null;
	/** Devpost's own submission-period text, e.g. "Aug 31 - Oct 23, 2026". */
	readonly dates: string | null;
	/** Display prize text, e.g. "$138,000" / "₹ 100,000"; null when absent or zero. */
	readonly prize: string | null;
	/** Ordering-only USD magnitude of the prize (never displayed as a conversion). */
	readonly prizeUsd: number | null;
	readonly themes: readonly string[];
	readonly registrations: number;
	readonly featured: boolean;
	readonly format: EventFormat | null;
	/** The venue/location text for in-person events; null for online. */
	readonly location: string | null;
}

/**
 * Clean a hackathon title. Page titles from web search read
 * "<title>: <tagline> - Devpost"; the API's own titles are already clean.
 * Strips the " - Devpost" suffix and, only when that suffix was present (the
 * page-title format), a trailing tagline segment — recognised as a sentence
 * (ends in punctuation) or ≥ 5 words — so a real colon title such as
 * "Build, Ship, Shape: Amazon Developer Hackathon" is kept whole.
 */
export function cleanHackathonTitle(raw: string): string {
	let title = raw.replace(/\s+/g, ' ').trim();
	const suffix = /\s*[-|–—]\s*Devpost\s*$/i;
	if (!suffix.test(title)) return title;
	title = title.replace(suffix, '').trim();
	const cut = title.lastIndexOf(': ');
	if (cut > 0) {
		const tail = title.slice(cut + 2).trim();
		const looksLikeTagline = /[.!?]$/.test(tail) || tail.split(/\s+/).length >= 5;
		if (looksLikeTagline) title = title.slice(0, cut).trim();
	}
	return title || raw.trim();
}

/**
 * Normalize one raw API entry. Returns null for anything that is not a real,
 * open, public contest: no title/url, open_state !== 'open', or invite-only.
 */
export function normalizeDevpostContest(raw: DevpostRawHackathon): DevpostContest | null {
	if (!raw.title || !raw.url) return null;
	if (raw.open_state !== 'open' || raw.invite_only) return null;
	const location = (raw.displayed_location?.location ?? '').trim();
	const icon = raw.displayed_location?.icon ?? '';
	const online = icon === 'globe' || /\bonline\b/i.test(location);
	const prizeText = stripHtml(raw.prize_amount ?? null);
	const prizeUsd = parsePrizeUsd(prizeText);
	const hasPrize = prizeUsd !== null && prizeUsd > 0;
	return {
		title: cleanHackathonTitle(raw.title),
		url: normalizeDevpostUrl(raw.url),
		organization: raw.organization_name?.trim() || null,
		dates: raw.submission_period_dates?.trim() || null,
		prize: hasPrize ? prizeText : null,
		prizeUsd: hasPrize ? prizeUsd : null,
		themes: (raw.themes ?? []).map((t) => t?.name?.trim() ?? '').filter(Boolean),
		registrations: typeof raw.registrations_count === 'number' && raw.registrations_count > 0 ? raw.registrations_count : 0,
		featured: raw.featured === true,
		format: online ? 'online' : location ? 'in-person' : null,
		location: online ? null : location || null,
	};
}

/**
 * The one-line card summary, composed ONLY from API fields. It carries the
 * entry count as "N registered" and the format as "Online" / "In person · venue"
 * so the card's chip parsers (dates, prize, participants, format) read real
 * values back out of the stored summary — no schema migration needed.
 */
export function composeContestSummary(c: DevpostContest): string {
	const parts: string[] = [];
	if (c.organization) parts.push(`By ${c.organization}`);
	if (c.dates) parts.push(c.dates);
	if (c.prize) parts.push(`${c.prize} in prizes`);
	if (c.registrations > 0) parts.push(`${c.registrations.toLocaleString('en-US')} registered`);
	if (c.themes.length > 0) parts.push(c.themes.slice(0, 4).join(', '));
	if (c.format === 'online') parts.push('Online');
	else if (c.format === 'in-person') parts.push(c.location ? `In person · ${c.location}` : 'In person');
	return sanitizeSummary(parts.join(' · '), 'Open hackathon on Devpost.', 320);
}

/**
 * Read the organiser and themes back out of a summary built by
 * {@link composeContestSummary}. A web-search snippet does not have that
 * structure, so it yields nulls rather than a guessed organiser or theme.
 */
export function parseComposedSummary(summary: string): { organizer: string | null; themes: readonly string[] } {
	const parts = summary.split(' · ').map((part) => part.trim()).filter(Boolean);
	const composed = parts.some((part) => /^By\s/.test(part) || /\sregistered$/.test(part) || /\sin prizes$/.test(part));
	if (!composed) return { organizer: null, themes: [] };
	const organizer = parts.find((part) => /^By\s/.test(part))?.slice(3).trim() || null;
	const inPersonIndex = parts.indexOf('In person');
	const venueIndex = inPersonIndex >= 0 ? inPersonIndex + 1 : -1; // "In person · <venue>"
	const themePart = parts.find((part, index) =>
		index !== venueIndex && !/^By\s/.test(part) && !/\sregistered$/.test(part) && !/\sin prizes$/.test(part) &&
		!/^(Online|In person)\b/.test(part) && parseEventDates(part).startsAt === null && !/^via\s/.test(part));
	const themes = themePart ? themePart.split(',').map((theme) => theme.trim()).filter(Boolean) : [];
	return { organizer, themes };
}

/** Map a normalized contest to the adapter-raw candidate shape. */
export function candidateFromDevpostContest(c: DevpostContest): RawCandidate {
	const dates = parseEventDates(c.dates);
	return {
		url: c.url,
		title: c.title,
		summary: composeContestSummary(c),
		publishedAt: null,
		requirements: [],
		prizeUsd: c.prizeUsd,
		companyWeight: companyWeight(c.title, c.organization),
		participants: c.registrations > 0 ? c.registrations : null,
		format: c.format,
		startsAt: dates.startsAt,
		endsAt: dates.endsAt,
		deadline: dates.deadline,
	};
}

/**
 * Fetch EVERY open contest from the Devpost API: per_page=40, paged until
 * total_count is reached (bounded by DEVPOST_MAX_PAGES), filtered to open +
 * public, deduped by url. A failed FIRST page throws (the feed records a
 * visible gap); a failed later page stops paging and keeps what was read.
 * Throws when nothing open came back — an empty list is never silently "fine".
 */
export async function fetchOpenDevpostContests(fetchImpl: typeof fetch = fetch): Promise<DevpostContest[]> {
	const seen = new Set<string>();
	const out: DevpostContest[] = [];
	let total = Number.POSITIVE_INFINITY;
	let read = 0;
	for (let page = 1; page <= DEVPOST_MAX_PAGES && read < total; page++) {
		const url = `${DEVPOST_API_URL}?status%5B%5D=open&per_page=${DEVPOST_PER_PAGE}&page=${page}`;
		let body: { hackathons?: DevpostRawHackathon[]; meta?: { total_count?: number } };
		try {
			const res = await fetchImpl(url, {
				headers: { Accept: 'application/json', 'User-Agent': 'caddie-forge' },
				signal: timeoutSignal(DEVPOST_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`Devpost API returned HTTP ${res.status}`);
			body = (await res.json()) as typeof body;
		} catch (error) {
			if (page === 1) throw new Error(`Devpost open-contests API unavailable: ${error instanceof Error ? error.message : String(error)}`);
			break; // partial read: keep what earlier pages returned
		}
		const items = body.hackathons ?? [];
		if (typeof body.meta?.total_count === 'number') total = body.meta.total_count;
		if (items.length === 0) break;
		read += items.length;
		for (const raw of items) {
			const contest = normalizeDevpostContest(raw);
			if (!contest) continue;
			const key = contest.url.toLowerCase().replace(/\/+$/, '');
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(contest);
		}
	}
	if (out.length === 0) throw new Error('Devpost open-contests API returned no open public hackathons.');
	return out;
}

/**
 * The PRIMARY discovery adapter: every open, public Devpost contest from the
 * API, as candidates whose summaries are composed from structured fields.
 * `fetchImpl` is the test seam (unit tests replay a saved API snapshot).
 * `onUnavailable` fires when the API cannot be read, so the Tavily adapter
 * (which runs after this one in the same sweep) can take over Devpost as an
 * explicitly-unverified backup. The error is still rethrown → a visible gap.
 */
export function createDevpostDiscoveryAdapter(
	options: { fetchImpl?: typeof fetch; onUnavailable?: (reason: string) => void } = {},
): DiscoverySourceAdapter {
	return {
		id: 'devpost',
		async fetchCandidates(): Promise<DiscoverySourceBatch> {
			let contests: DevpostContest[];
			try {
				contests = await fetchOpenDevpostContests(options.fetchImpl ?? fetch);
			} catch (error) {
				options.onUnavailable?.(error instanceof Error ? error.message : String(error));
				throw error;
			}
			return { candidates: contests.map(candidateFromDevpostContest) };
		},
	};
}

/**
 * Ranking signals recovered from a STORED candidate (title + composed summary),
 * so ranking works on persisted rows without extra columns. Ordering-only.
 */
export function candidateRankingSignals(title: string, summary: string): {
	readonly companyWeight: number;
	readonly participants: number;
	readonly prizeUsd: number;
} {
	return {
		companyWeight: companyWeight(title, summary),
		participants: parseParticipants(summary) ?? 0,
		prizeUsd: parsePrizeUsd(summary) ?? 0,
	};
}

/**
 * Turn one Tavily search hit into a RawCandidate. Honest field mapping: the
 * summary is the sanitized search snippet (never invented); publishedAt null;
 * requirements []. A Devpost hit only reaches here in BACKUP mode (the Devpost
 * API was unavailable), and its summary then says so up front — its open state
 * comes from web search, not from Devpost.
 */
function candidateFromTavilyHit(hit: TavilySearchResult): RawCandidate {
	const platform = platformLabel(hit.url);
	const snippet = hit.content.trim();
	// Sanitize the raw scraped snippet into readable prose (this is the branch
	// that produced the "Devpost Devpost logo", "||| --- ||" soup on the cards).
	const cleaned = sanitizeSummary(
		snippet,
		platform ? `Open hackathon found on ${platform}.` : 'Open hackathon found via web search.',
	);
	const sourced = platform && snippet ? `${cleaned} · via ${platform}` : cleaned;
	const summary = platform === 'devpost.com' ? `${UNVERIFIED_OPEN_LABEL} · ${sourced}` : sourced;
	// Parse prize/company AND display fields from whatever the snippet carries —
	// a non-feed-matched hit still gets ranking signals and real chips.
	const parseText = `${hit.title} ${snippet}`;
	const dates = parseEventDates(parseText);
	return {
		url: hit.url,
		title: cleanHackathonTitle(hit.title),
		summary,
		publishedAt: null,
		requirements: [],
		prizeUsd: parsePrizeUsd(parseText),
		companyWeight: companyWeight(hit.title, snippet),
		participants: parseParticipants(parseText),
		format: parseFormat(parseText),
		startsAt: dates.startsAt,
		endsAt: dates.endsAt,
		deadline: dates.deadline,
	};
}

/**
 * Reject search hits that are not actual contest pages. A live web search —
 * unlike Devpost's structured `?status=open` feed — also returns help-center
 * articles, docs, blog posts and category/listing pages ("How do I set up the
 * Submission Period?", "Registering for a hackathon"). These are the SEO/noise
 * class the carryover warned about; drop them so a candidate is a real event,
 * not a support article. Conservative: only obvious non-contest hosts/paths are
 * rejected, so a genuine contest is never discarded.
 */
function isLikelyContestHit(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const host = parsed.hostname.toLowerCase();
	// Help/support/docs/blog subdomains are never a contest page.
	if (/^(help|support|docs|blog|info|learn|guides?)\./.test(host)) return false;
	const path = parsed.pathname.toLowerCase().replace(/\/+$/, ''); // trailing slash normalized
	// A BARE host with no path is a platform LANDING PAGE only when the host is a
	// platform ROOT (devpost.com, mlh.io) — the "Devpost - home for hackathons"
	// noise from the live transcript. On a contest SUBDOMAIN
	// (uncommon-hacks-2026.devpost.com) the bare host IS the event, so keep it.
	const bareHost = path === '' || path === '/';
	const isPlatformRoot = (HACKATHON_DOMAINS as readonly string[]).includes(host.replace(/^www\./, ''));
	if (bareHost && isPlatformRoot) return false;
	// ALWAYS non-contest, on any host: help centers, auth, generic docs/blog,
	// category and article pages. These are never an event page.
	const NON_CONTEST_ANYWHERE = [
		'/help', '/support', '/docs', '/blog', '/faq', '/about', '/pricing', '/login', '/signup',
		'/c/', '/categories', '/articles', '/hc/', '/settings', '/users',
	];
	if (NON_CONTEST_ANYWHERE.some((seg) => path === seg || path.startsWith(seg + '/') || path.startsWith(seg))) return false;
	// LISTING / DIRECTORY / SEARCH index pages ("/hackathons", "/software/search",
	// "/discover", "/explore") are index pages ONLY on a PLATFORM ROOT host
	// (devpost.com/hackathons). On a contest SUBDOMAIN the same segment can be
	// part of the event's own path, so do NOT drop it there — that over-drop was
	// discarding known-open events the user expected to see.
	if (isPlatformRoot) {
		const NON_CONTEST_PLATFORM = ['/hackathons', '/software', '/search', '/portfolio', '/discover', '/explore'];
		if (NON_CONTEST_PLATFORM.some((seg) => path === seg || path.startsWith(seg + '/') || path.startsWith(seg))) return false;
	}
	return true;
}

/**
 * True when an event's text carries a date RANGE that has already closed.
 * Only a range end counts: a lone date in a web snippet ("posted Sep 1") is
 * not evidence the event ended, so it never hides one.
 */
export function isPastEvent(text: string | null | undefined, now: Date = new Date()): boolean {
	const { endsAt } = parseEventDates(text);
	return endsAt !== null && endsAt < now.toISOString().slice(0, 10);
}

/** Path segments that mark a project / listing / subpage / report — never one event's own page. */
const NON_EVENT_SEGMENTS = new Set([
	'buidl', 'build', 'milestones', 'hackers', 'report', 'seasons', 'event-membership', 'lp', 'custom-tab',
	'faq', 'submission-format', 'info', 'start', 'projects', 'submissions', 'leaderboard', 'discussion',
]);
/** A path ENDING in one of these is a directory of events, not an event. */
const LISTING_LAST_SEGMENTS = new Set(['hackathon', 'hackathons', 'challenges', 'competitions', 'events', 'open', 'compete']);
/** Titles of directory, schedule, project and report pages the web search returns. */
const NON_EVENT_TITLES: readonly RegExp[] = [
	/\|\s*buidls?\b/i, /\bseason schedule\b/i, /^open hackathons\b/i, /^compete\s*\|/i, /\bhackathon report\b/i,
	/^kaggle competitions$/i, /^upcoming hackathon prizes\b/i, /^join the mlh\b/i, /^hackathons for\b/i,
];

/**
 * Each platform's event-page URL shape: true = an event page, false = some
 * other page on that platform, null = a host with no known shape.
 */
function platformEventShape(host: string, segments: readonly string[]): boolean | null {
	const sub = (root: string) => host.endsWith(`.${root}`) && host !== `www.${root}`;
	if (host === 'devfolio.co' || sub('devfolio.co')) return sub('devfolio.co') && segments.length === 0;
	if (host === 'devpost.com' || sub('devpost.com')) return sub('devpost.com') && segments.length === 0;
	if (host.endsWith('dorahacks.io')) {
		return segments[0] === 'hackathon' && (segments.length === 2 || (segments.length === 3 && segments[2] === 'detail'));
	}
	if (host.endsWith('ethglobal.com')) return segments[0] === 'events' && segments.length === 2;
	if (host.endsWith('kaggle.com')) return segments[0] === 'competitions' && segments.length >= 2;
	if (host === 'hackerearth.com' || host.endsWith('.hackerearth.com')) {
		if (sub('hackerearth.com')) return segments.length === 0;
		const rest = segments[0] === 'community' ? segments.slice(1) : segments;
		return rest[0] === 'challenges' && rest.length === 3;
	}
	return null;
}

/**
 * Keep a web-search hit only when it is ONE event's own page that is not
 * obviously over: help/docs noise (isLikelyContestHit), project pages
 * (DoraHacks "Buidls"), directory/schedule pages (MLH seasons, Devfolio
 * "/hackathons/open", the Kaggle index), subpages (/faq, /hackers, /report),
 * pages whose newest year is already past, and events whose date range closed.
 * MLH is a directory of other hosts' events; it never hosts an event page.
 */
export function isLikelyEventPage(input: {
	url: string;
	title: string;
	text?: string | null;
	now?: Date;
}): boolean {
	if (!isLikelyContestHit(input.url)) return false;
	let parsed: URL;
	try {
		parsed = new URL(input.url);
	} catch {
		return false;
	}
	const now = input.now ?? new Date();
	const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
	const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean);
	const title = input.title.replace(/[\u200b-\u200d\ufeff]/g, '').trim();
	if (title.length < 3 || NON_EVENT_TITLES.some((pattern) => pattern.test(title))) return false;
	if (host === 'mlh.io' || host.endsWith('.mlh.io') || host.startsWith('resources.')) return false;
	if (segments.some((segment) => NON_EVENT_SEGMENTS.has(segment))) return false;
	if (segments.length > 0 && LISTING_LAST_SEGMENTS.has(segments[segments.length - 1]!)) return false;
	if (platformEventShape(host, segments) === false) return false;
	const years = [...`${title} ${input.url}`.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((m) => Number(m[1]));
	if (years.length > 0 && Math.max(...years) < now.getUTCFullYear()) return false;
	return !isPastEvent(`${title} ${input.text ?? ''}`, now);
}

/** Prefix on every Devpost candidate found by web search in BACKUP mode. */
export const UNVERIFIED_OPEN_LABEL = 'Open status unverified (Devpost API unavailable)';

/**
 * The Tavily breadth {@link DiscoverySourceAdapter}: a domain-scoped web search
 * of the platforms the Devpost API does not cover ({@link OTHER_PLATFORM_DOMAINS}).
 * Its own Devpost hits are DROPPED — the API is authoritative for Devpost.
 *
 * BACKUP: when `devpostBackup()` returns true at sweep time (the Devpost API
 * adapter, which runs first, reported itself unavailable), this sweep ALSO
 * searches devpost.com (plus the big-sponsor query) and keeps those hits,
 * each labelled {@link UNVERIFIED_OPEN_LABEL}. Throws when no key is configured
 * ({@link TavilyNotConfiguredError}) or the search fails — runDiscoveryFeed
 * records either as a visible named gap. Never returns a silent empty list.
 */
export function createTavilyDiscoveryAdapter(options: {
	tavilyApiKey?: string;
	/** Profile interests/skills — add topic-targeted queries alongside the generic sweep. */
	terms?: readonly string[];
	/** Profile country — adds one locality query (does not filter; a locality hint only). */
	country?: string | null;
	/** Read at sweep time: true → Devpost API is down, so web-search Devpost too. */
	devpostBackup?: () => boolean;
}): DiscoverySourceAdapter {
	return {
		id: 'tavily',
		async fetchCandidates(): Promise<DiscoverySourceBatch> {
			if (!options.tavilyApiKey) throw new TavilyNotConfiguredError();
			const backup = options.devpostBackup?.() === true;
			const domains = backup ? HACKATHON_DOMAINS : OTHER_PLATFORM_DOMAINS;
			const queries = buildDiscoveryQueries({ terms: options.terms, country: options.country, sponsorSweep: backup });
			// Run the query set sequentially. A single query failing throws (the
			// whole sweep is a visible gap); breadth comes from MERGING all
			// queries' hits and deduping by url across them.
			const hitsByUrl = new Map<string, TavilySearchResult>();
			for (const query of queries) {
				const hits = await tavilySearch(options.tavilyApiKey, query, {
					includeDomains: domains,
					searchDepth: 'advanced',
					maxResults: 30,
				});
				for (const hit of hits) {
					const key = hit.url.toLowerCase();
					// First query to surface a url wins its (usually higher) ranking;
					// later queries only ADD new urls, never overwrite.
					if (!hitsByUrl.has(key)) hitsByUrl.set(key, hit);
				}
			}
			const seen = new Set<string>();
			const candidates: RawCandidate[] = [];
			for (const hit of hitsByUrl.values()) {
				// One event's own page only: drops help/docs noise, project pages,
				// directories, subpages, stale-year pages and closed date ranges.
				if (!isLikelyEventPage({ url: hit.url, title: hit.title, text: hit.content })) continue;
				// Devpost is the API's job; a web-search Devpost hit is kept ONLY as backup.
				if (!backup && platformLabel(hit.url) === 'devpost.com') continue;
				// Drop ENDED events. Conservative — only an explicit ended signal in
				// the hit's own text closes it; an unknown-state event is kept.
				if (isEndedHackathon({ text: `${hit.title} ${hit.content}` })) continue;
				const candidate = candidateFromTavilyHit(hit);
				// Dedup by CANONICAL url (collapses tracking-param and trailing-slash
				// variants of the same event). Fail-soft to the lowercased url when a
				// url cannot be canonicalized, so a weird-but-valid hit is never lost.
				let key: string;
				try {
					key = canonicalizeUrl(candidate.url).toLowerCase();
				} catch {
					key = candidate.url.toLowerCase();
				}
				if (seen.has(key)) continue;
				seen.add(key);
				candidates.push(candidate);
			}
			if (candidates.length === 0) {
				throw new Error(
					backup
						? 'Tavily backup search returned no usable hackathon results (Devpost API was also unavailable).'
						: 'Tavily found no open events on the other platforms (Devfolio, HackerEarth, DoraHacks, ETHGlobal, Kaggle) this sweep.',
				);
			}
			return { candidates };
		},
	};
}

// --- the feed -----------------------------------------------------------------------

/**
 * Run the candidate feed: execute every adapter, record each source's outcome
 * (a thrown adapter becomes a named FAILED gap with its reason — a partial
 * failure is visible, never silently dropped), and ingest candidates under
 * their derived ids. Ingest is idempotent per (project, source, url): re-runs
 * land on the same rows.
 *
 * A candidate whose URL cannot be canonicalized fails its whole source run —
 * the failure is visible at the source level rather than a junk row slipping
 * through with a guessed identity.
 */
export async function runDiscoveryFeed(
	db: D1Database,
	scope: Scope,
	options: { adapters: readonly DiscoverySourceAdapter[] },
): Promise<DiscoveryFeedRecord> {
	const verified = await assertProjectScope(db, scope);
	const feedRunId = newId('feed');
	const requestedAt = nowIso();
	await db
		.prepare(
			'insert into "discovery_feed_runs" ("id","projectId","requestedBy","requestedAt","candidateCount") values (?,?,?,?,0)',
		)
		.bind(feedRunId, verified.projectId, verified.actorId, requestedAt)
		.run();

	const derivedIds: string[] = [];
	let totalSeen = 0;
	for (const adapter of options.adapters) {
		const sourceStartedAt = nowIso();
		let seen = 0;
		let failureReason: string | null = null;
		try {
			const batch = await adapter.fetchCandidates({ projectId: verified.projectId });
			for (const raw of batch.candidates) {
				const canonicalUrl = canonicalizeUrl(raw.url); // throws -> source-level failure, no junk rows
				const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fail(400, 'invalid_input', 'candidate title is required');
				const summary =
					typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : fail(400, 'invalid_input', 'candidate summary is required');
				const id = await deriveCandidateId(adapter.id, canonicalUrl);
				// Upsert: a re-seen candidate keeps its identity, status, saved flag
				// and first-seen run, but its TITLE/SUMMARY refresh — registration
				// counts, dates and prizes change between sweeps, and a frozen
				// first-ever summary (insert-or-ignore) would show stale facts forever.
				await db
					.prepare(
						'insert into "discovery_candidates" ' +
							'("id","projectId","source","url","title","summary","publishedAt","requirementsJson","status","feedRunId","firstSeenAt","updatedAt") ' +
							'values (?,?,?,?,?,?,?,?,?,?,?,?) ' +
							'on conflict ("id","projectId") do update set "title" = excluded."title", "summary" = excluded."summary", "updatedAt" = excluded."updatedAt"',
					)
					.bind(
						id,
						verified.projectId,
						adapter.id,
						canonicalUrl,
						title,
						summary,
						raw.publishedAt ?? null,
						JSON.stringify(raw.requirements ?? []),
						'new',
						feedRunId,
						requestedAt,
						requestedAt,
					)
					.run();
				if (!derivedIds.includes(id)) derivedIds.push(id);
				seen += 1;
			}
		} catch (error) {
			failureReason = error instanceof Error ? error.message : String(error);
		}
		totalSeen += seen;
		await db
			.prepare(
				'insert into "discovery_feed_sources" ' +
					'("id","feedRunId","projectId","source","outcome","failureReason","candidateCount","completedAt") ' +
					'values (?,?,?,?,?,?,?,?)',
			)
			.bind(
				newId('feedsrc'),
				feedRunId,
				verified.projectId,
				adapter.id,
				failureReason === null ? 'succeeded' : 'failed',
				failureReason,
				seen,
				sourceStartedAt,
			)
			.run();
	}

	await db
		.prepare('update "discovery_feed_runs" set "candidateCount" = ? where "id" = ? and "projectId" = ?')
		.bind(totalSeen, feedRunId, verified.projectId)
		.run();

	return (await getFeedRun(db, verified, feedRunId, derivedIds))!;
}

/**
 * One feed run with its per-source outcomes (the gaps) and its candidates, or
 * null. `derivedIds` (set by {@link runDiscoveryFeed}) lists the candidates
 * THIS run derived ids for: on a re-run nothing new is stored (the row keeps
 * its first-seen run), but the run still reports the candidates it saw.
 */
export async function getFeedRun(
	db: D1Database,
	scope: Scope,
	feedRunId: string,
	derivedIds?: readonly string[],
): Promise<DiscoveryFeedRecord | null> {
	const verified = await assertProjectScope(db, scope);
	if (typeof feedRunId !== 'string' || feedRunId.length === 0) {
		fail(400, 'invalid_request', 'feedRunId is required');
	}
	const runs = await queryAll(
		db,
		'select * from "discovery_feed_runs" where "id" = ? and "projectId" = ?',
		feedRunId,
		verified.projectId,
	);
	const run = runs[0];
	if (!run) return null;
	const sourceRows = await queryAll(
		db,
		'select * from "discovery_feed_sources" where "feedRunId" = ? and "projectId" = ? order by "completedAt" asc, "id" asc',
		feedRunId,
		verified.projectId,
	);
	const candidateRows =
		derivedIds && derivedIds.length > 0
			? await queryAll(
					db,
					`select * from "discovery_candidates" where "projectId" = ? and "id" in (${derivedIds.map(() => '?').join(', ')}) ` +
						'order by "firstSeenAt" asc, "id" asc',
					verified.projectId,
					...derivedIds,
				)
			: await queryAll(
					db,
					'select * from "discovery_candidates" where "feedRunId" = ? and "projectId" = ? order by "firstSeenAt" asc, "id" asc',
					feedRunId,
					verified.projectId,
				);
	return {
		id: String(run['id']),
		projectId: String(run['projectId']),
		requestedBy: String(run['requestedBy']),
		requestedAt: String(run['requestedAt']),
		sources: sourceRows.map((row) => ({
			id: String(row['id']),
			feedRunId: String(row['feedRunId']),
			source: String(row['source']),
			outcome: String(row['outcome']) as FeedSourceOutcome,
			failureReason: row['failureReason'] == null ? null : String(row['failureReason']),
			candidateCount: Number(row['candidateCount']),
			completedAt: String(row['completedAt']),
		})),
		candidates: candidateRows.map(candidateFromRow),
	};
}

/** The project's feed runs, newest first (records only; use getFeedRun for detail). */
export async function listFeedRuns(db: D1Database, scope: Scope): Promise<DiscoveryFeedRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select "id" from "discovery_feed_runs" where "projectId" = ? order by "requestedAt" desc, "id" asc',
		verified.projectId,
	);
	const out: DiscoveryFeedRecord[] = [];
	for (const row of rows) {
		const record = await getFeedRun(db, verified, String(row['id']));
		if (record) out.push(record);
	}
	return out;
}

// --- candidates -----------------------------------------------------------------------

export async function listCandidates(db: D1Database, scope: Scope): Promise<CandidateRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "discovery_candidates" where "projectId" = ? order by "firstSeenAt" desc, "id" asc',
		verified.projectId,
	);
	return rows.map(candidateFromRow);
}

/**
 * One project-scoped candidate, or 404. The stored id is re-checked against
 * its (source, url) derivation on every read: a row whose identity does not
 * match its content is refused rather than served.
 */
export async function getCandidate(db: D1Database, scope: Scope, candidateId: string): Promise<CandidateRecord> {
	const verified = await assertProjectScope(db, scope);
	if (typeof candidateId !== 'string' || candidateId.length === 0) {
		fail(400, 'invalid_request', 'candidateId is required');
	}
	const rows = await queryAll(
		db,
		'select * from "discovery_candidates" where "id" = ? and "projectId" = ?',
		candidateId,
		verified.projectId,
	);
	const row = rows[0];
	if (!row) fail(404, 'candidate_not_found', 'no such candidate in this project');
	await assertCandidateId(String(row!['id']), String(row!['source']), String(row!['url']));
	return candidateFromRow(row!);
}

/** Mark a candidate accepted (the id must be the derived identity — see assertCandidateId). */
export async function acceptCandidate(db: D1Database, scope: Scope, candidateId: string): Promise<CandidateRecord> {
	const candidate = await getCandidate(db, scope, candidateId);
	await db
		.prepare('update "discovery_candidates" set "status" = \'accepted\', "updatedAt" = ? where "id" = ? and "projectId" = ?')
		.bind(nowIso(), candidate.id, scope.projectId)
		.run();
	return getCandidate(db, scope, candidateId);
}

/**
 * B01 — save/unsave a candidate WITHOUT accepting it (HANDOFF §8.1).
 * `savedAt` is its own axis: saving bookmarks the candidate on the project's
 * shortlist and never touches `status`, never creates a project, and never
 * starts a run. Unsave clears the bookmark.
 */
export async function saveCandidate(db: D1Database, scope: Scope, candidateId: string): Promise<CandidateRecord> {
	const candidate = await getCandidate(db, scope, candidateId);
	await db
		.prepare('update "discovery_candidates" set "savedAt" = ?, "updatedAt" = ? where "id" = ? and "projectId" = ?')
		.bind(nowIso(), nowIso(), candidate.id, scope.projectId)
		.run();
	return getCandidate(db, scope, candidateId);
}

export async function unsaveCandidate(db: D1Database, scope: Scope, candidateId: string): Promise<CandidateRecord> {
	const candidate = await getCandidate(db, scope, candidateId);
	await db
		.prepare('update "discovery_candidates" set "savedAt" = NULL, "updatedAt" = ? where "id" = ? and "projectId" = ?')
		.bind(nowIso(), candidate.id, scope.projectId)
		.run();
	return getCandidate(db, scope, candidateId);
}

/** The project's saved shortlist, newest saved first. Project-scoped by the
 *  same scope checks as every other candidate read. */
export async function listSavedCandidates(db: D1Database, scope: Scope): Promise<CandidateRecord[]> {
	await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "discovery_candidates" where "projectId" = ? and "savedAt" is not null order by "savedAt" desc, "id" asc',
		scope.projectId,
	);
	return rows.map(candidateFromRow);
}

// --- explainable fit --------------------------------------------------------------------

/**
 * Compute the explainable fit for one candidate against the project's P10
 * evidence. Each requirement maps to a claim type; the P10 authority
 * reconciliation decides what the project's evidence currently says:
 *
 *   - a reconciled winner    → 'supported', citing that claim id;
 *   - a retained conflict    → 'conflict', citing the conflicting claim ids;
 *   - no stored evidence     → 'unknown' with a recorded assumption — nothing
 *     is invented and no claim is fabricated.
 */
export async function computeFit(db: D1Database, scope: Scope, candidate: CandidateRecord): Promise<FitResult> {
	await assertProjectScope(db, scope);
	const claims: FitClaim[] = [];
	for (const requirement of candidate.requirements) {
		const surveys = await surveyClaims(db, scope, { claimType: requirement.claimType });
		const survey = surveys.find((s) => s.claimType === requirement.claimType);
		if (survey?.conflict) {
			claims.push({
				requirement: requirement.text,
				claimType: requirement.claimType,
				verdict: 'conflict',
				statement: `equal-authority evidence disagrees about ${requirement.claimType} — retained conflict, not auto-resolved`,
				evidenceClaimIds: [...survey.conflict.claimIds],
				assumptions: ['the conflict must be resolved against the sources before this requirement is treated as met'],
			});
			continue;
		}
		if (survey?.winner) {
			const winner: ReconciliationClaim = survey.winner;
			claims.push({
				requirement: requirement.text,
				claimType: requirement.claimType,
				verdict: 'supported',
				statement: `stored evidence: ${requirement.claimType} = ${winner.value}`,
				evidenceClaimIds: [winner.claimId],
				assumptions: [],
			});
			continue;
		}
		claims.push({
			requirement: requirement.text,
			claimType: requirement.claimType,
			verdict: 'unknown',
			statement: `no stored evidence for ${requirement.claimType}`,
			evidenceClaimIds: [],
			assumptions: [`the project holds no evidence claim of type ${requirement.claimType} — capture the rule before treating this as met`],
		});
	}
	return {
		candidateId: candidate.id,
		matchedRequirements: claims.filter((c) => c.verdict === 'supported').length,
		claims,
		fitVersion: FIT_VERSION,
	};
}

// --- eligibility read-model --------------------------------------------------------------

/**
 * Evaluate a candidate's eligibility from the project's quoted rules (P10
 * claims of type `eligibility.*`) and the caller-supplied profile. All rule
 * inputs are quoted claims — there is no prompt channel (eligibility.ts).
 */
export async function evaluateCandidateEligibility(
	db: D1Database,
	scope: Scope,
	candidate: CandidateRecord,
	profile: EligibilityProfile,
): Promise<EligibilityEvaluation> {
	await assertProjectScope(db, scope);
	// Only THIS event's quoted rules decide its eligibility. Using every claim
	// in the project let one event's rule (another event's age minimum or
	// country list) leak into a different event's detail pane.
	const [all, sources, candidates] = await Promise.all([listClaims(db, scope), listSources(db, scope), listCandidates(db, scope)]);
	const sourceUrls = authoritativeSourceUrls(sources);
	// A claim decides THIS event's eligibility when it comes from an
	// authoritative rules source (binding_rules / organizer_message / official_*)
	// AND that source's URL is scoped to this candidate — either it belongs to
	// the candidate's own page tree (same origin + /rules|/faq subpage), OR it
	// belongs to NO candidate in the project at all. The second case covers an
	// authoritative rules page hosted on a SEPARATE domain (e.g. rules.example):
	// since claims are project-scoped and that host maps to no event here, it
	// can only be describing this project's work, so it applies rather than
	// being silently dropped. A same-origin /design/rules page that DOES belong
	// to the "Design" candidate is therefore NOT applied to the "Education"
	// candidate — which is the cross-event isolation the detail pane relies on.
	const authoritativeSourceIds = new Set(sourceUrls.keys());
	const candidateUrls = candidates.map((c) => c.url);
	const appliesHere = (claim: { readonly sourceId: string }): boolean => {
		if (!authoritativeSourceIds.has(claim.sourceId)) return false;
		const sourceUrl = sourceUrls.get(claim.sourceId) ?? '';
		if (belongsToCandidate(sourceUrl, candidate.url)) return true;
		// A standalone rules host belongs to no candidate's page tree.
		return !candidateUrls.some((url) => belongsToCandidate(sourceUrl, url));
	};
	const ruleClaims: EligibilityRuleClaim[] = all
		.filter((claim) => claim.status === 'active' && claim.claimType.startsWith('eligibility.'))
		.filter(appliesHere)
		.map((claim) => ({
			claimId: claim.id,
			claimType: claim.claimType,
			value: claim.value,
			quote: claim.quote,
		}));
	return evaluateEligibility(ruleClaims, profile);
}

/** Source authorities whose quoted rules may decide an event's eligibility. */
const AUTHORITATIVE_RULE_SOURCES = ['binding_rules', 'organizer_message', 'official_faq', 'official_overview'];

/** sourceId → canonical url, for the authoritative sources only. */
export function authoritativeSourceUrls(
	sources: readonly { readonly id: string; readonly authority: string; readonly canonicalUrl: string }[],
): Map<string, string> {
	return new Map(sources.filter((s) => AUTHORITATIVE_RULE_SOURCES.includes(s.authority)).map((s) => [s.id, s.canonicalUrl]));
}

/** Restrict quoted rules to this event's URL or explicit rules/FAQ subpage.
 * A claim about a different event must never decide this candidate's eligibility. */
export function belongsToCandidate(sourceUrl: string, candidateUrl: string): boolean {
	try {
		const source = new URL(sourceUrl);
		const candidate = new URL(candidateUrl);
		if (source.origin !== candidate.origin || source.search !== candidate.search) return false;
		const path = (url: URL) => url.pathname.replace(/\/+$/, '');
		const root = path(candidate);
		return path(source) === root || ['rules', 'faq', 'requirements', 'guidelines'].some((part) => path(source) === `${root}/${part}`);
	} catch { return false; }
}

/** One candidate's full read model for the UI: fit + eligibility, both explainable. */
export interface CandidateEvaluation {
	readonly candidate: CandidateRecord;
	readonly fit: FitResult;
	readonly eligibility: EligibilityEvaluation;
}

export async function evaluateCandidate(
	db: D1Database,
	scope: Scope,
	candidateId: string,
	profile: EligibilityProfile,
): Promise<CandidateEvaluation> {
	const candidate = await getCandidate(db, scope, candidateId);
	const [fit, eligibility] = await Promise.all([
		computeFit(db, scope, candidate),
		evaluateCandidateEligibility(db, scope, candidate, profile),
	]);
	return { candidate, fit, eligibility };
}

// --- candidate detail (detail pane) ------------------------------------------------------

/** One verbatim rule in the detail pane, grouped under a human kind. */
export interface CandidateDetailClaim {
	readonly claimId: string;
	readonly claimType: string;
	readonly quote: string;
	readonly verdict: 'eligible' | 'ineligible' | 'unknown';
	readonly reason: string;
}

/** A kind-grouped bundle of verbatim rules (Tier 2 of the pane). */
export interface CandidateDetailGroup {
	readonly kind: 'who_can_enter' | 'deadlines' | 'must_do' | 'fit' | 'other';
	readonly label: string;
	readonly claims: readonly CandidateDetailClaim[];
}

/** The full detail model the pane renders: evaluation + AI digest + grouped verbatim rules. */
export interface CandidateDetail {
	readonly candidate: CandidateRecord;
	readonly fit: FitResult;
	readonly eligibility: EligibilityEvaluation;
	/** Tier 1: the AI digest, or null when it could not run (gap explains why). */
	readonly digest: CandidateDigest | null;
	/** A visible gap when the digest could not run; null when it ran. */
	readonly digestGap: string | null;
	/**
	 * True when the caller asked to defer the digest and none is cached yet: the
	 * rules are returned now and the digest is fetched separately (it is a slow
	 * model call). False whenever `digest`/`digestGap` are final.
	 */
	readonly digestPending: boolean;
	/** Tier 2: verbatim rules grouped by kind. */
	readonly groups: readonly CandidateDetailGroup[];
}

const DETAIL_KIND_LABEL: Record<CandidateDetailGroup['kind'], string> = {
	who_can_enter: 'Who can enter',
	deadlines: 'Deadlines',
	must_do: 'What you must do',
	fit: 'Why it fits',
	other: 'Other clauses',
};

/** Map an eligibility.* claim type to a detail group kind. */
function eligibilityKind(claimType: string): CandidateDetailGroup['kind'] {
	if (
		claimType === 'eligibility.open_countries' ||
		claimType === 'eligibility.restricted_countries' ||
		claimType === 'eligibility.min_age' ||
		claimType === 'eligibility.student_only'
	) {
		return 'who_can_enter';
	}
	if (claimType.includes('deadline')) return 'deadlines';
	return 'other';
}

/**
 * The detail model for the pane. Reuses evaluateCandidate (fit + eligibility),
 * groups the verbatim eligibility rules by kind, and layers an AI digest on top.
 * The digest is fail-soft (null + gap on failure); the verbatim groups are the
 * source of truth and never depend on the model.
 */
export async function candidateDetail(
	db: D1Database,
	scope: Scope,
	candidateId: string,
	profile: EligibilityProfile,
	digestApiKey: string | undefined,
	/** Full stored profile facts for the digest's fit-track inference; absent → country only. */
	digestProfileInput?: InspectionProfile,
	/**
	 * When true, a cache MISS does not run the (slow, ~30s) digest model call:
	 * the rules come back immediately with `digestPending: true` and the client
	 * fetches the digest separately. A cache HIT is still returned inline.
	 */
	options?: { readonly deferDigest?: boolean },
): Promise<CandidateDetail> {
	const { candidate, fit, eligibility } = await evaluateCandidate(db, scope, candidateId, profile);

	// Tier 2: group the verbatim eligibility rule outcomes, then append the
	// supported fit claims as a "Why it fits" group.
	const byKind = new Map<CandidateDetailGroup['kind'], CandidateDetailClaim[]>();
	for (const outcome of eligibility.rules) {
		const kind = eligibilityKind(outcome.claimType);
		const list = byKind.get(kind) ?? [];
		list.push({
			claimId: outcome.claimId,
			claimType: outcome.claimType,
			quote: outcome.quote,
			verdict: outcome.verdict,
			reason: outcome.reason,
		});
		byKind.set(kind, list);
	}
	const fitClaims = fit.claims
		.filter((claim) => claim.verdict === 'supported')
		.map((claim) => ({
			claimId: claim.evidenceClaimIds[0] ?? claim.claimType,
			claimType: claim.claimType,
			quote: claim.statement,
			verdict: 'unknown' as const,
			reason: claim.requirement,
		}));
	if (fitClaims.length > 0) byKind.set('fit', fitClaims);

	const order: CandidateDetailGroup['kind'][] = ['who_can_enter', 'deadlines', 'must_do', 'fit', 'other'];
	const groups: CandidateDetailGroup[] = order
		.filter((kind) => (byKind.get(kind)?.length ?? 0) > 0)
		.map((kind) => ({ kind, label: DETAIL_KIND_LABEL[kind], claims: byKind.get(kind)! }));

	// Tier 1: the AI digest. CACHED per candidate so opening a hackathon does
	// NOT re-run the model every time (reference caddie's saveDigest pattern).
	// The cache key is a hash of the content the digest is grounded in; a
	// changed summary (re-ingest) OR a newly-read overview page invalidates it
	// and triggers one recompute.
	const facts: string[] = [];
	if (eligibility.verdict) facts.push(`eligibility verdict: ${eligibility.verdict}`);
	for (const outcome of eligibility.rules.slice(0, 6)) facts.push(outcome.quote);
	// The event's overview prose (read by the rules sweep into the evidence
	// store with 'official_overview' authority). When present it is the primary
	// material the digest is written from — the thin composed summary is only
	// the fallback. A fresh overview changes the hash → one recompute.
	const overview = await readOverviewText(db, scope, candidate.url);
	const digestProfile: InspectionProfile = digestProfileInput ?? { country: profile.country };
	const contentHash = await digestContentHash(candidate, facts, overview, digestProfile);

	let digest: CandidateDigest | null = null;
	let digestGap: string | null = null;
	let digestPending = false;
	const cached = await getCachedDigest(db, scope, candidate.id, contentHash);
	if (cached) {
		// Cache hit on the same content — reuse, no model call.
		digest = cached;
	} else if (options?.deferDigest) {
		// Rules first: the client fetches the digest in a second request.
		digestPending = true;
	} else {
		const computed = await digestCandidate({
			apiKey: digestApiKey,
			profile: digestProfile,
			candidate: { id: candidate.id, url: candidate.url, title: candidate.title, summary: candidate.summary },
			facts,
			overview,
		});
		digest = computed.digest;
		digestGap = computed.gap;
		// Store only a real digest — a fail-soft gap is not cached, so the next
		// open retries (e.g. once the model key is configured).
		if (digest) await putCachedDigest(db, scope, candidate.id, contentHash, digest);
	}

	return { candidate, fit, eligibility, digest, digestGap, digestPending, groups };
}

/**
 * The event's OVERVIEW prose from the evidence store — the main detail page the
 * rules sweep read with 'official_overview' authority. Used as rich digest
 * input (reference-caddie's full-page-text model). Returns null when no
 * overview source has been read for this candidate yet, so the digest falls
 * back to summary + facts. Fail-soft: a missing snapshot reads as null.
 */
/**
 * The digest cache key: everything the digest is grounded in. DIGEST_VERSION
 * makes a prompt/shape change rebuild every cached digest once; the profile is
 * included because "tracks that fit you" depends on it, so a profile edit
 * recomputes instead of showing fit picks for the old profile. Shared by
 * candidateDetail and prewarmDigest so a pre-warmed entry is a cache hit.
 */
async function digestContentHash(
	candidate: { title: string; summary: string },
	facts: readonly string[],
	overview: string | null,
	digestProfile: InspectionProfile,
): Promise<string> {
	return sha256Hex(
		`${DIGEST_VERSION}\n${candidate.title}\n${candidate.summary}\n${facts.join('\n')}\n` +
			`${overview ? `overview:${await sha256Hex(overview)}` : ''}\nprofile:${JSON.stringify(digestProfile)}`,
	);
}

async function readOverviewText(db: D1Database, scope: Scope, candidateUrl: string): Promise<string | null> {
	const overviewUrl = overviewUrlFor(candidateUrl);
	if (!overviewUrl) return null;
	const canonical = canonicalizeUrl(overviewUrl);
	const sources = await listSources(db, scope);
	const source = sources.find((s) => s.authority === 'official_overview' && s.canonicalUrl === canonical);
	if (!source?.latestSnapshotId) return null;
	try {
		const snapshot = await getSnapshot(db, scope, source.latestSnapshotId);
		return snapshot.content.trim() ? snapshot.content : null;
	} catch {
		return null; // a missing/removed snapshot reads as "no overview", never throws
	}
}

/** Read a cached digest for (candidate, contentHash); null on miss or stale hash. */
async function getCachedDigest(
	db: D1Database,
	scope: Scope,
	candidateId: string,
	contentHash: string,
): Promise<CandidateDigest | null> {
	const rows = await queryAll(
		db,
		'select "digestJson" from "discovery_digests" where "candidateId" = ? and "projectId" = ? and "contentHash" = ?',
		candidateId,
		scope.projectId,
		contentHash,
	);
	const row = rows[0];
	if (!row) return null;
	try {
		return JSON.parse(String(row['digestJson'])) as CandidateDigest;
	} catch {
		return null; // a corrupt cache row reads as a miss, never throws
	}
}

/** Replace-on-write: one digest row per candidate, latest content wins. */
async function putCachedDigest(
	db: D1Database,
	scope: Scope,
	candidateId: string,
	contentHash: string,
	digest: CandidateDigest,
): Promise<void> {
	await db
		.prepare(
			'insert into "discovery_digests" ("candidateId","projectId","contentHash","digestJson","computedAt") ' +
				'values (?,?,?,?,?) ' +
				'on conflict("candidateId","projectId") do update set ' +
				'"contentHash" = excluded."contentHash", "digestJson" = excluded."digestJson", "computedAt" = excluded."computedAt"',
		)
		.bind(candidateId, scope.projectId, contentHash, JSON.stringify(digest), nowIso())
		.run();
}

/**
 * Pre-warm the AI digest cache for ONE candidate so the first detail-open is
 * instant (no model call on open). Mirrors candidateDetail's digest path EXACTLY
 * — same facts, same content hash, same cache row — so a pre-warmed digest is a
 * guaranteed cache HIT when candidateDetail runs. The ONE difference is the
 * overview source: here it is the text the rules sweep JUST read (passed in),
 * so pre-warm works on the very first feed run, before readOverviewText could
 * see the new snapshot. Fail-soft: a cache hit, no overview, or a digest
 * failure all leave the cache untouched and never throw.
 *
 * digestApiKey undefined (no model key) short-circuits before any work.
 */
export async function prewarmDigest(
	db: D1Database,
	scope: Scope,
	candidate: { id: string; url: string; title: string; summary: string },
	profile: EligibilityProfile,
	overview: string | null,
	digestApiKey: string | undefined,
	/** Same profile facts candidateDetail passes, so the pre-warmed hash matches. */
	digestProfileInput?: InspectionProfile,
): Promise<boolean> {
	if (!digestApiKey) return false;
	try {
		// Same facts candidateDetail grounds the digest in (eligibility verdict +
		// quoted rules), so the content hash matches and the open is a cache hit.
		const { eligibility } = await evaluateCandidate(db, scope, candidate.id, profile);
		const facts: string[] = [];
		if (eligibility.verdict) facts.push(`eligibility verdict: ${eligibility.verdict}`);
		for (const outcome of eligibility.rules.slice(0, 6)) facts.push(outcome.quote);
		// Prefer the freshly-read overview; fall back to any stored one so a run
		// that reused a fresh snapshot (no new text passed) still hashes the same.
		const overviewText = overview ?? (await readOverviewText(db, scope, candidate.url));
		const digestProfile: InspectionProfile = digestProfileInput ?? { country: profile.country };
		const contentHash = await digestContentHash(candidate, facts, overviewText, digestProfile);
		if (await getCachedDigest(db, scope, candidate.id, contentHash)) return false; // already warm
		const computed = await digestCandidate({
			apiKey: digestApiKey,
			profile: digestProfile,
			candidate,
			facts,
			overview: overviewText,
		});
		if (computed.digest) {
			await putCachedDigest(db, scope, candidate.id, contentHash, computed.digest);
			return true;
		}
		return false;
	} catch {
		return false; // pre-warm is best-effort; a failure never breaks the feed
	}
}

/** The result of an on-demand single-candidate eligibility check. */
export interface CheckEligibilityResult {
	readonly evaluation: CandidateEvaluation;
	/** How many rules pages were read this time (0 when reused/fresh or unreadable). */
	readonly pagesRead: number;
	/** How many quoted eligibility claims were added. */
	readonly claimsAdded: number;
	/** Visible gaps (Tavily not configured, unreadable page, etc.) — never thrown. */
	readonly gaps: readonly string[];
}

/**
 * On-demand "Check eligibility" for ONE candidate: read its rules page into the
 * evidence store, then re-evaluate from the freshly quoted rules. Fail-soft —
 * readRulesForCandidates never throws, and a page that could not be read leaves
 * the verdict 'unknown' (never a guess), with the reason in `gaps`.
 */
export async function checkCandidateEligibility(
	db: D1Database,
	scope: Scope,
	candidateId: string,
	profile: EligibilityProfile,
	keys: { tavilyApiKey?: string; nebiusApiKey?: string },
): Promise<CheckEligibilityResult> {
	const candidate = await getCandidate(db, scope, candidateId);
	const reading = await readRulesForCandidates(
		db,
		scope,
		[{ id: candidate.id, url: candidate.url, title: candidate.title }],
		{ tavilyApiKey: keys.tavilyApiKey, nebiusApiKey: keys.nebiusApiKey, maxPages: 1 },
	);
	const evaluation = await evaluateCandidate(db, scope, candidateId, profile);
	return {
		evaluation,
		pagesRead: reading.pagesRead,
		claimsAdded: reading.claimsAdded,
		gaps: reading.gaps,
	};
}

// --- scheduled "worth it" sweep (DB-only, session-less) ----------------------------------

/** One candidate the sweep decided is worth surfacing. */
export interface SweepHit {
	readonly candidateId: string;
	readonly title: string;
	readonly url: string;
	readonly verdict: 'eligible' | 'ineligible' | 'unknown';
}

export interface DiscoverySweepResult {
	/** Candidates that are eligible AND a supported fit — the "fits you" set. */
	readonly hits: readonly SweepHit[];
	/** How many stored candidates were evaluated. */
	readonly evaluated: number;
}

/**
 * The scheduled sweep (feature: "Caddie periodically checks hackathons in the
 * background and shows which fit and are worth it"). DELIBERATELY DB-ONLY: the
 * cron tick carries no Tavily/Nebius key (server/cloudflare.ts passes only DB),
 * so this NEVER reads rules pages or calls a model — it RE-EVALUATES the
 * candidates whose rules were already read (by a feed sweep or an on-demand
 * check) against the owner's profile, and returns the ones that are now
 * eligible with a supported fit. Reading new rules stays on the key-bearing
 * paths (the feed and the per-row check). Fit is a supported fit claim; "worth
 * it" is the eligible verdict — never a guess.
 */
export async function runDiscoverySweep(
	db: D1Database,
	scope: Scope,
	profile: EligibilityProfile,
): Promise<DiscoverySweepResult> {
	const candidates = await listCandidates(db, scope);
	const hits: SweepHit[] = [];
	for (const candidate of candidates) {
		const [fit, eligibility] = [
			await computeFit(db, scope, candidate),
			await evaluateCandidateEligibility(db, scope, candidate, profile),
		];
		const supportedFit = fit.claims.some((claim) => claim.verdict === 'supported');
		if (eligibility.verdict === 'eligible' && supportedFit) {
			hits.push({ candidateId: candidate.id, title: candidate.title, url: candidate.url, verdict: eligibility.verdict });
		}
	}
	return { hits, evaluated: candidates.length };
}

export interface CandidateListEvaluation {
	readonly evaluations: readonly CandidateEvaluation[];
	/** Conservative ranking: eligible first, unknown, ineligible last (rankCandidateSummaries). */
	readonly ranked: readonly CandidateSummary[];
	/** The profile country the eligibility read used (honesty about the input). */
	readonly profileCountry: string | null;
}

/**
 * Evaluate every project candidate (fit + eligibility) and rank them
 * conservatively. Used by the evaluated list endpoint; the profile is the
 * ACTOR's P14 profile — the route layer resolves it from the verified session.
 */
export async function listCandidateEvaluations(
	db: D1Database,
	scope: Scope,
	profile: EligibilityProfile,
): Promise<CandidateListEvaluation> {
	const candidates = await listCandidates(db, scope);
	const evaluations: CandidateEvaluation[] = [];
	for (const candidate of candidates) {
		const [fit, eligibility] = [
			await computeFit(db, scope, candidate),
			await evaluateCandidateEligibility(db, scope, candidate, profile),
		];
		evaluations.push({ candidate, fit, eligibility });
	}
	const ranked = rankCandidateSummaries(
		evaluations.map((e) => ({
			candidateId: e.candidate.id,
			matchedRequirements: e.fit.matchedRequirements,
			verdict: e.eligibility.verdict,
			// Stage 2: derive the ranking signals from the stored text (the
			// summary already embeds the prize/org string — no migration needed).
			prizeUsd: parsePrizeUsd(`${e.candidate.title} ${e.candidate.summary}`),
			companyWeight: companyWeight(e.candidate.title, e.candidate.summary),
		})),
	);
	return { evaluations, ranked, profileCountry: profile.country };
}

// --- conservative ranking --------------------------------------------------------------------

export interface CandidateSummary {
	readonly candidateId: string;
	readonly matchedRequirements: number;
	readonly verdict: 'eligible' | 'ineligible' | 'unknown';
	/** Stage 2 ranking signal: parsed USD-ordering prize, null when unknown. */
	readonly prizeUsd?: number | null;
	/** Stage 2 ranking signal: known-company weight (0 when none). */
	readonly companyWeight?: number;
	/**
	 * AI fit verdict from the inspection step — a ranking signal placed ABOVE
	 * prize/company but BELOW the hard eligibility verdict (so an ineligible
	 * event never outranks an eligible one, whatever its fit). Absent/'unknown'
	 * sorts neutrally, never penalised as if judged a bad fit.
	 */
	readonly aiFit?: 'strong' | 'possible' | 'weak' | 'unknown';
}

const VERDICT_ORDER: Readonly<Record<CandidateSummary['verdict'], number>> = {
	eligible: 0,
	unknown: 1,
	ineligible: 2,
};

/**
 * AI-fit ranking order: a judged 'strong' fit rises above 'possible', then
 * 'weak'. 'unknown' (not scored, or too thin to judge) sorts at the SAME level
 * as 'possible' — a neutral middle, so an un-inspected candidate is never
 * pushed below one the model actively judged a weak fit. This keeps the AI
 * signal additive (it promotes clear wins) without punishing honest unknowns.
 */
const AI_FIT_ORDER: Readonly<Record<NonNullable<CandidateSummary['aiFit']>, number>> = {
	strong: 0,
	possible: 1,
	unknown: 1,
	weak: 2,
};
const aiFitRank = (e: CandidateSummary): number => AI_FIT_ORDER[e.aiFit ?? 'unknown'] ?? 1;

/**
 * Conservative ranking with the Stage 2 preference "biggest prizes, bigger
 * companies first". The ladder, in strict priority order:
 *
 *   1. VERDICT — eligible, then unknown, then ineligible LAST. A hard-ineligible
 *      candidate can NEVER outrank an eligible one, whatever its prize or
 *      sponsor (the user's own requirement that eligibility is not for sale).
 *   2. AI FIT — within a verdict tier, a model-judged 'strong' fit rises above
 *      'possible'/'unknown' (neutral middle), then 'weak'. This sits ABOVE
 *      prize/company so judgement of actual fit leads money — but BELOW verdict,
 *      so a great fit never promotes an ineligible event.
 *   3. PRIZE SIZE — within a fit tier, a bigger parsed prize ranks higher.
 *      A null prize sorts BELOW any known prize (unknown money is not a big
 *      prize). This is where "biggest prizes first" lives.
 *   4. COMPANY WEIGHT — a bigger known sponsor (Google/NVIDIA/… ) breaks a
 *      prize tie upward ("bigger companies").
 *   5. FIT — matchedRequirements, higher first.
 *   6. candidateId — deterministic final tiebreak.
 *
 * Prize/company are ORDERING signals only; they never relabel a verdict and
 * never invent a figure (a null prize is just "no known prize", ranked last in
 * its tier, not zero dollars asserted). The AI fit is likewise ordering-only:
 * it never changes eligibility and an un-inspected 'unknown' is not penalised.
 */
export function rankCandidateSummaries(entries: readonly CandidateSummary[]): CandidateSummary[] {
	const prizeOf = (e: CandidateSummary): number => (typeof e.prizeUsd === 'number' && e.prizeUsd > 0 ? e.prizeUsd : -1);
	const compOf = (e: CandidateSummary): number => (typeof e.companyWeight === 'number' ? e.companyWeight : 0);
	return [...entries].sort((a, b) => {
		const va = VERDICT_ORDER[a.verdict] ?? Number.MAX_SAFE_INTEGER;
		const vb = VERDICT_ORDER[b.verdict] ?? Number.MAX_SAFE_INTEGER;
		if (va !== vb) return va - vb;
		const fa = aiFitRank(a);
		const fb = aiFitRank(b);
		if (fa !== fb) return fa - fb; // stronger AI fit first (below verdict, above prize)
		const pa = prizeOf(a);
		const pb = prizeOf(b);
		if (pa !== pb) return pb - pa; // bigger prize first
		const ca = compOf(a);
		const cb = compOf(b);
		if (ca !== cb) return cb - ca; // bigger known company first
		if (a.matchedRequirements !== b.matchedRequirements) return b.matchedRequirements - a.matchedRequirements;
		return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
	});
}
