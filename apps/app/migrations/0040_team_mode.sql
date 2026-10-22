-- 0040_team_mode.sql — Software-team mode foundations (lane 1, plan section 4).
--
-- Additive only (append-style; no ALTER of earlier tables except the
-- build_workflows column adds this migration is for, no drops). D1/SQLite
-- dialect. Conventions follow 0002 and 0018: quoted identifiers, text ids,
-- text ISO-8601 timestamps, a CHECK for every enum, an index for every
-- lookup a part makes. Money is integer micros (1e-6 of a unit) everywhere;
-- no floats. Trigger DDL keeps `end;` on its own line so the test harness's
-- statement splitter stays deterministic.

-- --- build_workflows: team-mode columns (section 4) --------------------------
--
-- build_workflows is created in 0018 with unquoted identifiers; these adds use
-- the same unquoted style so the table reads consistently. The three mode
-- columns are stamped once when a workflow is created (build-workflow.ts
-- ensureWorkflow) and never changed, so a project keeps its mode. spendPayerId
-- names the build's payer in build_spend_limits (part A). approvedDesignRevisionId
-- binds the build, its checks and publish to one design revision (parts B/E/G).
alter table build_workflows add column teamMode integer not null default 0 check (teamMode in (0, 1));
alter table build_workflows add column bigApps integer not null default 0 check (bigApps in (0, 1));
alter table build_workflows add column appFeatures integer not null default 0 check (appFeatures in (0, 1));
alter table build_workflows add column spendPayerId text;
alter table build_workflows add column approvedDesignRevisionId text;

-- --- build_spend_limits (part A) ---------------------------------------------
--
-- One row per payer with its ceiling in micros. A build creates a payer
-- `build:<runId>:<time>` with its D4 limit. NOT migration 0002's budget_payers:
-- those count whole cents (minor units) with each reservation at least 1, while
-- one model call costs a fraction of a cent, and 0002's trigger counts only
-- open reservations, not money already settled (part A step 4).
create table "build_spend_limits" (
  "payerId" text not null primary key,
  "limitMicros" integer not null check ("limitMicros" >= 0),
  "createdAt" text not null,
  "updatedAt" text not null
);

-- --- build_spend_reservations (part A) ---------------------------------------
--
-- One row per model call, keyed by turnId (unique: Flue keys each `model`
-- operation by turnId, so a reservation is made at most once per call). The
-- limit is enforced ATOMICALLY by the trigger below, inside the INSERT itself:
-- the reservation is refused in ONE conditional insert when
--   (settled so far) + (open reservations) + (this estimate) > limit.
-- Two concurrent reserves serialize on SQLite's write lock and the over-limit
-- one aborts, so the limit is hard across every builder sharing the payer.
-- reservedMicros is the worst-case estimate; settledMicros is this call's own
-- usage, written when the reservation settles. A reservation never settled (a
-- crash mid-call) stays counted as reserved — the safe direction.
create table "build_spend_reservations" (
  "turnId" text not null primary key,
  "payerId" text not null references "build_spend_limits" ("payerId"),
  "conversationId" text not null,
  "reservedMicros" integer not null check ("reservedMicros" >= 0),
  "settledMicros" integer check ("settledMicros" >= 0),
  "status" text not null default 'reserved' check ("status" in ('reserved', 'settled', 'released')),
  "createdAt" text not null,
  "updatedAt" text not null
);

create index "build_spend_reservations_payer_status_idx" on "build_spend_reservations" ("payerId", "status");

create index "build_spend_reservations_conversation_idx" on "build_spend_reservations" ("conversationId");

-- The hard limit, enforced in the insert. settled counts settledMicros of
-- settled rows (money truly spent); reserved counts reservedMicros of still-open
-- rows (worst-case liability). released rows count toward neither. A payer with
-- no limit row is refused (the limit reads as -1): part A creates the limit row
-- before the first reservation, so a missing one is a bug, and the guard fails
-- closed whatever the database's foreign-key setting.
create trigger "build_spend_reservations_limit_guard"
before insert on "build_spend_reservations"
when new."status" = 'reserved'
begin
  select raise(abort, 'spend_limit_exceeded')
  where (
    select coalesce(sum("settledMicros"), 0)
    from "build_spend_reservations"
    where "payerId" = new."payerId" and "status" = 'settled'
  ) + (
    select coalesce(sum("reservedMicros"), 0)
    from "build_spend_reservations"
    where "payerId" = new."payerId" and "status" = 'reserved'
  ) + new."reservedMicros"
  > coalesce((select "limitMicros" from "build_spend_limits" where "payerId" = new."payerId"), -1);
end;

