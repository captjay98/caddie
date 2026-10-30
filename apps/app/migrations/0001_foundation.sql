-- 1. Foundation: product, controls, artifacts, evidence, runs, schedules, profile, discovery, judge, build workflow
--
-- Folded 2026-10-28 from the original 58-file history (0001-0058; 0056-0058
-- were still uncommitted, so their objects live here). Mechanically generated:
-- the original files were replayed into an empty SQLite database, each object's
-- first appearance was recorded, and its FINAL definition was emitted in that
-- stage. No hand-editing -- the three table rebuilds (0024, 0035, 0044) and
-- every later ALTER are already merged into the CREATE below. Regenerate rather
-- than patch: replaying these four files yields the identical schema.

CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

CREATE INDEX "session_userId_idx" on "session" ("userId");

CREATE INDEX "account_userId_idx" on "account" ("userId");

CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");

CREATE TABLE "workspaces" ("id" text not null primary key, "name" text not null, "createdAt" date not null);

CREATE TABLE "workspace_memberships" ("id" text not null primary key, "workspaceId" text not null references "workspaces" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);

CREATE TABLE "projects" ("id" text not null primary key, "workspaceId" text not null references "workspaces" ("id") on delete cascade, "name" text not null, "description" text, "contestId" text, "contestUrl" text, "status" text not null default 'active' check ("status" in ('active', 'archived')), "createdAt" date not null, "updatedAt" date not null, "kind" text not null default 'standard' check ("kind" in ('standard', 'home')));

CREATE TABLE "project_repo_bindings" ("id" text not null primary key, "projectId" text not null references "projects" ("id") on delete cascade, "provider" text not null, "owner" text not null, "repo" text not null, "defaultBranch" text, "createdAt" date not null);

CREATE TABLE "plan_doc_revisions" ("id" text not null primary key, "projectId" text not null references "projects" ("id") on delete cascade, "kind" text not null, "revision" integer not null, "bodyHash" text not null, "body" text not null, "createdBy" text not null references "user" ("id"), "createdAt" date not null);

CREATE TABLE "run_bindings" ("runId" text not null primary key, "projectId" text not null references "projects" ("id") on delete cascade, "conversationId" text not null, "submissionId" text not null, "planRevision" text not null, "stackId" text not null check ("stackId" in ('react-hono', 'tanstack-start', 'laravel-inertia', 'fastapi-react', 'flutter')), "payerId" text not null, "modelRouteId" text not null, "pricingVersion" text not null, "createdBy" text not null references "user" ("id"), "createdAt" date not null);

CREATE TABLE "artifact_revisions" ("id" text not null primary key, "projectId" text not null references "projects" ("id") on delete cascade, "artifactId" text not null, "kind" text not null, "revision" integer not null, "metadataHash" text not null, "metadata" text not null, "createdBy" text not null references "user" ("id"), "createdAt" date not null);

CREATE UNIQUE INDEX "workspace_memberships_workspace_user_idx" on "workspace_memberships" ("workspaceId", "userId");

CREATE INDEX "workspace_memberships_userId_idx" on "workspace_memberships" ("userId");

CREATE INDEX "projects_workspaceId_idx" on "projects" ("workspaceId");

CREATE UNIQUE INDEX "project_repo_bindings_projectId_idx" on "project_repo_bindings" ("projectId");

CREATE UNIQUE INDEX "plan_doc_revisions_project_kind_revision_idx" on "plan_doc_revisions" ("projectId", "kind", "revision");

CREATE INDEX "run_bindings_projectId_idx" on "run_bindings" ("projectId");

CREATE UNIQUE INDEX "artifact_revisions_project_artifact_revision_idx" on "artifact_revisions" ("projectId", "artifactId", "revision");

CREATE TABLE "approvals" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "action" text not null check ("action" in ('design', 'feature-review', 'deploy-production', 'destructive-database-change', 'merge-default-branch')),
  "resourceId" text not null,
  "revisionHash" text not null,
  "policyVersion" text not null,
  "intentHash" text not null,
  "decidedBy" text,
  "status" text not null default 'pending' check ("status" in ('pending', 'approved', 'rejected', 'revoked', 'expired', 'superseded')),
  "expiresAt" date not null,
  "createdAt" date not null,
  "decidedAt" date
);

