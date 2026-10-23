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
	type ArchitectureTable,
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

/** route id -> the plan ids that unlock it (plan part J), from the approved block. */
function lockedRoutes(block: ArchitectureBlock): Record<string, string[]> {
	return Object.fromEntries((block.payments?.locked ?? []).map((l) => [l.route, [...l.plans]]));
}

/**
 * What caddie/contract.ts tells the builder about the declared test-mode
 * features (plan parts J, K, L, N) — the generated contract test checks exactly
 * this. Comment lines only; empty when the block declares none.
 */
function testModeGuide(block: ArchitectureBlock): string[] {
	const lines: string[] = [];
	if (block.payments) {
		lines.push(
			'//',
			"// Payments (test mode, no money moves): mount Caddie's billing routes once with",
			'// mountPayments(app, { currency, plans }) from ./payments. A route in LOCKED',
			'// answers 402 { "reason": "plan_required" } until the person has an active',
			'// plan; this file does that check, so never add your own.',
		);
	}
	for (const email of block.emails) {
		const to = email.to === 'person' ? 'the signed-in person' : `the address in the request's ${email.to.slice('request-field:'.length)} field`;
		lines.push(
			'//',
			`// Email "${email.id}": the route ${email.route} sends it once per call with`,
			`// env.CADDIE.email({ to, subject, text, template: "${email.id}" }), to ${to}.`,
			'// It lands in the test inbox; send nothing any other way.',
		);
	}
	for (const job of block.jobs) {
		lines.push(
			'//',
			`// Job "${job.id}": the route ${job.route} runs only from Caddie's signed Run-now`,
			"// call (this file refuses anyone else). Do the job's work and answer 2xx.",
		);
	}
	if (block.tables.some((t) => t.fields.some((f) => f.type === 'file'))) {
		lines.push('//', "// Files: mount Caddie's upload routes once with mountFiles(app) from ./files;", '// a file field stores the file id.');
	}
	return lines;
}

