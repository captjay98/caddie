import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Scope } from "@caddie/contracts";
import type { D1Database } from "../apps/app/src/server/auth.ts";
import {
  ScopeError,
  projectScopeForUser,
} from "../apps/app/src/server/scope.ts";
import {
  ensureHomeProject,
  createProject,
  createWorkspace,
  createPlanDocRevision,
  listRunBindings,
} from "../apps/app/src/server/projects.ts";
import { createRun, recordRepairRound } from "../apps/app/src/server/runs.ts";
import {
  recordDecision,
  revokeApproval,
} from "../apps/app/src/server/approvals.ts";
import { listPlanDecisions } from "../apps/app/src/server/planning.ts";
import {
  startProjectFromChat,
  ensureWorkflow,
  readWorkflow,
  workflowSnapshot,
  decideWorkflow,
  acknowledgeDispatch,
  requireBuildApproval,
  storeBuildOutput,
  readBuildOutput,
  setWorkflowBlocker,
  stopWorkflow,
  planIntent,
  retryWorkflow,
  workflowRepairPause,
  continueProjectFromChat,
  reconcileStalledBuild,
  sweepStalledBuilds,
  BUILD_STALL_MS,
} from "../apps/app/src/server/build-workflow.ts";
import { buildActivity } from "../apps/app/src/server/build-activity.ts";
import { rollbackToFeature } from "../apps/app/src/server/build-features.ts";
import { BUILD_ACTION_BUDGET, REPEATED_ACTION_LIMIT } from "../apps/app/src/agents/permissions.ts";
import { resolveCoordinatorContext } from "../apps/app/src/server/coordinator-host.ts";
import {
  checkedCoordinatorSnapshot,
  coordinatorSnapshot,
  scopedCoordinatorContext,
} from "../apps/app/src/agents/host-context.ts";
import { SandboxStub } from "./fixtures/sandbox-stub.ts";
import { upsertProfile } from "../apps/app/src/server/profiles.ts";
import { splitSqlStatements } from "./fixtures/controls-harness.ts";

/** LOCAL VERIFIED: real production migrations/services over SQLite, with
 * D1-shaped results and a real synchronous transaction backing D1.batch.
 * No model responses, sandbox commands or paid provider calls are simulated
 * as successful builds: these tests exercise workflow governance only. */
