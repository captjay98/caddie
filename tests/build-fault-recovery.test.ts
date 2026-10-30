import { allMigrationPaths } from "./fixtures/migrations.ts";
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { D1Database } from "../apps/app/src/server/auth.ts";
import {
  prepareOperation,
  markDispatched,
  recordReceipt,
  requestCancel,
  markCancelled,
  markReconciliationRequired,
  claimForDelivery,
  getOperation,
} from "../apps/app/src/server/operations.ts";

/**
 * B01 — the failure laboratory (operations layer).
 *
 * The durable-operation primitives in `operations.ts` are where invariants 1
 * (one logical effect = one durable identity) and 2 (ambiguous effects are
 * reconciled with the receipt, never fabricated) are ENFORCED. These cases
 * lock that enforcement as regression guards: the plan's reliability wave must
 * not weaken it while wiring deadlines/retries above it.
 *
 * They are deliberately GREEN today — a passing guard here is the point (it is
 * the baseline the B02 recovery policy must preserve). The genuinely-open
 * question (late effect after Stop, invariant 4) is PROBED here and pinned to
 * the orchestration layer above — see the final `describe`.
 *
 * In-memory D1 via bun:sqlite, mirroring tests/workflow-dispatch.test.ts. No
 * server, no sandbox, no paid calls, deterministic.
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

function freshDb(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const path of allMigrationPaths()) {
    sqlite.exec(readFileSync(path, "utf8"));
  }
  // Seed the project `external_operations.projectId` references (workspaces has
  // no FK; projects → workspaces). The fixture must stand on its own, not fail
  // for a missing-environment reason (B01 gate).
  const now = new Date().toISOString();
  sqlite.exec(
    `insert into "workspaces" ("id","name","createdAt") values ('ws_fault','Fault Lab','${now}')`,
  );
  sqlite.exec(
    `insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt") values ('proj_fault','ws_fault','Fault Lab Project','active','${now}','${now}')`,
  );
  return d1Adapter(sqlite);
}

/** A prepared+dispatched operation, ready to receive a receipt. */
async function dispatched(db: D1Database, operationKey: string) {
  await prepareOperation(db, {
    projectId: "proj_fault",
    runId: "run_fault",
    operationKey,
    provider: "contree",
  });
  await markDispatched(db, operationKey, "remote-1");
  return operationKey;
}

describe("B01 invariant 1 — one logical effect has one durable identity", () => {
  test("a second prepare on the same operationKey is refused (not a second effect)", async () => {
    const db = freshDb();
    await prepareOperation(db, { projectId: "proj_fault", runId: "run_fault", operationKey: "op-dup", provider: "contree" });
    await expect(
      prepareOperation(db, { projectId: "proj_fault", runId: "run_fault", operationKey: "op-dup", provider: "contree" }),
    ).rejects.toMatchObject({ code: "operation_key_conflict" });
    // Still exactly one row, still in its first state.
    const op = await getOperation(db, "op-dup");
    expect(op?.status).toBe("prepared");
  });

  test("claimForDelivery lets exactly one sender win from prepared", async () => {
    const db = freshDb();
    await prepareOperation(db, { projectId: "proj_fault", runId: "run_fault", operationKey: "op-claim", provider: "contree" });
    const at = new Date().toISOString();
    const stale = new Date(Date.now() - 60_000).toISOString();
    const first = await claimForDelivery(db, "op-claim", "remote-A", at, stale);
    const second = await claimForDelivery(db, "op-claim", "remote-B", at, stale);
    expect(first).toBe(true);
    expect(second).toBe(false); // already dispatched + fresh → the second sender loses
    const op = await getOperation(db, "op-claim");
    expect(op?.status).toBe("dispatched");
  });
});

describe("B01 invariant 2 — receipts reconcile, never fabricate", () => {
  test("replaying the SAME receipt is a no-op (one settlement, not two)", async () => {
    const db = freshDb();
    await dispatched(db, "op-replay");
    const first = await recordReceipt(db, "op-replay", { receiptId: "rcpt-1", outcome: "succeeded" });
    const again = await recordReceipt(db, "op-replay", { receiptId: "rcpt-1", outcome: "succeeded" });
    expect(first.status).toBe("succeeded");
    expect(again.status).toBe("succeeded");
    expect(again.receiptId).toBe("rcpt-1");
  });

  test("a DIFFERENT receipt on a settled row is a typed conflict, not a re-settlement", async () => {
    const db = freshDb();
    await dispatched(db, "op-conflict");
    await recordReceipt(db, "op-conflict", { receiptId: "rcpt-1", outcome: "succeeded" });
    await expect(
      recordReceipt(db, "op-conflict", { receiptId: "rcpt-2", outcome: "failed" }),
    ).rejects.toMatchObject({ code: "receipt_conflict" });
    const op = await getOperation(db, "op-conflict");
    expect(op?.status).toBe("succeeded"); // unchanged
  });

  test("a receipt with no dispatch on record cannot fabricate completion", async () => {
    const db = freshDb();
    await prepareOperation(db, { projectId: "proj_fault", runId: "run_fault", operationKey: "op-nodispatch", provider: "contree" });
    await expect(
      recordReceipt(db, "op-nodispatch", { receiptId: "rcpt-x", outcome: "succeeded" }),
    ).rejects.toMatchObject({ code: "operation_invalid_transition" });
    expect((await getOperation(db, "op-nodispatch"))?.status).toBe("prepared");
  });

  test("an ambiguous dispatch stops at reconciliation-required, not a guessed outcome", async () => {
    const db = freshDb();
    await dispatched(db, "op-ambig");
    const op = await markReconciliationRequired(db, "op-ambig");
    expect(op.status).toBe("reconciliation-required"); // never silently succeeded/failed
  });
});

describe("B01 invariant 4 — late effect after Stop (boundary probe)", () => {
  test("a cancel REQUEST does not by itself fence a genuine late receipt (by design)", async () => {
    // requestCancel moves dispatched → cancel-requested; the remote MAY have
    // finished before the cancel landed, so recordReceipt is still allowed to
    // settle the real outcome from cancel-requested. This is correct per inv.2
    // (reconcile with the receipt; unknown is not failed). The FENCE is the
    // terminal `cancelled` state, asserted below.
    const db = freshDb();
    await dispatched(db, "op-cancel-race");
    await requestCancel(db, "op-cancel-race");
    const settled = await recordReceipt(db, "op-cancel-race", { receiptId: "rcpt-late", outcome: "succeeded" });
    expect(settled.status).toBe("succeeded");
  });

  test("once TERMINALLY cancelled, a late success receipt is refused (fence holds)", async () => {
    const db = freshDb();
    await dispatched(db, "op-cancelled");
    await requestCancel(db, "op-cancelled");
    await markCancelled(db, "op-cancelled", "rcpt-cancel");
    await expect(
      recordReceipt(db, "op-cancelled", { receiptId: "rcpt-late-success", outcome: "succeeded" }),
    ).rejects.toMatchObject({ code: "receipt_conflict" });
    expect((await getOperation(db, "op-cancelled"))?.status).toBe("cancelled");
  });

  // NOTE (B01 finding → B02): the operations PRIMITIVE fences late effects
  // correctly at the row level. The open invariant-4 question is one layer up:
  // does the build ORCHESTRATION (coordinator-host.ts / build-workflow.ts)
  // treat a cancel-requested→late-succeeded settlement as "advance the feature
  // / publish the preview", or does it fence by run/admission/attempt
  // generation? That is the real RED surface; a failing orchestration test
  // goes in tests/build-recovery.test.ts (B02 §D), not here.
});