function contractTs(block: ArchitectureBlock): string {
	const teamTable = block.team?.table ?? null;
	return [
		'// Caddie runtime file — do not edit. The app\'s contract (plan part E): the',
		'// declared routes, and implement(app, handlers) which checks WHO may call each',
		'// route BEFORE the builder\'s handler runs — 401 without a session or a valid',
		'// job signature, 403 for the wrong team, role or admin. A builder cannot forget',
		'// the access check: it is mounted here, from the approved design.',
		...testModeGuide(block),
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
		'/**',
		' * Verify Caddie\'s Run-now signature. The header is "<unix-ms>.<hex>"; the',
		' * signature is an HMAC-SHA256 over "<unix-ms>.<route path>" with CADDIE_JOB_SECRET.',
		' * The secret is keyed per project and mode by Caddie, so project and mode are',
		' * bound by the key; the route path binds WHICH job may run (one job, one route);',
		' * the timestamp must be inside 5 minutes. All three — project+mode, job, time —',
		' * are covered, exactly as the plan (part N) requires.',
		' */',
		'async function validJobSignature(c: Context, routePath: string): Promise<boolean> {',
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
		'  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stamp + "." + routePath));',
		'  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");',
		'  // Constant-time-ish compare.',
		'  if (hex.length !== sig.length) return false;',
		'  let diff = 0;',
		'  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);',
		'  return diff === 0;',
		'}',
		'',
		'/** Routes a plan unlocks (plan part J): route id -> the plan ids that open it. */',
		'export const LOCKED: Record<string, string[]> = ' + j(lockedRoutes(block)) + ';',
		'',
		'/**',
		' * Whether the person has an active plan in planIds right now. The subscriptions',
		' * live in caddie_subscriptions (caddie/payments.ts writes them); an ended plan,',
		' * or a cancelled one past its renewal date, does not count.',
		' */',
		'async function hasActivePlan(c: Context, personId: string, planIds: string[]): Promise<boolean> {',
		'  const row = await c.env.DB.prepare("select planId, status, renewsAt from caddie_subscriptions where personId = ?")',
		'    .bind(personId)',
		'    .first<{ planId: string; status: string; renewsAt: string | null }>();',
		'  if (!row || !planIds.includes(row.planId) || row.status === "ended") return false;',
		'  return !(row.renewsAt && new Date(row.renewsAt).getTime() <= Date.now());',
		'}',
		'',
		'/** Why this caller may NOT use the route: a Response to refuse, or null to let it through. */',
		'async function refusal(route: ContractRoute, c: Context): Promise<Response | null> {',
		'  const access = route.access;',
		'  if (access === "public") return null;',
		'  if (access === "job") {',
		'    return (await validJobSignature(c, route.path)) ? null : unauthorized("This can only run from Caddie\'s scheduled run.");',
		'  }',
		'  // Every other access needs a signed-in person.',
		'  const user = await currentUser(c);',
		'  if (!user) return unauthorized("Sign in first.");',
		'  if (access === "signed-in" || access === "person") return null;',
		'  if (access === "admin") return (await isAdmin(c, user.id)) ? null : forbidden("Only an admin can do this.");',
		'  if (access === "team" || route.role !== null) {',
		'    const teamId = c.req.param("teamId");',
		'    if (!teamId) return forbidden("This needs a team.");',
		'    const { inTeam, role } = await isTeamMember(c, teamId, user.id);',
		'    if (!inTeam) return forbidden("You are not a member of this team.");',
		'    if (route.role !== null && role !== route.role) return forbidden("You do not have the right role for this.");',
		'  }',
		'  return null;',
		'}',
		'',
		'/** The access guard for one route: who may call it, then (a locked route) whether they have a plan. */',
		'function guardFor(route: ContractRoute): MiddlewareHandler {',
		'  return async (c, next) => {',
		'    const refused = await refusal(route, c);',
		'    if (refused) return refused;',
		'    // A locked route (plan part J) answers 402 until the person has a plan, so a',
		'    // builder can\'t leave one open.',
		'    const plans = LOCKED[route.id];',
		'    if (plans) {',
		'      const user = await currentUser(c);',
		'      if (!user) return unauthorized("Sign in first.");',
		'      if (!(await hasActivePlan(c, user.id, plans))) {',
		'        return new Response(JSON.stringify({ reason: "plan_required" }), { status: 402, headers: { "content-type": "application/json" } });',
		'      }',
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

/** The field a change is made to: the first text field that isn't a pointer to another record, else the first field. */
function changeField(route: ArchitectureRoute, table: ArchitectureTable): string | null {
	const pointers = new Set(table.fields.filter((f) => f.references).map((f) => f.name));
	const text = route.request.find((f) => f.type === 'text' && !pointers.has(f.name));
	return (text ?? route.request[0])?.name ?? null;
}

/** A visibly different value that is still valid for the field's type. */
function changedValue(field: ArchitectureRoute['request'][number]): string {
	switch (field.type) {
		case 'integer': {
			const n = Number.parseInt(field.example, 10);
			return String(Number.isFinite(n) ? n + 1 : 2);
		}
		case 'real': {
			const n = Number.parseFloat(field.example);
			return String(Number.isFinite(n) ? n + 1.5 : 2.5);
		}
		case 'boolean':
			return /^(true|1|yes)$/i.test(field.example.trim()) ? 'false' : 'true';
		case 'datetime': {
			const ms = Date.parse(field.example);
			return new Date((Number.isFinite(ms) ? ms : Date.UTC(2026, 0, 1)) + 86_400_000).toISOString();
		}
		default:
			return field.example + ' (changed)';
	}
}

/** The update body: every declared field at its example, with ONE field changed, so the change can be seen. */
function updatedBody(route: ArchitectureRoute, field: string | null): Record<string, string> {
	const body = exampleBody(route);
	const target = route.request.find((f) => f.name === field);
	if (target) body[target.name] = changedValue(target);
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

/** A table the generated test drives: its CRUD, with example bodies. */
interface SubjectMeta {
	readonly table: string;
	/** person: owned by one person; team: a record of a team (under /api/teams/:teamId/…). */
	readonly kind: 'person' | 'team';
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
	/** Request fields that point at another table's record; the test fills them with the id it saved there. */
	readonly refs: ReadonlyArray<{ readonly field: string; readonly table: string }>;
}

function subjectFor(routes: TableRoutes, table: ArchitectureTable, kind: 'person' | 'team'): SubjectMeta {
	const idField = routes.create?.response.find((f) => f === 'id') ?? 'id';
	const updateField = routes.update ? changeField(routes.update, table) : null;
	const asked = new Set([...(routes.create?.request ?? []), ...(routes.update?.request ?? [])].map((f) => f.name));
	return {
		table: routes.table,
		kind,
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
		updateBody: routes.update ? updatedBody(routes.update, updateField) : {},
		updateField,
		deletePath: routes.delete?.path ?? null,
		deleteMethod: routes.delete?.method ?? null,
		response: routes.create?.response ?? routes.read?.response ?? [],
		refs: table.fields.filter((f) => f.references && asked.has(f.name)).map((f) => ({ field: f.name, table: f.references! })),
	};
}

/**
 * The tables the check saves a record in: EVERY person-owned table and, once a
 * team can be started, EVERY team-owned record table (not the team table
 * itself), each with a create route in scope. A table another one points at
 * comes first, so its record exists when the pointing record is made;
 * otherwise declaration order (a cycle keeps declaration order).
 */
function subjectTables(block: ArchitectureBlock, view: ArchitectureBlock, hasTeam: boolean): ArchitectureTable[] {
	const teamTable = block.team?.table ?? null;
	const chosen = block.tables.filter(
		(t) =>
			view.routes.some((r) => r.table === t.name && r.op === 'create') &&
			(t.owner === 'person' || (hasTeam && t.owner === 'team' && t.name !== teamTable)),
	);
	const byName = new Map(chosen.map((t) => [t.name, t]));
	const ordered: ArchitectureTable[] = [];
	const seen = new Set<string>();
	const visit = (t: ArchitectureTable): void => {
		if (seen.has(t.name)) return;
		seen.add(t.name);
		for (const f of t.fields) {
			const target = f.references ? byName.get(f.references) : undefined;
			if (target && target.name !== t.name) visit(target);
		}
		ordered.push(t);
	};
	for (const t of chosen) visit(t);
	return ordered;
}

/**
 * The generated contract test. It is ONE file, run four times with different
 * CADDIE_CONTRACT_PHASE values so the host can drive restarts across SEPARATE
 * processes (host-checks.ts). Each phase process opens the file database fresh,
 * so moving from one phase to the next is a real restart. The phases:
 *   create          A signs in; seeds teams (team mode); creates a record in
 *                   EVERY table (person-owned and team-owned).
 *   read            restart; reads each by id and in the list; then changes
 *                   each (steps 3-4).
 *   privacy-screen  restart; every change survived; second-person, teammate and
 *                   team/role checks on every table; each table screen shows
 *                   A's record of ITS OWN table and not B's; then deletes.
 *   test-mode       restart; every delete survived (404 + gone); test-mode checks.
 * Data crosses phases through a handoff JSON file next to the database, so a
 * later process knows the ids and cookies the earlier one made.
 *
 * NO test is vacuous: a declared subject the test cannot exercise FAILS with a
 * plain sentence (never a skip), so a weak app cannot pass by having nothing
 * checked. Every failure names the table, so a repair knows where to look.
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

	// Team mode: the team registry table, the team create/list routes, and the
	// role and admin routes step 6 exercises.
	const teamTable = block.team?.table ?? null;
	const teamCreate = teamTable ? view.routes.find((r) => r.table === teamTable && r.op === 'create') ?? null : null;
	const teamList = teamTable ? view.routes.find((r) => r.table === teamTable && r.op === 'list') ?? null : null;
	// The team checks start once a team can be started (its create route built).
	const hasTeam = block.team !== null && (!scoped || teamCreate !== null);

	// The subjects: every person-owned and team-owned record table in scope.
	const subjects = subjectTables(block, view, hasTeam).map((t) =>
		subjectFor(routesForTable(view, t.name), t, t.owner === 'person' ? 'person' : 'team'),
	);

	// A team-role:<role> route (step 6: refuses C, allows A who holds creatorRole).
	// A delete is the last choice: A's allowed call would remove a record the
	// later checks still read.
	const roleRoutes = view.routes.filter((r) => teamRoleOf(r.access as Access) !== null);
	const roleRoute = roleRoutes.find((r) => r.op !== 'delete') ?? roleRoutes[0] ?? null;
	// An admin route (step 6: refuses B, allows the first account).
	const adminRoute = view.routes.find((r) => r.access === 'admin') ?? null;

	// Step 8: each screen that shows a table is checked against the record the
	// test saved for THAT table (a team record is opened with its team as the
	// current team). A screen of a table the test saves nothing in (the team
	// table itself, a shared table) has no record to look for, so it is not
	// checked here.
	const bySubject = new Map(subjects.map((s) => [s.table, s]));
	const screenOnly = new Set(block.screenOnly);
	const tableScreens = block.screens
		.filter((s) => !screenOnly.has(s.id) && s.shows.length > 0)
		.flatMap((s) => {
			const table = s.shows.find((name) => bySubject.has(name));
			return table ? [{ id: s.id, path: s.path, kind: bySubject.get(table)!.kind, table }] : [];
		});

	// Step 9: the test-mode features. Each is checked once its route is built (in
	// scope); at the final check every declared one is. A declared feature whose
	// route the design does not have can never be checked, so it fails there.
	const routeById = new Map(block.routes.map((r) => [r.id, r]));
	const inView = new Set(view.routes.map((r) => r.id));
	const lockedPlans = new Map((block.payments?.locked ?? []).map((l) => [l.route, [...l.plans]]));
	const routeMeta = (r: ArchitectureRoute) => ({ id: r.id, path: r.path, method: r.method, body: exampleBody(r), plans: lockedPlans.get(r.id) ?? null });
	const built = (route: string) => inView.has(route) && routeById.has(route);
	const lockedInScope = (block.payments?.locked ?? []).filter((l) => built(l.route)).map((l) => routeMeta(routeById.get(l.route)!));
	// Without a locked route, the checkout alone is checked, at the final check.
	const payments =
		block.payments && (lockedInScope.length > 0 || !scoped) ? { firstPlan: block.payments.plans[0]?.id ?? null, locked: lockedInScope } : null;
	const emails = block.emails.filter((e) => built(e.route)).map((e) => ({ id: e.id, to: e.to, route: routeMeta(routeById.get(e.route)!) }));
	const jobs = block.jobs.filter((x) => built(x.route)).map((x) => ({ id: x.id, route: routeMeta(routeById.get(x.route)!) }));
	const files = block.tables.some((t) => t.fields.some((f) => f.type === 'file') && view.routes.some((r) => r.table === t.name));
	const unchecked = scoped
		? []
		: [
				...block.emails.filter((e) => !routeById.has(e.route)).map((e) => `the email "${e.id}" names the route ${e.route}, which the design does not have`),
				...block.jobs.filter((x) => !routeById.has(x.route)).map((x) => `the job "${x.id}" names the route ${x.route}, which the design does not have`),
				...(block.payments?.locked ?? []).filter((l) => !routeById.has(l.route)).map((l) => `the locked route ${l.route} is not in the design`),
			];

	const meta = {
		scoped,
		hasTeam,
		creatorRole: block.team?.creatorRole ?? null,
		otherRole: block.team ? block.team.roles.find((r) => r !== block.team!.creatorRole) ?? block.team.roles[0]! : null,
		teamTable,
		subjects,
		teamCreate: teamCreate ? { path: teamCreate.path, method: teamCreate.method, body: exampleBody(teamCreate) } : null,
		teamList: teamList ? { path: teamList.path, method: teamList.method } : null,
		role: roleRoute
			? { path: roleRoute.path, method: roleRoute.method, role: teamRoleOf(roleRoute.access as Access), body: exampleBody(roleRoute), table: roleRoute.table }
			: null,
		admin: adminRoute ? { path: adminRoute.path, method: adminRoute.method, body: exampleBody(adminRoute) } : null,
		screens: tableScreens,
		payments,
		emails,
		jobs,
		files,
		unchecked,
	};
	const personalInTeam = hasTeam && subjects.some((s) => s.kind === 'person');

	return `// Caddie runtime file — do not edit. The generated contract test (plan part E,
// steps 1-9). Run in phases by CADDIE_CONTRACT_PHASE; each phase is a SEPARATE
// process on one file at CADDIE_TEST_DB_FILE, so moving between phases is a real
// restart. Data crosses phases through HANDOFF (a JSON file beside the database).
// EVERY table the app saves records in is checked, not only the first one.
import { expect, test } from "bun:test";
import { app } from "../src/server";
import { signInForTest } from "../test/setup/auth";
import { createFileEnv } from "../test/setup/d1-file";
import { JOB_HEADER, ROUTES, TEAM_TABLE } from "./contract";

interface Subject {
  table: string;
  kind: "person" | "team";
  idField: string;
  createId: string | null;
  createPath: string | null;
  createMethod: string | null;
  createBody: Record<string, string>;
  readPath: string | null;
  readMethod: string;
  listPath: string | null;
  listMethod: string;
  updatePath: string | null;
  updateMethod: string | null;
  updateBody: Record<string, string>;
  updateField: string | null;
  deletePath: string | null;
  deleteMethod: string | null;
  response: string[];
  refs: { field: string; table: string }[];
}
/** A declared route the step-9 checks call: its example body, and the plans that unlock it (null when it is not locked). */
interface RouteMeta { id: string; path: string; method: string; body: Record<string, string>; plans: string[] | null }
interface Meta {
  scoped: boolean;
  hasTeam: boolean;
  creatorRole: string | null;
  otherRole: string | null;
  teamTable: string | null;
  subjects: Subject[];
  teamCreate: { path: string; method: string; body: Record<string, string> } | null;
  teamList: { path: string; method: string } | null;
  role: { path: string; method: string; role: string | null; body: Record<string, string>; table: string | null } | null;
  admin: { path: string; method: string; body: Record<string, string> } | null;
  screens: { id: string; path: string; kind: "person" | "team"; table: string }[];
  payments: { firstPlan: string | null; locked: RouteMeta[] } | null;
  emails: { id: string; to: string; route: RouteMeta }[];
  jobs: { id: string; route: RouteMeta }[];
  files: boolean;
  unchecked: string[];
}

const PHASE = process.env.CADDIE_CONTRACT_PHASE ?? "create";
const FILE = process.env.CADDIE_TEST_DB_FILE!;
const META: Meta = ${j(meta)};
const HANDOFF = FILE + ".handoff.json";
/** The current-team key caddie/api.ts keeps (currentTeamId); step 8 sets it. */
const TEAM_KEY = "caddie.teamId";
/** One check drives every table, so it may need longer than bun's 5 s default. */
const LONG = 100_000;
const PERSONS = META.subjects.filter((s) => s.kind === "person");
const TEAMS = META.subjects.filter((s) => s.kind === "team");
void TEAM_TABLE;

function req(path: string, init: RequestInit, env: unknown) { return app.request(path, init, env as any); }
const jsonHeaders = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", ...extra });
type Row = Record<string, unknown>;
async function readHandoff(): Promise<Row> { return (await Bun.file(HANDOFF).json()) as Row; }
async function writeHandoff(next: Row) { await Bun.write(HANDOFF, JSON.stringify(next)); }
/** Substitute :teamId then :id, then any other :param with a dummy. */
function path(p: string, teamId?: unknown, id?: unknown): string {
  let out = p;
  if (teamId !== undefined && teamId !== null) out = out.replace(/:teamId\\b/g, String(teamId));
  if (id !== undefined && id !== null) out = out.replace(/:id\\b/g, String(id));
  return out.replace(/:[a-zA-Z]+/g, "x");
}
/** A screen's address with its team and record filled in (other :params left as they are). */
function screenPath(p: string, teamId?: unknown, id?: unknown): string {
  let out = p;
  if (teamId !== undefined && teamId !== null) out = out.replace(/:teamId\\b/g, String(teamId));
  if (id !== undefined && id !== null) out = out.replace(/:id\\b/g, String(id));
  return out;
}
/** The record A saved in a table in the create phase. */
function recordOf(h: Row, s: { table: string }): unknown { return ((h.records ?? {}) as Row)[s.table]; }
/** The team the routes sit under: A's team T1 (a path without :teamId ignores it). */
function teamFor(h: Row): unknown { return h.t1Id; }
/**
 * A body for a table's route: a field that points at another table's record
 * is filled with the id this run saved there (A's team T1 for the team table),
 * as a person filling in the form picks one of their own records.
 */
function bodyFor(s: Subject, body: Record<string, string>, h: Row): Row {
  const out: Row = { ...body };
  for (const ref of s.refs) {
    if (!(ref.field in out)) continue;
    const target = ref.table === META.teamTable ? h.t1Id : ((h.records ?? {}) as Row)[ref.table];
    if (target !== undefined && target !== null) out[ref.field] = target;
  }
  return out;
}
/** A stored value equals the one sent (a number or a yes/no may come back in its stored form). */
function same(actual: unknown, expected: unknown): boolean {
  if (String(actual) === String(expected)) return true;
  const yes = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
  const no = (v: unknown) => v === false || v === 0 || v === "0" || v === "false";
  if ((yes(actual) && yes(expected)) || (no(actual) && no(expected))) return true;
  return typeof expected === "string" && expected.trim() !== "" && Number.isFinite(Number(expected)) && Number(actual) === Number(expected);
}
/** A's copy of a record: read by id, else found in the list. Null when it is gone. */
async function readAs(env: unknown, cookie: string, s: Subject, h: Row, id: unknown): Promise<Row | null> {
  if (s.readPath) {
    const r = await req(path(s.readPath, teamFor(h), id), { method: s.readMethod, headers: { cookie } }, env);
    return r.status === 200 ? ((await r.json()) as Row) : null;
  }
  if (s.listPath) {
    const r = await req(path(s.listPath, teamFor(h)), { method: s.listMethod, headers: { cookie } }, env);
    if (r.status !== 200) return null;
    return ((await r.json()) as Row[]).find((x) => String(x[s.idField]) === String(id)) ?? null;
  }
  return null;
}
/** Insert a team_members row directly (step 6 seeds membership). */
async function seedMember(env: any, teamId: unknown, personId: string, role: string) {
  const now = new Date().toISOString();
  await env.DB.prepare("insert or replace into team_members (teamId, personId, role, createdAt) values (?, ?, ?, ?)").bind(String(teamId), personId, role, now).run();
}
/** Make the first signed-in account an admin (step 6 admin route). */
async function seedAdmin(env: any, personId: string) {
  const now = new Date().toISOString();
  await env.DB.prepare("insert or replace into caddie_admins (personId, createdAt) values (?, ?)").bind(personId, now).run();
}

/** Caddie's job secret for this check's runs (the app reads env.CADDIE_JOB_SECRET). */
const JOB_SECRET = "caddie-contract-check-job-secret";
/** The request for a declared route: its example body when it takes one. */
function sendInit(r: RouteMeta, headers: Record<string, string>): RequestInit {
  return r.method === "GET" || r.method === "DELETE" ? { method: r.method, headers } : { method: r.method, headers: jsonHeaders(headers), body: JSON.stringify(r.body) };
}
/** Caddie's test-mode checkout (caddie/payments.ts) with one of the D10 test cards. */
function checkout(env: unknown, cookie: string, planId: string, card: string) {
  return req("/api/caddie/checkout", { method: "POST", headers: jsonHeaders({ cookie }), body: JSON.stringify({ planId, cardNumber: card, expiry: "12/30", cvc: "123" }) }, env);
}
/** Test mode's "End now": the plan ends at once. */
function endNow(env: unknown, cookie: string) {
  return req("/api/caddie/end-now", { method: "POST", headers: jsonHeaders({ cookie }), body: "{}" }, env);
}
/** Caddie's Run-now signature: "<ms>.<hex>", an HMAC-SHA256 over "<ms>.<route path>". */
async function jobSignature(secret: string, routePath: string): Promise<string> {
  const stamp = String(Date.now());
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stamp + "." + routePath));
  return stamp + "." + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** 5 MB of varied bytes, the same every run. */
function fiveMegabytes(): Uint8Array {
  const bytes = new Uint8Array(5 * 1024 * 1024);
  let x = 2463534242;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    bytes[i] = x & 255;
  }
  return bytes;
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// ==== phase: create (steps 1-3, 7) =======================================
if (PHASE === "create") {
  test("every route is registered through implement() (step 1)", async () => {
    const env = createFileEnv(FILE);
    for (const route of ROUTES) {
      const res = await req(route.path.replace(/:[a-zA-Z]+/g, "x"), { method: route.method }, env);
      expect(res.status, "route " + route.id + " (" + route.method + " " + route.path + ") is not registered").not.toBe(404);
    }
  }, LONG);

  test("guarded routes answer 401/403 without a session (step 2)", async () => {
    const env = createFileEnv(FILE);
    const guarded = ROUTES.filter((r) => r.access !== "public" && r.access !== "job");
    for (const route of guarded) {
      const res = await req(route.path.replace(/:[a-zA-Z]+/g, "x"), { method: route.method }, env);
      expect([401, 403], "route " + route.id + " should refuse an anonymous caller").toContain(res.status);
    }
  }, LONG);

  test("A creates a record in every table and each reply carries the declared fields (steps 3, 7)", async () => {
    const env = createFileEnv(FILE);
    const { headers, user } = await signInForTest(app, env, "ada@example.com");
    const records: Row = {};
    const handoff: Row = { aCookie: headers.cookie, aId: user.id, records };

    if (META.hasTeam) {
      // Seed the first account as admin (step 6 admin route).
      await seedAdmin(env, user.id);
      // A owns team T1 with the creator role; T1 is the team registry row.
      if (!META.teamCreate) throw new Error("A team app must let a signed-in person start a team, but no team-create route is declared.");
      const created = await req(META.teamCreate.path.replace(/:[a-zA-Z]+/g, "x"), { method: META.teamCreate.method, headers: jsonHeaders(headers), body: JSON.stringify(META.teamCreate.body) }, env);
      expect([200, 201], "starting team T1 failed: " + created.status + " " + (await created.clone().text())).toContain(created.status);
      const t1 = (await created.json()) as Row;
      expect(t1["id"], "the team-create reply has no id").toBeDefined();
      await seedMember(env, t1["id"], user.id, META.creatorRole!);
      handoff.t1Id = t1["id"];
      // Scoped: the team records may be a later feature; the team itself is checked now.
      if (TEAMS.length === 0 && !META.scoped) throw new Error("A team app must let a member add a record under its team, but no team-owned record route is declared.");
    }

    // Every table, in an order where a record another one points at is made first.
    for (const s of META.subjects) {
      const res = await req(path(s.createPath!, handoff.t1Id), { method: s.createMethod!, headers: jsonHeaders(headers), body: JSON.stringify(bodyFor(s, s.createBody, handoff)) }, env);
      expect([200, 201], s.table + ": A creating a record failed: " + res.status + " " + (await res.clone().text())).toContain(res.status);
      const row = (await res.json()) as Row;
      for (const field of s.response) expect(field in row, s.table + ': the reply is missing the declared field "' + field + '" (step 7)').toBe(true);
      expect(row[s.idField], s.table + ": the create reply has no " + s.idField + ", so the record can't be found again").toBeDefined();
      records[s.table] = row[s.idField];
    }

    if (!META.scoped && META.subjects.length === 0 && !META.hasTeam) throw new Error("No create route could be exercised, so nothing proves the app saves anything.");
    await writeHandoff(handoff);
  }, LONG);
}

// ==== phase: read (steps 3-4: read after restart, then update) ===========
if (PHASE === "read") {
  test("after a restart, A reads every saved record by id and in the list (step 3)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const headers = { cookie: String(h.aCookie) };
    for (const s of META.subjects) {
      const id = recordOf(h, s);
      if (!s.readPath && !s.listPath) {
        if (META.scoped) continue; // the read routes are a later feature
        throw new Error(s.table + ": the app saves this record but declares no way to read it back, so it can't be proven saved.");
      }
      if (s.readPath) {
        const byId = await req(path(s.readPath, teamFor(h), id), { method: s.readMethod, headers }, env);
        expect(byId.status, s.table + ": reading A's record after restart failed: " + byId.status).toBe(200);
      }
      if (s.listPath) {
        const list = await req(path(s.listPath, teamFor(h)), { method: s.listMethod, headers }, env);
        expect(list.status, s.table + ": listing A's records after restart failed: " + list.status).toBe(200);
        const rows = (await list.json()) as Row[];
        expect(rows.some((r) => String(r[s.idField]) === String(id)), s.table + ": the saved record is gone from the list after restart").toBe(true);
      }
    }
  }, LONG);

  test("A changes the record in every table that can be changed (step 4, update half)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const headers = jsonHeaders({ cookie: String(h.aCookie) });
    const changeable = META.subjects.filter((s) => s.updatePath && s.updateField);
    if (changeable.length === 0) {
      if (META.scoped || META.subjects.length === 0) return; // no change route is built yet, or nothing was saved
      throw new Error("The app declares no way to change a saved record, so a change can't be proven to stick.");
    }
    const changes: Row = {};
    for (const s of changeable) {
      const res = await req(path(s.updatePath!, teamFor(h), recordOf(h, s)), { method: s.updateMethod!, headers, body: JSON.stringify(bodyFor(s, s.updateBody, h)) }, env);
      expect([200, 201, 204], s.table + ": changing A's record failed: " + res.status + " " + (await res.clone().text())).toContain(res.status);
      changes[s.table] = { field: s.updateField, value: s.updateBody[s.updateField!] };
    }
    h.changes = changes;
    await writeHandoff(h);
  }, LONG);
}

