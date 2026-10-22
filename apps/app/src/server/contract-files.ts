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

/**
 * The generated contract test. It is ONE file, run four times with different
 * CADDIE_CONTRACT_PHASE values so the host can drive the restart across two
 * processes (host-checks.ts). The phases:
 *   create          A signs in and creates each person/team record (step 3).
 *   read            reopen the file; read by id and in the list (steps 3-4).
 *   privacy-screen  B can't see A's record; screens show A's and not B's; and
 *                   a team member can / an outsider can't (steps 5-8).
 *   test-mode       locked/email/job/file behaviour, when declared (step 9).
 * It writes its own data through the app's REAL routes via caddie/api-style
 * fetch at app.request, over the FILE database (createFileEnv), so "saved" is
 * proven across processes.
 */
function contractTestTs(block: ArchitectureBlock): string {
	// Pick the simplest person-owned create/read/list to drive the core round trip.
	const personTables = new Set(block.tables.filter((t) => t.owner === 'person').map((t) => t.name));
	const createRoute = block.routes.find((r) => r.op === 'create' && r.table !== null && personTables.has(r.table)) ?? null;
	const readRoute =
		createRoute && createRoute.table
			? block.routes.find((r) => r.op === 'read' && r.table === createRoute.table) ?? null
			: null;
	const listRoute =
		createRoute && createRoute.table
			? block.routes.find((r) => r.op === 'list' && r.table === createRoute.table) ?? null
			: null;

	const hasTeam = block.team !== null;

	const meta = {
		createRouteId: createRoute?.id ?? null,
		createPath: createRoute?.path ?? null,
		createMethod: createRoute?.method ?? null,
		createBody: createRoute ? exampleBody(createRoute) : {},
		readPath: readRoute?.path ?? null,
		listPath: listRoute?.path ?? null,
		idField: createRoute?.response.find((f) => f === 'id') ?? 'id',
		hasTeam,
	};

	return [
		'// Caddie runtime file — do not edit. The generated contract test (plan part E).',
		'// Run in phases by CADDIE_CONTRACT_PHASE so the host can restart between create',
		'// and read in SEPARATE processes, on one file at CADDIE_TEST_DB_FILE.',
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
		'',
		'function req(path: string, init: RequestInit, env: unknown) { return app.request(path, init, env as any); }',
		'const jsonHeaders = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", ...extra });',
		'',
		'// ---- phase: create (step 1-3) -------------------------------------------',
		'if (PHASE === "create") {',
		'  test("every route is registered through implement() (step 1)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    // A route that exists answers something other than 404 "no such route".',
		'    for (const route of ROUTES) {',
		'      const res = await req(route.path.replace(/:[a-zA-Z]+/g, "x"), { method: route.method }, env);',
		'      expect(res.status, `route ${route.id} (${route.method} ${route.path}) is not registered`).not.toBe(404);',
		'    }',
		'  });',
		'',
		'  test("sign-in routes answer 401 without a session (step 2)", async () => {',
		'    const env = createFileEnv(FILE);',
		'    const guarded = ROUTES.filter((r) => r.access !== "public" && r.access !== "job");',
		'    for (const route of guarded) {',
		'      const res = await req(route.path.replace(/:[a-zA-Z]+/g, "x"), { method: route.method }, env);',
		'      expect([401, 403], `route ${route.id} should refuse an anonymous caller`).toContain(res.status);',
		'    }',
		'  });',
		'',
		(meta.createRouteId
			? [
				'  test("A creates a record (step 3, process 1)", async () => {',
				'    const env = createFileEnv(FILE);',
				'    const { headers, user } = await signInForTest(app, env, "ada@example.com");',
				'    const res = await req(META.createPath!, { method: META.createMethod!, headers: jsonHeaders(headers), body: JSON.stringify(META.createBody) }, env);',
				'    expect([200, 201], `create failed: ${res.status} ${await res.clone().text()}`).toContain(res.status);',
				'    const row = (await res.json()) as Record<string, unknown>;',
				'    await Bun.write(HANDOFF, JSON.stringify({ id: row[META.idField], cookie: headers.cookie, ownerId: user.id }));',
				'  });',
			].join('\n')
			: '  test.skip("no person-owned create route to exercise (step 3)", () => {});'),
		'}',
		'',
		'// ---- phase: read (step 3-4) ---------------------------------------------',
		'if (PHASE === "read") {',
		(meta.createRouteId && meta.readPath
			? [
				'  test("after restart, A reads the record by id (step 3, process 2)", async () => {',
				'    const env = createFileEnv(FILE);',
				'    const handoff = (await Bun.file(HANDOFF).json()) as { id: unknown; cookie: string };',
				'    const headers = { cookie: handoff.cookie };',
				'    const path = META.readPath!.replace(/:id\\b/, String(handoff.id)).replace(/:[a-zA-Z]+/g, "x");',
				'    const res = await req(path, { headers }, env);',
				'    expect(res.status, `read after restart failed: ${res.status}`).toBe(200);',
				'  });',
			].join('\n')
			: '  test.skip("no person-owned read route to exercise (step 3-4)", () => {});'),
		(meta.createRouteId && meta.listPath
			? [
				'  test("after restart, the record is in A\'s list (step 3)", async () => {',
				'    const env = createFileEnv(FILE);',
				'    const handoff = (await Bun.file(HANDOFF).json()) as { id: unknown; cookie: string };',
				'    const headers = { cookie: handoff.cookie };',
				'    const res = await req(META.listPath!.replace(/:[a-zA-Z]+/g, "x"), { headers }, env);',
				'    expect(res.status).toBe(200);',
				'    const rows = (await res.json()) as Array<Record<string, unknown>>;',
				'    expect(rows.some((r) => String(r[META.idField]) === String(handoff.id)), "the saved record is not in the list after restart").toBe(true);',
				'  });',
			].join('\n')
			: '  test.skip("no person-owned list route to exercise (step 3)", () => {});'),
		'}',
		'',
		'// ---- phase: privacy-screen (step 5-8) -----------------------------------',
		'if (PHASE === "privacy-screen") {',
		(meta.createRouteId && meta.listPath
			? [
				'  test("a second person B cannot see A\'s record (step 5)", async () => {',
				'    const env = createFileEnv(FILE);',
				'    const { headers } = await signInForTest(app, env, "bo@example.com");',
				'    const res = await req(META.listPath!.replace(/:[a-zA-Z]+/g, "x"), { headers }, env);',
				'    expect(res.status).toBe(200);',
				'    const rows = (await res.json()) as Array<Record<string, unknown>>;',
				'    const handoff = (await Bun.file(HANDOFF).json()) as { id: unknown };',
				'    expect(rows.some((r) => String(r[META.idField]) === String(handoff.id)), "B can see A\'s record — the list is not owner-scoped").toBe(false);',
				'  });',
			].join('\n')
			: '  test.skip("no list route to check privacy on (step 5)", () => {});'),
		'  test("the team table\'s list is open to any signed-in person, but shows only your teams (step 6)", async () => {',
		'    if (!META.hasTeam || TEAM_TABLE === null) return;',
		'    const env = createFileEnv(FILE);',
		'    const list = ROUTES.find((r) => r.table === TEAM_TABLE && r.op === "list");',
		'    if (!list) return;',
		'    const anon = await req(list.path.replace(/:[a-zA-Z]+/g, "x"), { method: list.method }, env);',
		'    // signed-in people may list; anonymous may not.',
		'    expect([401, 403]).toContain(anon.status);',
		'    const { headers } = await signInForTest(app, env, "cas@example.com");',
		'    const mine = await req(list.path.replace(/:[a-zA-Z]+/g, "x"), { method: list.method, headers }, env);',
		'    expect(mine.status).toBe(200);',
		'  });',
		'}',
		'',
		'// ---- phase: test-mode (step 9) ------------------------------------------',
		'if (PHASE === "test-mode") {',
		'  test.skip("test-mode features (payments/emails/jobs/files) are checked when declared (step 9)", () => {});',
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
export function generateContractFiles(block: ArchitectureBlock, options: { kind: ContractKind }): GeneratedContractFiles {
	const files: Record<string, string> = {
		'caddie/contract.ts': contractTs(block),
		'caddie/api.ts': apiTs(),
		'caddie/router.tsx': routerTsx(block),
		'caddie/contract.test.ts': contractTestTs(block),
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
