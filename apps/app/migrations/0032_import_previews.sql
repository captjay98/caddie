-- "Start from my GitHub repo": right after the copy, Caddie builds the copied
-- app once, without AI, so the project card can show it before any planning
-- (import-preview.ts). One row per project: a project starts from GitHub once.
--   checking  the build is under way (the card and the 5-minute cron advance it)
--   ready     outputId is the preview (a workflow_outputs row tied to the version)
--   failed    message says why in plain words; detail keeps the log tail
create table "import_previews" (
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
create index "import_previews_status" on "import_previews" ("status", "updatedAt");