// ==== phase: privacy-screen (steps 4 read, 5-8) ==========================
if (PHASE === "privacy-screen") {
  test("after a restart, every change is still there (step 4, read half)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const changes = (h.changes ?? {}) as Record<string, { field: string; value: unknown }>;
    for (const s of META.subjects) {
      const change = changes[s.table];
      if (!change) continue;
      if (!s.readPath && !s.listPath) {
        if (META.scoped) continue; // the read routes are a later feature
        throw new Error(s.table + ": the app cannot read a record back, so a saved change can't be checked.");
      }
      const row = await readAs(env, String(h.aCookie), s, h, recordOf(h, s));
      expect(row !== null, s.table + ": the record is gone after the change and a restart").toBe(true);
      const shown = row![change.field];
      expect(same(shown, change.value), s.table + ": the change was not saved: the record still shows the old value after a restart (it shows " + JSON.stringify(shown) + ")").toBe(true);
    }
  }, LONG);

  test("a second person B cannot read, change or delete A's record in any table (step 5)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const aCookie = String(h.aCookie);
    const { headers: bHeaders } = await signInForTest(app, env, "bo@example.com");
    for (const s of META.subjects) {
      const id = recordOf(h, s);
      if (id === undefined) continue; // its create already failed
      const t = teamFor(h);
      if (s.readPath) {
        const read = await req(path(s.readPath, t, id), { method: s.readMethod, headers: bHeaders }, env);
        expect([403, 404], s.table + ": B can read A's record — it is not owner/team-scoped").toContain(read.status);
      }
      if (s.listPath) {
        const list = await req(path(s.listPath, t), { method: s.listMethod, headers: bHeaders }, env);
        // B's list is refused (an outsider to A's team) or holds only B's own rows.
        if (list.status === 200) {
          const rows = (await list.json()) as Row[];
          expect(rows.some((r) => String(r[s.idField]) === String(id)), s.table + ": A's record shows up in B's list — not scoped").toBe(false);
        } else {
          expect([403, 404], s.table + ": B's list answered " + list.status).toContain(list.status);
        }
      }
      if (s.updatePath && s.updateField) {
        const before = await readAs(env, aCookie, s, h, id);
        const upd = await req(path(s.updatePath, t, id), { method: s.updateMethod!, headers: jsonHeaders(bHeaders), body: JSON.stringify(bodyFor(s, s.updateBody, h)) }, env);
        // Refused outright (403/404), or a no-op — but A's record must be UNCHANGED.
        if (before) {
          const after = await readAs(env, aCookie, s, h, id);
          expect(String(after?.[s.updateField]), s.table + ": B changed A's record — the write is not owner/team-scoped").toBe(String(before[s.updateField]));
        } else {
          expect([403, 404], s.table + ": B could change A's record").toContain(upd.status);
        }
      }
      if (s.deletePath) {
        await req(path(s.deletePath, t, id), { method: s.deleteMethod!, headers: bHeaders }, env);
        // Refused or a no-op — but A's record must still be there.
        if (s.readPath || s.listPath) {
          const still = await readAs(env, aCookie, s, h, id);
          expect(still !== null, s.table + ": B deleted A's record — the delete is not owner/team-scoped").toBe(true);
        }
      }
    }
  }, LONG);