function d1Adapter(
  sqlite: Database,
  hooks: { beforeBatch: (() => void) | null },
): D1Database {
  function statement(sql: string, args: unknown[] = []) {
    return {
      bind(...values: unknown[]) {
        return statement(sql, values);
      },
      all() {
        return {
          results: sqlite.prepare(sql).all(...(args as never[])),
          meta: {},
        };
      },
      run() {
        const result = sqlite.prepare(sql).run(...(args as never[]));
        return {
          success: true,
          results: [],
          meta: {
            changes: result.changes,
            last_row_id: Number(result.lastInsertRowid),
          },
        };
      },
    };
  }
  return {
    prepare: statement,
    batch(statements: { run(): unknown }[]) {
      hooks.beforeBatch?.();
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
    "0023_build_features.sql",
  ]) {
    const ddl = readFileSync(
      new URL(`../apps/app/migrations/${migration}`, import.meta.url),
      "utf8",
    );
    for (const statement of splitSqlStatements(ddl)) sqlite.exec(statement);
  }
  for (const user of ["alice", "bob"])
    sqlite
      .prepare(
        "insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)",
      )
      .run(
        user,
        user,
        `${user}@example.com`,
        "2026-10-11T00:00:00.000Z",
        "2026-10-11T00:00:00.000Z",
      );
  const hooks = { beforeBatch: null as (() => void) | null };
  const db = d1Adapter(sqlite, hooks);
  const home = await ensureHomeProject(db, "alice");
  const homeScope = await projectScopeForUser(db, "alice", home.id);
  const homeRun = await createRun(db, homeScope, {
    modelRouteId: "nemotron-3-super",
    payerId: "alice",
    conversationId: "conv-home-alice",
  });
  const intake = {
    name: "Todo app",
    description: "A beautiful todo app",
    brief:
      "Build a modern minimal todo app with keyboard support, filters, and saved tasks. Show me the plan first.",
    operationKey: "tool-create-one",
    sourceConversationId: homeRun.conversationId,
  };
  async function start(input = intake) {
    const result = await startProjectFromChat(db, homeScope, input);
    const scope = await projectScopeForUser(db, "alice", result.project.id);
    return { ...result, scope };
  }
  function count(table: string, where = "1=1") {
    return Number(
      (
        sqlite
          .query(`select count(*) as n from ${table} where ${where}`)
          .get() as { n: number }
      ).n,
    );
  }
  return { db, sqlite, homeScope, homeRun, intake, start, count, hooks };
}
async function rejectsCode(task: Promise<unknown>, code: string) {
  try {
    await task;
  } catch (error) {
    expect(error).toBeInstanceOf(ScopeError);
    expect((error as ScopeError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}, but effect succeeded`);
}
async function planned(w: Awaited<ReturnType<typeof world>>) {
  const started = await w.start();
  const plan = await createPlanDocRevision(w.db, started.scope, {
    kind: "prd",
    body: "# Todo app\n\nAdd, complete, delete, filter and persist tasks.",
  });
  await workflowSnapshot(w.db, started.scope);
  return { ...started, plan };
}
async function approved(w: Awaited<ReturnType<typeof world>>) {
  const item = await planned(w);
  const snapshot = await decideWorkflow(w.db, item.scope, {
    planId: item.plan.id,
    decision: "approved",
  });
  return { ...item, snapshot };
}

describe("durable chat intake", () => {
  test("one intake replay creates one project/run/workflow and preserves the full original brief", async () => {
    const w = await world();
    try {
      const first = await w.start();
      await acknowledgeDispatch(w.db, first.scope, first.workflow.pendingKey!);
      const replay = await w.start();
      expect(replay.project.id).toBe(first.project.id);
      expect(replay.workflow.runId).toBe(first.workflow.runId);
      expect(replay.workflow.conversationId).toBe(
        first.workflow.conversationId,
      );
      expect(replay.workflow.brief).toBe(w.intake.brief);
      expect(replay.workflow.pendingKey).toBeNull();
      expect(replay.workflow.sourceConversationId).toBe(
        w.homeRun.conversationId,
      );
      expect(w.count("projects", "kind = 'standard'")).toBe(1);
      expect(w.count("run_bindings", `projectId = '${first.project.id}'`)).toBe(
        1,
      );
      expect(w.count("build_workflows")).toBe(1);
      expect((await listRunBindings(w.db, first.scope))[0]?.payerId).toBe(
        "alice",
      );
    } finally {
      w.sqlite.close();
    }
  });

  test("failed final write rolls back the new project and run atomically", async () => {
    const w = await world();
    try {
      w.sqlite.exec(
        "create trigger refuse_intake before insert on build_workflows begin select raise(abort, 'forced_intake_failure'); end;",
      );
      await expect(w.start()).rejects.toThrow("forced_intake_failure");
      expect(w.count("projects", "kind = 'standard'")).toBe(0);
      expect(w.count("run_bindings")).toBe(1); // only the original Home conversation
      expect(w.count("build_workflows")).toBe(0);
    } finally {
      w.sqlite.close();
    }
  });

  test("unauthorized workspace intake and project operations fail before reading or writing", async () => {
    const w = await world();
    try {
      await rejectsCode(
        startProjectFromChat(
          w.db,
          { ...w.homeScope, actorId: "bob" },
          w.intake,
        ),
        "not_a_member",
      );
      const item = await planned(w);
      const other = { ...item.scope, actorId: "bob" };
      await rejectsCode(readWorkflow(w.db, other), "not_a_member");
      await rejectsCode(workflowSnapshot(w.db, other), "not_a_member");
      await rejectsCode(
        decideWorkflow(w.db, other, {
          planId: item.plan.id,
          decision: "approved",
        }),
        "not_a_member",
      );
      await rejectsCode(
        acknowledgeDispatch(w.db, other, "anything"),
        "not_a_member",
      );
      await rejectsCode(
        setWorkflowBlocker(w.db, other, "forged blocker"),
        "not_a_member",
      );
      expect(w.count("approvals")).toBe(0);
    } finally {
      w.sqlite.close();
    }
  });

  test("invalid intake cannot produce a partial project and Home is not a build workflow", async () => {
    const w = await world();
    try {
      await rejectsCode(w.start({ ...w.intake, brief: " " }), "invalid_intake");
      await rejectsCode(
        w.start({ ...w.intake, brief: "x".repeat(16001) }),
        "invalid_intake",
      );
      await rejectsCode(ensureWorkflow(w.db, w.homeScope), "home_not_build");
      expect(w.count("projects", "kind = 'standard'")).toBe(0);
    } finally {
      w.sqlite.close();
    }
  });

  test("source conversations must belong to this actor and source project", async () => {
    const w = await world();
    try {
      await rejectsCode(
        w.start({ ...w.intake, sourceConversationId: "invented-conversation" }),
        "invalid_source",
      );
      const item = await w.start();
      await rejectsCode(
        w.start({
          ...w.intake,
          operationKey: "cross-project",
          sourceConversationId: item.workflow.conversationId,
        }),
        "invalid_source",
      );
      w.sqlite
        .prepare(
          "insert into workspace_memberships (id,workspaceId,userId,role,createdAt) values (?,?,?,?,?)",
        )
        .run(
          "bob-home-member",
          w.homeScope.workspaceId,
          "bob",
          "member",
          "2026-10-11T00:00:00.000Z",
        );
      const bobRun = await createRun(
        w.db,
        { ...w.homeScope, actorId: "bob" },
        { modelRouteId: "nemotron-3-super", payerId: "bob" },
      );
      await rejectsCode(
        w.start({
          ...w.intake,
          operationKey: "wrong-owner",
          sourceConversationId: bobRun.conversationId,
        }),
        "invalid_source",
      );
      expect(w.count("build_workflows")).toBe(1);
    } finally {
      w.sqlite.close();
    }
  });

  test("same intake key cannot silently replace the original brief or project name", async () => {
    const w = await world();
    try {
      const first = await w.start();
      await expect(
        w.start({ ...w.intake, brief: "Actually build a finance app instead" }),
      ).rejects.toBeInstanceOf(ScopeError);
      await expect(
        w.start({ ...w.intake, name: "Different project" }),
      ).rejects.toBeInstanceOf(ScopeError);
      expect((await readWorkflow(w.db, first.scope))?.brief).toBe(
        w.intake.brief,
      );
      expect(w.count("build_workflows")).toBe(1);
    } finally {
      w.sqlite.close();
    }
  });

  test("existing project reuses its conversation without resetting intake or creating another run", async () => {
    const w = await world();
    try {
      const item = await w.start();
      const existing = await ensureWorkflow(w.db, item.scope);
      expect(existing.runId).toBe(item.workflow.runId);
      expect(existing.conversationId).toBe(item.workflow.conversationId);
      expect(existing.brief).toBe(w.intake.brief);
      expect(w.count("run_bindings", `projectId = '${item.project.id}'`)).toBe(
        1,
      );
    } finally {
      w.sqlite.close();
    }
  });
});

describe("plan review and durable build approval", () => {
  test("planning settles without an approval but cannot execute a build", async () => {
    const w = await world();
    try {
      const item = await w.start();
      const before = await workflowSnapshot(w.db, item.scope);
      expect(before.workflow?.phase).toBe("planning");
      expect(before.plan).toBeNull();
      expect(before.approval).toBeNull();
      await rejectsCode(
        requireBuildApproval(w.db, item.scope),
        "BUILD_NOT_APPROVED",
      );
      const plan = await createPlanDocRevision(w.db, item.scope, {
        kind: "prd",
        body: "# Plan\nReady for user review",
      });
      const review = await workflowSnapshot(w.db, item.scope);
      expect(review.workflow?.phase).toBe("review");
      expect(review.workflow?.planId).toBe(plan.id);
      expect(review.workflow?.pendingKey).toBeNull();
      expect(review.approval).toBeNull();
      expect(w.count("approvals")).toBe(0);
    } finally {
      w.sqlite.close();
    }
  });

  test("the latest PRD owns review even when another document has a higher revision number", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      for (let i = 0; i < 4; i++)
        await createPlanDocRevision(w.db, item.scope, {
          kind: "spec",
          body: `Spec ${i}`,
        });
      const snapshot = await workflowSnapshot(w.db, item.scope);
      expect(snapshot.plan?.id).toBe(item.plan.id);
      expect(snapshot.plan?.kind).toBe("prd");
      expect(snapshot.workflow?.phase).toBe("review");
    } finally {
      w.sqlite.close();
    }
  });

  test("authenticated approval queues one build and replay after dispatch acknowledgment cannot restart it", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const queued = item.snapshot.workflow!;
      expect(queued.phase).toBe("building");
      expect(queued.pendingKey).toBe(`decision:${item.snapshot.approval!.id}`);
      expect(queued.pendingBody).toContain(item.plan.id);
      expect(item.snapshot.approval?.decidedBy).toBe("alice");
      expect((await requireBuildApproval(w.db, item.scope)).plan.id).toBe(
        item.plan.id,
      );
      const doubleClick = await decideWorkflow(w.db, item.scope, {
        planId: item.plan.id,
        decision: "approved",
      });
      expect(doubleClick.workflow?.pendingKey).toBe(queued.pendingKey);
      expect(w.count("plan_decisions")).toBe(1);
      await acknowledgeDispatch(w.db, item.scope, queued.pendingKey!);
      const replay = await decideWorkflow(w.db, item.scope, {
        planId: item.plan.id,
        decision: "approved",
      });
      expect(replay.workflow?.phase).toBe("building");
      expect(replay.workflow?.pendingKey).toBeNull();
      expect(w.count("approvals")).toBe(1);
      expect(w.count("plan_decisions")).toBe(1);
    } finally {
      w.sqlite.close();
    }
  });

  test("acknowledging an old delivery key cannot clear a newer queued build", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      const rejected = await decideWorkflow(w.db, item.scope, {
        planId: item.plan.id,
        decision: "rejected",
        note: "Add keyboard shortcuts",
      });
      const oldKey = rejected.workflow!.pendingKey!;
      const next = await createPlanDocRevision(w.db, item.scope, {
        kind: "prd",
        body: "# Revised plan\nAdd keyboard shortcuts",
      });
      await workflowSnapshot(w.db, item.scope);
      const approvedNext = await decideWorkflow(w.db, item.scope, {
        planId: next.id,
        decision: "approved",
      });
      const newKey = approvedNext.workflow!.pendingKey!;
      expect(newKey).not.toBe(oldKey);
      await acknowledgeDispatch(w.db, item.scope, oldKey);
      expect((await readWorkflow(w.db, item.scope))?.pendingKey).toBe(newKey);
      await acknowledgeDispatch(w.db, item.scope, newKey);
      expect((await readWorkflow(w.db, item.scope))?.pendingKey).toBeNull();
    } finally {
      w.sqlite.close();
    }
  });

  test("a newer plan invalidates the old approval at both click and effect boundaries", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const next = await createPlanDocRevision(w.db, item.scope, {
        kind: "prd",
        body: "# Changed plan\nSync tasks to a server",
      });
      await rejectsCode(
        requireBuildApproval(w.db, item.scope),
        "BUILD_NOT_APPROVED",
      );
      await rejectsCode(
        decideWorkflow(w.db, item.scope, {
          planId: item.plan.id,
          decision: "approved",
        }),
        "STALE_PLAN",
      );
      const snapshot = await workflowSnapshot(w.db, item.scope);
      expect(snapshot.workflow?.phase).toBe("review");
      expect(snapshot.plan?.id).toBe(next.id);
      expect(snapshot.approval).toBeNull();
    } finally {
      w.sqlite.close();
    }
  });

  test("expired and revoked approval are re-read and denied immediately before effects", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      w.sqlite
        .prepare("update approvals set expiresAt = ? where id = ?")
        .run("2000-01-01T00:00:00.000Z", item.snapshot.approval!.id);
      await rejectsCode(
        requireBuildApproval(w.db, item.scope),
        "APPROVAL_EXPIRED",
      );
      w.sqlite
        .prepare("update approvals set expiresAt = ? where id = ?")
        .run("2999-01-01T00:00:00.000Z", item.snapshot.approval!.id);
      await revokeApproval(w.db, "alice", item.snapshot.approval!.id);
      await rejectsCode(
        requireBuildApproval(w.db, item.scope),
        "APPROVAL_REVOKED",
      );
    } finally {
      w.sqlite.close();
    }
  });

  test("another member cannot execute using the original actor approval, and membership removal stops effects", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      w.sqlite
        .prepare(
          "insert into workspace_memberships (id,workspaceId,userId,role,createdAt) values (?,?,?,?,?)",
        )
        .run(
          "bob-member",
          item.scope.workspaceId,
          "bob",
          "member",
          "2026-10-11T00:00:00.000Z",
        );
      await rejectsCode(
        requireBuildApproval(w.db, { ...item.scope, actorId: "bob" }),
        "APPROVAL_WRONG_ACTOR",
      );
      w.sqlite
        .prepare(
          "delete from workspace_memberships where workspaceId = ? and userId = ?",
        )
        .run(item.scope.workspaceId, "alice");
      await rejectsCode(requireBuildApproval(w.db, item.scope), "not_a_member");
    } finally {
      w.sqlite.close();
    }
  });

  test("model-forged phase without durable approval cannot bypass review", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      w.sqlite
        .prepare(
          "update build_workflows set phase = 'building' where projectId = ?",
        )
        .run(item.project.id);
      await rejectsCode(
        requireBuildApproval(w.db, item.scope),
        "STALE_APPROVAL",
      );
    } finally {
      w.sqlite.close();
    }
  });

  test("rejected feedback is durable, replays do not requeue it, and a revised plan requires fresh approval", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      await rejectsCode(
        decideWorkflow(w.db, item.scope, {
          planId: item.plan.id,
          decision: "rejected",
          note: " ",
        }),
        "feedback_required",
      );
      const feedback = "Use a calm palette and add keyboard shortcuts";
      const rejection = await decideWorkflow(w.db, item.scope, {
        planId: item.plan.id,
        decision: "rejected",
        note: feedback,
      });
      expect(rejection.workflow?.phase).toBe("planning");
      expect(rejection.workflow?.pendingBody).toContain(feedback);
      expect(rejection.approval?.status).toBe("rejected");
      expect(
        (await listPlanDecisions(w.db, item.scope, item.plan.id))[0]?.note,
      ).toBe(feedback);
      await acknowledgeDispatch(
        w.db,
        item.scope,
        rejection.workflow!.pendingKey!,
      );
      const replay = await decideWorkflow(w.db, item.scope, {
        planId: item.plan.id,
        decision: "rejected",
        note: feedback,
      });
      expect(replay.workflow?.pendingKey).toBeNull();
      const next = await createPlanDocRevision(w.db, item.scope, {
        kind: "prd",
        body: `# Revised Todo\n${feedback}`,
      });
      const revised = await workflowSnapshot(w.db, item.scope);
      expect(revised.plan?.id).toBe(next.id);
      expect(revised.workflow?.phase).toBe("review");
      expect(revised.approval).toBeNull();
      await rejectsCode(
        requireBuildApproval(w.db, item.scope),
        "BUILD_NOT_APPROVED",
      );
      const accepted = await decideWorkflow(w.db, item.scope, {
        planId: next.id,
        decision: "approved",
      });
      expect(accepted.approval?.id).not.toBe(rejection.approval?.id);
      expect((await requireBuildApproval(w.db, item.scope)).plan.id).toBe(
        next.id,
      );
    } finally {
      w.sqlite.close();
    }
  });

  test("three actual failed repair rounds pause the approved run", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      for (let i = 0; i < 3; i++)
        await recordRepairRound(w.db, item.scope, item.workflow.runId, {
          issue: "build failure",
          round: "repair_attempt",
          outcome: "failed",
        });
      await rejectsCode(requireBuildApproval(w.db, item.scope), "RUN_PAUSED");
    } finally {
      w.sqlite.close();
    }
  });
});

