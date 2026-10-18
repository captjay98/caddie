-- 0028_app_publishing.sql — publishing apps on Caddie's Cloudflare account
-- (Publish programme stage 4; domains for stage 6). Additive only; SQLite
-- dialect for D1.
--
-- Owns:
--   app_publications  one row per published project: its public slug
--                     (<slug>.<apps-domain>), its user Worker in the dispatch
--                     namespace, its live D1 database (backend apps), what is
--                     live (build output + bundle manifest hash), which
--                     migrations already ran on the live database (name ->
--                     sha256, so an edited migration is refused), and whether
--                     it is live, paused by its owner, or blocked by Caddie.
--   app_publish_runs  the operations log: one row per publish / unpublish /
--                     roll back attempt with every step's outcome. At most one
--                     run per project is 'running' (partial unique index).
--   app_domains       custom domains (Cloudflare for SaaS custom hostnames).
create table "app_publications" (
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
);

create table "app_publish_runs" (
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

create index "app_publish_runs_project_idx" on "app_publish_runs" ("projectId", "startedAt");
create unique index "app_publish_runs_one_running" on "app_publish_runs" ("projectId") where "status" = 'running';

create table "app_domains" (
  "hostname" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "customHostnameId" text,
  "status" text not null,
  "sslStatus" text,
  "lastCheckedAt" text,
  "createdAt" text not null,
  "updatedAt" text not null
);

create index "app_domains_project_idx" on "app_domains" ("projectId");
