import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { D1Database } from "../apps/app/src/server/auth.ts";
import { projectScopeForUser } from "../apps/app/src/server/scope.ts";
import { ensureHomeProject, createPlanDocRevision } from "../apps/app/src/server/projects.ts";
import { createRun } from "../apps/app/src/server/runs.ts";
import {
  startProjectFromChat,
  workflowSnapshot,
} from "../apps/app/src/server/build-workflow.ts";
import { projectExperience, approvePlan } from "../apps/app/src/server/project-experience.ts";

/**
 * R06 LOCAL VERIFIED: the shared ProjectExperience projection and the
 * approve-plan command are the ONE source the workspace + chat consume. This
 * exercises the server functions the new `/experience` and
 * `/experience/approve` routes call, over the in-memory D1 harness. The
 * browser consolidation (Overview/Plan/Preview layout) and its screenshots are
 * the BROWSER gate, deferred (same wrangler-fixture environmental block as the
 * rest of this run).
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
        return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
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
  for (const m of [
    "0001_product.sql", "0002_controls.sql", "0003_artifacts.sql", "0005_runs.sql",
    "0008_profile.sql", "0017_profile_preferences.sql", "0011_home_project.sql",
    "0015_plan_decisions.sql", "0018_build_workflow.sql", "0024_design_phase.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../apps/app/migrations/${m}`, import.meta.url), "utf8"));
  }
  sqlite.prepare("insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)")
    .run("alice", "alice", "alice@example.com", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z");
  const db = d1Adapter(sqlite);
  const home = await ensureHomeProject(db, "alice");
  const homeScope = await projectScopeForUser(db, "alice", home.id);
  const homeRun = await createRun(db, homeScope, { modelRouteId: "nemotron-3-super", payerId: "alice", conversationId: "conv-home-alice" });
  async function reviewReady() {
    const started = await startProjectFromChat(db, homeScope, {
      name: "Todo app", description: "A todo app",
      brief: "Build a minimal todo app with filters and saved tasks. Show the plan first.",
      operationKey: "tool-create-one", sourceConversationId: homeRun.conversationId,
    });
    const scope = await projectScopeForUser(db, "alice", started.project.id);
    const plan = await createPlanDocRevision(db, scope, { kind: "prd", body: "# Todo\n\nAdd/complete/delete/filter/persist." });
    await workflowSnapshot(db, scope);
    return { scope, plan };
  }
  return { db, reviewReady };
}

describe("R06 one-source project experience consumption", () => {
  test("the experience projection reports review + an approve primary when a plan is ready", async () => {
    const w = await world();
    const { scope } = await w.reviewReady();
    const exp = await projectExperience(w.db, scope);
    expect(exp.stage).toBe("review");
    expect(exp.actions.find((a) => a.primary)!.kind).toBe("approve_plan");
    // The workspace and chat read THIS — not a per-UI guess.
    expect(exp.plan).not.toBeNull();
    expect(exp.plan!.approved).toBe(false);
  });

  test("approve-plan command advances the SAME projection to the design step", async () => {
    const w = await world();
    const { scope } = await w.reviewReady();
    const before = await projectExperience(w.db, scope);
    const result = await approvePlan(w.db, scope, {
      projectId: scope.projectId,
      planRevisionId: before.plan!.id,
      expectedVersion: before.version,
      idempotencyKey: "r06-approve-0001",
    });
    expect(result.outcome).toBe("applied");
    expect(result.experience.stage).toBe("design");
    // A re-read sees the same truth the command returned (one source).
    const reread = await projectExperience(w.db, scope);
    expect(reread.stage).toBe("design");
    expect(reread.plan!.approved).toBe(true);
  });

  test("a stale approve is a refreshable conflict, never a different build", async () => {
    const w = await world();
    const { scope } = await w.reviewReady();
    const before = await projectExperience(w.db, scope);
    const result = await approvePlan(w.db, scope, {
      projectId: scope.projectId,
      planRevisionId: before.plan!.id,
      expectedVersion: before.version - 1,
      idempotencyKey: "r06-approve-stale",
    });
    expect(result.outcome).toBe("stale");
    expect((await projectExperience(w.db, scope)).stage).toBe("review");
  });
});