describe("approved output and preview identity", () => {
  test("stores approved current-plan bytes with a computed hash and scopes reads to their project", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const html =
        "<!doctype html><html><body><h1>Todo app — tasks</h1></body></html>";
      const output = await storeBuildOutput(w.db, item.scope, {
        html,
        image: "sha256:actual-sandbox-image",
        planId: item.plan.id,
        runId: item.workflow.runId,
      });
      expect(output.sha256).toBe(
        createHash("sha256").update(html).digest("hex"),
      );
      expect(
        new TextDecoder().decode(
          await readBuildOutput(w.db, item.scope, output.outputId),
        ),
      ).toBe(html);
      const snapshot = await workflowSnapshot(w.db, item.scope);
      expect(snapshot.workflow?.phase).toBe("ready");
      expect(snapshot.workflow?.previewId).toBe(output.outputId);
      const other = await w.start({
        ...w.intake,
        operationKey: "another-project",
      });
      await rejectsCode(
        readBuildOutput(w.db, other.scope, output.outputId),
        "preview_not_found",
      );
      await rejectsCode(
        readBuildOutput(
          w.db,
          { ...item.scope, actorId: "bob" },
          output.outputId,
        ),
        "not_a_member",
      );
    } finally {
      w.sqlite.close();
    }
  });

  test("unapproved, stale-check, incomplete HTML and oversized output never publish readiness", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      const payload = {
        html: "<html><body>Preview</body></html>",
        image: "image",
        planId: item.plan.id,
        runId: item.workflow.runId,
      };
      await rejectsCode(
        storeBuildOutput(w.db, item.scope, payload),
        "BUILD_NOT_APPROVED",
      );
      await decideWorkflow(w.db, item.scope, {
        planId: item.plan.id,
        decision: "approved",
      });
      await rejectsCode(
        storeBuildOutput(w.db, item.scope, {
          ...payload,
          runId: "unrelated-run",
        }),
        "STALE_CHECK",
      );
      await rejectsCode(
        storeBuildOutput(w.db, item.scope, {
          ...payload,
          planId: "older-plan",
        }),
        "STALE_CHECK",
      );
      await rejectsCode(
        storeBuildOutput(w.db, item.scope, {
          ...payload,
          html: "<div>Not a complete HTML document</div>",
        }),
        "INVALID_PREVIEW",
      );
      await rejectsCode(
        storeBuildOutput(w.db, item.scope, {
          ...payload,
          html: `<html>${"x".repeat(500001)}</html>`,
        }),
        "INVALID_PREVIEW",
      );
      expect(w.count("workflow_outputs")).toBe(0);
      expect(w.count("artifact_content")).toBe(0);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("building");
    } finally {
      w.sqlite.close();
    }
  });

  test("a plan revision arriving immediately before output publication prevents stale readiness", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      w.hooks.beforeBatch = () => {
        w.hooks.beforeBatch = null;
        const body =
          "# New plan arriving during publication\nAdd synchronization";
        w.sqlite
          .prepare(
            "insert into plan_doc_revisions (id,projectId,kind,revision,bodyHash,body,createdBy,createdAt) values (?,?,?,?,?,?,?,?)",
          )
          .run(
            "plan-publication-race",
            item.project.id,
            "prd",
            2,
            `sha256-${createHash("sha256").update(body).digest("hex")}`,
            body,
            "alice",
            new Date().toISOString(),
          );
      };
      await expect(
        storeBuildOutput(w.db, item.scope, {
          html: "<html>Old plan</html>",
          image: "old-image",
          planId: item.plan.id,
          runId: item.workflow.runId,
        }),
      ).rejects.toBeInstanceOf(ScopeError);
      expect((await readWorkflow(w.db, item.scope))?.phase).not.toBe("ready");
      expect((await readWorkflow(w.db, item.scope))?.previewId).toBeNull();
    } finally {
      w.sqlite.close();
    }
  });

  test("approval revoked immediately before output publication cannot publish readiness", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      w.hooks.beforeBatch = () => {
        w.hooks.beforeBatch = null;
        w.sqlite
          .prepare("update approvals set status = 'revoked' where id = ?")
          .run(item.snapshot.approval!.id);
      };
      await expect(
        storeBuildOutput(w.db, item.scope, {
          html: "<html>Unauthorized output</html>",
          image: "image",
          planId: item.plan.id,
          runId: item.workflow.runId,
        }),
      ).rejects.toBeInstanceOf(ScopeError);
      expect((await readWorkflow(w.db, item.scope))?.phase).not.toBe("ready");
    } finally {
      w.sqlite.close();
    }
  });

  test("an old preview stays inspectable as history but never indicates a new plan is ready", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const html = "<html><body>Old working version</body></html>";
      const output = await storeBuildOutput(w.db, item.scope, {
        html,
        image: "old-image",
        planId: item.plan.id,
        runId: item.workflow.runId,
      });
      const next = await createPlanDocRevision(w.db, item.scope, {
        kind: "prd",
        body: "# New plan\nAdd synchronization",
      });
      const revised = await workflowSnapshot(w.db, item.scope);
      expect(revised.workflow?.phase).toBe("review");
      expect(revised.workflow?.planId).toBe(next.id);
      expect(revised.workflow?.previewId).toBeNull();
      expect(
        new TextDecoder().decode(
          await readBuildOutput(w.db, item.scope, output.outputId),
        ),
      ).toBe(html);
    } finally {
      w.sqlite.close();
    }
  });
});

