// Test fixtures for part E's contract check (plan part E — "Test apps that must
// fail" + one correct app). Each fixture is a set of app source files (the
// builder-written src/server.ts and a screen) plus the architecture block they
// were built from. The contract-check test (tests/contract-checks.test.ts)
// materialises the real starter, writes the GENERATED caddie/ files from the
// block, drops in the fixture's server/screen, and runs the generated contract
// test in phases — proving each bad app fails the right check and the correct
// app passes every one.
//
// All fixtures share one small, person-owned block: a "notes" table a signed-in
// person owns, with create / read / list / update / delete routes and one
// screen that lists the notes. The bad apps each break exactly one thing part E
// checks; the good app breaks nothing.
import type { ArchitectureBlock } from '@caddie/contracts';

export const NOTES_BLOCK: ArchitectureBlock = {
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
	routes: [
		{ id: 'notes.create', module: 'app', feature: 'notes', op: 'create', method: 'POST', path: '/api/notes', table: 'notes', plain: 'Add a note', access: 'person', request: [{ name: 'body', type: 'text', example: 'Buy feed' }], response: ['id', 'body'] },
		{ id: 'notes.read', module: 'app', feature: 'notes', op: 'read', method: 'GET', path: '/api/notes/:id', table: 'notes', plain: 'Read a note', access: 'person', request: [], response: ['id', 'body'] },
		{ id: 'notes.list', module: 'app', feature: 'notes', op: 'list', method: 'GET', path: '/api/notes', table: 'notes', plain: 'Your notes', access: 'person', request: [], response: ['id', 'body'] },
		{ id: 'notes.update', module: 'app', feature: 'notes', op: 'update', method: 'PUT', path: '/api/notes/:id', table: 'notes', plain: 'Change a note', access: 'person', request: [{ name: 'body', type: 'text', example: 'Buy more feed' }], response: ['id', 'body'] },
		{ id: 'notes.delete', module: 'app', feature: 'notes', op: 'delete', method: 'DELETE', path: '/api/notes/:id', table: 'notes', plain: 'Delete a note', access: 'person', request: [], response: ['id'] },
	],
	screens: [{ id: 'notes', module: 'app', path: '#/notes', plain: 'Your notes', shows: ['notes'] }],
	services: [],
	ai: [],
	payments: null,
	emails: [],
	jobs: [],
	screenOnly: [],
};

/** The builder migration for the notes table (a person-owned table). */
export const NOTES_MIGRATION = [
	'create table notes (',
	'  id integer primary key autoincrement,',
	'  ownerId text not null,',
	'  body text not null,',
	"  createdAt text not null default (datetime('now'))",
	');',
	'create index notes_owner on notes (ownerId);',
	'',
].join('\n');

/** A fixture: the builder-written server + the screen, and what should happen. */
export interface ContractFixture {
	readonly id: string;
	readonly plain: string;
	/** The phases this fixture must FAIL (empty for the correct app). */
	readonly mustFail: ReadonlyArray<'create' | 'read' | 'privacy-screen' | 'test-mode'>;
	/** builder files, keyed by path relative to the app root. */
	readonly files: Readonly<Record<string, string>>;
}

// --- the CORRECT app: owner-scoped CRUD, a screen that uses caddie/api --------

