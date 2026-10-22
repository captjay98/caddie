/**
 * Generated contract files (plan part E).
 *
 * From the approved architecture block, Caddie writes a set of PROTECTED files
 * into the app, so a builder can't forget the access check or weaken the
 * contract test:
 *
 *   caddie/contract.ts        the route table, the request/response types, and
 *                             `implement(app, routes)` — which mounts each
 *                             declared route's access check (part B) BEFORE the
 *                             builder's own handler runs: 401 without a session
 *                             or a valid job signature, 403 for the wrong team,
 *                             role or admin.
 *   caddie/api.ts             the ONLY way a screen reaches the server (the
 *                             static check in host-checks.ts enforces this).
 *   caddie/router.tsx         hash routes for the declared screens.
 *   caddie/modules.ts         (big apps) mounts each module's server routes.
 *   caddie/contract.test.ts   the generated test, run in phases create | read |
 *                             privacy-screen | test-mode (part E steps 1-9).
 *   test/setup/d1-file.ts     a FILE-BACKED copy of the SAME db wrapper shipped
 *                             in test/setup/d1.ts, so the restart check runs
 *                             across two processes on one database file (S4).
 *
 * `generateContractFiles(block, { kind })` returns the files keyed by path.
 * The host writes them when a feature is handed out and before every check run
 * (host-checks.ts). The output is DETERMINISTIC, so part E's generation is
 * testable by snapshot.
 *
 * This file OWNS only the generated text. The shipped starter's own
 * `test/setup/d1.ts` is lane 11's; the generated `test/setup/d1-file.ts` here
 * re-uses that wrapper's `splitStatements` and only swaps `:memory:` for the
 * file at CADDIE_TEST_DB_FILE, so "the SAME wrapper" stays literally true.
 */

import {
	teamRoleOf,
	type Access,
	type ArchitectureBlock,
	type ArchitectureRoute,
} from '@caddie/contracts';

export type ContractKind = 'small' | 'big';

export interface GeneratedContractFiles {
	/** path (relative to the app root) -> file text. */
	readonly files: Readonly<Record<string, string>>;
}

const j = (value: unknown): string => JSON.stringify(value);

// --------------------------------------------------------------------------
// caddie/d1-file.ts — the file-backed db wrapper (S4, proven by the spike)
// --------------------------------------------------------------------------

/**
 * A FILE-BACKED variant of the shipped test/setup/d1.ts wrapper. It imports the
 * shipped wrapper's own `splitStatements` and `TEST_AUTH_SECRET`, and builds the
 * SAME `Statement` / `D1Database` shape over a file database, applying each
 * migration ONCE (a second process opening the file skips migrations it already
 * applied, via a WAL journal and a has-any-app-table guard). The only change
 * from the shipped wrapper is `new Database(file)` in place of `":memory:"`.
 */
const D1_FILE = [
	'// Caddie test harness — do not edit. A FILE-BACKED Cloudflare D1 database for',
	'// the restart check (plan part E): the SAME wrapper as test/setup/d1.ts, but',
	'// over a file at CADDIE_TEST_DB_FILE so a SEPARATE process can reopen it and',
	'// read what the first process wrote. Migrations apply once (WAL + a guard).',
	'import { Database } from "bun:sqlite";',
	'import { existsSync, readdirSync, readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	'import type { D1Database } from "../../caddie/d1";',
	'import { splitStatements, TEST_AUTH_SECRET } from "./d1";',
	'import { createTestCaddie, type TestCaddie } from "./caddie";',
	'',
	'const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");',
	'',
	'function value(input: unknown): unknown {',
	'  if (input === undefined) throw new Error("D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'");',
	'  if (typeof input === "boolean") return input ? 1 : 0;',
	'  return input;',
	'}',
	'',
	'function d1Error(error: unknown): Error {',
	'  const message = error instanceof Error ? error.message : String(error);',
	'  return new Error(message.startsWith("D1_") ? message : "D1_ERROR: " + message);',
	'}',
	'',
	'class Statement {',
	'  constructor(private readonly db: Database, private readonly sql: string, private readonly params: unknown[] = []) {}',
	'  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values.map(value)); }',
	'  private execute() {',
	'    try {',
	'      const prepared = this.db.prepare(this.sql);',
	'      const columns = prepared.columnNames;',
	'      if (columns.length > 0) {',
	'        const rows = prepared.all(...(this.params as never[])) as Record<string, unknown>[];',
	'        return { rows, columns };',
	'      }',
	'      const result = prepared.run(...(this.params as never[]));',
	'      return { rows: [] as Record<string, unknown>[], columns, lastRowId: Number(result.lastInsertRowid), changes: result.changes };',
	'    } catch (error) { throw d1Error(error); }',
	'  }',
	'  async first<T = unknown>(column?: string): Promise<T | null> {',
	'    const row = this.execute().rows[0];',
	'    if (row === undefined) return null;',
	'    if (column === undefined) return row as T;',
	'    if (!(column in row)) throw new Error("D1_COLUMN_NOTFOUND: Column not found (" + column + ")");',
	'    return (row as Record<string, unknown>)[column] as T;',
	'  }',
	'  async all<T = Record<string, unknown>>() {',
	'    const { rows } = this.execute();',
	'    return { results: rows as T[], success: true as const, meta: {} };',
	'  }',
	'  async run<T = Record<string, unknown>>() { return this.all<T>(); }',
	'  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<any> {',
	'    const { rows, columns } = this.execute();',
	'    const out = rows.map((row) => columns.map((name) => row[name])) as T[];',
	'    return options?.columnNames ? [columns, ...out] : out;',
	'  }',
	'}',
	'',
	'/** Has any app table been created yet? (Migrations beyond the auth ones.) */',
	'function schemaApplied(db: Database): boolean {',
	'  const row = db',
	'    .prepare("select count(*) as n from sqlite_master where type = \'table\' and name not like \'auth_%\' and name not like \'sqlite_%\'")',
	'    .get() as { n: number };',
	'  return row.n > 0;',
	'}',
	'',
	'/** The SAME wrapper as test/setup/d1.ts, over a file so a second process can reopen it. */',
	'export function createFileDatabase(file: string): D1Database {',
	'  const db = new Database(file);',
	'  db.exec("pragma journal_mode = wal;");',
	'  if (!schemaApplied(db) && existsSync(MIGRATIONS)) {',
	'    const files = readdirSync(MIGRATIONS).filter((name) => /^\\d{4}_.+\\.sql$/.test(name)).sort();',
	'    for (const name of files) {',
	'      for (const sql of splitStatements(readFileSync(join(MIGRATIONS, name), "utf8"))) db.exec(sql);',
	'    }',
	'  }',
	'  return {',
	'    prepare: (query: string) => new Statement(db, query) as never,',
	'    async batch(statements: never[]) { return db.transaction(() => statements.map((s) => (s as unknown as Statement)))() as never; },',
	'    async exec(query: string) { for (const sql of splitStatements(query)) db.exec(sql); return { count: 1, duration: 0 } as never; },',
	'  } as D1Database;',
	'}',
	'',
	'export function createFileEnv(file: string): { DB: D1Database; CADDIE: TestCaddie; CADDIE_AUTH_SECRET: string } {',
	'  return { DB: createFileDatabase(file), CADDIE: createTestCaddie(), CADDIE_AUTH_SECRET: TEST_AUTH_SECRET };',
	'}',
	'',
].join('\n');

// --------------------------------------------------------------------------
// caddie/contract.ts — the route table, types, implement() with the access check
// --------------------------------------------------------------------------