${
	meta.hasTeam
		? `  test("teams and roles: member C reads, outsider B cannot, in every team table; role and admin routes (step 6)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const aCookie = String(h.aCookie);
    // The record checks need a saved team record and a way to read it. In a
    // scoped test they wait for that feature; the team list, role and admin
    // checks run now.
    const readable = TEAMS.filter((s) => (s.readPath || s.listPath) && recordOf(h, s) !== undefined);
    if (readable.length === 0 && !META.scoped) throw new Error("A team app must let a teammate read the team's records, but no team read route is declared.");
    // C joins T1 with a non-creator role; B owns a separate team T2.
    const { user: c, headers: cHeaders } = await signInForTest(app, env, "cas@example.com");
    await seedMember(env, h.t1Id, c.id, META.otherRole!);
    const { user: b, headers: bHeaders } = await signInForTest(app, env, "bo@example.com");
    let t2Id: unknown = null;
    if (META.teamCreate) {
      const t2 = await req(META.teamCreate.path.replace(/:[a-zA-Z]+/g, "x"), { method: META.teamCreate.method, headers: jsonHeaders(bHeaders), body: JSON.stringify(META.teamCreate.body) }, env);
      expect([200, 201], "B starting their own team T2 failed: " + t2.status).toContain(t2.status);
      t2Id = ((await t2.json()) as Row)["id"];
      await seedMember(env, t2Id, b.id, META.creatorRole!);
      // Step 8 opens B's screens with B's own team T2 as the current team.
      await writeHandoff({ ...h, t2Id });
    }

    for (const s of readable) {
      const id = recordOf(h, s);
      // C can read and list T1's records.
      if (s.readPath) {
        const cRead = await req(path(s.readPath, h.t1Id, id), { method: s.readMethod, headers: cHeaders }, env);
        expect(cRead.status, s.table + ": a teammate C cannot read the team's record").toBe(200);
      }
      if (s.listPath) {
        const cList = await req(path(s.listPath, h.t1Id), { method: s.listMethod, headers: cHeaders }, env);
        expect(cList.status, s.table + ": a teammate C cannot list the team's records").toBe(200);
        const rows = (await cList.json()) as Row[];
        expect(rows.some((r) => String(r[s.idField]) === String(id)), s.table + ": the team's record is not in teammate C's list").toBe(true);
      }
      // B (outsider to T1) can read, change or delete nothing of T1's.
      if (s.readPath) {
        const bRead = await req(path(s.readPath, h.t1Id, id), { method: s.readMethod, headers: bHeaders }, env);
        expect([403, 404], s.table + ": outsider B can read T1's record").toContain(bRead.status);
      }
      if (s.updatePath && s.updateField) {
        const bUpd = await req(path(s.updatePath, h.t1Id, id), { method: s.updateMethod!, headers: jsonHeaders(bHeaders), body: JSON.stringify(bodyFor(s, s.updateBody, h)) }, env);
        expect([403, 404], s.table + ": outsider B can change T1's record").toContain(bUpd.status);
      }
      if (s.deletePath) {
        const bDel = await req(path(s.deletePath, h.t1Id, id), { method: s.deleteMethod!, headers: bHeaders }, env);
        expect([403, 404], s.table + ": outsider B can delete T1's record").toContain(bDel.status);
      }
      // The real team-filter check: B is a MEMBER of T2, so the guard lets B call
      // T2's routes. A handler that does not filter by teamId would leak A's T1
      // record here. B must never see, change or delete A's record through B's own team.
      if (t2Id !== null) {
        if (s.listPath) {
          const bOwnList = await req(path(s.listPath, t2Id), { method: s.listMethod, headers: bHeaders }, env);
          expect(bOwnList.status, s.table + ": B cannot list B's own team's records").toBe(200);
          const rows = (await bOwnList.json()) as Row[];
          expect(rows.some((r) => String(r[s.idField]) === String(id)), s.table + ": A's record leaks into B's own-team list — the route does not filter by team").toBe(false);
        }
        if (s.readPath) {
          const bReadOwn = await req(path(s.readPath, t2Id, id), { method: s.readMethod, headers: bHeaders }, env);
          expect([403, 404], s.table + ": B reads A's record through B's own team — the route does not filter by team").toContain(bReadOwn.status);
        }
        if (s.updatePath && s.updateField) {
          const before = await readAs(env, aCookie, s, h, id);
          await req(path(s.updatePath, t2Id, id), { method: s.updateMethod!, headers: jsonHeaders(bHeaders), body: JSON.stringify(bodyFor(s, s.updateBody, h)) }, env);
          const after = await readAs(env, aCookie, s, h, id);
          expect(String(after?.[s.updateField]), s.table + ": B changed A's record through B's own team — the route does not filter by team").toBe(String(before?.[s.updateField]));
        }
        if (s.deletePath) {
          await req(path(s.deletePath, t2Id, id), { method: s.deleteMethod!, headers: bHeaders }, env);
          const still = await readAs(env, aCookie, s, h, id);
          expect(still !== null, s.table + ": B deleted A's record through B's own team — the route does not filter by team").toBe(true);
        }
      }
    }
    if (META.teamList && t2Id !== null) {
      // A team list under a team path (/api/teams/:teamId/…) is read as B's own team T2.
      const bList = await req(path(META.teamList.path, t2Id), { method: META.teamList.method, headers: bHeaders }, env);
      expect(bList.status, "B cannot list B's own teams: " + bList.status).toBe(200);
      const rows = (await bList.json()) as Row[];
      const ids = rows.map((r) => String(r["id"]));
      expect(ids.includes(String(t2Id)), "B's own team T2 is missing from B's team list").toBe(true);
      expect(ids.includes(String(h.t1Id)), "A's team T1 shows up in B's team list").toBe(false);
    }

    // The team-role route refuses C (lacks the role) and allows A (holds it).
    if (META.role) {
      const { headers: aHeaders } = await signInForTest(app, env, "ada@example.com");
      const roleRecord = META.role.table === META.teamTable ? h.t1Id : META.role.table ? ((h.records ?? {}) as Row)[META.role.table] : undefined;
      const cTry = await req(path(META.role.path, h.t1Id, roleRecord), { method: META.role.method, headers: jsonHeaders(cHeaders), body: JSON.stringify(META.role.body) }, env);
      expect([403], "the " + META.role.role + " route let a member without that role through").toContain(cTry.status);
      const aTry = await req(path(META.role.path, h.t1Id, roleRecord), { method: META.role.method, headers: jsonHeaders(aHeaders), body: JSON.stringify(META.role.body) }, env);
      expect(aTry.status, "the " + META.role.role + " route refused A who holds that role").not.toBe(403);
    }

    // The admin route refuses B and allows the first account (A, seeded admin in create).
    if (META.admin) {
      const { headers: aHeaders } = await signInForTest(app, env, "ada@example.com");
      const bAdmin = await req(path(META.admin.path, h.t1Id), { method: META.admin.method, headers: jsonHeaders(bHeaders), body: JSON.stringify(META.admin.body) }, env);
      expect([403], "the admin route let a non-admin through").toContain(bAdmin.status);
      const aAdmin = await req(path(META.admin.path, h.t1Id), { method: META.admin.method, headers: jsonHeaders(aHeaders), body: JSON.stringify(META.admin.body) }, env);
      expect(aAdmin.status, "the admin route refused the app's first account").not.toBe(403);
    }
  }, LONG);`
		: '  // (no team declared: step 6 does not apply)'
}

