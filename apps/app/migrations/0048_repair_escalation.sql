-- Append-only reliability admission and checked-repair receipts (B02a).
-- NULL policy preserves legacy admissions; model switches never open payers.
alter table "build_workflows" add column "repairPolicyVersion" text;
create table "build_repair_issues" (
 "id" text primary key, "projectId" text not null references projects(id),
 "runId" text not null, "planId" text not null, "featureId" text not null,
 "admissionId" text not null, "policyVersion" text not null,
 "requiresVision" integer not null check ("requiresVision" in (0,1)),
 "failures" integer not null default 0 check ("failures" between 0 and 6),
 "state" text not null default 'active' check ("state" in ('active','exhausted','completed')),
 "createdAt" text not null, "updatedAt" text not null,
 unique("projectId","runId","planId","featureId","admissionId")
);
create table "build_repair_attempts" (
 "operationKey" text primary key, "issueId" text not null references build_repair_issues(id),
 "ordinal" integer not null, "modelRouteId" text not null, "failureHash" text not null,
 "createdAt" text not null, unique("issueId","ordinal")
);
create index "build_repair_active" on "build_repair_issues" ("runId","admissionId","state");
