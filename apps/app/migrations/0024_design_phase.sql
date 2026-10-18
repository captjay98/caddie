-- 0024_design_phase.sql — add the DESIGN step to the build workflow lifecycle.
-- Append-only migration tag; D1 / SQLite dialect. Runs once, in order, on a
-- fresh DB (the migrate script applies every file in numeric order).
--
-- WHY A REBUILD: build_workflows.phase carries a CHECK constraint
-- (0018) that only allowed planning / review / building / blocked / ready.
-- The design step inserts two new phases between review and building —
--   design          Caddie is authoring the design brief (post-PRD-approval)
--   design-review   the brief is saved and awaiting the user's approval
-- SQLite cannot ALTER a CHECK constraint in place, so the table is rebuilt
-- with the widened constraint and its rows copied over. Column set, primary
-- key, and the source index are preserved exactly.

create table "build_workflows_new" (
 projectId text primary key references projects(id), runId text not null,
 conversationId text not null, sourceConversationId text,
 intakeKey text unique not null, brief text not null,
 phase text not null check(phase in ('planning','review','design','design-review','building','blocked','ready')),
 planId text, previewId text, pendingKey text, pendingBody text,
 detail text, updatedAt text not null
);

insert into "build_workflows_new"
 (projectId, runId, conversationId, sourceConversationId, intakeKey, brief,
  phase, planId, previewId, pendingKey, pendingBody, detail, updatedAt)
select
  projectId, runId, conversationId, sourceConversationId, intakeKey, brief,
  phase, planId, previewId, pendingKey, pendingBody, detail, updatedAt
from "build_workflows";

drop table "build_workflows";
alter table "build_workflows_new" rename to "build_workflows";
create index build_workflows_source on build_workflows(sourceConversationId);
