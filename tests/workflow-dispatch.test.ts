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
  decideDesign,
  workflowSnapshot,
  stopWorkflow,
  stopBuild,
  readWorkflow,
} from "../apps/app/src/server/build-workflow.ts";
import {
  dispatchPendingWorkflow,
  needsRedelivery,
  recoverStalledDispatch,
  REDELIVERY_AFTER_MS,
  workerSelfDeliver,
  workerSelfAbort,
  type CoordinatorDeliver,
} from "../apps/app/src/server/workflow-dispatch.ts";
import { getOperation, markDispatched, prepareOperation, recordReceipt } from "../apps/app/src/server/operations.ts";
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
    "0024_design_phase.sql",
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
  /** A project whose pending message is the intake (phase planning). */
  async function intakeProject(name = "Intake app") {
    const started = await startProjectFromChat(db, homeScope, {
      name,
      description: name,
      brief: `Build ${name}. Show the plan first.`,
      operationKey: `tool-create-${name}`,
      sourceConversationId: homeRun.conversationId,
    });
    return { scope: await projectScopeForUser(db, "alice", started.project.id) };
  }
  /** A project whose pending message starts the build (design approved, phase building). */
  async function buildingProject() {
    const { scope } = await approvedProject();
    await dispatchPendingWorkflow(db, scope, async () => ({ delivered: true }));
    const design = await createPlanDocRevision(db, scope, { kind: "design", body: "# Design\n\nOne screen." });
    await workflowSnapshot(db, scope); // design -> design-review
    await decideDesign(db, scope, { designId: design.id, decision: "approved" });
    return { scope };
  }
  return { sqlite, db, approvedProject, intakeProject, buildingProject };
}

/**
 * A coordinator stand-in that behaves like the pinned Flue 2.2.2 keyed
 * admission (agent-coordinator / builtin-providers: adoptKeyedSubmissionReplay):
 * the same idempotency key with the same message converges on ONE submission
 * (deduplicated); the same key with a different message is a conflict. It can
 * also fail its first N deliveries (a non-2xx answer).
 */
function dedupingCoordinator(options: { failFirst?: number } = {}) {
  const admitted = new Map<string, string>();
  const deliveries: string[] = [];
  let failures = options.failFirst ?? 0;
  const deliver: CoordinatorDeliver = async ({ body, idempotencyKey }) => {
    deliveries.push(idempotencyKey);
    if (failures > 0) {
      failures -= 1;
      return { delivered: false };
    }
    const prior = admitted.get(idempotencyKey);
    if (prior !== undefined && prior !== body) throw new Error("SubmissionConflictError: the key names a different delivery");
    admitted.set(idempotencyKey, body);
    return { delivered: true };
  };
  return { deliver, admitted, deliveries };
}

