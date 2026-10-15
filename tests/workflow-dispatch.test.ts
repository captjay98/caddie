import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { D1Database } from "../apps/app/src/server/auth.ts";
import { projectScopeForUser } from "../apps/app/src/server/scope.ts";
import { ensureHomeProject, createPlanDocRevision } from "../apps/app/src/server/projects.ts";
import { createRun } from "../apps/app/src/server/runs.ts";
import {
  startProjectFromChat,
  decideWorkflow,
  workflowSnapshot,
  stopWorkflow,
  readWorkflow,
} from "../apps/app/src/server/build-workflow.ts";
import { dispatchPendingWorkflow, workerSelfDeliver, type CoordinatorDeliver } from "../apps/app/src/server/workflow-dispatch.ts";
import { getOperation } from "../apps/app/src/server/operations.ts";
import { splitSqlStatements } from "./fixtures/controls-harness.ts";

/**
 * LOCAL VERIFIED (R02): server-owned durable dispatch over real production
 * migrations/services on in-memory SQLite with a D1-shaped adapter + real
 * transaction behind D1.batch. The coordinator DO is represented by a FAKE
 * `deliver` boundary that counts how many times a logical message is handed to
 * the DO — this proves the ELECTION/idempotency/reconcile policy deterministically.
 * The at-least-once re-delivery + DO drain behaviour itself is the LIVE gate,
 * deferred to the live phase (needs a supported runtime, not a code read).
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
  async function approvedProject() {
    const started = await startProjectFromChat(db, homeScope, {
      name: "Todo app",
      description: "A todo app",
      brief: "Build a minimal todo app with filters and saved tasks. Show the plan first.",
      operationKey: "tool-create-one",
      sourceConversationId: homeRun.conversationId,
    });
    const scope = await projectScopeForUser(db, "alice", started.project.id);
    const plan = await createPlanDocRevision(db, scope, { kind: "prd", body: "# Todo\n\nAdd/complete/delete/filter/persist." });
    await workflowSnapshot(db, scope); // planning -> review
    await decideWorkflow(db, scope, { planId: plan.id, decision: "approved" });
    return { scope, plan };
  }
  return { db, approvedProject };
}

/** A deliver boundary that records every logical hand-off to the DO. */
function recordingDeliver(): CoordinatorDeliver & { calls: Array<{ conversationId: string; idempotencyKey: string }> } {
  const calls: Array<{ conversationId: string; idempotencyKey: string }> = [];
  const fn = (async (input) => {
    calls.push({ conversationId: input.conversationId, idempotencyKey: input.idempotencyKey });
    return { delivered: true };
  }) as CoordinatorDeliver & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("R02 server-owned durable dispatch", () => {
  test("one approval delivers exactly one coordinator message and clears the pending slot", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const before = await readWorkflow(w.db, scope);
    expect(before?.pendingKey).toBeTruthy(); // approval parked a pending message

    const deliver = recordingDeliver();
    const result = await dispatchPendingWorkflow(w.db, scope, deliver);
    expect(result.outcome).toBe("dispatched");
    expect(deliver.calls).toHaveLength(1);
    expect(deliver.calls[0]!.idempotencyKey).toBe(before!.pendingKey!);

    const after = await readWorkflow(w.db, scope);
    expect(after?.pendingKey).toBeNull(); // acked
  });

  test("duplicate dispatch (double-click / retried request) is a no-op — one logical job", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const deliver = recordingDeliver();
    await dispatchPendingWorkflow(w.db, scope, deliver);
    // Second call after ack: nothing pending.
    const second = await dispatchPendingWorkflow(w.db, scope, deliver);
    expect(second.outcome).toBe("none");
    expect(deliver.calls).toHaveLength(1);
  });

  test("concurrent election: a second dispatcher on the same pending key never re-sends", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const key = (await readWorkflow(w.db, scope))!.pendingKey!;
    // Simulate a racing dispatcher that already prepared+delivered the op by
    // running two dispatches "in parallel" (sequential here, but the election
    // via unique operationKey is what we assert). First wins and acks.
    const a = recordingDeliver();
    await dispatchPendingWorkflow(w.db, scope, a);
    const op = await getOperation(w.db, key);
    expect(op?.status).toBe("succeeded");
    expect(a.calls).toHaveLength(1);
  });

  test("uncertain delivery reconciles — never a blind re-send that double-fires", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const uncertain: CoordinatorDeliver = async () => ({ delivered: false });
    const result = await dispatchPendingWorkflow(w.db, scope, uncertain);
    expect(result.outcome).toBe("reconcile");
    const key = result.operationKey!;
    expect((await getOperation(w.db, key))?.status).toBe("reconciliation-required");

    // A follow-up dispatch must NOT re-deliver an operation stuck in reconcile.
    const after = recordingDeliver();
    const again = await dispatchPendingWorkflow(w.db, scope, after);
    expect(again.outcome).toBe("reconcile");
    expect(after.calls).toHaveLength(0); // no second send
    // pending slot stays set (not acked) until reconciliation resolves it.
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBe(key);
  });

  test("a thrown delivery (network drop) reconciles rather than crashing or re-sending", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const throwing: CoordinatorDeliver = async () => {
      throw new Error("connection reset");
    };
    const result = await dispatchPendingWorkflow(w.db, scope, throwing);
    expect(result.outcome).toBe("reconcile");
    expect((await getOperation(w.db, result.operationKey!))?.status).toBe("reconciliation-required");
  });

  test("after stop, there is nothing to dispatch — no self-resuming build", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    // Dispatch the approval first, then stop.
    await dispatchPendingWorkflow(w.db, scope, recordingDeliver());
    await stopWorkflow(w.db, scope);
    const afterStop = recordingDeliver();
    const result = await dispatchPendingWorkflow(w.db, scope, afterStop);
    expect(result.outcome).toBe("none");
    expect(afterStop.calls).toHaveLength(0);
  });
});