CREATE UNIQUE INDEX "approvals_pending_intent_idx" on "approvals" ("intentHash") where "status" = 'pending';

CREATE INDEX "approvals_intent_project_idx" on "approvals" ("intentHash", "projectId");

CREATE INDEX "approvals_projectId_idx" on "approvals" ("projectId");

CREATE INDEX "approvals_intent_fields_idx" on "approvals" ("action", "resourceId", "revisionHash", "policyVersion");

CREATE TABLE "external_operations" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "runId" text not null,
  "operationKey" text not null unique,
  "provider" text not null,
  "remoteId" text,
  "status" text not null default 'prepared' check ("status" in ('prepared', 'dispatched', 'succeeded', 'failed', 'cancel-requested', 'cancelled', 'reconciliation-required')),
  "receiptId" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE INDEX "external_operations_projectId_idx" on "external_operations" ("projectId");

CREATE INDEX "external_operations_runId_idx" on "external_operations" ("runId");

CREATE INDEX "external_operations_provider_key_idx" on "external_operations" ("provider", "operationKey");

CREATE TABLE "budget_payers" (
  "payerId" text not null primary key,
  "limitMinorUnits" integer not null check ("limitMinorUnits" >= 0),
  "currency" text not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE TABLE "budget_pricing" (
  "modelRouteId" text not null,
  "pricingVersion" text not null,
  "unitPriceMinorUnits" integer not null check ("unitPriceMinorUnits" >= 0),
  "currency" text not null,
  "createdAt" date not null,
  primary key ("modelRouteId", "pricingVersion")
);

CREATE TABLE "budget_reservations" (
  "id" text not null primary key,
  "payerId" text not null references "budget_payers" ("payerId"),
  "reservationKey" text not null unique,
  "amountMinorUnits" integer not null check ("amountMinorUnits" > 0),
  "settledAmountMinorUnits" integer check ("settledAmountMinorUnits" >= 0),
  "status" text not null default 'reserved' check ("status" in ('reserved', 'settled', 'released')),
  "runId" text,
  "modelRouteId" text not null,
  "pricingVersion" text not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE INDEX "budget_reservations_payer_status_idx" on "budget_reservations" ("payerId", "status");

CREATE INDEX "budget_reservations_runId_idx" on "budget_reservations" ("runId");

CREATE TRIGGER "budget_reservations_cap_guard"
before insert on "budget_reservations"
when new."status" = 'reserved'
begin
  select raise(abort, 'budget_exceeded')
  where (
    select coalesce(sum("amountMinorUnits"), 0)
    from "budget_reservations"
    where "payerId" = new."payerId" and "status" = 'reserved'
  ) + new."amountMinorUnits"
  > (select "limitMinorUnits" from "budget_payers" where "payerId" = new."payerId");
end;

CREATE TABLE "credential_handles" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "provider" text not null,
  "fingerprint" text not null,
  "envelope" text not null,
  "createdAt" date not null
);

CREATE UNIQUE INDEX "credential_handles_identity_idx" on "credential_handles" ("projectId", "provider", "fingerprint");

CREATE TABLE "artifact_content" (
  "contentHash" text not null primary key,
  "bytes" blob not null,
  "size" integer not null check ("size" >= 0 and "size" <= 5242880),
  "createdAt" date not null
);

CREATE TABLE "project_artifacts" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "kind" text not null check ("kind" in ('plan', 'test-result', 'browser-capture', 'diff')),
  "planRevision" integer not null check ("planRevision" >= 1),
  "sha256" text not null references "artifact_content" ("contentHash"),
  "size" integer not null check ("size" >= 0),
  "contentType" text not null,
  "filename" text not null,
  "status" text not null default 'current' check ("status" in ('current', 'stale')),
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null
);

