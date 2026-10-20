import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { D1Database } from "../apps/app/src/server/auth.ts";
import { confirmMemoryFact, listMemoryFacts, memoryForInjection, proposeMemoryFact, retractMemoryFact } from "../apps/app/src/server/memory.ts";
import {
  STATED_SOURCE_PREFIX,
  captureStatedPreferences,
  memoryOffers,
  statedPreferences,
} from "../apps/app/src/server/stated-preference.ts";
import { ensureHomeProject } from "../apps/app/src/server/projects.ts";
import { projectScopeForUser } from "../apps/app/src/server/scope.ts";
import { createRun } from "../apps/app/src/server/runs.ts";
import { allMigrationPaths } from "./fixtures/migrations.ts";
import { splitSqlStatements } from "./fixtures/controls-harness.ts";

/**
 * Plan 6.2: memory learns. A lasting preference the person states in a
 * message ("Always use TypeScript.", "From now on keep replies short.") is
 * offered to remember even when Caddie itself didn't call remember. It is a
 * PROPOSAL about the person: nothing reaches a future conversation until they
 * confirm it. LOCAL VERIFIED over the real migrations, no model.
 */

function d1(sqlite: Database): D1Database {
  function statement(sql: string, args: unknown[] = []) {
    return {
      bind: (...values: unknown[]) => statement(sql, values),
      all: () => ({ results: sqlite.prepare(sql).all(...(args as never[])), meta: {} }),
      run: () => {
        const result = sqlite.prepare(sql).run(...(args as never[]));
        return { success: true, results: [], meta: { changes: result.changes } };
      },
    };
  }
  return {
    prepare: statement,
    batch: (statements: { run(): unknown }[]) => sqlite.transaction(() => statements.map((s) => s.run()))(),
  } as unknown as D1Database;
}

function world(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const path of allMigrationPaths()) for (const s of splitSqlStatements(readFileSync(path, "utf8"))) sqlite.exec(s);
  sqlite
    .prepare("insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)")
    .run("alice", "alice", "alice@example.com", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z");
  return d1(sqlite);
}

describe("a lasting preference the person states is offered to remember (plan 6.2)", () => {
  test("picks lasting preferences out of what the person wrote", () => {
    expect(statedPreferences("Always use TypeScript. Thanks!")).toEqual(["Always use TypeScript."]);
    expect(statedPreferences("from now on keep your replies short")).toEqual(["from now on keep your replies short"]);
    expect(statedPreferences("I prefer dark screens. Also I\u2019d rather you ask before big changes.")).toEqual([
      "I prefer dark screens.",
      "Also I\u2019d rather you ask before big changes.",
    ]);
    expect(statedPreferences("Please never use emojis in my app.\nGoing forward, write in Hausa first.")).toEqual([
      "Please never use emojis in my app.",
      "Going forward, write in Hausa first.",
    ]);
  });

  test("passes over questions, passing remarks, permission and private details", () => {
    for (const text of [
      "Can you always reply in Hausa?",
      "The app should never crash.",
      "I never got the email.",
      "Never mind, show me the plan.",
      "Never again!",
      "Always deploy without asking me.",
      "From now on you can spend up to $50.",
      "Never share my number 08031234567 with anyone.",
      "I prefer https://example.com for docs.",
      "I prefer mail at ada@example.com.",
      `Always use ${"very ".repeat(70)}long names.`,
      "",
    ]) {
      expect(statedPreferences(text)).toEqual([]);
    }
    expect(statedPreferences(null)).toEqual([]);
    // Two at most from one message.
    expect(statedPreferences("Always use TypeScript. Never use emojis. I prefer dark screens.")).toEqual([
      "Always use TypeScript.",
      "Never use emojis.",
    ]);
  });

  test("each is proposed once, as a preference about the person, and waits for their OK", async () => {
    const db = world();
    const proposed = await captureStatedPreferences(db, { actorId: "alice", runId: "run-1" }, { kind: "user", body: "Always use TypeScript. What next?" });
    expect(proposed.map((f) => [f.content, f.kind, f.status, f.projectId, f.sourceRunId])).toEqual([
      ["Always use TypeScript.", "preference", "proposed", null, `${STATED_SOURCE_PREFIX}run-1`],
    ]);
    // Nothing is given to a conversation until the person confirms it.
    expect(await memoryForInjection(db, "alice", null)).toEqual([]);
    // Saying it again offers nothing new; nor does saying it after "Not now".
    expect(await captureStatedPreferences(db, { actorId: "alice", runId: "run-2" }, { kind: "user", body: "always use typescript" })).toEqual([]);
    await retractMemoryFact(db, "alice", proposed[0]!.id);
    expect(await captureStatedPreferences(db, { actorId: "alice", runId: "run-3" }, { kind: "user", body: "Always use TypeScript!" })).toEqual([]);
    // Only the person's own words, and only text.
    expect(await captureStatedPreferences(db, { actorId: "alice", runId: "run-4" }, { kind: "system", body: "Never use emojis." })).toEqual([]);
    expect(await captureStatedPreferences(db, { actorId: "alice", runId: "run-4" }, null)).toEqual([]);
    expect((await listMemoryFacts(db, "alice", { includeRetracted: true })).map((f) => f.content)).toEqual(["Always use TypeScript."]);
  });

  test("the person's own messages are read for it, never Caddie's own dispatches, and a failure never stops the message", () => {
    const runs = readFileSync(new URL("../apps/app/src/server/routes/runs.ts", import.meta.url), "utf8");
    const branch = runs.slice(runs.indexOf("if (!fromServer) {"), runs.indexOf("await next();", runs.indexOf("if (!fromServer) {")));
    expect(branch).toContain("captureStatedPreferences(");
    expect(branch).toContain("catch");
  });
});

