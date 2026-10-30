-- 2. Apps and judges: proposals, publishing, safety, secrets, sign-in, judge accounts, import previews
--
-- Folded 2026-10-28 from the original 58-file history (0001-0058; 0056-0058
-- were still uncommitted, so their objects live here). Mechanically generated:
-- the original files were replayed into an empty SQLite database, each object's
-- first appearance was recorded, and its FINAL definition was emitted in that
-- stage. No hand-editing -- the three table rebuilds (0024, 0035, 0044) and
-- every later ALTER are already merged into the CREATE below. Regenerate rather
-- than patch: replaying these four files yields the identical schema.

CREATE TABLE "github_project_repos" (
  "projectId" text not null primary key references "projects" ("id") on delete cascade,
  "installationId" text not null,
  "repoFullName" text not null,
  "visibility" text not null check ("visibility" in ('private', 'public')),
  "origin" text not null check ("origin" in ('created', 'adopted', 'connected')),
  "htmlUrl" text not null default '',
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE INDEX "github_project_repos_repo_idx" on "github_project_repos" ("repoFullName");

CREATE TABLE "discovery_digests" (
  "candidateId" text not null,
  "projectId" text not null references "projects" ("id") on delete cascade,
  -- SHA-256 of the (title + summary) the digest was grounded in; a change
  -- invalidates the cache so a re-ingested candidate re-digests.
  "contentHash" text not null,
  -- The CandidateDigest JSON ({headline, bullets, watchOut}).
  "digestJson" text not null,
  "computedAt" text not null,
  primary key ("candidateId", "projectId"),
  -- discovery_candidates' PRIMARY KEY is composite (id, projectId), so the FK
  -- must reference both columns — a row is scoped to its project.
  foreign key ("candidateId", "projectId") references "discovery_candidates" ("id", "projectId") on delete cascade
);

CREATE INDEX "discovery_digests_projectId_idx" on "discovery_digests" ("projectId");

CREATE TABLE "project_proposals" (
  "id" text primary key not null,
  "actorId" text not null,
  "workspaceId" text not null,
  -- The Home (account) project whose chat showed the proposal; accept/dismiss
  -- are authorised against this project's scope.
  "homeProjectId" text not null references "projects" ("id") on delete cascade,
  -- The Home conversation the proposal came from (the new project's intake
  -- is bound to it exactly as a chat-created project was).
  "sourceConversationId" text not null,
  "name" text not null,
  -- 1-3 plain sentences shown on the card.
  "idea" text not null,
  -- The full brief handed to planning on accept.
  "brief" text not null,
  "hackathonTitle" text,
  "hackathonUrl" text,
  "track" text,
  "firstStep" text,
  "status" text not null default 'proposed' check ("status" in ('proposed', 'accepted', 'dismissed')),
  -- Set on accept; null until then.
  "projectId" text,
  "createdAt" text not null,
  "updatedAt" text not null
, "requiredTech" text, "audience" text, "problem" text, "stackId" text not null default 'react-hono'
  check ("stackId" in ('react-hono', 'flutter')));

CREATE INDEX "project_proposals_home_idx" on "project_proposals" ("homeProjectId", "createdAt");

CREATE TABLE "build_activity" (
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
, "contentHash" text);

CREATE INDEX "build_activity_run_idx" on "build_activity" ("runId", "startedAt");

CREATE TABLE "build_features" (
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

CREATE INDEX "build_features_plan_idx" on "build_features" ("projectId", "planId", "position");

CREATE TABLE "build_sandbox_sessions" (
  "projectId" text primary key not null references "projects" ("id") on delete cascade,
  "runId" text not null,
  "sessionKey" text not null,
  -- The image a NEW session with this key starts from (a feature save point).
  "image" text not null,
  "reason" text not null,
  "updatedAt" text not null
);

CREATE TABLE "github_source_saves" (
  "id" text not null primary key,
  "operationKey" text not null unique,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "outputId" text not null,
  "repoFullName" text not null,
  "headBranch" text not null,
  "pullRequestNumber" integer,
  "manifestJson" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null
);

CREATE INDEX "github_source_saves_project_idx" on "github_source_saves" ("projectId", "repoFullName", "createdAt");

CREATE TABLE "code_versions" (
  "projectId" text not null references "projects" ("id") on delete cascade,
  "commitId" text not null,
  "seq" integer not null,
  "kind" text not null check ("kind" in ('feature', 'build', 'restore', 'import')),
  -- Plain-words label shown in the Versions list.
  "title" text not null,
  "store" text not null check ("store" in ('artifacts', 'local')),
  "featureId" text,
  "planId" text,
  "image" text,
  "outputId" text,
  "fileCount" integer not null,
  "totalBytes" integer not null,
  -- sha256 over the sorted (path, file sha256) list: equal digests = identical code.
  "digest" text not null,
  -- JSON [{path, reason}] of what the snapshot left out (dependencies, build output, secrets).
  "skipped" text not null default '[]',
  "createdBy" text not null,
  "createdAt" text not null,
  primary key ("projectId", "commitId")
);

CREATE UNIQUE INDEX "code_versions_seq_idx" on "code_versions" ("projectId", "seq");

CREATE TABLE "local_code_commits" (
  "repo" text not null,
  "id" text not null,
  "parentId" text,
  "message" text not null,
  "authorName" text not null,
  "authorEmail" text not null,
  -- JSON [{path, size, sha256}] sorted by path: the complete snapshot.
  "tree" text not null,
  "createdAt" text not null,
  primary key ("repo", "id")
);

CREATE TABLE "local_code_heads" (
  "repo" text primary key not null,
  "head" text,
  "updatedAt" text not null
);

CREATE TABLE "app_secrets" (
  "projectId" text not null references "projects" ("id") on delete cascade,
  "name" text not null,
  "status" text not null check ("status" in ('requested', 'set')),
  "envelope" text,
  "keyId" text,
  "description" text,
  "helpUrl" text,
  "requestedBy" text,
  "updatedBy" text,
  "createdAt" text not null,
  "updatedAt" text not null,
  primary key ("projectId", "name"),
  check (("status" = 'requested' and "envelope" is null and "keyId" is null)
      or ("status" = 'set' and "envelope" is not null and "keyId" is not null))
);

CREATE INDEX "app_secrets_key_idx" on "app_secrets" ("keyId");

CREATE TABLE "app_publications" (
  "projectId" text not null primary key references "projects" ("id") on delete cascade,
  "slug" text not null unique,
  "script" text not null unique,
  "databaseId" text,
  "status" text not null check ("status" in ('live', 'paused', 'blocked')),
  "outputId" text,
  "manifestSha256" text,
  "hasServer" integer not null default 0,
  "appliedMigrations" text not null default '{}',
  "publishedBy" text,
  "publishedAt" text,
  "createdAt" text not null,
  "updatedAt" text not null
, "candidateScript" text, "candidateOutputId" text, "candidateManifestSha256" text, "checkedAt" text, "blockedReason" text, "blockedBy" text, "blockedAt" text);

CREATE TABLE "app_publish_runs" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "kind" text not null check ("kind" in ('publish', 'unpublish', 'rollback')),
  "outputId" text,
  "manifestSha256" text,
  "status" text not null check ("status" in ('running', 'succeeded', 'failed')),
  "steps" text not null default '[]',
  "error" text,
  "approvalId" text,
  "actorId" text not null,
  "startedAt" text not null,
  "finishedAt" text
);

CREATE INDEX "app_publish_runs_project_idx" on "app_publish_runs" ("projectId", "startedAt");

CREATE UNIQUE INDEX "app_publish_runs_one_running" on "app_publish_runs" ("projectId") where "status" = 'running';

CREATE TABLE "app_domains" (
  "hostname" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "customHostnameId" text,
  "status" text not null,
  "sslStatus" text,
  "lastCheckedAt" text,
  "createdAt" text not null,
  "updatedAt" text not null
);

CREATE INDEX "app_domains_project_idx" on "app_domains" ("projectId");

CREATE TABLE "app_safety_checks" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "kind" text not null check ("kind" in ('url-scan', 'web-risk')),
  "manifestSha256" text,
  "script" text,
  "url" text not null,
  "scanId" text,
  "runId" text,
  "status" text not null check ("status" in ('pending', 'clean', 'flagged', 'error')),
  "categories" text not null default '[]',
  "reportUrl" text,
  "detail" text,
  "createdAt" text not null,
  "finishedAt" text
);