/** The declared routes, as a plain data table the generated code and test read. */
function routeTableLiteral(block: ArchitectureBlock): string {
	const rows = block.routes.map((r) => {
		const role = teamRoleOf(r.access as Access);
		return (
			'  ' +
			j({
				id: r.id,
				module: r.module,
				feature: r.feature,
				op: r.op,
				method: r.method,
				path: r.path,
				table: r.table,
				access: r.access,
				role,
				request: r.request.map((f) => ({ name: f.name, type: f.type, example: f.example })),
				response: r.response,
			})
		);
	});
	return '[\n' + rows.join(',\n') + '\n]';
}

function contractTs(block: ArchitectureBlock): string {
	const teamTable = block.team?.table ?? null;
	return [
		'// Caddie runtime file — do not edit. The app\'s contract (plan part E): the',
		'// declared routes, and implement(app, handlers) which checks WHO may call each',
		'// route BEFORE the builder\'s handler runs — 401 without a session or a valid',
		'// job signature, 403 for the wrong team, role or admin. A builder cannot forget',
		'// the access check: it is mounted here, from the approved design.',
		'import type { Context, Hono, MiddlewareHandler } from "hono";',
		'import { requireUser, currentUser } from "./auth";',
		'',
		'export type Access =',
		'  | "public" | "signed-in" | "person" | "team" | "admin" | "job"',
		'  | `team-role:${string}`;',
		'',
		'export interface ContractRoute {',
		'  id: string;',
		'  module: string;',
		'  feature: string;',
		'  op: "create" | "read" | "list" | "update" | "delete" | "action";',
		'  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";',
		'  path: string;',
		'  table: string | null;',
		'  access: Access;',
		'  /** The role from a team-role:<role> access, else null. */',
		'  role: string | null;',
		'  request: { name: string; type: string; example: string }[];',
		'  response: string[];',
		'}',
		'',
		'export const ROUTES: ContractRoute[] = ' + routeTableLiteral(block) + ' as ContractRoute[];',
		'',
		'/** The team table\'s name, or null for an app without teams. */',
		'export const TEAM_TABLE: string | null = ' + j(teamTable) + ';',
		'',
		'/** Caddie\'s job signature header: "<unix-ms>.<hex>", valid for 5 minutes. */',
		'export const JOB_HEADER = "x-caddie-job";',
		'const JOB_MAX_AGE_MS = 5 * 60_000;',
		'',
		'/** The scaffold mounts the app with .basePath("/api"); routes register relative to it. */',
		'export const BASE_PATH = "/api";',
		'',
		'function unauthorized(message: string): Response {',
		'  return new Response(JSON.stringify({ error: message }), { status: 401, headers: { "content-type": "application/json" } });',
		'}',
		'function forbidden(message: string): Response {',
		'  return new Response(JSON.stringify({ error: message }), { status: 403, headers: { "content-type": "application/json" } });',
		'}',
		'',
		'async function isTeamMember(c: Context, teamId: string, personId: string): Promise<{ inTeam: boolean; role: string | null }> {',
		'  const row = await c.env.DB.prepare("select role from team_members where teamId = ? and personId = ?")',
		'    .bind(teamId, personId)',
		'    .first<{ role: string }>();',
		'  return { inTeam: row !== null, role: row?.role ?? null };',
		'}',
		'',
		'async function isAdmin(c: Context, personId: string): Promise<boolean> {',
		'  const row = await c.env.DB.prepare("select 1 as ok from caddie_admins where personId = ?").bind(personId).first<{ ok: number }>();',
		'  return row !== null;',
		'}',
		'',
		'/** Verify Caddie\'s Run-now signature over (secret, header). */',
		'async function validJobSignature(c: Context): Promise<boolean> {',
		'  const header = c.req.header(JOB_HEADER);',
		'  const secret = (c.env as { CADDIE_JOB_SECRET?: string }).CADDIE_JOB_SECRET;',
		'  if (!header || !secret) return false;',
		'  const dot = header.indexOf(".");',
		'  if (dot <= 0) return false;',
		'  const stamp = header.slice(0, dot);',
		'  const sig = header.slice(dot + 1);',
		'  const ms = Number(stamp);',
		'  if (!Number.isFinite(ms) || Math.abs(Date.now() - ms) > JOB_MAX_AGE_MS) return false;',
		'  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);',
		'  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stamp));',
		'  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");',
		'  // Constant-time-ish compare.',
		'  if (hex.length !== sig.length) return false;',
		'  let diff = 0;',
		'  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);',
		'  return diff === 0;',
		'}',
		'',
		'/** The access guard for one route. Returns a Response to refuse, or null to let the handler run. */',
		'function guardFor(route: ContractRoute): MiddlewareHandler {',
		'  return async (c, next) => {',
		'    const access = route.access;',
		'    if (access === "public") return next();',
		'    if (access === "job") {',
		'      if (!(await validJobSignature(c))) return unauthorized("This can only run from Caddie\'s scheduled run.");',
		'      return next();',
		'    }',
		'    // Every other access needs a signed-in person.',
		'    const user = await currentUser(c);',
		'    if (!user) return unauthorized("Sign in first.");',
		'    if (access === "signed-in" || access === "person") return next();',
		'    if (access === "admin") {',
		'      if (!(await isAdmin(c, user.id))) return forbidden("Only an admin can do this.");',
		'      return next();',
		'    }',
		'    if (access === "team" || route.role !== null) {',
		'      const teamId = c.req.param("teamId");',
		'      if (!teamId) return forbidden("This needs a team.");',
		'      const { inTeam, role } = await isTeamMember(c, teamId, user.id);',
		'      if (!inTeam) return forbidden("You are not a member of this team.");',
		'      if (route.role !== null && role !== route.role) return forbidden("You do not have the right role for this.");',
		'      return next();',
		'    }',
		'    return next();',
		'  };',
		'}',
		'',
		'/**',
		' * Mount every declared route\'s access guard, then let the builder\'s handler',
		' * run. The builder passes a handler per route id; a missing one is a 501, so',
		' * the contract test (phase "create") catches an unimplemented route.',
		' */',
		'export function implement<E extends { Bindings: any }>(',
		'  app: Hono<E>,',
		'  handlers: Record<string, (c: Context) => Response | Promise<Response>>,',
		'): Hono<E> {',
		'  // The app is created with .basePath("/api"), so a declared path like',
		'  // "/api/notes" is registered as "/notes" (the base is added back by Hono).',
		'  const strip = (path: string) => (path.startsWith(BASE_PATH) ? path.slice(BASE_PATH.length) || "/" : path);',
		'  for (const route of ROUTES) {',
		'    const method = route.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";',
		'    const handler = handlers[route.id];',
		'    (app as any)[method](strip(route.path), guardFor(route), async (c: Context) => {',
		'      if (!handler) return c.json({ error: "This route is not built yet." }, 501);',
		'      return handler(c);',
		'    });',
		'  }',
		'  return app;',
		'}',
		'',
		'export { requireUser };',
		'',
	].join('\n');
}

// --------------------------------------------------------------------------
// caddie/api.ts — the ONLY path a screen uses to reach the server
// --------------------------------------------------------------------------

