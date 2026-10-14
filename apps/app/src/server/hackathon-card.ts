import type { HackathonCandidate, HackathonResultsCard } from '@caddie/contracts';
import { parseComposedSummary, parseEventDates, parseFormat, parseParticipants, parsePrize, UNVERIFIED_OPEN_LABEL } from './discovery.ts';

/**
 * Map a discovery result (what `find_hackathons` gets back from
 * discoverForActor) to the structured hackathon-results card the chat renders.
 * Pure and deterministic — the card is built from the REAL result, never from
 * model-authored text, so it cannot invent an event, a date or a prize.
 *
 * HONESTY in the mapping:
 *   - dates / prize / entries / format are read back out of the candidate's
 *     composed summary (Devpost API fields, or a sanitized web snippet); a field
 *     that is not there stays null and its chip is simply not shown;
 *   - the prize chip shows the ORIGINAL prize text ("₹ 100,000"), never the
 *     rough USD ordering value (which would turn ₹100,000 into "$1,200");
 *   - eligibility is the strict engine verdict; the note/quote/rules link are
 *     its wording and evidence, never a softer verdict;
 *   - a web-search backup result carries `openStatusUnverified`, and its label
 *     is lifted out of the summary into that flag (shown as its own chip);
 *   - the rich top-pick treatment goes only to a first-ranked candidate the AI
 *     judged a STRONG fit that is not ineligible.
 */

/** The discovery-result shape this mapper reads (a structural subset of ActorDiscoveryResult). */
export interface DiscoveryResultForCard {
	readonly candidates?: readonly {
		readonly id: string;
		readonly title: string;
		readonly url: string;
		readonly summary: string;
		readonly eligibility?: { readonly verdict?: string };
		readonly eligibilityNote?: string;
		readonly eligibilityQuote?: string | null;
		readonly eligibilityNeedsConfirm?: boolean;
		readonly rulesUrl?: string | null;
		readonly format?: string | null;
		readonly aiFit?: 'strong' | 'possible' | 'weak' | 'unknown';
		readonly aiFitReason?: string;
		readonly aiFitConfidence?: number | null;
		readonly saved?: boolean;
	}[];
	readonly gaps?: readonly string[];
	readonly profileCountry?: string | null;
}

const hostOf = (url: string): string | null => {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return null;
	}
};

/** Claims use 'in_person'; the card union uses 'in-person'. Falls back to the summary text. */
function formatOf(format: string | null | undefined, text: string): HackathonCandidate['format'] {
	if (format === 'online') return 'online';
	if (format === 'in_person' || format === 'in-person') return 'in-person';
	if (format === 'hybrid') return 'hybrid';
	return parseFormat(text);
}

export function buildHackathonResultsCard(result: DiscoveryResultForCard): HackathonResultsCard {
	const raw = result.candidates ?? [];
	const first = raw[0];
	const topPickId =
		first && first.aiFit === 'strong' && first.eligibility?.verdict !== 'ineligible' ? first.id : null;
	const candidates: HackathonCandidate[] = raw.map((c) => {
		const unverified = c.summary.startsWith(UNVERIFIED_OPEN_LABEL);
		const summary = unverified ? c.summary.slice(UNVERIFIED_OPEN_LABEL.length).replace(/^\s*·\s*/, '') : c.summary;
		const dates = parseEventDates(summary);
		const prize = parsePrize(summary);
		const { organizer, themes } = parseComposedSummary(summary);
		const verdict = c.eligibility?.verdict === 'eligible' || c.eligibility?.verdict === 'ineligible' ? c.eligibility.verdict : 'unknown';
		return {
			id: c.id,
			title: c.title,
			url: c.url,
			platform: hostOf(c.url),
			summary,
			startsAt: dates.startsAt,
			endsAt: dates.endsAt,
			deadline: dates.deadline,
			prize: prize && prize.usd > 0 ? prize.display : null,
			participants: parseParticipants(summary),
			format: formatOf(c.format, `${c.title} ${summary}`),
			organizer,
			themes: [...themes],
			topPick: c.id === topPickId,
			eligibility: verdict,
			eligibilityNote: c.eligibilityNote ?? '',
			eligibilityQuote: c.eligibilityQuote ?? null,
			eligibilityNeedsConfirm: c.eligibilityNeedsConfirm === true,
			rulesUrl: c.rulesUrl ?? null,
			openStatusUnverified: unverified,
			saved: c.saved === true,
			aiFit: c.aiFit ?? 'unknown',
			aiFitReason: c.aiFitReason ?? '',
			aiFitConfidence: c.aiFitConfidence ?? null,
		};
	});
	return { candidates, gaps: [...(result.gaps ?? [])], profileCountry: result.profileCountry ?? null };
}

/**
 * One row of the compact reference the model receives alongside a rendered
 * hackathon card. The card itself is what the user sees; this exists ONLY so a
 * follow-up ("tell me about the Nebius one") can name the right event and look
 * it up by id, instead of searching the web blind and contradicting the card.
 */
export interface HackathonReferenceRow {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	/** The strict engine verdict shown on the card — never softened. */
	readonly eligibility: HackathonCandidate['eligibility'];
	/** True when the card asks the user to confirm a rule (e.g. an age minimum). */
	readonly needsConfirm: boolean;
}

/**
 * Build the follow-up reference from the SAME card the user sees, so the model's
 * view of "what was shown" can never drift from the rendered card. Deliberately
 * terse (no prize, dates or summary): enough to identify an event and look it
 * up, too little to be worth re-listing as prose.
 */
export function buildHackathonReference(card: HackathonResultsCard): HackathonReferenceRow[] {
	return card.candidates.map((c) => ({
		id: c.id,
		title: c.title,
		url: c.url,
		eligibility: c.eligibility,
		needsConfirm: c.eligibilityNeedsConfirm === true,
	}));
}
