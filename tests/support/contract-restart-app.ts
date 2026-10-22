// Test-only helper for the S4 spike (tests/contract-restart-spike.test.ts).
//
// It materialises a REAL react-hono starter app (the same SCAFFOLD_FILES the
// host writes) into a temp directory, then adds the files a generated contract
// test for part E would need:
//
//   - migrations/0001_records.sql          the app's one table (owner-scoped)
//   - src/server.ts                         real Hono CRUD routes, owner-filtered
//   - src/RecordsScreen.tsx                 a screen that fetches the REAL server
//   - test/setup/d1-file.ts                 a FILE-BACKED copy of the SAME db
//                                           wrapper shipped in test/setup/d1.ts,
//                                           opening a path instead of :memory:
//   - caddie/contract-create.test.ts        process 1: A creates a record
//   - caddie/contract-restart.test.ts       process 2: reopen the file, read it
//   - caddie/contract-screen.test.tsx       same process: screen + privacy (B)
//
// The point of the spike: prove the SAME wrapper works file-backed across two
// separate `bun test` runs, that the starter's migrations apply to the file
// database the same way they do in-memory, that signInForTest gives two real
// accounts, and that a happy-dom screen whose fetch hits the real server sees
// A's record and not B's. No paid calls, no sandbox.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { SCAFFOLD_BASE_FILES } from "../../stacks/react-hono/scaffold.ts";
import { SCAFFOLD_LOCKFILE } from "../../stacks/react-hono/scaffold-lock.ts";

const bun = process.execPath;

/** The app's one owner-scoped table. A builder-written migration (0001). */
const RECORDS_MIGRATION = [
	"create table records (",
	"  id integer primary key autoincrement,",
	"  ownerId text not null,",
	"  name text not null,",
	"  createdAt text not null default (datetime('now'))",
	");",
	"create index records_owner on records (ownerId);",
	"",
].join("\n");

/**
 * A real app server: sign-in mounted, a records table scoped to the signed-in
 * person. This is exactly the kind of code a correct builder writes, and the
 * generated contract test checks its create / read / list / privacy behaviour.
 */
const APP_SERVER = [
	'import { Hono } from "hono";',
	'import type { D1Database } from "../caddie/d1";',
	'import type { CaddiePlatform } from "../caddie/platform";',
	'import { mountSignIn, requireUser } from "../caddie/auth";',
	"",
	"export type Env = { DB: D1Database; CADDIE: CaddiePlatform; CADDIE_AUTH_SECRET?: string };",
	"",
	'export const app = new Hono<{ Bindings: Env }>().basePath("/api");',
	"",
	'app.get("/health", (c) => c.json({ ok: true }));',
	"mountSignIn(app);",
	"",
	'app.post("/records", async (c) => {',
	"  const user = await requireUser(c);",
	"  const { name } = await c.req.json<{ name: string }>();",
	'  const row = await c.env.DB.prepare("insert into records (ownerId, name) values (?, ?) returning id, name")',
	"    .bind(user.id, name)",
	"    .first<{ id: number; name: string }>();",
	"  return c.json(row, 201);",
	"});",
	"",
	'app.get("/records", async (c) => {',
	"  const user = await requireUser(c);",
	'  const { results } = await c.env.DB.prepare("select id, name from records where ownerId = ? order by id")',
	"    .bind(user.id)",
	"    .all<{ id: number; name: string }>();",
	"  return c.json(results);",
	"});",
	"",
	'app.get("/records/:id", async (c) => {',
	"  const user = await requireUser(c);",
	'  const row = await c.env.DB.prepare("select id, name from records where id = ? and ownerId = ?")',
	"    .bind(Number(c.req.param(\"id\")), user.id)",
	"    .first<{ id: number; name: string }>();",
	'  if (!row) return c.json({ error: "Not found." }, 404);',
	"  return c.json(row);",
	"});",
	"",
	"export default app;",
	"",
].join("\n");

/**
 * The screen. It fetches the REAL server (part E step 8: fetch goes to the
 * server, never a faked reply) through the app's own caddie/api helper shape,
 * which here is a plain fetch to /api/records. The spike wires globalThis.fetch
 * to app.request in the test, so this is the real round trip, in happy-dom.
 */
