import type { Scope } from '@caddie/contracts';
import { MODEL_CALL_TIMEOUT_MS, timeoutSignal } from './http-timeouts.ts';
import { findModelRouteForRole } from '../agents/providers.ts';
import type { D1Database } from './auth.ts';
import { ELIGIBILITY_RULE_TYPES } from './eligibility.ts';
import { addClaim, listClaims } from './evidence/claims.ts';
import {
	canonicalizeUrl,
	captureSnapshot,
	getSnapshot,
	listSources,
	registerSource,
	type SnapshotRecord,
} from './evidence/sources.ts';
import { tavilyExtract } from './tavily.ts';

/**
 * Rules reading (discovery Stage 4): Tavily READS each top candidate's official
 * rules page, and a model pulls the eligibility rules out of it — so a card can
 * say "You can enter" / "Not eligible" with the rule quoted, instead of
 * "Eligibility unknown" on every event.
 *
 * PIPELINE (each step reuses the existing evidence store, no new tables):
 *   1. pick ≤ 5 Devpost-hosted candidates (their rules live at `<event>/rules`);
 *   2. ONE batched Tavily Extract call reads the pages that are not fresh;
 *   3. each page → registerSource(authority 'binding_rules') + captureSnapshot
 *      (provenance 'processed', renderer 'tavily-extract') — an immutable copy;
 *   4. the Nebius helper model reads the eligibility section and proposes
 *      claims (open/restricted countries as ISO-2, min age, students only);
 *   5. every proposed quote is LOCATED in the snapshot (whitespace/markdown-
 *      tolerant) and the exact snapshot substring is what addClaim stores —
 *      addClaim itself rejects any quote not present in the snapshot. A quote
 *      the model invented therefore never becomes a claim.
 *
 * HONESTY / COST:
 *   - fail-soft: no key, a failed read, an unreadable page or a bad model reply
 *     becomes a visible GAP string — this module never throws and never guesses
 *     a verdict (unread rules simply leave eligibility 'unknown');
 *   - bounded: ≤ 5 pages per sweep, one extract call, one small model call per
 *     page; a page read within the last 24h is reused, and a snapshot that
 *     already has claims from this extractor is not re-analysed;
 *   - claims supersede themselves: a changed rules page's new readings retire
 *     the old ones through addClaim's built-in supersession.
 */

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
export const RULES_EXTRACTION_VERSION = 'rules-reader-1';
const DEFAULT_MAX_PAGES = 5;
const FRESH_FOR_MS = 24 * 60 * 60 * 1000;
/** Pages shorter than this are a block page / error shell, not rules text. */
const MIN_RULES_CHARS = 200;
const MAX_EXCERPT_CHARS = 6000;

export interface RulesReadingCandidate {
	readonly id: string;
	readonly url: string;
	readonly title: string;
}

export interface RulesReadingOptions {
	readonly tavilyApiKey?: string;
	readonly nebiusApiKey?: string;
	readonly maxPages?: number;
	/** Injectable clock (tests). */
	readonly now?: () => number;
}

export interface RulesReadingResult {
	/** Pages freshly read by Tavily this sweep (cache hits excluded). */
	readonly pagesRead: number;
	/** Rules pages that have a snapshot available (fresh or reused). */
	readonly pagesAvailable: number;
	readonly claimsAdded: number;
	/** Model-proposed quotes that could not be found in the snapshot → never stored. */
	readonly quotesRejected: number;
	readonly gaps: readonly string[];
	/**
	 * The candidate's OVERVIEW text (its main detail page, read via the same
	 * Tavily Extract sweep), keyed by candidate id. This is the rich "about"
	 * prose the Devpost LIST API never carries — it feeds the AI digest so a
	 * card's digest is grounded in the event's real description, not the thin
	 * composed meta line. Fresh snapshots (read within 24h) and freshly-read
	 * pages both land here; a candidate with no readable overview is absent.
	 * Overview text is DIGEST INPUT ONLY — it never produces eligibility claims
	 * (those stay the verbatim-quoted `/rules` path above).
	 */
	readonly overviewByCandidateId: ReadonlyMap<string, string>;
}

