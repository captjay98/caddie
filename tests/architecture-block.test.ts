import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	ARCHITECTURE_BLOCK_INFO,
	parseArchitectureBlock,
	splitArchitectureBlock,
	type ArchitectureBlock,
} from '../packages/contracts/src/architecture.ts';
import { checkArchitecture, type ArchitectureKind } from '../apps/app/src/server/architecture-gate.ts';
import { generateSchema, needsGeneratedSchema } from '../apps/app/src/server/schema-gen.ts';

/**
 * The `caddie-architecture` block (plan part B, v2): the shape, the
 * deterministic gate, and the generated schema. LOCAL VERIFIED.
 */

const FIX = fileURLToPath(new URL('./fixtures/architecture/', import.meta.url));
// `bun test --update-snapshots` regenerates the schema fixtures.
const UPDATE = process.argv.includes('--update-snapshots');

function snapshot(name: string, sql: string): void {
	const path = `${FIX}${name}`;
	if (UPDATE || !existsSync(path)) {
		writeFileSync(path, sql);
		return;
	}
	expect(sql).toBe(readFileSync(path, 'utf8'));
}

/** Wrap a block in a design document so the parser has prose around it. */
const design = (block: unknown, fence = '```') =>
	`# How your app works\n\nProse a person reads.\n\n${fence}${ARCHITECTURE_BLOCK_INFO}\n${JSON.stringify(block, null, 2)}\n${fence}\n\nClosing note.`;

// --- building blocks for fixtures -------------------------------------------

/** A minimal valid SMALL app: one module "app", one person-owned table, full CRUD. */
function smallBlock(): ArchitectureBlock {
	const crud = (op: ArchitectureBlock['routes'][number]['op'], method: string) => ({
		id: `notes.${op}`,
		module: 'app',
		feature: 'notes',
		op,
		method: method as ArchitectureBlock['routes'][number]['method'],
		path: op === 'list' ? '/api/notes' : '/api/notes/:id',
		table: 'notes',
		plain: `${op} a note`,
		access: 'person' as const,
		request: op === 'create' || op === 'update' ? [{ name: 'body', type: 'text' as const, example: 'Buy feed' }] : [],
		response: ['id', 'body'],
	});
	return {
		version: 2,
		signIn: 'required',
		team: null,
		modules: [{ id: 'app', plain: 'The whole app', dependsOn: [] }],
		tables: [
			{
				name: 'notes',
				module: 'app',
				plain: 'A note you wrote',
				owner: 'person',
				fields: [{ name: 'body', type: 'text', references: null }],
			},
		],
		routes: [crud('create', 'POST'), crud('read', 'GET'), crud('list', 'GET'), crud('update', 'PUT'), crud('delete', 'DELETE')],
		screens: [{ id: 'notes', module: 'app', path: '#/notes', plain: 'Your notes', shows: ['notes'] }],
		services: [],
		ai: [],
		payments: null,
		emails: [],
		jobs: [],
		screenOnly: ['calculator'],
	};
}