function apiTs(): string {
	return [
		'// Caddie runtime file — do not edit. The ONE way a screen talks to the server.',
		'// Every screen must call the server through this helper (Caddie checks it): it',
		'// keeps the fetch in one place so the contract test can route it at the real',
		'// server, and so no screen quietly reads localStorage instead of the database.',
		'export interface ApiError { error: string; status: number; }',
		'',
		'async function request<T>(method: string, path: string, body?: unknown): Promise<T> {',
		'  const init: RequestInit = { method, headers: {} };',
		'  if (body !== undefined) {',
		'    (init.headers as Record<string, string>)["content-type"] = "application/json";',
		'    init.body = JSON.stringify(body);',
		'  }',
		'  const res = await fetch(path, init);',
		'  const text = await res.text();',
		'  const data = text ? JSON.parse(text) : null;',
		'  if (!res.ok) {',
		'    const err: ApiError = { error: (data && data.error) || "Something went wrong.", status: res.status };',
		'    throw err;',
		'  }',
		'  return data as T;',
		'}',
		'',
		'export const api = {',
		'  get: <T>(path: string) => request<T>("GET", path),',
		'  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),',
		'  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),',
		'  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),',
		'  delete: <T>(path: string) => request<T>("DELETE", path),',
		'};',
		'',
		'// Team apps: the team the person is looking at. A screen that shows team',
		'// records reads it with currentTeamId() and, when none is set, uses the',
		'// person\'s first team (from the team list route) and saves it with',
		'// setCurrentTeamId(). A team picker calls setCurrentTeamId() too. Caddie\'s',
		'// check sets it before it opens a team screen.',
		'const TEAM_KEY = "caddie.teamId";',
		'export function currentTeamId(): string | null {',
		'  try { return globalThis.localStorage?.getItem(TEAM_KEY) ?? null; } catch { return null; }',
		'}',
		'export function setCurrentTeamId(teamId: string): void {',
		'  try { globalThis.localStorage?.setItem(TEAM_KEY, teamId); } catch { /* storage unavailable */ }',
		'}',
		'',
	].join('\n');
}

// --------------------------------------------------------------------------
// caddie/router.tsx — hash routes for the declared screens
// --------------------------------------------------------------------------

function routerTsx(block: ArchitectureBlock): string {
	const screens = block.screens.map((s) => ({ id: s.id, path: s.path, plain: s.plain }));
	return [
		'// Caddie runtime file — do not edit. Hash routes for the declared screens.',
		'// Each screen starts as a placeholder; the builder replaces each with the real',
		'// screen component as that feature is built. The contract test checks that each',
		'// screen that shows saved data reaches the server through caddie/api.ts.',
		'import { useEffect, useState, type ReactNode } from "react";',
		'',
		'export interface ScreenDef { id: string; path: string; plain: string; }',
		'export const SCREENS: ScreenDef[] = ' + j(screens) + ';',
		'',
		'export function useHashRoute(): string {',
		'  const [hash, setHash] = useState(() => (typeof location !== "undefined" ? location.hash || "#/" : "#/"));',
		'  useEffect(() => {',
		'    const on = () => setHash(location.hash || "#/");',
		'    window.addEventListener("hashchange", on);',
		'    return () => window.removeEventListener("hashchange", on);',
		'  }, []);',
		'  return hash;',
		'}',
		'',
		'/** Mount the declared screens; the builder supplies a component per screen id. */',
		'export function Router(props: { screens: Record<string, () => ReactNode> }): ReactNode {',
		'  const hash = useHashRoute();',
		'  const match = SCREENS.find((s) => s.path === hash) ?? SCREENS[0];',
		'  if (!match) return null;',
		'  const screen = props.screens[match.id];',
		'  return screen ? screen() : <p>This screen is not built yet.</p>;',
		'}',
		'',
	].join('\n');
}

// --------------------------------------------------------------------------
// caddie/modules.ts — (big apps) mounts each module's server routes
// --------------------------------------------------------------------------

function modulesTs(block: ArchitectureBlock): string {
	const modules = block.modules.map((m) => m.id);
	return [
		'// Caddie runtime file — do not edit. (Big apps.) Each module adds its server',
		'// routes through mountModule; this file lists the declared modules so the host',
		'// can mount them in dependency order. A small app has one module ("app").',
		'import type { Context, Hono } from "hono";',
		'',
		'export const MODULE_IDS: string[] = ' + j(modules) + ';',
		'',
		'export type ModuleMount<E extends { Bindings: any }> = (app: Hono<E>) => void;',
		'',
		'/** Mount each module\'s routes in the order given. */',
		'export function mountModules<E extends { Bindings: any }>(app: Hono<E>, mounts: Record<string, ModuleMount<E>>): Hono<E> {',
		'  for (const id of MODULE_IDS) {',
		'    const mount = mounts[id];',
		'    if (mount) mount(app);',
		'  }',
		'  return app;',
		'}',
		'',
		'export type { Context };',
		'',
	].join('\n');
}

// --------------------------------------------------------------------------
// caddie/contract.test.ts — the phased contract test (part E steps 1-9)
// --------------------------------------------------------------------------

/** The example request body for a route, from its declared request fields. */
function exampleBody(route: ArchitectureRoute): Record<string, string> {
	const body: Record<string, string> = {};
	for (const f of route.request) body[f.name] = f.example;
	return body;
}

/** A second example body, so an update is a visibly different value from create. */
function updatedBody(route: ArchitectureRoute): Record<string, string> {
	const body: Record<string, string> = {};
	for (const f of route.request) body[f.name] = f.example + ' (changed)';
	return body;
}

/** The CRUD routes for one table, by op. */
interface TableRoutes {
	readonly table: string;
	readonly create: ArchitectureRoute | null;
	readonly read: ArchitectureRoute | null;
	readonly list: ArchitectureRoute | null;
	readonly update: ArchitectureRoute | null;
	readonly delete: ArchitectureRoute | null;
}

function routesForTable(block: ArchitectureBlock, table: string): TableRoutes {
	const of = (op: ArchitectureRoute['op']) => block.routes.find((r) => r.table === table && r.op === op) ?? null;
	return { table, create: of('create'), read: of('read'), list: of('list'), update: of('update'), delete: of('delete') };
}

/** A route's path with every :param replaced by a literal value (first match wins per name). */
const substPath = (path: string, params: Record<string, string>): string =>
	path.replace(/:([a-zA-Z]+)/g, (_m, name: string) => (name in params ? params[name]! : 'x'));

/** The subject the generated test drives: a table and its CRUD, with example bodies. */
interface SubjectMeta {
	readonly table: string;
	readonly idField: string;
	readonly createId: string | null;
	readonly createPath: string | null;
	readonly createMethod: string | null;
	readonly createBody: Record<string, string>;
	readonly readPath: string | null;
	readonly readMethod: string | null;
	readonly listPath: string | null;
	readonly listMethod: string | null;
	readonly updatePath: string | null;
	readonly updateMethod: string | null;
	readonly updateBody: Record<string, string>;
	readonly updateField: string | null;
	readonly deletePath: string | null;
	readonly deleteMethod: string | null;
	readonly response: string[];
}

function subjectFor(routes: TableRoutes): SubjectMeta {
	const idField = routes.create?.response.find((f) => f === 'id') ?? 'id';
	const updateField = routes.update?.request[0]?.name ?? null;
	return {
		table: routes.table,
		idField,
		createId: routes.create?.id ?? null,
		createPath: routes.create?.path ?? null,
		createMethod: routes.create?.method ?? null,
		createBody: routes.create ? exampleBody(routes.create) : {},
		readPath: routes.read?.path ?? null,
		readMethod: routes.read?.method ?? 'GET',
		listPath: routes.list?.path ?? null,
		listMethod: routes.list?.method ?? 'GET',
		updatePath: routes.update?.path ?? null,
		updateMethod: routes.update?.method ?? null,
		updateBody: routes.update ? updatedBody(routes.update) : {},
		updateField,
		deletePath: routes.delete?.path ?? null,
		deleteMethod: routes.delete?.method ?? null,
		response: routes.create?.response ?? routes.read?.response ?? [],
	};
}

