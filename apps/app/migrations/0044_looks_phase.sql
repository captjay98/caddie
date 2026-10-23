-- 0044_looks_phase.sql — add the "choose a look" step to the build workflow.
-- Append-only migration tag; D1 / SQLite dialect. Runs once, in order.
--
-- The step sits between plan approval and the design brief (owner-approved
-- 2026-10-23, docs/reviews/2026-10-23-look-and-feel-picker):
--   looks          Caddie is preparing 2-3 looks for the app
--   looks-review   the looks are saved and the owner is choosing one
-- Choosing a look moves the workflow to 'design', where the brief is written
-- in that look; asking for other looks moves it back to 'looks'.
--
-- NEW COLUMNS (nullable; null = no baseline, the behaviour before this step):
--   looksBaseline   the highest 'looks' plan-doc revision number that existed
--                   when the plan was approved; only a NEWER proposal is offered
--   designBaseline  the highest 'design' revision number that existed when the
--                   look was chosen; only a NEWER brief advances to review
-- Revision numbers, not timestamps: two saves in the same millisecond must
-- never let a proposal or brief written for an earlier step look current.
--
-- WHY A REBUILD: build_workflows.phase carries a CHECK constraint (0018,
-- widened in 0024) and SQLite cannot ALTER a CHECK in place. The table is
-- rebuilt with the widened constraint and every row copied. The column set
-- (including the 0040 team-mode columns with their defaults and checks), the
-- primary key, the unique intakeKey and the source index are preserved
-- exactly. No other table references build_workflows.

create table "build_workflows_new" (
 projectId text primary key references projects(id), runId text not null,
 conversationId text not null, sourceConversationId text,
 intakeKey text unique not null, brief text not null,
 phase text not null check(phase in ('planning','review','looks','looks-review','design','design-review','building','blocked','ready')),
 planId text, previewId text, pendingKey text, pendingBody text,
 detail text, updatedAt text not null,
 teamMode integer not null default 0 check (teamMode in (0, 1)),
 bigApps integer not null default 0 check (bigApps in (0, 1)),
 appFeatures integer not null default 0 check (appFeatures in (0, 1)),
 spendPayerId text,
 approvedDesignRevisionId text,
 looksBaseline integer,
 designBaseline integer
);

insert into "build_workflows_new"
 (projectId, runId, conversationId, sourceConversationId, intakeKey, brief,
  phase, planId, previewId, pendingKey, pendingBody, detail, updatedAt,
  teamMode, bigApps, appFeatures, spendPayerId, approvedDesignRevisionId)
select
  projectId, runId, conversationId, sourceConversationId, intakeKey, brief,
  phase, planId, previewId, pendingKey, pendingBody, detail, updatedAt,
  teamMode, bigApps, appFeatures, spendPayerId, approvedDesignRevisionId
from "build_workflows";

drop table "build_workflows";
alter table "build_workflows_new" rename to "build_workflows";
create index build_workflows_source on build_workflows(sourceConversationId);
