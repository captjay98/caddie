-- 0006_github.sql — P08 GitHub App import and receipt-backed delivery
-- (feature-ledger C17 + H6). Additive only; SQLite dialect for D1.
--
-- Owns:
--   github_installations      installation records bound to workspaces by
--                             EXPLICIT user action; status flips to revoked on
--                             the installation.deleted webhook — after that all
--                             operations for the installation fail closed.
--   github_repo_selections    the binding set maintained by
--                             installation_repositories events; only selected
--                             repos may be imported or delivered to.
--   github_webhook_deliveries delivery-GUID dedupe: a replayed webhook is
--                             acknowledged but never re-processed (durable
--                             replacement for the in-process cache of the
--                             HackSteward reference).
--   github_imports            import records (repo, ref, root, manifest with
--                             hashes, skipped submodules, size/count caps).
--   content_blobs             minimal content-addressed store (sha256 ->
--                             bytes); P07 has not landed, so this packet
--                             provides the pattern locally.
--   github_deliveries         delivery metadata keyed by the P03 operations
--                             ledger's unique operationKey: branch, PR number,
--                             and the last recorded head commit used for the
--                             divergence check (never force-push, never
--                             overwrite).
--
-- Every per-project index leads with projectId (audit defect #2 class).
-- Secrets never live here: the App private key and webhook secret are env
-- inputs (fail-closed when missing) and only redacted fingerprints may ever be
-- persisted or returned.

create table "github_installations" (
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

create index "github_installations_workspace_idx" on "github_installations" ("workspaceId");

create table "github_repo_selections" (
  "id" text not null primary key,
  "installationId" text not null references "github_installations" ("installationId") on delete cascade,
  "repoFullName" text not null,
  "status" text not null default 'selected' check ("status" in ('selected', 'deselected')),
  "createdAt" date not null,
  "updatedAt" date not null
);

create unique index "github_repo_selections_unique" on "github_repo_selections" ("installationId", "repoFullName");
create index "github_repo_selections_repo_idx" on "github_repo_selections" ("repoFullName");

create table "github_webhook_deliveries" (
  "deliveryId" text not null primary key,
  "event" text not null,
  "receivedAt" date not null
);

create table "github_imports" (
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

create index "github_imports_project_idx" on "github_imports" ("projectId");

create table "content_blobs" (
  "hash" text not null primary key,
  "bytes" blob not null,
  "size" integer not null,
  "createdAt" date not null
);

create table "github_deliveries" (
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

create index "github_deliveries_project_idx" on "github_deliveries" ("projectId");
create index "github_deliveries_branch_idx" on "github_deliveries" ("repoFullName", "headBranch");
