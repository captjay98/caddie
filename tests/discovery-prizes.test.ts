import { describe, expect, test } from 'bun:test';
import type { CandidateDigest } from '../apps/app/src/server/candidate-inspection.ts';
import { overlayOfficialPrizeAmounts, parseOfficialPrizes, type OfficialPrize } from '../apps/app/src/server/discovery-prizes.ts';

const TABLE = `
| | | | |
| --- | --- | --- | --- |
| Prize Name | Prize Items | Quantity | Eligibility |
| Overall Awards |
| Grand Prize | * $20,000 USD | 1 | All Eligible Submissions |
| 2nd Place | * $10,000 USD | 1 | All Eligible Submissions |
| Track Awards |
| Personal AI Track Winner | * NVIDIA Jetson Orin Nano | 1 | Personal AI track |
| Bonus Awards |
| City Winner Awards | * $500 USD | 20 | Attending a participating city event |
| Most Valuable Feedback | * $100 USD * NVIDIA swag pack | 10 | Complete the feedback submission |
`;

function digest(prizes: CandidateDigest['prizes']): CandidateDigest {
	return { headline: 'Build an AI app', about: '', bullets: [], tracks: [], prizes, perks: [], judging: [], fitTracks: [], watchOut: null };
}

const prize = (label: string, amount: string): OfficialPrize => ({ label, amount, quantity: '', eligibility: '' });

describe('official prize tables — deterministic stored-source extraction', () => {
	test('reads the complete prize table even after 12k characters', () => {
		const rows = parseOfficialPrizes(`${'Introduction. '.repeat(1100)}\n${TABLE}`);
		expect(rows[0]).toEqual({ label: 'Grand Prize', amount: '$20,000 USD', quantity: '1', eligibility: 'All Eligible Submissions' });
		expect(rows).toHaveLength(5);
	});

	test('retains exact hardware, combined rewards and eligibility conditions', () => {
		const rows = parseOfficialPrizes(TABLE);
		expect(rows.find(row => row.label === 'Personal AI Track Winner')?.amount).toBe('NVIDIA Jetson Orin Nano');
		expect(rows.find(row => row.label === 'Most Valuable Feedback')).toEqual({
			label: 'Most Valuable Feedback', amount: '$100 USD * NVIDIA swag pack', quantity: '10', eligibility: 'Complete the feedback submission',
		});
	});

	test('does not multiply prize amount by award quantity', () => {
		const city = parseOfficialPrizes(TABLE).find(row => row.label === 'City Winner Awards');
		expect(city?.amount).toBe('$500 USD');
		expect(city?.quantity).toBe('20');
	});

	test('preserves currencies and permits explicitly omitted optional columns', () => {
		expect(parseOfficialPrizes('| Prize Name | Prize Items |\n|---|---|\n| Best app | €2,500 EUR |\n| Second | ₹100,000 |')).toEqual([
			prize('Best app', '€2,500 EUR'), prize('Second', '₹100,000'),
		]);
	});

	test('preserves explicit Qty and Eligible Submissions columns from Amazon rules', () => {
		expect(parseOfficialPrizes('| Prize Name | Prize Items | Qty | Eligible Submissions |\n| Fire TV Track - 1st Place | * $25,000 cash * $15,000 AWS Credits | 1 | All Eligible Submissions submitted into the FireTV Track |')).toEqual([
			{ label: 'Fire TV Track - 1st Place', amount: '$25,000 cash * $15,000 AWS Credits', quantity: '1', eligibility: 'All Eligible Submissions submitted into the FireTV Track' },
		]);
	});

	test('rejects canonical and alias quantity columns on the same table', () => {
		expect(parseOfficialPrizes('| Prize Name | Prize Items | Quantity | Qty |\n| Grand Prize | $20,000 | 1 | 2 |')).toEqual([]);
	});

	test('rejects canonical and alias eligibility columns on the same table', () => {
		expect(parseOfficialPrizes('| Prize Name | Prize Items | Eligibility | Eligible Submissions |\n| Grand Prize | $20,000 | Students | All entrants |')).toEqual([]);
	});

	test('does not reinterpret unrecognized tables, headings or free prose as awards', () => {
		expect(parseOfficialPrizes('### Grand Prize\n$20,000\n| Name | Value |\n|---|---|\n| Grand Prize | $20,000 |')).toEqual([]);
	});

	test('omits ambiguous duplicate labels, including whitespace/case aliases', () => {
		expect(parseOfficialPrizes('| Prize Name | Prize Items |\n|---|---|\n| Grand Prize | $20,000 |\n| grand   prize | $10,000 |\n| Runner up | $500 |')).toEqual([prize('Runner up', '$500')]);
	});

	test('an empty amount on a duplicate label does not make the other row unambiguous', () => {
		expect(parseOfficialPrizes('| Prize Name | Prize Items |\n| Grand Prize | $20,000 |\n| Grand Prize | |')).toEqual([]);
	});

	test('rejects ambiguous column headers and malformed or empty-amount rows', () => {
		expect(parseOfficialPrizes('| Prize Name | Prize Items | Prize Items |\n| Grand | $1 | $2 |')).toEqual([]);
		expect(parseOfficialPrizes('| Prize Name | Prize Items |\n| Grand | |\n| Too many | $1 | ??? |\n| Valid | $500 |')).toEqual([prize('Valid', '$500')]);
	});

	test('stops a table at prose rather than consuming a later unrelated table', () => {
		expect(parseOfficialPrizes('| Prize Name | Prize Items |\n| Real | $1 |\nNot a table\n| Invented | $999 |')).toEqual([prize('Real', '$1')]);
	});
});

describe('official prize overlay — cached digests need no model regeneration', () => {
	test('corrects empty and wrong nonempty cached amounts only on exact normalized labels', () => {
		const original = digest([{ label: 'Grand Prize', amount: '' }, { label: '2ND  Place', amount: 'NVIDIA Jetson Orin Nano' }, { label: 'Unknown', amount: 'Unchanged' }]);
		const result = overlayOfficialPrizeAmounts(original, parseOfficialPrizes(TABLE));
		expect(result?.prizes).toEqual([{ label: 'Grand Prize', amount: '$20,000 USD' }, { label: '2ND  Place', amount: '$10,000 USD' }, { label: 'Unknown', amount: 'Unchanged' }]);
		expect(original.prizes[0]?.amount).toBe('');
		expect(result?.headline).toBe(original.headline);
	});

	test('does not fuzzy-match unrelated labels or append guessed prizes', () => {
		const original = digest([{ label: 'Second Prize', amount: '' }]);
		expect(overlayOfficialPrizeAmounts(original, [prize('2nd Place', '$10,000')])).toBe(original);
	});

	test('fails closed for duplicate source or cached labels', () => {
		const original = digest([{ label: 'Grand Prize', amount: '' }]);
		expect(overlayOfficialPrizeAmounts(original, [prize('Grand Prize', '$20,000'), prize('grand prize', '$1')])).toBe(original);
		const duplicate = digest([{ label: 'Grand Prize', amount: '' }, { label: 'grand prize', amount: 'hardware' }]);
		expect(overlayOfficialPrizeAmounts(duplicate, [prize('Grand Prize', '$20,000')])).toBe(duplicate);
	});

	test('does not fabricate a missing digest and leaves unmatched digests untouched', () => {
		expect(overlayOfficialPrizeAmounts(null, parseOfficialPrizes(TABLE))).toBeNull();
		const original = digest([{ label: 'Grand Prize', amount: '$20,000 USD' }]);
		expect(overlayOfficialPrizeAmounts(original, parseOfficialPrizes(TABLE))).toBe(original);
	});
});
