import { describe, expect, test } from 'bun:test';
import type { ArchitectureBlock } from '../packages/contracts/src/architecture.ts';
import { accessPhrase, summariseArchitecture, summariseArchitectureText } from '../apps/app/src/server/architecture-summary.ts';

/**
 * The Design-review summary (plan part B — the summary function): turns the
 * caddie-architecture block into plain sentences. LOCAL VERIFIED.
 */

/** A small app with one private table, sign-in, a service, an AI use and test-mode features. */
function block(): ArchitectureBlock {
	return {
		version: 2,
		signIn: 'required',
		team: null,
		modules: [{ id: 'app', plain: 'The whole app', dependsOn: [] }],
		tables: [{ name: 'notes', module: 'app', plain: 'A note you wrote', owner: 'person', fields: [{ name: 'body', type: 'text', references: null }] }],
		routes: [
			{ id: 'notes.create', module: 'app', feature: 'notes', op: 'create', method: 'POST', path: '/api/notes', table: 'notes', plain: 'add a note', access: 'person', request: [{ name: 'body', type: 'text', example: 'Buy feed' }], response: ['id'] },
			{ id: 'notes.list', module: 'app', feature: 'notes', op: 'list', method: 'GET', path: '/api/notes', table: 'notes', plain: 'list notes', access: 'person', request: [], response: ['id'] },
			{ id: 'reports.export', module: 'app', feature: 'reports', op: 'action', method: 'POST', path: '/api/reports/export', table: null, plain: 'Export a report', access: 'signed-in', request: [], response: ['url'] },
		],
		screens: [{ id: 'notes', module: 'app', path: '#/notes', plain: 'Your notes', shows: ['notes'] }],
		services: [{ id: 'weather', plain: 'weather for the farm', keyName: 'WEATHER_API_KEY', keyPage: 'https://example.com/keys' }],
		ai: [{ id: 'summary-ai', plain: 'explains the week', route: 'reports.export', tier: 'fast', images: false }],
		payments: { currency: 'USD', plans: [{ id: 'pro', plain: 'Pro', priceMinor: 900, interval: 'month' }], locked: [{ route: 'reports.export', plans: ['pro'] }] },
		emails: [{ id: 'invite', plain: 'invites someone to the farm', route: 'reports.export', to: 'person' }],
		jobs: [{ id: 'daily', plain: 'sums up yesterday', route: 'reports.export', every: 'day' }],
		screenOnly: [],
	};
}

describe('summariseArchitecture', () => {
	test('groups into the plan part B sections', () => {
		const sections = summariseArchitecture(block());
		const keys = sections.map((s) => s.key);
		expect(keys).toEqual(['saves', 'access', 'sign-in', 'services', 'ai', 'test-mode']);
	});

	test('"what it saves" names each record and who owns it', () => {
		const saves = summariseArchitecture(block()).find((s) => s.key === 'saves')!;
		expect(saves.lines[0]).toBe('A note you wrote — private to each person.');
	});

	test('sign-in is stated in plain words', () => {
		const signIn = summariseArchitecture(block()).find((s) => s.key === 'sign-in')!;
		expect(signIn.lines[0]).toContain('code emailed');
	});

	test('test-mode features are each labelled test mode', () => {
		const test = summariseArchitecture(block()).find((s) => s.key === 'test-mode')!;
		expect(test.lines.join(' ')).toContain('test mode, no money moves');
		expect(test.lines.join(' ')).toContain('test inbox');
		expect(test.lines.some((l) => l.includes('run it with a button'))).toBe(true);
	});

	test('a section the block does not populate is omitted, never shown empty', () => {
		const bare = block();
		bare.services = [];
		bare.ai = [];
		bare.payments = null;
		bare.emails = [];
		bare.jobs = [];
		const keys = summariseArchitecture(bare).map((s) => s.key);
		expect(keys).toEqual(['saves', 'access', 'sign-in']);
		// Every section that IS shown has at least one line.
		for (const section of summariseArchitecture(bare)) expect(section.lines.length).toBeGreaterThan(0);
	});

	test('the AI line flags photo use', () => {
		const withPhotos = block();
		withPhotos.ai = [{ id: 'x', plain: 'reads an animal photo', route: 'reports.export', tier: 'super', images: true }];
		const ai = summariseArchitecture(withPhotos).find((s) => s.key === 'ai')!;
		expect(ai.lines[0]).toContain('look at photos');
	});

	test('accessPhrase reads in plain words, including a team role', () => {
		expect(accessPhrase('person')).toContain('their own records');
		expect(accessPhrase('admin')).toContain('admins');
		expect(accessPhrase('team-role:owner')).toBe("a team's owner");
	});

	test('the text form lists every section with its heading', () => {
		const text = summariseArchitectureText(block());
		expect(text).toContain('What it saves');
		expect(text).toContain('Who can do what');
		expect(text).toContain('Test-mode features');
	});
});
