import { describe, expect, test } from 'bun:test';
import { isLikelyEventPage, isPastEvent, parseComposedSummary } from '../apps/app/src/server/discovery.ts';
import {
	compactCount,
	compactPrize,
	eligibilityView,
	platformName,
	rowFacts,
} from '../apps/app/src/client/conversation/hackathon-format.ts';
import type { HackathonCandidate } from '../packages/contracts/src/index.ts';

/**
 * Discover / chat-card quality pass. The URL list below is the Discover page
 * the user reported (2026-10-13): every web-search row that was not one
 * event's own page, plus the real events that must survive the filter.
 */

const NOW = new Date('2026-10-13T12:00:00Z');
const keep = (url: string, title: string, text = '') => isLikelyEventPage({ url, title, text, now: NOW });

describe('isLikelyEventPage — the reported Discover junk is dropped', () => {
	const junk: readonly (readonly [string, string])[] = [
		['https://dorahacks.io/build/33392/milestones', 'iSchool Labs | Buidls'],
		['https://dorahacks.io/buidl/30609/milestones', 'SafePhone NG | Buidls'],
		['https://dorahacks.io/hackathon/codenut/hackers', '🏆 CodeNut Global Vibe: AI Web3 Hackathon 2025 🏆'],
		['https://dorahacks.io/hackathon', 'Hackathons for Frontier Tech - AI, Quantum, Crypto, BioTech | Organizer AI Toolkits | DoraHacks'],
		['https://dorahacks.io/hackathon/wchl25-qualification-round/report', 'ICP - WCHL25 - Qualification Round | Hackathon'],
		['https://hack.mlh.io/', 'Upcoming Hackathon Prizes | Major League Hacking'],
		['https://mlh.io/seasons/2025/events', '2025 Season Schedule // Major League Hacking'],
		['https://mlh.io/seasons/2026/events', '2026 Season Schedule // Major League Hacking'],
		['https://mlh.io/event-membership', 'Join the MLH Hackathon Season. | Major League Hacking'],
		['https://mlh.io/na', '2027 Season Schedule // Major League Hacking'],
		['https://ghw.mlh.io/', 'Global Hack Week'],
		['https://www.hackerearth.com/lp/challenges/microsoft-build-ai', 'Microsoft Build AI'],
		['https://www.hackerearth.com/challenges/hackathon/cheggs-hackathon', '\u200b'],
		['https://www.hackerearth.com/challenges/hackathon/sentientio-ihack-alpha-2020', 'iHack Alpha: AI-Enabled Solutions'],
		['https://www.hackerearth.com/challenges/hackathon', 'Compete | HackerEarth'],
		['https://www.hackerearth.com/challenges', 'Compete | HackerEarth'],
		['https://resources.hackerearth.com/global-hackathon-report', 'Global Hackathon Report'],
		['https://www.hackerearth.com/challenges/hackathon/code19-india/custom-tab/submission-format', '#CODE19INDIA'],
		['https://momo2022.hackerearth.com/', 'MoMo Hackathon 2022'],
		['https://www.hackerearth.com/challenges/hackathon/arvr-hackathon-1/faq', 'AR/VR Hackathon 1.0'],
		['https://hackuem.devfolio.co/hackathons/open', 'Open Hackathons | Devfolio'],
		['https://unfold2023.devfolio.co/hackathons/open', 'Open Hackathons | Devfolio'],
		['https://www.kaggle.com/competitions', 'Kaggle Competitions'],
		['https://ethglobal.com/events/openagents/info/start', 'ETHGlobal | Open Agents'],
	];
	for (const [url, title] of junk) {
		test(`drops ${url}`, () => expect(keep(url, title)).toBe(false));
	}
});

