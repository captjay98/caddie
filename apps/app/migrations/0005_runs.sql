-- 0005_runs.sql — run lifecycle: repair ledger, verification evidence,
-- last-good checkpoints (P05). Additive; SQLite dialect for D1.

create table "run_rounds" (
	"id" text not null primary key,
	"runId" text not null,
	"projectId" text not null,
	"issue" text not null,
	"round" text not null check ("round" in ('diagnosis','repair_attempt','verification','transport_retry','framework_recovery')),
	"outcome" text not null check ("outcome" in ('started','succeeded','failed')),
	"detail" text,
	"createdAt" text not null
);

create index "run_rounds_run_issue_idx" on "run_rounds" ("runId", "issue", "round");
create index "run_rounds_project_idx" on "run_rounds" ("projectId");

create table "run_verifications" (
	"id" text not null primary key,
	"runId" text not null,
	"projectId" text not null,
	"check" text not null,
	"passed" integer not null,
	"evidence" text not null,
	"planRevision" text not null,
	"recordedBy" text not null,
	"createdAt" text not null
);

create index "run_verifications_run_idx" on "run_verifications" ("runId", "createdAt");

create table "run_checkpoints" (
	"runId" text not null primary key,
	"projectId" text not null,
	"planRevision" text not null,
	"evidenceIds" text not null,
	"sha256" text not null,
	"createdAt" text not null
);