CREATE INDEX "app_safety_checks_pending_idx" on "app_safety_checks" ("status", "createdAt");

CREATE INDEX "app_safety_checks_project_idx" on "app_safety_checks" ("projectId", "kind", "manifestSha256");

CREATE TABLE "abuse_reports" (
  "id" text not null primary key,
  "slug" text not null,
  "projectId" text references "projects" ("id") on delete set null,
  "source" text not null check ("source" in ('visitor', 'url-scan', 'web-risk', 'operator')),
  "category" text not null check ("category" in ('phishing', 'malware', 'scam', 'illegal', 'other')),
  "details" text not null,
  "reporterEmail" text,
  "reporterHash" text,
  "status" text not null default 'open' check ("status" in ('open', 'actioned', 'dismissed')),
  "notified" integer not null default 0,
  "createdAt" text not null,
  "resolvedAt" text,
  "resolvedBy" text,
  "resolution" text
);

CREATE INDEX "abuse_reports_status_idx" on "abuse_reports" ("status", "createdAt");

CREATE INDEX "abuse_reports_reporter_idx" on "abuse_reports" ("reporterHash", "createdAt");

CREATE TABLE "app_ai_usage" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "mode" text not null check ("mode" in ('preview', 'live')),
  -- UTC calendar month the call counts toward, e.g. '2026-10'.
  "month" text not null,
  "status" text not null check ("status" in ('reserved', 'settled', 'failed')),
  "routeId" text not null,
  "reservedMicros" integer not null check ("reservedMicros" >= 0),
  "costMicros" integer not null default 0 check ("costMicros" >= 0),
  "inputTokens" integer,
  "outputTokens" integer,
  -- Plain reason for a failed call (busy, timeout, provider error) — never prompt text.
  "outcome" text,
  "createdAt" text not null,
  "updatedAt" text not null
);