/** A valid TEAM app: a team table in core, team-owned records, team access. */
function teamBlock(): ArchitectureBlock {
	const crud = (op: ArchitectureBlock['routes'][number]['op'], method: string, access: ArchitectureBlock['routes'][number]['access']) => ({
		id: `animals.${op}`,
		module: 'core',
		feature: 'animal-registry',
		op,
		method: method as ArchitectureBlock['routes'][number]['method'],
		path: op === 'list' ? '/api/teams/:teamId/animals' : '/api/teams/:teamId/animals/:id',
		table: 'animals',
		plain: `${op} an animal`,
		access,
		request: op === 'create' || op === 'update' ? [{ name: 'name', type: 'text' as const, example: 'Daisy' }] : [],
		response: ['id', 'name'],
	});
	return {
		version: 2,
		signIn: 'required',
		team: { table: 'farms', plain: 'A farm and the people on it', roles: ['owner', 'worker'], creatorRole: 'owner' },
		modules: [{ id: 'core', plain: 'Farms, people and roles', dependsOn: [] }],
		tables: [
			{ name: 'farms', module: 'core', plain: 'A farm', owner: 'team', fields: [{ name: 'name', type: 'text', references: null }] },
			{
				name: 'animals',
				module: 'core',
				plain: 'Each animal',
				owner: 'team',
				fields: [
					{ name: 'name', type: 'text', references: null },
					{ name: 'weight', type: 'real', references: null },
				],
			},
		],
		routes: [
			// the team table's own CRUD: create is team creation (signed-in, no :teamId)
			{ id: 'farms.create', module: 'core', feature: 'farm-registry', op: 'create', method: 'POST', path: '/api/farms', table: 'farms', plain: 'Start a farm', access: 'signed-in', request: [{ name: 'name', type: 'text', example: 'Green Acres' }], response: ['id'] },
			{ id: 'farms.read', module: 'core', feature: 'farm-registry', op: 'read', method: 'GET', path: '/api/teams/:teamId/farm', table: 'farms', plain: 'See the farm', access: 'team', request: [], response: ['id'] },
			{ id: 'farms.list', module: 'core', feature: 'farm-registry', op: 'list', method: 'GET', path: '/api/farms', table: 'farms', plain: 'Your farms', access: 'team', request: [], response: ['id'] },
			{ id: 'farms.update', module: 'core', feature: 'farm-registry', op: 'update', method: 'PUT', path: '/api/teams/:teamId/farm', table: 'farms', plain: 'Change the farm', access: 'team-role:owner', request: [{ name: 'name', type: 'text', example: 'Green Acres' }], response: ['id'] },
			{ id: 'farms.delete', module: 'core', feature: 'farm-registry', op: 'delete', method: 'DELETE', path: '/api/teams/:teamId/farm', table: 'farms', plain: 'Close the farm', access: 'team-role:owner', request: [], response: ['ok'] },
			crud('create', 'POST', 'team'),
			crud('read', 'GET', 'team'),
			crud('list', 'GET', 'team'),
			crud('update', 'PUT', 'team-role:owner'),
			crud('delete', 'DELETE', 'team-role:owner'),
		],
		screens: [{ id: 'animals', module: 'core', path: '#/animals', plain: 'Your animals', shows: ['animals'] }],
		services: [],
		ai: [],
		payments: null,
		emails: [],
		jobs: [],
		screenOnly: [],
	};
}

/** A small app that also declares payments, emails and jobs (tier-3 features). */
function featuresBlock(): ArchitectureBlock {
	const base = smallBlock();
	base.routes.push({
		id: 'reports.export',
		module: 'app',
		feature: 'reports',
		op: 'action',
		method: 'POST',
		path: '/api/reports/export',
		table: null,
		plain: 'Export a report',
		access: 'signed-in',
		request: [],
		response: ['url'],
	});
	base.routes.push({
		id: 'members.invite',
		module: 'app',
		feature: 'invites',
		op: 'action',
		method: 'POST',
		path: '/api/members/invite',
		table: null,
		plain: 'Invite someone',
		access: 'signed-in',
		request: [{ name: 'email', type: 'text', example: 'friend@example.com' }],
		response: ['ok'],
	});
	base.routes.push({
		id: 'jobs.daily-summary',
		module: 'app',
		feature: 'summaries',
		op: 'action',
		method: 'POST',
		path: '/api/jobs/daily-summary',
		table: null,
		plain: 'Sum up yesterday',
		access: 'job',
		request: [],
		response: ['summary'],
	});
	base.payments = {
		currency: 'USD',
		plans: [{ id: 'pro', plain: 'Pro', priceMinor: 900, interval: 'month' }],
		locked: [{ route: 'reports.export', plans: ['pro'] }],
	};
	base.emails = [{ id: 'invite', plain: 'Invites someone', route: 'members.invite', to: 'request-field:email' }];
	base.jobs = [{ id: 'daily-summary', plain: 'Sums up yesterday', route: 'jobs.daily-summary', every: 'day' }];
	base.ai = [{ id: 'summary-ai', plain: 'Explains the day', route: 'reports.export', tier: 'fast', images: false }];
	base.services = [{ id: 'weather', plain: 'Weather for the farm', keyName: 'WEATHER_API_KEY', keyPage: 'https://example.com/keys' }];
	return base;
}

// --- parse -------------------------------------------------------------------

describe('parseArchitectureBlock', () => {
	test('finds the block and parses a valid small app', () => {
		const parsed = parseArchitectureBlock(design(smallBlock()));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.block.version).toBe(2);
		expect(parseArchitectureBlock(design(smallBlock(), '~~~')).ok).toBe(true);
	});

	test('splits prose from the block', () => {
		const { display, raw } = splitArchitectureBlock(design(smallBlock()));
		expect(raw).not.toBeNull();
		expect(display).toBe('# How your app works\n\nProse a person reads.\n\nClosing note.');
		expect(splitArchitectureBlock('# Just prose').raw).toBeNull();
	});

	test('refuses a missing block, bad JSON and two blocks', () => {
		const missing = parseArchitectureBlock('# Just prose');
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain(`no \`${ARCHITECTURE_BLOCK_INFO}\``);

		const badJson = parseArchitectureBlock('```caddie-architecture\n{ not json\n```');
		expect(badJson.ok).toBe(false);
		if (!badJson.ok) expect(badJson.error).toContain('not valid JSON');

		const two = '```caddie-architecture\n{\n```\n\n```caddie-architecture\n{}\n```';
		expect(parseArchitectureBlock(two).ok).toBe(false);
	});

	test('refuses a shape error with a located message', () => {
		const bad = smallBlock() as unknown as Record<string, unknown>;
		bad.version = 1;
		const parsed = parseArchitectureBlock(design(bad));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain('version');
	});
});