-- --- architecture_reviews (part B) -------------------------------------------
--
-- One row per Ultra review round of a design's architecture block. blockHash
-- pins the review to the exact block reviewed; issues is a JSON array, each
-- issue carrying its own severity (security | advisory). A security issue
-- blocks until fixed, with no round limit (section 4 / part B).
create table "architecture_reviews" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "blockHash" text not null,
  "round" integer not null check ("round" >= 1),
  "issues" text not null,
  "createdAt" text not null
);

create index "architecture_reviews_project_idx" on "architecture_reviews" ("projectId");

create unique index "architecture_reviews_project_block_round_idx" on "architecture_reviews" ("projectId", "blockHash", "round");

-- --- build_modules (part P/Q) ------------------------------------------------
--
-- One row per module of a big-app build. buildSeq distinguishes successive
-- builds of the same project; (projectId, buildSeq, moduleId) is one module.
-- sessionKey is the module's own build copy; checkpointRef its last save point;
-- builderId the ModuleBuilder instance. A stopped module does not stop the
-- others (status 'stopped'); a module that fails to merge ends 'not-merged'.
create table "build_modules" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "buildSeq" integer not null check ("buildSeq" >= 0),
  "moduleId" text not null,
  "status" text not null default 'pending' check ("status" in ('pending', 'building', 'stopped', 'passed', 'merged', 'not-merged')),
  "sessionKey" text,
  "checkpointRef" text,
  "builderId" text,
  "createdAt" text not null,
  "updatedAt" text not null
);

create index "build_modules_project_seq_idx" on "build_modules" ("projectId", "buildSeq");

create unique index "build_modules_identity_idx" on "build_modules" ("projectId", "buildSeq", "moduleId");

-- --- integration_locks (part Q) ----------------------------------------------
--
-- The D1 integration lock that lets only one module merge into the app at a
-- time. One row per project while held; holder names who holds it, expiresAt
-- when a crashed holder's lock may be taken.
create table "integration_locks" (
  "projectId" text not null primary key references "projects" ("id") on delete cascade,
  "holder" text not null,
  "expiresAt" text not null,
  "createdAt" text not null
);

create index "integration_locks_expires_idx" on "integration_locks" ("expiresAt");

-- --- part_manifests (part D) -------------------------------------------------
--
-- The path+sha256 manifest of an app's source folders recorded by start_part,
-- read back by finish_part/finish_feature to refuse any change outside a
-- builder's own area. manifest is a JSON document; one row per (project, part).
create table "part_manifests" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "partKey" text not null,
  "manifest" text not null,
  "createdAt" text not null
);

create index "part_manifests_project_idx" on "part_manifests" ("projectId");

create unique index "part_manifests_project_part_idx" on "part_manifests" ("projectId", "partKey");

-- --- app_test_emails (part K) ------------------------------------------------
--
-- The project's test inbox. Every email from a preview or published app this
-- week is stored here, marked "not sent" (D11). mode distinguishes a preview
-- from a (still test-mode) live app. Nothing is ever delivered.
create table "app_test_emails" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "mode" text not null check ("mode" in ('preview', 'live')),
  "toEmail" text not null,
  "subject" text not null,
  "textBody" text not null,
  "template" text,
  "createdAt" text not null
);

create index "app_test_emails_project_created_idx" on "app_test_emails" ("projectId", "createdAt");

-- --- app_job_runs (part N) ---------------------------------------------------
--
-- One row per "Run now" job run. mode distinguishes preview from live; summary
-- is the route's one-line result (at most 300 chars, enforced by the part).
create table "app_job_runs" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "mode" text not null check ("mode" in ('preview', 'live')),
  "jobId" text not null,
  "status" text not null check ("status" in ('running', 'done', 'failed')),
  "summary" text,
  "startedAt" text not null,
  "finishedAt" text
);

create index "app_job_runs_project_job_idx" on "app_job_runs" ("projectId", "jobId");

create index "app_job_runs_project_started_idx" on "app_job_runs" ("projectId", "startedAt");

-- --- platform_switches (section 4) -------------------------------------------
--
-- A stored override for a platform switch. A row present means the switch's
-- value is set (overriding the env default); no row means the env default
-- stands. Keys and values are validated in server/platform-switches.ts; the
-- CHECKs here are the floor so a bad value can never land in the table.
create table "platform_switches" (
  "key" text not null primary key check ("key" in ('team_mode', 'big_apps', 'app_features', 'spend_enforcement', 'publish_safety')),
  "value" text not null check ("value" in ('off', 'owner', 'on')),
  "updatedAt" text not null
);

-- --- platform_switch_log (section 4) -----------------------------------------
--
-- One row per flip: who flipped it, the old and new values, and when. oldValue
-- is null for the first flip of a key (no prior stored value). Append-only.
create table "platform_switch_log" (
  "id" text not null primary key,
  "key" text not null,
  "oldValue" text,
  "newValue" text not null,
  "actorId" text not null,
  "createdAt" text not null
);

create index "platform_switch_log_key_created_idx" on "platform_switch_log" ("key", "createdAt");