const CORRECT_SERVER = [
	'import { Hono } from "hono";',
	'import type { D1Database } from "../caddie/d1";',
	'import type { CaddiePlatform } from "../caddie/platform";',
	'import { mountSignIn } from "../caddie/auth";',
	'import { implement, requireUser } from "../caddie/contract";',
	'',
	'export type Env = { DB: D1Database; CADDIE: CaddiePlatform; CADDIE_AUTH_SECRET?: string };',
	'export const app = new Hono<{ Bindings: Env }>().basePath("/api");',
	'app.get("/health", (c) => c.json({ ok: true }));',
	'mountSignIn(app);',
	'',
	'implement(app, {',
	'  "notes.create": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { body } = await c.req.json<{ body: string }>();',
	'    const row = await c.env.DB.prepare("insert into notes (ownerId, body) values (?, ?) returning id, body").bind(user.id, body).first<{ id: number; body: string }>();',
	'    return c.json(row, 201);',
	'  },',
	'  "notes.read": async (c) => {',
	'    const user = await requireUser(c);',
	'    const row = await c.env.DB.prepare("select id, body from notes where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).first<{ id: number; body: string }>();',
	'    if (!row) return c.json({ error: "Not found." }, 404);',
	'    return c.json(row);',
	'  },',
	'  "notes.list": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { results } = await c.env.DB.prepare("select id, body from notes where ownerId = ? order by id").bind(user.id).all<{ id: number; body: string }>();',
	'    return c.json(results);',
	'  },',
	'  "notes.update": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { body } = await c.req.json<{ body: string }>();',
	'    await c.env.DB.prepare("update notes set body = ? where id = ? and ownerId = ?").bind(body, Number(c.req.param("id")), user.id).run();',
	'    const row = await c.env.DB.prepare("select id, body from notes where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).first<{ id: number; body: string }>();',
	'    return c.json(row);',
	'  },',
	'  "notes.delete": async (c) => {',
	'    const user = await requireUser(c);',
	'    await c.env.DB.prepare("delete from notes where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).run();',
	'    return c.json({ id: Number(c.req.param("id")) });',
	'  },',
	'});',
	'export default app;',
	'',
].join('\n');

const CORRECT_SCREEN = [
	'import { useEffect, useState } from "react";',
	'import { api } from "../caddie/api";',
	'',
	'export function NotesScreen() {',
	'  const [bodies, setBodies] = useState<string[] | null>(null);',
	'  useEffect(() => {',
	'    api.get<{ id: number; body: string }[]>("/api/notes").then((rows) => setBodies(rows.map((r) => r.body))).catch(() => setBodies([]));',
	'  }, []);',
	'  if (bodies === null) return <p>Loading…</p>;',
	'  return <ul>{bodies.map((b) => <li key={b}>{b}</li>)}</ul>;',
	'}',
	'',
].join('\n');

// --- the BAD apps -------------------------------------------------------------
// Each starts from the correct server and breaks exactly one thing.

/** Keeps data in a module-level array, never touching the database. Fails read. */
const IN_MEMORY_SERVER = CORRECT_SERVER
	.replace(
		'app.get("/health", (c) => c.json({ ok: true }));',
		'app.get("/health", (c) => c.json({ ok: true }));\nconst MEM: { id: number; ownerId: string; body: string }[] = [];\nlet NEXT = 1;',
	)
	.replace(
		'const row = await c.env.DB.prepare("insert into notes (ownerId, body) values (?, ?) returning id, body").bind(user.id, body).first<{ id: number; body: string }>();\n    return c.json(row, 201);',
		'const row = { id: NEXT++, ownerId: user.id, body };\n    MEM.push(row);\n    return c.json({ id: row.id, body: row.body }, 201);',
	)
	.replace(
		'const row = await c.env.DB.prepare("select id, body from notes where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).first<{ id: number; body: string }>();\n    if (!row) return c.json({ error: "Not found." }, 404);\n    return c.json(row);',
		'const row = MEM.find((r) => r.id === Number(c.req.param("id")) && r.ownerId === user.id);\n    if (!row) return c.json({ error: "Not found." }, 404);\n    return c.json({ id: row.id, body: row.body });',
	)
	.replace(
		'const { results } = await c.env.DB.prepare("select id, body from notes where ownerId = ? order by id").bind(user.id).all<{ id: number; body: string }>();\n    return c.json(results);',
		'return c.json(MEM.filter((r) => r.ownerId === user.id).map((r) => ({ id: r.id, body: r.body })));',
	);