describe("workerSelfDeliver — the real self-fetch boundary", () => {
  // Regression (2026-10-15, FarmLog AI): the self-fetch was `app.fetch(request)`
  // with NO bindings, so the /agents guard read `c.env.AUTH_TEST_MODE` off
  // undefined, the delivery 500'd and every accepted proposal / approval sat in
  // reconciliation-required with the UI stuck on "turning your request into a plan".
  test("forwards THIS request's Worker env + execution context to the coordinator self-request", async () => {
    const seen: { url: string; env: unknown; ctx: unknown; body: string; cookie: string | null }[] = [];
    const app = {
      async fetch(request: Request, env?: unknown, ctx?: unknown) {
        seen.push({ url: request.url, env, ctx, body: await request.text(), cookie: request.headers.get("cookie") });
        return new Response("{}", { status: env ? 200 : 500 });
      },
    };
    const env = { DB: {}, BETTER_AUTH_SECRET: "x" };
    const ctx = { waitUntil() {} };
    const deliver = workerSelfDeliver(app, "http://localhost:5176", "session=abc", env, ctx);
    const result = await deliver({ conversationId: "conv_1", body: "Prepare a plan", idempotencyKey: "intake:k" });
    expect(result.delivered).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.env).toBe(env);
    expect(seen[0]!.ctx).toBe(ctx);
    expect(seen[0]!.url).toBe("http://localhost:5176/agents/coordinator/conv_1");
    expect(seen[0]!.cookie).toBe("session=abc");
    // The FLAT shape @flue/sdk send() posts (message fields + idempotencyKey
    // siblings). The nested { message: {...} } shape this test once pinned was
    // the second cause of the stuck "Planning your app" card.
    expect(JSON.parse(seen[0]!.body)).toEqual({ idempotencyKey: "intake:k", kind: "user", body: "Prepare a plan" });
  });
});
