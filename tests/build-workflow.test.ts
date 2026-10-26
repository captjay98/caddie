import {SandboxDriver} from '../apps/app/src/server/adapters/sandbox.ts';
import { putLarge } from "../apps/app/src/server/large-content.ts";
import { describe, test, expect, spyOn } from "bun:test";
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
  decideDesign,
  decideLooks,
  acknowledgeDispatch,
  requireBuildApproval,
  storeBuildOutput,
  readBuildOutput,
  readOutputManifest,
  readPublishBundle,
  readBuildBundle,
  setWorkflowBlocker,
  stopWorkflow,
  planIntent,
  designIntent,
  retryWorkflow,
  workflowRepairPause,
  continueProjectFromChat,
  reconcileStalledBuild,
  sweepStalledBuilds,
  BUILD_STALL_MS,
  MAX_PREVIEW_PAGE_BYTES,
} from "../apps/app/src/server/build-workflow.ts";
import { PREVIEW_LIMIT, STORAGE_LIMIT, previewDocument, previewSeed } from "../apps/app/src/shared/preview-frame.ts";
import { prepareOperation, markDispatched, markReconciliationRequired } from "../apps/app/src/server/operations.ts";
import { androidDownloadView, createAndroidAppRouter } from "../apps/app/src/server/android-app.ts";
import { buildActivity } from "../apps/app/src/server/build-activity.ts";
import { rollbackToFeature } from "../apps/app/src/server/build-features.ts";
import { BUILD_ACTION_BUDGET, REPEATED_ACTION_LIMIT, ROLE_TOOL_POLICY } from "../apps/app/src/agents/permissions.ts";
import { resolveCoordinatorContext, resolveModuleBuilderContext } from "../apps/app/src/server/coordinator-host.ts";
import { getModule, seedModules, takeSlot } from "../apps/app/src/server/module-slots.ts";
import { ContreeClient } from "../apps/app/src/server/adapters/contree.ts";
import { retryPart } from "../apps/app/src/server/module-join.ts";
import { listAppSecrets, setAppSecret } from "../apps/app/src/server/app-secrets.ts";
import { parseKeyring } from "../apps/app/src/server/secret-box.ts";
import { makeRequestAppKey } from "../apps/app/src/agents/tools.ts";
import { LocalCodeStore, listCodeVersions, readVersionFiles, recordCodeVersion } from "../apps/app/src/server/code-versions.ts";
import { restoreVersion } from "../apps/app/src/server/version-restore.ts";
import { SCAFFOLD_COMMANDS } from "../stacks/react-hono/scaffold.ts";
import {
  checkedCoordinatorSnapshot,
  coordinatorSnapshot,
  scopedCoordinatorContext,
} from "../apps/app/src/agents/host-context.ts";
import { SandboxStub } from "./fixtures/sandbox-stub.ts";
import { upsertProfile } from "../apps/app/src/server/profiles.ts";
import { splitSqlStatements } from "./fixtures/controls-harness.ts";
import { documentHash, type FidelityPort } from "../apps/app/src/server/visual-fidelity.ts";
import { chooseLook, saveLooks, FIELD_LOOK } from "./fixtures/looks-fixture.ts";

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
    "0024_design_phase.sql",
    "0026_code_versions.sql",
    "0027_app_secrets.sql",
    "0028_app_publishing.sql",
    // Track 3: the large-file store (an Android app's preview page and APK).
    "0039_large_content.sql",
    // Judge accounts (the build-start payer reads them) and team mode (the
    // spending-limit tables and the workflow mode columns).
    "0033_judge_accounts.sql",
    "0040_team_mode.sql",
    // Part P: the module rows and slots the module-builder tests seed.
    "0042_module_builders.sql",
    // Part Q: the integration lock a part's join takes.
    "0043_integration_lock.sql",
    // The choose-a-look step: the workflow's looks / looks-review phases.
    "0044_looks_phase.sql",
    // B03: content hash on build_activity for the progress guard.
    "0047_build_activity_content_hash.sql",
    "0048_repair_escalation.sql",
    "0049_build_environment.sql",
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
  // Approving the PRD now enters the LOOKS step, then DESIGN, not building. To
  // keep the downstream build tests exercising a 'building' workflow, this
  // helper carries through: PRD approved -> looks, save + choose a look ->
  // design, save the design brief -> design-review, approve the design ->
  // building. A test that wants to assert the intermediate phases uses
  // planned()/designReady() directly.
  await decideWorkflow(w.db, item.scope, {
    planId: item.plan.id,
    decision: "approved",
  });
  await chooseLook(w.db, item.scope);
  const design = await createPlanDocRevision(w.db, item.scope, {
    kind: "design",
    body: "# Design brief\n\nOne screen: a feed-log form and a totals dashboard. Loading, empty and error states defined.",
  });
  await workflowSnapshot(w.db, item.scope);
  const snapshot = await decideDesign(w.db, item.scope, {
    designId: design.id,
    decision: "approved",
  });
  return { ...item, design, snapshot };
}
/** Through PRD approval into the DESIGN phase, with the brief saved and awaiting
 *  review — the state the design-review tests assert against. */
