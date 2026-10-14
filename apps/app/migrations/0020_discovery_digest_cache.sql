-- 0020_discovery_digest_cache.sql — cache the AI "digest" (detail-pane Tier 1)
-- so opening a hackathon does NOT re-run the model every time. Additive only;
-- SQLite dialect for D1.
--
-- Owns:
--   discovery_digests  ONE row per candidate holding the last computed digest
--                      JSON plus the content hash it was computed from. The
--                      detail pane reads this instead of calling the model;
--                      it only recomputes when the hash changes (the summary
--                      the digest was grounded in changed) — mirroring the
--                      reference caddie's saveDigest/getLatestDigest
--                      replace-on-write (one digest per contest, latest wins,
--                      no unbounded growth).
--
-- The digest is NEVER load-bearing: a cache miss falls back to a live compute,
-- and a live-compute failure still degrades to "read the verbatim rules below"
-- (candidate-inspection.ts). This table only removes the repeated cost.

create table "discovery_digests" (
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

create index "discovery_digests_projectId_idx" on "discovery_digests" ("projectId");