// --- the gate: valid blocks pass --------------------------------------------

describe('checkArchitecture — valid blocks pass', () => {
	const cases: Array<[string, ArchitectureBlock, ArchitectureKind]> = [
		['small', smallBlock(), 'small'],
		['features (payments/emails/jobs)', featuresBlock(), 'small'],
		['team (core-module app)', teamBlock(), 'big'],
	];
	for (const [name, block, kind] of cases) {
		test(`${name} passes`, () => {
			const issues = checkArchitecture(block, { kind });
			expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
		});
	}

	test('big farm fixture (9 modules, ~37 tables) passes', () => {
		const farm = JSON.parse(readFileSync(`${FIX}farm-block.json`, 'utf8')) as ArchitectureBlock;
		const parsed = parseArchitectureBlock(design(farm));
		expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
		const issues = checkArchitecture(farm, { kind: 'big' });
		expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
	});
});

// --- the gate: one refusal per rule, with its message -----------------------

function refuses(
	mutate: (b: ArchitectureBlock) => void,
	kind: ArchitectureKind,
	rule: string,
	messagePart: string,
	from: () => ArchitectureBlock = smallBlock,
) {
	const block = from();
	mutate(block);
	const issues = checkArchitecture(block, { kind });
	const hit = issues.find((i) => i.rule === rule);
	expect(hit, `expected rule ${rule}, got ${JSON.stringify(issues)}`).toBeDefined();
	if (hit) expect(hit.message).toContain(messagePart);
}