const RECORDS_SCREEN = [
	'import { useEffect, useState } from "react";',
	"",
	"export function RecordsScreen() {",
	"  const [names, setNames] = useState<string[] | null>(null);",
	"  useEffect(() => {",
	'    fetch("/api/records")',
	"      .then((r) => (r.ok ? r.json() : []))",
	"      .then((rows: { name: string }[]) => setNames(rows.map((r) => r.name)))",
	"      .catch(() => setNames([]));",
	"  }, []);",
	'  if (names === null) return <p>Loading…</p>;',
	"  return (",
	"    <ul>",
	"      {names.map((name) => (",
	"        <li key={name}>{name}</li>",
	"      ))}",
	"    </ul>",
	"  );",
	"}",
	"",
].join("\n");

/**
 * A FILE-BACKED copy of the SAME wrapper shipped in test/setup/d1.ts. The only
 * change from the shipped wrapper is the Database path: a file instead of
 * ":memory:", opened from CADDIE_TEST_DB_FILE. Everything else — the Statement
 * class, meta(), the migration application loop, createTestEnv() — is byte
 * identical, so this proves the SAME wrapper works file-backed. A separate
 * process opening the same path sees what the first process wrote.
 */
const D1_FILE = [
	"// Test-only, file-backed variant of test/setup/d1.ts for the restart check.",
	"// It re-exports the shipped wrapper's internals and swaps only the Database",
	"// target from :memory: to the file at CADDIE_TEST_DB_FILE.",
	'import { Database } from "bun:sqlite";',
	'import { existsSync, readdirSync, readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	'import type { D1Database } from "../../caddie/d1";',
	'import { splitStatements } from "./d1";',
	'import { createTestCaddie, type TestCaddie } from "./caddie";',
	'import { TEST_AUTH_SECRET } from "./d1";',
	"",
	'const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");',
	"",
	"function value(input: unknown): unknown {",
	"  if (input === undefined) throw new Error(\"D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'\");",
	'  if (typeof input === "boolean") return input ? 1 : 0;',
	"  return input;",
	"}",
	"",
	"function d1Error(error: unknown): Error {",
	"  const message = error instanceof Error ? error.message : String(error);",
	'  return new Error(message.startsWith("D1_") ? message : "D1_ERROR: " + message);',
	"}",
	"",
	"class Statement {",
	"  constructor(private readonly db: Database, private readonly sql: string, private readonly params: unknown[] = []) {}",
	"  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values.map(value)); }",
	"  private execute() {",
	"    try {",
	"      const prepared = this.db.prepare(this.sql);",
	"      const columns = prepared.columnNames;",
	"      if (columns.length > 0) {",
	"        const rows = prepared.all(...(this.params as never[])) as Record<string, unknown>[];",
	"        return { rows, columns };",
	"      }",
	"      const result = prepared.run(...(this.params as never[]));",
	"      return { rows: [] as Record<string, unknown>[], columns, lastRowId: Number(result.lastInsertRowid), changes: result.changes };",
	"    } catch (error) { throw d1Error(error); }",
	"  }",
	"  async first<T = unknown>(column?: string): Promise<T | null> {",
	"    const row = this.execute().rows[0];",
	"    if (row === undefined) return null;",
	"    if (column === undefined) return row as T;",
	"    return (row as Record<string, unknown>)[column] as T;",
	"  }",
	"  async all<T = Record<string, unknown>>() {",
	"    const { rows } = this.execute();",
	"    return { results: rows as T[], success: true as const, meta: {} };",
	"  }",
	"  async run<T = Record<string, unknown>>() { return this.all<T>(); }",
	"}",
	"",
	"/** The SAME wrapper as test/setup/d1.ts, but over a file so a second process can reopen it. */",
	"export function createFileDatabase(file: string): D1Database {",
	"  const db = new Database(file);",
	'  db.exec("pragma journal_mode = wal;");',
	"  const applied = db.prepare(\"select count(*) as n from sqlite_master where type = 'table' and name = 'records'\").get() as { n: number };",
	"  if (applied.n === 0 && existsSync(MIGRATIONS)) {",
	"    const files = readdirSync(MIGRATIONS).filter((name) => /^\\d{4}_.+\\.sql$/.test(name)).sort();",
	"    for (const name of files) {",
	'      for (const sql of splitStatements(readFileSync(join(MIGRATIONS, name), "utf8"))) db.exec(sql);',
	"    }",
	"  }",
	"  return {",
	"    prepare: (query: string) => new Statement(db, query) as never,",
	"    async batch(statements: never[]) { return db.transaction(() => statements.map((s) => (s as unknown as Statement)))() as never; },",
	"    async exec(query: string) { for (const sql of splitStatements(query)) db.exec(sql); return { count: 1, duration: 0 } as never; },",
	"  } as D1Database;",
	"}",
	"",
	"export function createFileEnv(file: string): { DB: D1Database; CADDIE: TestCaddie; CADDIE_AUTH_SECRET: string } {",
	"  return { DB: createFileDatabase(file), CADDIE: createTestCaddie(), CADDIE_AUTH_SECRET: TEST_AUTH_SECRET };",
	"}",
	"",
].join("\n");

