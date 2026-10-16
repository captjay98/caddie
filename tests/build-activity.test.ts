import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { D1Database } from "../apps/app/src/server/auth.ts";
import { projectScopeForUser } from "../apps/app/src/server/scope.ts";
import {
  ensureHomeProject,
  createPlanDocRevision,
} from "../apps/app/src/server/projects.ts";
import { createRun } from "../apps/app/src/server/runs.ts";
import {
  startProjectFromChat,
  decideWorkflow,
  workflowSnapshot,
  setWorkflowBlocker,
} from "../apps/app/src/server/build-workflow.ts";
import { recordRepairRound } from "../apps/app/src/server/runs.ts";
import { buildActivity, recordBuildActivity } from "../apps/app/src/server/build-activity.ts";
import { splitSqlStatements } from "./fixtures/controls-harness.ts";

/**
 * LOCAL VERIFIED (R06 build-progress): the honest build-activity projection
 * over real migrations/services on in-memory SQLite with a D1-shaped adapter.
 * Every step and round is derived from real workflow phase + run_rounds rows;
 * nothing is simulated model output.
 */
function d1Adapter(sqlite: Database): D1Database {
  function statement(sql: string, args: unknown[] = []) {
    return {
      bind(...values: unknown[]) {
        return statement(sql, values);
      },
      all() {
        return { results: sqlite.prepare(sql).all(...(args as never[])), meta: {} };
      },
      run() {
        const result = sqlite.prepare(sql).run(...(args as never[]));
        return {
          success: true,
          results: [],
          meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
        };
      },
    };
  }
  return {
    prepare: statement,
    batch(statements: { run(): unknown }[]) {
      return sqlite.transaction(() => statements.map((stmt) => stmt.run()))();
    },
    exec(sql: string) {
      sqlite.exec(sql);
    },
  } as unknown as D1Database;
}

async function world() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const migration of [
    "0001_product.sql",
    "0002_controls.sql",
    "0003_artifacts.sql",
    "0005_runs.sql",
    "0008_profile.sql",
    "0017_profile_preferences.sql",
    "0011_home_project.sql",
    "0015_plan_decisions.sql",
    "0018_build_workflow.sql",
    "0022_build_activity.sql",
  ]) {
    const ddl = readFileSync(new URL(`../apps/app/migrations/${migration}`, import.meta.url), "utf8");
    for (const statement of splitSqlStatements(ddl)) sqlite.exec(statement);
  }
  sqlite
    .prepare("insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)")
    .run("alice", "alice", "alice@example.com", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z");
  const db = d1Adapter(sqlite);
  const home = await ensureHomeProject(db, "alice");
  const homeScope = await projectScopeForUser(db, "alice", home.id);
  const homeRun = await createRun(db, homeScope, {
    modelRouteId: "nemotron-3-super",
    payerId: "alice",
    conversationId: "conv-home-alice",
  });
  async function planned() {
    const started = await startProjectFromChat(db, homeScope, {
      name: "Todo app",
      description: "A beautiful todo app",
      brief: "Build a modern minimal todo app with keyboard support, filters, and saved tasks. Show me the plan first.",
      operationKey: "tool-create-one",
      sourceConversationId: homeRun.conversationId,
    });
    const scope = await projectScopeForUser(db, "alice", started.project.id);
    const plan = await createPlanDocRevision(db, scope, {
      kind: "prd",
      body: "# Todo app\n\nAdd, complete, delete, filter and persist tasks.",
    });
    await workflowSnapshot(db, scope); // planning -> review
    return { scope, plan, workflow: started.workflow };
  }
  return { db, planned };
}