${
	personalInTeam
		? `  test("in a team app, a teammate cannot see another member's personal records (step 5)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const aCookie = String(h.aCookie);
    // C shares team T1 with A (step 6 seeds the same membership).
    const { user: c, headers: cHeaders } = await signInForTest(app, env, "cas@example.com");
    await seedMember(env, h.t1Id, c.id, META.otherRole!);
    for (const s of PERSONS) {
      const id = recordOf(h, s);
      if (id === undefined) continue; // its create already failed
      if (s.readPath) {
        const cRead = await req(path(s.readPath, h.t1Id, id), { method: s.readMethod, headers: cHeaders }, env);
        expect([403, 404], s.table + ": a teammate can read A's personal record — a person's own records stay theirs, even inside a team").toContain(cRead.status);
      }
      if (s.listPath) {
        const cList = await req(path(s.listPath, h.t1Id), { method: s.listMethod, headers: cHeaders }, env);
        if (cList.status === 200) {
          const rows = (await cList.json()) as Row[];
          expect(rows.some((r) => String(r[s.idField]) === String(id)), s.table + ": a teammate can read A's personal record — it shows up in their list").toBe(false);
        }
      }
      // A still can.
      expect((await readAs(env, aCookie, s, h, id)) !== null, s.table + ": A can no longer read their own record").toBe(true);
    }
  }, LONG);`
		: '  // (no personal records in a team app: the teammate check does not apply)'
}