// ---- generated-style contract test files -----------------------------------
//
// These are what the host would write as caddie/contract.test.ts, split into
// the three runs the restart check needs. They live under caddie/ in the temp
// app. The spike proves they work; the real generator would emit one file that
// the host runs as described in the report.

const CONTRACT_CREATE = [
	"// Process 1 of the restart check: A signs in and creates a record in the",
	"// FILE database at CADDIE_TEST_DB_FILE. The process then ends.",
	'import { expect, test } from "bun:test";',
	'import { app } from "../src/server";',
	'import { signInForTest } from "../test/setup/auth";',
	'import { createFileEnv } from "../test/setup/d1-file";',
	"",
	'const file = process.env.CADDIE_TEST_DB_FILE!;',
	"",
	'test("A creates a record through the real routes (file db)", async () => {',
	"  const env = createFileEnv(file);",
	'  const { headers, user } = await signInForTest(app, env, "ada@example.com");',
	'  expect(user.email).toBe("ada@example.com");',
	'  const res = await app.request("/api/records", {',
	'    method: "POST",',
	'    headers: { "content-type": "application/json", ...headers },',
	'    body: JSON.stringify({ name: "Daisy" }),',
	"  }, env);",
	"  expect(res.status).toBe(201);",
	"  const row = (await res.json()) as { id: number; name: string };",
	'  expect(row.name).toBe("Daisy");',
	"  // Hand the created id and A's cookie to process 2 through a side file.",
	'  await Bun.write(file + ".handoff.json", JSON.stringify({ id: row.id, cookie: headers.cookie, ownerId: user.id }));',
	"});",
	"",
].join("\n");

const CONTRACT_RESTART = [
	"// Process 2 of the restart check: a SEPARATE `bun test` run opens the same",
	"// file and reads the record A created — by id and in the list — with the",
	"// same cookie. This is create -> restart -> read across two processes.",
	'import { expect, test } from "bun:test";',
	'import { app } from "../src/server";',
	'import { createFileEnv } from "../test/setup/d1-file";',
	"",
	'const file = process.env.CADDIE_TEST_DB_FILE!;',
	"",
	'test("after restart, A reads the record by id and in the list", async () => {',
	"  const env = createFileEnv(file);",
	'  const handoff = (await Bun.file(file + ".handoff.json").json()) as { id: number; cookie: string };',
	'  const headers = { cookie: handoff.cookie };',
	"",
	'  const byId = await app.request("/api/records/" + handoff.id, { headers }, env);',
	"  expect(byId.status).toBe(200);",
	'  expect(((await byId.json()) as { name: string }).name).toBe("Daisy");',
	"",
	'  const list = await app.request("/api/records", { headers }, env);',
	"  const rows = (await list.json()) as { id: number; name: string }[];",
	'  expect(rows).toEqual([{ id: handoff.id, name: "Daisy" }]);',
	"});",
	"",
].join("\n");

