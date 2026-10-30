-- 4. Quality and acceptance: usage, repair escalation, artifact quality, acceptance receipts, deadlines, ready changes, quality policy
--
-- Folded 2026-10-28 from the original 58-file history (0001-0058; 0056-0058
-- were still uncommitted, so their objects live here). Mechanically generated:
-- the original files were replayed into an empty SQLite database, each object's
-- first appearance was recorded, and its FINAL definition was emitted in that
-- stage. No hand-editing -- the three table rebuilds (0024, 0035, 0044) and
-- every later ALTER are already merged into the CREATE below. Regenerate rather
-- than patch: replaying these four files yields the identical schema.

CREATE TABLE "model_call_usage" (
 "turnId" text primary key,
 "instanceId" text, "conversationId" text, "submissionId" text,
 "agentName" text, "purpose" text not null,
 "providerId" text not null, "requestedModel" text not null, "responseModel" text,
 "routeId" text, "pricingVersion" text, "currency" text,
 "selectedRole" text, "selectionReason" text not null,
 "inputTokens" integer, "outputTokens" integer, "cacheReadTokens" integer, "cacheWriteTokens" integer, "totalTokens" integer,
 "catalogCostMicros" integer check ("catalogCostMicros" is null or "catalogCostMicros" >= 0),
 "durationMs" real, "isError" integer not null check ("isError" in (0,1)), "createdAt" text not null
, finishReason text, providerFinishReason text, outputKind text);

CREATE INDEX "model_call_usage_instance" on "model_call_usage" ("instanceId", "createdAt");

CREATE INDEX "model_call_usage_submission" on "model_call_usage" ("submissionId", "createdAt");

CREATE TABLE "build_repair_issues" (
 "id" text primary key, "projectId" text not null references projects(id),
 "runId" text not null, "planId" text not null, "featureId" text not null,
 "admissionId" text not null, "policyVersion" text not null,
 "requiresVision" integer not null check ("requiresVision" in (0,1)),
 "failures" integer not null default 0 check ("failures" between 0 and 6),
 "state" text not null default 'active' check ("state" in ('active','exhausted','completed')),
 "createdAt" text not null, "updatedAt" text not null,
 unique("projectId","runId","planId","featureId","admissionId")
);

CREATE TABLE "build_repair_attempts" (
 "operationKey" text primary key, "issueId" text not null references build_repair_issues(id),
 "ordinal" integer not null, "modelRouteId" text not null, "failureHash" text not null,
 "createdAt" text not null, unique("issueId","ordinal")
);

CREATE INDEX "build_repair_active" on "build_repair_issues" ("runId","admissionId","state");

CREATE TABLE build_environments (
 runId text primary key, projectId text not null references projects(id),
 stackId text not null, recipeVersion text not null, baseImage text not null,
 createdAt text not null
);

CREATE TABLE quality_projects (
 projectId text primary key references projects(id), policyVersion text not null,
 authorRouteId text not null, createdAt text not null
);

CREATE TABLE quality_admissions (
 id text primary key, projectId text not null references projects(id),
 stage text not null check(stage in ('prd','looks','design')), dependencyHash text not null,
 payerId text not null, expiresAt text not null, createdAt text not null,
 phase text not null, planId text, brief text not null, decisionId text,
 unique(projectId,stage,dependencyHash)
);

CREATE TABLE artifact_candidates (
 id text primary key, admissionId text not null references quality_admissions(id),
 projectId text not null references projects(id), kind text not null,
 bodyHash text not null, body text not null, authorRouteId text not null,
 round integer not null check(round between 1 and 3),
 status text not null check(status in ('pending','reviewing','passed','revise','blocked','published')),
 createdAt text not null,
 unique(admissionId,round),unique(admissionId,bodyHash)
);

CREATE TABLE artifact_quality_reviews (
 candidateId text primary key references artifact_candidates(id),
 policyVersion text not null, reviewerRouteId text not null,
 verdict text not null check(verdict in ('pass','revise','blocked')),
 findingsJson text not null, captureManifestJson text not null, createdAt text not null
);

CREATE INDEX artifact_candidates_project on artifact_candidates(projectId,kind,createdAt);

CREATE TABLE feature_acceptance_receipts (
 operationKey text primary key, projectId text not null references projects(id),
 runId text not null, admissionId text not null, planId text not null,
 designId text not null, featureId text not null, checkedImage text not null,
 status text not null check(status in ('passed','failed','not-checked')),
 evidenceJson text not null, createdAt text not null
);

CREATE TABLE build_task_deadlines (
 taskKey text primary key, runId text not null, admissionId text not null,
 startedAt integer not null, deadlineAt integer not null
);

CREATE TABLE acceptance_candidates (
 id text primary key,tokenHash text unique not null,projectId text not null references projects(id),
 actorId text not null,workspaceId text not null,runId text not null,admissionId text not null,
 planId text not null,designId text not null,checkedImage text not null,bundleHash text not null,
 expiresAt integer not null,requestCount integer not null default 0,epoch integer not null default 0,
 closed integer not null default 0 check(closed in (0,1)),createdAt text not null
);

CREATE TABLE feature_acceptance_claims (
 operationKey text primary key, identityHash text not null,
 state text not null check(state in ('executing','settled')), createdAt text not null
);

CREATE TABLE ready_changes (
 id text primary key,
 projectId text not null references projects(id),
 runId text not null,
 baseOutputId text not null,
 request text not null,
 requestHash text not null,
 status text not null default 'proposed' check(status in ('proposed','approved','completed','failed','cancelled')),
 outputId text,
 failure text,
 createdBy text not null,
 decidedBy text,
 decidedAt text,
 createdAt text not null,
 updatedAt text not null
, proposalJson text, proposalHash text, admissionToken text);

CREATE INDEX ready_changes_project_idx on ready_changes(projectId, updatedAt);

CREATE UNIQUE INDEX ready_changes_open_idx on ready_changes(projectId) where status in ('proposed','approved');

CREATE TRIGGER artifact_quality_publication_guard before insert on plan_doc_revisions
when new.kind in ('prd','looks','design') and exists(
  select 1 from quality_projects where projectId=new.projectId and policyVersion='quality-v1'
)
begin
 select case when not exists(
  select 1 from artifact_candidates c
  join quality_admissions a on a.id=c.admissionId
  join artifact_quality_reviews r on r.candidateId=c.id
  join build_workflows w on w.projectId=c.projectId
  where c.projectId=new.projectId and c.kind=new.kind and ('sha256-' || c.bodyHash)=new.bodyHash and c.body=new.body
   and c.status='passed' and julianday(a.expiresAt)>julianday('now') and r.verdict='pass' and r.policyVersion='quality-v1'
   and c.rowid=(select max(rowid) from artifact_candidates where admissionId=a.id)
   and w.phase=a.phase and w.planId is a.planId and w.brief=a.brief
   and a.decisionId is (select id from plan_decisions where projectId=w.projectId order by rowid desc limit 1)
 ) then raise(abort,'artifact_quality_required') end;
end;

CREATE TRIGGER artifact_quality_published after insert on plan_doc_revisions
when new.kind in ('prd','looks','design') and exists(
  select 1 from quality_projects where projectId=new.projectId and policyVersion='quality-v1'
)
begin
 update artifact_candidates set status='published' where projectId=new.projectId and kind=new.kind
  and ('sha256-' || bodyHash)=new.bodyHash and status='passed';
end;