${
	meta.screens.length > 0
		? `  test("each table screen shows A's saved record of its own table, and not to B (step 8)", async () => {
    if (typeof document === "undefined") throw new Error("This app's screens could not be opened for the check: the starter's browser-page test setup (happy-dom, in bunfig.toml and test/setup/) is missing. Put it back as the starter had it.");
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    // Route the screen's fetch at the real server, as the chosen person.
    let activeCookie = String(h.aCookie);
    let inflight = 0;
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const p = url.replace(/^https?:\\/\\/[^/]+/, "");
      const headers = { ...(init.headers || {}), cookie: activeCookie };
      inflight += 1;
      try {
        return await req(p, { ...init, headers }, env);
      } finally {
        inflight -= 1;
      }
    };
    /** Wait until the screen's requests are done and what they returned is drawn. */
    const settled = async () => {
      const start = Date.now();
      let quiet = 0;
      while (Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 25));
        quiet = inflight === 0 ? quiet + 1 : 0;
        if (quiet >= 6) return;
      }
    };
    try {
      const React = await import("react");
      const { render, cleanup, waitFor } = await import("@testing-library/react");
      let entry: any;
      try { entry = await import("../src/App"); } catch { entry = null; }
      const App = entry && (entry.App || entry.default);
      if (!App) throw new Error("This app's screen could not be rendered to check it shows saved data (no src/App export).");
      const bySubject = new Map(META.subjects.map((s) => [s.table, s] as const));
      const bCookie = String((await signInForTest(app, createFileEnv(FILE), "bo@example.com")).cookie);
      const bTeam = h.t2Id !== undefined && h.t2Id !== null ? String(h.t2Id) : null;
      /** A's saved value to look for: the longest text A typed into the record, read live (it may have changed). */
      const needleFor = async (s: Subject): Promise<string> => {
        const row = await readAs(env, String(h.aCookie), s, h, recordOf(h, s));
        if (!row) return "";
        const typed = Object.keys(s.createBody)
          .filter((k) => !s.refs.some((r) => r.field === k))
          .map((k) => row[k])
          .filter((v): v is string => typeof v === "string" && v.length > 0);
        const pool = typed.length > 0 ? typed : Object.entries(row).filter(([k, v]) => k !== s.idField && !/(Id|At)$/.test(k) && typeof v === "string" && v.length > 0).map(([, v]) => String(v));
        return [...pool].sort((x, y) => y.length - x.length)[0] ?? "";
      };
      for (const sc of META.screens) {
        const s = bySubject.get(sc.table)!;
        const needle = await needleFor(s);
        if (!needle) throw new Error("The " + sc.id + " screen cannot be checked: no saved " + sc.table + " value was found to look for.");
        // Render for A, with A's team T1 as the current team: the record must appear.
        activeCookie = String(h.aCookie);
        if (sc.kind === "team") localStorage.setItem(TEAM_KEY, String(h.t1Id));
        else localStorage.removeItem(TEAM_KEY);
        location.hash = screenPath(sc.path, sc.kind === "team" ? h.t1Id : undefined, recordOf(h, s));
        render(React.createElement(App));
        await waitFor(() => expect(document.body.textContent || "").toContain(needle), { timeout: 4000 }).catch(() => {
          throw new Error(
            sc.kind === "team"
              ? "The " + sc.id + " screen does not show the team's saved record. A team screen shows the records of the team in currentTeamId() from caddie/api.ts (the person's first team when none is set), read from the server."
              : "The " + sc.id + " screen does not show a record the server saved (it may read the browser instead of the server, or another table).",
          );
        });
        cleanup();
        // Render for B, with B's own team current: the record must NOT appear.
        activeCookie = bCookie;
        if (sc.kind === "team" && bTeam) localStorage.setItem(TEAM_KEY, bTeam);
        else localStorage.removeItem(TEAM_KEY);
        location.hash = screenPath(sc.path, sc.kind === "team" && bTeam ? bTeam : undefined, recordOf(h, s));
        render(React.createElement(App));
        await settled();
        expect(document.body.textContent || "", "the " + sc.id + " screen shows another person's record to B").not.toContain(needle);
        cleanup();
      }
    } finally {
      (globalThis as any).fetch = realFetch;
      localStorage.removeItem(TEAM_KEY);
    }
  }, LONG);`
		: '  // (no table-backed screen declared: step 8 does not apply)'
}