CREATE INDEX "project_artifacts_project_idx" on "project_artifacts" ("projectId", "createdAt");

CREATE INDEX "project_artifacts_project_kind_idx" on "project_artifacts" ("projectId", "kind", "planRevision");

CREATE INDEX "project_artifacts_project_stale_idx" on "project_artifacts" ("projectId", "status", "planRevision");

CREATE TABLE "preview_tokens" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "revisionId" text not null references "project_artifacts" ("id") on delete cascade,
  "tokenHash" text not null unique,
  "createdBy" text not null,
  "expiresAt" date not null,
  "revokedAt" date,
  "createdAt" date not null
);

CREATE INDEX "preview_tokens_project_idx" on "preview_tokens" ("projectId");

CREATE INDEX "preview_tokens_revision_idx" on "preview_tokens" ("revisionId");

CREATE TABLE "preview_access_log" (
  "id" text not null primary key,
  "tokenId" text not null,
  "projectId" text,
  "path" text not null,
  "outcome" text not null check ("outcome" in ('served', 'denied', 'gone')),
  "at" date not null
);

CREATE INDEX "preview_access_log_token_idx" on "preview_access_log" ("tokenId", "at");

CREATE INDEX "preview_access_log_project_idx" on "preview_access_log" ("projectId");

CREATE TABLE "evidence_sources" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "canonicalUrl" text not null,
  "kind" text not null check ("kind" in ('page', 'document', 'repository', 'message', 'other')),
  "authority" text not null check ("authority" in ('binding_rules', 'organizer_message', 'official_faq', 'official_overview', 'sponsor_page', 'community', 'unknown')),
  "displayName" text,
  "latestSnapshotId" text,
  "latestContentHash" text,
  "lastOutcome" text not null default 'never_fetched' check ("lastOutcome" in ('never_fetched', 'succeeded', 'unchanged', 'failed', 'blocked')),
  "lastFailureReason" text,
  "observedAt" date,
  "attemptedAt" date,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE UNIQUE INDEX "evidence_sources_project_url_idx" on "evidence_sources" ("projectId", "canonicalUrl");

CREATE INDEX "evidence_sources_projectId_idx" on "evidence_sources" ("projectId");

CREATE TABLE "evidence_snapshots" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "sourceId" text not null references "evidence_sources" ("id") on delete cascade,
  "contentHash" text not null,
  "mediaType" text not null,
  "byteLength" integer not null,
  "content" text not null,
  "originalUrl" text not null default '',
  "provenance" text not null default 'original' check ("provenance" in ('original', 'processed')),
  "renderer" text,
  "rendererRef" text,
  "capturedAt" date not null,
  "capturedBy" text not null,
  check ("byteLength" >= 0),
  check ("provenance" <> 'processed' or ("renderer" is not null and trim("renderer") <> ''))
);

CREATE UNIQUE INDEX "evidence_snapshots_source_hash_idx" on "evidence_snapshots" ("sourceId", "contentHash");

CREATE INDEX "evidence_snapshots_projectId_idx" on "evidence_snapshots" ("projectId");

CREATE INDEX "evidence_snapshots_sourceId_idx" on "evidence_snapshots" ("sourceId");

CREATE TABLE "evidence_claims" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "sourceId" text not null references "evidence_sources" ("id") on delete cascade,
  "snapshotId" text not null references "evidence_snapshots" ("id") on delete cascade,
  "claimType" text not null,
  "value" text not null,
  "quote" text not null,
  "locator" text,
  "extractionVersion" text not null,
  "confidence" real,
  "status" text not null default 'active' check ("status" in ('active', 'superseded')),
  "supersededBy" text references "evidence_claims" ("id"),
  "snapshotCapturedAt" date not null,
  "createdAt" date not null,
  check ("confidence" is null or ("confidence" >= 0 and "confidence" <= 1))
);

CREATE INDEX "evidence_claims_project_type_idx" on "evidence_claims" ("projectId", "claimType");

CREATE INDEX "evidence_claims_source_type_idx" on "evidence_claims" ("sourceId", "claimType", "status");

