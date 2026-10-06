-- 0007_schedules.sql — P12 tasks, schedules, occurrences, sentinel results and
-- notifications (D1, SQLite dialect).
--
-- Additive only (no ALTER of earlier migrations, no drops). Numbering: the
-- GitHub packet owns 0006; 0007 leaves that slot free (decided against a main
-- branch check on 2026-10-05 — main ends at 0005_runs.sql).
--
-- Design rules carried over from the established migrations:
--   - SQLite dialect, text PKs, ISO-8601 strings in date columns.
--   - Every per-project access path indexes projectId first (audit defect #2).
--   - Storage enumerates state vocabularies with check constraints so storage
--     cannot drift from logic (audit defect #6 class).
--   - Schedules do NOT create a parallel scheduler runtime: a schedule is a
--     D1 record whose due slots are executed by calling the EXISTING run /
--     operation machinery (run_bindings + external_operations, P05/P03). The
--     D1 alarm/cron wiring is P09/P17; the unique occurrence index below is
--     the idempotency core that makes any executor safe to retry.

-- --- human tasks (project-scoped) ---------------------------------------------

create table "tasks" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "title" text not null,
  "status" text not null default 'open' check ("status" in ('open', 'done', 'cancelled')),
  "dueAt" date,
  "linkedRunId" text,
  "createdBy" text not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

create index "tasks_project_status_idx" on "tasks" ("projectId", "status");

create index "tasks_project_due_idx" on "tasks" ("projectId", "dueAt");

-- --- schedules (project-scoped; stored project/source ids, never "active") ------
--
-- Audit-defect shape: a schedule stores its projectId and an EXPLICIT payload
-- ({ "sourceId"?, "runId"?, both optional strings }) at creation. There is no
-- "currently active project" concept anywhere in the execution path — the
-- due-selection executor (selectDueSchedules / dispatchDueSchedules) is
-- system-level and works exclusively off the STORED ids, so switching projects
-- can never retarget a schedule.
--
-- cron is stored as the exact 5-field string the user gave; timezone is an
-- IANA zone name validated against the Intl ICU database at the service
-- boundary. nextRunAt is the computed UTC instant of the next slot.

create table "schedules" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "name" text not null,
  "cron" text not null,
  "timezone" text not null,
  "nextRunAt" date not null,
  "lastResult" text,
  "lastResultAt" date,
  "paused" integer not null default 0 check ("paused" in (0, 1)),
  "payload" text not null default '{}',
  "createdBy" text not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

create index "schedules_project_idx" on "schedules" ("projectId");

create index "schedules_due_idx" on "schedules" ("paused", "nextRunAt");

-- --- schedule occurrences (the idempotency core) ---------------------------------
--
-- occurrenceKey is the deterministic identity of ONE firing:
--   scheduled runs: the slot's UTC instant (from cron math) — the same slot
--     computed twice, by two executors, after a crash/retry, is the SAME key;
--   manual runs: "manual:<UTC instant of the request>" — two run-now calls in
--     the same second collapse, distinct seconds are distinct manual fires.
-- The (scheduleId, occurrenceKey) unique index makes a double dispatch a
-- no-op: the second insert is ignored, no second notification, no second
-- operation record. History is retained: editing a schedule's cron/timezone
-- recomputes nextRunAt but never deletes occurrence rows.

create table "schedule_occurrences" (
  "id" text not null primary key,
  "scheduleId" text not null references "schedules" ("id") on delete cascade,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "occurrenceKey" text not null,
  "slotAt" date not null,
  "kind" text not null default 'scheduled' check ("kind" in ('scheduled', 'manual')),
  "dispatchedAt" date not null,
  "dispatchedBy" text not null,
  "result" text
);

create unique index "schedule_occurrences_schedule_key_idx" on "schedule_occurrences" ("scheduleId", "occurrenceKey");

create index "schedule_occurrences_project_idx" on "schedule_occurrences" ("projectId");

-- --- sentinel results (append-only check history) --------------------------------
--
-- One row per check run comparing the rule claims of a previous snapshot
-- against a current snapshot of the same source. severity is decided by the
-- source's declared authority (rules tier = material, everything else =
-- informational); changes is a JSON array retaining the OLD and NEW claim ids
-- so every verdict stays traceable to evidence (defect #1 class). Rows are
-- never updated or deleted by any service path.

create table "sentinel_results" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "sourceId" text not null references "evidence_sources" ("id") on delete cascade,
  "scheduleId" text,
  "previousSnapshotId" text not null,
  "currentSnapshotId" text not null,
  "severity" text not null check ("severity" in ('material', 'informational', 'none')),
  "changedCount" integer not null check ("changedCount" >= 0),
  "changes" text not null,
  "createdAt" date not null
);

create index "sentinel_results_project_source_idx" on "sentinel_results" ("projectId", "sourceId", "createdAt");

-- --- notifications (in-app) -------------------------------------------------------
--
-- dedupeKey is unique: a repeated notify with the same effective key is a
-- no-op, never a second row. Time-window dedupe composes the window into the
-- key at the service boundary (key : window bucket), which keeps the storage
-- constraint absolute while allowing periodic digests to re-notify in a later
-- window.

create table "notifications" (
  "id" text not null primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "projectId" text,
  "kind" text not null,
  "title" text not null,
  "body" text not null,
  "readAt" date,
  "dedupeKey" text not null,
  "createdAt" date not null
);

create unique index "notifications_dedupe_idx" on "notifications" ("dedupeKey");

create index "notifications_user_idx" on "notifications" ("userId", "createdAt");

-- --- notification deliveries (email receipts + retry queue) -----------------------
--
-- Email is ABSENT locally: the Mailer port's default NoopMailer records
-- nothing. A real SMTP provider is the P17 wiring. Any attempted delivery
-- leaves a receipt here: status 'sent' is the delivery receipt, status
-- 'failed' is the retry-visible queue entry. A failed send NEVER fails the
-- calling domain operation — fire-and-forget with error capture.

create table "notification_deliveries" (
  "id" text not null primary key,
  "notificationId" text not null references "notifications" ("id") on delete cascade,
  "channel" text not null default 'email',
  "status" text not null check ("status" in ('sent', 'failed')),
  "error" text,
  "attempts" integer not null default 1 check ("attempts" >= 1),
  "createdAt" date not null
);

create index "notification_deliveries_status_idx" on "notification_deliveries" ("status", "createdAt");
