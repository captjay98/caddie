-- Internal drafts never enter plan_doc_revisions before independent review.
create table quality_projects (
 projectId text primary key references projects(id), policyVersion text not null,
 authorRouteId text not null, createdAt text not null
);
create table quality_admissions (
 id text primary key, projectId text not null references projects(id),
 stage text not null check(stage in ('prd','looks','design')), dependencyHash text not null,
 payerId text not null, expiresAt text not null, createdAt text not null,
 phase text not null, planId text, brief text not null, decisionId text,
 unique(projectId,stage,dependencyHash)
);
create table artifact_candidates (
 id text primary key, admissionId text not null references quality_admissions(id),
 projectId text not null references projects(id), kind text not null,
 bodyHash text not null, body text not null, authorRouteId text not null,
 round integer not null check(round between 1 and 3),
 status text not null check(status in ('pending','reviewing','passed','revise','blocked','published')),
 createdAt text not null,
 unique(admissionId,round),unique(admissionId,bodyHash)
);
create table artifact_quality_reviews (
 candidateId text primary key references artifact_candidates(id),
 policyVersion text not null, reviewerRouteId text not null,
 verdict text not null check(verdict in ('pass','revise','blocked')),
 findingsJson text not null, captureManifestJson text not null, createdAt text not null
);
create index artifact_candidates_project on artifact_candidates(projectId,kind,createdAt);

-- This boundary protects every publication path, including direct REST writes.
-- Dependencies and newest intended candidate are checked in the INSERT itself.
create trigger artifact_quality_publication_guard before insert on plan_doc_revisions
when new.kind in ('prd','looks','design') and exists(select 1 from quality_projects where projectId=new.projectId)
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
create trigger artifact_quality_published after insert on plan_doc_revisions
when new.kind in ('prd','looks','design') and exists(select 1 from quality_projects where projectId=new.projectId)
begin
 update artifact_candidates set status='published' where projectId=new.projectId and kind=new.kind
  and ('sha256-' || bodyHash)=new.bodyHash and status='passed';
end;