describe("the chat offers what is waiting for the person's OK (plan 6.2)", () => {
  test("a project's offers are the person's own proposals from that project's chats, while they wait", async () => {
    const db = world();
    const home = await ensureHomeProject(db, "alice");
    const run = await createRun(db, await projectScopeForUser(db, "alice", home.id), {
      modelRouteId: "nemotron-3-super",
      payerId: "alice",
      conversationId: "conv-offers",
    });
    // What the person stated, and what Caddie itself proposed with remember.
    await captureStatedPreferences(db, { actorId: "alice", runId: run.runId }, { kind: "user", body: "Always use TypeScript." });
    await proposeMemoryFact(db, "alice", { kind: "fact", content: "Builds apps for goat farmers", sourceRunId: run.runId });
    // Proposals from outside this project's chats are not offered here.
    await proposeMemoryFact(db, "alice", { kind: "fact", content: "From an import", sourceRunId: "import:abc" });
    const offers = await memoryOffers(db, "alice", home.id);
    expect(offers.map((o) => o.content)).toEqual(["Always use TypeScript.", "Builds apps for goat farmers"]);
    expect(Object.keys(offers[0]!).sort()).toEqual(["content", "id"]);

    // Remembered or declined, an offer stops waiting.
    await confirmMemoryFact(db, "alice", offers[0]!.id);
    await retractMemoryFact(db, "alice", offers[1]!.id);
    expect(await memoryOffers(db, "alice", home.id)).toEqual([]);
  });

  test("another person never sees them", async () => {
    const db = world();
    const home = await ensureHomeProject(db, "alice");
    const run = await createRun(db, await projectScopeForUser(db, "alice", home.id), {
      modelRouteId: "nemotron-3-super",
      payerId: "alice",
      conversationId: "conv-private",
    });
    await captureStatedPreferences(db, { actorId: "alice", runId: run.runId }, { kind: "user", body: "Never use emojis." });
    expect(await memoryOffers(db, "mallory", home.id)).toEqual([]);
    expect((await memoryOffers(db, "alice", home.id)).map((o) => o.content)).toEqual(["Never use emojis."]);
  });

  test("the offers route answers only for the signed-in person", () => {
    const profile = readFileSync(new URL("../apps/app/src/server/routes/profile.ts", import.meta.url), "utf8");
    const route = profile.slice(profile.indexOf("router.get('/memory/offers'"));
    expect(route.slice(0, 400)).toContain("requireSessionActorId(");
    expect(route.slice(0, 400)).toContain("memoryOffers(c.env.DB, actorId,");
  });
});
