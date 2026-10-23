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
import { generateSchema } from '../../../apps/app/src/server/schema-gen.ts';

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
		// A second person-owned table, whose records point at a note. Its create
		// example "999" is a placeholder: the check must send the id of the note
		// it saved, as a real person would.
		{
			name: 'tasks',
			module: 'app',
			plain: 'A task you set',
			owner: 'person',
			fields: [
				{ name: 'title', type: 'text', references: null },
				{ name: 'noteId', type: 'integer', references: 'notes' },
			],
		},
	],
	routes: [
		{ id: 'notes.create', module: 'app', feature: 'notes', op: 'create', method: 'POST', path: '/api/notes', table: 'notes', plain: 'Add a note', access: 'person', request: [{ name: 'body', type: 'text', example: 'Buy feed' }], response: ['id', 'body'] },
		{ id: 'notes.read', module: 'app', feature: 'notes', op: 'read', method: 'GET', path: '/api/notes/:id', table: 'notes', plain: 'Read a note', access: 'person', request: [], response: ['id', 'body'] },
		{ id: 'notes.list', module: 'app', feature: 'notes', op: 'list', method: 'GET', path: '/api/notes', table: 'notes', plain: 'Your notes', access: 'person', request: [], response: ['id', 'body'] },
		{ id: 'notes.update', module: 'app', feature: 'notes', op: 'update', method: 'PUT', path: '/api/notes/:id', table: 'notes', plain: 'Change a note', access: 'person', request: [{ name: 'body', type: 'text', example: 'Buy more feed' }], response: ['id', 'body'] },
		{ id: 'notes.delete', module: 'app', feature: 'notes', op: 'delete', method: 'DELETE', path: '/api/notes/:id', table: 'notes', plain: 'Delete a note', access: 'person', request: [], response: ['id'] },
		{ id: 'tasks.create', module: 'app', feature: 'tasks', op: 'create', method: 'POST', path: '/api/tasks', table: 'tasks', plain: 'Add a task', access: 'person', request: [{ name: 'title', type: 'text', example: 'Call the vet' }, { name: 'noteId', type: 'integer', example: '999' }], response: ['id', 'title', 'noteId'] },
		{ id: 'tasks.read', module: 'app', feature: 'tasks', op: 'read', method: 'GET', path: '/api/tasks/:id', table: 'tasks', plain: 'Read a task', access: 'person', request: [], response: ['id', 'title'] },
		{ id: 'tasks.list', module: 'app', feature: 'tasks', op: 'list', method: 'GET', path: '/api/tasks', table: 'tasks', plain: 'Your tasks', access: 'person', request: [], response: ['id', 'title'] },
		{ id: 'tasks.update', module: 'app', feature: 'tasks', op: 'update', method: 'PUT', path: '/api/tasks/:id', table: 'tasks', plain: 'Change a task', access: 'person', request: [{ name: 'title', type: 'text', example: 'Call the vet again' }], response: ['id', 'title'] },
		{ id: 'tasks.delete', module: 'app', feature: 'tasks', op: 'delete', method: 'DELETE', path: '/api/tasks/:id', table: 'tasks', plain: 'Delete a task', access: 'person', request: [], response: ['id'] },
	],
	screens: [
		{ id: 'notes', module: 'app', path: '#/notes', plain: 'Your notes', shows: ['notes'] },
		{ id: 'tasks', module: 'app', path: '#/tasks', plain: 'Your tasks', shows: ['tasks'] },
	],
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
	'create table tasks (',
	'  id integer primary key autoincrement,',
	'  ownerId text not null,',
	'  title text not null,',
	'  noteId integer references notes (id),',
	"  createdAt text not null default (datetime('now'))",
	');',
	'create index tasks_owner on tasks (ownerId);',
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
	/**
	 * The features built so far (passed plus the current one). The host scopes
	 * the generated contract test to them; omitted means the whole design, as
	 * at the final check.
	 */
	readonly features?: readonly string[];
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
	'  "tasks.create": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { title, noteId } = await c.req.json<{ title: string; noteId: number | string }>();',
	'    const note = await c.env.DB.prepare("select id from notes where id = ? and ownerId = ?").bind(Number(noteId), user.id).first();',
	'    if (!note) return c.json({ error: "A task must point at one of your notes." }, 400);',
	'    const row = await c.env.DB.prepare("insert into tasks (ownerId, title, noteId) values (?, ?, ?) returning id, title, noteId").bind(user.id, title, Number(noteId)).first();',
	'    return c.json(row, 201);',
	'  },',
	'  "tasks.read": async (c) => {',
	'    const user = await requireUser(c);',
	'    const row = await c.env.DB.prepare("select id, title, noteId from tasks where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).first();',
	'    if (!row) return c.json({ error: "Not found." }, 404);',
	'    return c.json(row);',
	'  },',
	'  "tasks.list": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { results } = await c.env.DB.prepare("select id, title, noteId from tasks where ownerId = ? order by id").bind(user.id).all();',
	'    return c.json(results);',
	'  },',
	'  "tasks.update": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { title } = await c.req.json<{ title: string }>();',
	'    await c.env.DB.prepare("update tasks set title = ? where id = ? and ownerId = ?").bind(title, Number(c.req.param("id")), user.id).run();',
	'    const row = await c.env.DB.prepare("select id, title, noteId from tasks where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).first();',
	'    return c.json(row);',
	'  },',
	'  "tasks.delete": async (c) => {',
	'    const user = await requireUser(c);',
	'    await c.env.DB.prepare("delete from tasks where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).run();',
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
	)
	// Its tasks look the note up where this app keeps notes: in memory.
	.replace(
		'const note = await c.env.DB.prepare("select id from notes where id = ? and ownerId = ?").bind(Number(noteId), user.id).first();',
		'const note = MEM.find((r) => r.id === Number(noteId) && r.ownerId === user.id) ?? null;',
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

/**
 * The app shell: mounts NotesScreen at #/notes (the declared screen path). The
 * generated step-8 check imports `../src/App`, sets the hash, and renders it, so
 * the App must surface the screen that shows the notes table.
 */
const NOTES_APP = [
	'import { NotesScreen } from "./NotesScreen";',
	'import { TasksScreen } from "./TasksScreen";',
	'',
	'export function App() {',
	'  const hash = typeof location !== "undefined" ? location.hash : "#/notes";',
	'  if (hash === "#/notes") return <NotesScreen />;',
	'  if (hash === "#/tasks") return <TasksScreen />;',
	'  return <main><h1>Your app</h1></main>;',
	'}',
	'',
].join('\n');

/** The tasks screen: lists the person's tasks, read from the server through caddie/api. */
const TASKS_SCREEN = [
	'import { useEffect, useState } from "react";',
	'import { api } from "../caddie/api";',
	'',
	'export function TasksScreen() {',
	'  const [titles, setTitles] = useState<string[] | null>(null);',
	'  useEffect(() => {',
	'    api.get<{ id: number; title: string }[]>("/api/tasks").then((rows) => setTitles(rows.map((r) => r.title))).catch(() => setTitles([]));',
	'  }, []);',
	'  if (titles === null) return <p>Loading…</p>;',
	'  return <ul>{titles.map((t) => <li key={t}>{t}</li>)}</ul>;',
	'}',
	'',
].join('\n');

/** BAD: the tasks screen shows the NOTES (a real server read, but of the wrong table). */
const TASKS_SHOWS_NOTES_SCREEN = TASKS_SCREEN.replace(
	'api.get<{ id: number; title: string }[]>("/api/tasks").then((rows) => setTitles(rows.map((r) => r.title)))',
	'api.get<{ id: number; body: string }[]>("/api/notes").then((rows) => setTitles(rows.map((r) => r.body)))',
);

/** BAD: tasks are read and listed without the owner filter (notes are fine). */
const TASKS_NO_OWNER_FILTER_SERVER = CORRECT_SERVER.replace(
	'"select id, title, noteId from tasks where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).first();\n    if (!row)',
	'"select id, title, noteId from tasks where id = ?").bind(Number(c.req.param("id"))).first();\n    if (!row)',
).replace(
	'"select id, title, noteId from tasks where ownerId = ? order by id").bind(user.id).all();',
	'"select id, title, noteId from tasks order by id").all();',
);

/** BAD: tasks are kept in memory (notes are saved), so they vanish after a restart. */
const TASKS_IN_MEMORY_SERVER = CORRECT_SERVER.replace(
	'app.get("/health", (c) => c.json({ ok: true }));',
	'app.get("/health", (c) => c.json({ ok: true }));\nconst TASKS: { id: number; ownerId: string; title: string; noteId: number }[] = [];\nlet NEXT_TASK = 1;',
).replace(
	'const row = await c.env.DB.prepare("insert into tasks (ownerId, title, noteId) values (?, ?, ?) returning id, title, noteId").bind(user.id, title, Number(noteId)).first();\n    return c.json(row, 201);',
	'const row = { id: NEXT_TASK++, ownerId: user.id, title, noteId: Number(noteId) };\n    TASKS.push(row);\n    return c.json({ id: row.id, title: row.title, noteId: row.noteId }, 201);',
).replace(
	'const row = await c.env.DB.prepare("select id, title, noteId from tasks where id = ? and ownerId = ?").bind(Number(c.req.param("id")), user.id).first();\n    if (!row) return c.json({ error: "Not found." }, 404);\n    return c.json(row);',
	'const row = TASKS.find((r) => r.id === Number(c.req.param("id")) && r.ownerId === user.id);\n    if (!row) return c.json({ error: "Not found." }, 404);\n    return c.json({ id: row.id, title: row.title, noteId: row.noteId });',
).replace(
	'const { results } = await c.env.DB.prepare("select id, title, noteId from tasks where ownerId = ? order by id").bind(user.id).all();\n    return c.json(results);',
	'return c.json(TASKS.filter((r) => r.ownerId === user.id));',
);

/** The person app's files: its server, both screens, the shell and the migration. */
function personFiles(server: string, notesScreen = CORRECT_SCREEN, tasksScreen = TASKS_SCREEN): Record<string, string> {
	return {
		'src/server.ts': server,
		'src/NotesScreen.tsx': notesScreen,
		'src/TasksScreen.tsx': tasksScreen,
		'src/App.tsx': NOTES_APP,
		'migrations/0001_notes.sql': NOTES_MIGRATION,
	};
}

// --- the TEAM-ONLY app --------------------------------------------------------
// A team app: a "crews" team registry (owner: team) and a "logs" team-owned
// table whose records live under /api/teams/:teamId/logs. The correct app routes
// every team record through its team routes, filtered by team membership, with a
// role-gated update and an admin route. The bad apps each break one thing.

export const TEAM_BLOCK: ArchitectureBlock = {
	version: 2,
	signIn: 'required',
	team: { table: 'crews', plain: 'A crew and its people', roles: ['boss', 'hand'], creatorRole: 'boss' },
	modules: [{ id: 'app', plain: 'The whole app', dependsOn: [] }],
	tables: [
		{ name: 'crews', module: 'app', plain: 'A crew', owner: 'team', fields: [{ name: 'name', type: 'text', references: null }] },
		{ name: 'logs', module: 'app', plain: 'A crew log entry', owner: 'team', fields: [{ name: 'text', type: 'text', references: null }] },
		// A second team-owned table, and a person's own notes inside the team app.
		{ name: 'tools', module: 'app', plain: 'A tool the crew shares', owner: 'team', fields: [{ name: 'label', type: 'text', references: null }] },
		{ name: 'notes', module: 'app', plain: 'A note only you can see', owner: 'person', fields: [{ name: 'body', type: 'text', references: null }] },
	],
	routes: [
		// the team registry's own CRUD: create is team creation (signed-in, no :teamId)
		{ id: 'crews.create', module: 'app', feature: 'crews', op: 'create', method: 'POST', path: '/api/crews', table: 'crews', plain: 'Start a crew', access: 'signed-in', request: [{ name: 'name', type: 'text', example: 'Blue Crew' }], response: ['id', 'name'] },
		{ id: 'crews.list', module: 'app', feature: 'crews', op: 'list', method: 'GET', path: '/api/crews', table: 'crews', plain: 'Your crews', access: 'signed-in', request: [], response: ['id', 'name'] },
		// the team-owned child table: records under /api/teams/:teamId/logs
		{ id: 'logs.create', module: 'app', feature: 'logs', op: 'create', method: 'POST', path: '/api/teams/:teamId/logs', table: 'logs', plain: 'Add a log', access: 'team', request: [{ name: 'text', type: 'text', example: 'Fed the animals' }], response: ['id', 'text'] },
		{ id: 'logs.read', module: 'app', feature: 'logs', op: 'read', method: 'GET', path: '/api/teams/:teamId/logs/:id', table: 'logs', plain: 'Read a log', access: 'team', request: [], response: ['id', 'text'] },
		{ id: 'logs.list', module: 'app', feature: 'logs', op: 'list', method: 'GET', path: '/api/teams/:teamId/logs', table: 'logs', plain: 'The crew\'s logs', access: 'team', request: [], response: ['id', 'text'] },
		{ id: 'logs.update', module: 'app', feature: 'logs', op: 'update', method: 'PUT', path: '/api/teams/:teamId/logs/:id', table: 'logs', plain: 'Change a log', access: 'team-role:boss', request: [{ name: 'text', type: 'text', example: 'Fed the animals twice' }], response: ['id', 'text'] },
		{ id: 'logs.delete', module: 'app', feature: 'logs', op: 'delete', method: 'DELETE', path: '/api/teams/:teamId/logs/:id', table: 'logs', plain: 'Delete a log', access: 'team-role:boss', request: [], response: ['id'] },
		// the second team-owned table
		{ id: 'tools.create', module: 'app', feature: 'tools', op: 'create', method: 'POST', path: '/api/teams/:teamId/tools', table: 'tools', plain: 'Add a tool', access: 'team', request: [{ name: 'label', type: 'text', example: 'Post driver' }], response: ['id', 'label'] },
		{ id: 'tools.read', module: 'app', feature: 'tools', op: 'read', method: 'GET', path: '/api/teams/:teamId/tools/:id', table: 'tools', plain: 'Read a tool', access: 'team', request: [], response: ['id', 'label'] },
		{ id: 'tools.list', module: 'app', feature: 'tools', op: 'list', method: 'GET', path: '/api/teams/:teamId/tools', table: 'tools', plain: 'The crew\'s tools', access: 'team', request: [], response: ['id', 'label'] },
		{ id: 'tools.update', module: 'app', feature: 'tools', op: 'update', method: 'PUT', path: '/api/teams/:teamId/tools/:id', table: 'tools', plain: 'Change a tool', access: 'team-role:boss', request: [{ name: 'label', type: 'text', example: 'Heavy post driver' }], response: ['id', 'label'] },
		{ id: 'tools.delete', module: 'app', feature: 'tools', op: 'delete', method: 'DELETE', path: '/api/teams/:teamId/tools/:id', table: 'tools', plain: 'Delete a tool', access: 'team-role:boss', request: [], response: ['id'] },
		// a person's own notes (personal, even inside a team app)
		{ id: 'notes.create', module: 'app', feature: 'notes', op: 'create', method: 'POST', path: '/api/notes', table: 'notes', plain: 'Add a note', access: 'person', request: [{ name: 'body', type: 'text', example: 'Ask about my pay' }], response: ['id', 'body'] },
		{ id: 'notes.read', module: 'app', feature: 'notes', op: 'read', method: 'GET', path: '/api/notes/:id', table: 'notes', plain: 'Read a note', access: 'person', request: [], response: ['id', 'body'] },
		{ id: 'notes.list', module: 'app', feature: 'notes', op: 'list', method: 'GET', path: '/api/notes', table: 'notes', plain: 'Your notes', access: 'person', request: [], response: ['id', 'body'] },
		{ id: 'notes.update', module: 'app', feature: 'notes', op: 'update', method: 'PUT', path: '/api/notes/:id', table: 'notes', plain: 'Change a note', access: 'person', request: [{ name: 'body', type: 'text', example: 'Ask about my pay rise' }], response: ['id', 'body'] },
		{ id: 'notes.delete', module: 'app', feature: 'notes', op: 'delete', method: 'DELETE', path: '/api/notes/:id', table: 'notes', plain: 'Delete a note', access: 'person', request: [], response: ['id'] },
		// an admin route (refuses a non-admin, allows the first account)
		{ id: 'admin.ping', module: 'app', feature: 'admin', op: 'action', method: 'POST', path: '/api/admin/ping', table: null, plain: 'Admin ping', access: 'admin', request: [], response: ['ok'] },
	],
	screens: [
		{ id: 'logs', module: 'app', path: '#/logs', plain: 'The crew\'s logs', shows: ['logs'] },
		{ id: 'tools', module: 'app', path: '#/tools', plain: 'The crew\'s tools', shows: ['tools'] },
	],
	services: [],
	ai: [],
	payments: null,
	emails: [],
	jobs: [],
	screenOnly: [],
};

/** The full schema for the team app (team tables + team_members + caddie_admins). */
export const TEAM_MIGRATION = generateSchema(TEAM_BLOCK);

/** The correct team server: every log goes through its crew's team routes, filtered. */
const TEAM_SERVER = [
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
	'const now = () => new Date().toISOString();',
	'',
	'implement(app, {',
	'  "crews.create": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { name } = await c.req.json<{ name: string }>();',
	'    const id = crypto.randomUUID();',
	'    await c.env.DB.prepare("insert into crews (id, teamId, name, createdAt, updatedAt) values (?, ?, ?, ?, ?)").bind(id, id, name, now(), now()).run();',
	'    await c.env.DB.prepare("insert into team_members (teamId, personId, role, createdAt) values (?, ?, ?, ?)").bind(id, user.id, "boss", now()).run();',
	'    return c.json({ id, name }, 201);',
	'  },',
	'  "crews.list": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { results } = await c.env.DB.prepare("select c.id, c.name from crews c join team_members m on m.teamId = c.id where m.personId = ? order by c.id").bind(user.id).all<{ id: string; name: string }>();',
	'    return c.json(results);',
	'  },',
	'  "logs.create": async (c) => {',
	'    const teamId = c.req.param("teamId");',
	'    const { text } = await c.req.json<{ text: string }>();',
	'    const id = crypto.randomUUID();',
	'    await c.env.DB.prepare("insert into logs (id, teamId, text, createdAt, updatedAt) values (?, ?, ?, ?, ?)").bind(id, teamId, text, now(), now()).run();',
	'    return c.json({ id, text }, 201);',
	'  },',
	'  "logs.read": async (c) => {',
	'    const teamId = c.req.param("teamId");',
	'    const row = await c.env.DB.prepare("select id, text from logs where id = ? and teamId = ?").bind(c.req.param("id"), teamId).first<{ id: string; text: string }>();',
	'    if (!row) return c.json({ error: "Not found." }, 404);',
	'    return c.json(row);',
	'  },',
	'  "logs.list": async (c) => {',
	'    const teamId = c.req.param("teamId");',
	'    const { results } = await c.env.DB.prepare("select id, text from logs where teamId = ? order by id").bind(teamId).all<{ id: string; text: string }>();',
	'    return c.json(results);',
	'  },',
	'  "logs.update": async (c) => {',
	'    const teamId = c.req.param("teamId");',
	'    const { text } = await c.req.json<{ text: string }>();',
	'    await c.env.DB.prepare("update logs set text = ?, updatedAt = ? where id = ? and teamId = ?").bind(text, now(), c.req.param("id"), teamId).run();',
	'    const row = await c.env.DB.prepare("select id, text from logs where id = ? and teamId = ?").bind(c.req.param("id"), teamId).first<{ id: string; text: string }>();',
	'    return c.json(row);',
	'  },',
	'  "logs.delete": async (c) => {',
	'    const teamId = c.req.param("teamId");',
	'    await c.env.DB.prepare("delete from logs where id = ? and teamId = ?").bind(c.req.param("id"), teamId).run();',
	'    return c.json({ id: c.req.param("id") });',
	'  },',
	'  "tools.create": async (c) => {',
	'    const teamId = c.req.param("teamId");',
	'    const { label } = await c.req.json<{ label: string }>();',
	'    const id = crypto.randomUUID();',
	'    await c.env.DB.prepare("insert into tools (id, teamId, label, createdAt, updatedAt) values (?, ?, ?, ?, ?)").bind(id, teamId, label, now(), now()).run();',
	'    return c.json({ id, label }, 201);',
	'  },',
	'  "tools.read": async (c) => {',
	'    const row = await c.env.DB.prepare("select id, label from tools where id = ? and teamId = ?").bind(c.req.param("id"), c.req.param("teamId")).first();',
	'    if (!row) return c.json({ error: "Not found." }, 404);',
	'    return c.json(row);',
	'  },',
	'  "tools.list": async (c) => {',
	'    const { results } = await c.env.DB.prepare("select id, label from tools where teamId = ? order by id").bind(c.req.param("teamId")).all();',
	'    return c.json(results);',
	'  },',
	'  "tools.update": async (c) => {',
	'    const { label } = await c.req.json<{ label: string }>();',
	'    await c.env.DB.prepare("update tools set label = ?, updatedAt = ? where id = ? and teamId = ?").bind(label, now(), c.req.param("id"), c.req.param("teamId")).run();',
	'    const row = await c.env.DB.prepare("select id, label from tools where id = ? and teamId = ?").bind(c.req.param("id"), c.req.param("teamId")).first();',
	'    return c.json(row);',
	'  },',
	'  "tools.delete": async (c) => {',
	'    await c.env.DB.prepare("delete from tools where id = ? and teamId = ?").bind(c.req.param("id"), c.req.param("teamId")).run();',
	'    return c.json({ id: c.req.param("id") });',
	'  },',
	'  "notes.create": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { body } = await c.req.json<{ body: string }>();',
	'    const id = crypto.randomUUID();',
	'    await c.env.DB.prepare("insert into notes (id, ownerId, body, createdAt, updatedAt) values (?, ?, ?, ?, ?)").bind(id, user.id, body, now(), now()).run();',
	'    return c.json({ id, body }, 201);',
	'  },',
	'  "notes.read": async (c) => {',
	'    const user = await requireUser(c);',
	'    const row = await c.env.DB.prepare("select id, body from notes where id = ? and ownerId = ?").bind(c.req.param("id"), user.id).first();',
	'    if (!row) return c.json({ error: "Not found." }, 404);',
	'    return c.json(row);',
	'  },',
	'  "notes.list": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { results } = await c.env.DB.prepare("select id, body from notes where ownerId = ? order by id").bind(user.id).all();',
	'    return c.json(results);',
	'  },',
	'  "notes.update": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { body } = await c.req.json<{ body: string }>();',
	'    await c.env.DB.prepare("update notes set body = ?, updatedAt = ? where id = ? and ownerId = ?").bind(body, now(), c.req.param("id"), user.id).run();',
	'    const row = await c.env.DB.prepare("select id, body from notes where id = ? and ownerId = ?").bind(c.req.param("id"), user.id).first();',
	'    return c.json(row);',
	'  },',
	'  "notes.delete": async (c) => {',
	'    const user = await requireUser(c);',
	'    await c.env.DB.prepare("delete from notes where id = ? and ownerId = ?").bind(c.req.param("id"), user.id).run();',
	'    return c.json({ id: c.req.param("id") });',
	'  },',
	'  "admin.ping": async (c) => c.json({ ok: true }),',
	'});',
	'export default app;',
	'',
].join('\n');

/**
 * The team screen: lists the logs of the team the person is looking at, read
 * with currentTeamId() from caddie/api (the person's first crew when none is
 * set), always through caddie/api.
 */
const TEAM_SCREEN = [
	'import { useEffect, useState } from "react";',
	'import { api, currentTeamId } from "../caddie/api";',
	'',
	'export function LogsScreen() {',
	'  const [texts, setTexts] = useState<string[] | null>(null);',
	'  useEffect(() => {',
	'    (async () => {',
	'      let teamId = currentTeamId();',
	'      if (!teamId) teamId = (await api.get<{ id: string }[]>("/api/crews"))[0]?.id ?? null;',
	'      if (!teamId) return setTexts([]);',
	'      const rows = await api.get<{ id: string; text: string }[]>(`/api/teams/${teamId}/logs`);',
	'      setTexts(rows.map((r) => r.text));',
	'    })().catch(() => setTexts([]));',
	'  }, []);',
	'  if (texts === null) return <p>Loading…</p>;',
	'  return <ul>{texts.map((t) => <li key={t}>{t}</li>)}</ul>;',
	'}',
	'',
].join('\n');

/** The team app shell: mounts LogsScreen at exactly #/logs, as caddie/router.tsx matches. */
const TEAM_APP = [
	'import { LogsScreen } from "./LogsScreen";',
	'import { ToolsScreen } from "./ToolsScreen";',
	'',
	'export function App() {',
	'  const hash = typeof location !== "undefined" ? location.hash : "";',
	'  if (hash === "#/logs") return <LogsScreen />;',
	'  if (hash === "#/tools") return <ToolsScreen />;',
	'  return <main><h1>Your app</h1></main>;',
	'}',
	'',
].join('\n');

/** The tools screen: the tools of the team in currentTeamId() (else the first crew), through caddie/api. */
const TOOLS_SCREEN = TEAM_SCREEN.replace('export function LogsScreen()', 'export function ToolsScreen()')
	.replace('const rows = await api.get<{ id: string; text: string }[]>(`/api/teams/${teamId}/logs`);\n      setTexts(rows.map((r) => r.text));', 'const rows = await api.get<{ id: string; label: string }[]>(`/api/teams/${teamId}/tools`);\n      setTexts(rows.map((r) => r.label));');

/** BAD: tools are read, listed and changed without the team filter (logs are fine). */
const TOOLS_NO_FILTER_SERVER = TEAM_SERVER.replace(
	'"select id, label from tools where id = ? and teamId = ?").bind(c.req.param("id"), c.req.param("teamId")).first();\n    if (!row)',
	'"select id, label from tools where id = ?").bind(c.req.param("id")).first();\n    if (!row)',
).replace(
	'"select id, label from tools where teamId = ? order by id").bind(c.req.param("teamId")).all();',
	'"select id, label from tools order by id").all();',
).replace(
	'"update tools set label = ?, updatedAt = ? where id = ? and teamId = ?").bind(label, now(), c.req.param("id"), c.req.param("teamId")).run();',
	'"update tools set label = ?, updatedAt = ? where id = ?").bind(label, now(), c.req.param("id")).run();',
);

/**
 * BAD: a person's notes are shared with everyone in the same crews: a teammate
 * reads them. An outsider still can't (no shared crew), so only the teammate
 * check catches it.
 */
const TEAMMATE_READS_NOTES_SERVER = TEAM_SERVER.replace(
	'"select id, body from notes where id = ? and ownerId = ?").bind(c.req.param("id"), user.id).first();\n    if (!row)',
	'"select id, body from notes where id = ? and (ownerId = ? or ownerId in (select m2.personId from team_members m1 join team_members m2 on m2.teamId = m1.teamId where m1.personId = ?))").bind(c.req.param("id"), user.id, user.id).first();\n    if (!row)',
).replace(
	'"select id, body from notes where ownerId = ? order by id").bind(user.id).all();',
	'"select id, body from notes where ownerId = ? or ownerId in (select m2.personId from team_members m1 join team_members m2 on m2.teamId = m1.teamId where m1.personId = ?) order by id").bind(user.id, user.id).all();',
);

/** The team app's files: its server, both team screens, the shell and the generated schema. */
function teamFiles(server: string, logsScreen = TEAM_SCREEN, app = TEAM_APP): Record<string, string> {
	return {
		'src/server.ts': server,
		'src/LogsScreen.tsx': logsScreen,
		'src/ToolsScreen.tsx': TOOLS_SCREEN,
		'src/App.tsx': app,
		'migrations/0001_schema.sql': TEAM_MIGRATION,
	};
}

/** An app shell with no screens built yet (the logs feature comes later). */
const TEAM_SHELL_APP = ['export function App() {', '  return <main><h1>Your app</h1></main>;', '}', ''].join('\n');

/** CORRECT but minimal: reads only currentTeamId(), with no first-team fallback. */
const TEAM_CURRENT_ONLY_SCREEN = TEAM_SCREEN.replace(
	'      if (!teamId) teamId = (await api.get<{ id: string }[]>("/api/crews"))[0]?.id ?? null;\n',
	'',
);

/** BAD: the team update writes without the teamId filter, so an outsider changes it. */
const TEAM_NO_FILTER_SERVER = TEAM_SERVER
	.replace(
		'await c.env.DB.prepare("update logs set text = ?, updatedAt = ? where id = ? and teamId = ?").bind(text, now(), c.req.param("id"), teamId).run();',
		'await c.env.DB.prepare("update logs set text = ?, updatedAt = ? where id = ?").bind(text, now(), c.req.param("id")).run();',
	)
	.replace(
		'const row = await c.env.DB.prepare("select id, text from logs where id = ? and teamId = ?").bind(c.req.param("id"), teamId).first<{ id: string; text: string }>();\n    if (!row) return c.json({ error: "Not found." }, 404);\n    return c.json(row);',
		'const row = await c.env.DB.prepare("select id, text from logs where id = ?").bind(c.req.param("id")).first<{ id: string; text: string }>();\n    if (!row) return c.json({ error: "Not found." }, 404);\n    return c.json(row);',
	)
	.replace(
		'const { results } = await c.env.DB.prepare("select id, text from logs where teamId = ? order by id").bind(teamId).all<{ id: string; text: string }>();',
		'const { results } = await c.env.DB.prepare("select id, text from logs order by id").all<{ id: string; text: string }>();',
	);

/** BAD: the team update writes nothing, so a change does not stick. */
const TEAM_UPDATE_NOT_SAVED_SERVER = TEAM_SERVER.replace(
	'await c.env.DB.prepare("update logs set text = ?, updatedAt = ? where id = ? and teamId = ?").bind(text, now(), c.req.param("id"), teamId).run();',
	'// bug: the update is dropped, nothing is saved',
);

/** BAD: the team delete has no teamId filter, so B deletes A's log through B's own crew. */
const TEAM_DELETE_NO_FILTER_SERVER = TEAM_SERVER.replace(
	'await c.env.DB.prepare("delete from logs where id = ? and teamId = ?").bind(c.req.param("id"), teamId).run();',
	'void teamId; await c.env.DB.prepare("delete from logs where id = ?").bind(c.req.param("id")).run();',
);

/** CORRECT, but its replies carry teamId before text (real apps return whole rows). */
const TEAM_WIDE_ROWS_SERVER = TEAM_SERVER.replace(
	'select id, text from logs where id = ? and teamId = ?',
	'select id, teamId, text from logs where id = ? and teamId = ?',
).replace(
	'select id, text from logs where teamId = ? order by id',
	'select id, teamId, text from logs where teamId = ? order by id',
);

/** Only the crews and admin features are built: every logs route is still a 501. */
const TEAM_CREWS_ONLY_SERVER = TEAM_SERVER.replace(/ {2}"logs\.create"[\s\S]*?(?= {2}"admin\.ping")/, '');

/** BAD team screen: reads localStorage, so the saved log never shows on screen. */
const TEAM_LOCALSTORAGE_SCREEN = [
	'import { useEffect, useState } from "react";',
	'',
	'export function LogsScreen() {',
	'  const [texts, setTexts] = useState<string[]>([]);',
	'  useEffect(() => {',
	'    const raw = localStorage.getItem("logs");',
	'    setTexts(raw ? (JSON.parse(raw) as string[]) : []);',
	'  }, []);',
	'  return <ul>{texts.map((t) => <li key={t}>{t}</li>)}</ul>;',
	'}',
	'',
].join('\n');

export const CONTRACT_FIXTURES: readonly ContractFixture[] = [
	{ id: 'correct', plain: 'A correct app: owner-scoped CRUD on both tables, screens that use caddie/api.', mustFail: [], files: personFiles(CORRECT_SERVER) },
	{ id: 'kept-in-memory', plain: 'Keeps notes in memory, so they vanish after a restart.', mustFail: ['read'], files: personFiles(IN_MEMORY_SERVER) },
	{ id: 'dummy-row-serves-memory', plain: 'Inserts a dummy row but serves from memory; the read after restart fails.', mustFail: ['read'], files: personFiles(DUMMY_ROW_SERVER) },
	{ id: 'no-owner-filter', plain: 'No owner filter, so a second person can see the first person\'s notes.', mustFail: ['privacy-screen'], files: personFiles(NO_OWNER_FILTER_SERVER) },
	{ id: 'update-not-saved', plain: 'An update that is dropped, so a change does not survive a restart.', mustFail: ['privacy-screen'], files: personFiles(UPDATE_NOT_SAVED_SERVER) },
	{ id: 'screen-reads-localstorage', plain: 'A screen reads localStorage instead of the server; the static check and the screen check catch it.', mustFail: ['privacy-screen'], files: personFiles(CORRECT_SERVER, LOCALSTORAGE_SCREEN) },
	// Every person-owned table is checked, not only the first one.
	{ id: 'second-table-kept-in-memory', plain: 'Notes are saved, but tasks are kept in memory and vanish after a restart.', mustFail: ['read'], files: personFiles(TASKS_IN_MEMORY_SERVER) },
	{ id: 'second-table-no-owner-filter', plain: 'Notes are private, but tasks have no owner filter, so a second person sees them.', mustFail: ['privacy-screen'], files: personFiles(TASKS_NO_OWNER_FILTER_SERVER) },
	// Each screen is checked against the record of the table it shows.
	{ id: 'second-screen-shows-another-table', plain: 'The tasks screen reads the server, but shows the notes instead of the tasks.', mustFail: ['privacy-screen'], files: personFiles(CORRECT_SERVER, CORRECT_SCREEN, TASKS_SHOWS_NOTES_SCREEN) },
];

/** Team-mode fixtures (plan part E, team mode). Run across all four phases. */
export const TEAM_FIXTURES: readonly ContractFixture[] = [
	{ id: "team-correct", plain: "A correct team app: every record through its team routes, role and admin gated, personal notes kept personal.", mustFail: [], files: teamFiles(TEAM_SERVER) },
	{ id: "team-route-without-team-filter", plain: "A team route with no team filter, so an outsider can read and change the crew's records.", mustFail: ['privacy-screen'], files: teamFiles(TEAM_NO_FILTER_SERVER) },
	{ id: "team-update-not-saved", plain: "A team update that is dropped, so a change does not survive a restart.", mustFail: ['privacy-screen'], files: teamFiles(TEAM_UPDATE_NOT_SAVED_SERVER) },
	{ id: "team-screen-reads-localstorage", plain: "A team screen reads localStorage, so the saved log never shows on screen.", mustFail: ['privacy-screen'], files: teamFiles(TEAM_SERVER, TEAM_LOCALSTORAGE_SCREEN) },
	{ id: "team-delete-without-team-filter", plain: "A team delete with no team filter, so an outsider deletes the crew's record through their own crew.", mustFail: ['privacy-screen'], files: teamFiles(TEAM_DELETE_NO_FILTER_SERVER) },
	{ id: "team-correct-wide-rows", plain: "A correct team app whose replies carry teamId before the text.", mustFail: [], files: teamFiles(TEAM_WIDE_ROWS_SERVER) },
	{ id: "team-screen-reads-current-team", plain: "A correct team screen that shows exactly the team in currentTeamId().", mustFail: [], files: teamFiles(TEAM_SERVER, TEAM_CURRENT_ONLY_SCREEN) },
	{ id: "team-second-table-without-team-filter", plain: "Logs are filtered by crew, but tools are not, so an outsider sees the crew's tools.", mustFail: ['privacy-screen'], files: teamFiles(TOOLS_NO_FILTER_SERVER) },
	{ id: "team-teammate-reads-personal", plain: "A person's own notes are shared with their crew, so a teammate reads them.", mustFail: ['privacy-screen'], files: teamFiles(TEAMMATE_READS_NOTES_SERVER) },
];

/**
 * Feature scope (plan part E: "for the routes of passed features plus the
 * current one"). The same half-built app passes when only its built features
 * are checked, and fails against the whole design.
 */
export const TEAM_SCOPED_FIXTURES: readonly ContractFixture[] = [
	{
		id: 'team-crews-built',
		plain: 'Only the crews and admin features are built; checked for those features, it passes.',
		mustFail: [],
		features: ['crews', 'admin'],
		files: { 'src/server.ts': TEAM_CREWS_ONLY_SERVER, 'src/App.tsx': TEAM_SHELL_APP, 'migrations/0001_schema.sql': TEAM_MIGRATION },
	},
	{
		id: 'team-crews-built-whole-design',
		plain: 'The same half-built app checked against the whole design fails: its logs are not built yet.',
		mustFail: ['create'],
		files: { 'src/server.ts': TEAM_CREWS_ONLY_SERVER, 'src/App.tsx': TEAM_SHELL_APP, 'migrations/0001_schema.sql': TEAM_MIGRATION },
	},
];

export { UPDATE_NOT_SAVED_SERVER, CORRECT_SERVER, CORRECT_SCREEN, LOCALSTORAGE_SCREEN, TEAM_SERVER, TEAM_SCREEN };