/**
 * The generated contract test. It is ONE file, run four times with different
 * CADDIE_CONTRACT_PHASE values so the host can drive restarts across SEPARATE
 * processes (host-checks.ts). Each phase process opens the file database fresh,
 * so moving from one phase to the next is a real restart. The phases:
 *   create          A signs in; seeds teams (team mode); creates each record.
 *   read            restart; read by id and in the list; then update (step 3-4).
 *   privacy-screen  restart; the update survived; second-person and team/role
 *                   checks; the screen shows A's record and not B's; then delete.
 *   test-mode       restart; the delete survived (404 + gone); test-mode checks.
 * Data crosses phases through a handoff JSON file next to the database, so a
 * later process knows the ids and cookies the earlier one made.
 *
 * NO test is vacuous: a declared subject the test cannot exercise FAILS with a
 * plain sentence (never a skip or an early return), so a weak app cannot pass
 * by having nothing checked.
 */
function contractTestTs(block: ArchitectureBlock, features?: readonly string[]): string {
	// Plan part E checks "the routes of passed features plus the current one".
	// During a build the host passes those feature ids; the final check passes
	// none, so the whole design is driven. Only this TEST is scoped: the route
	// table in caddie/contract.ts stays whole, so every route is registered from
	// the first feature (an unbuilt one answers 501). In a scoped test a check
	// whose route is a later feature waits for it; a route that IS in scope but
	// cannot be exercised still fails with a plain sentence.
	const scoped = features !== undefined;
	const inScope = new Set(features ?? []);
	const view: ArchitectureBlock = scoped ? { ...block, routes: block.routes.filter((r) => inScope.has(r.feature)) } : block;

	// The person subject: the first person-owned table with a create route.
	const personTable = block.tables.find((t) => t.owner === 'person' && view.routes.some((r) => r.table === t.name && r.op === 'create'));
	const person = personTable ? subjectFor(routesForTable(view, personTable.name)) : null;

	// Team mode: the team registry table, a team-owned child table (its records
	// live under /api/teams/:teamId/…), the team create/list routes, and the
	// role and admin routes step 6 exercises.
	const teamTable = block.team?.table ?? null;
	const teamChildTable = block.tables.find(
		(t) => t.owner === 'team' && t.name !== teamTable && view.routes.some((r) => r.table === t.name && r.op === 'create'),
	);
	const team = teamChildTable ? subjectFor(routesForTable(view, teamChildTable.name)) : null;
	const teamCreate = teamTable ? view.routes.find((r) => r.table === teamTable && r.op === 'create') ?? null : null;
	const teamList = teamTable ? view.routes.find((r) => r.table === teamTable && r.op === 'list') ?? null : null;
	// The team checks start once a team can be started (its create route built).
	const hasTeam = block.team !== null && (!scoped || teamCreate !== null);
	// A team-role:<role> route (step 6: refuses C, allows A who holds creatorRole).
	const roleRoute = view.routes.find((r) => teamRoleOf(r.access as Access) !== null) ?? null;
	// An admin route (step 6: refuses B, allows the first account).
	const adminRoute = view.routes.find((r) => r.access === 'admin') ?? null;

	// Step 8: each screen that shows a table is checked against the record the
	// test saved for that table: the team subject's (opened as the current team)
	// or the person subject's. A screen of another table has no record to look
	// for, so it is not checked here — checking it against this record would
	// fail a correct app.
	const screenOnly = new Set(block.screenOnly);
	const tableScreens = block.screens
		.filter((s) => !screenOnly.has(s.id) && s.shows.length > 0)
		.flatMap((s) => {
			const kind =
				hasTeam && team && s.shows.includes(team.table) ? 'team' : person && s.shows.includes(person.table) ? 'person' : null;
			return kind ? [{ id: s.id, path: s.path, kind }] : [];
		});

	// Step 9: declared test-mode features. A declared feature with no generated
	// check makes the test-mode phase FAIL (see the phase below).
	const declaredFeatures = {
		payments: block.payments !== null,
		emails: block.emails.length > 0,
		jobs: block.jobs.length > 0,
		files: block.tables.some((t) => t.fields.some((f) => f.type === 'file')),
	};

	const meta = {
		scoped,
		hasTeam,
		creatorRole: block.team?.creatorRole ?? null,
		otherRole: block.team ? block.team.roles.find((r) => r !== block.team!.creatorRole) ?? block.team.roles[0]! : null,
		teamTable,
		person,
		team,
		teamCreate: teamCreate ? { path: teamCreate.path, method: teamCreate.method, body: exampleBody(teamCreate) } : null,
		teamList: teamList ? { path: teamList.path, method: teamList.method } : null,
		role: roleRoute ? { path: roleRoute.path, method: roleRoute.method, role: teamRoleOf(roleRoute.access as Access), body: exampleBody(roleRoute) } : null,
		admin: adminRoute ? { path: adminRoute.path, method: adminRoute.method, body: exampleBody(adminRoute) } : null,
		screens: tableScreens,
		features: declaredFeatures,
	};

	return [
		'// Caddie runtime file — do not edit. The generated contract test (plan part E,',
		'// steps 1-9). Run in phases by CADDIE_CONTRACT_PHASE; each phase is a SEPARATE',
		'// process on one file at CADDIE_TEST_DB_FILE, so moving between phases is a real',
		'// restart. Data crosses phases through HANDOFF (a JSON file beside the database).',
		'import { expect, test } from "bun:test";',
		'import { app } from "../src/server";',
		'import { signInForTest } from "../test/setup/auth";',
		'import { createFileEnv } from "../test/setup/d1-file";',
		'import { ROUTES, TEAM_TABLE } from "./contract";',
		'',
		'const PHASE = process.env.CADDIE_CONTRACT_PHASE ?? "create";',
		'const FILE = process.env.CADDIE_TEST_DB_FILE!;',
		'const META = ' + j(meta) + ' as const;',
		'const HANDOFF = FILE + ".handoff.json";',
		'/** The current-team key caddie/api.ts keeps (currentTeamId); step 8 sets it. */',
		'const TEAM_KEY = "caddie.teamId";',
		'',
		'function req(path: string, init: RequestInit, env: unknown) { return app.request(path, init, env as any); }',
		'const jsonHeaders = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", ...extra });',
		'type Row = Record<string, unknown>;',
		'async function readHandoff(): Promise<Row> { return (await Bun.file(HANDOFF).json()) as Row; }',
		'async function writeHandoff(next: Row) { await Bun.write(HANDOFF, JSON.stringify(next)); }',
		'/** Substitute :teamId then :id, then any other :param with a dummy. */',
		'function path(p: string, teamId?: unknown, id?: unknown): string {',
		'  let out = p;',
		'  if (teamId !== undefined) out = out.replace(/:teamId\\b/g, String(teamId));',
		'  if (id !== undefined) out = out.replace(/:id\\b/g, String(id));',
		'  return out.replace(/:[a-zA-Z]+/g, "x");',
		'}',
		'/** Insert a team_members row directly (step 6 seeds membership). */',
		'async function seedMember(env: any, teamId: unknown, personId: string, role: string) {',
		'  const now = new Date().toISOString();',
		'  await env.DB.prepare("insert or replace into team_members (teamId, personId, role, createdAt) values (?, ?, ?, ?)").bind(String(teamId), personId, role, now).run();',
		'}',
		'/** Make the first signed-in account an admin (step 6 admin route). */',
		'async function seedAdmin(env: any, personId: string) {',
		'  const now = new Date().toISOString();',
		'  await env.DB.prepare("insert or replace into caddie_admins (personId, createdAt) values (?, ?)").bind(personId, now).run();',
		'}',
		'',
		'// ==== phase: create (steps 1-3, 7) =======================================',
		'if (PHASE === "create") {',
		'  test("every route is registered through implement() (step 1)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    for (const route of ROUTES) {',
		'      const res = await req(route.path.replace(/:[a-zA-Z]+/g, "x"), { method: route.method }, env);',
		'      expect(res.status, `route ${route.id} (${route.method} ${route.path}) is not registered`).not.toBe(404);',
		'    }',
		'  });',
		'',
		'  test("guarded routes answer 401/403 without a session (step 2)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const guarded = ROUTES.filter((r) => r.access !== "public" && r.access !== "job");',
		'    for (const route of guarded) {',
		'      const res = await req(route.path.replace(/:[a-zA-Z]+/g, "x"), { method: route.method }, env);',
		'      expect([401, 403], `route ${route.id} should refuse an anonymous caller`).toContain(res.status);',
		'    }',
		'  });',
		'',
		'  test("A creates a record and the reply carries the declared fields (steps 3, 7)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const { headers, user } = await signInForTest(app, env, "ada@example.com");',
		'    const handoff: Row = { aCookie: headers.cookie, aId: user.id };',
		'',
		'    if (META.hasTeam) {',
		'      // Seed the first account as admin (step 6 admin route).',
		'      await seedAdmin(env, user.id);',
		'      // A owns team T1 with the creator role; T1 is the team registry row.',
		'      if (!META.teamCreate) throw new Error("A team app must let a signed-in person start a team, but no team-create route is declared.");',
		'      const created = await req(META.teamCreate.path.replace(/:[a-zA-Z]+/g, "x"), { method: META.teamCreate.method, headers: jsonHeaders(headers), body: JSON.stringify(META.teamCreate.body) }, env);',
		'      expect([200, 201], `starting team T1 failed: ${created.status} ${await created.clone().text()}`).toContain(created.status);',
		'      const t1 = (await created.json()) as Row;',
		'      const t1Id = t1["id"];',
		'      expect(t1Id, "the team-create reply has no id").toBeDefined();',
		'      await seedMember(env, t1Id, user.id, META.creatorRole!);',
		'      handoff.t1Id = t1Id;',
		'',
		'      if (!META.team || !META.team.createId) {',
		'        // Scoped: the team records are a later feature; the team itself is checked now.',
		'        if (!META.scoped) throw new Error("A team app must let a member add a record under its team, but no team-owned record route is declared.");',
		'      } else {',
		'        const res = await req(path(META.team.createPath!, t1Id), { method: META.team.createMethod!, headers: jsonHeaders(headers), body: JSON.stringify(META.team.createBody) }, env);',
		'        expect([200, 201], `A creating a team record failed: ${res.status} ${await res.clone().text()}`).toContain(res.status);',
		'        const row = (await res.json()) as Row;',
		'        for (const field of META.team.response) expect(field in row, `the reply is missing the declared field "${field}" (step 7)`).toBe(true);',
		'        handoff.teamRecordId = row[META.team.idField];',
		'      }',
		'    }',
		'',
		'    if (META.person && META.person.createId) {',
		'      const res = await req(META.person.createPath!, { method: META.person.createMethod!, headers: jsonHeaders(headers), body: JSON.stringify(META.person.createBody) }, env);',
		'      expect([200, 201], `A creating a record failed: ${res.status} ${await res.clone().text()}`).toContain(res.status);',
		'      const row = (await res.json()) as Row;',
		'      for (const field of META.person.response) expect(field in row, `the reply is missing the declared field "${field}" (step 7)`).toBe(true);',
		'      handoff.personRecordId = row[META.person.idField];',
		'    }',
		'',
		'    if (!META.scoped && !META.person?.createId && !META.hasTeam) throw new Error("No create route could be exercised, so nothing proves the app saves anything.");',
		'    await writeHandoff(handoff);',
		'  });',
		'}',
		'',
		'// ==== phase: read (steps 3-4: read after restart, then update) ===========',
		'if (PHASE === "read") {',
		'  test("after a restart, A reads the saved record by id and in the list (step 3)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const h = await readHandoff();',
		'    const headers = { cookie: String(h.aCookie) };',
		'',
		'    if (META.hasTeam && META.team && (META.team.readPath || !META.scoped)) {',
		'      if (!META.team.readPath) throw new Error("A team app must let a member read a saved record, but no team read route is declared.");',
		'      const byId = await req(path(META.team.readPath, h.t1Id, h.teamRecordId), { method: META.team.readMethod, headers }, env);',
		'      expect(byId.status, `reading A\'s team record after restart failed: ${byId.status}`).toBe(200);',
		'      if (META.team.listPath) {',
		'        const list = await req(path(META.team.listPath, h.t1Id), { method: META.team.listMethod, headers }, env);',
		'        expect(list.status).toBe(200);',
		'        const rows = (await list.json()) as Row[];',
		'        expect(rows.some((r) => String(r[META.team.idField]) === String(h.teamRecordId)), "A\'s team record is gone from the list after restart").toBe(true);',
		'      }',
		'    }',
		'',
		'    if (META.person && META.person.readPath) {',
		'      const byId = await req(path(META.person.readPath, undefined, h.personRecordId), { method: META.person.readMethod, headers }, env);',
		'      expect(byId.status, `reading A\'s record after restart failed: ${byId.status}`).toBe(200);',
		'      if (META.person.listPath) {',
		'        const list = await req(path(META.person.listPath), { method: META.person.listMethod, headers }, env);',
		'        expect(list.status).toBe(200);',
		'        const rows = (await list.json()) as Row[];',
		'        expect(rows.some((r) => String(r[META.person.idField]) === String(h.personRecordId)), "the saved record is gone from the list after restart").toBe(true);',
		'      }',
		'    }',
		'  });',
		'',
		'  test("A updates the record; the change is saved (step 4, update half)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const h = await readHandoff();',
		'    const headers = jsonHeaders({ cookie: String(h.aCookie) });',
		'    const subj = META.hasTeam && META.team ? META.team : META.person;',
		'    if (!subj) return; // nothing saved to change: no record route is built yet (scoped), or create already failed',
		'    if (!subj.updatePath && META.scoped) return; // the change route is a later feature',
		'    if (!subj.updatePath || !subj.updateField) throw new Error("The app declares no way to change a saved record, so a change cannot be proven to stick.");',
		'    const teamId = META.hasTeam && META.team ? h.t1Id : undefined;',
		'    const recId = META.hasTeam && META.team ? h.teamRecordId : h.personRecordId;',
		'    const res = await req(path(subj.updatePath, teamId, recId), { method: subj.updateMethod!, headers, body: JSON.stringify(subj.updateBody) }, env);',
		'    expect([200, 201, 204], `update failed: ${res.status} ${await res.clone().text()}`).toContain(res.status);',
		'    h.updatedField = subj.updateField;',
		'    h.updatedValue = subj.updateBody[subj.updateField];',
		'    await writeHandoff(h);',
		'  });',
		'}',
		'',
		'// ==== phase: privacy-screen (steps 4 read, 5-8) ==========================',
		'if (PHASE === "privacy-screen") {',
		'  test("after a restart, the update is still there (step 4, read half)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const h = await readHandoff();',
		'    if (!h.updatedField) return;',
		'    const headers = { cookie: String(h.aCookie) };',
		'    const subj = META.hasTeam && META.team ? META.team : META.person;',
		'    if (!subj || !subj.readPath) {',
		'      if (META.scoped) return; // the read route is a later feature',
		'      throw new Error("The app cannot read a record back, so a saved change cannot be checked.");',
		'    }',
		'    const teamId = META.hasTeam && META.team ? h.t1Id : undefined;',
		'    const recId = META.hasTeam && META.team ? h.teamRecordId : h.personRecordId;',
		'    const res = await req(path(subj.readPath, teamId, recId), { method: subj.readMethod, headers }, env);',
		'    expect(res.status, "the record is gone after the update and a restart").toBe(200);',
		'    const row = (await res.json()) as Row;',
		'    expect(String(row[String(h.updatedField)]), "the change was not saved: the record still shows the old value after a restart").toBe(String(h.updatedValue));',
		'  });',
		'',
		'  test("a second person B cannot read, change or delete A\'s record (step 5)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const h = await readHandoff();',
		'    const { headers: bHeaders } = await signInForTest(app, env, "bo@example.com");',
		'    const subj = META.hasTeam && META.team ? META.team : META.person;',
		'    if (!subj) return;',
		'    const teamId = META.hasTeam && META.team ? h.t1Id : undefined;',
		'    const recId = META.hasTeam && META.team ? h.teamRecordId : h.personRecordId;',
		'',
		'    if (subj.readPath) {',
		'      const read = await req(path(subj.readPath, teamId, recId), { method: subj.readMethod, headers: bHeaders }, env);',
		'      expect([403, 404], "B can read A\'s record — it is not owner/team-scoped").toContain(read.status);',
		'    }',
		'    if (subj.listPath) {',
		'      const list = await req(path(subj.listPath, teamId), { method: subj.listMethod, headers: bHeaders }, env);',
		'      // B listing under A\'s team is itself refused (outsider) or returns rows that exclude A\'s record.',
		'      if (list.status === 200) {',
		'        const rows = (await list.json()) as Row[];',
		'        expect(rows.some((r) => String(r[subj.idField]) === String(recId)), "A\'s record shows up in B\'s list — not scoped").toBe(false);',
		'      } else {',
		'        expect([403, 404]).toContain(list.status);',
		'      }',
		'    }',
		'    if (subj.updatePath && subj.updateField) {',
		'      const before = subj.readPath ? await (await req(path(subj.readPath, teamId, recId), { method: subj.readMethod, headers: { cookie: String(h.aCookie) } }, env)).json() as Row : null;',
		'      const upd = await req(path(subj.updatePath, teamId, recId), { method: subj.updateMethod!, headers: jsonHeaders(bHeaders), body: JSON.stringify(subj.updateBody) }, env);',
		'      // Refused outright (403/404), or a no-op — but A\'s record must be UNCHANGED.',
		'      if (subj.readPath && before) {',
		'        const after = await (await req(path(subj.readPath, teamId, recId), { method: subj.readMethod, headers: { cookie: String(h.aCookie) } }, env)).json() as Row;',
		'        expect(String(after[subj.updateField]), "B changed A\'s record — the write is not owner/team-scoped").toBe(String(before[subj.updateField]));',
		'      } else {',
		'        expect([403, 404], "B could change A\'s record").toContain(upd.status);',
		'      }',
		'    }',
		'    if (subj.deletePath) {',
		'      const del = await req(path(subj.deletePath, teamId, recId), { method: subj.deleteMethod!, headers: bHeaders }, env);',
		'      void del.status;',
		'      // Refused or a no-op — but A\'s record must still be there.',
		'      if (subj.readPath) {',
		'        const read = await req(path(subj.readPath, teamId, recId), { method: subj.readMethod, headers: { cookie: String(h.aCookie) } }, env);',
		'        expect(read.status, "B deleted A\'s record — the delete is not owner/team-scoped").toBe(200);',
		'      }',
		'    }',
		'  });',
		'',
		(meta.hasTeam
			? [
				'  test("teams and roles: member C reads, outsider B cannot; role and admin routes (step 6)", async () => {',
				'    const env = createFileEnv(FILE);',
				'    const h = await readHandoff();',
				'    // The record checks need a saved team record and its read route. In a scoped',
				'    // test they wait for that feature; the team list, role and admin checks run now.',
				'    const records = Boolean(META.team && META.team.readPath && h.teamRecordId !== undefined);',
				'    if (!records && !META.scoped) throw new Error("A team app must let a teammate read the team\'s records, but no team read route is declared.");',
				'    // C joins T1 with a non-creator role; B owns a separate team T2.',
				'    const { user: c, headers: cHeaders } = await signInForTest(app, env, "cas@example.com");',
				'    await seedMember(env, h.t1Id, c.id, META.otherRole!);',
				'    const { user: b, headers: bHeaders } = await signInForTest(app, env, "bo@example.com");',
				'    let t2Id: unknown = null;',
				'    if (META.teamCreate) {',
				'      const t2 = await req(META.teamCreate.path.replace(/:[a-zA-Z]+/g, "x"), { method: META.teamCreate.method, headers: jsonHeaders(bHeaders), body: JSON.stringify(META.teamCreate.body) }, env);',
				'      expect([200, 201]).toContain(t2.status);',
				'      t2Id = ((await t2.json()) as Row)["id"];',
				'      await seedMember(env, t2Id, b.id, META.creatorRole!);',
				'      // Step 8 opens B\'s screens with B\'s own team T2 as the current team.',
				'      await writeHandoff({ ...h, t2Id });',
				'    }',
				'',
				'    if (records) {',
				'    // C can read and list T1\'s records.',
				'    const cRead = await req(path(META.team.readPath, h.t1Id, h.teamRecordId), { method: META.team.readMethod, headers: cHeaders }, env);',
				'    expect(cRead.status, "a teammate C cannot read the team\'s record").toBe(200);',
				'    if (META.team.listPath) {',
				'      const cList = await req(path(META.team.listPath, h.t1Id), { method: META.team.listMethod, headers: cHeaders }, env);',
				'      expect(cList.status).toBe(200);',
				'      const rows = (await cList.json()) as Row[];',
				'      expect(rows.some((r) => String(r[META.team.idField]) === String(h.teamRecordId)), "the team\'s record is not in teammate C\'s list").toBe(true);',
				'    }',
				'',
				'    // B (outsider to T1) can read, change or delete nothing of T1\'s, and T1 is not in B\'s lists.',
				'    const bRead = await req(path(META.team.readPath, h.t1Id, h.teamRecordId), { method: META.team.readMethod, headers: bHeaders }, env);',
				'    expect([403, 404], "outsider B can read T1\'s record").toContain(bRead.status);',
				'    if (META.team.updatePath && META.team.updateField) {',
				'      const bUpd = await req(path(META.team.updatePath, h.t1Id, h.teamRecordId), { method: META.team.updateMethod!, headers: jsonHeaders(bHeaders), body: JSON.stringify(META.team.updateBody) }, env);',
				'      expect([403, 404], "outsider B can change T1\'s record").toContain(bUpd.status);',
				'    }',
				'    if (META.team.deletePath) {',
				'      const bDel = await req(path(META.team.deletePath, h.t1Id, h.teamRecordId), { method: META.team.deleteMethod!, headers: bHeaders }, env);',
				'      expect([403, 404], "outsider B can delete T1\'s record").toContain(bDel.status);',
				'    }',
				'    // The real team-filter check: B is a MEMBER of T2, so the guard lets B call',
				'    // T2\'s routes. A handler that does not filter by teamId would leak A\'s T1',
				'    // record here. B must never see or change A\'s record through B\'s own team.',
				'    if (t2Id !== null) {',
				'      if (META.team.listPath) {',
				'        const bOwnList = await req(path(META.team.listPath, t2Id), { method: META.team.listMethod, headers: bHeaders }, env);',
				'        expect(bOwnList.status).toBe(200);',
				'        const rows = (await bOwnList.json()) as Row[];',
				'        expect(rows.some((r) => String(r[META.team.idField]) === String(h.teamRecordId)), "A\'s record leaks into B\'s own-team list — the route does not filter by team").toBe(false);',
				'      }',
				'      const bReadOwn = await req(path(META.team.readPath, t2Id, h.teamRecordId), { method: META.team.readMethod, headers: bHeaders }, env);',
				'      expect([403, 404], "B reads A\'s record through B\'s own team — the route does not filter by team").toContain(bReadOwn.status);',
				'      if (META.team.updatePath && META.team.updateField) {',
				'        const before = await (await req(path(META.team.readPath, h.t1Id, h.teamRecordId), { method: META.team.readMethod, headers: { cookie: String(h.aCookie) } }, env)).json() as Row;',
				'        await req(path(META.team.updatePath, t2Id, h.teamRecordId), { method: META.team.updateMethod!, headers: jsonHeaders(bHeaders), body: JSON.stringify(META.team.updateBody) }, env);',
				'        const after = await (await req(path(META.team.readPath, h.t1Id, h.teamRecordId), { method: META.team.readMethod, headers: { cookie: String(h.aCookie) } }, env)).json() as Row;',
				'        expect(String(after[META.team.updateField]), "B changed A\'s record through B\'s own team — the route does not filter by team").toBe(String(before[META.team.updateField]));',
				'      }',
				'      if (META.team.deletePath) {',
				'        await req(path(META.team.deletePath, t2Id, h.teamRecordId), { method: META.team.deleteMethod!, headers: bHeaders }, env);',
				'        const still = await req(path(META.team.readPath, h.t1Id, h.teamRecordId), { method: META.team.readMethod, headers: { cookie: String(h.aCookie) } }, env);',
				'        expect(still.status, "B deleted A\'s record through B\'s own team — the route does not filter by team").toBe(200);',
				'      }',
				'    }',
				'    }',
				'    if (META.teamList && t2Id !== null) {',
				'      const bList = await req(META.teamList.path.replace(/:[a-zA-Z]+/g, "x"), { method: META.teamList.method, headers: bHeaders }, env);',
				'      expect(bList.status).toBe(200);',
				'      const rows = (await bList.json()) as Row[];',
				'      const ids = rows.map((r) => String(r["id"]));',
				'      expect(ids.includes(String(t2Id)), "B\'s own team T2 is missing from B\'s team list").toBe(true);',
				'      expect(ids.includes(String(h.t1Id)), "A\'s team T1 shows up in B\'s team list").toBe(false);',
				'    }',
				'',
				'    // The team-role route refuses C (lacks the role) and allows A (holds it).',
				'    if (META.role) {',
				'      const { headers: aHeaders } = await signInForTest(app, env, "ada@example.com");',
				'      const cTry = await req(path(META.role.path, h.t1Id, h.teamRecordId), { method: META.role.method, headers: jsonHeaders(cHeaders), body: JSON.stringify(META.role.body) }, env);',
				'      expect([403], `the ${META.role.role} route let a member without that role through`).toContain(cTry.status);',
				'      const aTry = await req(path(META.role.path, h.t1Id, h.teamRecordId), { method: META.role.method, headers: jsonHeaders(aHeaders), body: JSON.stringify(META.role.body) }, env);',
				'      expect(aTry.status, `the ${META.role.role} route refused A who holds that role`).not.toBe(403);',
				'    }',
				'',
				'    // The admin route refuses B and allows the first account (A, seeded admin in create).',
				'    if (META.admin) {',
				'      const { headers: aHeaders } = await signInForTest(app, env, "ada@example.com");',
				'      const bAdmin = await req(path(META.admin.path, h.t1Id), { method: META.admin.method, headers: jsonHeaders(bHeaders), body: JSON.stringify(META.admin.body) }, env);',
				'      expect([403], "the admin route let a non-admin through").toContain(bAdmin.status);',
				'      const aAdmin = await req(path(META.admin.path, h.t1Id), { method: META.admin.method, headers: jsonHeaders(aHeaders), body: JSON.stringify(META.admin.body) }, env);',
				'      expect(aAdmin.status, "the admin route refused the app\'s first account").not.toBe(403);',
				'    }',
				'  });',
			].join('\n')
			: '  // (no team declared: step 6 does not apply)'),
		'',
		(meta.screens.length > 0
			? [
				'  test("each table screen shows A\'s saved record and not B\'s (step 8)", async () => {',
				'    if (typeof document === "undefined") throw new Error("This app\'s screens could not be opened for the check: the starter\'s browser-page test setup (happy-dom, in bunfig.toml and test/setup/) is missing. Put it back as the starter had it.");',
				'    const env = createFileEnv(FILE);',
				'    const h = await readHandoff();',
				'    // Route the screen\'s fetch at the real server, as the chosen person.',
				'    let activeCookie = String(h.aCookie);',
				'    const realFetch = globalThis.fetch;',
				'    (globalThis as any).fetch = async (input: any, init: any = {}) => {',
				'      const url = typeof input === "string" ? input : input.url;',
				'      const p = url.replace(/^https?:\\/\\/[^/]+/, "");',
				'      const headers = { ...(init.headers || {}), cookie: activeCookie };',
				'      return req(p, { ...init, headers }, env);',
				'    };',
				'    try {',
				'      const React = await import("react");',
				'      const { render, cleanup, waitFor } = await import("@testing-library/react");',
				'      let entry: any;',
				'      try { entry = await import("../src/App"); } catch { entry = null; }',
				'      const App = entry && (entry.App || entry.default);',
				'      if (!App) throw new Error("This app\'s screen could not be rendered to check it shows saved data (no src/App export).");',
				'      /** A\'s saved value to look for: the longest text A typed into the record, read live (it may have changed). */',
				'      const needleFor = async (kind: "team" | "person"): Promise<string> => {',
				'        const subj = kind === "team" ? META.team : META.person;',
				'        if (!subj) return "";',
				'        const recId = kind === "team" ? h.teamRecordId : h.personRecordId;',
				'        const teamId = kind === "team" ? h.t1Id : undefined;',
				'        const aHeaders = { cookie: String(h.aCookie) };',
				'        let row: Row | null = null;',
				'        if (subj.readPath) {',
				'          const r = await req(path(subj.readPath, teamId, recId), { method: subj.readMethod, headers: aHeaders }, env);',
				'          if (r.status === 200) row = (await r.json()) as Row;',
				'        }',
				'        if (!row && subj.listPath) {',
				'          const r = await req(path(subj.listPath, teamId), { method: subj.listMethod, headers: aHeaders }, env);',
				'          if (r.status === 200) row = ((await r.json()) as Row[]).find((x) => String(x[subj.idField]) === String(recId)) ?? null;',
				'        }',
				'        if (!row) return "";',
				'        const found = row;',
				'        const typed = Object.keys(subj.createBody).map((k) => found[k]).filter((v): v is string => typeof v === "string" && v.length > 0);',
				'        const pool = typed.length > 0 ? typed : Object.entries(found).filter(([k, v]) => k !== subj.idField && !/(Id|At)$/.test(k) && typeof v === "string" && v.length > 0).map(([, v]) => String(v));',
				'        return [...pool].sort((x, y) => y.length - x.length)[0] ?? "";',
				'      };',
				'      for (const sc of META.screens) {',
				'        const needle = await needleFor(sc.kind);',
				'        if (!needle) throw new Error(`The ${sc.id} screen cannot be checked: no saved value was found to look for.`);',
				'        // Render for A, with A\'s team T1 as the current team: the record must appear.',
				'        activeCookie = String(h.aCookie);',
				'        if (sc.kind === "team") localStorage.setItem(TEAM_KEY, String(h.t1Id));',
				'        else localStorage.removeItem(TEAM_KEY);',
				'        location.hash = sc.kind === "team" ? sc.path.replace(/:teamId\\b/g, String(h.t1Id)) : sc.path;',
				'        render(React.createElement(App));',
				'        await waitFor(() => expect(document.body.textContent || "").toContain(needle), { timeout: 4000 }).catch(() => {',
				'          throw new Error(',
				'            sc.kind === "team"',
				'              ? `The ${sc.id} screen does not show the team\'s saved record. A team screen shows the records of the team in currentTeamId() from caddie/api.ts (the person\'s first team when none is set), read from the server.`',
				'              : `The ${sc.id} screen does not show a record the server saved (it may read the browser instead of the server).`,',
				'          );',
				'        });',
				'        cleanup();',
				'        // Render for B, with B\'s own team current: the record must NOT appear.',
				'        activeCookie = String((await signInForTest(app, createFileEnv(FILE), "bo@example.com")).cookie);',
				'        const bTeam = h.t2Id !== undefined && h.t2Id !== null ? String(h.t2Id) : null;',
				'        if (sc.kind === "team" && bTeam) localStorage.setItem(TEAM_KEY, bTeam);',
				'        else localStorage.removeItem(TEAM_KEY);',
				'        location.hash = sc.kind === "team" && bTeam ? sc.path.replace(/:teamId\\b/g, bTeam) : sc.path;',
				'        render(React.createElement(App));',
				'        await new Promise((r) => setTimeout(r, 500));',
				'        expect(document.body.textContent || "", `the ${sc.id} screen shows another person\'s record to B`).not.toContain(needle);',
				'        cleanup();',
				'      }',
				'    } finally {',
				'      (globalThis as any).fetch = realFetch;',
				'      localStorage.removeItem(TEAM_KEY);',
				'    }',
				'  });',
			].join('\n')
			: '  // (no table-backed screen declared: step 8 does not apply)'),
		'',
		'  test("A deletes the record (step 4, delete half — the read is checked in test-mode)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const h = await readHandoff();',
		'    const headers = { cookie: String(h.aCookie) };',
		'    const subj = META.hasTeam && META.team ? META.team : META.person;',
		'    if (!subj || !subj.deletePath) { h.skipDelete = true; await writeHandoff(h); return; }',
		'    const teamId = META.hasTeam && META.team ? h.t1Id : undefined;',
		'    const recId = META.hasTeam && META.team ? h.teamRecordId : h.personRecordId;',
		'    const res = await req(path(subj.deletePath, teamId, recId), { method: subj.deleteMethod!, headers }, env);',
		'    expect([200, 204], `delete failed: ${res.status}`).toContain(res.status);',
		'    h.deletedId = recId;',
		'    await writeHandoff(h);',
		'  });',
		'}',
		'',
		'// ==== phase: test-mode (step 4 delete-read, step 9) ======================',
		'if (PHASE === "test-mode") {',
		'  test("after a restart, the deleted record is gone (404 and not in the list) (step 4, delete read)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const h = await readHandoff().catch(() => null);',
		'    if (!h || h.skipDelete) return; // no delete route — already reported in privacy-screen',
		'    const headers = { cookie: String(h.aCookie) };',
		'    const subj = META.hasTeam && META.team ? META.team : META.person;',
		'    if (!subj || !subj.readPath) {',
		'      if (META.scoped) return; // the read route is a later feature',
		'      throw new Error("The app cannot read a record back, so a delete cannot be checked.");',
		'    }',
		'    const teamId = META.hasTeam && META.team ? h.t1Id : undefined;',
		'    const read = await req(path(subj.readPath, teamId, h.deletedId), { method: subj.readMethod, headers }, env);',
		'    expect(read.status, "a deleted record is still readable after a restart").toBe(404);',
		'    if (subj.listPath) {',
		'      const list = await req(path(subj.listPath, teamId), { method: subj.listMethod, headers }, env);',
		'      if (list.status === 200) {',
		'        const rows = (await list.json()) as Row[];',
		'        expect(rows.some((r) => String(r[subj.idField]) === String(h.deletedId)), "a deleted record is still in the list after a restart").toBe(false);',
		'      }',
		'    }',
		'  });',
		'',
		'  test("declared test-mode features (payments/emails/jobs/files) have a check (step 9)", () => {',
		'    // Lanes 9/10 extend this phase with the real payment/email/job/file checks.',
		'    // Until then, a block that DECLARES such a feature must not pass silently:',
		'    // a declared feature with no generated check fails here, in plain words.',
		'    const missing: string[] = [];',
		'    if (META.features.payments) missing.push("payments (a locked route should answer 402 before checkout)");',
		'    if (META.features.emails) missing.push("emails (a message should land in the test inbox and nothing real is sent)");',
		'    if (META.features.jobs) missing.push("scheduled jobs (a job route should need Caddie\'s signature)");',
		'    if (META.features.files) missing.push("file uploads (a file should come back byte-identical after a restart)");',
		'    expect(missing.length === 0, missing.length === 0 ? "" : `This app declares ${missing.join(", ")}, but those are not checked yet. They must be checked before the app can pass.`).toBe(true);',
		'  });',
		'}',
		'',
	].join('\n');
}

