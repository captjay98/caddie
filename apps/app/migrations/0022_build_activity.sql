-- 0022_build_activity.sql — the app-owned build activity ledger.
-- Additive only; SQLite dialect for D1.
--
-- Owns:
--   build_activity  one row per real sandbox action the build host performed
--                   for a run: the generic scaffold upload, each file write,
--                   each command, and each host check (verify_build). Written
--                   by the host at the sandbox boundary (coordinator-host.ts),
--                   never by a model, and never containing file contents.
--
-- Why: Flue returns only a specialist's FINAL answer to the parent
-- conversation, so the browser cannot see which files were written or which
-- commands ran. The build timeline ("what is being built, how long each step
-- took, are the tests passing") reads this ledger instead of guessing.
-- Observability only: no authorization or completion decision reads it — the
-- verification log and the workflow phase stay authoritative.

create table "build_activity" (
  "id" text primary key not null,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "runId" text not null,
  "kind" text not null check ("kind" in ('setup', 'file', 'command', 'check')),
  -- The specialist role that acted (frontend/backend/mobile/qa/tech-lead), or
  -- null for host-initiated actions.
  "role" text,
  -- Workspace-relative file path, the command line, or the check name.
  "subject" text not null,
  "outcome" text not null check ("outcome" in ('ok', 'failed', 'cancelled')),
  "exitCode" integer,
  -- Parsed from a real test command's output; null when it was not a test run
  -- or the counts were not printed.
  "testsPassed" integer,
  "testsFailed" integer,
  "bytes" integer,
  "startedAt" text not null,
  "finishedAt" text not null,
  "durationMs" integer not null
);

create index "build_activity_run_idx" on "build_activity" ("runId", "startedAt");