describe('isLikelyEventPage — real event pages survive', () => {
	const events: readonly (readonly [string, string])[] = [
		['https://www.hackerearth.com/challenges/hackathon/the-tiny-fish-hackathon-2026', 'TinyFish $2M Pre-Accelerator Hackathon'],
		['https://dorahacks.io/hackathon/hackathon2026challenge', 'Hackathon 2026 Challenge | Hackathon | DoraHacks'],
		['https://dorahacks.io/hackathon/cosmoshubafrica/detail', 'Naija HackAtom | Hackathon'],
		['https://dorahacks.io/hackathon/ai-eduhack-season-2', 'AI EduHack - Building AI Solutions for African Education'],
		['https://www.kaggle.com/competitions/nexora-hackathon/rules', 'Nexora Hackathon'],
		['https://www.hackerearth.com/challenges/hackathon/africa-ignite-hackathon', 'Africa Ignite Hackathon'],
		['https://www.hackerearth.com/community/challenges/hackathon/micro1-frontier-engineering-challenge-2026', 'Frontier Engineering Challenge 2026'],
		['https://ethglobal.com/events/agents', 'Agentic Ethereum'],
		['https://gcp-mlb.devfolio.co', 'Google Cloud x MLB Hackathon'],
	];
	for (const [url, title] of events) {
		test(`keeps ${url}`, () => expect(keep(url, title)).toBe(true));
	}

	test('an event whose date range has closed is dropped; a lone past date is not proof', () => {
		const url = 'https://dorahacks.io/hackathon/agents-jam';
		expect(keep(url, 'Agents Jam', 'Runs Jan 10 - Feb 14, 2026 online')).toBe(false);
		expect(keep(url, 'Agents Jam', 'Posted Jan 10, 2026. Submissions open now.')).toBe(true);
		expect(isPastEvent('Oct 05 - 27, 2026', NOW)).toBe(false);
		expect(isPastEvent('Sep 01 - 30, 2026', NOW)).toBe(true);
	});
});

describe('parseComposedSummary — organiser and themes from the Devpost-composed line only', () => {
	test('reads organiser and themes', () => {
		const parsed = parseComposedSummary('By Amazon · Aug 31 - Oct 23, 2026 · $138,000 in prizes · 54,512 registered · Machine Learning/AI, Open Ended · Online');
		expect(parsed).toEqual({ organizer: 'Amazon', themes: ['Machine Learning/AI', 'Open Ended'] });
	});
	test('an in-person venue is never read as a theme', () => {
		expect(parseComposedSummary('By ACME · Oct 01 - 05, 2026 · 120 registered · In person · Lagos, Nigeria').themes).toEqual([]);
	});
	test('a web-search snippet yields nothing rather than a guess', () => {
		expect(parseComposedSummary('Join builders worldwide for a weekend of AI · via devfolio.co')).toEqual({ organizer: null, themes: [] });
	});
});

const base: HackathonCandidate = {
	id: 'c1', title: 'T', url: 'https://t.devpost.com/', platform: 't.devpost.com', summary: '', startsAt: '2026-08-31', prize: '$138,000',
	endsAt: '2026-10-23', deadline: '2026-10-23', participants: 54_752, format: 'online', organizer: 'Amazon', themes: [], topPick: false,
	eligibility: 'unknown', eligibilityNote: '', eligibilityQuote: null, eligibilityNeedsConfirm: false, rulesUrl: null,
	openStatusUnverified: false, saved: false, aiFit: 'unknown', aiFitReason: '', aiFitConfidence: null,
};

describe('display formatting shared by the chat card and Discover', () => {
	test('compact numbers floor, never round up', () => {
		expect(compactCount(54_752)).toBe('54.7k');
		expect(compactCount(1_000)).toBe('1k');
		expect(compactCount(883)).toBe('883');
		expect(compactCount(1_000_000)).toBe('1M');
	});
	test('prize keeps its own currency', () => {
		expect(compactPrize('$138,000')).toBe('$138k');
		expect(compactPrize('₹ 100,000')).toBe('₹100k');
		expect(compactPrize('$67,500')).toBe('$67.5k');
		expect(compactPrize('Swag and credits')).toBe('Swag and credits');
		expect(compactPrize(null)).toBeNull();
	});
	test('row facts: prize · entered · deadline, omitting what is unknown', () => {
		expect(rowFacts(base)).toEqual(['$138k', '54.7k entered', 'ends Oct 23']);
		expect(rowFacts({ ...base, prize: null, participants: null, deadline: null, endsAt: null })).toEqual([]);
	});
	test('platform names', () => {
		expect(platformName('amazonappdev2026.devpost.com')).toBe('Devpost');
		expect(platformName('dorahacks.io')).toBe('DoraHacks');
		expect(platformName('example.org')).toBe('example.org');
	});
	test('eligibility wording never softens the verdict', () => {
		expect(eligibilityView({ ...base, eligibility: 'eligible', eligibilityNote: 'You can enter', eligibilityQuote: 'q' })).toMatchObject({ state: 'eligible', short: 'Can enter', why: 'Why you can enter' });
		expect(eligibilityView({ ...base, eligibilityNeedsConfirm: true, eligibilityNote: "Open to NG · confirm you're 13+" })).toMatchObject({ state: 'confirm', short: 'Confirm 13+' });
		expect(eligibilityView(base)).toMatchObject({ state: 'unknown', short: 'Not checked', why: null });
		expect(eligibilityView({ ...base, eligibility: 'ineligible', eligibilityNote: 'Only open to US' })).toMatchObject({ state: 'ineligible', label: 'Only open to US', short: "Can't enter" });
	});
});
