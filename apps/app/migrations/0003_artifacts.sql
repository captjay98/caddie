-- 0003_artifacts.sql — P07 versioned artifact content + private previews (D1,
-- SQLite dialect).
--
-- Additive only: no ALTER of earlier migrations, no drops, no rewrites. The
-- migration number 0003 is assigned by the plan (packets.md P07); 0004/0005
-- already exist and are untouched.
--
-- Storage port: artifact_content IS the LOCAL DEFAULT implementation of the
-- artifact content-store port (apps/app/src/server/artifacts.ts — put/get/
-- delete keyed by content hash). R2 is the PROPOSED production binding
-- (docs/setup/previews.md); no bucket exists locally, so nothing here
-- references one. The port interface keeps callers storage-agnostic: an
-- R2-backed adapter can replace this table without touching services.
--
-- Immutability: content rows are addressed by SHA-256 and never mutated;
-- revision rows are written once and never deleted. Staleness ("a newer plan
-- revision exists") is a status flip on the revision row — content and
-- history are always preserved.
--
-- Isolation (audit defect #2 class): every index leads with projectId, so no
-- "latest per user" or cross-project access path can emerge.

-- --- artifact_content (local default content store, content-addressed) -------------
--
-- One row per DISTINCT artifact payload, keyed by the hex SHA-256 of the
-- bytes. Storing the same bytes again dedupes onto the same row (the service
-- insert-or-ignores; the primary key enforces it). MAX_ARTIFACT_BYTES in
-- artifacts.ts is 5 MiB; the CHECK keeps storage and service limits from
-- drifting. Larger artifacts are the proposed R2 binding's job, not this
-- table's.

create table "artifact_content" (
  "contentHash" text not null primary key,
  "bytes" blob not null,
  "size" integer not null check ("size" >= 0 and "size" <= 5242880),
  "createdAt" date not null
);

-- --- project_artifacts (immutable per-revision records) ----------------------------
--
-- One row per artifact revision: who stored it, from which plan revision it
-- derives, and where its immutable content lives (sha256 -> artifact_content).
-- kind is the closed P07 vocabulary (plan | test-result | browser-capture |
-- diff). status is the ONLY mutable column: markStaleForPlan flips
-- 'current' -> 'stale' for artifacts derived from older plan revisions —
-- never a delete, so the last green revision stays inspectable after a failed
-- repair (contracts.md: build completion is bound to the final revision).

create table "project_artifacts" (
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

create index "project_artifacts_project_idx" on "project_artifacts" ("projectId", "createdAt");

create index "project_artifacts_project_kind_idx" on "project_artifacts" ("projectId", "kind", "planRevision");

create index "project_artifacts_project_stale_idx" on "project_artifacts" ("projectId", "status", "planRevision");

-- --- preview_tokens (private preview gateway credentials) --------------------------
--
-- Bearer-style preview tokens, one per artifact revision. The secret is
-- 32 random bytes base64url-encoded, shown ONCE at creation and NEVER stored:
-- tokenHash (hex SHA-256) is the only persisted form. The public resolution
-- route authenticates with the token alone — it reads no session cookie — so
-- a separate isolated origin can serve previews. expiresAt + revokedAt are
-- the share/expiry levers; rows are never deleted so the audit story and
-- "why did this link stop working" stay answerable.
--
-- createdBy is intentionally NOT a foreign key (same rationale as
-- approvals.decidedBy): the audit trail survives user deletion; integrity
-- comes from the session-derived creation path.

create table "preview_tokens" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "revisionId" text not null references "project_artifacts" ("id") on delete cascade,
  "tokenHash" text not null unique,
  "createdBy" text not null,
  "expiresAt" date not null,
  "revokedAt" date,
  "createdAt" date not null
);

create index "preview_tokens_project_idx" on "preview_tokens" ("projectId");

create index "preview_tokens_revision_idx" on "preview_tokens" ("revisionId");

-- --- preview_access_log (append-only audit trail for every resolution try) ---------
--
-- One row per resolve attempt: which token row answered (by id; unknown
-- secrets are logged as a NON-reversible hash prefix, never the presented
-- secret), the path, the outcome and the time. Append-only; tokenId is
-- intentionally not a foreign key so the log survives any future cleanup.

create table "preview_access_log" (
  "id" text not null primary key,
  "tokenId" text not null,
  "projectId" text,
  "path" text not null,
  "outcome" text not null check ("outcome" in ('served', 'denied', 'gone')),
  "at" date not null
);

create index "preview_access_log_token_idx" on "preview_access_log" ("tokenId", "at");

create index "preview_access_log_project_idx" on "preview_access_log" ("projectId");
