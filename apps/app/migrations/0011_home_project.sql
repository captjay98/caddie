-- 0011_home_project.sql — per-user Home project (P00 numbering: additive).
-- The Home project is the actor's direct conversation with Caddie: it backs
-- the project-less chat surface, so its run binding lives in the same
-- run/conversation machinery as every other project. One home per workspace
-- (the actor's personal workspace), enforced by a partial unique index —
-- concurrent ensureHomeProject calls lose the insert and re-select.
alter table "projects" add column "kind" text not null default 'standard' check ("kind" in ('standard', 'home'));
create unique index "projects_home_per_workspace_idx" on "projects" ("workspaceId") where "kind" = 'home';
