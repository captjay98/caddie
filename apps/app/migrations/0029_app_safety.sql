-- 0029_app_safety.sql — keeping published apps safe (Publish programme stage
-- 5). Additive only; SQLite dialect for D1.
--
-- Owns:
--   app_safety_checks  one row per check of a published app: a Cloudflare URL
--                      Scanner scan of a NEW version (run on a private check
--                      address before the public address switches to it), or a
--                      Google Web Risk lookup of a live app (daily recheck).
--                      pending -> clean | flagged | error.
--   abuse_reports      reports from the "Report" link on every app, plus the
--                      ones Caddie files itself when a check flags an app.
--                      Answered by the operator within 24 hours (Cloudflare's
--                      abuse rule for platforms).
-- app_publications gains: the candidate version waiting on its check, the last
-- daily recheck, and who took the app down and why.
create table "app_safety_checks" (
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

create index "app_safety_checks_pending_idx" on "app_safety_checks" ("status", "createdAt");
create index "app_safety_checks_project_idx" on "app_safety_checks" ("projectId", "kind", "manifestSha256");

alter table "app_publications" add column "candidateScript" text;
alter table "app_publications" add column "candidateOutputId" text;
alter table "app_publications" add column "candidateManifestSha256" text;
alter table "app_publications" add column "checkedAt" text;
alter table "app_publications" add column "blockedReason" text;
alter table "app_publications" add column "blockedBy" text;
alter table "app_publications" add column "blockedAt" text;

create table "abuse_reports" (
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

create index "abuse_reports_status_idx" on "abuse_reports" ("status", "createdAt");
create index "abuse_reports_reporter_idx" on "abuse_reports" ("reporterHash", "createdAt");
