import { describe, expect, test } from 'bun:test';
import {
	aboutMinutes,
	FEATURE_BLOCK_GUIDE,
	FIRST_VERSION_MAX,
	firstVersionChoiceError,
	ITEM_CHECKS_MAX,
	itemNeeds,
	itemTitleIssue,
	parsePlanFeatures,
	PRD_REVIEW_CRITERIA,
	type PlanFeature,
} from '@caddie/contracts';
import { choiceDiffers, moveToFirst, moveToLater, planChoice } from '../apps/app/src/client/planning/plan-choice.ts';
import { addNextView } from '../apps/app/src/client/project/add-next.ts';

/**
 * Staged builds (owner 2026-10-30): the approved list is built as a small
 * first version, then one "add after" item at a time. These are the pure
 * rules both the plan card and the host apply. LOCAL VERIFIED.
 */

const FEATURES: PlanFeature[] = [
	{ id: 'farm', title: 'Add your farm', doneWhen: ['Saving a farm name shows it on the home screen'] },
	{ id: 'eggs', title: 'Write down today’s eggs', needs: ['farm'], doneWhen: ['Saving 120 eggs shows 120 for today', 'It is still there after a reload'] },
	{ id: 'week', title: 'See this week’s eggs', later: true, needs: ['eggs'], doneWhen: ['The week shows the total of each day'] },
	{ id: 'sales', title: 'Write down egg sales', later: true, needs: ['farm'], doneWhen: ['Saving a sale shows it in the list'] },
	{ id: 'earned', title: 'See what you earned', later: true, needs: ['sales'], doneWhen: ['The week shows money earned'] },
];
const block = (list: unknown) => '```caddie-features\n' + JSON.stringify(list) + '\n```';

describe('the plan list carries "later" and "needs"', () => {
	test('a staged list parses; its first version is the items without "later"', () => {
		const parsed = parsePlanFeatures(block(FEATURES));
		expect(parsed.ok).toBe(true);
		expect(planChoice(FEATURES, null).first.map((f) => f.id)).toEqual(['farm', 'eggs']);
	});
	test('"needs" may only name earlier items, and a first-version item never needs a later one', () => {
		expect(parsePlanFeatures(block([FEATURES[1], FEATURES[0]])).ok).toBe(false);
		const firstNeedsLater = [FEATURES[0], { ...FEATURES[2], later: true }, { id: 'x', title: 'Do x', needs: ['week'], doneWhen: ['x'] }];
		expect(parsePlanFeatures(block(firstNeedsLater))).toMatchObject({ ok: false });
		expect(parsePlanFeatures(block([{ ...FEATURES[0], later: true }]))).toMatchObject({ ok: false });
	});
	test('the guide shown to the plan writer is itself a valid list', () => {
		const example = /```caddie-features\n([\s\S]*?)\n```/.exec(FEATURE_BLOCK_GUIDE)![0];
		expect(parsePlanFeatures(example).ok).toBe(true);
	});
	test('needs are followed through other items', () => {
		expect(itemNeeds(FEATURES, 'earned')).toEqual(['farm', 'sales']);
	});
});

