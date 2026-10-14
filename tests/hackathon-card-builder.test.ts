import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import type * as ReactTypes from '../apps/app/node_modules/@types/react/index.d.ts';
import type * as ReactDomServerTypes from '../apps/app/node_modules/@types/react-dom/server.d.ts';
import { HackathonResultsCardSchema } from '../packages/contracts/src/index.ts';
import { HackathonResultsCard } from '../apps/app/src/client/conversation/HackathonResultsCard.tsx';
import { buildHackathonResultsCard } from '../apps/app/src/server/hackathon-card.ts';
import { parsePrize, parsePrizeUsd, UNVERIFIED_OPEN_LABEL } from '../apps/app/src/server/discovery.ts';
import { describeEligibility, evaluateEligibility } from '../apps/app/src/server/eligibility.ts';

// The root test project has no React of its own. Load the app's copy (the same
// instance the card component uses) at runtime, typed by the app's @types.
const REACT_DOM_SERVER_PATH = '../apps/app/node_modules/react-dom/server.js';
const REACT_PATH = '../apps/app/node_modules/react/index.js';
const { renderToStaticMarkup } = (await import(REACT_DOM_SERVER_PATH)) as typeof ReactDomServerTypes;
const { createElement } = (await import(REACT_PATH)) as typeof ReactTypes;

/**
 * Stage 5 — from a discovery result to what the user actually sees.
 * LOCAL VERIFIED: the pure card mapper, the eligibility wording, the prize
 * display parser, and a server-side render of the real card component (the
 * same React component the chat renders; the browser suite is separate).
 */

const AMAZON_SUMMARY = 'By Amazon · Aug 31 - Oct 23, 2026 · $138,000 in prizes · 54,512 registered · Machine Learning/AI, Open Ended · Online';
const INR_SUMMARY = 'By Kamand Prompt, IIT Mandi · Sep 29 - Oct 14, 2026 · ₹ 100,000 in prizes · 3,684 registered · Machine Learning/AI · Online';

const result = {
	profileCountry: 'NG',
	gaps: ["Open Devpost contests come from Devpost's live open-contests API.", 'Eligibility for the top event is read from its official rules page (via Tavily).'],
	candidates: [
		{
			id: 'c-amazon', title: 'Build, Ship, Shape: Amazon Developer Hackathon', url: 'https://amazonappdev2026.devpost.com/', summary: AMAZON_SUMMARY,
			eligibility: { verdict: 'eligible' }, eligibilityNote: 'You can enter',
			eligibilityQuote: '(including, but not limited to, Brazil, Quebec, Russia, Crimea, Cuba, Iran, and North Korea',
			eligibilityNeedsConfirm: false, rulesUrl: 'https://amazonappdev2026.devpost.com/rules', format: 'online',
			aiFit: 'strong' as const, aiFitReason: 'Large AI track that matches your interests.', aiFitConfidence: 0.8,
		},
		{
			id: 'c-inr', title: 'Multimodal AI Hackathon 2026', url: 'https://multimodal.devpost.com/', summary: INR_SUMMARY,
			eligibility: { verdict: 'unknown' }, eligibilityNote: "Open to NG · confirm you're 18+",
			eligibilityQuote: 'at least 18 years of age', eligibilityNeedsConfirm: true, rulesUrl: 'https://multimodal.devpost.com/rules',
			format: null, aiFit: 'strong' as const,
		},
		{
			id: 'c-backup', title: 'Some Devpost Event', url: 'https://some-event.devpost.com/',
			summary: `${UNVERIFIED_OPEN_LABEL} · Build with AI agents. · via devpost.com`, eligibility: {}, format: null,
		},
	],
};