/** A Devpost-hosted contest page (`<slug>.devpost.com`), whose rules live at `/rules`. */
export function rulesUrlFor(candidateUrl: string): string | null {
	try {
		const url = new URL(candidateUrl);
		const host = url.hostname.toLowerCase();
		if (!host.endsWith('.devpost.com') || host === 'www.devpost.com' || host === 'help.devpost.com') return null;
		return `${url.origin}/rules`;
	} catch {
		return null;
	}
}

/**
 * The candidate's MAIN overview page — its own event page, the one that carries
 * the tagline + "About" prose the Devpost list API omits. For a Devpost-hosted
 * contest that is `<slug>.devpost.com` (origin, no `/rules`); for any other
 * absolute http(s) URL it is the URL itself. Returns null for a URL we cannot
 * parse. This is READ for digest input only — never for eligibility claims.
 */
export function overviewUrlFor(candidateUrl: string): string | null {
	try {
		const url = new URL(candidateUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		const host = url.hostname.toLowerCase();
		if (host.endsWith('.devpost.com') && host !== 'www.devpost.com' && host !== 'help.devpost.com') {
			return url.origin; // the event's own landing page, not /rules
		}
		return `${url.origin}${url.pathname}`;
	} catch {
		return null;
	}
}

/** Overview prose fed to the digest — reference-caddie reads this much page text. */
const MAX_OVERVIEW_CHARS = 12_000;

/**
 * The eligibility part of a rules page: from the "Eligibility" heading up to the
 * next numbered/markdown heading (bounded). Falls back to the page head when no
 * such heading exists. Keeps the model prompt small and on-topic.
 */
export function eligibilityExcerpt(content: string): string {
	const start = content.search(/(^|\n)[#*\s\d.]*eligib/i);
	if (start === -1) return content.slice(0, MAX_EXCERPT_CHARS);
	const from = Math.max(0, start);
	const rest = content.slice(from + 20);
	const next = rest.search(/\n#{2,6}\s|\n\*\*\s*\d+\.\s|\n\d+\.\s+[A-Z][a-z]+(?: [A-Za-z]+)*\s*\n/);
	const end = next === -1 ? from + MAX_EXCERPT_CHARS : Math.min(from + 20 + next, from + MAX_EXCERPT_CHARS);
	return content.slice(from, end).trim();
}

/**
 * Find `quote` in `content` tolerating whitespace and markdown emphasis
 * differences, and return the EXACT substring of `content` that matched (or
 * null). This is what makes a model's lightly re-spaced quote storable while a
 * paraphrased or invented one is rejected.
 */
export function locateVerbatim(content: string, quote: string): string | null {
	const words = quote.replace(/[*_`]/g, ' ').split(/\s+/).filter(Boolean);
	if (words.length < 3) return null;
	const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const pattern = new RegExp(escaped.join('[\\s*_`]+'), 'i');
	const match = pattern.exec(content);
	return match ? match[0] : null;
}

interface ProposedClaim {
	readonly claimType: string;
	readonly value: string;
	readonly quote: string;
}

const COUNTRY_LIST = /^[A-Z]{2}(\s*[,;]\s*[A-Z]{2})*$/;

/** Keep only claims the eligibility grammar can interpret, with well-formed values. */
function validClaim(raw: { type?: unknown; value?: unknown; quote?: unknown }): ProposedClaim | null {
	const claimType = typeof raw.type === 'string' ? raw.type.trim() : '';
	const value = typeof raw.value === 'string' ? raw.value.trim() : typeof raw.value === 'number' ? String(raw.value) : '';
	const quote = typeof raw.quote === 'string' ? raw.quote.trim() : '';
	if (!ELIGIBILITY_RULE_TYPES.includes(claimType) || !value || quote.length < 12 || quote.length > 600) return null;
	switch (claimType) {
		case 'eligibility.open_countries':
		case 'eligibility.restricted_countries': {
			const normalized = value.toUpperCase().replace(/\s+/g, '');
			return COUNTRY_LIST.test(normalized) ? { claimType, value: normalized.replace(/;/g, ','), quote } : null;
		}
		case 'eligibility.min_age':
			return /^\d{1,2}$/.test(value) && Number(value) > 0 ? { claimType, value, quote } : null;
		case 'eligibility.student_only':
			return /^(true|false)$/i.test(value) ? { claimType, value: value.toLowerCase(), quote } : null;
		default:
			return null;
	}
}

const SYSTEM_PROMPT =
	"You extract ELIGIBILITY rules from ONE hackathon's official rules text. " +
	'Return STRICT JSON ONLY: {"claims":[{"type":"...","value":"...","quote":"..."}]}. Allowed types: ' +
	'"eligibility.open_countries" — entry is ONLY open to residents of specific countries; value = comma-separated ISO 3166-1 alpha-2 codes. ' +
	'"eligibility.restricted_countries" — residents of specific countries are EXCLUDED; value = ISO-2 codes of the sovereign countries the text names explicitly ' +
	'(omit sub-national regions such as Quebec or Crimea, and omit vague phrases such as "any other sanctioned country"). ' +
	'"eligibility.min_age" — a minimum age stated AS A NUMBER; value = that integer. Do NOT emit it for "age of majority" without a number. ' +
	'"eligibility.student_only" — entry restricted to students; value "true". ' +
	'quote = an EXACT contiguous excerpt copied character-for-character from the text (one sentence or list item, max 300 characters) that states the rule. ' +
	'Never paraphrase, never combine passages, never invent. If a rule is not clearly stated, omit it. Return {"claims":[]} when none apply.';

/** Tolerant JSON extraction (fences / stray prose), mirroring candidate-inspection. */
function parseClaims(content: string): { type?: unknown; value?: unknown; quote?: unknown }[] | null {
	if (!content.trim()) return null;
	const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const text = fenced ? fenced[1]! : content;
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as { claims?: unknown };
		return Array.isArray(parsed.claims) ? (parsed.claims as { type?: unknown }[]) : null;
	} catch {
		return null;
	}
}

/** One small model call per page. Returns null on any failure (caller records a gap). */
async function proposeClaims(apiKey: string, excerpt: string): Promise<ProposedClaim[] | null> {
	const route = findModelRouteForRole('helper');
	try {
		const res = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			signal: timeoutSignal(MODEL_CALL_TIMEOUT_MS),
			body: JSON.stringify({
				model: route.modelId,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: `Rules text:\n"""\n${excerpt}\n"""` },
				],
				temperature: 0,
				max_tokens: route.maxTokens,
			}),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
		const raw = body.choices?.[0]?.message?.content;
		const items = parseClaims(typeof raw === 'string' ? raw : '');
		if (!items) return null;
		return items.map(validClaim).filter((c): c is ProposedClaim => c !== null);
	} catch {
		return null;
	}
}

/**
 * Read the rules pages of the given (already-ranked) candidates into the
 * evidence store and extract quoted eligibility claims. Never throws.
 */
export async function readRulesForCandidates(
	db: D1Database,
	scope: Scope,
	candidates: readonly RulesReadingCandidate[],
	options: RulesReadingOptions = {},
): Promise<RulesReadingResult> {
	const gaps: string[] = [];
	let pagesRead = 0;
	let claimsAdded = 0;
	let quotesRejected = 0;
	// Overview text per candidate id — digest input, built as a side-effect of
	// the same Extract sweep that reads the rules pages. Empty until populated.
	const overviewByCandidateId = new Map<string, string>();
	const empty = (): RulesReadingResult => ({
		pagesRead,
		pagesAvailable: 0,
		claimsAdded,
		quotesRejected,
		gaps,
		overviewByCandidateId,
	});
	const picks = candidates
		.map((c) => ({ candidate: c, rulesUrl: rulesUrlFor(c.url), overviewUrl: overviewUrlFor(c.url) }))
		.filter((p): p is { candidate: RulesReadingCandidate; rulesUrl: string; overviewUrl: string | null } => p.rulesUrl !== null)
		.slice(0, options.maxPages ?? DEFAULT_MAX_PAGES);
	// No Tavily key: the discovery feed already shows the Tavily configuration gap.
	if (picks.length === 0 || !options.tavilyApiKey) return empty();
	const now = options.now ?? Date.now;
	try {
		// 1. Reuse rules pages read within the freshness window.
		const sources = await listSources(db, scope);
		const sourceByUrl = new Map(sources.map((s) => [s.canonicalUrl, s]));
		const snapshots = new Map<string, { snapshot: SnapshotRecord; title: string }>();
		const toRead: { rulesUrl: string; title: string }[] = [];
		// Overview sweep bookkeeping (parallel to rules, same Extract call).
		const overviewToRead: { overviewUrl: string; candidateId: string }[] = [];
		for (const { candidate, rulesUrl, overviewUrl } of picks) {
			const existing = sourceByUrl.get(canonicalizeUrl(rulesUrl));
			const fresh =
				existing?.latestSnapshotId &&
				existing.observedAt &&
				now() - Date.parse(existing.observedAt) < FRESH_FOR_MS;
			if (fresh) {
				snapshots.set(rulesUrl, { snapshot: await getSnapshot(db, scope, existing.latestSnapshotId!), title: candidate.title });
			} else {
				toRead.push({ rulesUrl, title: candidate.title });
			}
			// Overview: reuse a fresh snapshot, else queue it for the Extract call.
			if (overviewUrl) {
				const existingOverview = sourceByUrl.get(canonicalizeUrl(overviewUrl));
				const overviewFresh =
					existingOverview?.latestSnapshotId &&
					existingOverview.observedAt &&
					now() - Date.parse(existingOverview.observedAt) < FRESH_FOR_MS;
				if (overviewFresh) {
					const snap = await getSnapshot(db, scope, existingOverview.latestSnapshotId!);
					if (snap.content.length >= MIN_RULES_CHARS) {
						overviewByCandidateId.set(candidate.id, snap.content.slice(0, MAX_OVERVIEW_CHARS));
					}
				} else {
					overviewToRead.push({ overviewUrl, candidateId: candidate.id });
				}
			}
		}
		// 2. One batched Tavily Extract call for everything not fresh — rules
		//    pages AND overview pages share the single call (Extract takes many
		//    URLs), so the overview enrichment adds no extra round-trip.
		const extractUrls = [...toRead.map((p) => p.rulesUrl), ...overviewToRead.map((p) => p.overviewUrl)];
		if (extractUrls.length > 0) {
			let pages: Awaited<ReturnType<typeof tavilyExtract>> = [];
			try {
				pages = await tavilyExtract(options.tavilyApiKey, extractUrls);
			} catch (error) {
				gaps.push(`Rules pages could not be read this time (${error instanceof Error ? error.message : 'Tavily extract failed'}) — eligibility stays unknown for those events.`);
			}
			const pageByUrl = new Map<string, string>();
			for (const page of pages) {
				try {
					pageByUrl.set(canonicalizeUrl(page.url), page.content);
				} catch {
					// an unparseable url in the reply maps to nothing
				}
			}
			const unreadable: string[] = [];
			for (const { rulesUrl, title } of toRead) {
				const content = pageByUrl.get(canonicalizeUrl(rulesUrl));
				if (!content || content.length < MIN_RULES_CHARS) {
					if (pages.length > 0) unreadable.push(title);
					continue;
				}
				// 3. Immutable copy in the evidence store.
				const source = await registerSource(db, scope, {
					url: rulesUrl,
					kind: 'page',
					authority: 'binding_rules',
					displayName: `${title} — Official Rules`,
				});
				const { snapshot } = await captureSnapshot(db, scope, source.id, {
					content,
					mediaType: 'text/markdown',
					originalUrl: rulesUrl,
					provenance: 'processed',
					renderer: 'tavily-extract',
				});
				snapshots.set(rulesUrl, { snapshot, title });
				pagesRead += 1;
			}
			if (unreadable.length > 0) {
				gaps.push(`No readable rules page for ${unreadable.slice(0, 3).join(', ')}${unreadable.length > 3 ? ' and others' : ''} — eligibility stays unknown there.`);
			}
			// 3b. Snapshot overview pages (digest input), mirroring the rules copy
			//     but with the 'official_overview' authority. Overview text never
			//     feeds eligibility; it is NOT analysed for claims below.
			for (const { overviewUrl, candidateId } of overviewToRead) {
				const content = pageByUrl.get(canonicalizeUrl(overviewUrl));
				if (!content || content.length < MIN_RULES_CHARS) continue;
				const pick = picks.find((p) => p.candidate.id === candidateId);
				const title = pick?.candidate.title ?? overviewUrl;
				const overviewSource = await registerSource(db, scope, {
					url: overviewUrl,
					kind: 'page',
					authority: 'official_overview',
					displayName: `${title} — Overview`,
				});
				await captureSnapshot(db, scope, overviewSource.id, {
					content,
					mediaType: 'text/markdown',
					originalUrl: overviewUrl,
					provenance: 'processed',
					renderer: 'tavily-extract',
				});
				overviewByCandidateId.set(candidateId, content.slice(0, MAX_OVERVIEW_CHARS));
			}
		}
		if (snapshots.size === 0) return { ...empty(), pagesAvailable: 0 };
		// 4–5. Extract claims for snapshots this extractor has not analysed yet.
		if (!options.nebiusApiKey) {
			gaps.push('Rules pages were saved but not analysed: the model key is not configured, so eligibility stays unknown.');
			return { pagesRead, pagesAvailable: snapshots.size, claimsAdded, quotesRejected, gaps, overviewByCandidateId };
		}
		const analysed = new Set(
			(await listClaims(db, scope))
				.filter((c) => c.extractionVersion === RULES_EXTRACTION_VERSION)
				.map((c) => c.snapshotId),
		);
		const pending = [...snapshots.values()].filter(({ snapshot }) => !analysed.has(snapshot.id));
		const proposals = await Promise.all(
			pending.map(async ({ snapshot, title }) => ({
				snapshot,
				title,
				claims: await proposeClaims(options.nebiusApiKey!, eligibilityExcerpt(snapshot.content)),
			})),
		);
		const failed: string[] = [];
		for (const { snapshot, title, claims } of proposals) {
			if (claims === null) {
				failed.push(title);
				continue;
			}
			for (const claim of claims) {
				const quote = locateVerbatim(snapshot.content, claim.quote);
				if (!quote) {
					quotesRejected += 1;
					continue;
				}
				try {
					await addClaim(db, scope, {
						snapshotId: snapshot.id,
						claimType: claim.claimType,
						value: claim.value,
						quote,
						extractionVersion: RULES_EXTRACTION_VERSION,
					});
					claimsAdded += 1;
				} catch {
					quotesRejected += 1; // addClaim's own verbatim guard, or a malformed value
				}
			}
		}
		if (failed.length > 0) {
			gaps.push(`The rules for ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ' and others' : ''} were read but could not be analysed — eligibility stays unknown there.`);
		}
		return { pagesRead, pagesAvailable: snapshots.size, claimsAdded, quotesRejected, gaps, overviewByCandidateId };
	} catch (error) {
		gaps.push(`Rules reading stopped early (${error instanceof Error ? error.message : 'unexpected error'}) — eligibility stays unknown where rules were not read.`);
		return { pagesRead, pagesAvailable: 0, claimsAdded, quotesRejected, gaps, overviewByCandidateId };
	}
}