describe('the owner moves items on the plan card', () => {
	test('including an item brings what it needs; moving one to later takes what needs it', () => {
		const up = moveToFirst(FEATURES, ['farm'], 'earned');
		expect(up).toEqual({ ok: true, chosen: ['farm', 'sales', 'earned'] });
		// Bringing "earned" in with eggs already there would make 4: past the ceiling.
		expect(moveToFirst(FEATURES, null, 'earned')).toMatchObject({ ok: false });
		const down = moveToLater(FEATURES, ['farm', 'sales', 'earned'], 'sales');
		expect(down).toEqual({ ok: true, chosen: ['farm'] });
		expect(moveToLater(FEATURES, ['farm'], 'farm')).toMatchObject({ ok: false });
	});
	test('the first version has a ceiling, said in plain words', () => {
		const many = Array.from({ length: FIRST_VERSION_MAX + 1 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}`, later: i > 0 ? true : undefined, doneWhen: ['x'] })) as PlanFeature[];
		const ids = many.slice(0, FIRST_VERSION_MAX).map((f) => f.id);
		expect(moveToFirst(many, ids, many[FIRST_VERSION_MAX]!.id)).toMatchObject({ ok: false });
		expect(firstVersionChoiceError(many, many.map((f) => f.id))).toContain(`at most ${FIRST_VERSION_MAX}`);
	});
	test('a small first version: 3 parts, 3 checks each, and the plan reviewer judges the same numbers', () => {
		expect(FIRST_VERSION_MAX).toBe(3);
		expect(ITEM_CHECKS_MAX).toBe(3);
		const sizing = PRD_REVIEW_CRITERIA.find((line) => line.startsWith('FIRST VERSION'))!;
		expect(sizing).toContain(`at most ${FIRST_VERSION_MAX} items, at most ${ITEM_CHECKS_MAX} doneWhen checks each`);
	});
	test('the host refuses a choice missing what an item needs, an empty choice, and unknown items', () => {
		expect(firstVersionChoiceError(FEATURES, ['farm', 'earned'])).toBe('“See what you earned” needs “Write down egg sales” in the first version too.');
		expect(firstVersionChoiceError(FEATURES, [])).not.toBeNull();
		expect(firstVersionChoiceError(FEATURES, ['nope'])).not.toBeNull();
		expect(firstVersionChoiceError(FEATURES, ['farm', 'sales'])).toBeNull();
	});
	test('only a changed split is sent with the approval', () => {
		expect(choiceDiffers(FEATURES, null)).toBe(false);
		expect(choiceDiffers(FEATURES, ['farm', 'eggs'])).toBe(false);
		expect(choiceDiffers(FEATURES, ['farm'])).toBe(true);
	});
	test('times read as "about N min", rounded up to 5', () => {
		expect(planChoice(FEATURES, null).firstMinutes).toBe(30);
		expect(aboutMinutes(1)).toBe(5);
		expect(aboutMinutes(21)).toBe(25);
	});
});

describe('plain item titles', () => {
	test('system words and long titles are refused; owner words pass', () => {
		expect(itemTitleIssue('Log without signal and sync when back online')).toContain('sync');
		expect(itemTitleIssue('A flagged-days list from Caddie’s AI')).toContain('flagged');
		expect(itemTitleIssue('See the feed dashboard')).toContain('dashboard');
		expect(itemTitleIssue('Write down today’s birds, feed, eggs and sales from your phone each day')).toContain('10 words');
		expect(itemTitleIssue('Write down today’s eggs')).toBeNull();
		expect(itemTitleIssue('Works with no signal, saves when you’re back')).toBeNull();
	});
});

describe('the ready card offers one next idea', () => {
	const stages = {
		first: [],
		firstMinutes: 0,
		later: [
			{ id: 'week', title: 'See this week’s eggs', minutes: 10, needs: [], status: 'available' as const },
			{ id: 'sales', title: 'Write down egg sales', minutes: 10, needs: [], status: 'available' as const },
			{ id: 'earned', title: 'See what you earned', minutes: 10, needs: ['Write down egg sales'], status: 'waiting' as const },
		],
	};
	test('the first available idea leads; the rest wait behind it', () => {
		const view = addNextView(stages, null);
		expect(view.next?.id).toBe('week');
		expect(view.others.map((i) => i.id)).toEqual(['sales']);
		expect(view.waiting.map((i) => i.id)).toEqual(['earned']);
		expect(view.failed).toBeNull();
	});
	test('an idea whose add failed is said plainly and offered again first', () => {
		const view = addNextView(stages, { status: 'failed', request: 'Add from your plan: Write down egg sales' });
		expect(view.failed).toBe('Write down egg sales');
		expect(view.next?.id).toBe('sales');
	});
	test('an ordinary change that failed is not reported as an idea', () => {
		expect(addNextView(stages, { status: 'failed', request: 'Make the buttons bigger' }).failed).toBeNull();
	});
});