describe("buildActivity — honest build-progress projection", () => {
  test("planning/review: no build steps are active yet", async () => {
    const w = await world();
    const item = await w.planned();
    const activity = await buildActivity(w.db, item.scope);
    expect(activity.phase).toBe("review");
    expect(activity.building).toBe(false);
    expect(activity.steps.every((s) => s.state === "pending")).toBe(true);
    expect(activity.rounds).toHaveLength(0);
  });

  test("building with no rounds yet: implement is active, check is pending", async () => {
    const w = await world();
    const item = await w.planned();
    await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
    const activity = await buildActivity(w.db, item.scope);
    expect(activity.phase).toBe("building");
    expect(activity.building).toBe(true);
    const byKey = Object.fromEntries(activity.steps.map((s) => [s.key, s.state]));
    expect(byKey.scaffold).toBe("done");
    expect(byKey.implement).toBe("active");
    expect(byKey.check).toBe("pending");
    expect(byKey.preview).toBe("pending");
  });

  test("building after a verification round: the check step becomes active and history is real", async () => {
    const w = await world();
    const item = await w.planned();
    await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
    const snap = await workflowSnapshot(w.db, item.scope);
    await recordRepairRound(w.db, item.scope, snap.workflow!.runId, {
      issue: "saved-tasks",
      round: "repair_attempt",
      outcome: "failed",
      detail: "Reload drops the saved tasks.",
    });
    const activity = await buildActivity(w.db, item.scope);
    const byKey = Object.fromEntries(activity.steps.map((s) => [s.key, s.state]));
    expect(byKey.implement).toBe("done");
    expect(byKey.check).toBe("active");
    expect(activity.rounds).toHaveLength(1);
    expect(activity.rounds[0]!.issue).toBe("saved-tasks");
    expect(activity.rounds[0]!.outcome).toBe("failed");
    expect(activity.openIssues).toBe(1);
  });

  test("blocked mid-build: check is where it stuck, preview never shown", async () => {
    const w = await world();
    const item = await w.planned();
    await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
    await setWorkflowBlocker(w.db, item.scope, "The saved-task check still fails after three attempts.");
    const activity = await buildActivity(w.db, item.scope);
    const byKey = Object.fromEntries(activity.steps.map((s) => [s.key, s.state]));
    expect(activity.phase).toBe("blocked");
    expect(byKey.preview).toBe("pending");
  });

  test("recorded sandbox actions become the timeline: files, real test counts, plan scope; replays are deduplicated", async () => {
    const w = await world();
    const item = await w.planned();
    await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
    const runId = (await workflowSnapshot(w.db, item.scope)).workflow!.runId;
    const base = { projectId: item.scope.projectId, runId };
    await recordBuildActivity(w.db, { ...base, kind: "file", subject: `/workspace/${item.scope.projectId}/src/App.tsx`, outcome: "ok", bytes: 1200, startedAt: "2026-10-15T19:12:00.000Z", finishedAt: "2026-10-15T19:12:01.000Z" });
    const testRun = {
      ...base, kind: "command" as const, subject: `cd /workspace/${item.scope.projectId} && bun test src/`,
      outcome: "failed" as const, exitCode: 1, output: "bun test v1.3.14\n 5 pass\n 1 fail\n",
      startedAt: "2026-10-15T19:13:00.000Z", finishedAt: "2026-10-15T19:13:20.000Z", key: "exec:op-1",
    };
    await recordBuildActivity(w.db, testRun);
    await recordBuildActivity(w.db, testRun); // DO recovery replays the same operation

    const activity = await buildActivity(w.db, item.scope, Date.parse("2026-10-15T19:14:00.000Z"));
    const t = activity.timeline;
    expect(t.files.map((f) => f.path)).toEqual(["src/App.tsx"]);
    expect(t.commands).toHaveLength(1);
    expect(t.commands[0]!.command).toBe("bun test src/");
    expect(t.tests).toMatchObject({ passed: 5, failed: 1 });
    // The fixture plan ("Add, complete, delete, filter and persist tasks.") has
    // no feature list, so no scope is invented. planScope parsing is covered in
    // tests/build-timeline.test.ts.
    expect(t.scope).toEqual([]);
    expect(t.elapsedMs).toBe(2 * 60_000);
  });

  test("recording never throws, even when the table is missing", async () => {
    const sqlite = new Database(":memory:");
    const db = d1Adapter(sqlite);
    await expect(
      recordBuildActivity(db, { projectId: "p", runId: "r", kind: "file", subject: "a.ts", outcome: "ok", startedAt: "2026-10-15T00:00:00.000Z", finishedAt: "2026-10-15T00:00:01.000Z" }),
    ).resolves.toBeUndefined();
  });
});
