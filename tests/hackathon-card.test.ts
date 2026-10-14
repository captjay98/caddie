import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import { HackathonResultsCardSchema } from '../packages/contracts/src/index.ts';

/**
 * Stage 2 — the hackathon-results card contract. Locks the HONESTY shape: the
 * nullable fields (platform/startsAt/prize) accept null (rendered "unknown",
 * never fabricated), eligibility is the closed verdict set, and a malformed
 * payload is REJECTED (the Channel then shows its honest fault, never a guess).
 */

const validCandidate = {
	id: 'cand_1',
	title: 'Uncommon Hacks 2026',
	url: 'https://uncommon-hacks-2026.devpost.com',
	platform: 'devpost.com',
	summary: 'By UChicago · open theme',
	startsAt: null,
	prize: null,
	eligibility: 'unknown' as const,
	saved: false,
};

describe('HackathonResultsCardSchema', () => {
	test('accepts a valid card with nullable fields as null (honest unknowns)', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [validCandidate],
			gaps: ['Live web results — verify dates against each source.'],
			profileCountry: 'NG',
		});
		expect(r.success).toBe(true);
	});

	test('accepts a populated prize/startsAt/platform when the tool genuinely has them', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [{ ...validCandidate, startsAt: '2026-11-01', prize: '$100,000', platform: 'mlh.io', eligibility: 'eligible' }],
			gaps: [],
			profileCountry: null,
		});
		expect(r.success).toBe(true);
	});

	test('rejects an unknown eligibility verdict (closed set — no invented status)', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [{ ...validCandidate, eligibility: 'maybe' }],
			gaps: [],
			profileCountry: null,
		});
		expect(r.success).toBe(false);
	});

	test('rejects a candidate missing its cited url', () => {
		const { url, ...noUrl } = validCandidate;
		void url;
		const r = safeParse(HackathonResultsCardSchema, { candidates: [noUrl], gaps: [], profileCountry: null });
		expect(r.success).toBe(false);
	});

	test('rejects an unknown extra field (strict object — payload drift is a fault, not a silent pass)', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [{ ...validCandidate, fabricatedDate: 'Oct 14' }],
			gaps: [],
			profileCountry: null,
		});
		expect(r.success).toBe(false);
	});

	// --- Stage 3: AI fit verdict carried through the contract ------------------

	test('back-compat: a candidate with no AI fit fields parses, defaulting to honest unknown/empty', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [validCandidate],
			gaps: [],
			profileCountry: null,
		});
		expect(r.success).toBe(true);
		if (r.success) {
			const c = r.output.candidates[0]!;
			expect(c.aiFit).toBe('unknown');
			expect(c.aiFitReason).toBe('');
			expect(c.aiFitConfidence).toBe(null);
		}
	});

	test('accepts a populated AI fit verdict, reason and confidence', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [{ ...validCandidate, aiFit: 'strong', aiFitReason: 'Matches your AI agent interests and solo-online format.', aiFitConfidence: 0.82 }],
			gaps: [],
			profileCountry: 'NG',
		});
		expect(r.success).toBe(true);
		if (r.success) {
			const c = r.output.candidates[0]!;
			expect(c.aiFit).toBe('strong');
			expect(c.aiFitConfidence).toBe(0.82);
		}
	});

	test('rejects an AI fit verdict outside the closed set (no invented fit status)', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [{ ...validCandidate, aiFit: 'perfect' }],
			gaps: [],
			profileCountry: null,
		});
		expect(r.success).toBe(false);
	});

	test('accepts a null AI fit confidence (model gave no number — honest absence)', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [{ ...validCandidate, aiFit: 'possible', aiFitReason: '', aiFitConfidence: null }],
			gaps: [],
			profileCountry: null,
		});
		expect(r.success).toBe(true);
	});

	// --- card redesign: parsed display chips + top-pick flag -------------------

	test('back-compat: a candidate with no display/topPick fields defaults them honestly', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [validCandidate],
			gaps: [],
			profileCountry: null,
		});
		expect(r.success).toBe(true);
		if (r.success) {
			const c = r.output.candidates[0]!;
			expect(c.endsAt).toBe(null);
			expect(c.deadline).toBe(null);
			expect(c.participants).toBe(null);
			expect(c.format).toBe(null);
			expect(c.topPick).toBe(false);
		}
	});

	test('accepts populated display chips + a top-pick card', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [{
				...validCandidate,
				startsAt: '2026-10-03',
				endsAt: '2026-10-24',
				deadline: '2026-10-24',
				prize: '$100,000',
				participants: 1234,
				format: 'online',
				topPick: true,
				aiFit: 'strong',
			}],
			gaps: [],
			profileCountry: 'NG',
		});
		expect(r.success).toBe(true);
		if (r.success) {
			const c = r.output.candidates[0]!;
			expect(c.participants).toBe(1234);
			expect(c.format).toBe('online');
			expect(c.topPick).toBe(true);
		}
	});

	test('rejects a format outside the closed set (online|in-person|hybrid)', () => {
		const r = safeParse(HackathonResultsCardSchema, {
			candidates: [{ ...validCandidate, format: 'in_person' }], // underscore form is NOT the card union
			gaps: [],
			profileCountry: null,
		});
		expect(r.success).toBe(false);
	});

	test('accepts each valid format literal', () => {
		for (const format of ['online', 'in-person', 'hybrid'] as const) {
			const r = safeParse(HackathonResultsCardSchema, {
				candidates: [{ ...validCandidate, format }],
				gaps: [],
				profileCountry: null,
			});
			expect(r.success).toBe(true);
		}
	});
});

describe('buildHackathonReference — the follow-up reference mirrors the card', () => {
	test('one terse row per card candidate, verdict and confirm flag copied unchanged', async () => {
		const { buildHackathonReference } = await import('../apps/app/src/server/hackathon-card.ts');
		const card = {
			candidates: [
				{ ...validCandidate, id: 'cand_a', title: 'Nebius x NVIDIA', url: 'https://nebius.devpost.com', eligibility: 'eligible' as const },
				{ ...validCandidate, id: 'cand_b', title: 'Meta VR Start', url: 'https://metavr.devpost.com', eligibility: 'unknown' as const, eligibilityNeedsConfirm: true },
			],
			gaps: [],
			profileCountry: 'NG',
		};
		const rows = buildHackathonReference(card as never);
		expect(rows).toEqual([
			{ id: 'cand_a', title: 'Nebius x NVIDIA', url: 'https://nebius.devpost.com', eligibility: 'eligible', needsConfirm: false },
			{ id: 'cand_b', title: 'Meta VR Start', url: 'https://metavr.devpost.com', eligibility: 'unknown', needsConfirm: true },
		]);
		// Terse by design: nothing worth re-listing as prose (no summary/prize/dates).
		for (const row of rows) expect(Object.keys(row).sort()).toEqual(['eligibility', 'id', 'needsConfirm', 'title', 'url']);
	});

	test('an empty card yields an empty reference', async () => {
		const { buildHackathonReference } = await import('../apps/app/src/server/hackathon-card.ts');
		expect(buildHackathonReference({ candidates: [], gaps: [], profileCountry: null } as never)).toEqual([]);
	});
});
