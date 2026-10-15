-- 0021_project_proposals.sql — Caddie PROPOSES a project; only the user creates it.
-- Additive only; SQLite dialect for D1.
--
-- Owns:
--   project_proposals  one row per proposal card Caddie shows in the Home chat.
--                      Nothing is created when Caddie proposes: the project,
--                      its run and its planning intake are created only when
--                      the user presses "Start this project" (status →
--                      accepted, projectId set). "Keep refining" dismisses the
--                      card and creates nothing.
--
-- Why: an instruction ("don't create before they agree") was not enough — the
-- model read "keep the focus on livestock" as agreement and created a project.
-- Creation is now a user action on a server-backed card, never a model call.

create table "project_proposals" (
  "id" text primary key not null,
  "actorId" text not null,
  "workspaceId" text not null,
  -- The Home (account) project whose chat showed the proposal; accept/dismiss
  -- are authorised against this project's scope.
  "homeProjectId" text not null references "projects" ("id") on delete cascade,
  -- The Home conversation the proposal came from (the new project's intake
  -- is bound to it exactly as a chat-created project was).
  "sourceConversationId" text not null,
  "name" text not null,
  -- 1-3 plain sentences shown on the card.
  "idea" text not null,
  -- The full brief handed to planning on accept.
  "brief" text not null,
  "hackathonTitle" text,
  "hackathonUrl" text,
  "track" text,
  "firstStep" text,
  "status" text not null default 'proposed' check ("status" in ('proposed', 'accepted', 'dismissed')),
  -- Set on accept; null until then.
  "projectId" text,
  "createdAt" text not null,
  "updatedAt" text not null
);

create index "project_proposals_home_idx" on "project_proposals" ("homeProjectId", "createdAt");