describe("explicit build recovery and existing project handoff", () => {
  test("retry preserves evidence, is idempotent, and allows only three new failures", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      for (let i = 0; i < 3; i++)
        await recordRepairRound(w.db, item.scope, item.workflow.runId, {
          issue: "build",
          round: "repair_attempt",
          outcome: "failed",
        });
      await setWorkflowBlocker(w.db, item.scope, "Three failed checks");
      const retry = await retryWorkflow(w.db, item.scope, "recovery-test-1");
      expect(retry.workflow?.phase).toBe("building");
      expect(
        (await workflowRepairPause(w.db, item.workflow.runId)).paused,
      ).toBe(false);
      expect(w.count("run_rounds")).toBe(3);
      await acknowledgeDispatch(w.db, item.scope, retry.workflow!.pendingKey!);
      expect(
        (await retryWorkflow(w.db, item.scope, "recovery-test-1")).workflow
          ?.pendingKey,
      ).toBeNull();
      expect(w.count("workflow_resumes")).toBe(1);
      for (let i = 0; i < 3; i++)
        await recordRepairRound(w.db, item.scope, item.workflow.runId, {
          issue: "build",
          round: "repair_attempt",
          outcome: "failed",
        });
      await rejectsCode(requireBuildApproval(w.db, item.scope), "RUN_PAUSED");
      expect(w.count("run_rounds")).toBe(6);
    } finally {
      w.sqlite.close();
    }
  });
  test("retry cannot bypass revoked approval or a revised plan", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      await setWorkflowBlocker(w.db, item.scope, "Unavailable sandbox");
      await revokeApproval(w.db, "alice", item.snapshot.approval!.id);
      await rejectsCode(
        retryWorkflow(w.db, item.scope, "recovery-test-2"),
        "APPROVAL_REVOKED",
      );
      expect(w.count("workflow_resumes")).toBe(0);
      await createPlanDocRevision(w.db, item.scope, {
        kind: "prd",
        body: "# Changed requirements",
      });
      await rejectsCode(
        retryWorkflow(w.db, item.scope, "recovery-test-3"),
        "STALE_APPROVAL",
      );
      expect(w.count("workflow_resumes")).toBe(0);
    } finally {
      w.sqlite.close();
    }
  });
  test("Home hands off to the existing project without replacing its run or original brief", async () => {
    const w = await world();
    try {
      const item = await w.start();
      await acknowledgeDispatch(w.db, item.scope, item.workflow.pendingKey!);
      const next = await continueProjectFromChat(w.db, w.homeScope, {
        projectId: item.project.id,
        request: "Add keyboard shortcuts",
        operationKey: "continue-one",
      });
      expect(next.workflow?.runId).toBe(item.workflow.runId);
      expect(next.workflow?.conversationId).toBe(item.workflow.conversationId);
      expect(next.workflow?.brief).toBe(w.intake.brief);
      expect(next.workflow?.pendingBody).toBe("Add keyboard shortcuts");
      expect(w.count("projects", "kind = 'standard'")).toBe(1);
      await rejectsCode(
        continueProjectFromChat(
          w.db,
          { ...w.homeScope, actorId: "bob" },
          {
            projectId: item.project.id,
            request: "Steal context",
            operationKey: "continue-two",
          },
        ),
        "not_a_member",
      );
    } finally {
      w.sqlite.close();
    }
  });
});