CREATE INDEX "app_ai_usage_project_month_idx" on "app_ai_usage" ("projectId", "month");

CREATE INDEX "app_ai_usage_project_created_idx" on "app_ai_usage" ("projectId", "createdAt");

CREATE TABLE "app_sign_in_emails" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "mode" text not null check ("mode" in ('preview', 'live')),
  "recipientHash" text not null,
  "status" text not null check ("status" in ('inbox', 'sent', 'failed')),
  "createdAt" text not null
);

CREATE INDEX "app_sign_in_emails_project_idx" on "app_sign_in_emails" ("projectId", "createdAt");

CREATE INDEX "app_sign_in_emails_recipient_idx" on "app_sign_in_emails" ("projectId", "recipientHash", "createdAt");

CREATE TABLE "app_test_inbox" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "toEmail" text not null,
  "code" text not null,
  "createdAt" text not null
);

CREATE INDEX "app_test_inbox_project_idx" on "app_test_inbox" ("projectId", "createdAt");

CREATE TABLE "import_previews" (
  "projectId" text primary key references "projects" ("id") on delete cascade,
  "actorId" text not null references "user" ("id"),
  "commitId" text not null,
  "versionSeq" integer not null,
  "repoFullName" text not null,
  "status" text not null check ("status" in ('checking', 'ready', 'failed')),
  "outputId" text,
  "hasServer" integer not null default 0,
  "message" text,
  "detail" text,
  "errors" integer not null default 0,
  "createdAt" text not null,
  "updatedAt" text not null
);

CREATE INDEX "import_previews_status" on "import_previews" ("status", "updatedAt");

CREATE TABLE "judge_accounts" (
  "judgeName" text not null primary key,
  -- Null until the user exists. Set together with the flip to 'active'.
  "userId" text references "user" ("id") on delete cascade,
  "state" text not null default 'active' check ("state" in ('starting', 'active')),
  "createdAt" text not null,
  "lastSignInAt" text
);

CREATE UNIQUE INDEX "judge_accounts_user" on "judge_accounts" ("userId");

CREATE INDEX "judge_accounts_starting" on "judge_accounts" ("state", "createdAt");

CREATE TABLE "judge_access_attempts" (
  "id" text not null primary key,
  "action" text not null check ("action" in ('start', 'sign_in')),
  "ipHash" text not null,
  "createdAt" text not null
);

CREATE INDEX "judge_access_attempts_ip" on "judge_access_attempts" ("ipHash", "createdAt");

CREATE INDEX "judge_access_attempts_created" on "judge_access_attempts" ("createdAt");

CREATE TABLE "judge_usage_events" (
  "id" text not null primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "kind" text not null check ("kind" in ('build', 'message', 'discovery')),
  "createdAt" text not null
);

CREATE INDEX "judge_usage_events_user_kind" on "judge_usage_events" ("userId", "kind", "createdAt");

CREATE TABLE "large_content" (
  "sha256" text not null primary key,
  "bytes" integer not null check ("bytes" > 0 and "bytes" <= 67108864),
  "chunks" integer not null check ("chunks" >= 1),
  "createdAt" text not null
);

CREATE TABLE "large_content_chunks" (
  "sha256" text not null,
  "idx" integer not null check ("idx" >= 0),
  "bytes" blob not null,
  primary key ("sha256", "idx")
);
