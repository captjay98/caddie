-- 0023_build_features.sql — the host-driven feature loop (build-loop Phase 1).
-- Additive only; SQLite dialect for D1.
--
-- Owns:
--   build_features          one row per feature of an approved plan revision,
--                           created when that revision's build starts. The host
--                           builds them in `position` order, one at a time; a
--                           feature passes only on green host checks plus new
--                           passing tests, and then records the sandbox image
--                           it left (`checkpointRef`) as a save point.
--   build_sandbox_sessions  which sandbox session the build uses when it is NOT
--                           the default `session:<runId>` — set by a rollback,
--                           which starts a fresh session from a feature's save
--                           point (the image becomes that session's start).
--
-- The feature list itself is NOT authored here: it is parsed from the
-- approved PRD revision's `caddie-features` block, so the user's approval
-- (bound to that revision's hash) covers exactly what gets built.

create table "build_features" (
  "projectId" text not null references "projects" ("id") on delete cascade,
  "runId" text not null,
  "planId" text not null,
  "featureId" text not null,
  "position" integer not null,
  "title" text not null,
  -- JSON array of the feature's observable "done when" checks.
  "doneWhen" text not null,
  "status" text not null check ("status" in ('pending', 'building', 'passed', 'failed')),
  -- Failed check rounds spent on this feature (mirrors its repair_attempt rows).
  "attempts" integer not null default 0,
  -- Passing tests in the project when the feature went green.
  "testsPassed" integer,
  -- The sandbox image after the feature went green: its save point.
  "checkpointRef" text,
  "passedAt" text,
  "updatedAt" text not null,
  primary key ("projectId", "planId", "featureId")
);

create index "build_features_plan_idx" on "build_features" ("projectId", "planId", "position");

create table "build_sandbox_sessions" (
  "projectId" text primary key not null references "projects" ("id") on delete cascade,
  "runId" text not null,
  "sessionKey" text not null,
  -- The image a NEW session with this key starts from (a feature save point).
  "image" text not null,
  "reason" text not null,
  "updatedAt" text not null
);
