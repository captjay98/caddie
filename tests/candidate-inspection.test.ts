import { afterEach, describe, expect, test } from 'bun:test';
import { inspectCandidates, type InspectableCandidate } from '../apps/app/src/server/candidate-inspection.ts';

/**
 * Stage 2 — AI inspection of discovery candidates, unit-tested with a STUBBED
 * global fetch (no real model call). The module makes ONE batched call to the
 * Nebius helper route and is FAIL-SOFT: no key / failed request / unparseable
 * reply all return an empty map + a visible gap, never throw. Covers:
 *   - no key -> empty + gap (ranked by heuristics only);
 *   - happy path -> each candidate gets a verdict/reason/confidence;
 *   - a candidate the model omits stays absent (honest 'unknown' at read site);
 *   - an out-of-range index the model invents maps to nothing (dropped);
 *   - reason/confidence are clamped (bounded length, 0..1);
 *   - non-2xx -> empty + gap; unparseable JSON -> empty + gap;
 *   - empty candidate list -> empty + no gap (nothing to inspect, no error).
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

const CANDIDATES: InspectableCandidate[] = [
	{ id: 'c0', url: 'https://a.devpost.com', title: 'AI Agents Hack', summary: 'Build AI agents with TypeScript. Online, open worldwide.' },
	{ id: 'c1', url: 'https://b.devfolio.co', title: 'Fintech Lagos', summary: 'In-person fintech event in Lagos.' },
];

const PROFILE = { country: 'NG', experienceLevel: 'senior', formatPreference: 'online', interests: ['ai agents'], skills: ['typescript'] };

describe('Stage 2 — inspectCandidates (batched AI fit, stubbed fetch)', () => {
	test('no key -> empty map + a visible gap (heuristics-only), never throws', async () => {
		const result = await inspectCandidates({ profile: PROFILE, candidates: CANDIDATES });
		expect(result.byId.size).toBe(0);
		expect(result.gap).toBeTruthy();
		expect(result.gap!.toLowerCase()).toContain('heuristics');
	});

	test('empty candidate list -> empty map, NO gap (nothing to inspect is not an error)', async () => {
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: [] });
		expect(result.byId.size).toBe(0);
		expect(result.gap).toBeNull();
	});

	test('happy path -> each candidate gets a verdict/reason/confidence', async () => {
		stubModel({
			content: JSON.stringify({
				items: [
					{ i: 0, verdict: 'strong', reason: 'Matches your AI-agents interest and TypeScript skill, and it is online.', confidence: 0.9 },
					{ i: 1, verdict: 'weak', reason: 'In-person in Lagos but little topical overlap.', confidence: 0.4 },
				],
			}),
		});
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: CANDIDATES });
		expect(result.gap).toBeNull();
		expect(result.byId.get('c0')).toEqual({ verdict: 'strong', reason: 'Matches your AI-agents interest and TypeScript skill, and it is online.', confidence: 0.9 });
		expect(result.byId.get('c1')!.verdict).toBe('weak');
	});

	test('a candidate the model OMITS stays absent (honest unknown at the read site)', async () => {
		stubModel({ content: JSON.stringify({ items: [{ i: 0, verdict: 'possible', reason: 'Some overlap.', confidence: 0.5 }] }) });
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: CANDIDATES });
		expect(result.byId.has('c0')).toBe(true);
		expect(result.byId.has('c1')).toBe(false); // not scored -> absent, not fabricated
	});

	test('an invented out-of-range index maps to nothing (dropped, never mis-assigned)', async () => {
		stubModel({ content: JSON.stringify({ items: [{ i: 7, verdict: 'strong', reason: 'ghost', confidence: 1 }] }) });
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: CANDIDATES });
		expect(result.byId.size).toBe(0);
	});

	test('reason is length-bounded and confidence is clamped to 0..1; bad verdict -> unknown', async () => {
		stubModel({
			content: JSON.stringify({
				items: [{ i: 0, verdict: 'amazing', reason: 'x'.repeat(500), confidence: 9 }],
			}),
		});
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: CANDIDATES });
		const c0 = result.byId.get('c0')!;
		expect(c0.verdict).toBe('unknown'); // 'amazing' is not a valid verdict
		expect(c0.reason.length).toBeLessThanOrEqual(160);
		expect(c0.confidence).toBe(1); // clamped from 9
	});

	test('tolerates a fenced ```json block around the object', async () => {
		stubModel({ content: '```json\n{"items":[{"i":0,"verdict":"possible","reason":"ok","confidence":0.5}]}\n```' });
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: CANDIDATES });
		expect(result.byId.get('c0')!.verdict).toBe('possible');
	});

	test('non-2xx -> empty + gap (fail-soft)', async () => {
		stubModel({ status: 503, content: '' });
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: CANDIDATES });
		expect(result.byId.size).toBe(0);
		expect(result.gap).toContain('503');
	});

	test('unparseable reply -> empty + gap (fail-soft)', async () => {
		stubModel({ content: 'I am a reasoning model and I forgot to output JSON.' });
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: CANDIDATES });
		expect(result.byId.size).toBe(0);
		expect(result.gap).toBeTruthy();
	});

	test('network throw -> empty + gap (fail-soft, never throws)', async () => {
		stubModel({ throwNetwork: true });
		const result = await inspectCandidates({ apiKey: 'k', profile: PROFILE, candidates: CANDIDATES });
		expect(result.byId.size).toBe(0);
		expect(result.gap).toBeTruthy();
	});
});
