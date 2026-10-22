-- 0043_integration_lock.sql — The per-build integration merge lock (lane 13, plan part Q).
--
-- Additive only (append-style; no ALTER that drops, no edit of an earlier
-- migration). D1/SQLite dialect, matching 0040/0042 conventions: quoted
-- identifiers, text ids, text ISO-8601 timestamps, an index for every lookup.
--
-- Part Q: "Each finished module is merged when it lands, one at a time, under
-- the D1 integration lock." 0040 already created `integration_locks`, but keyed
-- by projectId alone (one lock per project). A big-app build runs under one
-- buildSeq, and a project may build more than once, so the merge lock is scoped
-- to the BUILD — (projectId, buildSeq) — not the project. This table is that
-- build-scoped lock: one row means a merge holds the lock for that build, so a
-- second merge on the same build is refused until the holder releases.
--
-- The primary key (projectId, buildSeq) IS the serialisation: a second
-- `insert` for a build that already holds the lock fails the PK constraint, so
-- two concurrent merges on one build cannot both hold it. `holder` names the
-- module instance holding it (for a human-readable "who holds it"); `expiresAt`
-- lets a crashed holder's lock be taken after it lapses (server/integration.ts
-- deletes an expired row before trying to acquire). released locks are DELETEd
-- rows, so the table holds only live holders.
create table "integration_merge_locks" (
  "projectId" text not null references "projects" ("id") on delete cascade,
  "buildSeq" integer not null check ("buildSeq" >= 0),
  "holder" text not null,
  "expiresAt" text not null,
  "createdAt" text not null,
  primary key ("projectId", "buildSeq")
);

create index "integration_merge_locks_expires_idx" on "integration_merge_locks" ("expiresAt");