describe('checkArchitecture — every rule refuses with its message', () => {
	test('cap: small too many tables', () =>
		refuses((b) => {
			for (let i = 0; i < 25; i++) b.tables.push({ name: `t${i}`, module: 'app', plain: 'x', owner: 'shared', fields: [] });
		}, 'small', 'cap.tables', 'at most 25 kinds of record'));

	test('cap: small single module', () =>
		refuses((b) => b.modules.push({ id: 'extra', plain: 'x', dependsOn: [] }), 'small', 'small.single-module', 'exactly one module'));

	test('cap: big too many modules', () =>
		refuses((b) => {
			for (let i = 0; i < 13; i++) b.modules.push({ id: `m${i}`, plain: 'x', dependsOn: [] });
		}, 'big', 'cap.modules', 'at most 12 parts', teamBlock));

	test('cap: big features per module', () =>
		refuses((b) => {
			for (let i = 0; i < 13; i++)
				b.routes.push({ id: `r${i}`, module: 'core', feature: `f${i}`, op: 'action', method: 'POST', path: `/api/x${i}`, table: null, plain: 'x', access: 'signed-in', request: [], response: [] });
		}, 'big', 'cap.features-per-module', 'at most 12 features', teamBlock));

	test('cap: too many services', () =>
		refuses((b) => {
			for (let i = 0; i < 11; i++) b.services.push({ id: `s${i}`, plain: 'x', keyName: 'A_KEY', keyPage: 'https://e.com' });
		}, 'small', 'cap.services', 'at most 10 outside services'));

	test('cap: too many jobs', () =>
		refuses((b) => {
			for (let i = 0; i < 6; i++) b.jobs.push({ id: `j${i}`, plain: 'x', route: 'notes.create', every: 'day' });
		}, 'small', 'cap.jobs', 'at most 5 scheduled jobs'));

	test('unique ids: duplicate table name', () =>
		refuses((b) => b.tables.push({ ...b.tables[0]! }), 'small', 'unique.tables', 'each needs its own name'));

	test('path: not /api/', () =>
		refuses((b) => (b.routes[0]!.path = '/notes'), 'small', 'path.api-prefix', 'starts with /api/'));

	test('path: reserved /api/caddie/', () =>
		refuses((b) => (b.routes[0]!.path = '/api/caddie/notes'), 'small', 'path.reserved', 'keeps for itself'));

	// P2 (review 2026-10-23): a declared field named like a column Caddie always
	// adds (id/createdAt/updatedAt or the owner column) would make the generated
	// CREATE TABLE emit a duplicate column and fail at build time — refuse it.
	test('field: a reserved column name (createdAt) is refused', () =>
		refuses((b) => b.tables[0]!.fields.push({ name: 'createdAt', type: 'text', references: null }), 'small', 'field.reserved', 'adds automatically'));

	test('field: the owner column name (ownerId) is refused on a person-owned table', () =>
		refuses((b) => b.tables[0]!.fields.push({ name: 'ownerId', type: 'text', references: null }), 'small', 'field.reserved', 'ownerId'));

	test('field: a field name repeated within a table is refused', () =>
		refuses((b) => b.tables[0]!.fields.push({ name: 'body', type: 'text', references: null }), 'small', 'field.duplicate', 'more than once'));

	test('module: table in an unknown module', () =>
		refuses((b) => (b.tables[0]!.module = 'ghost'), 'small', 'module.unknown', 'does not have'));

	test('module: dependsOn cycle', () =>
		refuses((b) => {
			b.modules = [
				{ id: 'core', plain: 'x', dependsOn: ['feed'] },
				{ id: 'feed', plain: 'x', dependsOn: ['core'] },
			];
		}, 'big', 'module.cycle', 'neither can be built first', teamBlock));

	test('module: a module writes core\'s table', () =>
		refuses((b) => {
			b.modules.push({ id: 'feed', plain: 'x', dependsOn: ['core'] });
			b.routes[0]!.module = 'feed';
		}, 'big', 'module.core-write', 'only the core part may change it', teamBlock));

	test('table: private record missing a delete route', () =>
		refuses((b) => (b.routes = b.routes.filter((r) => r.op !== 'delete')), 'small', 'table.missing-route', 'needs a way to delete it'));

	test('table: private record left open', () =>
		refuses((b) => (b.routes[0]!.access = 'public'), 'small', 'table.private-open', "can't be open to everyone"));

	test('team: creator role not in roles', () =>
		refuses((b) => (b.team!.creatorRole = 'boss'), 'small', 'team.creator-role', 'must be one of the team', teamBlock));

	test('team: team-owned table without a team', () =>
		refuses((b) => {
			b.team = null;
		}, 'small', 'team.undeclared', 'has no team', teamBlock));

	test('team: team route missing :teamId', () =>
		refuses((b) => {
			const r = b.routes.find((x) => x.table === 'animals' && x.op === 'read')!;
			r.path = '/api/animals';
		}, 'small', 'team.route-path', 'must include :teamId', teamBlock));

	test('team: team route with the wrong access', () =>
		refuses((b) => {
			const r = b.routes.find((x) => x.table === 'animals' && x.op === 'read')!;
			r.access = 'person';
		}, 'small', 'team.route-access', 'only a team member', teamBlock));

	test('team: unknown role', () =>
		refuses((b) => {
			const r = b.routes.find((x) => x.table === 'animals' && x.op === 'update')!;
			r.access = 'team-role:boss';
		}, 'small', 'team.unknown-role', "don't have", teamBlock));

	test('access: admin without sign-in', () =>
		refuses((b) => {
			b.signIn = 'none';
			b.routes[0]!.access = 'admin';
		}, 'small', 'access.needs-sign-in', 'must have sign-in'));

	test('access: job route not declared', () =>
		refuses((b) => (b.routes[0]!.access = 'job'), 'small', 'access.job-not-declared', 'not listed under jobs'));

	test('request: field without an example', () =>
		refuses((b) => {
			const create = b.routes.find((r) => r.op === 'create')!;
			create.request[0]!.example = '';
		}, 'small', 'request.needs-example', 'needs an example value'));

	test('service: bad key name', () =>
		refuses((b) => b.services.push({ id: 'weather', plain: 'x', keyName: 'weatherKey', keyPage: 'https://e.com' }), 'small', 'service.key-name', 'capitals, digits and underscores'));

	test('service: non-https key page', () =>
		refuses((b) => b.services.push({ id: 'weather', plain: 'x', keyName: 'A_KEY', keyPage: 'http://e.com' }), 'small', 'service.key-page', 'https web address'));

	test('ai: unknown route', () =>
		refuses((b) => b.ai.push({ id: 'x', plain: 'x', route: 'ghost', tier: 'fast', images: false }), 'small', 'ai.unknown-route', 'does not have'));

	test('ai: images without super', () =>
		refuses((b) => b.ai.push({ id: 'x', plain: 'x', route: 'notes.create', tier: 'fast', images: true }), 'small', 'ai.images-super', 'needs the deeper'));

	test('payments: bad currency', () =>
		refuses((b) => (b.payments!.currency = 'dollars'), 'small', 'payments.currency', '3-letter code', featuresBlock));

	test('payments: price out of range', () =>
		refuses((b) => (b.payments!.plans[0]!.priceMinor = 0), 'small', 'payments.price', 'whole amount from 1 to 100000', featuresBlock));

	test('payments: locked route open to everyone', () =>
		refuses((b) => {
			b.routes.find((r) => r.id === 'reports.export')!.access = 'public';
		}, 'small', 'payments.locked-open', 'needs sign-in', featuresBlock));

	test('payments: locked route does not exist', () =>
		refuses((b) => (b.payments!.locked[0]!.route = 'ghost'), 'small', 'payments.locked-route', 'does not have', featuresBlock));

	test('email: unknown route', () =>
		refuses((b) => (b.emails[0]!.route = 'ghost'), 'small', 'email.unknown-route', 'does not have', featuresBlock));

	test('email: open route', () =>
		refuses((b) => {
			b.routes.find((r) => r.id === 'members.invite')!.access = 'public';
		}, 'small', 'email.open-route', 'needs sign-in', featuresBlock));

	test('email: to-field example is not an email', () =>
		refuses((b) => {
			b.routes.find((r) => r.id === 'members.invite')!.request[0]!.example = 'not-an-email';
		}, 'small', 'email.to-example', 'must be an email address', featuresBlock));
});

