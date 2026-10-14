-- 0019_github_project_repo.sql — the per-project connected GitHub repo
-- (guided join → build → GitHub step). Additive only; SQLite dialect for D1.
--
-- Owns:
--   github_project_repos  ONE row per project naming the repo the project is
--                         building in — connected (adopted an existing repo)
--                         or created (initialised a new private/public repo).
--                         This is the precise, honest "a repo is connected"
--                         signal the guided-steps surfaces derive from; it is
--                         distinct from github_imports (a content snapshot),
--                         because a freshly-created EMPTY repo has no commit to
--                         snapshot yet but is genuinely connected.
--
-- The repo must be a SELECTED repo of a bound installation (enforced in the
-- route, same guard as import/delivery); this table only records the link.
-- One repo per project (primary key on projectId); re-connecting replaces it.

create table "github_project_repos" (
  "projectId" text not null primary key references "projects" ("id") on delete cascade,
  "installationId" text not null,
  "repoFullName" text not null,
  "visibility" text not null check ("visibility" in ('private', 'public')),
  "origin" text not null check ("origin" in ('created', 'adopted', 'connected')),
  "htmlUrl" text not null default '',
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null,
  "updatedAt" date not null
);

create index "github_project_repos_repo_idx" on "github_project_repos" ("repoFullName");
