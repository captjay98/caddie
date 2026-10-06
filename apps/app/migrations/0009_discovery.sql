-- 0009_discovery.sql — P11 discovery, fit and planning support (D1, SQLite
-- dialect). Migration number assigned by the integration lead (packets.md
-- P11); additive only — no ALTER of earlier migrations, no drops.
--
-- Owns:
--   discovery_seed_candidates   local source-adapter seed table (the pluggable
--                               local adapter reads candidates from here; a
--                               real Devpost adapter is P17 live wiring)
--   discovery_feed_runs         one row per feed execution per project
--   discovery_feed_sources      PER-SOURCE outcome of a feed run — a failed
--                               source is a named, durable gap, never a
--                               silently dropped entry (P11 acceptance)
--   discovery_candidates        ingested candidates; the id is a DETERMINISTIC
--                               hash of (source, canonical URL) derived
--                               server-side at ingest — never client-supplied
--                               (audit carryover: scout bound candidates by
--                               prose-derived client ids)
--   planning_milestones         deadline-linked milestones derived from actual
--                               requirements (each cites its evidence claim)
--   planning_revision_provenance  origin of every plan-doc revision
--                               ('planning' | 'user') so planning can preserve
--                               what the user manually revised (feature-ledger
--                               C13/H13)
--
-- Isolation shape (audit defect #2 class): every per-project index leads with
-- projectId. Feed bookkeeping is per project — the same seed can be ingested
-- independently into different projects.

create table "discovery_seed_candidates" (
  "id" text not null primary key,
  "source" text not null,
  "url" text not null,
  "title" text not null,
  "summary" text not null,
  "publishedAt" date,
  "requirementsJson" text not null default '[]',
  "createdAt" date not null
);

create unique index "discovery_seed_source_url_idx" on "discovery_seed_candidates" ("source", "url");

create table "discovery_feed_runs" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "requestedBy" text not null references "user" ("id"),
  "requestedAt" date not null,
  "candidateCount" integer not null default 0
);

create index "discovery_feed_runs_projectId_idx" on "discovery_feed_runs" ("projectId");

create table "discovery_feed_sources" (
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

create index "discovery_feed_sources_feedRunId_idx" on "discovery_feed_sources" ("feedRunId");

create index "discovery_feed_sources_projectId_idx" on "discovery_feed_sources" ("projectId");

create table "discovery_candidates" (
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
  "updatedAt" date not null,
  primary key ("id", "projectId")
);

create unique index "discovery_candidates_project_source_url_idx" on "discovery_candidates" ("projectId", "source", "url");

create index "discovery_candidates_projectId_idx" on "discovery_candidates" ("projectId");

create table "planning_milestones" (
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

create unique index "planning_milestones_project_title_due_idx" on "planning_milestones" ("projectId", "title", ifnull("dueDate", ''));

create index "planning_milestones_projectId_idx" on "planning_milestones" ("projectId");

create table "planning_revision_provenance" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "kind" text not null,
  "planRevisionId" text not null references "plan_doc_revisions" ("id") on delete cascade,
  "origin" text not null check ("origin" in ('planning', 'user')),
  "createdAt" date not null
);

create unique index "planning_revision_provenance_revision_idx" on "planning_revision_provenance" ("planRevisionId");

create index "planning_revision_provenance_project_kind_idx" on "planning_revision_provenance" ("projectId", "kind");