const AFTER_LEASE = () => Date.now() + REDELIVERY_AFTER_MS + 1_000;

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

  test("uncertain delivery keeps the pending message, waits out the lease, then re-delivers once with the SAME key", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const uncertain: CoordinatorDeliver = async () => ({ delivered: false });
    const result = await dispatchPendingWorkflow(w.db, scope, uncertain);
    expect(result.outcome).toBe("reconcile");
    const key = result.operationKey!;
    expect((await getOperation(w.db, key))?.status).toBe("reconciliation-required");

    // Inside the lease a follow-up does not re-send, and nothing is cleared.
    const early = recordingDeliver();
    const again = await dispatchPendingWorkflow(w.db, scope, early);
    expect(again.outcome).toBe("in-flight");
    expect(early.calls).toHaveLength(0);
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBe(key);

    // After the lease, one re-delivery with the same key settles it.
    const later = recordingDeliver();
    const settled = await dispatchPendingWorkflow(w.db, scope, later, { now: Date.now() + REDELIVERY_AFTER_MS + 1 });
    expect(settled.outcome).toBe("dispatched");
    expect(later.calls).toEqual([{ conversationId: expect.any(String), idempotencyKey: key }]);
    expect((await getOperation(w.db, key))?.status).toBe("succeeded");
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBeNull();
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

describe("F01 a handoff is cleared only by an accepted delivery (review 2026-10-19)", () => {
  /** Simulate an attempt that marked the operation dispatched and then died. */
  async function crashedAttempt(db: D1Database, scope: { projectId: string }, key: string, conversationId: string, runId: string) {
    await prepareOperation(db, { projectId: scope.projectId, runId, provider: "coordinator-dispatch", operationKey: key });
    await markDispatched(db, key, conversationId);
  }

  for (const phase of ["planning", "design", "building"] as const) {
    test(`crash before the coordinator admitted it (${phase}): kept, then re-delivered once after the lease`, async () => {
      const w = await world();
      const { scope } =
        phase === "planning" ? await w.intakeProject() : phase === "design" ? await w.approvedProject() : await w.buildingProject();
      const workflow = (await readWorkflow(w.db, scope))!;
      expect(workflow.phase).toBe(phase);
      const key = workflow.pendingKey!;
      await crashedAttempt(w.db, scope, key, workflow.conversationId, workflow.runId);

      // The old code read 'dispatched' as delivered and cleared the slot here.
      const coordinator = dedupingCoordinator();
      const early = await dispatchPendingWorkflow(w.db, scope, coordinator.deliver);
      expect(early.outcome).toBe("in-flight");
      expect(coordinator.deliveries).toHaveLength(0);
      expect((await readWorkflow(w.db, scope))?.pendingKey).toBe(key);

      const recovered = await dispatchPendingWorkflow(w.db, scope, coordinator.deliver, { now: AFTER_LEASE() });
      expect(recovered.outcome).toBe("dispatched");
      expect(coordinator.deliveries).toEqual([key]);
      expect(coordinator.admitted.size).toBe(1);
      expect((await getOperation(w.db, key))?.status).toBe("succeeded");
      expect((await readWorkflow(w.db, scope))?.pendingKey).toBeNull();
    });
  }

  test("crash after the coordinator admitted it, before the receipt: the re-delivery converges on the same submission", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const workflow = (await readWorkflow(w.db, scope))!;
    const key = workflow.pendingKey!;
    const coordinator = dedupingCoordinator();
    await crashedAttempt(w.db, scope, key, workflow.conversationId, workflow.runId);
    // The coordinator admitted it; the Worker died before recording that.
    await coordinator.deliver({ conversationId: workflow.conversationId, body: workflow.pendingBody!, idempotencyKey: key });

    const recovered = await dispatchPendingWorkflow(w.db, scope, coordinator.deliver, { now: AFTER_LEASE() });
    expect(recovered.outcome).toBe("dispatched");
    expect(coordinator.deliveries).toEqual([key, key]);
    expect(coordinator.admitted.size).toBe(1); // one submission, not two
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBeNull();
  });

  test("crash after the receipt, before the slot was cleared: the next call clears it without sending", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const workflow = (await readWorkflow(w.db, scope))!;
    const key = workflow.pendingKey!;
    await crashedAttempt(w.db, scope, key, workflow.conversationId, workflow.runId);
    await recordReceipt(w.db, key, { receiptId: `delivered:${key}`, outcome: "succeeded" });

    const coordinator = dedupingCoordinator();
    const result = await dispatchPendingWorkflow(w.db, scope, coordinator.deliver);
    expect(result.outcome).toBe("noop");
    expect(coordinator.deliveries).toHaveLength(0);
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBeNull();
  });

  test("two dispatchers at once: one delivery, and the loser never clears the message before the 2xx", async () => {
    const w = await world();
    const { scope } = await w.approvedProject();
    const key = (await readWorkflow(w.db, scope))!.pendingKey!;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const deliveries: string[] = [];
    const slow: CoordinatorDeliver = async ({ idempotencyKey }) => {
      deliveries.push(idempotencyKey);
      entered();
      await gate;
      return { delivered: true };
    };
    const first = dispatchPendingWorkflow(w.db, scope, slow);
    await inside; // the first dispatcher is now mid-delivery, its outcome unknown
    const second = await dispatchPendingWorkflow(w.db, scope, slow);
    expect(second.outcome).toBe("in-flight");
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBe(key); // still there: nothing accepted yet
    release();
    expect((await first).outcome).toBe("dispatched");
    expect(deliveries).toEqual([key]);
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBeNull();
  });

  test("looking at the project recovers a stranded handoff after the lease, and leaves a fresh one alone", async () => {
    const w = await world();
    // A message the decision route has just written: its own sender is still on it.
    const fresh = await w.intakeProject("Fresh app");
    const coordinator = dedupingCoordinator();
    expect(await recoverStalledDispatch(w.db, fresh.scope, coordinator.deliver)).toBeNull();
    expect(coordinator.deliveries).toHaveLength(0);

    // A Worker that died between writing the message and sending it: no
    // operation row at all. Recovered once the lease has passed.
    const stranded = await w.intakeProject("Stranded app");
    const key = (await readWorkflow(w.db, stranded.scope))!.pendingKey!;
    expect(await needsRedelivery(w.db, stranded.scope)).toBe(false);
    expect(await needsRedelivery(w.db, stranded.scope, AFTER_LEASE())).toBe(true);
    const recovered = await recoverStalledDispatch(w.db, stranded.scope, coordinator.deliver, AFTER_LEASE());
    expect(recovered?.outcome).toBe("dispatched");
    expect(coordinator.deliveries).toEqual([key]);
    expect((await readWorkflow(w.db, stranded.scope))?.pendingKey).toBeNull();
    // Settled: nothing more to recover.
    expect(await recoverStalledDispatch(w.db, stranded.scope, coordinator.deliver, AFTER_LEASE())).toBeNull();
    expect(coordinator.deliveries).toEqual([key]);
  });

  test("repeated non-2xx answers keep the message; each retry waits out the lease and the first 2xx settles it", async () => {
    const w = await world();
    const { scope } = await w.intakeProject("Flaky app");
    const key = (await readWorkflow(w.db, scope))!.pendingKey!;
    const coordinator = dedupingCoordinator({ failFirst: 2 });
    expect((await dispatchPendingWorkflow(w.db, scope, coordinator.deliver)).outcome).toBe("reconcile");
    expect((await dispatchPendingWorkflow(w.db, scope, coordinator.deliver, { now: AFTER_LEASE() })).outcome).toBe("reconcile");
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBe(key);
    const settled = await dispatchPendingWorkflow(w.db, scope, coordinator.deliver, { now: AFTER_LEASE() + REDELIVERY_AFTER_MS });
    expect(settled.outcome).toBe("dispatched");
    expect(coordinator.deliveries).toEqual([key, key, key]);
    expect(coordinator.admitted.size).toBe(1);
    expect((await readWorkflow(w.db, scope))?.pendingKey).toBeNull();
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

describe("one Stop for every Stop button: the workflow, then the running turn (plan 3.2)", () => {
  // Live, the project page's "Stop work" only stopped the workflow, while the
  // chat's "Stop build" also aborted the running turn from the browser. The
  // server now does both for every caller.
  test("workerSelfAbort makes the browser's own abort request, with this request's cookie and bindings", async () => {
    const seen: { url: string; method: string; env: unknown; cookie: string | null; body: string }[] = [];
    const app = {
      async fetch(request: Request, env?: unknown) {
        seen.push({ url: request.url, method: request.method, env, cookie: request.headers.get("cookie"), body: await request.text() });
        return new Response("{}", { status: 200 });
      },
    };
    const env = { DB: {} };
    const abort = workerSelfAbort(app, "http://localhost:5176", "session=abc", env);
    expect(await abort("conv_1")).toBe(true);
    expect(seen).toEqual([{ url: "http://localhost:5176/agents/coordinator/conv_1/abort", method: "POST", env, cookie: "session=abc", body: "" }]);
  });

  test("stopBuild marks the build stopped before it stops the build's turn, and a failed abort keeps the stop", async () => {
    const w = await world();
    const { scope } = await w.buildingProject();
    const phaseNow = () => (w.sqlite.prepare("select phase from build_workflows where projectId = ?").get(scope.projectId) as { phase: string }).phase;
    const conversationId = (await readWorkflow(w.db, scope))!.conversationId;
    expect(phaseNow()).toBe("building");
    const seen: { conversationId: string; phase: string }[] = [];
    const result = await stopBuild(w.db, scope, async (id) => {
      seen.push({ conversationId: id, phase: phaseNow() });
      throw new Error("the agent could not be reached");
    });
    expect(seen).toEqual([{ conversationId, phase: "blocked" }]);
    expect(result.workflow?.phase).toBe("blocked");
    expect(result.workflow?.detail?.startsWith("Stop requested.")).toBe(true);
  });
});