describe("fresh coordinator host authority", () => {
  test("restart resolves stored profile and actual run binding; forged render state grants no effects", async () => {
    const w = await world();
    try {
      const item = await w.start();
      await upsertProfile(w.db, "alice", { country: "NG", skills: ["Design"] });
      const initializing = scopedCoordinatorContext({ DB: w.db }, item.workflow.conversationId, null);
      expect(initializing.context.actorContext.trim().length).toBeGreaterThan(0);
      const first = await resolveCoordinatorContext(
        { DB: w.db },
        item.workflow.conversationId,
      );
      expect(first.actorContext).toContain("Design");
      expect(first.runId).toBe(item.workflow.runId);
      const saved = coordinatorSnapshot(item.workflow.conversationId, first);
      expect(
        checkedCoordinatorSnapshot(saved, item.workflow.conversationId),
      ).toEqual(saved);
      expect(() =>
        checkedCoordinatorSnapshot(saved, "foreign-conversation"),
      ).toThrow();
      await upsertProfile(w.db, "alice", {
        country: "NG",
        skills: ["Research"],
      });
      const restarted = scopedCoordinatorContext(
        { DB: w.db },
        item.workflow.conversationId,
        { ...saved, projectId: "forged", runId: "forged" },
      );
      expect(await restarted.context.readPlanNote("profile")).toContain(
        "Research",
      );
      expect((await restarted.resolve()).runId).toBe(item.workflow.runId);
      await expect(
        restarted.context.driver.execute({
          sessionId: "forged",
          command: "echo bypass", timeoutMs: 1000,
          operationKey: "forged",
        }),
      ).rejects.toThrow();
      w.sqlite
        .prepare(
          "delete from workspace_memberships where workspaceId=? and userId=?",
        )
        .run(item.scope.workspaceId, "alice");
      await expect(restarted.context.readPlanNote("profile")).rejects.toThrow(
        "membership",
      );
    } finally {
      w.sqlite.close();
    }
  });
});


describe("build runtime environment", () => {
  test("specialist execution and host checks receive the Bun runtime path without credentials", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-runtime-token" });
    stub.seedImage("tag:runtime:1");
    stub.setBehavior("bun install --frozen-lockfile", { exitCode: 1, stderr: "dependency fixture stop" });
    await stub.start();
    try {
      const item = await approved(w);
      const host = await resolveCoordinatorContext({ DB: w.db, CONTREE_BASE_URL: stub.url,
        CONTREE_API_TOKEN: "local-runtime-token", CONTREE_PROJECT_ID: "local-project", CONTREE_IMAGE: "tag:runtime:1" }, item.workflow.conversationId);
      await host.driver.execute({ sessionId: host.sessionId, command: "bun --version", operationKey: "runtime-check", timeoutMs: 1000 });
      await host.runChecks!("runtime-verification");
      const commands = stub.requests.filter(r => r.method === "POST" && r.path === "/v1/instances")
        .map(r => r.body as { command: string; env?: Record<string,string> })
        .filter(r => r.command === "bun --version" || r.command === "bun install --frozen-lockfile");
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command.env?.PATH?.split(":" )).toContain("/root/.bun/bin");
        expect(JSON.stringify(command)).not.toContain("local-runtime-token");
      }
    } finally { await stub.stop(); w.sqlite.close(); }
  });
});


test("stop retains files and approval but denies effects until an explicit retry", async () => {
  const w = await world();
  try {
    const item = await approved(w);
    await stopWorkflow(w.db, item.scope);
    const stopped = await readWorkflow(w.db, item.scope);
    expect(stopped?.phase).toBe("blocked");
    expect(stopped?.pendingKey).toBeNull();
    await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
    await retryWorkflow(w.db, item.scope, "resume-after-stop");
    expect((await requireBuildApproval(w.db, item.scope)).plan.id).toBe(item.plan.id);
  } finally { w.sqlite.close(); }
});


