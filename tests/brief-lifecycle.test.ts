import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeParse } from "valibot";
import { BriefSummarySchema } from "@caddie/contracts";
import type { D1Database } from "../apps/app/src/server/auth.ts";
import { accountBrief, summariseBrief, markBriefRead } from "../apps/app/src/server/brief.ts";

/**
 * R05 LOCAL VERIFIED: the brief-in-chat summary is derived from the SAME
 * accountBrief (one source, so chat and Brief never drift), and the brief no
 * longer leaks internal-ID headlines. In-memory SQLite over the real DDL.
 */

const REPO = join(import.meta.dir, "..");
// The real schema: every migration, in order (the brief reads build_workflows).
const MIGRATIONS_DIR = join(REPO, "apps", "app", "migrations");
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((n) => /^\d+_.*\.sql$/.test(n))
  .sort()
  .map((n) => join(MIGRATIONS_DIR, n));

const ISO = "2026-10-05T00:00:00.000Z";

function d1(sqlite: Database): D1Database {
  return {
    prepare: (q: string) => {
      const stmt = sqlite.prepare(q);
      return {
        bind: (...v: unknown[]) => ({
          run: async () => stmt.run(...(v as never[])),
          all: async () => ({ results: stmt.all(...(v as never[])) as unknown[], meta: {} }),
        }),
        run: async () => stmt.run(),
        all: async () => ({ results: stmt.all() as unknown[], meta: {} }),
      };
    },
    batch: async (s: unknown[]) => {
      const out: unknown[] = [];
      for (const stmt of s as { run(): unknown }[]) out.push(await stmt.run());
      return out;
    },
    exec: async (q: string) => sqlite.exec(q),
  } as unknown as D1Database;
}

function world(): { db: D1Database; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const p of MIGRATIONS) sqlite.exec(readFileSync(p, "utf8"));
  sqlite.exec(`
    insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values
      ('alice','Alice','alice@example.com',0,'${ISO}','${ISO}');
    insert into "workspaces" ("id","name","createdAt") values ('ws-a','Alice WS','${ISO}');
    insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values ('mem-a','ws-a','alice','owner','${ISO}');
    insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt") values ('proj-a','ws-a','Alice Project','active','${ISO}','${ISO}');
    -- one live pending approval (needs-you), one armed schedule (handled)
    insert into "approvals" ("id","projectId","action","resourceId","revisionHash","policyVersion","intentHash","decidedBy","status","expiresAt","createdAt","decidedAt") values
      ('ap-live','proj-a','design','plan-r1','hash-r1','v1','intent-live',null,'pending','2999-01-01T00:00:00.000Z','2026-10-04T10:00:00.000Z',null);
    insert into "schedules" ("id","projectId","name","cron","timezone","nextRunAt","lastResult","lastResultAt","paused","payload","createdBy","createdAt","updatedAt") values
      ('sch-1','proj-a','Weekly discovery sweep','0 7 * * 1','Africa/Lagos','2026-10-06T07:00:00.000Z',null,null,0,'{}','alice','${ISO}','${ISO}');
    -- a failed run (blocked)
    insert into "run_rounds" ("id","runId","projectId","issue","round","outcome","detail","createdAt") values
      ('rr-1','run-1','proj-a','preview check failed','repair_attempt','failed',null,'2026-10-04T09:00:00.000Z');
  `);
  return { db: d1(sqlite), sqlite };
}

describe("R05 brief-in-chat summary derives from the same account brief", () => {
  test("summary counts equal what the account brief actually contains", async () => {
    const { db } = world();
    const brief = await accountBrief(db, "alice");
    const summary = summariseBrief(brief);
    expect(safeParse(BriefSummarySchema, summary).success).toBe(true);

    const open = brief.cards.filter((c) => c.status !== "handled");
    const handled = brief.cards.filter((c) => c.status === "handled");
    // One source of truth: the summary's counts are exactly the brief's.
    expect(summary.openCount).toBe(open.length);
    expect(summary.updatesCount).toBe(handled.length);
    expect(summary.needsYouCount).toBe(open.filter((c) => !c.seen).length);
    expect(summary.href).toBe("/app/");
  });

  test("marking the needs-you card read lowers the summary's needsYouCount in lockstep", async () => {
    const { db } = world();
    const before = summariseBrief(await accountBrief(db, "alice"));
    expect(before.needsYouCount).toBeGreaterThan(0);
    const approval = (await accountBrief(db, "alice")).cards.find((c) => c.kind === "approval")!;
    await markBriefRead(db, "alice", [approval.key!]);
    const after = summariseBrief(await accountBrief(db, "alice"));
    expect(after.needsYouCount).toBe(before.needsYouCount - 1);
    // Reading never resolves: the open count is unchanged.
    expect(after.openCount).toBe(before.openCount);
  });

  test("caught-up state reads honestly", async () => {
    const summary = summariseBrief({
      cards: [],
      unseenCount: 0,
      projects: [],
      asOf: ISO,
    });
    expect(summary.needsYouCount).toBe(0);
    expect(summary.openCount).toBe(0);
    expect(summary.headline).toContain("caught up");
  });
});

describe("R05 brief no longer leaks internal-ID / cron headlines", () => {
  test("a failed run shows user-facing copy, raw issue only in the summary", async () => {
    const { db } = world();
    const brief = await accountBrief(db, "alice");
    const blocked = brief.cards.find((c) => c.status === "blocked")!;
    expect(blocked.headline).not.toContain("Run stopped");
    expect(blocked.headline.toLowerCase()).toContain("problem");
    // the raw ledger issue is still available, in the summary not the headline
    expect(blocked.summary).toContain("preview check failed");
  });

  test("a schedule card headline carries no raw cron expression", async () => {
    const { db } = world();
    const brief = await accountBrief(db, "alice");
    const handled = brief.cards.find((c) => c.kind === "deadline")!;
    expect(handled.headline).toContain("Weekly discovery sweep");
    expect(handled.headline).not.toContain("* * *");
    expect(handled.headline).not.toContain("0 7");
  });
});