// --- the generated schema ----------------------------------------------------

describe('needsGeneratedSchema', () => {
	test('big app: always', () => expect(needsGeneratedSchema(smallBlock(), 'big')).toBe(true));
	test('team app: yes', () => expect(needsGeneratedSchema(teamBlock(), 'small')).toBe(true));
	test('admin route: yes', () => {
		const b = smallBlock();
		b.routes[0]!.access = 'admin';
		expect(needsGeneratedSchema(b, 'small')).toBe(true);
	});
	test('plain small app: no', () => expect(needsGeneratedSchema(smallBlock(), 'small')).toBe(false));
});

describe('generateSchema', () => {
	test('is deterministic (same block, same SQL)', () => {
		expect(generateSchema(teamBlock())).toBe(generateSchema(teamBlock()));
	});

	test('boolean/datetime/json/file column types', () => {
		const b = teamBlock();
		b.tables[1]!.fields = [
			{ name: 'alive', type: 'boolean', references: null },
			{ name: 'bornAt', type: 'datetime', references: null },
			{ name: 'extra', type: 'json', references: null },
			{ name: 'photo', type: 'file', references: null },
		];
		const sql = generateSchema(b);
		expect(sql).toContain('alive integer');
		expect(sql).toContain('bornAt text');
		expect(sql).toContain('extra text');
		expect(sql).toContain('photo text');
	});

	test('ownerId on person tables, teamId on team tables, platform tables', () => {
		const sql = generateSchema(teamBlock());
		expect(sql).toContain('teamId text not null');
		expect(sql).toContain('create table team_members');
		expect(sql).toContain('create table caddie_admins');
		const person = generateSchema(smallBlock());
		expect(person).toContain('ownerId text not null');
	});

	test('snapshot: small team app', () => snapshot('small-team.sql', generateSchema(teamBlock())));

	test('snapshot: big farm app', () => {
		const farm = JSON.parse(readFileSync(`${FIX}farm-block.json`, 'utf8')) as ArchitectureBlock;
		snapshot('farm-schema.sql', generateSchema(farm));
	});

	test('generated SQL applies cleanly in bun:sqlite (team app)', () => {
		const db = new Database(':memory:');
		db.run('PRAGMA foreign_keys = ON;');
		for (const stmt of generateSchema(teamBlock()).split(';').map((s) => s.trim()).filter(Boolean)) db.run(stmt + ';');
		const names = db.query("select name from sqlite_master where type='table' order by name").all() as { name: string }[];
		const set = new Set(names.map((n) => n.name));
		expect(set.has('animals')).toBe(true);
		expect(set.has('team_members')).toBe(true);
		expect(set.has('caddie_admins')).toBe(true);
		db.close();
	});

	test('generated SQL applies cleanly in bun:sqlite (big farm)', () => {
		const farm = JSON.parse(readFileSync(`${FIX}farm-block.json`, 'utf8')) as ArchitectureBlock;
		const db = new Database(':memory:');
		db.run('PRAGMA foreign_keys = ON;');
		for (const stmt of generateSchema(farm).split(';').map((s) => s.trim()).filter(Boolean)) db.run(stmt + ';');
		const count = db.query("select count(*) as n from sqlite_master where type='table'").get() as { n: number };
		expect(count.n).toBeGreaterThanOrEqual(37);
		db.close();
	});
});
