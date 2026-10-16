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
  stopWorkflow,
  setWorkflowBlocker,
} from "../apps/app/src/server/build-workflow.ts";
import {
  projectExperience,
  approvePlan,
} from "../apps/app/src/server/project-experience.ts";
import { splitSqlStatements } from "./fixtures/controls-harness.ts";

/**
 * LOCAL VERIFIED (R01): the shared ProjectExperience projection + approve-plan
 * command over real production migrations/services on in-memory SQLite with a
 * D1-shaped adapter and a real synchronous transaction behind D1.batch. No
 * model, sandbox or paid provider output is simulated — these exercise state
 * derivation and decision governance only.
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
  async function start() {
    const result = await startProjectFromChat(db, homeScope, {
      name: "Todo app",
      description: "A beautiful todo app",
      brief: "Build a modern minimal todo app with keyboard support, filters, and saved tasks. Show me the plan first.",
      operationKey: "tool-create-one",
      sourceConversationId: homeRun.conversationId,
    });
    const scope = await projectScopeForUser(db, "alice", result.project.id);
    return { ...result, scope };
  }
  return { db, sqlite, homeScope, start };
}

async function planned(w: Awaited<ReturnType<typeof world>>) {
  const started = await w.start();
  const plan = await createPlanDocRevision(w.db, started.scope, {
    kind: "prd",
    body: "# Todo app\n\nAdd, complete, delete, filter and persist tasks.",
  });
  await workflowSnapshot(w.db, started.scope); // move planning -> review on the new plan
  return { ...started, plan };
}

describe("ProjectExperience projection — stage mapping (table-driven)", () => {
  test("planning: no plan yet -> stage planning, single continue action", async () => {
    const w = await world();
    const started = await w.start();
    const exp = await projectExperience(w.db, started.scope);
    expect(exp.stage).toBe("planning");
    expect(exp.plan).toBeNull();
    expect(exp.preview).toBeNull();
    expect(exp.actions.filter((a) => a.primary)).toHaveLength(1);
    expect(exp.actions[0]!.kind).toBe("suggest_change");
  });

  test("review: plan ready, unapproved -> stage review, approve is the primary", async () => {
    const w = await world();
    const item = await planned(w);
    const exp = await projectExperience(w.db, item.scope);
    expect(exp.stage).toBe("review");
    expect(exp.plan).not.toBeNull();
    expect(exp.plan!.id).toBe(item.plan.id);
    expect(exp.plan!.approved).toBe(false);
    const primary = exp.actions.find((a) => a.primary)!;
    expect(primary.kind).toBe("approve_plan");
    expect(primary.enabled).toBe(true);
  });

  test("building: approved plan -> stage building, stop is the primary", async () => {
    const w = await world();
    const item = await planned(w);
    await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
    const exp = await projectExperience(w.db, item.scope);
    expect(exp.stage).toBe("building");
    expect(exp.plan!.approved).toBe(true);
    expect(exp.actions.find((a) => a.primary)!.kind).toBe("stop");
  });

  test("stopped: user stop -> stage stopped (distinct from blocked), resume primary", async () => {
    const w = await world();
    const item = await planned(w);
    await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
    await stopWorkflow(w.db, item.scope);
    const exp = await projectExperience(w.db, item.scope);
    expect(exp.stage).toBe("stopped");
    expect(exp.actions.find((a) => a.primary)!.kind).toBe("retry");
  });

  test("blocked: repair/infra block -> stage blocked (not stopped)", async () => {
    const w = await world();
    const item = await planned(w);
    await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
    await setWorkflowBlocker(w.db, item.scope, "The build sandbox is not configured. Your plan is saved.");
    const exp = await projectExperience(w.db, item.scope);
    expect(exp.stage).toBe("blocked");
    expect(exp.message).toContain("sandbox");
  });

  test("planning_blocked: a block BEFORE approval is a stuck plan, not a stuck build", async () => {
    const w = await world();
    const item = await planned(w); // plan exists, in review, NOT approved
    // Simulate the FarmLog failure: the planning continuation loop blocked the
    // workflow before any approval (useAgentFinish -> blockBuild).
    await setWorkflowBlocker(w.db, item.scope, "The plan revision was not saved. Ask Caddie to continue planning; your request and feedback are retained.");
    const exp = await projectExperience(w.db, item.scope);
    // Honest status: NOT the generic build-blocked state.
    expect(exp.stage).toBe("planning_blocked");
    expect(exp.plan!.approved).toBe(false);
    // Message tells the truth: nothing was built.
    expect(exp.message.toLowerCase()).toContain("nothing has been built");
    // The single action resumes PLANNING, worded for a plan — never "retry build".
    const primary = exp.actions.find((a) => a.primary)!;
    expect(primary.kind).toBe("retry");
    expect(primary.label).toBe("Continue the plan");
    expect(exp.actions.filter((a) => a.primary)).toHaveLength(1);
  });

  test("a stop before approval still reads as stopped, not planning_blocked", async () => {
    const w = await world();
    const item = await planned(w);
    // The STOP sentinel wins even when the plan is unapproved: an explicit user
    // stop is distinct from a plan that silently failed to save.
    await setWorkflowBlocker(w.db, item.scope, "Stop requested. Your plan and files are retained.");
    const exp = await projectExperience(w.db, item.scope);
    expect(exp.stage).toBe("stopped");
  });

  test("every stage offers exactly one primary action", async () => {
    const w = await world();
    const item = await planned(w);
    // review
    expect((await projectExperience(w.db, item.scope)).actions.filter((a) => a.primary)).toHaveLength(1);
    await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
    // building
    expect((await projectExperience(w.db, item.scope)).actions.filter((a) => a.primary)).toHaveLength(1);
  });
});

describe("approvePlan command — versioned + idempotent", () => {
  test("applied: correct version + revision approves and moves to building", async () => {
    const w = await world();
    const item = await planned(w);
    const before = await projectExperience(w.db, item.scope);
    const result = await approvePlan(w.db, item.scope, {
      projectId: item.scope.projectId,
      planRevisionId: before.plan!.id,
      expectedVersion: before.version,
      idempotencyKey: "approve-key-0001",
    });
    expect(result.outcome).toBe("applied");
    expect(result.experience.stage).toBe("building");
    expect(result.experience.plan!.approved).toBe(true);
  });

  test("noop: approving an already-approved revision is idempotent", async () => {
    const w = await world();
    const item = await planned(w);
    const before = await projectExperience(w.db, item.scope);
    await approvePlan(w.db, item.scope, {
      projectId: item.scope.projectId,
      planRevisionId: before.plan!.id,
      expectedVersion: before.version,
      idempotencyKey: "approve-key-0001",
    });
    const after = await projectExperience(w.db, item.scope);
    const again = await approvePlan(w.db, item.scope, {
      projectId: item.scope.projectId,
      planRevisionId: after.plan!.id,
      expectedVersion: after.version,
      idempotencyKey: "approve-key-0002",
    });
    expect(again.outcome).toBe("noop");
    expect(again.experience.plan!.approved).toBe(true);
  });

  test("stale: wrong expectedVersion is a refreshable conflict, no build", async () => {
    const w = await world();
    const item = await planned(w);
    const before = await projectExperience(w.db, item.scope);
    const result = await approvePlan(w.db, item.scope, {
      projectId: item.scope.projectId,
      planRevisionId: before.plan!.id,
      expectedVersion: before.version - 1,
      idempotencyKey: "approve-key-stale",
    });
    expect(result.outcome).toBe("stale");
    expect(result.code).toBe("STALE_VERSION");
    expect(result.experience.plan!.approved).toBe(false);
  });

  test("stale: wrong planRevisionId never builds a different plan", async () => {
    const w = await world();
    const item = await planned(w);
    const before = await projectExperience(w.db, item.scope);
    const result = await approvePlan(w.db, item.scope, {
      projectId: item.scope.projectId,
      planRevisionId: "rev-does-not-exist",
      expectedVersion: before.version,
      idempotencyKey: "approve-key-wrong-rev",
    });
    expect(result.outcome).toBe("stale");
    expect(result.code).toBe("STALE_PLAN");
    expect(result.experience.plan!.approved).toBe(false);
  });

  test("denied: a body projectId that mismatches the scope is refused, not retargeted", async () => {
    const w = await world();
    const item = await planned(w);
    const before = await projectExperience(w.db, item.scope);
    const result = await approvePlan(w.db, item.scope, {
      projectId: "proj_someone_else",
      planRevisionId: before.plan!.id,
      expectedVersion: before.version,
      idempotencyKey: "approve-key-mismatch",
    });
    expect(result.outcome).toBe("denied");
    expect(result.code).toBe("PROJECT_MISMATCH");
  });
});
