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

/**
 * The app shell: mounts NotesScreen at #/notes (the declared screen path). The
 * generated step-8 check imports `../src/App`, sets the hash, and renders it, so
 * the App must surface the screen that shows the notes table.
 */
const NOTES_APP = [
	'import { NotesScreen } from "./NotesScreen";',
	'',
	'export function App() {',
	'  const hash = typeof location !== "undefined" ? location.hash : "#/notes";',
	'  if (hash === "#/notes") return <NotesScreen />;',
	'  return <main><h1>Your app</h1></main>;',
	'}',
	'',
].join('\n');

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
		// an admin route (refuses a non-admin, allows the first account)
		{ id: 'admin.ping', module: 'app', feature: 'admin', op: 'action', method: 'POST', path: '/api/admin/ping', table: null, plain: 'Admin ping', access: 'admin', request: [], response: ['ok'] },
	],
	screens: [{ id: 'logs', module: 'app', path: '#/logs', plain: 'The crew\'s logs', shows: ['logs'] }],
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
	'  "admin.ping": async (c) => c.json({ ok: true }),',
	'});',
	'export default app;',
	'',
].join('\n');

/** The team screen: lists the crew\'s logs through caddie/api, reading the teamId from the hash. */
const TEAM_SCREEN = [
	'import { useEffect, useState } from "react";',
	'import { api } from "../caddie/api";',
	'',
	'export function LogsScreen() {',
	'  const [texts, setTexts] = useState<string[] | null>(null);',
	'  useEffect(() => {',
	'    const teamId = (location.hash.split("/")[2]) || "";',
	'    api.get<{ id: string; text: string }[]>(`/api/teams/${teamId}/logs`).then((rows) => setTexts(rows.map((r) => r.text))).catch(() => setTexts([]));',
	'  }, []);',
	'  if (texts === null) return <p>Loading…</p>;',
	'  return <ul>{texts.map((t) => <li key={t}>{t}</li>)}</ul>;',
	'}',
	'',
].join('\n');

/** The team app shell: mounts LogsScreen at #/logs/<teamId>. */
const TEAM_APP = [
	'import { LogsScreen } from "./LogsScreen";',
	'',
	'export function App() {',
	'  const hash = typeof location !== "undefined" ? location.hash : "";',
	'  if (hash.startsWith("#/logs")) return <LogsScreen />;',
	'  return <main><h1>Your app</h1></main>;',
	'}',
	'',
].join('\n');

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
	{
		id: 'correct',
		plain: 'A correct app: owner-scoped CRUD, a screen that uses caddie/api.',
		mustFail: [],
		files: { 'src/server.ts': CORRECT_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'src/App.tsx': NOTES_APP, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'kept-in-memory',
		plain: 'Keeps notes in memory, so they vanish after a restart.',
		mustFail: ['read'],
		files: { 'src/server.ts': IN_MEMORY_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'src/App.tsx': NOTES_APP, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'dummy-row-serves-memory',
		plain: 'Inserts a dummy row but serves from memory; the read after restart fails.',
		mustFail: ['read'],
		files: { 'src/server.ts': DUMMY_ROW_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'src/App.tsx': NOTES_APP, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'no-owner-filter',
		plain: 'No owner filter, so a second person can see the first person\'s notes.',
		mustFail: ['privacy-screen'],
		files: { 'src/server.ts': NO_OWNER_FILTER_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'src/App.tsx': NOTES_APP, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'update-not-saved',
		plain: 'An update that is dropped, so a change does not survive a restart.',
		mustFail: ['privacy-screen'],
		files: { 'src/server.ts': UPDATE_NOT_SAVED_SERVER, 'src/NotesScreen.tsx': CORRECT_SCREEN, 'src/App.tsx': NOTES_APP, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
	{
		id: 'screen-reads-localstorage',
		plain: 'A screen reads localStorage instead of the server; the static check and the screen check catch it.',
		mustFail: ['privacy-screen'],
		files: { 'src/server.ts': CORRECT_SERVER, 'src/NotesScreen.tsx': LOCALSTORAGE_SCREEN, 'src/App.tsx': NOTES_APP, 'migrations/0001_notes.sql': NOTES_MIGRATION },
	},
];

/** Team-mode fixtures (plan part E, team mode). Run across all four phases. */
export const TEAM_FIXTURES: readonly ContractFixture[] = [
	{
		id: 'team-correct',
		plain: 'A correct team app: every record through its team routes, role and admin gated.',
		mustFail: [],
		files: { 'src/server.ts': TEAM_SERVER, 'src/LogsScreen.tsx': TEAM_SCREEN, 'src/App.tsx': TEAM_APP, 'migrations/0001_schema.sql': TEAM_MIGRATION },
	},
	{
		id: 'team-route-without-team-filter',
		plain: 'A team route with no team filter, so an outsider can read and change the crew\'s records.',
		mustFail: ['privacy-screen'],
		files: { 'src/server.ts': TEAM_NO_FILTER_SERVER, 'src/LogsScreen.tsx': TEAM_SCREEN, 'src/App.tsx': TEAM_APP, 'migrations/0001_schema.sql': TEAM_MIGRATION },
	},
	{
		id: 'team-update-not-saved',
		plain: 'A team update that is dropped, so a change does not survive a restart.',
		mustFail: ['privacy-screen'],
		files: { 'src/server.ts': TEAM_UPDATE_NOT_SAVED_SERVER, 'src/LogsScreen.tsx': TEAM_SCREEN, 'src/App.tsx': TEAM_APP, 'migrations/0001_schema.sql': TEAM_MIGRATION },
	},
	{
		id: 'team-screen-reads-localstorage',
		plain: 'A team screen reads localStorage, so the saved log never shows on screen.',
		mustFail: ['privacy-screen'],
		files: { 'src/server.ts': TEAM_SERVER, 'src/LogsScreen.tsx': TEAM_LOCALSTORAGE_SCREEN, 'src/App.tsx': TEAM_APP, 'migrations/0001_schema.sql': TEAM_MIGRATION },
	},
];

export { UPDATE_NOT_SAVED_SERVER, CORRECT_SERVER, CORRECT_SCREEN, LOCALSTORAGE_SCREEN, TEAM_SERVER, TEAM_SCREEN };
