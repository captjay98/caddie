-- 0026_code_versions.sql — code history (Publish programme stage 1) and the
-- bundle manifest backend apps need (stages 3–4). Additive only; SQLite
-- dialect for D1.
--
-- Owns:
--   code_versions        one row per saved version of a project's code, newest
--                        = highest seq. The commit itself lives in the code
--                        store (Cloudflare Artifacts in production, the local
--                        tables below otherwise). A version remembers the
--                        sandbox image it came from and the checked build
--                        output, so Restore can reuse the image while it lasts.
--   local_code_commits   the LOCAL code store (code-versions.ts LocalCodeStore):
--   local_code_heads     complete-snapshot commits whose file bytes live in the
--                        content-addressed artifact_content table.
--   workflow_outputs.manifestSha256
--                        content hash of the output's bundle manifest (client
--                        JS/CSS, server bundle, migrations). Null for outputs
--                        checked before apps could have a server.

create table "code_versions" (
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

create unique index "code_versions_seq_idx" on "code_versions" ("projectId", "seq");

create table "local_code_commits" (
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

create table "local_code_heads" (
  "repo" text primary key not null,
  "head" text,
  "updatedAt" text not null
);

alter table "workflow_outputs" add column "manifestSha256" text;
