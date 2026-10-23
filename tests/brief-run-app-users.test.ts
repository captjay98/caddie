import { describe, expect, test } from 'bun:test';
import {
	APP_USER_A_EMAIL,
	APP_USER_B_EMAIL,
	firstTextField,
	type FormField,
	isTextLikeField,
	pickRecordTarget,
	pickRecordTargetFromDesign,
	planFormFill,
	readInboxCode,
	screenIsOpenable,
	type TestInbox,
	todayValue,
} from '../scripts/brief-run/app-users.ts';
import type { ArchitectureBlock } from '@caddie/contracts';

/**
 * LANE 8 ITEM 2 — the pure parts of the two-app-user browser check:
 *   - pickRecordTarget: the first PERSON-owned table with a create route and a
 *     screen showing it; an app with none is "not applicable", never passed;
 *   - readInboxCode: the newest sign-in code for an email from the real
 *     test-inbox shape;
 *   - pickRecordTargetFromDesign: parsing a real design doc's
 *     caddie-architecture block.
 */

// A minimal valid block, built up per test. version 2, one module "app".
function block(over: Partial<ArchitectureBlock> = {}): ArchitectureBlock {
	return {
		version: 2,
		signIn: 'required',
		team: null,
		modules: [{ id: 'app', plain: 'The app', dependsOn: [] }],
		tables: [],
		routes: [],
		screens: [],
		services: [],
		ai: [],
		payments: null,
		emails: [],
		jobs: [],
		screenOnly: [],
		...over,
	} as ArchitectureBlock;
}

const noteTable = { name: 'notes', module: 'app', plain: 'Each note', owner: 'person' as const, fields: [{ name: 'body', type: 'text' as const, references: null }] };
const noteCreate = {
	id: 'notes.create', module: 'app', feature: 'notes', op: 'create' as const, method: 'POST' as const,
	path: '/api/notes', table: 'notes', plain: 'Add a note', access: 'person' as const,
	request: [{ name: 'body', type: 'text' as const, example: 'Buy milk' }], response: ['id', 'body'],
};
const noteScreen = { id: 'notes', module: 'app', path: '#/notes', plain: 'Your notes', shows: ['notes'] };

describe('pickRecordTarget (item 2)', () => {
	test('picks the first person-owned table with a create route and a screen', () => {
		const choice = pickRecordTarget(block({ tables: [noteTable], routes: [noteCreate], screens: [noteScreen] }));
		expect(choice.applicable).toBe(true);
		if (choice.applicable) {
			expect(choice.target.table.name).toBe('notes');
			expect(choice.target.createRoute.id).toBe('notes.create');
			expect(choice.target.screen.id).toBe('notes');
			expect(choice.target.markerField).toBe('body'); // the first text field
		}
	});

	test('no person-owned table → not applicable (a shared/public app is not a pass)', () => {
		const shared = { ...noteTable, owner: 'shared' as const };
		const choice = pickRecordTarget(block({ tables: [shared], routes: [{ ...noteCreate }], screens: [noteScreen] }));
		expect(choice.applicable).toBe(false);
		if (!choice.applicable) expect(choice.reason).toMatch(/no person-owned table/);
	});

	test('a person table with no create route → not applicable', () => {
		const choice = pickRecordTarget(block({ tables: [noteTable], routes: [], screens: [noteScreen] }));
		expect(choice.applicable).toBe(false);
	});

	test('a person table with a create route but NO screen showing it → not applicable', () => {
		const choice = pickRecordTarget(block({ tables: [noteTable], routes: [noteCreate], screens: [] }));
		expect(choice.applicable).toBe(false);
		if (!choice.applicable) expect(choice.reason).toMatch(/screen showing it/);
	});

	test('a create route with no text field → not applicable (nowhere to type a marker)', () => {
		const noText = { ...noteCreate, request: [{ name: 'count', type: 'integer' as const, example: '3' }] };
		const noTextTable = { ...noteTable, fields: [{ name: 'count', type: 'integer' as const, references: null }] };
		const choice = pickRecordTarget(block({ tables: [noTextTable], routes: [noText], screens: [noteScreen] }));
		expect(choice.applicable).toBe(false);
	});

	test('skips a person table without a usable route and picks a later one that works', () => {
		const tasks = { ...noteTable, name: 'tasks' };
		const tasksScreen = { ...noteScreen, id: 'tasks', path: '#/tasks', shows: ['tasks'] };
		// tasks has no create route; notes does → notes is chosen despite being second.
		const choice = pickRecordTarget(block({
			tables: [tasks, noteTable],
			routes: [noteCreate],
			screens: [tasksScreen, noteScreen],
		}));
		expect(choice.applicable).toBe(true);
		if (choice.applicable) expect(choice.target.table.name).toBe('notes');
	});

	test('a screen whose path has a :param is skipped (it cannot be opened without the id)', () => {
		// The only screen for notes is `#/notes/:id` — not openable. MUTATION:
		// drop the screenIsOpenable guard and this would wrongly pick it.
		const paramScreen = { ...noteScreen, path: '#/notes/:id' };
		const choice = pickRecordTarget(block({ tables: [noteTable], routes: [noteCreate], screens: [paramScreen] }));
		expect(choice.applicable).toBe(false);
		if (!choice.applicable) expect(choice.reason).toMatch(/param-free screen/);
	});

	test('a param-free screen is preferred over a :param one for the same table', () => {
		const paramScreen = { ...noteScreen, id: 'note-detail', path: '#/notes/:id' };
		const choice = pickRecordTarget(block({ tables: [noteTable], routes: [noteCreate], screens: [paramScreen, noteScreen] }));
		expect(choice.applicable).toBe(true);
		if (choice.applicable) expect(choice.target.screen.path).toBe('#/notes');
	});
});

