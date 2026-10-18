-- "Save the code to GitHub": one row per source save, i.e. a pull request
-- carrying the source of one verified build (workflow_outputs). The
-- manifest lists every path the save carried, so a LATER save can remove
-- files Caddie itself put in the repo that the build has since deleted, and
-- never touches a file Caddie did not save. Append-only: a new table only.
create table "github_source_saves" (
  "id" text not null primary key,
  "operationKey" text not null unique,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "outputId" text not null,
  "repoFullName" text not null,
  "headBranch" text not null,
  "pullRequestNumber" integer,
  "manifestJson" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null
);

create index "github_source_saves_project_idx" on "github_source_saves" ("projectId", "repoFullName", "createdAt");