const CONTRACT_SCREEN = [
	"// Same process: (step 5) a second signed-in person B cannot read A's record,",
	"// and (step 8) the screen, whose fetch goes to the REAL server, shows A's",
	"// record for A and not for B. happy-dom is registered by the app's bunfig.",
	'import { afterEach, beforeEach, expect, test } from "bun:test";',
	'import { render, screen, waitFor } from "@testing-library/react";',
	'import { app } from "../src/server";',
	'import { signInForTest } from "../test/setup/auth";',
	'import { createFileEnv } from "../test/setup/d1-file";',
	'import { RecordsScreen } from "../src/RecordsScreen";',
	"",
	'const file = process.env.CADDIE_TEST_DB_FILE!;',
	"const realFetch = globalThis.fetch;",
	"",
	"// Route the screen's fetch to the real server through app.request, carrying",
	"// the person's cookie. This is the real round trip, not a faked reply.",
	"function serveAs(cookie: string, env: ReturnType<typeof createFileEnv>) {",
	"  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {",
	'    const path = typeof input === "string" ? input : input.toString();',
	'    return app.request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } }, env);',
	"  }) as typeof fetch;",
	"}",
	"afterEach(() => { globalThis.fetch = realFetch; });",
	"",
	'test("the screen shows the record A saved (real server fetch)", async () => {',
	"  const env = createFileEnv(file);",
	'  const { headers } = await signInForTest(app, env, "ada@example.com");',
	"  serveAs(headers.cookie, env);",
	"  render(<RecordsScreen />);",
	'  await waitFor(() => expect(screen.getByText("Daisy")).toBeInTheDocument());',
	"});",
	"",
	'test("B does not see A\'s record, on the server and on the screen", async () => {',
	"  const env = createFileEnv(file);",
	'  const { headers } = await signInForTest(app, env, "bo@example.com");',
	"  // Server: B's list is empty.",
	'  const list = await app.request("/api/records", { headers }, env);',
	"  expect(await list.json()).toEqual([]);",
	"  // Screen: nothing renders for B.",
	"  serveAs(headers.cookie, env);",
	"  render(<RecordsScreen />);",
	'  await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());',
	'  expect(screen.queryByText("Daisy")).not.toBeInTheDocument();',
	"});",
	"",
].join("\n");

const EXTRA_FILES: Record<string, string> = {
	"migrations/0001_records.sql": RECORDS_MIGRATION,
	"src/server.ts": APP_SERVER,
	"src/RecordsScreen.tsx": RECORDS_SCREEN,
	"test/setup/d1-file.ts": D1_FILE,
	"caddie/contract-create.test.ts": CONTRACT_CREATE,
	"caddie/contract-restart.test.ts": CONTRACT_RESTART,
	"caddie/contract-screen.test.tsx": CONTRACT_SCREEN,
};

export interface MaterializedApp {
	dir: string;
	dbFile: string;
	cleanup(): void;
}

function write(dir: string, path: string, text: string): void {
	const full = join(dir, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/** Materialise the starter + the contract-test files, and `bun install --frozen-lockfile`. */
export function materializeApp(): MaterializedApp {
	if (!SCAFFOLD_LOCKFILE) throw new Error("scaffold-lock.ts is empty; run scripts/refresh-scaffold-lock.ts first");
	const dir = mkdtempSync(join(tmpdir(), "caddie-s4-"));
	for (const [path, text] of Object.entries(SCAFFOLD_BASE_FILES)) write(dir, path, text);
	write(dir, "bun.lock", SCAFFOLD_LOCKFILE);
	for (const [path, text] of Object.entries(EXTRA_FILES)) write(dir, path, text);

	const install = spawnSync(bun, ["install", "--frozen-lockfile"], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
	if ((install.status ?? 1) !== 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(`bun install --frozen-lockfile failed:\n${install.stdout}\n${install.stderr}`);
	}
	return {
		dir,
		dbFile: join(dir, "contract-restart.sqlite"),
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Run `bun test <file>` inside the app, with CADDIE_TEST_DB_FILE pointing at the file db. */
export function runAppTest(app: MaterializedApp, testFile: string): { ok: boolean; out: string } {
	const result = spawnSync(bun, ["test", testFile], {
		cwd: app.dir,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1", CADDIE_TEST_DB_FILE: app.dbFile },
	});
	return { ok: (result.status ?? 1) === 0, out: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}