// --------------------------------------------------------------------------
// the generator
// --------------------------------------------------------------------------

/**
 * Generate the protected contract files for an app, from its approved
 * architecture block. Deterministic (declaration order throughout), so part E's
 * generation is snapshot-testable. `kind === 'big'` adds caddie/modules.ts.
 */
export function generateContractFiles(
	block: ArchitectureBlock,
	options: { kind: ContractKind; features?: readonly string[] },
): GeneratedContractFiles {
	const files: Record<string, string> = {
		'caddie/contract.ts': contractTs(block),
		'caddie/api.ts': apiTs(),
		'caddie/router.tsx': routerTsx(block),
		'caddie/contract.test.ts': contractTestTs(block, options.features),
		'test/setup/d1-file.ts': D1_FILE,
	};
	if (options.kind === 'big') files['caddie/modules.ts'] = modulesTs(block);
	return { files };
}

/**
 * The static check part E requires: a screen must reach the server only through
 * caddie/api.ts. Given a map of screen source files, returns the plain problems
 * (a screen that calls fetch() directly or reads localStorage for data).
 * host-checks.ts runs this over the app's screen files before a check run.
 */
export function checkScreensUseApi(screenSources: Readonly<Record<string, string>>): string[] {
	const problems: string[] = [];
	for (const [path, source] of Object.entries(screenSources)) {
		const stripped = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
		if (/\bfetch\s*\(/.test(stripped)) {
			problems.push(`${path} calls fetch() directly. A screen must reach the server through caddie/api.ts, so the data is real and private.`);
		}
		if (/\blocalStorage\b/.test(stripped) || /\bsessionStorage\b/.test(stripped)) {
			problems.push(`${path} reads browser storage. A screen must show what the server saved (through caddie/api.ts), not data kept only in the browser.`);
		}
	}
	return problems;
}