CREATE INDEX "evidence_claims_snapshotId_idx" on "evidence_claims" ("snapshotId");

CREATE TABLE "run_rounds" (
	"id" text not null primary key,
	"runId" text not null,
	"projectId" text not null,
	"issue" text not null,
	"round" text not null check ("round" in ('diagnosis','repair_attempt','verification','transport_retry','framework_recovery')),
	"outcome" text not null check ("outcome" in ('started','succeeded','failed')),
	"detail" text,
	"createdAt" text not null
);

CREATE INDEX "run_rounds_run_issue_idx" on "run_rounds" ("runId", "issue", "round");

CREATE INDEX "run_rounds_project_idx" on "run_rounds" ("projectId");

CREATE TABLE "run_verifications" (
	"id" text not null primary key,
	"runId" text not null,
	"projectId" text not null,
	"check" text not null,
	"passed" integer not null,
	"evidence" text not null,
	"planRevision" text not null,
	"recordedBy" text not null,
	"createdAt" text not null
);

CREATE INDEX "run_verifications_run_idx" on "run_verifications" ("runId", "createdAt");

CREATE TABLE "run_checkpoints" (
	"runId" text not null primary key,
	"projectId" text not null,
	"planRevision" text not null,
	"evidenceIds" text not null,
	"sha256" text not null,
	"createdAt" text not null
);