async function designReady(w: Awaited<ReturnType<typeof world>>) {
  const item = await planned(w);
  await decideWorkflow(w.db, item.scope, {
    planId: item.plan.id,
    decision: "approved",
  });
  await chooseLook(w.db, item.scope);
  const design = await createPlanDocRevision(w.db, item.scope, {
    kind: "design",
    body: "# Design brief\n\nScreens, states and token choices for the todo app.",
  });
  const snapshot = await workflowSnapshot(w.db, item.scope);
  return { ...item, design, snapshot };
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

// Regression (2026-10-23 identity/bootstrap failure, proj_506d61…): a coordinator
// DO whose stale alarm record predated Flue 2.2.2's __ps_name persistence wedged
// (ctx.id.name undefined + no fallback), so its parked planning handoff never ran
// and the UI sat on "turning your request into a plan" forever. workflowSnapshot
// now exposes dispatchStalled so the UI can show an actionable retry — but ONLY
// once re-delivery has demonstrably failed to converge (not while it is in flight).
describe("dispatchStalled: a planning handoff that will not converge is surfaced", () => {
  const LEASE_MS = 2 * 60_000;

  test("a reconciliation-required handoff older than the redelivery lease reads dispatchStalled", async () => {
    const w = await world();
    try {
      const started = await w.start(); // planning, with a parked pendingKey
      const key = started.workflow.pendingKey!;
      await prepareOperation(w.db, {
        projectId: started.scope.projectId,
        runId: started.workflow.runId,
        provider: "coordinator-dispatch",
        operationKey: key,
      });
      await markDispatched(w.db, key, `delivered:${key}`);
      await markReconciliationRequired(w.db, key);
      // Backdate the operation past one lease so it counts as not converging,
      // not merely in flight.
      w.sqlite
        .query('update external_operations set "updatedAt" = ? where "operationKey" = ?')
        .run(new Date(Date.now() - LEASE_MS - 1_000).toISOString(), key);

      const snapshot = await workflowSnapshot(w.db, started.scope);
      expect(snapshot.workflow?.phase).toBe("planning");
      expect(snapshot.dispatchStalled).toBe(true);
    } finally {
      w.sqlite.close();
    }
  });

  test("a fresh (in-flight) handoff within the lease is NOT stalled — no false error flashes", async () => {
    const w = await world();
    try {
      const started = await w.start();
      const key = started.workflow.pendingKey!;
      await prepareOperation(w.db, {
        projectId: started.scope.projectId,
        runId: started.workflow.runId,
        provider: "coordinator-dispatch",
        operationKey: key,
      });
      await markDispatched(w.db, key, `delivered:${key}`);
      await markReconciliationRequired(w.db, key); // just now, within the lease
      const snapshot = await workflowSnapshot(w.db, started.scope);
      expect(snapshot.dispatchStalled).toBe(false);
    } finally {
      w.sqlite.close();
    }
  });

  test("no operation row at all (handoff not yet attempted) is NOT stalled", async () => {
    const w = await world();
    try {
      const started = await w.start();
      const snapshot = await workflowSnapshot(w.db, started.scope);
      expect(snapshot.workflow?.pendingKey).toBeTruthy();
      expect(snapshot.dispatchStalled).toBe(false);
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

  test("a separately saved design part cannot start a build", async () => {
    const w = await world();
    try {
      const item = await designReady(w);
      const fragment = await createPlanDocRevision(w.db, item.scope, {
        kind: "design", body: "# Farmhand — Design Brief (part 3)\nOnly the final screens.",
      });
      await expect(decideDesign(w.db, item.scope, { designId: fragment.id, decision: "approved" })).rejects.toMatchObject({ code: "DESIGN_INCOMPLETE" });
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("design-review");
    } finally { w.sqlite.close(); }
  });

  test("authenticated design approval queues one build and replay after dispatch acknowledgment cannot restart it", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const queued = item.snapshot.workflow!;
      expect(queued.phase).toBe("building");
      expect(queued.pendingKey).toBe(`design-decision:${item.snapshot.designApproval!.id}`);
      expect(item.snapshot.designApproval?.decidedBy).toBe("alice");
      expect((await requireBuildApproval(w.db, item.scope)).plan.id).toBe(
        item.plan.id,
      );
      const doubleClick = await decideDesign(w.db, item.scope, {
        designId: item.design.id,
        decision: "approved",
      });
      expect(doubleClick.workflow?.pendingKey).toBe(queued.pendingKey);
      // One plan decision (PRD) + one look choice + one design decision; the
      // double-click adds none.
      expect(w.count("plan_decisions")).toBe(3);
      await acknowledgeDispatch(w.db, item.scope, queued.pendingKey!);
      const replay = await decideDesign(w.db, item.scope, {
        designId: item.design.id,
        decision: "approved",
      });
      expect(replay.workflow?.phase).toBe("building");
      expect(replay.workflow?.pendingKey).toBeNull();
      // One PRD approval + one design approval = two approvals total; the look
      // choice is a plan decision only (it opens no spending and gates no build).
      expect(w.count("approvals")).toBe(2);
      expect(w.count("plan_decisions")).toBe(3);
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
      // The revised PRD's approval enters the look step, then design; approve
      // the design brief to reach the build gate.
      await chooseLook(w.db, item.scope);
      const design = await createPlanDocRevision(w.db, item.scope, {
        kind: "design",
        body: "# Design brief\n\nCalm palette, keyboard shortcuts, states defined.",
      });
      await workflowSnapshot(w.db, item.scope);
      await decideDesign(w.db, item.scope, { designId: design.id, decision: "approved" });
      expect((await requireBuildApproval(w.db, item.scope)).plan.id).toBe(
        next.id,
      );
    } finally {
      w.sqlite.close();
    }
  });

  test("the repair ladder pauses the approved run only after six failed attempts, not three", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      // The repair ladder (always-on repair-v1) escalates across models and
      // allows SIX checked failures (two per model) before pausing — not the
      // old three-attempt weak fallback. Three failures must NOT pause yet.
      for (let i = 0; i < 3; i++)
        await recordRepairRound(w.db, item.scope, item.workflow.runId, {
          issue: "build failure",
          round: "repair_attempt",
          outcome: "failed",
        });
      expect((await workflowRepairPause(w.db, item.workflow.runId)).paused).toBe(false);
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

describe("design review and the build gate", () => {
  test("approving the PRD enters the look step; choosing a look starts the design in it; building stays gated until the design is approved", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      const afterPlan = await decideWorkflow(w.db, item.scope, {
        planId: item.plan.id,
        decision: "approved",
      });
      // PRD approval goes to the LOOKS step, NOT design or building.
      expect(afterPlan.workflow?.phase).toBe("looks");
      expect(afterPlan.workflow?.pendingBody).toContain("CHOOSE A LOOK");
      expect(afterPlan.workflow?.pendingBody).toContain("kind:'looks'");
      expect(afterPlan.looks).toBeNull();
      await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
      // A design saved before a look is chosen does not jump the owner's choice.
      await createPlanDocRevision(w.db, item.scope, { kind: "design", body: "# Too early\n\nA brief." });
      expect((await workflowSnapshot(w.db, item.scope)).workflow?.phase).toBe("looks");
      // Saving the looks advances looks -> looks-review.
      const { looks, snapshot: choosing } = await saveLooks(w.db, item.scope);
      expect(choosing.workflow?.phase).toBe("looks-review");
      expect(choosing.looks?.id).toBe(looks.id);
      await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
      // Choosing a look enters design, with that look's theme handed to the designer.
      const chosen = await decideLooks(w.db, item.scope, { looksId: looks.id, choice: "calm", note: "a little warmer" });
      expect(chosen.workflow?.phase).toBe("design");
      expect(chosen.workflow?.pendingKey?.startsWith("looks:")).toBe(true);
      expect(chosen.workflow?.pendingBody).toContain('chose the look "Calm and clear"');
      expect(chosen.workflow?.pendingBody).toContain("```caddie-theme");
      expect(chosen.workflow?.pendingBody).toContain('"primary": "#2B5FD9"');
      expect(chosen.workflow?.pendingBody).toContain("poultry and catfish farmers");
      expect(chosen.workflow?.pendingBody).toContain("a little warmer");
      expect(chosen.workflow?.pendingBody).not.toContain('"id": "calm"');
      const [decision] = await listPlanDecisions(w.db, item.scope, looks.id);
      expect(decision?.decision).toBe("approved");
      expect(decision?.note).toBe("look:calm\na little warmer");
      await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
      // Saving the design brief advances design -> design-review.
      const design = await createPlanDocRevision(w.db, item.scope, {
        kind: "design",
        body: "# Design brief\n\nScreens, states and tokens.",
      });
      const review = await workflowSnapshot(w.db, item.scope);
      expect(review.workflow?.phase).toBe("design-review");
      expect(review.design?.id).toBe(design.id);
      expect(review.designApproval).toBeNull();
      await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
      // Approving the design brief is the gate to building.
      const built = await decideDesign(w.db, item.scope, {
        designId: design.id,
        decision: "approved",
      });
      expect(built.workflow?.phase).toBe("building");
      expect(built.workflow?.pendingKey).toBe(`design-decision:${built.designApproval!.id}`);
      expect((await requireBuildApproval(w.db, item.scope)).plan.id).toBe(item.plan.id);
    } finally {
      w.sqlite.close();
    }
  });

  test("asking for other looks returns to the look step with the owner's words, and waits for a NEW proposal", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
      const { looks } = await saveLooks(w.db, item.scope);
      const more = await decideLooks(w.db, item.scope, { looksId: looks.id, more: true, note: "Designed for: office staff at a desk" });
      expect(more.workflow?.phase).toBe("looks");
      expect(more.workflow?.pendingBody).toContain("asked for other looks");
      expect(more.workflow?.pendingBody).toContain('"Field-ready", "Calm and clear", "Warm and bold"');
      expect(more.workflow?.pendingBody).toContain("office staff at a desk");
      const [decision] = await listPlanDecisions(w.db, item.scope, looks.id);
      expect(decision?.decision).toBe("changes");
      // The answered proposal does not re-advance on its own.
      expect((await workflowSnapshot(w.db, item.scope)).workflow?.phase).toBe("looks");
      const { looks: second, snapshot } = await saveLooks(w.db, item.scope);
      expect(snapshot.workflow?.phase).toBe("looks-review");
      expect(snapshot.looks?.id).toBe(second.id);
      expect(second.id).not.toBe(looks.id);
    } finally {
      w.sqlite.close();
    }
  });

  test("a look answer is refused for stale looks, a look not offered, or an unclear request; a replay records and sends nothing", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
      const { looks } = await saveLooks(w.db, item.scope);
      await rejectsCode(decideLooks(w.db, item.scope, { looksId: "not-these", choice: "field" }), "STALE_LOOKS");
      await rejectsCode(decideLooks(w.db, item.scope, { looksId: looks.id, choice: "neon" }), "invalid_look");
      await rejectsCode(decideLooks(w.db, item.scope, { looksId: looks.id }), "invalid_decision");
      await rejectsCode(decideLooks(w.db, item.scope, { looksId: looks.id, choice: "field", more: true }), "invalid_decision");
      await rejectsCode(decideLooks(w.db, item.scope, { looksId: looks.id, choice: "field", note: "x".repeat(2001) }), "note_too_long");
      await rejectsCode(decideLooks(w.db, { ...item.scope, actorId: "bob" }, { looksId: looks.id, choice: "field" }), "not_a_member");
      const first = await decideLooks(w.db, item.scope, { looksId: looks.id, choice: "field" });
      const key = first.workflow?.pendingKey;
      const replay = await decideLooks(w.db, item.scope, { looksId: looks.id, choice: "warm" });
      expect(replay.workflow?.phase).toBe("design");
      expect(replay.workflow?.pendingKey).toBe(key);
      expect(replay.workflow?.pendingBody).toContain('"Field-ready"');
      expect(await listPlanDecisions(w.db, item.scope, looks.id)).toHaveLength(1);
    } finally {
      w.sqlite.close();
    }
  });

  test("looks or a design written for an EARLIER plan version never reach the owner as current", async () => {
    const w = await world();
    try {
      const item = await planned(w);
      await decideWorkflow(w.db, item.scope, { planId: item.plan.id, decision: "approved" });
      await chooseLook(w.db, item.scope);
      await createPlanDocRevision(w.db, item.scope, { kind: "design", body: "# Design for v1\n\nOld screens." });
      expect((await workflowSnapshot(w.db, item.scope)).workflow?.phase).toBe("design-review");
      // The owner changes the plan before deciding the design.
      const v2 = await createPlanDocRevision(w.db, item.scope, { kind: "prd", body: "# Todo app v2\n\nTasks with due dates." });
      const back = await workflowSnapshot(w.db, item.scope);
      expect(back.workflow?.phase).toBe("review");
      expect(back.looks).toBeNull();
      await decideWorkflow(w.db, item.scope, { planId: v2.id, decision: "approved" });
      // The v1 looks were answered and are older than v2: the step waits for new looks.
      expect((await workflowSnapshot(w.db, item.scope)).workflow?.phase).toBe("looks");
      await chooseLook(w.db, item.scope, "warm");
      // The undecided v1 design is older than v2: it does not skip the new design.
      const designing = await workflowSnapshot(w.db, item.scope);
      expect(designing.workflow?.phase).toBe("design");
    } finally {
      w.sqlite.close();
    }
  });

  test("rejecting the design brief returns to design with durable feedback and does not advance until a NEW revision", async () => {
    const w = await world();
    try {
      const item = await designReady(w);
      expect(item.snapshot.workflow?.phase).toBe("design-review");
      await rejectsCode(
        decideDesign(w.db, item.scope, { designId: item.design.id, decision: "rejected", note: " " }),
        "feedback_required",
      );
      const feedback = "Use a warmer palette and bigger tap targets";
      const rejected = await decideDesign(w.db, item.scope, {
        designId: item.design.id,
        decision: "rejected",
        note: feedback,
      });
      expect(rejected.workflow?.phase).toBe("design");
      expect(rejected.workflow?.pendingBody).toContain(feedback);
      // The rejected brief does NOT re-advance to review on its own — it is decided.
      const stillDesign = await workflowSnapshot(w.db, item.scope);
      expect(stillDesign.workflow?.phase).toBe("design");
      await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
      // A new design revision supersedes it and advances to design-review again.
      const revised = await createPlanDocRevision(w.db, item.scope, {
        kind: "design",
        body: `# Design brief v2\n\n${feedback}`,
      });
      const back = await workflowSnapshot(w.db, item.scope);
      expect(back.workflow?.phase).toBe("design-review");
      expect(back.design?.id).toBe(revised.id);
    } finally {
      w.sqlite.close();
    }
  });

  test("a design decision cannot act from the wrong phase or against a stale design id", async () => {
    const w = await world();
    try {
      const item = await designReady(w);
      await rejectsCode(
        decideDesign(w.db, item.scope, { designId: "not-the-design", decision: "approved" }),
        "STALE_DESIGN",
      );
      const other = { ...item.scope, actorId: "bob" };
      await rejectsCode(
        decideDesign(w.db, other, { designId: item.design.id, decision: "approved" }),
        "not_a_member",
      );
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

  test("a backend build keeps its server bundle and migrations with the output", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const server = "export default { fetch() { return new Response('ok'); } };";
      const migrations = [
        { name: "0002_tags.sql", sql: "alter table notes add column tag text;" },
        { name: "0001_init.sql", sql: "create table notes (id integer primary key, body text);" },
      ];
      const output = await storeBuildOutput(w.db, item.scope, {
        html: "<!doctype html><html><body>notes</body></html>",
        image: "sha256:backend-image",
        planId: item.plan.id,
        runId: item.workflow.runId,
        bundle: { server, migrations },
      });
      const bundle = await readBuildBundle(w.db, item.scope, output.outputId);
      expect(bundle?.server).toBe(server);
      expect(bundle?.migrations.map((m) => m.name)).toEqual(["0001_init.sql", "0002_tags.sql"]);
      expect(bundle?.migrations[0]?.sql).toContain("create table notes");
      const other = await w.start({ ...w.intake, operationKey: "bundle-other-project" });
      await rejectsCode(readBuildBundle(w.db, other.scope, output.outputId), "preview_not_found");
    } finally {
      w.sqlite.close();
    }
  });

  test("a client-only build has no bundle, and a bad migration name is refused", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      await rejectsCode(
        storeBuildOutput(w.db, item.scope, {
          html: "<!doctype html><html><body>bad</body></html>",
          image: "sha256:bad-image",
          planId: item.plan.id,
          runId: item.workflow.runId,
          bundle: { server: "export default {}", migrations: [{ name: "../escape.sql", sql: "select 1" }] },
        }),
        "INVALID_MIGRATION",
      );
      expect(w.count("workflow_outputs")).toBe(0);
      const plain = await storeBuildOutput(w.db, item.scope, {
        html: "<!doctype html><html><body>static</body></html>",
        image: "sha256:static-image",
        planId: item.plan.id,
        runId: item.workflow.runId,
      });
      expect(await readBuildBundle(w.db, item.scope, plain.outputId)).toBeNull();
    } finally {
      w.sqlite.close();
    }
  });

  test("a page at the cap still opens: with the frame's own script and the most saved data, the frame document fits in 5 MB (part R)", () => {
    // The worst saved data: 100 KB of "<", which the document escapes six-fold.
    const seed = previewSeed({ k: "<".repeat(STORAGE_LIMIT - 1) })!;
    expect(seed).not.toBeNull();
    const page = `<!doctype html><html><body>${"z".repeat(MAX_PREVIEW_PAGE_BYTES - 60)}</body></html>`;
    expect(new TextEncoder().encode(page).length).toBeLessThanOrEqual(MAX_PREVIEW_PAGE_BYTES);
    const frameDocument = previewDocument(page, "abcdefgh12345678", seed, true, "web");
    // MUTATION: a cap of the frame's full 5 MB, and this document is too big to open.
    expect(new TextEncoder().encode(frameDocument).length).toBeLessThanOrEqual(PREVIEW_LIMIT);
  });

  test("a preview page up to 4.3 MB is kept and served whole (over 2 MB in parts, part R); a bigger one is refused in plain words with its size", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      // Over what the preview frame can open (5 MB, less room for the frame's
      // own script and saved data): refused, saying how big it is.
      const error = await storeBuildOutput(w.db, item.scope, {
        html: `<html>${"x".repeat(5_600_000)}</html>`,
        image: "sha256:huge-preview",
        planId: item.plan.id,
        runId: item.workflow.runId,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ScopeError);
      expect((error as ScopeError).code).toBe("INVALID_PREVIEW");
      expect((error as ScopeError).message).toBe(
        "This app's preview page is 5.4 MB, and a preview can be at most 4.3 MB. Make the app's code smaller (load big files only when needed) and check again.",
      );

      // A big app's page (4.4 MB): over one D1 value, so it is kept in parts
      // (the large-file store) and served back byte for byte.
      const bigPage = `<!doctype html><html><body><script>${"y".repeat(4_400_000)}</script></body></html>`;
      const big = await storeBuildOutput(w.db, item.scope, {
        html: bigPage,
        image: "sha256:big-app-preview",
        planId: item.plan.id,
        runId: item.workflow.runId,
      });
      const served = await readBuildOutput(w.db, item.scope, big.outputId);
      expect(served.length).toBe(new TextEncoder().encode(bigPage).length);
      expect(new TextDecoder().decode(served)).toBe(bigPage);
      expect(w.count("large_content")).toBe(1);
      // MUTATION: store it in one value again, and production D1 refuses the write.
      expect(w.count("artifact_content", "size > 2000000")).toBe(0);
    } finally { w.sqlite.close(); }

    // FarmLog AI (with sql.js): the preview page carries the whole app, and
    // it passed the old 500 KB cap, so a finished build got no preview. Under
    // 2 MB it stays one ordinary value, as before.
    const w2 = await world();
    try {
      const item = await approved(w2);
      const page = `<!doctype html><html><body><script>${"x".repeat(1_200_000)}</script></body></html>`;
      const output = await storeBuildOutput(w2.db, item.scope, {
        html: page,
        image: "sha256:large-preview",
        planId: item.plan.id,
        runId: item.workflow.runId,
      });
      expect(new TextDecoder().decode(await readBuildOutput(w2.db, item.scope, output.outputId))).toBe(page);
      expect(w2.count("large_content")).toBe(0);
    } finally { w2.sqlite.close(); }
  });

  test("an Android app's preview page (bigger than one D1 value) is kept whole and served instead of the stand-in", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const page = `<!doctype html><html><body><script type="application/json">${"x".repeat(3_000_000)}</script></body></html>`;
      const output = await storeBuildOutput(w.db, item.scope, {
        html: "<!doctype html><html><body>stand-in</body></html>",
        image: "sha256:flutter-image",
        planId: item.plan.id,
        runId: item.workflow.runId,
        bundle: { server: "export default {};", migrations: [], flutterWeb: page },
      });
      const served = new TextDecoder().decode(await readBuildOutput(w.db, item.scope, output.outputId));
      expect(served).toBe(page);
      expect((await readOutputManifest(w.db, item.scope, output.outputId))?.kind).toBe("flutter");
      expect(w.count("large_content")).toBe(1);
      expect(w.count("large_content_chunks")).toBe(2);
      // Nothing over D1's value limit went into the ordinary content table.
      expect(w.count("artifact_content", "size > 2000000")).toBe(0);
    } finally {
      w.sqlite.close();
    }
  });

  test("a Flutter publication binds the APK checksum to the approved immutable manifest", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      const apk = new Uint8Array(1_100_000); apk.set([0x50, 0x4b, 3, 4]);
      const output = await storeBuildOutput(w.db, item.scope, {
        html: "<html>Android app</html>", image: "flutter-apk-image", planId: item.plan.id, runId: item.workflow.runId,
        bundle: { server: "export default {};", migrations: [], flutterWeb: "<html>Flutter</html>", android: { ...(await putLarge(w.db, apk)), apiBase: "https://caddie.test/a/project" } },
      });
      expect((await readOutputManifest(w.db, item.scope, output.outputId))?.publishable).toBe(true);
      const publication = await readPublishBundle(w.db, item.scope, output.outputId);
      expect(publication.android?.bytes).toBe(apk.length);
      expect(publication.android?.sha256).toHaveLength(64);
      expect(publication.android?.apiBase).toBe("https://caddie.test/a/project");
      const origin = "https://caddie.test"; const secret = "test-only-android-link-secret";
      const metadata = await androidDownloadView(w.db, item.scope, origin, secret);
      expect(metadata?.bytes).toBe(apk.length);
      expect(metadata?.url).toBeNull();
      expect(metadata?.backendLive).toBe(false);
      const signed = await androidDownloadView(w.db, item.scope, origin, secret, true);
      expect(signed?.url).toContain("/app.apk?t=");
      expect(Date.parse(signed!.expiresAt!) - Date.now()).toBeGreaterThan(29 * 60_000);
      const reply = await createAndroidAppRouter().request(signed!.url!, {}, { DB: w.db, BETTER_AUTH_SECRET: secret });
      expect(reply.status).toBe(200);
      expect(new Uint8Array(await reply.arrayBuffer())).toEqual(apk);
      await expect(androidDownloadView(w.db, { ...item.scope, actorId: "bob" }, origin, secret, true)).rejects.toThrow("member");
      w.sqlite.prepare('delete from workspace_memberships where workspaceId = ? and userId = ?').run(item.scope.workspaceId, item.scope.actorId);
      await expect(androidDownloadView(w.db, item.scope, origin, secret, true)).rejects.toThrow("member");
      w.sqlite.prepare('insert into workspace_memberships (id,workspaceId,userId,role,createdAt) values (?, ?,?,?,?)').run("restore-member", item.scope.workspaceId, item.scope.actorId, "owner", new Date().toISOString());

      // Store another complete, valid APK so the old metadata-only route
      // would serve wrong bytes (rather than fail because the blob is absent).
      const replacementApk = apk.slice(); replacementApk[100] = 42;
      const replacement = await putLarge(w.db, replacementApk);
      w.sqlite.prepare('update workflow_outputs set apkSha256 = ?, apkBytes = ? where id = ?').run(replacement.sha256, replacement.bytes, output.outputId);
      await expect(readPublishBundle(w.db, item.scope, output.outputId)).rejects.toThrow("Android package");
      expect((await createAndroidAppRouter().request(signed!.url!, {}, { DB: w.db, BETTER_AUTH_SECRET: secret })).status).toBe(404);
      await expect(androidDownloadView(w.db, item.scope, origin, secret, true)).rejects.toThrow('no checked Android package');
    } finally { w.sqlite.close(); }
  });

  test("a server bundle or client file over 2 MB is kept in parts and read back whole (part R); over its cap it is refused at check time", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      // Over the caps: a server over 10 MB, a script over 4.5 MB (what a preview page holds).
      await rejectsCode(
        storeBuildOutput(w.db, item.scope, {
          html: "<!doctype html><html><body>huge</body></html>",
          image: "sha256:huge-image",
          planId: item.plan.id,
          runId: item.workflow.runId,
          bundle: { server: "export default {};\n" + "a".repeat(10_600_000), migrations: [] },
        }),
        "SERVER_TOO_LARGE",
      );
      await rejectsCode(
        storeBuildOutput(w.db, item.scope, {
          html: "<!doctype html><html><body>huge</body></html>",
          image: "sha256:huge-image-2",
          planId: item.plan.id,
          runId: item.workflow.runId,
          bundle: { server: null, migrations: [], client: { js: "x".repeat(5_600_000), css: "" } },
        }),
        "CLIENT_TOO_LARGE",
      );
      expect(w.count("workflow_outputs")).toBe(0);

      // 2.5 MB: over D1's real 2,000,000-byte value limit, so it goes to the
      // large-file store in parts instead of one value production would refuse.
      const bigServer = "export default {};\n" + "a".repeat(2_500_000);
      const bigScript = "x".repeat(2_500_000);
      const output = await storeBuildOutput(w.db, item.scope, {
        html: "<!doctype html><html><body>big</body></html>",
        image: "sha256:big-image",
        planId: item.plan.id,
        runId: item.workflow.runId,
        bundle: { server: bigServer, migrations: [], client: { js: bigScript, css: "body{}" } },
      });
      // The preview relay (/app) and publishing read it back byte for byte.
      expect((await readBuildBundle(w.db, item.scope, output.outputId))?.server).toBe(bigServer);
      const publication = await readPublishBundle(w.db, item.scope, output.outputId);
      expect(publication.server).toBe(bigServer);
      expect(publication.js).toBe(bigScript);
      expect(publication.css).toBe("body{}");
      expect(w.count("large_content")).toBe(2);
      // MUTATION: keep either in one value again, and production D1 refuses the write.
      expect(w.count("artifact_content", "size > 2000000")).toBe(0);
      expect(w.count("workflow_outputs")).toBe(1);
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
      // PRD approval enters the look step, then design; carry through to
      // building so the output guards below (which require phase 'building')
      // are what is tested.
      await chooseLook(w.db, item.scope);
      const design = await createPlanDocRevision(w.db, item.scope, {
        kind: "design",
        body: "# Design brief\n\nScreens and states for the todo app.",
      });
      await workflowSnapshot(w.db, item.scope);
      await decideDesign(w.db, item.scope, { designId: design.id, decision: "approved" });
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
          html: `<html>${"x".repeat(5 * 1024 * 1024 + 1)}</html>`,
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

  test("a new admission or revoked design immediately before publication cannot publish the old result",async()=>{
    for(const change of ['payer','design'] as const) {
      const w=await world();try {
        const item=await approved(w);
        w.hooks.beforeBatch=()=>{
          w.hooks.beforeBatch=null;
          if(change==='payer')w.sqlite.prepare('update build_workflows set spendPayerId=? where projectId=?').run('new-admission',item.project.id);
          else w.sqlite.prepare("update approvals set status='revoked' where resourceId=?").run(item.design.id);
        };
        await expect(storeBuildOutput(w.db,item.scope,{html:'<html>Checked older work</html>',image:'checked-old-image',planId:item.plan.id,runId:item.workflow.runId})).rejects.toBeInstanceOf(ScopeError);
        expect((await readWorkflow(w.db,item.scope))?.phase).not.toBe('ready');
      }finally{w.sqlite.close();}
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
  test("retry preserves evidence, is idempotent, and opens a fresh repair window", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      // Three failures under the first admission do not exhaust the ladder (6).
      for (let i = 0; i < 3; i++)
        await recordRepairRound(w.db, item.scope, item.workflow.runId, {
          issue: "build",
          round: "repair_attempt",
          outcome: "failed",
        });
      await setWorkflowBlocker(w.db, item.scope, "Three failed checks");
      const retry = await retryWorkflow(w.db, item.scope, "recovery-test-1");
      expect(retry.workflow?.phase).toBe("building");
      // Retry opens a new payer/admission, so the repair window is fresh.
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
      // The fresh window allows its own full six attempts before pausing.
      for (let i = 0; i < 5; i++)
        await recordRepairRound(w.db, item.scope, item.workflow.runId, {
          issue: "build",
          round: "repair_attempt",
          outcome: "failed",
        });
      expect(
        (await workflowRepairPause(w.db, item.workflow.runId)).paused,
      ).toBe(false);
      await recordRepairRound(w.db, item.scope, item.workflow.runId, {
          issue: "build",
          round: "repair_attempt",
          outcome: "failed",
        });
      await rejectsCode(requireBuildApproval(w.db, item.scope), "RUN_PAUSED");
      expect(w.count("run_rounds")).toBe(9);
    } finally {
      w.sqlite.close();
    }
  });

  test("a build retry carries a message parked while blocked, instead of dropping it", async () => {
    // A user asks to continue a blocked build WITHOUT resumeBlocked: the request
    // is parked under a `continue:` pendingKey (continueProjectFromChat). When the
    // build is later retried (e.g. POST /workflow/retry, which passes no request),
    // that parked message must reach the builder, not be overwritten — the same
    // carry resumePlanning already does for a blocked plan.
    const w = await world();
    try {
      const item = await approved(w);
      await acknowledgeDispatch(w.db, item.scope, item.snapshot.workflow!.pendingKey!);
      for (let i = 0; i < 3; i++)
        await recordRepairRound(w.db, item.scope, item.workflow.runId, {
          issue: "behavior-tests",
          round: "repair_attempt",
          outcome: "failed",
        });
      await setWorkflowBlocker(w.db, item.scope, "Checks failed");
      // Park a message (no resumeBlocked) → pendingKey "continue:…", pendingBody = request.
      const parkedMessage = "Fix the AI tier and store data in the database, please.";
      await continueProjectFromChat(w.db, w.homeScope, {
        projectId: item.project.id,
        request: parkedMessage,
        operationKey: "parked-while-blocked",
      });
      const parked = await readWorkflow(w.db, item.scope);
      expect(parked?.pendingKey?.startsWith("continue:")).toBe(true);
      // Retry with NO request, as the route does.
      const retry = await retryWorkflow(w.db, item.scope, "retry-after-park");
      expect(retry.workflow?.phase).toBe("building");
      expect(retry.workflow?.pendingBody).toContain(parkedMessage);
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
      // The dependencies check is the verified install: the sha512 check runs first, with the same env.
      const spawned = stub.requests.filter(r => r.method === "POST" && r.path === "/v1/instances")
        .map(r => r.body as { command: string; env?: Record<string,string> });
      const check = spawned.findIndex(r => r.command.includes("caddie-verified-install"));
      expect(check).toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThan(spawned.findIndex(r => r.command === "bun install --frozen-lockfile"));
      expect(spawned[check]!.env?.PATH?.split(":")).toContain("/root/.bun/bin");
      expect(JSON.stringify(spawned[check])).not.toContain("local-runtime-token");
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

describe("app keys during a build", () => {
  test("the builder can ask for a key only in an approved build, and learns only its status", async () => {
    const w = await world();
    try {
      const draft = await planned(w);
      const early = await resolveCoordinatorContext({ DB: w.db }, draft.workflow.conversationId);
      await expect(early.requestAppKey!({ name: "WEATHER_API_KEY", description: "Reads the forecast." })).rejects.toThrow();
      expect(await listAppSecrets(w.db, draft.scope)).toEqual([]);

      const item = await approved(w);
      const host = await resolveCoordinatorContext({ DB: w.db }, item.workflow.conversationId);
      const asked = await host.requestAppKey!({ name: "WEATHER_API_KEY", description: "Lets the app read the forecast.", helpUrl: "https://home.openweathermap.org/api_keys" });
      expect(asked).toEqual({ name: "WEATHER_API_KEY", status: "requested" });
      const listed = await listAppSecrets(w.db, item.scope);
      expect(listed.map((k) => [k.name, k.status, k.requested, k.helpUrl])).toEqual([["WEATHER_API_KEY", "requested", true, "https://home.openweathermap.org/api_keys"]]);

      // Once the owner saved it, asking again reports it as saved and still carries no value.
      const keyring = await parseKeyring(`k1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`);
      await setAppSecret(w.db, keyring, item.scope, { name: "WEATHER_API_KEY", value: "ow_secret_value" });
      const again = await host.requestAppKey!({ name: "WEATHER_API_KEY", description: "Lets the app read the forecast." });
      expect(again).toEqual({ name: "WEATHER_API_KEY", status: "set" });
      expect(JSON.stringify(again)).not.toContain("ow_secret_value");

      // The tool's answer to the model names the key and how to read it — never a value.
      let seen: unknown = null;
      const tool = makeRequestAppKey({ request: async (input) => { seen = input; return { name: input.name, status: "set" }; } });
      const out = await (tool as unknown as { run: (ctx: { data: Record<string, unknown> }) => Promise<{ output: string }> }).run({
        data: { name: "WEATHER_API_KEY", description: "Lets the app read the forecast." },
      });
      expect(seen).toEqual({ name: "WEATHER_API_KEY", description: "Lets the app read the forecast." });
      expect(out.output).toBe("WEATHER_API_KEY is already saved. The server reads it as c.env.WEATHER_API_KEY.");
    } finally { w.sqlite.close(); }
  });

  test("only build roles may ask for keys; planning roles and QA cannot", () => {
    const allowed = Object.entries(ROLE_TOOL_POLICY).filter(([, tools]) => tools.includes("request_app_key")).map(([role]) => role).sort();
    expect(allowed).toEqual(["backend", "frontend", "mobile", "tech-lead"]);
  });
});

describe("specialist repair boundaries", () => {
  test("shell test runs are refused; failed run_checks count once per receipt and stop the next effect after six attempts", async () => {
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
      // New rows store the sentence the check history shows, never the raw receipt (plan 3.3).
      expect((w.sqlite.prepare("select detail from run_rounds where outcome='failed'").get() as { detail: string }).detail).toBe("The app's own tests: 0 of 1 passed.");
      // Recovery of the same logical delivery must not consume another attempt.
      const restored = await resolveCoordinatorContext(env, item.workflow.conversationId);
      await restored.runChecks!("failure-one");
      expect(w.count("run_rounds", "outcome='failed'")).toBe(1);
      await host.runChecks!("failure-two");
      await host.runChecks!("failure-three");
      await host.runChecks!("failure-four");
      await host.runChecks!("failure-five");
      expect(w.count("run_rounds", "outcome='failed'")).toBe(5);
      // Five failures do not yet pause — the ladder allows six (two per model).
      expect((await workflowRepairPause(w.db, item.workflow.runId)).paused).toBe(false);
      await host.runChecks!("failure-six");
      expect(w.count("run_rounds", "outcome='failed'")).toBe(6);
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
      await host.runChecks!("failure-seven");
      expect(w.count("run_rounds", "outcome='failed'")).toBe(7);
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
    // A received POST is not an acknowledged dispatch: aborting there can
    // legitimately lose the response/remote id and require reconciliation.
    // This case exercises cancellation AFTER the remote identity is durable.
    let dispatched = false;
    for (let tries = 0; tries < 100; tries++) {
      const row = w.sqlite.prepare('select recordJson from sandbox_bindings where key = ?')
        .get(`op:exec:${item.workflow.runId}:running-cancel`) as { recordJson: string } | null;
      const operation = row ? JSON.parse(row.recordJson) : null;
      if (operation?.state === 'dispatched' && operation.remoteId) { dispatched = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(dispatched).toBe(true);
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
      // B03: an equal-LENGTH but DIFFERENT-content write to the same path is
      // real iteration, not a repeat — the guard must compare content, not the
      // byte COUNT. "aaaa\n" and "bbbb\n" are the same length; the fourth must
      // be allowed through after three identical ones.
      const sameLen = (content: string) => host.driver.writeFile({ sessionId: host.sessionId, path: "src/Equal.tsx", content });
      for (let i = 1; i <= REPEATED_ACTION_LIMIT; i++) await sameLen("aaaa\n");
      await sameLen("bbbb\n"); // same length, different content → must NOT throw
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
  "## Demo contract",
  "",
  "**One-line pitch:** A farmer logs a feed and sees this week's total before leaving the barn.",
  "**Demo path (3 minutes):**",
  "1. Enter 12 kg of feed against cow 14 and save it.",
  "2. The dashboard adds it to this week's total immediately.",
  "3. Reload the page and the entry and total are still there.",
  "**Real integration:** None — the app is a real local-first log with SQLite persistence; no outside service carries the demo.",
  "**Mocks:** None.",
  "**Why this wins:** The total is computed from real entries and survives a reload, not from a seeded chart a judge cannot change.",
  "",
  "```caddie-features",
  JSON.stringify([
    { id: "log-feed", title: "Log daily feed", doneWhen: ["Saving 12 kg shows 12 kg in today's list"] },
    { id: "view-dashboard", title: "See the feed dashboard", doneWhen: ["The dashboard totals this week's feed"] },
  ]),
  "```",
].join("\n");

describe("host-driven feature loop", () => {
  async function featureBuild(w: Awaited<ReturnType<typeof world>>, body = FEATURE_PRD, designBody = "# Design brief\n\nFeed-log form + totals dashboard; states defined.") {
    const started = await w.start();
    const plan = await createPlanDocRevision(w.db, started.scope, { kind: "prd", body });
    await workflowSnapshot(w.db, started.scope);
    // PRD approval -> looks -> design; carry through the look and design steps
    // so the feature loop runs against a 'building' workflow (the loop itself
    // is what these tests exercise).
    await decideWorkflow(w.db, started.scope, { planId: plan.id, decision: "approved" });
    await chooseLook(w.db, started.scope);
    const design = await createPlanDocRevision(w.db, started.scope, {
      kind: "design",
      body: designBody,
    });
    await workflowSnapshot(w.db, started.scope);
    const snapshot = await decideDesign(w.db, started.scope, { designId: design.id, decision: "approved" });
    return { ...started, plan, design, snapshot };
  }
  const env = (w: Awaited<ReturnType<typeof world>>, stub: SandboxStub) => ({
    DB: w.db, CONTREE_BASE_URL: stub.url, CONTREE_API_TOKEN: "local-feature-token", CONTREE_PROJECT_ID: "local-project", CONTREE_IMAGE: "tag:feature:1",
  });
  const feature = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    w.sqlite.query("select * from build_features where featureId = ?").get(id) as Record<string, unknown>;

  test("the repair ladder is admitted by default — no CADDIE_REPAIR_POLICY env needed",async()=>{
    // Reliability is not opt-in: a build opened with NO policy env var must
    // still be stamped repair-v1, so every build gets the escalating ladder
    // instead of the weak single-model fallback. world()/featureBuild pass no
    // CADDIE_REPAIR_POLICY, so this exercises the real default path.
    const w=await world();
    try{const item=await featureBuild(w);
      expect((await readWorkflow(w.db,item.scope))?.repairPolicyVersion).toBe('repair-v1');
    }finally{w.sqlite.close();}
  });

  test("a model cannot hand a technical check failure back to the owner while repair routes remain",async()=>{
    const w=await world();const stub=new SandboxStub({expectedToken:'local-feature-token'});stub.seedImage('tag:feature:1');await stub.start();
    try{const item=await featureBuild(w);w.sqlite.prepare("update build_workflows set repairPolicyVersion='repair-v1' where projectId=?").run(item.project.id);const payer=(await readWorkflow(w.db,item.scope))!.spendPayerId;
      await recordRepairRound(w.db,item.scope,item.workflow.runId,{admissionId:payer??undefined,issue:'log-feed:tests',round:'repair_attempt',outcome:'failed',operationKey:'real-failure'});
      const host=await resolveCoordinatorContext(env(w,stub),item.workflow.conversationId);
      await rejectsCode(host.blockBuild('Ask the owner to fix the test'),'REPAIR_AVAILABLE');expect((await readWorkflow(w.db,item.scope))?.phase).toBe('building');
      // A host-observed nonprogress limit is still terminal; model tools cannot
      // supply this trusted source (their schema contains only the reason).
      await host.blockBuild('The bounded continuation limit was exhausted. Saved work is retained.','nonprogress');expect((await readWorkflow(w.db,item.scope))?.phase).toBe('blocked');
    }finally{await stub.stop();w.sqlite.close();}
  });

  test("repair admission selects pinned models through fresh host contexts without resetting the payer", async () => {
    const w=await world(); const stub=new SandboxStub({expectedToken:'local-feature-token'}); stub.seedImage('tag:feature:1');
    try {
      const item=await featureBuild(w); await stub.start();
      const host=await resolveCoordinatorContext(env(w,stub),item.workflow.conversationId); await host.buildNextFeature();
      w.sqlite.prepare("update build_workflows set repairPolicyVersion='repair-v1' where projectId=?").run(item.project.id);
      const payer=(await readWorkflow(w.db,item.scope))?.spendPayerId;
      for(let i=0;i<6;i++) {
        const fresh=await resolveCoordinatorContext(env(w,stub),item.workflow.conversationId);
        expect(fresh.resumeContext).toContain('log-feed');
        expect(fresh.repairModelRouteId).toBe(['nemotron-3.5-super-vl','nemotron-3.5-super-vl','deepseek-v4.1-flash-1017','deepseek-v4.1-flash-1017','glm-5.3','glm-5.3'][i]);
        await recordRepairRound(w.db,item.scope,item.workflow.runId,{issue:'log-feed:test-'+i,round:'repair_attempt',outcome:'failed',operationKey:'repair-'+i,admissionId:payer ?? undefined});
      }
      expect((await workflowRepairPause(w.db,item.workflow.runId)).paused).toBe(true);
      expect((await readWorkflow(w.db,item.scope))?.spendPayerId).toBe(payer);
      expect(w.count('workflow_resumes')).toBe(0);
    } finally {await stub.stop();w.sqlite.close();}
  });

  test("a writer changing the checkpoint after feature checks cannot receive a verified feature",async()=>{
    const w=await world();const stub=new SandboxStub({expectedToken:'local-feature-token'});stub.seedImage('tag:feature:1');stub.setBehavior('bun run test',{stdout:'1 pass\n0 fail'});await stub.start();
    const original=SandboxDriver.prototype.checkpoint;let checkpoints=0;
    const wrapped=spyOn(SandboxDriver.prototype,'checkpoint').mockImplementation(async function(this:SandboxDriver,id:string){const result=await original.call(this,id);checkpoints++;return checkpoints>=2?{...result,checkpointRef:'a-concurrent-unchecked-image'}:result;});
    try{const item=await featureBuild(w);const host=await resolveCoordinatorContext(env(w,stub),item.workflow.conversationId);await host.buildNextFeature();await rejectsCode(host.finishFeature('log-feed','late-image'),'STALE_BUILD');expect(feature(w,'log-feed').status).not.toBe('passed');}
    finally{wrapped.mockRestore();await stub.stop();w.sqlite.close();}
  });

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

  test("B04: removing a failing test does not complete a later feature", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1");
    stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
    await stub.start();
    try {
      const item = await featureBuild(w);
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      // Feature 1 passes with one test → the protected baseline is now 1.
      await host.buildNextFeature();
      expect(((await host.finishFeature("log-feed", "f1")) as { passed: boolean }).passed).toBe(true);
      expect(feature(w, "log-feed").testsPassed).toBe(1);

      // Feature 2: attempt 1 FAILS a check (a real failing test), bumping attempts.
      await host.buildNextFeature();
      stub.setBehavior("bun run test", { stdout: "1 pass\n1 fail", exitCode: 1 });
      const fail1 = (await host.finishFeature("view-dashboard", "f2a")) as { passed: boolean };
      expect(fail1.passed).toBe(false);
      expect(Number(feature(w, "view-dashboard").attempts)).toBeGreaterThan(0);

      // A failing test vanished: this summary cannot distinguish deletion from
      // repair and supplies no independent evidence of the dashboard feature.
      stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
      const repaired = (await host.finishFeature("view-dashboard", "f2b")) as { passed: boolean };
      expect(repaired.passed).toBe(false);
      expect(feature(w, "view-dashboard").status).not.toBe("passed");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("resuming a feature opens a fresh new-test repair window without deleting earlier failures", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1");
    stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
    await stub.start();
    try {
      const item = await featureBuild(w);
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      await host.buildNextFeature();
      await host.finishFeature("log-feed", "checkpoint-first");
      const saved = feature(w, "log-feed").checkpointRef;
      await host.buildNextFeature();
      for (let attempt = 1; attempt <= 6; attempt++) {
        const result = await host.finishFeature("view-dashboard", `before-resume-${attempt}`) as { paused: boolean };
        expect(result.paused).toBe(attempt === 6);
      }
      await retryWorkflow(w.db, item.scope, "resume-new-test-window");
      const resumed = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      await resumed.buildNextFeature();
      for (let attempt = 1; attempt <= 6; attempt++) {
        const result = await resumed.finishFeature("view-dashboard", `after-resume-${attempt}`) as { paused: boolean };
        expect(result.paused).toBe(attempt === 6);
      }
      expect(w.count("run_rounds", "issue = 'view-dashboard:new-tests' and outcome = 'failed'")).toBe(12);
      expect(feature(w, "log-feed").checkpointRef).toBe(saved);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("verify_build keeps a working Flutter preview when saving the Android package fails", async () => {
    const w = await world(); const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1"); stub.setBehavior("sh caddie/run-tests.sh", { stdout: "1 pass\n0 fail" }); await stub.start();
    try {
      const item = await featureBuild(w); const root = `/workspace/${item.scope.projectId}`;
      w.sqlite.prepare("update run_bindings set stackId = 'flutter' where runId = ?").run(item.workflow.runId);
      const host = await resolveCoordinatorContext({ ...env(w, stub), CONTREE_FLUTTER_IMAGE: 'tag:feature:1', BETTER_AUTH_URL: 'https://caddie.test' }, item.workflow.conversationId);
      await host.buildNextFeature();
      w.sqlite.prepare("update build_features set status='passed',testsPassed=1 where projectId = ?").run(item.scope.projectId);
      stub.setBehavior("flutter build web --release", { stdout: 'built', writes: { [`${root}/build/web/main.dart.js`]: 'console.log("flutter")', [`${root}/dist/server.js`]: 'export default { fetch() { return new Response("ok"); } };' } });
      stub.setBehavior("flutter build apk --release", { stdout: 'built APK', writes: { [`${root}/build/app/outputs/flutter-apk/app-release.apk`]: 'PK\x03\x04' + 'x'.repeat(1_100_000) } });
      const prepare = w.db.prepare.bind(w.db);
      w.db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (!sql.includes('insert or ignore into "large_content_chunks"')) return statement;
        return { ...statement, bind: (...args: unknown[]) => {
          if ((args[2] as Uint8Array)?.byteLength > 1_000_000) throw new Error('Injected APK storage quota failure');
          return statement.bind(...args);
        } };
      }) as typeof w.db.prepare;
      const result = await host.verifyBuild('native-storage-failure') as { passed: boolean; outputId: string; receipts: Array<{ check: string; passed: boolean }> };
      expect(result.passed).toBe(true);
      expect(result.receipts.find(r => r.check === 'android-app')?.passed).toBe(false);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe('ready');
      expect(new TextDecoder().decode(await readBuildOutput(w.db, item.scope, result.outputId))).toContain('caddie-flutter-app');
      const saved = w.sqlite.prepare('select apkSha256,apkBytes from workflow_outputs where id = ?').get(result.outputId);
      expect(saved).toEqual({ apkSha256: null, apkBytes: null });
      expect(stub.spawnedCommands().some(command => command.startsWith('flutter build apk --release'))).toBe(true);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("verify_build refuses appearance drift, binds evidence to the approved revision and pauses after three repairs", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1"); stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" }); await stub.start();
    try {
      const { id: _id, ...theme } = FIELD_LOOK;
      const item = await featureBuild(w, FEATURE_PRD, `# Approved design\n\n\`\`\`caddie-theme\n${JSON.stringify(theme)}\n\`\`\`\n\n\`\`\`html-mock Feed log\n<main><button>Log feed</button></main>\n\`\`\``);
      const root = `/workspace/${item.scope.projectId}`;
      const capturedDesigns: string[] = [];
      const visualFidelity: FidelityPort = {
        capture: async (request) => {
          capturedDesigns.push(request.identity.designRevisionId);
          return { artifact: `private:${request.operationKey}`, sha256: await documentHash(request.document), documentHash: request.documentHash, width: request.viewport.width, height: request.viewport.height, capturedAt: new Date().toISOString() };
        },
        compare: async () => ({ differences: [{ severity: "blocking", area: "controls", message: "The approved Log feed action is missing." }] }),
      };
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId, { visualFidelity });
      await host.buildNextFeature();
      w.sqlite.prepare("update build_features set status='passed',testsPassed=1 where projectId = ?").run(item.scope.projectId);
      stub.setBehavior("bun run build", { stdout: "built", writes: { [`${root}/dist/main.js`]: 'console.log("feed")' } });
      // A newer draft must never replace the design the owner approved.
      await createPlanDocRevision(w.db, item.scope, { kind: "design", body: "# Unapproved replacement" });
      for (let attempt = 1; attempt <= 6; attempt++) {
        const outcome = await host.verifyBuild(`visual-${attempt}`) as { passed: boolean; paused: boolean; next: string };
        expect(outcome.passed).toBe(false);
        expect(outcome.paused).toBe(attempt === 6);
        expect(outcome.next).toContain("Log feed action is missing");
      }
      expect(new Set(capturedDesigns)).toEqual(new Set([item.design.id]));
      expect(w.count("workflow_outputs")).toBe(0);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("blocked");
      expect(w.count("run_rounds", "issue = 'visual-fidelity' and outcome = 'failed'")).toBe(6);
      expect(w.count("run_verifications", "\"check\" = 'visual-fidelity' and passed = 0")).toBe(6);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("verify_build stores the preview and records it as a version with the app's own source", async () => {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1");
    stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
    await stub.start();
    try {
      const item = await featureBuild(w);
      const root = `/workspace/${item.scope.projectId}`;
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      await host.buildNextFeature();
      expect(((await host.finishFeature("log-feed", "v-finish-1")) as { passed: boolean }).passed).toBe(true);
      await host.buildNextFeature();
      stub.setBehavior("bun run test", { stdout: "3 pass\n0 fail" });
      expect(((await host.finishFeature("view-dashboard", "v-finish-2")) as { passed: boolean }).passed).toBe(true);

      // The build check emits the bundle (and leaves build output and dependencies that a version must not keep).
      stub.setBehavior("bun run build", {
        stdout: "built",
        writes: {
          [`${root}/dist/main.js`]: 'console.log("farm log")',
          [`${root}/dist/main.css`]: "body { margin: 0 }",
          [`${root}/node_modules/react/index.js`]: "module.exports = {}",
        },
      });
      const verified = (await host.verifyBuild("verify-version-1")) as { passed: boolean; outputId: string };
      expect(verified.passed).toBe(true);

      const versions = await listCodeVersions(w.db, item.scope);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ seq: 1, kind: "build", title: "Log daily feed, See the feed dashboard", outputId: verified.outputId, hasImage: true });
      const files = await readVersionFiles(new LocalCodeStore(w.db), item.scope.projectId, versions[0]!.commitId);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("src/App.tsx");
      expect(paths).toContain("package.json");
      expect(paths.some((p) => p.startsWith("node_modules/") || p.startsWith("dist/"))).toBe(false);
      expect(versions[0]!.skipped.map((s) => s.path)).toEqual(expect.arrayContaining(["dist/", "node_modules/"]));
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  describe("when the sandbox no longer keeps the working copy", () => {
    const install = SCAFFOLD_COMMANDS.install.join(" && ");
    /**
     * A long pause, then the build runs again (a change request or Retry):
     * every working copy is older than the recheck window and the sandbox dropped them.
     */
    const longPause = (w: Awaited<ReturnType<typeof world>>, stub: SandboxStub) => {
      w.sqlite
        .prepare("update sandbox_bindings set recordJson = json_set(recordJson, '$.updatedAt', ?) where kind = 'session'")
        .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
      expect(stub.loseBuiltImages()).toBeGreaterThan(0);
      w.sqlite.prepare("update build_workflows set phase = 'building'").run();
    };
    /** Two features built, a file of the app's own, and one checked version. */
    async function checkedApp(w: Awaited<ReturnType<typeof world>>, stub: SandboxStub, saved = "export const feed = 'saved';") {
      const item = await featureBuild(w);
      const root = `/workspace/${item.scope.projectId}`;
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      await host.buildNextFeature();
      await host.driver.writeFile({ sessionId: host.sessionId, path: `${root}/src/feed.ts`, content: saved });
      expect(((await host.finishFeature("log-feed", "wc-finish-1")) as { passed: boolean }).passed).toBe(true);
      await host.buildNextFeature();
      stub.setBehavior("bun run test", { stdout: "3 pass\n0 fail" });
      expect(((await host.finishFeature("view-dashboard", "wc-finish-2")) as { passed: boolean }).passed).toBe(true);
      stub.setBehavior("bun run build", { stdout: "built", writes: { [`${root}/dist/main.js`]: "1", [`${root}/dist/main.css`]: "a{}" } });
      expect(((await host.verifyBuild("wc-verify-1")) as { passed: boolean }).passed).toBe(true);
      const [version] = await listCodeVersions(w.db, item.scope);
      return { item, root, version: version! };
    }
    const setupRows = (w: Awaited<ReturnType<typeof world>>) =>
      (w.sqlite.query("select subject, outcome from build_activity where kind = 'setup' order by startedAt").all() as { subject: string; outcome: string }[]);

    test("a resumed build continues from the newest saved version; with nothing lost the builder never notices", async () => {
      const w = await world();
      const stub = new SandboxStub({ expectedToken: "local-feature-token" });
      stub.seedImage("tag:feature:1");
      stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
      await stub.start();
      try {
        const { item, root, version } = await checkedApp(w, stub);
        longPause(w, stub);
        const spawnsBefore = stub.spawnedCommands().length;

        const later = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        expect(await later.driver.readFile({ sessionId: later.sessionId, path: `${root}/src/feed.ts` })).toBe("export const feed = 'saved';");
        // The new working copy got its dependencies installed again (versions never keep them).
        expect(stub.spawnedCommands().slice(spawnsBefore)).toContain(install);
        const restarted = stub.spawnedCommands().slice(spawnsBefore);
        const check = restarted.findIndex((command) => command.includes("caddie-verified-install"));
        expect(check).toBeGreaterThanOrEqual(0);
        expect(check).toBeLessThan(restarted.indexOf(install));
        expect(w.sqlite.query("select reason from build_sandbox_sessions").get()).toEqual({ reason: `seeded:${version.commitId}` });
        expect(feature(w, "log-feed").status).toBe("passed");
        expect(feature(w, "view-dashboard").status).toBe("passed");
        expect(setupRows(w).at(-1)).toEqual({ subject: "Continued from version 1", outcome: "ok" });

        // Later steps use the new working copy without checking again.
        const spawnsAfter = stub.spawnedCommands().length;
        const next = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        expect(await next.driver.readFile({ sessionId: next.sessionId, path: `${root}/package.json` })).toContain('"name"');
        expect(stub.spawnedCommands().length).toBe(spawnsAfter);
        expect(setupRows(w).filter((r) => r.subject.startsWith("Continued"))).toHaveLength(1);
      } finally { await stub.stop(); w.sqlite.close(); }
    });

    test("features whose code was not in the saved version are built again, and the builder is told once", async () => {
      const w = await world();
      const stub = new SandboxStub({ expectedToken: "local-feature-token" });
      stub.seedImage("tag:feature:1");
      stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
      await stub.start();
      try {
        const { item, root } = await checkedApp(w, stub);
        // Both features count as passed after the version was saved.
        w.sqlite.prepare("update code_versions set createdAt = ?").run("2000-01-01T00:00:00.000Z");
        longPause(w, stub);

        const later = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        await expect(later.driver.readFile({ sessionId: later.sessionId, path: `${root}/src/feed.ts` })).rejects.toMatchObject({ code: "WORKING_COPY_REPLACED" });
        expect(feature(w, "log-feed")).toMatchObject({ status: "pending", checkpointRef: null, passedAt: null });
        expect(feature(w, "view-dashboard").status).toBe("pending");
        expect(setupRows(w).at(-1)?.subject).toBe("Continued from version 1; 2 features built again");
        // Told once: the same context carries on with the saved files.
        expect(await later.driver.readFile({ sessionId: later.sessionId, path: `${root}/src/feed.ts` })).toBe("export const feed = 'saved';");
        expect(((await later.buildNextFeature()) as { feature: { id: string } }).feature.id).toBe("log-feed");
      } finally { await stub.stop(); w.sqlite.close(); }
    });

    test("with no saved version the build starts again from the plan", async () => {
      const w = await world();
      const stub = new SandboxStub({ expectedToken: "local-feature-token" });
      stub.seedImage("tag:feature:1");
      stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
      await stub.start();
      try {
        const item = await featureBuild(w);
        const root = `/workspace/${item.scope.projectId}`;
        const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        await host.buildNextFeature();
        expect(((await host.finishFeature("log-feed", "fresh-finish-1")) as { passed: boolean }).passed).toBe(true);
        longPause(w, stub);

        const later = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        await expect(later.driver.readFile({ sessionId: later.sessionId, path: `${root}/package.json` })).rejects.toMatchObject({ code: "WORKING_COPY_REPLACED" });
        expect(feature(w, "log-feed").status).toBe("pending");
        expect(setupRows(w).at(-1)?.subject).toBe("Started again from your plan");
        // The empty workspace gets the app's starting files again.
        expect(await later.driver.readFile({ sessionId: later.sessionId, path: `${root}/package.json` })).toContain('"name"');
      } finally { await stub.stop(); w.sqlite.close(); }
    });

    test("an unreachable sandbox never discards a working copy", async () => {
      const w = await world();
      const stub = new SandboxStub({ expectedToken: "local-feature-token" });
      stub.seedImage("tag:feature:1");
      stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
      await stub.start();
      try {
        const { item, root } = await checkedApp(w, stub);
        w.sqlite.prepare("update code_versions set createdAt = ?").run("2000-01-01T00:00:00.000Z");
        w.sqlite
          .prepare("update sandbox_bindings set recordJson = json_set(recordJson, '$.updatedAt', ?) where kind = 'session'")
          .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
        w.sqlite.prepare("update build_workflows set phase = 'building'").run();
        await stub.stop();
        const later = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        await expect(later.driver.readFile({ sessionId: later.sessionId, path: `${root}/src/feed.ts` })).rejects.toMatchObject({ code: "UPSTREAM_UNREACHABLE" });
        expect(w.sqlite.query("select count(*) as n from build_sandbox_sessions").get()).toEqual({ n: 0 });
        expect(feature(w, "log-feed").status).toBe("passed");
      } finally { await stub.stop(); w.sqlite.close(); }
    });

    test("a project's first build starts from the code copied from GitHub, not the empty template", async () => {
      const w = await world();
      const stub = new SandboxStub({ expectedToken: "local-feature-token" });
      stub.seedImage("tag:feature:1");
      await stub.start();
      try {
        const item = await featureBuild(w);
        const root = `/workspace/${item.scope.projectId}`;
        const copied = { "package.json": '{ "name": "caddie-project" }\n', "src/App.tsx": "export const copied = 'from GitHub';\n" };
        await recordCodeVersion(w.db, new LocalCodeStore(w.db), item.scope, {
          kind: "import",
          title: "Copied from octo-farm/farm-log",
          files: Object.entries(copied).map(([path, text]) => ({ path, contentBase64: btoa(text) })),
          actorId: item.scope.actorId,
        });
        const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        await host.buildNextFeature();
        expect(await host.driver.readFile({ sessionId: host.sessionId, path: `${root}/src/App.tsx` })).toBe(copied["src/App.tsx"]);
        // The template was not laid over it, and nothing was "lost": the feature keeps going.
        await expect(host.driver.readFile({ sessionId: host.sessionId, path: `${root}/test/examples/app.example.test.tsx` })).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
        expect(feature(w, "log-feed").status).toBe("building");
        expect(stub.spawnedCommands()).toContain(install);
        expect(setupRows(w).map((r) => r.subject)).toEqual(["Started from your code on GitHub"]);
      } finally { await stub.stop(); w.sqlite.close(); }
    });

    test("going back to a version whose working copy is gone starts from its saved files", async () => {
      const w = await world();
      const stub = new SandboxStub({ expectedToken: "local-feature-token" });
      stub.seedImage("tag:feature:1");
      stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
      await stub.start();
      try {
        const { item, root, version: first } = await checkedApp(w, stub, "export const feed = 'first';");
        const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        w.sqlite.prepare("update build_workflows set phase = 'building'").run();
        await host.driver.writeFile({ sessionId: host.sessionId, path: `${root}/src/feed.ts`, content: "export const feed = 'second';" });
        expect(((await host.verifyBuild("wc-verify-2")) as { passed: boolean }).passed).toBe(true);
        expect((await listCodeVersions(w.db, item.scope)).map((v) => v.seq)).toEqual([2, 1]);

        await restoreVersion(w.db, new LocalCodeStore(w.db), item.scope, { commitId: first.commitId, key: "restore-after-pause" });
        longPause(w, stub);
        const later = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
        expect(await later.driver.readFile({ sessionId: later.sessionId, path: `${root}/src/feed.ts` })).toBe("export const feed = 'first';");
        expect(setupRows(w).at(-1)?.subject).toBe("Continued from version 3");
        expect(feature(w, "view-dashboard").status).toBe("passed");
      } finally { await stub.stop(); w.sqlite.close(); }
    });
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
      const noContract = FEATURE_PRD.replace(/## Demo contract[\s\S]*?(?=```caddie-features)/, "");
      await expect(host.writePlanNote({ kind: "prd", body: noContract, planRevision: "rev-0" })).rejects.toThrow("DEMO_CONTRACT_INVALID");
      expect(w.count("plan_doc_revisions", "kind = 'prd'")).toBe(0);
      await expect(host.writePlanNote({ kind: "prd", body: "# Farm log\n\nJust prose.", planRevision: "rev-0" })).rejects.toThrow("DEMO_CONTRACT_INVALID");
      const noFeatures = FEATURE_PRD.replace(/```caddie-features[\s\S]*?```/, "");
      await expect(host.writePlanNote({ kind: "prd", body: noFeatures, planRevision: "rev-0" })).rejects.toThrow("PLAN_FEATURES_INVALID");
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

  // --- Big apps (plan part P steps 1-2) -------------------------------------
  // A team-mode build with big apps on whose approved design is the 9-module
  // farm fixture. The plan lists one core feature, one structures feature and
  // one money feature. The REAL coordinator host runs against the sandbox
  // stub; the module dispatcher is a fake that records what would be sent.
  const FARM_BLOCK = readFileSync(new URL("./fixtures/architecture/farm-block.json", import.meta.url), "utf8");
  const BIG_PRD = FEATURE_PRD.replace(
    /```caddie-features[\s\S]*?```/,
    [
      "```caddie-features",
      JSON.stringify([
        { id: "farm-registry", title: "Register your farms", doneWhen: ["A saved farm is listed"] },
        { id: "structures", title: "Add barns and pens", doneWhen: ["A saved barn is listed"] },
        { id: "sales", title: "Record a sale", doneWhen: ["A saved sale is listed"] },
      ]),
      "```",
    ].join("\n"),
  );
  async function bigBuild(w: Awaited<ReturnType<typeof world>>, opts: { bigApps?: boolean } = {}) {
    const item = await featureBuild(w, BIG_PRD);
    w.sqlite
      .prepare('update plan_doc_revisions set body = ? where id = ?')
      .run(`# Farm design\n\n\`\`\`caddie-architecture\n${FARM_BLOCK}\n\`\`\``, item.design.id);
    w.sqlite
      .prepare('update build_workflows set "teamMode" = 1, "bigApps" = ?, "approvedDesignRevisionId" = ? where projectId = ?')
      .run(opts.bigApps === false ? 0 : 1, item.design.id, item.scope.projectId);
    return item;
  }
  function bigStub() {
    const stub = new SandboxStub({ expectedToken: "local-feature-token" });
    stub.seedImage("tag:feature:1");
    stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
    stub.setBehavior("bun test caddie/contract.test.ts", { stdout: "3 pass\n0 fail" });
    return stub;
  }
  /** The browser bundle the preview reads (dist/main.js + main.css). */
  const builtFiles = (root: string) => ({ stdout: "built", writes: { [`${root}/dist/main.js`]: "1", [`${root}/dist/main.css`]: "a{}" } });

  test("a big build: the coordinator builds only the foundation's features, then starts the parts whose dependencies are joined", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const item = await bigBuild(w);
      const dispatched: Array<{ moduleId: string; buildSeq: number; features: readonly string[]; instanceId: string }> = [];
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId, {
        dispatchModuleBuilder: (input) => {
          dispatched.push(input);
        },
      });
      // MUTATION: drop the foundation scope (featureInScope) and the
      // coordinator is handed all three features (total 3, structures next).
      const first = (await host.buildNextFeature()) as { feature: { id: string }; total: number };
      expect(first).toMatchObject({ feature: { id: "farm-registry" }, total: 1 });

      const passed = (await host.finishFeature("farm-registry", "big-1")) as { passed: boolean; partsStarted?: boolean; next: string };
      expect(passed).toMatchObject({ passed: true, partsStarted: true });
      expect(passed.next).toContain("end your turn now");

      // Core's dependents start, up to the 4 builder slots, in the design's
      // order; a dependent with no planned feature is joined at once instead.
      // structures and money have features; tasks, notifications and
      // subscriptions have none, so they never take a builder.
      expect(dispatched.map((d) => [d.moduleId, [...d.features]])).toEqual([
        ["structures", ["structures"]],
        ["money", ["sales"]],
      ]);
      expect(dispatched[0]?.instanceId).toBe(`${item.scope.projectId}:${dispatched[0]?.buildSeq}:structures`);
      const status = (moduleId: string) =>
        (w.sqlite.query('select "status" from build_modules where "projectId" = ? and "moduleId" = ?').get(item.scope.projectId, moduleId) as { status: string }).status;
      expect(status("core")).toBe("merged");
      expect(status("tasks")).toBe("merged");
      // events waits on structures, but no planned feature belongs to it, so
      // there is nothing to wait for: it is joined at once too.
      expect(status("events")).toBe("merged");
      expect(status("structures")).toBe("building");
      expect(status("money")).toBe("building");

      // While the parts build the coordinator has nothing to do: the progress
      // says so (its finish hook then settles instead of nudging), and the next
      // feature call answers "waiting", never "every feature passed".
      expect(await host.featureProgress()).toMatchObject({ current: null, waitingOnParts: true });
      expect(await host.buildNextFeature()).toMatchObject({ done: false, waiting: true });
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("building");
      // Asking again starts nothing twice.
      expect(dispatched.length).toBe(2);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("a big build with no way to start the part builders says so plainly", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const item = await bigBuild(w);
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      await host.buildNextFeature();
      await rejectsCode(host.finishFeature("farm-registry", "big-2"), "PARTS_UNAVAILABLE");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("a team-mode build's verify_build publishes the app, though its contract checks run after the bundle is built", async () => {
    // Every check run commits a new sandbox image, and in team mode the
    // contract phases run after the browser bundle. The "files changed after
    // the build" guard must compare with the image the checks ENDED on, not
    // the bundle's. MUTATION: compare with the bundle's image again and every
    // team-mode verify fails with STALE_BUILD.
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const item = await bigBuild(w, { bigApps: false });
      const root = `/workspace/${item.scope.projectId}`;
      stub.setBehavior("bun run build", builtFiles(root));
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId);
      for (const [n, featureId] of ["farm-registry", "structures", "sales"].entries()) {
        await host.buildNextFeature();
        stub.setBehavior("bun run test", { stdout: `${n + 1} pass\n0 fail` });
        expect(((await host.finishFeature(featureId, `small-${n}`)) as { passed: boolean }).passed).toBe(true);
      }
      const verified = (await host.verifyBuild("small-verify")) as { passed: boolean };
      expect(verified.passed).toBe(true);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("ready");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("with big apps off the same design is built by one builder, exactly as before", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const item = await bigBuild(w, { bigApps: false });
      const dispatched: string[] = [];
      const host = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId, {
        dispatchModuleBuilder: (input) => {
          dispatched.push(input.moduleId);
        },
      });
      expect(await host.buildNextFeature()).toMatchObject({ feature: { id: "farm-registry" }, total: 3 });
      const passed = (await host.finishFeature("farm-registry", "small-1")) as { passed: boolean; partsStarted?: boolean; next: string };
      expect(passed.passed).toBe(true);
      expect(passed.partsStarted).toBeUndefined();
      expect(passed.next).toContain("Add barns and pens");
      expect(dispatched).toEqual([]);
      expect(w.count("build_modules")).toBe(0);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  // --- Big apps, joining a part (plan part P step 3) ------------------------
  // The coordinator builds the foundation on the REAL host; the structures
  // part's builder then runs on the REAL module host, and finish_module joins
  // it into the app through the sandbox stub (sessions, commits, inspect).
  async function partReady(w: Awaited<ReturnType<typeof world>>, stub: SandboxStub) {
    const item = await bigBuild(w);
    const root = `/workspace/${item.scope.projectId}`;
    const started: Array<{ moduleId: string; buildSeq: number }> = [];
    const notified: Array<{ key: string; message: string }> = [];
    const deps = {
      dispatchModuleBuilder: (input: { moduleId: string; buildSeq: number }) => void started.push(input),
      notifyCoordinator: (input: { key: string; message: string }) => void notified.push(input),
    };
    const coordinator = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId, deps);
    await coordinator.buildNextFeature();
    await coordinator.driver.writeFile({ sessionId: coordinator.sessionId, path: `${root}/src/server/core/farms.ts`, content: "export const farms = 'core';" });
    expect(((await coordinator.finishFeature("farm-registry", "core-1")) as { partsStarted?: boolean }).partsStarted).toBe(true);
    const buildSeq = started[0]!.buildSeq;
    const part = await resolveModuleBuilderContext(env(w, stub), { conversationId: item.workflow.conversationId, moduleId: "structures", buildSeq, features: ["structures"] }, deps);
    expect(await part.buildNextFeature()).toMatchObject({ feature: { id: "structures" } });
    await part.driver.writeFile({ sessionId: part.sessionId, path: `${root}/src/server/structures/barns.ts`, content: "export const barns = 'structures';" });
    const finished = (await part.finishFeature("structures", "structures-1")) as { passed: boolean; next: string };
    expect(finished.passed).toBe(true);
    expect(finished.next).toContain("Call finish_module");
    const status = (moduleId: string) =>
      (w.sqlite.query('select "status" from build_modules where "projectId" = ? and "moduleId" = ?').get(item.scope.projectId, moduleId) as { status: string }).status;
    const inspect = new ContreeClient({ baseUrl: stub.url, apiToken: "local-feature-token", platformProjectId: "local-project" });
    const read = async (image: string, path: string) => {
      const bytes = await inspect.inspectDownload(image, `${root}/${path}`);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    };
    return { item, root, part, buildSeq, started, notified, status, read };
  }

  test("a big build: finish_module joins a finished part into a copy of the newest save point and makes that the app", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const p = await partReady(w, stub);
      const foundation = (await getModule(w.db, p.item.scope.projectId, p.buildSeq, "core"))!.checkpointRef!;
      const spawnsBefore = stub.requests.length;
      const joined = (await p.part.finishModuleBuild!("join-1")) as { joined: boolean; next: string };
      expect(joined).toMatchObject({ joined: true });
      expect(joined.next).toContain("end your turn now");
      expect(p.status("structures")).toBe("merged");

      // The join copy was started from the foundation's save point...
      const spawned = stub.requests.slice(spawnsBefore).filter((r) => r.method === "POST" && r.path === "/v1/instances");
      expect((spawned[0]?.body as { image?: string })?.image).toBe(foundation);
      // ...and its commit, now the newest save point, holds the core AND the part.
      // MUTATION: start the join copy from the base image instead, and the
      // core's file is missing from the app.
      const newest = (await getModule(w.db, p.item.scope.projectId, p.buildSeq, "core"))!.checkpointRef!;
      expect(newest).not.toBe(foundation);
      expect(await p.read(newest, "src/server/core/farms.ts")).toBe("export const farms = 'core';");
      expect(await p.read(newest, "src/server/structures/barns.ts")).toBe("export const barns = 'structures';");
      // The build's own working copy now opens from it (verify_build and the preview use it).
      const override = w.sqlite.query('select "image","reason" from build_sandbox_sessions where "projectId" = ?').get(p.item.scope.projectId) as { image: string; reason: string };
      expect(override.image).toBe(newest);
      // The name lists every joined part in the design's order, including the
      // parts with no planned features (joined as they stood at the start).
      expect(override.reason).toBe("joined:core + structures + events + feed + tasks + insights + notifications + subscriptions merged");
      // money is still building, so Caddie is not told anything yet.
      expect(p.notified).toEqual([]);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("a join whose app server doesn't start on Cloudflare's runtime is red, with that reason for the part's builder", async () => {
    // Part Q: the join checks include "the server starting". The Worker
    // Loader is faked: the app's GET /api/health answers 500.
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const p = await partReady(w, stub);
      stub.setBehavior("bun run build", { stdout: "built", writes: { [`${p.root}/dist/main.js`]: "1", [`${p.root}/dist/server.js`]: "export default {}" } });
      let loads = 0;
      const LOADER = {
        get: () => {
          loads += 1;
          return { getEntrypoint: () => ({ fetch: async () => new Response("boom: env.DB is undefined", { status: 500 }) }) };
        },
      };
      const part = await resolveModuleBuilderContext({ ...env(w, stub), LOADER } as never, { conversationId: p.item.workflow.conversationId, moduleId: "structures", buildSeq: p.buildSeq, features: ["structures"] }, {
        dispatchModuleBuilder: () => {},
      });
      const out = (await part.finishModuleBuild!("join-start")) as { joined: boolean; failures: Array<{ check: string; output: string }> };
      // MUTATION: skip the server-start check in a join, and this part joins
      // an app whose server can't start.
      expect(out.joined).toBe(false);
      expect(loads).toBe(1);
      expect(out.failures).toEqual([{ check: "server-starts", output: expect.stringContaining("GET /api/health answered 500") }]);
      expect(p.status("structures")).toBe("building");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("a red join goes back to the part's builder and never counts toward any repair limit", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const p = await partReady(w, stub);
      const roundsBefore = w.count("run_rounds");
      stub.setBehavior("bun run test", { exitCode: 1, stderr: "1 fail: the barns list is empty" });
      const out = (await p.part.finishModuleBuild!("join-red")) as { joined: boolean; triesLeft: number; failures: Array<{ check: string; output: string }>; next: string };
      expect(out).toMatchObject({ joined: false, triesLeft: 1 });
      expect(out.failures[0]).toMatchObject({ check: "behavior-tests" });
      expect(out.failures[0]!.output).toContain("the barns list is empty");
      expect(out.next).toContain("call finish_module again");
      expect(p.status("structures")).toBe("building");
      // MUTATION: drop the join-mode return in the check runner, and the join's
      // failure is recorded as a repair round that could pause the build.
      expect(w.count("run_rounds")).toBe(roundsBefore);
      expect((await readWorkflow(w.db, p.item.scope))?.phase).toBe("building");
      // Nothing changed in the app: the newest save point and the build's copy stay put.
      expect(w.count("build_sandbox_sessions", "reason like 'joined:%'")).toBe(0);
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  // --- Big apps, the end of the build (plan part P step 3, Q "verify_build") --
  /** Run one part's builder on the REAL module host: its features, then finish_module. */
  async function buildPart(
    w: Awaited<ReturnType<typeof world>>,
    stub: SandboxStub,
    p: Awaited<ReturnType<typeof partReady>>,
    moduleId: string,
    featureId: string,
  ) {
    const host = await resolveModuleBuilderContext(env(w, stub), { conversationId: p.item.workflow.conversationId, moduleId, buildSeq: p.buildSeq, features: [featureId] }, {
      dispatchModuleBuilder: () => {},
      notifyCoordinator: (input: { key: string; message: string }) => void p.notified.push(input),
    });
    await host.buildNextFeature();
    await host.driver.writeFile({ sessionId: host.sessionId, path: `${p.root}/src/server/${moduleId}/${featureId}.ts`, content: `export const ${featureId.replace(/-/g, "_")} = 1;` });
    expect(((await host.finishFeature(featureId, `${moduleId}-1`)) as { passed: boolean }).passed).toBe(true);
    return host;
  }

  test("S3 end to end: two parts build at the same time on their own copies, both join under the lock, and the app is verified", async () => {
    // The production path through the REAL coordinator and module hosts; the
    // "builders" are scripted (each writes its part's file in its own copy),
    // and the sandbox is the local stub. LOCAL VERIFIED, SIMULATED builders.
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const item = await bigBuild(w);
      const root = `/workspace/${item.scope.projectId}`;
      stub.setBehavior("bun run build", builtFiles(root));
      const started: Array<{ moduleId: string; buildSeq: number }> = [];
      const notified: Array<{ key: string; message: string }> = [];
      const deps = {
        dispatchModuleBuilder: (input: { moduleId: string; buildSeq: number }) => void started.push(input),
        notifyCoordinator: (input: { key: string; message: string }) => void notified.push(input),
      };
      const coordinator = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId, deps);
      await coordinator.buildNextFeature();
      await coordinator.driver.writeFile({ sessionId: coordinator.sessionId, path: `${root}/src/server/core/farms.ts`, content: "core" });
      await coordinator.finishFeature("farm-registry", "core-1");
      expect(started.map((s) => s.moduleId)).toEqual(["structures", "money"]);
      const buildSeq = started[0]!.buildSeq;

      const spans: Record<string, { from: number; to: number }> = {};
      const runPart = async (moduleId: string, featureId: string) => {
        const host = await resolveModuleBuilderContext(env(w, stub), { conversationId: item.workflow.conversationId, moduleId, buildSeq, features: [featureId] }, deps);
        const from = Date.now();
        await host.buildNextFeature();
        await host.driver.writeFile({ sessionId: host.sessionId, path: `${root}/src/server/${moduleId}/${featureId}.ts`, content: moduleId });
        expect(((await host.finishFeature(featureId, `${moduleId}-1`)) as { passed: boolean }).passed).toBe(true);
        const joined = (await host.finishModuleBuild!(`join-${moduleId}`)) as { joined: boolean; queued?: boolean };
        spans[moduleId] = { from, to: Date.now() };
        return joined;
      };
      const outcomes = await Promise.all([runPart("structures", "structures"), runPart("money", "sales")]);
      // The two parts really worked at the same time (each started before the other finished).
      expect(spans.structures!.from).toBeLessThan(spans.money!.to);
      expect(spans.money!.from).toBeLessThan(spans.structures!.to);
      // Each joined, or waited and was joined by the holder of the lock.
      expect(outcomes.every((o) => o.joined || o.queued)).toBe(true);
      const status = (moduleId: string) =>
        (w.sqlite.query('select "status" from build_modules where "projectId" = ? and "moduleId" = ?').get(item.scope.projectId, moduleId) as { status: string }).status;
      expect([status("structures"), status("money")]).toEqual(["merged", "merged"]);
      expect(notified.length).toBe(1);

      // The newest save point holds the core and both parts.
      const newest = (await getModule(w.db, item.scope.projectId, buildSeq, "core"))!.checkpointRef!;
      const inspect = new ContreeClient({ baseUrl: stub.url, apiToken: "local-feature-token", platformProjectId: "local-project" });
      const read = async (path: string) => {
        const bytes = await inspect.inspectDownload(newest, `${root}/${path}`);
        return bytes === null ? null : new TextDecoder().decode(bytes);
      };
      expect(await read("src/server/core/farms.ts")).toBe("core");
      expect(await read("src/server/structures/structures.ts")).toBe("structures");
      expect(await read("src/server/money/sales.ts")).toBe("money");

      // Caddie checks the joined app and it is ready.
      const verifier = await resolveCoordinatorContext(env(w, stub), item.workflow.conversationId, deps);
      expect(await verifier.buildNextFeature()).toMatchObject({ done: true });
      expect(((await verifier.verifyBuild("s3-verify")) as { passed: boolean }).passed).toBe(true);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("ready");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("Retry after a big build stops keeps its parts: joined ones stay joined, interrupted ones are woken under the new limit", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const p = await partReady(w, stub);
      stub.setBehavior("bun run build", builtFiles(p.root));
      expect(await p.part.finishModuleBuild!("join-structures")).toMatchObject({ joined: true });
      // The build stops (e.g. its spending limit) while money is still building.
      await setWorkflowBlocker(w.db, p.item.scope, "This build reached its spending limit.");
      const oldPayer = (w.sqlite.query('select "spendPayerId" from build_workflows where projectId = ?').get(p.item.scope.projectId) as { spendPayerId: string }).spendPayerId;
      const boardRows = w.count("build_modules", `projectId='${p.item.scope.projectId}'`);
      await retryWorkflow(w.db, p.item.scope, "retry-big-build-1");
      const newPayer = (w.sqlite.query('select "spendPayerId" from build_workflows where projectId = ?').get(p.item.scope.projectId) as { spendPayerId: string }).spendPayerId;
      expect(newPayer).not.toBe(oldPayer);
      // The same parts carry on under the new payer (and so the new limit).
      // MUTATION: leave the parts on the old payer, and the coordinator starts
      // a fresh set of parts from the core, losing structures from the app.
      expect(w.count("build_modules", `projectId='${p.item.scope.projectId}' and "payerId"='${newPayer}'`)).toBe(boardRows);

      const woken: Array<{ moduleId: string; idempotencyKey?: string; message: string }> = [];
      const coordinator = await resolveCoordinatorContext(env(w, stub), p.item.workflow.conversationId, {
        dispatchModuleBuilder: (input: { moduleId: string; idempotencyKey?: string; message: string }) => void woken.push(input),
      });
      expect(await coordinator.buildNextFeature()).toMatchObject({ done: false, waiting: true });
      expect(w.count("build_modules", `projectId='${p.item.scope.projectId}'`)).toBe(boardRows);
      expect(p.status("structures")).toBe("merged");
      // money's builder was interrupted: it is woken once per Retry (keyed),
      // however often the coordinator asks. MUTATION: no wake, and money never moves.
      await coordinator.buildNextFeature();
      expect(woken.map((d) => [d.moduleId, d.idempotencyKey])).toEqual([
        ["money", "wake:retry-big-build-1:money"],
        ["money", "wake:retry-big-build-1:money"],
      ]);
      expect(woken[0]!.message).toContain("started again");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("a big build waits for its parts: verify_build publishes nothing while a part is still building", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const p = await partReady(w, stub);
      const coordinator = await resolveCoordinatorContext(env(w, stub), p.item.workflow.conversationId, { dispatchModuleBuilder: () => {} });
      const spawns = stub.spawnRequestCount();
      // MUTATION: drop the "parts still building" refusal and verify runs (and
      // publishes) an app two of whose parts are not in it yet.
      const early = (await coordinator.verifyBuild("big-early")) as { passed: boolean; waiting?: boolean; next: string };
      expect(early).toMatchObject({ passed: false, waiting: true });
      expect(early.next).toContain("end your turn now");
      expect(stub.spawnRequestCount()).toBe(spawns);
      expect((await readWorkflow(w.db, p.item.scope))?.phase).toBe("building");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("when every part is joined, Caddie is told, and verify_build checks the joined app and makes it ready", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const p = await partReady(w, stub);
      stub.setBehavior("bun run build", builtFiles(p.root));
      expect(await p.part.finishModuleBuild!("join-structures")).toMatchObject({ joined: true });
      const money = await buildPart(w, stub, p, "money", "sales");
      expect(await money.finishModuleBuild!("join-money")).toMatchObject({ joined: true });
      expect(p.notified.length).toBe(1);
      expect(p.notified[0]!.message).toContain("Every part is joined into the app");

      const newest = (await getModule(w.db, p.item.scope.projectId, p.buildSeq, "core"))!.checkpointRef!;
      const coordinator = await resolveCoordinatorContext(env(w, stub), p.item.workflow.conversationId, { dispatchModuleBuilder: () => {} });
      expect(await coordinator.buildNextFeature()).toMatchObject({ done: true });
      const before = stub.requests.length;
      const verified = (await coordinator.verifyBuild("big-verify")) as { passed: boolean };
      expect(verified.passed).toBe(true);
      // verify_build ran on the joined app: its session started from the newest save point.
      const spawned = stub.requests.slice(before).filter((r) => r.method === "POST" && r.path === "/v1/instances");
      expect((spawned[0]?.body as { image?: string })?.image).toBe(newest);
      const workflow = await readWorkflow(w.db, p.item.scope);
      expect(workflow?.phase).toBe("ready");
      expect(workflow?.detail).toBeNull();
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("parts that could not be joined or stopped are left out: the app ends ready but partly built, saying which", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const p = await partReady(w, stub);
      stub.setBehavior("bun run build", builtFiles(p.root));
      stub.setBehavior("bun run test", { exitCode: 1, stderr: "1 fail: the barns list is empty" });
      await p.part.finishModuleBuild!("join-1");
      expect(await p.part.finishModuleBuild!("join-2")).toMatchObject({ joined: false, final: true });
      stub.setBehavior("bun run test", { stdout: "1 pass\n0 fail" });
      expect(p.notified).toEqual([]); // money is still building
      // money's builder starts its feature, then reports a blocker: the part
      // stops with its feature unfinished, and with that every part is settled.
      // MUTATION: don't continue the big build after a part stops, and Caddie
      // is never told (the build sits silent until the stall watchdog).
      const money = await resolveModuleBuilderContext(env(w, stub), { conversationId: p.item.workflow.conversationId, moduleId: "money", buildSeq: p.buildSeq, features: ["sales"] }, {
        dispatchModuleBuilder: () => {},
        notifyCoordinator: (input: { key: string; message: string }) => void p.notified.push(input),
      });
      await money.buildNextFeature();
      await money.blockBuild("The payment provider's test keys are missing.");
      expect(p.status("money")).toBe("stopped");
      expect(p.notified.length).toBe(1);
      expect(p.notified[0]!.message).toContain("structures (could not be joined)");
      expect(p.notified[0]!.message).toContain("money (stopped)");

      const coordinator = await resolveCoordinatorContext(env(w, stub), p.item.workflow.conversationId, { dispatchModuleBuilder: () => {} });
      const next = (await coordinator.buildNextFeature()) as { done: boolean; next: string };
      expect(next.done).toBe(true);
      expect(next.next).toContain("verify_build");
      // MUTATION: count the missing parts' features in the verify gate, and the
      // build can never finish ("Not every feature is built yet": sales).
      const verified = (await coordinator.verifyBuild("big-verify")) as { passed: boolean; next: string };
      expect(verified.passed).toBe(true);
      expect(verified.next).toContain("Try again");
      const workflow = await readWorkflow(w.db, p.item.scope);
      expect(workflow?.phase).toBe("ready");
      const plain = (id: string) => JSON.parse(FARM_BLOCK).modules.find((m: { id: string }) => m.id === id).plain as string;
      expect(workflow?.detail).toBe(
        `Your app is ready without 2 parts: ${plain("structures")} (it couldn't be joined into the app), ${plain("money")} (it stopped). Press Try again on a part to build it again.`,
      );
      // The contract check the published app passed covers the features in it,
      // never the whole design. MUTATION: verify with the whole design's
      // contract, and it asks for the billing profiles table no built part made.
      const outputImage = (w.sqlite.query("select image from workflow_outputs where id = ?").get(workflow!.previewId) as { image: string }).image;
      const contractTest = await p.read(outputImage, "caddie/contract.test.ts");
      expect(contractTest).toContain('"scoped":true');
      expect(contractTest).not.toContain("billing_profiles");
    } finally { await stub.stop(); w.sqlite.close(); }
  });

  test("Try again on one missing part re-opens the build and starts only that part; a replay, a joined part and a stopped build are refused", async () => {
    const w = await world();
    const stub = bigStub();
    await stub.start();
    try {
      const p = await partReady(w, stub);
      stub.setBehavior("bun run build", builtFiles(p.root));
      expect(await p.part.finishModuleBuild!("join-structures")).toMatchObject({ joined: true });
      const money = await resolveModuleBuilderContext(env(w, stub), { conversationId: p.item.workflow.conversationId, moduleId: "money", buildSeq: p.buildSeq, features: ["sales"] }, {
        dispatchModuleBuilder: () => {},
        notifyCoordinator: (input: { key: string; message: string }) => void p.notified.push(input),
      });
      await money.buildNextFeature();
      await money.blockBuild("The payment provider's test keys are missing.");
      const coordinator = await resolveCoordinatorContext(env(w, stub), p.item.workflow.conversationId, { dispatchModuleBuilder: () => {} });
      expect(((await coordinator.verifyBuild("partly-1")) as { passed: boolean }).passed).toBe(true);
      expect((await readWorkflow(w.db, p.item.scope))?.phase).toBe("ready");

      const dispatched: Array<{ moduleId: string; instanceId: string }> = [];
      const dispatchFor = (conversationId: string) => {
        expect(conversationId).toBe(p.item.workflow.conversationId);
        return (input: { moduleId: string; instanceId: string }) => void dispatched.push(input);
      };
      // A joined part has nothing to try again.
      await rejectsCode(retryPart(w.db, p.item.scope, { moduleId: "structures", key: "try-structures-1" }, { dispatchFor }), "PART_NOT_STOPPED");
      // MUTATION: skip re-opening the build, and the coordinator is never asked
      // to check the app again once money joins (the build stays "ready").
      await retryPart(w.db, p.item.scope, { moduleId: "money", key: "try-money-1" }, { dispatchFor });
      const workflow = await readWorkflow(w.db, p.item.scope);
      expect(workflow?.phase).toBe("building");
      expect(workflow?.detail).toBeNull();
      expect(p.status("money")).toBe("building");
      expect(dispatched.map((d) => [d.moduleId, d.instanceId])).toEqual([["money", `${p.item.scope.projectId}:${p.buildSeq}:money`]]);
      // The same press again changes nothing.
      await retryPart(w.db, p.item.scope, { moduleId: "money", key: "try-money-1" }, { dispatchFor });
      expect(dispatched.length).toBe(1);
      // While the whole build is stopped, a part can't be tried on its own.
      await setWorkflowBlocker(w.db, p.item.scope, "Stopped.");
      await rejectsCode(retryPart(w.db, p.item.scope, { moduleId: "money", key: "try-money-2" }, { dispatchFor }), "BUILD_NOT_SETTLED");
    } finally { await stub.stop(); w.sqlite.close(); }
  });
});

describe("a paused build tells its owner once per run (plan 5.4)", () => {
  // Live finding (2026-10-20): a build Caddie paused only showed up if the
  // owner happened to open the Brief; nothing was raised where it paused.
  function withNotifications(w: Awaited<ReturnType<typeof world>>) {
    const ddl = readFileSync(new URL("../apps/app/migrations/0007_schedules.sql", import.meta.url), "utf8");
    for (const statement of splitSqlStatements(ddl)) w.sqlite.exec(statement);
  }
  const notes = (w: Awaited<ReturnType<typeof world>>) =>
    w.sqlite.query('select "userId", "projectId", "kind", "title", "body", "dedupeKey" from "notifications"').all();

  test("Caddie pausing the build notifies its owner once, with the reason, and never again for the same run", async () => {
    const w = await world();
    try {
      withNotifications(w);
      const item = await approved(w);
      const reason = "Caddie could not get the app checks passing after three attempts. Your plan and files are saved. The app is not ready to try yet.";
      await setWorkflowBlocker(w.db, item.scope, reason);
      await setWorkflowBlocker(w.db, item.scope, "Caddie used this build's step budget without getting the checks to pass, so the build was paused.");
      expect(notes(w)).toEqual([
        {
          userId: "alice",
          projectId: item.project.id,
          kind: "build_paused",
          title: "Caddie paused the build of Todo app",
          body: reason,
          dedupeKey: `brief:${item.workflow.runId}:blocked`,
        },
      ]);
    } finally { w.sqlite.close(); }
  });

  test("a build that stops making progress notifies its owner too", async () => {
    const w = await world();
    try {
      withNotifications(w);
      const item = await approved(w);
      const started = Date.parse((await readWorkflow(w.db, item.scope))!.updatedAt);
      expect(await reconcileStalledBuild(w.db, item.project.id, started + BUILD_STALL_MS + 1)).toBe(true);
      const [note] = notes(w) as { userId: string; title: string; body: string; dedupeKey: string }[];
      expect(note?.userId).toBe("alice");
      expect(note?.title).toBe("Caddie paused the build of Todo app");
      expect(note?.body).toContain("stopped making progress on the build");
      expect(note?.dedupeKey).toBe(`brief:${item.workflow.runId}:blocked`);
    } finally { w.sqlite.close(); }
  });

  test("the person's own Stop never notifies", async () => {
    const w = await world();
    try {
      withNotifications(w);
      const item = await approved(w);
      await stopWorkflow(w.db, item.scope);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("blocked");
      expect(notes(w)).toEqual([]);
    } finally { w.sqlite.close(); }
  });

  test("a notification that cannot be saved never undoes or hides the pause", async () => {
    const w = await world();
    try {
      // No notifications table at all: the pause is still recorded.
      const item = await approved(w);
      await setWorkflowBlocker(w.db, item.scope, "Caddie paused the build.");
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("blocked");
      expect((await readWorkflow(w.db, item.scope))?.detail).toBe("Caddie paused the build.");
    } finally { w.sqlite.close(); }
  });
});

describe("part A: a build never starts without its spending limit", () => {
  test("approving the design fails closed when the limit can't be opened, and approving again works once it can", async () => {
    const w = await world();
    try {
      const item = await designReady(w);
      // Make the limit store unusable for this one approval.
      w.sqlite.exec('alter table "build_spend_limits" rename to "build_spend_limits_off"');
      await expect(
        decideDesign(w.db, item.scope, { designId: item.design.id, decision: "approved" }),
      ).rejects.toThrow();
      // Nothing was decided and the build didn't start.
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("design-review");
      // With the store back, the same approval starts the build, with a payer.
      w.sqlite.exec('alter table "build_spend_limits_off" rename to "build_spend_limits"');
      await decideDesign(w.db, item.scope, { designId: item.design.id, decision: "approved" });
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("building");
      const row = w.sqlite
        .query('select "spendPayerId" from build_workflows where projectId = ?')
        .get(item.scope.projectId) as { spendPayerId: string | null };
      expect(row.spendPayerId).toMatch(/^build:/);
    } finally {
      w.sqlite.close();
    }
  });

  test("an operator spending cap in the env (SPEND_LIMIT_CAP_USD) lowers the new build's limit", async () => {
    const w = await world();
    try {
      const item = await designReady(w);
      // MUTATION PROOF: drop the env from the design approval's payer and the
      // build gets the standard $5 limit instead of the operator's $0.75.
      await decideDesign(w.db, item.scope, { designId: item.design.id, decision: "approved" }, { SPEND_LIMIT_CAP_USD: "0.75" });
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("building");
      const row = w.sqlite
        .query('select l."limitMicros" as limitMicros from build_workflows w join build_spend_limits l on l."payerId" = w."spendPayerId" where w.projectId = ?')
        .get(item.scope.projectId) as { limitMicros: number };
      expect(row.limitMicros).toBe(750_000);
    } finally {
      w.sqlite.close();
    }
  });
});

describe("part P: a module builder's repair limit and working copy are its own", () => {
  // Two modules build in parallel on the REAL module host
  // (resolveModuleBuilderContext) against the sandbox stub, each owning one
  // feature of the approved plan. The app's own tests fail, so every check
  // round fails. Team mode itself is off here: these paths are keyed on the
  // module scope, not on the switch.
  async function modulesWorld() {
    const w = await world();
    const stub = new SandboxStub({ expectedToken: "local-module-token" });
    stub.seedImage("tag:module-base:1");
    stub.setBehavior("bun run test", { exitCode: 1, stderr: "1 fail" });
    await stub.start();
    const item = await approved(w);
    const root = `/workspace/${item.scope.projectId}`;
    // Each module's start save point holds a marker only that module's copy
    // can see; the main build's session starts from the base image instead.
    const startImages = {
      feed: stub.seedImageWithFiles({ [`${root}/MODULE_START`]: "feed" }),
      tasks: stub.seedImageWithFiles({ [`${root}/MODULE_START`]: "tasks" }),
    };
    const env = {
      DB: w.db, CONTREE_BASE_URL: stub.url, CONTREE_API_TOKEN: "local-module-token",
      CONTREE_PROJECT_ID: "local-project", CONTREE_IMAGE: "tag:module-base:1",
    };
    const { plan } = await requireBuildApproval(w.db, item.scope);
    const insertFeature = w.sqlite.prepare(
      "insert into build_features (projectId,runId,planId,featureId,position,title,doneWhen,status,attempts,updatedAt) values (?,?,?,?,?,?,?,?,?,?)",
    );
    ["feed-feature", "tasks-feature"].forEach((featureId, position) =>
      insertFeature.run(item.scope.projectId, item.workflow.runId, plan.id, featureId, position, featureId, "[]", "building", 0, "2026-10-23T00:00:00.000Z"),
    );
    await seedModules(w.db, item.scope, {
      buildSeq: 0,
      payerId: "build:modules-test:1",
      modules: [{ moduleId: "feed", dependsOn: [] }, { moduleId: "tasks", dependsOn: [] }],
    });
    for (const moduleId of ["feed", "tasks"] as const) {
      await takeSlot(w.db, item.scope.projectId, 0, moduleId);
      w.sqlite
        .prepare('update build_modules set "status" = ?, "checkpointRef" = ? where "projectId" = ? and "buildSeq" = ? and "moduleId" = ?')
        .run("building", startImages[moduleId], item.scope.projectId, 0, moduleId);
    }
    const host = (moduleId: "feed" | "tasks") =>
      resolveModuleBuilderContext(env, {
        conversationId: item.workflow.conversationId,
        moduleId,
        buildSeq: 0,
        features: [`${moduleId}-feature`],
      });
    const moduleStatus = async (moduleId: string) => (await getModule(w.db, item.scope.projectId, 0, moduleId))?.status;
    const slots = () => w.count("build_module_slots", `projectId='${item.scope.projectId}'`);
    return { w, stub, item, root, host, moduleStatus, slots };
  }

  test("a module that spends its six tries stops only itself; the other module keeps building", async () => {
    const m = await modulesWorld();
    try {
      const feed = await m.host("feed");
      for (const attempt of ["feed-1", "feed-2", "feed-3", "feed-4", "feed-5", "feed-6"]) {
        const outcome = (await feed.runChecks!(attempt)) as { passed: boolean };
        expect(outcome.passed).toBe(false);
      }
      // feed spent its own six-attempt repair window: it stops ITSELF (the
      // module's repair pause -> the build-wide blocker), while feed's slot
      // frees and the project phase stays building for the other module.
      expect(await m.moduleStatus("feed")).toBe("stopped");
      expect(m.slots()).toBe(1); // feed's slot is free; tasks still holds its own
      expect((await readWorkflow(m.w.db, m.item.scope))?.phase).toBe("building");

      // The other module is not refused: its first failure is its own first
      // try, counted against tasks' own window — not feed's spent tries.
      const tasks = await m.host("tasks");
      const first = (await tasks.runChecks!("tasks-1")) as { passed: boolean; paused: boolean };
      expect(first.passed).toBe(false);
      expect(first.paused).toBe(false);
      expect(await m.moduleStatus("tasks")).toBe("building");
      expect((await readWorkflow(m.w.db, m.item.scope))?.phase).toBe("building");
      // feed's own spent tries still count for feed.
      await rejectsCode(feed.runChecks!("feed-7"), "RUN_PAUSED");
    } finally {
      m.w.sqlite.close();
      await m.stub.stop();
    }
  });

  test("a module host works on its own copy from its start save point, never the project's session pointer", async () => {
    const m = await modulesWorld();
    try {
      const feed = await m.host("feed");
      const tasks = await m.host("tasks");
      // MUTATION: open the module through openWorkingCopy (the main build's
      // session) and both reads see the base image, which has no marker.
      expect(await feed.driver.readFile({ sessionId: feed.sessionId, path: `${m.root}/MODULE_START` })).toBe("feed");
      expect(await tasks.driver.readFile({ sessionId: tasks.sessionId, path: `${m.root}/MODULE_START` })).toBe("tasks");
      expect(m.w.count("build_sandbox_sessions", `projectId='${m.item.scope.projectId}'`)).toBe(0);
    } finally {
      m.w.sqlite.close();
      await m.stub.stop();
    }
  });
});

describe("B02 §A — the absolute build deadline (the 103-min hang, host-side)", () => {
  // The stall watchdog only checks IDLE time (BUILD_STALL_MS = 20 min). A build
  // that keeps emitting a little activity — or a single delegate that pings
  // while hanging for 103 min — resets the idle clock and runs forever. The
  // absolute deadline (admission + BUILD_ABSOLUTE_MS) must pause it even when
  // it is NOT idle. Anchored on run_bindings.createdAt (the build's admission),
  // no new migration. Uses persistedBuildDeadline from build-deadlines.ts.
  test("a build past its absolute deadline is paused even with recent activity", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      w.sqlite
        .prepare("update build_workflows set phase = 'building', updatedAt = ? where projectId = ?")
        .run(new Date().toISOString(), item.project.id);
      // Admission 90 min ago → past the 60-min absolute deadline. The anchor is
      // the current attempt's payer id (build:<runId>:<startMs>); createdAt is
      // only the fallback. Set BOTH to 90 min ago so the attempt reads as old.
      const admittedMs = Date.now() - 90 * 60_000;
      const admittedAt = new Date(admittedMs).toISOString();
      w.sqlite
        .prepare("update build_workflows set spendPayerId = ? where projectId = ?")
        .run(`build:${item.workflow.runId}:${admittedMs}`, item.project.id);
      w.sqlite
        .prepare("update run_bindings set createdAt = ? where runId = ?")
        .run(admittedAt, item.workflow.runId);
      // Recent activity: idle is ~0, so the 20-min idle watchdog alone would NOT pause it.
      const paused = await reconcileStalledBuild(w.db, item.project.id, Date.now());
      expect(paused).toBe(true);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("blocked");
      expect((await readWorkflow(w.db, item.scope))?.detail).toContain("saved");
    } finally {
      w.sqlite.close();
    }
  });

  test("a build inside its absolute deadline with recent activity stays building", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      w.sqlite
        .prepare("update build_workflows set phase = 'building', updatedAt = ? where projectId = ?")
        .run(new Date().toISOString(), item.project.id);
      // Admitted 5 min ago, well inside the 60-min deadline, recent activity.
      const admittedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      w.sqlite
        .prepare("update run_bindings set createdAt = ? where runId = ?")
        .run(admittedAt, item.workflow.runId);
      const paused = await reconcileStalledBuild(w.db, item.project.id, Date.now());
      expect(paused).toBe(false);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("building");
    } finally {
      w.sqlite.close();
    }
  });
});

describe("B02 §D — late effects cannot advance a stopped build (inv.4 lock)", () => {
  // The shared fence both finishFeature and verifyBuild call first:
  // requireBuildApproval throws when the live phase is no longer 'building'.
  // A Stop / stall-pause that moved the build to 'blocked' therefore fences a
  // late finish_feature or verify_build — the orchestration re-reads the live
  // phase, it does not act on a stale in-flight settlement. These lock that.
  test("a finish/verify after a Stop is refused — BUILD_NOT_APPROVED (phase fence)", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      w.sqlite
        .prepare("update build_workflows set phase = 'building', updatedAt = ? where projectId = ?")
        .run(new Date().toISOString(), item.project.id);
      // While 'building', the fence lets work through.
      expect((await requireBuildApproval(w.db, item.scope)).plan.id).toBe(item.plan.id);
      // A Stop moves it to 'blocked'. A late finish/verify now hits the fence.
      await stopWorkflow(w.db, item.scope);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("blocked");
      await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
    } finally {
      w.sqlite.close();
    }
  });

  test("a stall-pause fences a late finish/verify the same way", async () => {
    const w = await world();
    try {
      const item = await approved(w);
      w.sqlite
        .prepare("update build_workflows set phase = 'building', updatedAt = ? where projectId = ?")
        .run(new Date(Date.now() - 90 * 60_000).toISOString(), item.project.id);
      // Past the absolute deadline → the watchdog pauses it to 'blocked'.
      const admittedAt = new Date(Date.now() - 90 * 60_000).toISOString();
      w.sqlite.prepare("update run_bindings set createdAt = ? where runId = ?").run(admittedAt, item.workflow.runId);
      expect(await reconcileStalledBuild(w.db, item.project.id, Date.now())).toBe(true);
      expect((await readWorkflow(w.db, item.scope))?.phase).toBe("blocked");
      // No preview was published by the stopped build.
      expect(w.count("workflow_outputs")).toBe(0);
      // And a late finish/verify is refused.
      await rejectsCode(requireBuildApproval(w.db, item.scope), "BUILD_NOT_APPROVED");
    } finally {
      w.sqlite.close();
    }
  });
});