describe("specialist repair boundaries", () => {
  test("shell test runs are refused; failed run_checks count once per receipt and stop the next effect after three attempts", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-repair-token" });
    stub.seedImage("tag:repair:1");
    stub.setBehavior("bun run test", { exitCode: 1, stderr: "1 fail" });
    await stub.start();
    try {
      const item = await approved(w);
      const env = { DB: w.db, CONTREE_BASE_URL: stub.url, CONTREE_API_TOKEN: "local-repair-token", CONTREE_PROJECT_ID: "local-project", CONTREE_IMAGE: "tag:repair:1" };
      const host = await resolveCoordinatorContext(env, item.workflow.conversationId);
      // A piped shell test (FarmLog AI: `| head -14` reported exit 0) is refused
      // before anything reaches the sandbox; tests run only through run_checks.
      for (const command of ["bun test src/diag.test.ts 2>&1 | head -14", "cd app && bun run test", "npx vitest run"]) {
        await expect(host.driver.execute({ sessionId: host.sessionId, command, operationKey: `shell:${command}`, timeoutMs: 1000 }))
          .rejects.toThrow("run_checks");
      }
      expect(stub.requests).toHaveLength(0);
      const first = (await host.runChecks!("failure-one")) as { passed: boolean; receipts: { check: string }[] };
      expect(first.passed).toBe(false);
      expect(first.receipts.at(-1)?.check).toBe("behavior-tests");
      // Recovery of the same logical delivery must not consume another attempt.
      const restored = await resolveCoordinatorContext(env, item.workflow.conversationId);
      await restored.runChecks!("failure-one");
      expect(w.count("run_rounds", "outcome='failed'")).toBe(1);
      await host.runChecks!("failure-two");
      await host.runChecks!("failure-three");
      expect(w.count("run_rounds", "outcome='failed'")).toBe(3);
      expect((await workflowRepairPause(w.db, item.workflow.runId)).paused).toBe(true);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("blocked");
      expect((await readWorkflow(w.db, item.scope))?.detail).toContain("saved");
      const before = stub.spawnRequestCount();
      await expect(host.driver.execute({ sessionId: host.sessionId, command: "ls", operationKey: "must-not-dispatch", timeoutMs: 1000 })).rejects.toThrow();
      expect(stub.spawnRequestCount()).toBe(before);
      // run_checks never publishes a preview, even before the pause.
      expect(w.count("workflow_outputs")).toBe(0);
      await retryWorkflow(w.db, item.scope, "explicit-bounded-retry");
      expect((await workflowRepairPause(w.db, item.workflow.runId)).paused).toBe(false);
      await host.runChecks!("failure-four");
      expect(w.count("run_rounds", "outcome='failed'")).toBe(4);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("building");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("already cancelled specialist execution and verification dispatch nothing", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-cancel-token" });
    stub.seedImage("tag:cancel:1");
    await stub.start();
    try {
      const item = await approved(w);
      const host = scopedCoordinatorContext({ DB: w.db, CONTREE_BASE_URL: stub.url, CONTREE_API_TOKEN: "local-cancel-token", CONTREE_PROJECT_ID: "local-project", CONTREE_IMAGE: "tag:cancel:1" }, item.workflow.conversationId, null).context;
      const controller = new AbortController(); controller.abort();
      await expect(host.driver.execute({ sessionId: host.sessionId, command: "bun test src", operationKey: "cancelled-exec", timeoutMs: 1000, signal: controller.signal })).rejects.toThrow();
      await expect(host.verifyBuild("cancelled-verify", controller.signal)).rejects.toThrow();
      expect(stub.requests).toHaveLength(0);
      expect(w.count("run_rounds")).toBe(0);
    } finally { await stub.stop(); w.sqlite.close(); }
  });
});


test("Stop propagates through the host to a running sandbox command", async () => {
  const w = await world();
  const stub = new SandboxStub({ expectedToken: "local-running-token" });
  stub.seedImage("tag:running:1");
  stub.setBehavior("bun run build", { delayMs: 5000 });
  await stub.start();
  try {
    const item = await approved(w);
    const host = await resolveCoordinatorContext({ DB: w.db, CONTREE_BASE_URL: stub.url, CONTREE_API_TOKEN: "local-running-token", CONTREE_PROJECT_ID: "local-project", CONTREE_IMAGE: "tag:running:1" }, item.workflow.conversationId);
    const controller = new AbortController();
    const pending = host.driver.execute({ sessionId: host.sessionId, command: "bun run build", operationKey: "running-cancel", timeoutMs: 10000, signal: controller.signal });
    // Wait for observed dispatch before aborting; cancellation must target that operation.
    for (let tries = 0; tries < 100; tries++) {
      if (stub.requests.some(r => r.method === "POST" && (r.body as { command?: string })?.command === "bun run build")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    await expect(pending).rejects.toThrow("remote cancellation was requested");
    expect(stub.requests.some(r => r.method === "DELETE" && r.path.startsWith("/v1/operations/"))).toBe(true);
    expect(w.count("workflow_outputs")).toBe(0);
    expect(w.count("run_rounds")).toBe(0);
  } finally { await stub.stop(); w.sqlite.close(); }
});


test("a user continuation resumes the approved stopped project with their full request, once", async () => {
  const w = await world();
  try {
    const item = await approved(w);
    await acknowledgeDispatch(w.db, item.scope, item.snapshot.workflow!.pendingKey!);
    for (let i=0;i<3;i++) await recordRepairRound(w.db,item.scope,item.workflow.runId,{issue:'behavior-tests',round:'repair_attempt',outcome:'failed'});
    await setWorkflowBlocker(w.db,item.scope,'Checks failed');
    const input = {projectId:item.project.id,request:'Please fix the existing app and check it; keep my saved work.',operationKey:'user-recovery-message',resumeBlocked:true};
    const resumed=await continueProjectFromChat(w.db,w.homeScope,input);
    expect(resumed.workflow?.phase).toBe('building');
    expect(resumed.workflow?.pendingBody).toContain(input.request);
    expect(resumed.workflow?.runId).toBe(item.workflow.runId);
    expect(w.count('workflow_resumes')).toBe(1);
    await acknowledgeDispatch(w.db,item.scope,resumed.workflow!.pendingKey!);
    expect((await continueProjectFromChat(w.db,w.homeScope,input)).workflow?.pendingKey).toBeNull();
    expect((await requireBuildApproval(w.db,item.scope)).plan.id).toBe(item.plan.id);
    for (let i=0;i<3;i++) await recordRepairRound(w.db,item.scope,item.workflow.runId,{issue:'behavior-tests',round:'repair_attempt',outcome:'failed'});
    await setWorkflowBlocker(w.db,item.scope,'New attempts failed');
    await continueProjectFromChat(w.db,w.homeScope,input);
    expect(w.count('workflow_resumes')).toBe(1);
    expect((await readWorkflow(w.db,item.scope))?.phase).toBe('blocked');
  } finally {w.sqlite.close();}
});

test("automatic handoff never resets repair limits and user continuation cannot bypass revoked approval", async () => {
  const w=await world();
  try {
    const item=await approved(w);
    await acknowledgeDispatch(w.db,item.scope,item.snapshot.workflow!.pendingKey!);
    await setWorkflowBlocker(w.db,item.scope,'Stopped');
    const input={projectId:item.project.id,request:'Inspect what went wrong',operationKey:'automatic-handoff'};
    await continueProjectFromChat(w.db,w.homeScope,input);
    expect((await readWorkflow(w.db,item.scope))?.phase).toBe('blocked');
    expect(w.count('workflow_resumes')).toBe(0);
    await revokeApproval(w.db,'alice',item.snapshot.approval!.id);
    await rejectsCode(continueProjectFromChat(w.db,w.homeScope,{...input,operationKey:'user-after-revoke',resumeBlocked:true}),'APPROVAL_REVOKED');
    expect(w.count('workflow_resumes')).toBe(0);
  } finally {w.sqlite.close();}
});


test("Home routes an explicit named-project continuation through scoped records before model prose", async () => {
  const w=await world();
  try {
    const item=await approved(w);
    await stopWorkflow(w.db,item.scope);
    const host=await resolveCoordinatorContext({DB:w.db},w.homeRun.conversationId);
    const routed=await host.continueNamedProject({request:'Continue Todo app and fix its checks.',operationKey:'home-delivery:1'});
    expect(routed?.project.id).toBe(item.project.id);
    expect((await readWorkflow(w.db,item.scope))?.phase).toBe('building');
    expect((await readWorkflow(w.db,item.scope))?.pendingBody).toContain('Continue Todo app and fix its checks.');
    expect(w.count('projects',"kind='standard'")).toBe(1);
    await stopWorkflow(w.db,item.scope);
    expect(await host.continueNamedProject({request:'Do not continue Todo app.',operationKey:'home-delivery:2'})).toBeNull();
    expect(await host.continueNamedProject({request:'What is Todo app?',operationKey:'home-delivery:3'})).toBeNull();
    expect((await readWorkflow(w.db,item.scope))?.phase).toBe('blocked');
    // Two exact names are ambiguous; never pick one silently.
    const other=await w.start({...w.intake,name:'Notes app',operationKey:'another-intake'});
    expect(await host.continueNamedProject({request:'Continue Todo app and Notes app.',operationKey:'home-delivery:4'})).toBeNull();
    const child=await resolveCoordinatorContext({DB:w.db},item.workflow.conversationId);
    expect(await child.continueNamedProject({request:'Continue Notes app',operationKey:'child-self-retry'})).toBeNull();
    expect((await readWorkflow(w.db,other.scope))?.phase).toBe('planning');
  } finally {w.sqlite.close();}
});


test("acknowledging delivery after a build failure preserves its plain blocker", async () => {
  const w=await world();
  try {
    const item=await approved(w);
    const key=item.snapshot.workflow!.pendingKey!;
    await setWorkflowBlocker(w.db,item.scope,'App checks failed; your files are saved.');
    await acknowledgeDispatch(w.db,item.scope,key);
    const state=await readWorkflow(w.db,item.scope);
    expect(state?.phase).toBe('blocked');
    expect(state?.detail).toBe('App checks failed; your files are saved.');
    expect(state?.pendingKey).toBeNull();
  } finally {w.sqlite.close();}
});

const iso = (ms: number) => new Date(ms).toISOString();
function seedActivity(w: Awaited<ReturnType<typeof world>>, projectId: string, runId: string, row: { id: string; kind?: string; subject?: string; at: number; bytes?: number }) {
  w.sqlite
    .prepare('insert into build_activity (id,projectId,runId,kind,subject,outcome,bytes,startedAt,finishedAt,durationMs) values (?,?,?,?,?,?,?,?,?,0)')
    .run(row.id, projectId, runId, row.kind ?? "command", row.subject ?? "ls", "ok", row.bytes ?? null, iso(row.at), iso(row.at));
}

describe("stalled build watchdog", () => {
  test("a building run with no progress for BUILD_STALL_MS is stopped honestly, then retryable", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const started = Date.parse((await readWorkflow(w.db, item.scope))!.updatedAt);
      expect(await reconcileStalledBuild(w.db, item.project.id, started + BUILD_STALL_MS - 1)).toBe(false);
      // A sandbox action is progress: the quiet window restarts from it.
      seedActivity(w, item.project.id, item.workflow.runId, { id: "act-progress", at: started + 60_000 });
      expect(await reconcileStalledBuild(w.db, item.project.id, started + BUILD_STALL_MS + 30_000)).toBe(false);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("building");
      // The progress card's poll is what stops it (FarmLog AI sat "building" for 80 silent minutes).
      const activity = await buildActivity(w.db, item.scope, started + 60_000 + BUILD_STALL_MS + 1);
      expect(activity.phase).toBe("blocked");
      const stopped = await readWorkflow(w.db, item.scope);
      expect(stopped?.detail).toContain("stopped making progress on the build for 20 minutes");
      expect(stopped?.detail).toContain("files are saved");
      expect(stopped?.pendingKey).toBeNull();
      await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
      // Idempotent: a second poll changes nothing.
      expect(await reconcileStalledBuild(w.db, item.project.id, started + 10 * BUILD_STALL_MS)).toBe(false);
      await retryWorkflow(w.db, item.scope, "resume-after-stall");
      expect((await requireBuildApproval(w.db, item.scope)).plan.id).toBe(item.plan.id);
    } finally { w.sqlite.close(); }
  });

  test("the cron sweep stops only stalled building runs", async () => {
    const w = await world();
    try {
      const building = await approved(w);
      const planning = await w.start({ ...w.intake, name: "Notes app", operationKey: "tool-create-two" });
      const started = Date.parse((await readWorkflow(w.db, building.scope))!.updatedAt);
      expect(await sweepStalledBuilds(w.db, started + 1_000)).toBe(0);
      expect(await sweepStalledBuilds(w.db, started + BUILD_STALL_MS + 1)).toBe(1);
      expect((await readWorkflow(w.db, building.scope))?.phase).toBe("blocked");
      expect((await readWorkflow(w.db, planning.scope))?.phase).toBe("planning");
    } finally { w.sqlite.close(); }
  });
});

describe("builder action bounds", () => {
  const stubEnv = (w: Awaited<ReturnType<typeof world>>, stub: SandboxStub, token: string, image: string) => ({
    DB: w.db, CONTREE_BASE_URL: stub.url, CONTREE_API_TOKEN: token, CONTREE_PROJECT_ID: "local-project", CONTREE_IMAGE: image,
  });
  const dispatched = (stub: SandboxStub, command: string) =>
    stub.requests.filter(r => r.method === "POST" && r.path === "/v1/instances" && (r.body as { command?: string })?.command === command).length;

  test("a spent action budget stops the build honestly; a user retry opens a fresh budget", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-budget-token" });
    stub.seedImage("tag:budget:1");
    await stub.start();
    try {
      const item = await approved(w);
      for (let i = 0; i < BUILD_ACTION_BUDGET; i++)
        seedActivity(w, item.project.id, item.workflow.runId, { id: `spent-${i}`, subject: `step ${i}`, at: Date.parse("2026-10-01T00:00:00.000Z") + i });
      const host = await resolveCoordinatorContext(stubEnv(w, stub, "local-budget-token", "tag:budget:1"), item.workflow.conversationId);
      await expect(host.driver.execute({ sessionId: host.sessionId, command: "ls", operationKey: "over-budget", timeoutMs: 1000 }))
        .rejects.toThrow("step budget");
      expect(dispatched(stub, "ls")).toBe(0);
      const stopped = await readWorkflow(w.db, item.scope);
      expect(stopped?.phase).toBe("blocked");
      expect(stopped?.detail).toContain("files are saved");
      await retryWorkflow(w.db, item.scope, "fresh-budget");
      await host.driver.execute({ sessionId: host.sessionId, command: "ls", operationKey: "fresh-window", timeoutMs: 1000 });
      expect(dispatched(stub, "ls")).toBe(1);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("the same command or identical file write repeated with nothing between is refused; replays and changed steps are not", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-repeat-token" });
    stub.seedImage("tag:repeat:1");
    await stub.start();
    try {
      const item = await approved(w);
      const host = await resolveCoordinatorContext(stubEnv(w, stub, "local-repeat-token", "tag:repeat:1"), item.workflow.conversationId);
      const run = (key: string, command = "bun run build") =>
        host.driver.execute({ sessionId: host.sessionId, command, operationKey: key, timeoutMs: 1000 });
      for (let i = 1; i <= REPEATED_ACTION_LIMIT; i++) await run(`build-${i}`);
      await expect(run("build-again")).rejects.toThrow(`already ran ${REPEATED_ACTION_LIMIT} times in a row`);
      expect(dispatched(stub, "bun run build")).toBe(REPEATED_ACTION_LIMIT);
      // Recovery replays a recorded call; that is never a repeat.
      await run(`build-${REPEATED_ACTION_LIMIT}`);
      // Changing the code between runs is real iteration.
      await host.driver.writeFile({ sessionId: host.sessionId, path: "src/App.tsx", content: "export function App() { return null; }\n" });
      await run("build-after-edit");
      expect(dispatched(stub, "bun run build")).toBe(REPEATED_ACTION_LIMIT + 1);
      const write = () => host.driver.writeFile({ sessionId: host.sessionId, path: "src/App.tsx", content: "same\n" });
      for (let i = 1; i <= REPEATED_ACTION_LIMIT; i++) await write();
      await expect(write()).rejects.toThrow("same content");
      // Refusals are per call; the build itself keeps going.
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("building");
    } finally { await stub.stop(); w.sqlite.close(); }
  });
});

const FEATURE_PRD = [
  "# Farm log",
  "",
  "Log feed and see it on a dashboard.",
  "",
  "```caddie-features",
  JSON.stringify([
    { id: "log-feed", title: "Log daily feed", doneWhen: ["Saving 12 kg shows 12 kg in today's list"] },
    { id: "view-dashboard", title: "See the feed dashboard", doneWhen: ["The dashboard totals this week's feed"] },
  ]),
  "```",
].join("\n");

describe("host-driven feature loop", () => {
  async function featureBuild(w: Awaited<ReturnType<typeof world>>, body = FEATURE_PRD) {
    const started = await w.start();
    const plan = await createPlanDocRevision(w.db, started.scope, { kind: "prd", body });
    await workflowSnapshot(w.db, started.scope);
    const snapshot = await decideWorkflow(w.db, started.scope, { planId: plan.id, decision: "approved" });
    return { ...started, plan, snapshot };
  }
  const env = (w: Awaited<ReturnType<typeof world>>, stub: SandboxStub) => ({
    DB: w.db, CONTREE_BASE_URL: stub.url, CONTREE_API_TOKEN: "local-feature-token", CONTREE_PROJECT_ID: "local-project", CONTREE_IMAGE: "tag:feature:1",
  });
  const feature = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    w.sqlite.query("select * from build_features where featureId = ?").get(id) as Record<string, unknown>;

  test("builds features in plan order, needs new passing tests per feature, and saves a checkpoint for each", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1");
    stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
    await stub.start();
    try {
      const item = await featureBuild(w);
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      // The preview waits for every feature.
      const early = (await host.verifyBuild("early")) as { passed: boolean; next: string };
      expect(early.passed).toBe(false);
      expect(early.next).toContain("Log daily feed");
      expect(stub.spawnRequestCount()).toBe(0);

      const first = (await host.buildNextFeature()) as { feature: { id: string }; position: number; total: number };
      expect(first).toMatchObject({ feature: { id: "log-feed" }, position: 1, total: 2 });
      expect(feature(w, "log-feed").status).toBe("building");
      await rejectsCode(host.finishFeature("view-dashboard", "out-of-order"), "NOT_CURRENT_FEATURE");

      const passedOne = (await host.finishFeature("log-feed", "finish-1")) as { passed: boolean; next: string };
      expect(passedOne.passed).toBe(true);
      expect(passedOne.next).toContain("See the feed dashboard");
      expect(feature(w, "log-feed")).toMatchObject({ status: "passed", testsPassed: 1 });
      expect(feature(w, "log-feed").checkpointRef).toBeTruthy();

      expect(((await host.buildNextFeature()) as { feature: { id: string } }).feature.id).toBe("view-dashboard");
      // Green checks are not enough: the feature must add passing tests.
      const noTests = (await host.finishFeature("view-dashboard", "finish-2")) as { passed: boolean; next: string };
      expect(noTests.passed).toBe(false);
      expect(noTests.next).toContain("no new passing tests");
      expect(w.count("run_rounds", "issue = 'view-dashboard:new-tests' and outcome = 'failed'")).toBe(1);
      expect(feature(w, "view-dashboard")).toMatchObject({ status: "building", attempts: 1 });

      stub.setBehavior("bun run test", { stdout: "3 pass\n0 fail" });
      const passedTwo = (await host.finishFeature("view-dashboard", "finish-3")) as { passed: boolean; next: string };
      expect(passedTwo.passed).toBe(true);
      expect(passedTwo.next).toContain("verify_build");
      expect(feature(w, "view-dashboard")).toMatchObject({ status: "passed", testsPassed: 3 });
      expect(feature(w, "view-dashboard").checkpointRef).not.toBe(feature(w, "log-feed").checkpointRef);
      expect(((await host.buildNextFeature()) as { done: boolean }).done).toBe(true);

      const activity = await buildActivity(w.db, item.scope);
      expect(activity.features.map((f) => [f.id, f.status])).toEqual([["log-feed", "passed"], ["view-dashboard", "passed"]]);
      // Nothing is offered for rollback while the build is still running.
      expect(activity.features.some((f) => f.canRollBack)).toBe(false);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("a failed check counts toward that feature only", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1");
    stub.setBehavior("bun run test", { exitCode: 1, stderr: "1 fail" });
    await stub.start();
    try {
      const item = await featureBuild(w);
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      await host.buildNextFeature();
      await host.runChecks!("dev-run");
      await host.finishFeature("log-feed", "finish-red");
      expect(w.count("run_rounds", "issue = 'log-feed:behavior-tests' and outcome = 'failed'")).toBe(2);
      expect(w.count("run_rounds", "issue = 'behavior-tests'")).toBe(0);
      expect(feature(w, "log-feed").attempts).toBe(1);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("a plan approved before feature lists builds as one whole-plan feature", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1");
    await stub.start();
    try {
      const item = await approved(w);
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      expect((await host.buildNextFeature()) as object).toMatchObject({ feature: { id: "whole-plan" }, position: 1, total: 1 });
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("an agent-written PRD without a valid feature list is not saved", async () => {
    const w = await world();
    try {
      const item = await w.start();
      const host = await resolveCoordinatorContext({ DB: w.db }, item.workflow.conversationId);
      await expect(host.writePlanNote({ kind: "prd", body: "# Farm log\n\nJust prose.", planRevision: "rev-0" })).rejects.toThrow("PLAN_FEATURES_INVALID");
      const duplicate = FEATURE_PRD.replace('"view-dashboard"', '"log-feed"');
      await expect(host.writePlanNote({ kind: "prd", body: duplicate, planRevision: "rev-0" })).rejects.toThrow("unique");
      expect(w.count("plan_doc_revisions", "kind = 'prd'")).toBe(0);
      await host.writePlanNote({ kind: "prd", body: FEATURE_PRD, planRevision: "rev-0" });
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("review");
      const activity = await buildActivity(w.db, item.scope);
      // In review the plan's features are shown, all pending, without creating rows.
      expect(activity.features.map((f) => [f.title, f.status])).toEqual([["Log daily feed", "pending"], ["See the feed dashboard", "pending"]]);
      expect(w.count("build_features")).toBe(0);
    } finally { w.sqlite.close(); }
  });

  test("rollback restarts the sandbox from a feature's save point and re-queues the later features", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1");
    stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
    await stub.start();
    try {
      const item = await featureBuild(w);
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      await host.buildNextFeature();
      await host.finishFeature("log-feed", "finish-1");
      stub.setBehavior("bun run test", { stdout: "2 pass\n0 fail" });
      await host.buildNextFeature();
      await host.finishFeature("view-dashboard", "finish-2");
      const savePoint = String(feature(w, "log-feed").checkpointRef);

      await rejectsCode(rollbackToFeature(w.db, item.scope, { featureId: "log-feed", key: "rollback-while-running" }), "BUILD_RUNNING");
      await stopWorkflow(w.db, item.scope);
      const offered = (await buildActivity(w.db, item.scope)).features;
      expect(offered.map((f) => f.canRollBack)).toEqual([true, false]);
      await rejectsCode(rollbackToFeature(w.db, item.scope, { featureId: "view-dashboard", key: "rollback-nothing-after" }), "NOTHING_TO_UNDO");
      await rejectsCode(rollbackToFeature(w.db, item.scope, { featureId: "no-such-feature", key: "rollback-no-save" }), "NOT_A_SAVE_POINT");
      await rejectsCode(rollbackToFeature(w.db, { ...item.scope, actorId: "bob" }, { featureId: "log-feed", key: "rollback-forged" }), "not_a_member");

      const rolled = await rollbackToFeature(w.db, item.scope, { featureId: "log-feed", key: "rollback-key-1" });
      expect(rolled.workflow?.phase).toBe("blocked");
      expect(rolled.workflow?.detail).toContain("Rolled back to just after “Log daily feed”");
      expect(feature(w, "view-dashboard")).toMatchObject({ status: "pending", checkpointRef: null, testsPassed: null });
      expect(feature(w, "log-feed").status).toBe("passed");
      // Replaying the same click is a no-op.
      await rollbackToFeature(w.db, item.scope, { featureId: "log-feed", key: "rollback-key-1" });
      expect(w.count("build_sandbox_sessions")).toBe(1);

      await retryWorkflow(w.db, item.scope, "continue-after-rollback");
      const resumed = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      const before = stub.requests.length;
      expect(((await resumed.buildNextFeature()) as { feature: { id: string } }).feature.id).toBe("view-dashboard");
      await resumed.driver.execute({ sessionId: resumed.sessionId, command: "ls", operationKey: "after-rollback", timeoutMs: 1000 });
      // The fresh session starts from the save point's image, not the later work.
      const started = stub.requests.slice(before).find((r) => r.method === "POST" && r.path === "/v1/instances");
      expect((started?.body as { image?: string })?.image).toBe(savePoint);
    } finally { await stub.stop(); w.sqlite.close(); }
  });
});