${
	meta.files
		? `  test("A stores a 5 MB file in parts (step 9; it is read back after the restart)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const cookie = String(h.aCookie);
    const bytes = fiveMegabytes();
    const sha = await sha256Hex(bytes);
    const start = await req("/api/caddie/files/start", { method: "POST", headers: jsonHeaders({ cookie }), body: JSON.stringify({ name: "contract-check.pdf", type: "application/pdf", size: bytes.length, sha256: sha }) }, env);
    if (start.status === 404) throw new Error("This app stores files, but Caddie's upload routes aren't mounted: call mountFiles(app) once in src/server.ts (caddie/files.ts).");
    expect(start.status, "starting a 5 MB upload failed: " + start.status + " " + (await start.clone().text())).toBe(200);
    const { id, parts, partBytes } = (await start.json()) as { id: string; parts: number; partBytes: number };
    for (let n = 0; n < parts; n++) {
      const slice = bytes.subarray(n * partBytes, Math.min(bytes.length, (n + 1) * partBytes));
      const put = await req("/api/caddie/files/" + id + "/parts/" + n, { method: "PUT", headers: { cookie, "content-type": "text/plain" }, body: Buffer.from(slice).toString("base64") }, env);
      expect(put.status, "storing part " + n + " of the file failed: " + put.status + " " + (await put.clone().text())).toBe(200);
    }
    const done = await req("/api/caddie/files/" + id + "/finish", { method: "POST", headers: jsonHeaders({ cookie }), body: "{}" }, env);
    expect(done.status, "finishing the 5 MB upload failed: " + done.status + " " + (await done.clone().text())).toBe(200);
    await writeHandoff({ ...h, file: { id, parts, sha } });
  }, LONG);`
		: '  // (no file field in scope: the file check does not apply)'
}

  test("A deletes the record in every table that can be deleted from (step 4, delete half — the read is checked in test-mode)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const headers = { cookie: String(h.aCookie) };
    const deleted: Row = {};
    // A record another one points at is deleted last.
    for (const s of [...META.subjects].reverse()) {
      const id = recordOf(h, s);
      if (!s.deletePath || id === undefined) continue;
      const res = await req(path(s.deletePath, teamFor(h), id), { method: s.deleteMethod!, headers }, env);
      expect([200, 204], s.table + ": deleting A's record failed: " + res.status).toContain(res.status);
      deleted[s.table] = id;
    }
    h.deleted = deleted;
    await writeHandoff(h);
  }, LONG);
}

// ==== phase: test-mode (step 4 delete-read, step 9) ======================
if (PHASE === "test-mode") {
  test("after a restart, every deleted record is gone (404 and not in the list) (step 4, delete read)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff().catch(() => null);
    if (!h) return; // the earlier phases never ran — already reported there
    const headers = { cookie: String(h.aCookie) };
    const deleted = (h.deleted ?? {}) as Row;
    for (const s of META.subjects) {
      if (!(s.table in deleted)) continue;
      const id = deleted[s.table];
      if (!s.readPath && !s.listPath) {
        if (META.scoped) continue; // the read routes are a later feature
        throw new Error(s.table + ": the app cannot read a record back, so a delete can't be checked.");
      }
      if (s.readPath) {
        const read = await req(path(s.readPath, teamFor(h), id), { method: s.readMethod, headers }, env);
        expect(read.status, s.table + ": a deleted record is still readable after a restart").toBe(404);
      }
      if (s.listPath) {
        const list = await req(path(s.listPath, teamFor(h)), { method: s.listMethod, headers }, env);
        if (list.status === 200) {
          const rows = (await list.json()) as Row[];
          expect(rows.some((r) => String(r[s.idField]) === String(id)), s.table + ": a deleted record is still in the list after a restart").toBe(false);
        }
      }
    }
  }, LONG);

${
	meta.files
		? `  test("after a restart, A's 5 MB file comes back byte-identical, and B can't read or delete it (step 9)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const f = h.file as { id: string; parts: number; sha: string } | undefined;
    if (!f) throw new Error("The 5 MB file was never stored (see the upload check), so it can't be read back after the restart.");
    const cookie = String(h.aCookie);
    const chunks: Uint8Array[] = [];
    for (let n = 0; n < f.parts; n++) {
      const part = await req("/api/caddie/files/" + f.id + "/parts/" + n, { method: "GET", headers: { cookie } }, env);
      expect(part.status, "reading part " + n + " of A's file after a restart failed: " + part.status).toBe(200);
      chunks.push(new Uint8Array(Buffer.from(((await part.json()) as { data: string }).data, "base64")));
    }
    const whole = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      whole.set(chunk, at);
      at += chunk.length;
    }
    expect(await sha256Hex(whole), "A's 5 MB file came back changed after a restart (its sha256 differs)").toBe(f.sha);
    const { headers: bHeaders } = await signInForTest(app, env, "bo@example.com");
    const bRead = await req("/api/caddie/files/" + f.id + "/parts/0", { method: "GET", headers: bHeaders }, env);
    expect([403, 404], "B can read A's file").toContain(bRead.status);
    await req("/api/caddie/files/" + f.id, { method: "DELETE", headers: bHeaders }, env);
    const still = await req("/api/caddie/files/" + f.id + "/parts/0", { method: "GET", headers: { cookie } }, env);
    expect(still.status, "B deleted A's file").toBe(200);
  }, LONG);`
		: '  // (no file field in scope: the file check does not apply)'
}