describe('screenIsOpenable (item 2)', () => {
	test('a param-free hash path is openable; a :param path is not', () => {
		expect(screenIsOpenable('#/notes')).toBe(true);
		expect(screenIsOpenable('#/')).toBe(true);
		expect(screenIsOpenable('#/notes/new')).toBe(true);
		expect(screenIsOpenable('#/notes/:id')).toBe(false);
		expect(screenIsOpenable('#/team/:teamId/members')).toBe(false);
	});
});

describe('planFormFill (item 2): which field gets which value', () => {
	const NOW = new Date('2026-10-23T14:05:00');

	test('the marker goes in the first text field; nothing else is filled when nothing else is required', () => {
		const fields: FormField[] = [
			{ kind: 'input', type: 'text', required: true, hasValue: false },
			{ kind: 'input', type: 'number', required: false, hasValue: false },
		];
		const steps = planFormFill(fields, 'MARKER-1', NOW);
		expect(steps).toEqual([{ index: 0, action: 'fill', value: 'MARKER-1', marker: true }]);
	});

	test('a textarea is the first text field when there is no text input before it', () => {
		const fields: FormField[] = [
			{ kind: 'input', type: 'number', required: true, hasValue: false },
			{ kind: 'textarea', required: true, hasValue: false },
		];
		const steps = planFormFill(fields, 'M', NOW);
		// The number (required) is filled 1; the textarea carries the marker.
		expect(steps).toContainEqual({ index: 1, action: 'fill', value: 'M', marker: true });
		expect(steps).toContainEqual({ index: 0, action: 'fill', value: '1' });
	});

	test('every required typed field is filled by its type so the form validates', () => {
		const fields: FormField[] = [
			{ kind: 'input', type: 'text', required: true, hasValue: false }, // marker
			{ kind: 'input', type: 'number', required: true, hasValue: false },
			{ kind: 'input', type: 'date', required: true, hasValue: false },
			{ kind: 'input', type: 'datetime-local', required: true, hasValue: false },
			{ kind: 'input', type: 'email', required: true, hasValue: false },
			{ kind: 'input', type: 'url', required: true, hasValue: false },
			{ kind: 'input', type: 'checkbox', required: true, hasValue: false },
			{ kind: 'select', required: true, hasValue: false, options: ['', 'red', 'blue'] },
		];
		const steps = planFormFill(fields, 'MK', NOW);
		expect(steps).toEqual([
			{ index: 0, action: 'fill', value: 'MK', marker: true },
			{ index: 1, action: 'fill', value: '1' },
			{ index: 2, action: 'fill', value: '2026-10-23' },
			{ index: 3, action: 'fill', value: '2026-10-23T14:05' },
			{ index: 4, action: 'fill', value: 'x@campaign.test' },
			{ index: 5, action: 'fill', value: 'https://example.com' },
			{ index: 6, action: 'check', value: 'on' },
			{ index: 7, action: 'select', value: 'red' },
		]);
	});

	test('a field that already holds a value is never overwritten', () => {
		const fields: FormField[] = [
			{ kind: 'input', type: 'text', required: true, hasValue: false }, // marker
			{ kind: 'input', type: 'number', required: true, hasValue: true }, // already set
		];
		const steps = planFormFill(fields, 'M', NOW);
		expect(steps).toEqual([{ index: 0, action: 'fill', value: 'M', marker: true }]);
	});

	test('an optional checkbox/select/typed field is left alone (an empty optional never blocks submit)', () => {
		const fields: FormField[] = [
			{ kind: 'input', type: 'text', required: true, hasValue: false }, // marker
			{ kind: 'input', type: 'checkbox', required: false, hasValue: false },
			{ kind: 'select', required: false, hasValue: false, options: ['', 'a'] },
			{ kind: 'input', type: 'number', required: false, hasValue: false },
		];
		const steps = planFormFill(fields, 'M', NOW);
		expect(steps).toEqual([{ index: 0, action: 'fill', value: 'M', marker: true }]);
	});

	test('a second required text field is also filled (with the marker text), but an optional one is not', () => {
		const fields: FormField[] = [
			{ kind: 'input', type: 'text', required: true, hasValue: false }, // marker
			{ kind: 'input', type: 'text', required: true, hasValue: false }, // required → filled
			{ kind: 'input', type: 'text', required: false, hasValue: false }, // optional → skipped
		];
		const steps = planFormFill(fields, 'M', NOW);
		expect(steps).toEqual([
			{ index: 0, action: 'fill', value: 'M', marker: true },
			{ index: 1, action: 'fill', value: 'M' },
		]);
	});

	test('isTextLikeField: text/search/typeless input and textarea are text; number/select are not', () => {
		expect(isTextLikeField({ kind: 'input', type: 'text', required: false, hasValue: false })).toBe(true);
		expect(isTextLikeField({ kind: 'input', type: 'search', required: false, hasValue: false })).toBe(true);
		expect(isTextLikeField({ kind: 'input', required: false, hasValue: false })).toBe(true);
		expect(isTextLikeField({ kind: 'textarea', required: false, hasValue: false })).toBe(true);
		expect(isTextLikeField({ kind: 'input', type: 'number', required: false, hasValue: false })).toBe(false);
		expect(isTextLikeField({ kind: 'select', required: false, hasValue: false })).toBe(false);
	});
});

