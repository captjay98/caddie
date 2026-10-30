-- 3. Team build: team mode, output contracts, module builders, integration lock, looks phase, notifications
--
-- Folded 2026-10-28 from the original 58-file history (0001-0058; 0056-0058
-- were still uncommitted, so their objects live here). Mechanically generated:
-- the original files were replayed into an empty SQLite database, each object's
-- first appearance was recorded, and its FINAL definition was emitted in that
-- stage. No hand-editing -- the three table rebuilds (0024, 0035, 0044) and
-- every later ALTER are already merged into the CREATE below. Regenerate rather
-- than patch: replaying these four files yields the identical schema.

CREATE TABLE "build_spend_limits" (
  "payerId" text not null primary key,
  "limitMicros" integer not null check ("limitMicros" >= 0),
  "createdAt" text not null,
  "updatedAt" text not null
);

CREATE TABLE "build_spend_reservations" (
  "turnId" text not null primary key,
  "payerId" text not null references "build_spend_limits" ("payerId"),
  "conversationId" text not null,
  "reservedMicros" integer not null check ("reservedMicros" >= 0),
  "settledMicros" integer check ("settledMicros" >= 0),
  "status" text not null default 'reserved' check ("status" in ('reserved', 'settled', 'released')),
  "createdAt" text not null,
  "updatedAt" text not null
);

CREATE INDEX "build_spend_reservations_payer_status_idx" on "build_spend_reservations" ("payerId", "status");

CREATE INDEX "build_spend_reservations_conversation_idx" on "build_spend_reservations" ("conversationId");

CREATE TRIGGER "build_spend_reservations_limit_guard"
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

CREATE TABLE "architecture_reviews" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "blockHash" text not null,
  "round" integer not null check ("round" >= 1),
  "issues" text not null,
  "createdAt" text not null
);

CREATE INDEX "architecture_reviews_project_idx" on "architecture_reviews" ("projectId");

CREATE UNIQUE INDEX "architecture_reviews_project_block_round_idx" on "architecture_reviews" ("projectId", "blockHash", "round");

CREATE TABLE "build_modules" (
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
, "attempts" integer not null default 0 check ("attempts" >= 0), "dependsOn" text not null default '[]', "payerId" text);

CREATE INDEX "build_modules_project_seq_idx" on "build_modules" ("projectId", "buildSeq");

CREATE UNIQUE INDEX "build_modules_identity_idx" on "build_modules" ("projectId", "buildSeq", "moduleId");

CREATE TABLE "integration_locks" (
  "projectId" text not null primary key references "projects" ("id") on delete cascade,
  "holder" text not null,
  "expiresAt" text not null,
  "createdAt" text not null
);

CREATE INDEX "integration_locks_expires_idx" on "integration_locks" ("expiresAt");

CREATE TABLE "part_manifests" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "partKey" text not null,
  "manifest" text not null,
  "createdAt" text not null
);

CREATE INDEX "part_manifests_project_idx" on "part_manifests" ("projectId");

CREATE UNIQUE INDEX "part_manifests_project_part_idx" on "part_manifests" ("projectId", "partKey");

CREATE TABLE "app_test_emails" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "mode" text not null check ("mode" in ('preview', 'live')),
  "toEmail" text not null,
  "subject" text not null,
  "textBody" text not null,
  "template" text,
  "createdAt" text not null
);

CREATE INDEX "app_test_emails_project_created_idx" on "app_test_emails" ("projectId", "createdAt");

CREATE TABLE "app_job_runs" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "mode" text not null check ("mode" in ('preview', 'live')),
  "jobId" text not null,
  "status" text not null check ("status" in ('running', 'done', 'failed')),
  "summary" text,
  "startedAt" text not null,
  "finishedAt" text
);

CREATE INDEX "app_job_runs_project_job_idx" on "app_job_runs" ("projectId", "jobId");

CREATE INDEX "app_job_runs_project_started_idx" on "app_job_runs" ("projectId", "startedAt");

CREATE TABLE "platform_switches" (
  "key" text not null primary key check ("key" in ('team_mode', 'big_apps', 'app_features', 'spend_enforcement', 'publish_safety')),
  "value" text not null check ("value" in ('off', 'owner', 'on')),
  "updatedAt" text not null
);

CREATE TABLE "platform_switch_log" (
  "id" text not null primary key,
  "key" text not null,
  "oldValue" text,
  "newValue" text not null,
  "actorId" text not null,
  "createdAt" text not null
);

CREATE INDEX "platform_switch_log_key_created_idx" on "platform_switch_log" ("key", "createdAt");

CREATE TABLE "output_contract_receipts" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "outputId" text not null,
  "checks" text not null,
  "createdAt" text not null
);

CREATE INDEX "output_contract_receipts_project_idx" on "output_contract_receipts" ("projectId");

CREATE UNIQUE INDEX "output_contract_receipts_output_idx" on "output_contract_receipts" ("projectId", "outputId");

CREATE TABLE "build_module_slots" (
  "instanceId" text not null primary key,
  "buildKey" text not null,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "buildSeq" integer not null check ("buildSeq" >= 0),
  "moduleId" text not null,
  "createdAt" text not null
);

CREATE INDEX "build_module_slots_build_idx" on "build_module_slots" ("buildKey");

CREATE TRIGGER "build_module_slots_cap_guard"
before insert on "build_module_slots"
when not exists (select 1 from "build_module_slots" where "instanceId" = new."instanceId")
begin
  select raise(abort, 'module_slot_build_cap')
  where (
    select count(*) from "build_module_slots" where "buildKey" = new."buildKey"
  ) >= 4;
  select raise(abort, 'module_slot_caddie_cap')
  where (
    select count(*) from "build_module_slots"
  ) >= 8;
end;

CREATE TABLE "integration_merge_locks" (
  "projectId" text not null references "projects" ("id") on delete cascade,
  "buildSeq" integer not null check ("buildSeq" >= 0),
  "holder" text not null,
  "expiresAt" text not null,
  "createdAt" text not null,
  primary key ("projectId", "buildSeq")
);

CREATE INDEX "integration_merge_locks_expires_idx" on "integration_merge_locks" ("expiresAt");

CREATE TABLE "notification_prefs" (
  "userId" text not null references "user" ("id") on delete cascade,
  "kind" text not null,
  "email" integer not null default 0 check ("email" in (0, 1)),
  "push" integer not null default 0 check ("push" in (0, 1)),
  "updatedAt" date not null,
  primary key ("userId", "kind")
);

CREATE TABLE "push_subscriptions" (
  "id" text not null primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "endpoint" text not null unique,
  "p256dh" text not null,
  "auth" text not null,
  "createdAt" date not null,
  "lastUsedAt" date
);

CREATE INDEX "push_subscriptions_user_idx" on "push_subscriptions" ("userId");
