import { describe, expect, test } from 'bun:test';
import {
	APP_USER_A_EMAIL,
	APP_USER_B_EMAIL,
	firstTextField,
	pickRecordTarget,
	pickRecordTargetFromDesign,
	readInboxCode,
	type TestInbox,
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