${
	meta.payments
		? `  test("payments in test mode: a locked route needs a plan; the declined card leaves it shut, the paying card opens it, End now shuts it again (step 9)", async () => {
    const env = createFileEnv(FILE);
    const h = await readHandoff();
    const cookie = String(h.aCookie);
    const pay = META.payments!;
    const billing = await req("/api/caddie/billing", { method: "GET", headers: { cookie } }, env);
    if (billing.status === 404) throw new Error("This app takes payments, but Caddie's billing routes aren't mounted: call mountPayments(app, { currency, plans }) once in src/server.ts (caddie/payments.ts).");
    if (pay.locked.length === 0) {
      // No route needs a plan: the checkout itself must still work.
      const paid = await checkout(env, cookie, pay.firstPlan ?? "", "4242 4242 4242 4242");
      expect(paid.status, "the paying test card (4242 4242 4242 4242) was refused: " + paid.status + " " + (await paid.clone().text())).toBe(200);
      const ended = await endNow(env, cookie);
      expect(ended.status, "End now (test mode) failed: " + ended.status).toBe(200);
      return;
    }
    for (const locked of pay.locked) {
      const plan = locked.plans![0]!;
      const before = await req(path(locked.path, h.t1Id), sendInit(locked, { cookie }), env);
      expect(before.status, locked.id + ": a locked route answered " + before.status + " before checkout; it must answer 402 until the person has a plan").toBe(402);
      const reason = ((await before.json().catch(() => ({}))) as Row).reason;
      expect(reason, locked.id + ': before checkout a locked route answers { "reason": "plan_required" }').toBe("plan_required");
      const declined = await checkout(env, cookie, plan, "4000 0000 0000 0002");
      expect(declined.status, "the declined test card (4000 0000 0000 0002) must be refused with 402 (it answered " + declined.status + ")").toBe(402);
      const still = await req(path(locked.path, h.t1Id), sendInit(locked, { cookie }), env);
      expect(still.status, locked.id + ": after the declined card the route answered " + still.status + "; it must still answer 402").toBe(402);
      const paid = await checkout(env, cookie, plan, "4242 4242 4242 4242");
      expect(paid.status, "the paying test card (4242 4242 4242 4242) was refused for the " + plan + " plan: " + paid.status + " " + (await paid.clone().text())).toBe(200);
      const open = await req(path(locked.path, h.t1Id), sendInit(locked, { cookie }), env);
      expect(open.status !== 402 && open.status !== 401 && open.status !== 403 && open.status < 500, locked.id + ": after paying, the route must answer normally (it answered " + open.status + ")").toBe(true);
      const ended = await endNow(env, cookie);
      expect(ended.status, "End now (test mode) failed: " + ended.status).toBe(200);
      const shut = await req(path(locked.path, h.t1Id), sendInit(locked, { cookie }), env);
      expect(shut.status, locked.id + ": after End now the route answered " + shut.status + "; it must answer 402 again").toBe(402);
    }
  }, LONG);`
		: '  // (no payments in scope: the payment check does not apply)'
}

${
	meta.emails.length > 0
		? `  test("emails in test mode: each email's route stores exactly one message in the test inbox, with its template, and sends nothing (step 9)", async () => {
    const h = await readHandoff();
    const cookie = String(h.aCookie);
    for (const e of META.emails) {
      const env = createFileEnv(FILE);
      // A route behind a plan is opened with the paying card first, and ended after.
      if (e.route.plans) await checkout(env, cookie, e.route.plans[0]!, "4242 4242 4242 4242");
      const outside: string[] = [];
      const realFetch = globalThis.fetch;
      (globalThis as any).fetch = async (input: any) => {
        outside.push(String(typeof input === "string" ? input : input?.url));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      };
      let res: Response;
      try {
        res = await req(path(e.route.path, h.t1Id), sendInit(e.route, { cookie }), env);
      } finally {
        (globalThis as any).fetch = realFetch;
      }
      if (e.route.plans) await endNow(env, cookie);
      expect(res.status < 400, e.id + ": the " + e.route.id + " route answered " + res.status + " " + (await res.clone().text())).toBe(true);
      const inbox = env.CADDIE.emails;
      expect(inbox.length, e.id + ": the " + e.route.id + " route stored " + inbox.length + " messages in the test inbox; it must store exactly one, sent with env.CADDIE.email(...)").toBe(1);
      expect(inbox[0]!.template, e.id + ': the message must carry the template "' + e.id + '"').toBe(e.id);
      const field = e.to.startsWith("request-field:") ? e.to.slice("request-field:".length) : null;
      const to = field ? String(e.route.body[field] ?? "") : "ada@example.com";
      expect(inbox[0]!.to.toLowerCase(), e.id + ": the message must go to " + (field ? "the address in the request's " + field + " field" : "the signed-in person")).toBe(to.toLowerCase());
      expect(outside, e.id + ": the route also reached outside Caddie (" + outside.join(", ") + "); an email goes through env.CADDIE.email only, to the test inbox").toEqual([]);
    }
  }, LONG);`
		: '  // (no email in scope: the email check does not apply)'
}

${
	meta.jobs.length > 0
		? `  test("jobs: each job's route answers 401 without Caddie's signature and does its work with it (step 9)", async () => {
    const h = await readHandoff();
    for (const job of META.jobs) {
      const env = { ...createFileEnv(FILE), CADDIE_JOB_SECRET: JOB_SECRET };
      const bare = await req(path(job.route.path, h.t1Id), sendInit(job.route, {}), env);
      expect(bare.status, job.id + ": the " + job.route.id + " route answered " + bare.status + " without Caddie's signature; it must answer 401").toBe(401);
      const forged = await req(path(job.route.path, h.t1Id), sendInit(job.route, { [JOB_HEADER]: await jobSignature("not-caddies-secret", job.route.path) }), env);
      expect(forged.status, job.id + ": the route accepted a signature made with the wrong secret (it answered " + forged.status + ")").toBe(401);
      const signed = await req(path(job.route.path, h.t1Id), sendInit(job.route, { [JOB_HEADER]: await jobSignature(JOB_SECRET, job.route.path) }), env);
      expect(signed.status >= 200 && signed.status < 300, job.id + ": with Caddie's signature the job must do its work and answer 2xx (it answered " + signed.status + " " + (await signed.clone().text()) + ")").toBe(true);
    }
  }, LONG);`
		: '  // (no job in scope: the job check does not apply)'
}

${
	meta.unchecked.length > 0
		? `  test("every declared test-mode feature can be checked (step 9)", () => {
    expect(META.unchecked, "This design declares test-mode features that can't be checked: " + META.unchecked.join("; ") + ".").toEqual([]);
  });`
		: ''
}
}
`;
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
