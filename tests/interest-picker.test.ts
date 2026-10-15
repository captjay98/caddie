import { describe, expect, test } from 'bun:test';
import { OPEN_TO_ANYTHING_INTEREST, isOpenToAnything, searchableInterests } from '../packages/contracts/src/index.ts';
import {
	MAX_INTERESTS,
	POPULAR_TOPICS,
	TOPIC_GROUPS,
	addCustomInterest,
	canAddCustom,
	customPicks,
	matchTopics,
	toggleInterest,
} from '../apps/app/src/client/interests/catalog.ts';

/**
 * The shared interest picker (onboarding + Settings): everything is a pick,
 * "Open to anything" is an exclusive real answer, and discovery never uses
 * the marker (or an unsplit compound label) as a search term.
 */
describe('interest picker logic', () => {
	test('catalog: 12 popular topics, a broad grouped list, no duplicates', () => {
		expect(POPULAR_TOPICS).toHaveLength(12);
		const all = [...POPULAR_TOPICS, ...TOPIC_GROUPS.flatMap((g) => g.topics)];
		expect(all.length).toBeGreaterThanOrEqual(40);
		expect(new Set(all.map((t) => t.toLowerCase())).size).toBe(all.length);
		expect(all).not.toContain(OPEN_TO_ANYTHING_INTEREST);
	});

	test('toggle: on, off, and "Open to anything" is exclusive both ways', () => {
		expect(toggleInterest([], 'Health')).toEqual(['Health']);
		expect(toggleInterest(['Health'], 'Health')).toEqual([]);
		expect(toggleInterest(['Health', 'Games'], OPEN_TO_ANYTHING_INTEREST)).toEqual([OPEN_TO_ANYTHING_INTEREST]);
		expect(toggleInterest([OPEN_TO_ANYTHING_INTEREST], 'Games')).toEqual(['Games']);
		expect(toggleInterest([OPEN_TO_ANYTHING_INTEREST], OPEN_TO_ANYTHING_INTEREST)).toEqual([]);
	});

	test('cap: a 13th pick is ignored, removing one frees a slot', () => {
		const twelve = Array.from({ length: MAX_INTERESTS }, (_, i) => `Topic ${i}`);
		expect(toggleInterest(twelve, 'One more')).toEqual(twelve);
		expect(toggleInterest(twelve, 'Topic 0')).toHaveLength(MAX_INTERESTS - 1);
		// "Open to anything" is always allowed: it replaces the whole list.
		expect(toggleInterest(twelve, OPEN_TO_ANYTHING_INTEREST)).toEqual([OPEN_TO_ANYTHING_INTEREST]);
	});

	test('custom: trimmed, capped at 60 chars, case-insensitive duplicates ignored', () => {
		expect(addCustomInterest([], '  Race   telemetry ')).toEqual(['Race telemetry']);
		expect(addCustomInterest(['Race telemetry'], 'race TELEMETRY')).toEqual(['Race telemetry']);
		expect(addCustomInterest([], 'x'.repeat(80))[0]).toHaveLength(60);
		expect(addCustomInterest([], '   ')).toEqual([]);
		expect(customPicks(['Health', 'Race telemetry', OPEN_TO_ANYTHING_INTEREST])).toEqual(['Race telemetry']);
	});

	test('search: filters every group; "+ Add" only for something not listed or picked', () => {
		const agri = matchTopics('agri');
		expect(agri.flatMap((g) => g.topics)).toEqual(['Agriculture']);
		expect(agri[0]!.label).toBe('Industries');
		expect(matchTopics('')[0]!.label).toBeNull();
		expect(canAddCustom('Agriculture', [])).toBe(false);
		expect(canAddCustom('agriculture', [])).toBe(false);
		expect(canAddCustom('Race telemetry', [])).toBe(true);
		expect(canAddCustom('Race telemetry', ['race telemetry'])).toBe(false);
		expect(canAddCustom('   ', [])).toBe(false);
		expect(canAddCustom('open to anything', [])).toBe(false);
	});
});

describe('searchableInterests (discovery terms)', () => {
	test('drops the "Open to anything" marker', () => {
		expect(isOpenToAnything([OPEN_TO_ANYTHING_INTEREST])).toBe(true);
		expect(isOpenToAnything(['Health'])).toBe(false);
		expect(searchableInterests([OPEN_TO_ANYTHING_INTEREST])).toEqual([]);
		expect(searchableInterests(['open to anything', 'Health'])).toEqual(['Health']);
	});

	test('splits compound labels into matchable terms, de-duplicated', () => {
		expect(searchableInterests(['AI & agents', 'AR / VR', 'Climate & energy'])).toEqual(['AI', 'agents', 'AR', 'VR', 'Climate', 'energy']);
		expect(searchableInterests(['Music and audio', 'Rust, WASM', 'AI', 'ai & agents'])).toEqual(['Music', 'audio', 'Rust', 'WASM', 'AI', 'agents']);
		expect(searchableInterests(['Education'])).toEqual(['Education']);
	});
});