describe('parsePrize — display the ORIGINAL prize text', () => {
	test('keeps the currency the event uses; the USD value is ordering-only', () => {
		expect(parsePrize(AMAZON_SUMMARY)).toEqual({ usd: 138_000, display: '$138,000' });
		const inr = parsePrize(INR_SUMMARY)!;
		expect(inr.display).toBe('₹ 100,000');
		expect(inr.usd).toBe(1_200); // ordering magnitude only — never shown
	});
	test('a following word starting with m/b/k is not a magnitude ("$50,000 more" ≠ $50B)', () => {
		expect(parsePrizeUsd('Win $50,000 more in credits')).toBe(50_000);
		expect(parsePrizeUsd('Over $5,000 bonus pool')).toBe(5_000);
		expect(parsePrizeUsd('$1.2M in prizes')).toBe(1_200_000);
		expect(parsePrizeUsd('50k USD grand prize')).toBe(50_000);
	});
});

describe('describeEligibility — the card wording, never a softer verdict', () => {
	const claim = (claimId: string, claimType: string, value: string, quote: string) => ({ claimId, claimType, value, quote });
	test('eligible → "You can enter" with the deciding quote', () => {
		const c = claim('r1', 'eligibility.restricted_countries', 'BR,RU,CU,IR,KP', 'including Brazil, Russia, Cuba, Iran, North Korea');
		const evaluation = evaluateEligibility([c], { country: 'NG' });
		expect(evaluation.verdict).toBe('eligible');
		expect(describeEligibility(evaluation, new Map([['r1', c.value]]), 'NG')).toEqual({ note: 'You can enter', quote: c.quote, needsConfirm: false });
	});
	test('ineligible via allowlist → "Only open to US"', () => {
		const c = claim('r1', 'eligibility.open_countries', 'US', 'legal residents of the 50 United States');
		const evaluation = evaluateEligibility([c], { country: 'NG' });
		expect(describeEligibility(evaluation, new Map([['r1', 'US']]), 'NG')).toEqual({ note: 'Only open to US', quote: c.quote, needsConfirm: false });
	});
	test('ineligible via restriction → "Not open to residents of NG"', () => {
		const c = claim('r1', 'eligibility.restricted_countries', 'NG,GH', 'residents of Nigeria and Ghana are excluded');
		const evaluation = evaluateEligibility([c], { country: 'NG' });
		expect(describeEligibility(evaluation, new Map([['r1', c.value]]), 'NG').note).toBe('Not open to residents of NG');
	});
	test('country passes + age gate → "Open to US · confirm you\'re 18+", verdict stays unknown', () => {
		const country = claim('r1', 'eligibility.open_countries', 'US', 'legal residents of the 50 United States');
		const age = claim('r2', 'eligibility.min_age', '18', 'at least 18 years of age');
		const evaluation = evaluateEligibility([country, age], { country: 'US' });
		expect(evaluation.verdict).toBe('unknown');
		expect(describeEligibility(evaluation, new Map([['r1', 'US'], ['r2', '18']]), 'US')).toEqual({
			note: "Open to US · confirm you're 18+",
			quote: country.quote,
			needsConfirm: true,
		});
	});
	test('no country on the profile → asks for it, not a guess', () => {
		const c = claim('r1', 'eligibility.restricted_countries', 'RU', 'residents of Russia are excluded');
		const evaluation = evaluateEligibility([c], { country: null });
		expect(describeEligibility(evaluation, new Map([['r1', 'RU']]), null)).toEqual({ note: 'Add your country to check', quote: c.quote, needsConfirm: false });
	});
	test('no rules read → empty note (the chip says "Eligibility unknown")', () => {
		expect(describeEligibility(evaluateEligibility([], { country: 'NG' }), new Map(), 'NG')).toEqual({ note: '', quote: null, needsConfirm: false });
	});
});

