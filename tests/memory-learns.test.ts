import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { D1Database } from "../apps/app/src/server/auth.ts";
import { projectScopeForUser } from "../apps/app/src/server/scope.ts";
import { ensureHomeProject } from "../apps/app/src/server/projects.ts";
import { createRun } from "../apps/app/src/server/runs.ts";
import { startProjectFromChat } from "../apps/app/src/server/build-workflow.ts";
import { resolveCoordinatorContext } from "../apps/app/src/server/coordinator-host.ts";
import { confirmMemoryFact, listMemoryFacts, memoryForInjection } from "../apps/app/src/server/memory.ts";
import { makeRememberFact } from "../apps/app/src/agents/tools.ts";
import { allMigrationPaths } from "./fixtures/migrations.ts";
import { splitSqlStatements } from "./fixtures/controls-harness.ts";

/**
 * Plan 6.2: memory learns. LOCAL VERIFIED over the real migrations and the
 * real coordinator host (no model): in a project's chat, what is said about
 * the project is kept with that project ("What Caddie knows" on its settings,
 * and only that project's chats are given it); what is about the person stays
 * with their account. Everything still starts as a proposal.
 */

function d1(sqlite: Database): D1Database {
  function statement(sql: string, args: unknown[] = []) {
    return {
      bind: (...values: unknown[]) => statement(sql, values),
      all: () => ({ results: sqlite.prepare(sql).all(...(args as never[])), meta: {} }),
      run: () => {
        const result = sqlite.prepare(sql).run(...(args as never[]));
        return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }
  return {
    prepare: statement,
    batch: (statements: { run(): unknown }[]) => sqlite.transaction(() => statements.map((s) => s.run()))(),
    exec: (sql: string) => sqlite.exec(sql),
  } as unknown as D1Database;
}

async function world() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const path of allMigrationPaths()) for (const s of splitSqlStatements(readFileSync(path, "utf8"))) sqlite.exec(s);
  sqlite
    .prepare("insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)")
    .run("alice", "alice", "alice@example.com", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z");
  const db = d1(sqlite);
  const home = await ensureHomeProject(db, "alice");
  const homeScope = await projectScopeForUser(db, "alice", home.id);
  await createRun(db, homeScope, { modelRouteId: "nemotron-3-super", payerId: "alice", conversationId: "conv-home-alice" });
  const started = await startProjectFromChat(db, homeScope, {
    name: "Goat clinic",
    description: "Sick-goat reminders",
    brief: "Build an app that reminds farmers when a goat needs the vet.",
    operationKey: "tool-create-goats",
    sourceConversationId: "conv-home-alice",
  });
  return { db, homeId: home.id, projectId: started.project.id, projectConversation: started.workflow.conversationId };
}

describe("memory learns: what is about the project stays with the project (plan 6.2)", () => {
  test("in a project's chat, a fact (or anything said to be about the project) is kept with that project", async () => {
    const w = await world();
    const host = await resolveCoordinatorContext({ DB: w.db }, w.projectConversation);
    await host.remember({ content: "The app is for farmers who keep goats", kind: "fact" });
    await host.remember({ content: "Reminders go out in Hausa", kind: "preference", about: "project" });
    const project = await listMemoryFacts(w.db, "alice", { projectId: w.projectId });
    expect(project.map((f) => [f.content, f.status]).sort()).toEqual([
      ["Reminders go out in Hausa", "proposed"],
      ["The app is for farmers who keep goats", "proposed"],
    ]);
    expect((await listMemoryFacts(w.db, "alice", {})).map((f) => f.content)).toEqual([]);
  });

  test("what is about the person stays with their account, in a project's chat as on Home", async () => {
    const w = await world();
    const inProject = await resolveCoordinatorContext({ DB: w.db }, w.projectConversation);
    await inProject.remember({ content: "Prefers TypeScript", kind: "preference" });
    await inProject.remember({ content: "Has shipped two React apps", kind: "fact", about: "you" });
    const home = await resolveCoordinatorContext({ DB: w.db }, "conv-home-alice");
    // Home is not a project: everything there is about the person.
    await home.remember({ content: "Works evenings", kind: "fact", about: "project" });
    expect((await listMemoryFacts(w.db, "alice", {})).map((f) => f.content).sort()).toEqual([
      "Has shipped two React apps",
      "Prefers TypeScript",
      "Works evenings",
    ]);
    expect(await listMemoryFacts(w.db, "alice", { projectId: w.projectId })).toEqual([]);
    expect(await listMemoryFacts(w.db, "alice", { projectId: w.homeId })).toEqual([]);
  });

  test("once confirmed, a project's fact is given to that project's chats only", async () => {
    const w = await world();
    const host = await resolveCoordinatorContext({ DB: w.db }, w.projectConversation);
    await host.remember({ content: "The app is for farmers who keep goats", kind: "fact" });
    const [fact] = await listMemoryFacts(w.db, "alice", { projectId: w.projectId });
    expect((await memoryForInjection(w.db, "alice", w.projectId)).map((f) => f.content)).toEqual([]);
    await confirmMemoryFact(w.db, "alice", fact!.id);
    expect((await memoryForInjection(w.db, "alice", w.projectId)).map((f) => f.content)).toEqual([
      "The app is for farmers who keep goats",
    ]);
    expect((await memoryForInjection(w.db, "alice", null)).map((f) => f.content)).toEqual([]);
  });

  test("the remember tool lets the model say who a memory is about", async () => {
    const calls: unknown[] = [];
    const tool = makeRememberFact({ remember: async (input) => (calls.push(input), { proposed: true }) });
    const run = (data: Record<string, unknown>) =>
      (tool as unknown as { run: (ctx: { data: Record<string, unknown> }) => Promise<{ output: string }> }).run({ data });
    await run({ content: "Reminders go out in Hausa", about: "project" });
    await run({ content: "Prefers TypeScript", kind: "preference", about: "you" });
    expect(calls).toEqual([
      { content: "Reminders go out in Hausa", kind: "preference", about: "project" },
      { content: "Prefers TypeScript", kind: "preference", about: "you" },
    ]);
    const description = (tool as unknown as { description: string }).description;
    expect(description).toContain("about");
    expect(description).toContain("project");
  });

  test("Caddie is told to remember what is said about a project, with that project", () => {
    const coordinator = readFileSync(new URL("../apps/app/src/agents/coordinator.ts", import.meta.url), "utf8");
    expect(coordinator).toContain(
      "When they tell you something lasting about this project (who it is for, what it must do, a decision), call remember with about 'project'",
    );
  });
});