/** Inserts a dummy row to make the table non-empty but serves from memory. Fails read. */
const DUMMY_ROW_SERVER = IN_MEMORY_SERVER.replace(
	'const row = { id: NEXT++, ownerId: user.id, body };\n    MEM.push(row);\n    return c.json({ id: row.id, body: row.body }, 201);',
	'await c.env.DB.prepare("insert into notes (ownerId, body) values (?, ?)").bind(user.id, "ignored").run();\n    const row = { id: NEXT++, ownerId: user.id, body };\n    MEM.push(row);\n    return c.json({ id: row.id, body: row.body }, 201);',
);

/** Update writes nothing. Fails read (the update-then-restart path, via privacy phase is unaffected; create/read still). */
const UPDATE_NOT_SAVED_SERVER = CORRECT_SERVER.replace(
	'await c.env.DB.prepare("update notes set body = ? where id = ? and ownerId = ?").bind(body, Number(c.req.param("id")), user.id).run();',
	'// bug: the update is dropped, nothing is saved',
);

/** No owner filter on list/read. Fails the second-person privacy check. */
const NO_OWNER_FILTER_SERVER = CORRECT_SERVER
	.replace(
		'const { results } = await c.env.DB.prepare("select id, body from notes where ownerId = ? order by id").bind(user.id).all<{ id: number; body: string }>();',
		'const { results } = await c.env.DB.prepare("select id, body from notes order by id").all<{ id: number; body: string }>();',
	)
	.replace(
		'const row = await c.env.DB.prepare("select id, body from notes where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).first<{ id: number; body: string }>();\n    if (!row) return c.json({ error: "Not found." }, 404);\n    return c.json(row);',
		'const row = await c.env.DB.prepare("select id, body from notes where id = ?").bind(Number(c.req.param("id"))).first<{ id: number; body: string }>();\n    if (!row) return c.json({ error: "Not found." }, 404);\n    return c.json(row);',
	);

/** A screen that reads localStorage instead of the server. Fails the static check. */
const LOCALSTORAGE_SCREEN = [
	'import { useEffect, useState } from "react";',
	'',
	'export function NotesScreen() {',
	'  const [bodies, setBodies] = useState<string[]>([]);',
	'  useEffect(() => {',
	'    const raw = localStorage.getItem("notes");',
	'    setBodies(raw ? (JSON.parse(raw) as string[]) : []);',
	'  }, []);',
	'  return <ul>{bodies.map((b) => <li key={b}>{b}</li>)}</ul>;',
	'}',
	'',
].join('\n');

export const CONTRACT_FIXTURES: readonly ContractFixture[] = [
	{
		id: 'correct',
		plain: 'A correct app: owner-scoped CRUD, a screen that uses caddie/api.',
		mustFail: [],
		files: { 'src/server.ts': CORRECT_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'kept-in-memory',
		plain: 'Keeps notes in memory, so they vanish after a restart.',
		mustFail: ['read'],
		files: { 'src/server.ts': IN_MEMORY_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'dummy-row-serves-memory',
		plain: 'Inserts a dummy row but serves from memory; the read after restart fails.',
		mustFail: ['read'],
		files: { 'src/server.ts': DUMMY_ROW_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'no-owner-filter',
		plain: 'No owner filter, so a second person can see the first person\'s notes.',
		mustFail: ['privacy-screen'],
		files: { 'src/server.ts': NO_OWNER_FILTER_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'screen-reads-localstorage',
		plain: 'A screen reads localStorage instead of the server; the static check catches it.',
		// The static check runs before the phases; see the test.
		mustFail: [],
		files: { 'src/server.ts': CORRECT_SERVER, 'src/NotesScreen.tsx': LOCALSTORAGE_SCREEN, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
];

export { UPDATE_NOT_SAVED_SERVER, CORRECT_SERVER, CORRECT_SCREEN, LOCALSTORAGE_SCREEN };
