import { afterEach, describe, expect, test } from 'bun:test';
import { digestCandidate, digestProfileFrom, normalizeDigest, type InspectableCandidate } from '../apps/app/src/server/candidate-inspection.ts';

/**
 * Stage 2 (detail pane) — the AI digest for one candidate, unit-tested with a
 * STUBBED global fetch (no real model call). Same fail-soft contract as
 * inspectCandidates: no key / non-2xx / network error / unparseable / empty
 * all return { digest: null, gap } and NEVER throw. The digest is Tier 1 of the
 * detail pane; the verbatim rules below it are the source of truth, so a null
 * digest degrades to "read the rules below", never to a fabricated summary.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubModel(opts: { content?: unknown; status?: number; throwNetwork?: boolean }): void {
	globalThis.fetch = (async () => {
		if (opts.throwNetwork) throw new Error('boom');
		const status = opts.status ?? 200;
		return {
			ok: status < 400,
			status,
			json: async () => ({ choices: [{ message: { content: opts.content ?? '' } }] }),
		} as Response;
	}) as unknown as typeof fetch;
}

const CANDIDATE: InspectableCandidate = {
	id: 'c0',
	url: 'https://a.devpost.com',
	title: 'AI Agents Hack',
	summary: 'Build AI agents with TypeScript. Online, open worldwide, 18+, ends Oct 23.',
};
const PROFILE = { country: 'NG', experienceLevel: 'senior', formatPreference: 'online', interests: ['ai agents'], skills: ['typescript'] };

describe('Stage 2 — digestCandidate (detail-pane Tier 1, stubbed fetch)', () => {
	test('no key -> null digest + a visible gap, never throws', async () => {
		const result = await digestCandidate({ profile: PROFILE, candidate: CANDIDATE });
		expect(result.digest).toBeNull();
		expect(result.gap).toBeTruthy();
		expect(result.gap!.toLowerCase()).toContain('rules below');
	});

	test('happy path -> headline, bullets, watch-out parsed and clamped', async () => {
		stubModel({
			content: JSON.stringify({
				headline: 'A strong online AI-agents fit with low eligibility friction.',
				bullets: ['Open to → anyone 18+ worldwide', 'Must ship → a working app by Oct 23', ''],
				watch_out: 'Confirm the submission needs a demo video before committing.',
			}),
		});
		const result = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE, facts: ['eligibility verdict: eligible'] });
		expect(result.gap).toBeNull();
		expect(result.digest).not.toBeNull();
		expect(result.digest!.headline).toContain('AI-agents fit');
		// empty bullet dropped
		expect(result.digest!.bullets).toEqual(['Open to → anyone 18+ worldwide', 'Must ship → a working app by Oct 23']);
		expect(result.digest!.watchOut).toContain('demo video');
	});

	test('watch_out null -> digest with watchOut null', async () => {
		stubModel({ content: JSON.stringify({ headline: 'Fine.', bullets: ['A → b'], watch_out: null }) });
		const result = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE });
		expect(result.digest!.watchOut).toBeNull();
	});

	test('fenced JSON is tolerated', async () => {
		stubModel({ content: '```json\n{"headline":"H","bullets":["A → b"],"watch_out":null}\n```' });
		const result = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE });
		expect(result.digest!.headline).toBe('H');
	});

	test('non-2xx -> null + gap', async () => {
		stubModel({ status: 500 });
		const result = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE });
		expect(result.digest).toBeNull();
		expect(result.gap).toContain('500');
	});

	test('network error -> null + gap', async () => {
		stubModel({ throwNetwork: true });
		const result = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE });
		expect(result.digest).toBeNull();
		expect(result.gap!.toLowerCase()).toContain('request error');
	});

	test('unparseable reply -> null + gap', async () => {
		stubModel({ content: 'sorry, I cannot help with that' });
		const result = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE });
		expect(result.digest).toBeNull();
		expect(result.gap).toBeTruthy();
	});

	test('empty digest (no headline, no bullets) -> null + gap, never a fabricated summary', async () => {
		stubModel({ content: JSON.stringify({ headline: '', bullets: [], watch_out: null }) });
		const result = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE });
		expect(result.digest).toBeNull();
		expect(result.gap).toBeTruthy();
	});
});

describe('digest v2 — about, tracks, prizes, perks, judging, fit (stubbed fetch)', () => {
	test('rich response -> every new field parsed and bounded', async () => {
		stubModel({
			content: JSON.stringify({
				headline: 'An online AI agents hackathon.',
				about: 'Build an agent that runs on the sponsor cloud.',
				bullets: ['Format → online'],
				tracks: [
					{ name: 'Fire TV', detail: 'Ship an app on Fire OS' },
					{ name: 'Alexa+', detail: 'Build a voice skill' },
					{ name: '', detail: 'nameless track is dropped' },
				],
				prizes: [{ label: 'Grand prize', amount: '$10,000' }, { label: '', amount: '' }],
				perks: ['$300 in cloud credits', ''],
				judging: ['Technical execution', 'Impact'],
				fit_tracks: [{ name: 'Alexa+', why: 'You list TypeScript and voice interests' }],
				watch_out: null,
			}),
		});
		const { digest, gap } = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE });
		expect(gap).toBeNull();
		expect(digest!.about).toContain('sponsor cloud');
		expect(digest!.tracks.map((t) => t.name)).toEqual(['Fire TV', 'Alexa+']);
		expect(digest!.prizes).toEqual([{ label: 'Grand prize', amount: '$10,000' }]);
		expect(digest!.perks).toEqual(['$300 in cloud credits']);
		expect(digest!.judging).toEqual(['Technical execution', 'Impact']);
		expect(digest!.fitTracks).toEqual([{ name: 'Alexa+', why: 'You list TypeScript and voice interests' }]);
	});

	test('a page that lists nothing -> empty sections, never invented', async () => {
		stubModel({ content: JSON.stringify({ headline: 'A hackathon.', bullets: ['Format → online'] }) });
		const { digest } = await digestCandidate({ apiKey: 'k', profile: PROFILE, candidate: CANDIDATE });
		expect(digest!.about).toBe('');
		expect(digest!.tracks).toEqual([]);
		expect(digest!.prizes).toEqual([]);
		expect(digest!.perks).toEqual([]);
		expect(digest!.judging).toEqual([]);
		expect(digest!.fitTracks).toEqual([]);
	});

	test('a fit track that is not a listed track is dropped (fit stays grounded in the page)', () => {
		const digest = normalizeDigest({
			headline: 'x',
			tracks: [{ name: 'Fire TV', detail: '' }],
			fit_tracks: [{ name: 'Made-up track', why: 'invented' }, { name: 'fire tv', why: 'case-insensitive match' }],
		});
		expect(digest!.fitTracks).toEqual([{ name: 'fire tv', why: 'case-insensitive match' }]);
	});

	test('the full profile and the whole 12k overview reach the prompt', async () => {
		let body = '';
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			body = String(init?.body ?? '');
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"headline":"x"}' } }] }) } as Response;
		}) as unknown as typeof fetch;
		const overview = 'a'.repeat(9000) + 'PRIZE_MARKER' + 'b'.repeat(1000);
		await digestCandidate({
			apiKey: 'k',
			profile: digestProfileFrom({ country: 'NG', skills: ['typescript'], stackIds: ['react'], freeTextInterests: ['voice'], weeklyHours: 10 }),
			candidate: CANDIDATE,
			overview,
		});
		expect(body).toContain('PRIZE_MARKER'); // past the old 8000-char cut
		expect(body).toContain('typescript');
		expect(body).toContain('react');
		expect(body).toContain('voice');
	});

	test('digestProfileFrom(null) -> country-only empty profile', () => {
		expect(digestProfileFrom(null)).toEqual({ country: null });
	});
});
