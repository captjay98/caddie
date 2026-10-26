-- Private, short-lived checked candidates. Never a published workflow output.
create table acceptance_candidates (
 id text primary key,tokenHash text unique not null,projectId text not null references projects(id),
 actorId text not null,workspaceId text not null,runId text not null,admissionId text not null,
 planId text not null,designId text not null,checkedImage text not null,bundleHash text not null,
 expiresAt integer not null,requestCount integer not null default 0,epoch integer not null default 0,
 closed integer not null default 0 check(closed in (0,1)),createdAt text not null
);