describe('buildHackathonResultsCard', () => {
	const card = buildHackathonResultsCard(result);
	const [amazon, inr, backup] = card.candidates;

	test('produces a card the contract accepts', () => {
		expect(safeParse(HackathonResultsCardSchema, card).success).toBe(true);
	});

	test('chips come from the composed summary: dates, original-currency prize, entries, format', () => {
		expect(amazon!.startsAt).toBe('2026-08-31');
		expect(amazon!.deadline).toBe('2026-10-23');
		expect(amazon!.prize).toBe('$138,000');
		expect(amazon!.participants).toBe(54_512);
		expect(amazon!.format).toBe('online');
		expect(inr!.prize).toBe('₹ 100,000'); // NOT "$1,200"
		expect(inr!.format).toBe('online'); // parsed from the summary when no claim
	});

	test('eligibility verdict, wording, quote and rules link pass through', () => {
		expect(amazon!.eligibility).toBe('eligible');
		expect(amazon!.eligibilityNote).toBe('You can enter');
		expect(amazon!.rulesUrl).toBe('https://amazonappdev2026.devpost.com/rules');
		expect(inr!.eligibility).toBe('unknown');
		expect(inr!.eligibilityNeedsConfirm).toBe(true);
		expect(backup!.eligibility).toBe('unknown');
		expect(backup!.eligibilityNote).toBe('');
	});

	test('a backup result is flagged unverified and the label leaves the summary', () => {
		expect(backup!.openStatusUnverified).toBe(true);
		expect(backup!.summary).toBe('Build with AI agents. · via devpost.com');
		expect(amazon!.openStatusUnverified).toBe(false);
	});

	test('top pick: only the first candidate, only when strong and not ineligible', () => {
		expect(amazon!.topPick).toBe(true);
		expect(inr!.topPick).toBe(false); // strong, but not first
		const ineligibleFirst = buildHackathonResultsCard({
			candidates: [{ ...result.candidates[0]!, eligibility: { verdict: 'ineligible' } }],
		});
		expect(ineligibleFirst.candidates[0]!.topPick).toBe(false);
	});

	test('gaps (the source notes) pass through unchanged', () => {
		expect(card.gaps).toEqual(result.gaps);
	});
});

describe('HackathonResultsCard render (server-side, the real component)', () => {
	const html = renderToStaticMarkup(createElement(HackathonResultsCard, { card: buildHackathonResultsCard(result) }));

	test('eligible card: "You can enter" chip and the quoted rule linked to the official page', () => {
		expect(html).toContain('You can enter');
		expect(html).toContain('href="https://amazonappdev2026.devpost.com/rules"');
		expect(html).toContain('Brazil, Quebec, Russia');
	});

	test('age-gated card: confirm state and wording', () => {
		expect(html).toContain('data-eligibility="confirm"');
		expect(html).toContain('Open to NG · confirm you&#x27;re 18+');
	});

	test('prize stays in its own currency (compacted), with entry count and deadline', () => {
		expect(html).toContain('$138k');
		expect(html).toContain('₹100k');
		expect(html).toContain('54.5k');
		expect(html).toContain('Oct 23');
		// Never the rough USD ordering value of the rupee prize.
		expect(html).not.toMatch(/\$1(,200|\.2k)/);
	});

	test('backup card: "Open status unverified" chip; top-pick ribbon on the first card only', () => {
		expect(html).toContain('data-testid="hk-unverified-chip"');
		expect(html.match(/data-testid="hk-toppick-ribbon"/g)?.length).toBe(1);
	});

	test('no scraped page chrome reaches the card', () => {
		expect(html).not.toMatch(/Devpost for Teams|\|\|\||&lt;span/);
	});

	test('one featured card, the rest as rows; the composed summary line is not repeated', () => {
		expect(html.match(/data-testid="hk-card"/g)?.length).toBe(1);
		expect(html.match(/data-testid="hk-row"/g)?.length).toBe(result.candidates.length - 1);
		expect(html).not.toContain(AMAZON_SUMMARY);
		expect(html).toContain('Entry checked for Nigeria');
	});

	test('past four rows the rest fold behind "Show N more"', () => {
		const many = {
			...result,
			candidates: Array.from({ length: 9 }, (_, i) => ({ ...result.candidates[0]!, id: `c-${i}`, url: `https://e${i}.devpost.com/`, title: `Event ${i}` })),
		};
		const out = renderToStaticMarkup(createElement(HackathonResultsCard, { card: buildHackathonResultsCard(many) }));
		expect(out.match(/data-testid="hk-row"/g)?.length).toBe(8);
		expect(out).toContain('Show 4 more');
	});
});
