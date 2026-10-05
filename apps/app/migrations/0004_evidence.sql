-- 0004_evidence.sql — P10 source evidence (D1, SQLite dialect).
--
-- Additive only (append-style; no ALTER of earlier migrations, no drops).
-- Owns: evidence_sources (H1 source registry), evidence_snapshots (H1
-- immutable observations) and evidence_claims (H1/C11 readings with history).
-- Migration number assigned by the integration lead (packets.md P10).
--
-- The "authority" check constraint enumerates EXACTLY the one shared
-- authority vocabulary in apps/app/src/server/evidence/authority.ts
-- (AUTHORITY_LEVELS order) — audit defect #6: storage cannot drift from
-- logic or UI. A unit test pins that agreement.
--
-- Audit defect #1 shape: claims reference real snapshot rows (FK), snapshots
-- carry real content + a content hash computed server-side, and placeholder
-- content is rejected at the service boundary. Snapshots are immutable by
-- contract: no service path updates or deletes them; dedupe is by content
-- hash per source ((sourceId, contentHash) unique), so re-reading unchanged
-- content lands on the SAME snapshot and history accumulates.
--
-- Isolation shape (audit defect #2 class): every per-project index leads
-- with projectId.

create table "evidence_sources" (
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

create unique index "evidence_sources_project_url_idx" on "evidence_sources" ("projectId", "canonicalUrl");

create index "evidence_sources_projectId_idx" on "evidence_sources" ("projectId");

create table "evidence_snapshots" (
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

create unique index "evidence_snapshots_source_hash_idx" on "evidence_snapshots" ("sourceId", "contentHash");

create index "evidence_snapshots_projectId_idx" on "evidence_snapshots" ("projectId");

create index "evidence_snapshots_sourceId_idx" on "evidence_snapshots" ("sourceId");

create table "evidence_claims" (
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

create index "evidence_claims_project_type_idx" on "evidence_claims" ("projectId", "claimType");

create index "evidence_claims_source_type_idx" on "evidence_claims" ("sourceId", "claimType", "status");

create index "evidence_claims_snapshotId_idx" on "evidence_claims" ("snapshotId");