describe('todayValue (item 2)', () => {
	test('date is YYYY-MM-DD; datetime-local adds the time', () => {
		const now = new Date('2026-01-09T08:07:00');
		expect(todayValue('date', now)).toBe('2026-01-09');
		expect(todayValue('datetime-local', now)).toBe('2026-01-09T08:07');
	});
});

describe('firstTextField (item 2)', () => {
	test('returns the first text request-field, or null when there is none', () => {
		expect(firstTextField(noteCreate)).toBe('body');
		expect(firstTextField({ ...noteCreate, request: [{ name: 'n', type: 'integer', example: '1' }] })).toBeNull();
	});
});

describe('readInboxCode (item 2): the real test-inbox shape', () => {
	const inbox: TestInbox = {
		messages: [
			{ to: 'a@campaign.test', code: '111111', createdAt: '2026-10-26T10:00:00.000Z' },
			{ to: 'A@Campaign.Test', code: '333333', createdAt: '2026-10-26T10:00:10.000Z' }, // newest, mixed case
			{ to: 'b@campaign.test', code: '222222', createdAt: '2026-10-26T10:00:05.000Z' },
		],
		emails: [],
	};

	test('returns the NEWEST code for an email, case-insensitively', () => {
		expect(readInboxCode(inbox, APP_USER_A_EMAIL)).toBe('333333');
		expect(readInboxCode(inbox, APP_USER_B_EMAIL)).toBe('222222');
	});

	test('returns null while no code for the email has arrived yet', () => {
		expect(readInboxCode({ messages: [] }, APP_USER_A_EMAIL)).toBeNull();
		expect(readInboxCode(inbox, 'c@campaign.test')).toBeNull();
	});
});

describe('pickRecordTargetFromDesign (item 2): parse a real design doc', () => {
	const design = [
		'# How your app works',
		'',
		'A simple notes app.',
		'',
		'```caddie-architecture',
		JSON.stringify({
			version: 2,
			signIn: 'required',
			team: null,
			modules: [{ id: 'app', plain: 'The app', dependsOn: [] }],
			tables: [noteTable],
			routes: [noteCreate],
			screens: [noteScreen],
			services: [],
			ai: [],
			payments: null,
			emails: [],
			jobs: [],
			screenOnly: [],
		}),
		'```',
		'',
	].join('\n');

	test('lifts the block and picks the person-owned record', () => {
		const choice = pickRecordTargetFromDesign(design);
		expect(choice.applicable).toBe(true);
		if (choice.applicable) expect(choice.target.table.name).toBe('notes');
	});

	test('a design with no architecture block is not applicable with a readable reason', () => {
		const choice = pickRecordTargetFromDesign('# A design with no block');
		expect(choice.applicable).toBe(false);
		if (!choice.applicable) expect(choice.reason).toMatch(/architecture block/);
	});
});
