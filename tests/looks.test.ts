import { describe, expect, test } from 'bun:test';
import {
	LOOKS_BLOCK_INFO,
	decodeLookChoice,
	encodeLookChoice,
	lookThemeBlock,
	looksSaveError,
	parseAppTheme,
	parseLooks,
} from '@caddie/contracts';

// The three looks the owner approved in the picker mock
// (docs/reviews/2026-10-23-look-and-feel-picker), as Caddie would propose them.
const FIELD = {
	id: 'field',
	name: 'Field-ready',
	why: 'Dark text on a light background, with big buttons. Easy to read in bright sun.',
	colors: { bg: '#F7F5EF', surface: '#FFFFFF', text: '#1B1F1A', muted: '#5A6157', primary: '#1F7A3A', onPrimary: '#FFFFFF', border: '#D9D6CC', ok: '#1F7A3A', warn: '#9A4A00', danger: '#B42318' },
	stateSurfaces: [{ name: 'warnBg', bg: '#FFF4E5', fg: '#9A4A00', plain: 'Behind a warning.' }],
	fonts: { heading: 'system-ui, -apple-system, "Segoe UI", sans-serif', body: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
	radius: 10,
	density: 'roomy',
};
const CALM = {
	id: 'calm',
	name: 'Calm and clear',
	why: 'Soft blues and plenty of space. Feels steady for money and the lender report.',
	colors: { bg: '#F4F7FB', surface: '#FFFFFF', text: '#142033', muted: '#5B6B82', primary: '#2B5FD9', onPrimary: '#FFFFFF', border: '#DCE3EE', ok: '#1F7A3A', warn: '#94520A', danger: '#B42318' },
	fonts: { heading: '"Avenir Next", Avenir, "Segoe UI", system-ui', body: '"Avenir Next", Avenir, "Segoe UI", system-ui' },
	radius: 14,
	density: 'comfortable',
};
const WARM = {
	id: 'warm',
	name: 'Warm and bold',
	why: 'Dark background with amber highlights. Gentle on the eyes at dawn and dusk.',
	colors: { bg: '#15120E', surface: '#221D17', text: '#F5EFE6', muted: '#B8AC9A', primary: '#F2A541', onPrimary: '#1A1208', border: '#3A3228', ok: '#7BD88F', warn: '#FFB86B', danger: '#FF8A80' },
	fonts: { heading: 'ui-rounded, "SF Pro Rounded", system-ui', body: 'ui-rounded, "SF Pro Rounded", system-ui' },
	radius: 20,
	density: 'comfortable',
};
const SCREEN = '```html-mock Today\n<main><h1 style="color:var(--text)">Today in your sheds</h1><button style="background:var(--primary);color:var(--on-primary)">Hold to speak</button></main>\n```';

function body(block: unknown, screen = SCREEN): string {
	return [
		'Three starting looks for Farmhand.',
		'```' + LOOKS_BLOCK_INFO,
		JSON.stringify(block, null, 2),
		'```',
		screen,
	].join('\n');
}
const GOOD = { audience: 'poultry and catfish farmers, mostly on their phones in the sheds', recommended: 'field', looks: [FIELD, CALM, WARM] };

describe('a set of looks (caddie-looks)', () => {
	test('the owner-approved three looks parse, with the shared key screen', () => {
		const parsed = parseLooks(body(GOOD));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.set.looks.map((look) => look.id)).toEqual(['field', 'calm', 'warm']);
		expect(parsed.set.recommended).toBe('field');
		expect(parsed.set.audience).toContain('farmers');
		expect(parsed.set.screen.title).toBe('Today');
		expect(parsed.set.screen.html).toContain('var(--primary)');
		expect(parsed.set.display).toBe('Three starting looks for Farmhand.');
		expect(looksSaveError(body(GOOD))).toBeNull();
	});

	test('two looks are enough; one or four are refused', () => {
		expect(parseLooks(body({ ...GOOD, looks: [FIELD, CALM] })).ok).toBe(true);
		const one = parseLooks(body({ ...GOOD, looks: [FIELD] }));
		expect(one.ok).toBe(false);
		if (!one.ok) expect(one.error).toContain('2 or 3 looks');
		expect(parseLooks(body({ ...GOOD, looks: [FIELD, CALM, WARM, { ...WARM, id: 'dusk', name: 'Dusk', colors: { ...WARM.colors, primary: '#E07A5F' } }] })).ok).toBe(false);
	});

	test('a missing block, bad JSON or a missing key screen is refused with a plain reason', () => {
		const none = parseLooks('Some prose and no block at all.');
		expect(none.ok).toBe(false);
		if (!none.ok) expect(none.error).toContain(LOOKS_BLOCK_INFO);
		const bad = parseLooks('```' + LOOKS_BLOCK_INFO + '\n{ not json\n```\n' + SCREEN);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('not valid JSON');
		const noScreen = parseLooks(body(GOOD, ''));
		expect(noScreen.ok).toBe(false);
		if (!noScreen.ok) expect(noScreen.error).toContain('html-mock');
	});

	test('every look must pass the same colour and contrast checks as a design theme', () => {
		const faint = { ...CALM, colors: { ...CALM.colors, muted: '#C9D1DC' } };
		const parsed = parseLooks(body({ ...GOOD, looks: [FIELD, faint] }));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.error).toContain('look "calm"');
			expect(parsed.error).toContain('contrast');
		}
	});

	test('ids are short unique slugs, names are unique, and the recommended look must exist', () => {
		expect(parseLooks(body({ ...GOOD, looks: [FIELD, { ...CALM, id: 'field' }] })).ok).toBe(false);
		expect(parseLooks(body({ ...GOOD, looks: [FIELD, { ...CALM, name: 'Field-ready' }] })).ok).toBe(false);
		expect(parseLooks(body({ ...GOOD, looks: [FIELD, { ...CALM, id: 'Calm Look!' }] })).ok).toBe(false);
		const missing = parseLooks(body({ ...GOOD, recommended: 'neon' }));
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain('recommended');
	});

	test('looks must really differ: two looks with the same background and main colour are refused', () => {
		const twin = { ...CALM, id: 'twin', name: 'Twin', colors: { ...CALM.colors, bg: FIELD.colors.bg, primary: FIELD.colors.primary } };
		const parsed = parseLooks(body({ ...GOOD, looks: [FIELD, twin] }));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain('different');
	});

	test('a choice round-trips through the decision note, with or without the owner\'s own words', () => {
		expect(decodeLookChoice(encodeLookChoice('calm', ''))).toEqual({ lookId: 'calm', note: '' });
		expect(decodeLookChoice(encodeLookChoice('field', 'the first one, but warmer'))).toEqual({ lookId: 'field', note: 'the first one, but warmer' });
		expect(decodeLookChoice('just some feedback')).toEqual({ lookId: null, note: 'just some feedback' });
	});

	test('the chosen look becomes a valid caddie-theme block for the design brief', () => {
		const parsed = parseLooks(body(GOOD));
		if (!parsed.ok) throw new Error(parsed.error);
		const block = lookThemeBlock(parsed.set.looks[1]!);
		expect(block.startsWith('```caddie-theme\n')).toBe(true);
		expect(block).not.toContain('"id"');
		const theme = parseAppTheme(`A brief.\n${block}`);
		expect(theme.ok).toBe(true);
		if (theme.ok) expect(theme.theme.name).toBe('Calm and clear');
	});
});
