-- 0015_plan_decisions.sql — stored plan decisions (B04).
-- Append-only (P00 numbering). Approve / suggest-a-change decisions are
-- persisted per plan-doc revision, linked to the approval id that carried
-- the effect. A decision is bound to ONE revision: a newer revision needs a
-- new decision (no inherited approvals).

create table if not exists "plan_decisions" (
	"id" text not null primary key,
	"projectId" text not null references "projects" ("id") on delete cascade,
	"planRevisionId" text not null,
	"decision" text not null check ("decision" in ('approved', 'changes')),
	"note" text,
	"approvalId" text,
	"decidedBy" text not null references "user" ("id"),
	"createdAt" text not null
);

create index "plan_decisions_project_revision_idx" on "plan_decisions" ("projectId", "planRevisionId", "createdAt");