CREATE TABLE "github_installations" (
  "id" text not null primary key,
  "installationId" text not null unique,
  "accountLogin" text not null,
  "appSlug" text not null default '',
  "permissionsJson" text not null default '{}',
  "workspaceId" text references "workspaces" ("id") on delete cascade,
  "boundBy" text references "user" ("id"),
  "status" text not null default 'active' check ("status" in ('active', 'revoked', 'suspended')),
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE INDEX "github_installations_workspace_idx" on "github_installations" ("workspaceId");

CREATE TABLE "github_repo_selections" (
  "id" text not null primary key,
  "installationId" text not null references "github_installations" ("installationId") on delete cascade,
  "repoFullName" text not null,
  "status" text not null default 'selected' check ("status" in ('selected', 'deselected')),
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE UNIQUE INDEX "github_repo_selections_unique" on "github_repo_selections" ("installationId", "repoFullName");

CREATE INDEX "github_repo_selections_repo_idx" on "github_repo_selections" ("repoFullName");

CREATE TABLE "github_webhook_deliveries" (
  "deliveryId" text not null primary key,
  "event" text not null,
  "receivedAt" date not null
);

CREATE TABLE "github_imports" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "installationId" text not null,
  "repoFullName" text not null,
  "ref" text not null,
  "commitSha" text not null,
  "rootPath" text not null default '',
  "fileCount" integer not null,
  "totalBytes" integer not null,
  "manifestJson" text not null,
  "skippedJson" text not null default '[]',
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null
);

CREATE INDEX "github_imports_project_idx" on "github_imports" ("projectId");

CREATE TABLE "content_blobs" (
  "hash" text not null primary key,
  "bytes" blob not null,
  "size" integer not null,
  "createdAt" date not null
);

CREATE TABLE "github_deliveries" (
  "id" text not null primary key,
  "operationKey" text not null unique,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "installationId" text not null,
  "repoFullName" text not null,
  "baseBranch" text not null,
  "headBranch" text not null,
  "mode" text not null check ("mode" in ('pull-request', 'merge-default-branch')),
  "contentHash" text not null,
  "pullRequestNumber" integer,
  "headSha" text,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE INDEX "github_deliveries_project_idx" on "github_deliveries" ("projectId");

CREATE INDEX "github_deliveries_branch_idx" on "github_deliveries" ("repoFullName", "headBranch");

CREATE TABLE "tasks" (
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

CREATE INDEX "tasks_project_status_idx" on "tasks" ("projectId", "status");

CREATE INDEX "tasks_project_due_idx" on "tasks" ("projectId", "dueAt");

CREATE TABLE "schedules" (
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

CREATE INDEX "schedules_project_idx" on "schedules" ("projectId");

CREATE INDEX "schedules_due_idx" on "schedules" ("paused", "nextRunAt");

CREATE TABLE "schedule_occurrences" (
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

CREATE UNIQUE INDEX "schedule_occurrences_schedule_key_idx" on "schedule_occurrences" ("scheduleId", "occurrenceKey");

CREATE INDEX "schedule_occurrences_project_idx" on "schedule_occurrences" ("projectId");

CREATE TABLE "sentinel_results" (
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

CREATE INDEX "sentinel_results_project_source_idx" on "sentinel_results" ("projectId", "sourceId", "createdAt");

CREATE TABLE "notifications" (
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

CREATE UNIQUE INDEX "notifications_dedupe_idx" on "notifications" ("dedupeKey");

CREATE INDEX "notifications_user_idx" on "notifications" ("userId", "createdAt");

CREATE TABLE "notification_deliveries" (
  "id" text not null primary key,
  "notificationId" text not null references "notifications" ("id") on delete cascade,
  "channel" text not null default 'email',
  "status" text not null check ("status" in ('sent', 'failed')),
  "error" text,
  "attempts" integer not null default 1 check ("attempts" >= 1),
  "createdAt" date not null
);

CREATE INDEX "notification_deliveries_status_idx" on "notification_deliveries" ("status", "createdAt");

CREATE TABLE "user_profiles" (
	"userId" text not null primary key references "user" ("id") on delete cascade,
	"country" text,
	"timezone" text,
	"weeklyHours" integer,
	"experienceLevel" text check ("experienceLevel" in ('beginner', 'intermediate', 'senior')),
	"stackIds" text not null default '[]',
	"freeTextInterests" text not null default '[]',
	"createdAt" date not null,
	"updatedAt" date not null
, "formatPreference" text check ("formatPreference" in ('online', 'in_person', 'either')), "skills" text not null default '[]', "projectHighlight" text, "budgetMode" text check ("budgetMode" in ('free_only', 'set', 'not_sure')), "budgetAmount" integer, "budgetCurrency" text);

CREATE TABLE "memory_facts" (
	"id" text not null primary key,
	"userId" text not null references "user" ("id") on delete cascade,
	"projectId" text references "projects" ("id") on delete cascade,
	"kind" text not null check ("kind" in ('preference', 'fact', 'correction')),
	"content" text not null,
	"status" text not null check ("status" in ('proposed', 'confirmed', 'retracted')),
	"sourceRunId" text,
	"correctsId" text references "memory_facts" ("id"),
	"createdAt" date not null,
	"updatedAt" date not null
);

CREATE INDEX "memory_facts_userId_idx" on "memory_facts" ("userId");

CREATE INDEX "memory_facts_projectId_idx" on "memory_facts" ("projectId");

CREATE INDEX "memory_facts_user_status_idx" on "memory_facts" ("userId", "status");

CREATE TABLE "discovery_seed_candidates" (
  "id" text not null primary key,
  "source" text not null,
  "url" text not null,
  "title" text not null,
  "summary" text not null,
  "publishedAt" date,
  "requirementsJson" text not null default '[]',
  "createdAt" date not null
);

CREATE UNIQUE INDEX "discovery_seed_source_url_idx" on "discovery_seed_candidates" ("source", "url");

CREATE TABLE "discovery_feed_runs" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "requestedBy" text not null references "user" ("id"),
  "requestedAt" date not null,
  "candidateCount" integer not null default 0
);

CREATE INDEX "discovery_feed_runs_projectId_idx" on "discovery_feed_runs" ("projectId");

CREATE TABLE "discovery_feed_sources" (
  "id" text not null primary key,
  "feedRunId" text not null references "discovery_feed_runs" ("id") on delete cascade,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "source" text not null,
  "outcome" text not null check ("outcome" in ('succeeded', 'failed')),
  "failureReason" text,
  "candidateCount" integer not null default 0,
  "completedAt" date not null,
  check ("outcome" <> 'failed' or ("failureReason" is not null and trim("failureReason") <> ''))
);

CREATE INDEX "discovery_feed_sources_feedRunId_idx" on "discovery_feed_sources" ("feedRunId");

CREATE INDEX "discovery_feed_sources_projectId_idx" on "discovery_feed_sources" ("projectId");

CREATE TABLE "discovery_candidates" (
  -- cand_<sha256(source ++ canonicalUrl)> — the deterministic identity. The
  -- PRIMARY KEY is (id, projectId): the derived id is a property of the
  -- candidate's (source, URL), but rows are project-scoped — the same
  -- real-world candidate can be ingested independently into many projects.
  "id" text not null,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "source" text not null,
  "url" text not null,
  "title" text not null,
  "summary" text not null,
  "publishedAt" date,
  "requirementsJson" text not null default '[]',
  "status" text not null default 'new' check ("status" in ('new', 'accepted', 'dismissed')),
  "feedRunId" text not null references "discovery_feed_runs" ("id") on delete cascade,
  "firstSeenAt" date not null,
  "updatedAt" date not null, "savedAt" text,
  primary key ("id", "projectId")
);

CREATE UNIQUE INDEX "discovery_candidates_project_source_url_idx" on "discovery_candidates" ("projectId", "source", "url");

CREATE INDEX "discovery_candidates_projectId_idx" on "discovery_candidates" ("projectId");

CREATE TABLE "planning_milestones" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "title" text not null,
  "dueDate" text,
  "dueUtc" text,
  "hasTime" integer not null default 0,
  "dueStatus" text not null check ("dueStatus" in ('resolved', 'date_only', 'ambiguous', 'none')),
  "dueNote" text,
  "deadlineClaimId" text references "evidence_claims" ("id"),
  "createdAt" date not null
);

CREATE UNIQUE INDEX "planning_milestones_project_title_due_idx" on "planning_milestones" ("projectId", "title", ifnull("dueDate", ''));

CREATE INDEX "planning_milestones_projectId_idx" on "planning_milestones" ("projectId");

CREATE TABLE "planning_revision_provenance" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "kind" text not null,
  "planRevisionId" text not null references "plan_doc_revisions" ("id") on delete cascade,
  "origin" text not null check ("origin" in ('planning', 'user')),
  "createdAt" date not null
);

CREATE UNIQUE INDEX "planning_revision_provenance_revision_idx" on "planning_revision_provenance" ("planRevisionId");

CREATE INDEX "planning_revision_provenance_project_kind_idx" on "planning_revision_provenance" ("projectId", "kind");

CREATE TABLE "judge_scorecards" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "rubricHash" text not null,
  "rubricJson" text not null,
  "resultJson" text not null,
  "scoringVersion" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null
);

CREATE INDEX "judge_scorecards_projectId_idx" on "judge_scorecards" ("projectId", "createdAt");

CREATE TABLE "submission_packages" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "title" text not null,
  "descriptionJson" text not null,
  "reuseRequired" integer not null check ("reuseRequired" in (0, 1)),
  "reuseState" text not null default 'unconfirmed' check ("reuseState" in ('unconfirmed', 'confirmed')),
  "reuseConfirmedBy" text references "user" ("id"),
  "reuseConfirmedAt" date,
  "requirementsVersion" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null,
  check ("reuseState" <> 'confirmed' or ("reuseConfirmedBy" is not null and "reuseConfirmedAt" is not null))
);

CREATE INDEX "submission_packages_projectId_idx" on "submission_packages" ("projectId", "createdAt");

CREATE TABLE "submission_checklist_items" (
  "id" text not null primary key,
  "packageId" text not null references "submission_packages" ("id") on delete cascade,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "kind" text not null check ("kind" in ('video', 'repository', 'license', 'description', 'host_proof', 'reuse_disclosure', 'other')),
  "requirementText" text not null,
  "citationClaimId" text not null references "evidence_claims" ("id"),
  "citationQuote" text not null,
  "citationUrl" text not null,
  "status" text not null check ("status" in ('missing', 'declared', 'verified', 'conflict')),
  "evidenceJson" text not null default '[]',
  "createdAt" date not null
);

CREATE INDEX "submission_checklist_items_packageId_idx" on "submission_checklist_items" ("packageId");

CREATE INDEX "submission_checklist_items_projectId_idx" on "submission_checklist_items" ("projectId");

CREATE TABLE "submission_exports" (
  "id" text not null primary key,
  "packageId" text not null references "submission_packages" ("id") on delete cascade,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "exportHash" text not null,
  "requirementsVersion" text not null,
  "packageJson" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null
);

CREATE INDEX "submission_exports_projectId_idx" on "submission_exports" ("projectId", "createdAt");

CREATE INDEX "submission_exports_packageId_idx" on "submission_exports" ("packageId");

CREATE TABLE "submission_confirmations" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "exportId" text not null references "submission_exports" ("id"),
  "exportHash" text not null,
  "attestationsJson" text not null,
  "note" text,
  "confirmedBy" text not null references "user" ("id"),
  "confirmedAt" date not null
);

CREATE INDEX "submission_confirmations_projectId_idx" on "submission_confirmations" ("projectId");

CREATE UNIQUE INDEX "projects_home_per_workspace_idx" on "projects" ("workspaceId") where "kind" = 'home';

CREATE TABLE "brief_read_state" (
	"actorId" text not null,
	"cardKey" text not null,
	"seenAt" text not null,
	primary key ("actorId", "cardKey")
);

CREATE TABLE "stack_notify_subscriptions" (
	"actorId" text not null,
	"stackId" text not null,
	"createdAt" text not null,
	primary key ("actorId", "stackId")
);

CREATE TABLE "plan_decisions" (
	"id" text not null primary key,
	"projectId" text not null references "projects" ("id") on delete cascade,
	"planRevisionId" text not null,
	"decision" text not null check ("decision" in ('approved', 'changes')),
	"note" text,
	"approvalId" text,
	"decidedBy" text not null references "user" ("id"),
	"createdAt" text not null
);

CREATE INDEX "plan_decisions_project_revision_idx" on "plan_decisions" ("projectId", "planRevisionId", "createdAt");

CREATE TABLE user_onboarding (
 userId TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 completedAt TEXT NOT NULL
);

CREATE TABLE workflow_outputs (
 id text primary key, projectId text not null references projects(id),
 runId text not null, planId text not null, image text not null,
 sha256 text not null references artifact_content(contentHash), createdAt text not null
, "manifestSha256" text, "apkSha256" text, "apkBytes" integer
  check ("apkBytes" is null or "apkBytes" > 0));

CREATE TABLE sandbox_bindings (
 key text primary key, kind text not null, sessionId text, projectId text,
 runId text, recordJson text not null, updatedAt text not null
);

CREATE INDEX sandbox_bindings_session on sandbox_bindings(sessionId,kind);

CREATE TABLE workflow_resumes (
 id text primary key, projectId text not null references projects(id),
 runId text not null, actorId text not null references user(id),
 afterRoundRowId integer not null, createdAt text not null
);

CREATE INDEX workflow_resumes_run on workflow_resumes(runId);

CREATE TABLE "build_workflows" (
 projectId text primary key references projects(id), runId text not null,
 conversationId text not null, sourceConversationId text,
 intakeKey text unique not null, brief text not null,
 phase text not null check(phase in ('planning','review','looks','looks-review','design','design-review','building','blocked','ready')),
 planId text, previewId text, pendingKey text, pendingBody text,
 detail text, updatedAt text not null,
 teamMode integer not null default 0 check (teamMode in (0, 1)),
 bigApps integer not null default 0 check (bigApps in (0, 1)),
 appFeatures integer not null default 0 check (appFeatures in (0, 1)),
 spendPayerId text,
 approvedDesignRevisionId text,
 looksBaseline integer,
 designBaseline integer
, "repairPolicyVersion" text);

CREATE INDEX build_workflows_source on build_workflows(sourceConversationId);
