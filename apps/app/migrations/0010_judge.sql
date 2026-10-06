-- 0010_judge.sql — P13 judge coaching + submission package (D1, SQLite
-- dialect). Migration number assigned by the integration lead (packets.md
-- P13); additive only — no ALTER of earlier migrations, no drops.
--
-- Owns:
--   judge_scorecards             structured coaching scorecards. The rubric a
--                                scorecard was scored against is snapshotted
--                                (rubricHash + rubricJson) so a coaching score
--                                is always auditable against the exact rubric
--                                version it used — and so a LATER rule change
--                                cannot silently reinterpret an old scorecard.
--   submission_packages          prepared submission packages (title is the
--                                PROJECT title — never a contest/opportunity
--                                title assumption). reuseState is the human
--                                confirmation gate for reuse disclosure.
--   submission_checklist_items   per-requirement checklist rows; every row
--                                CITES the evidence claim it derives from
--                                (claimId + quote + canonical url). There is
--                                no seed path that invents universal items —
--                                no claim, no row.
--   submission_exports           exported package snapshots with the export
--                                content hash and the requirements version
--                                they were prepared against; a later rule
--                                change invalidates readiness (stale export).
--   submission_confirmations     the HUMAN'S record that they submitted
--                                externally — deliberately a separate table
--                                from prepared packages/exports so "prepared"
--                                and "confirmed submitted" can never blur.
--
-- Isolation shape (audit defect #2 class): every per-project index leads
-- with projectId. Checklist rows double-key on (projectId, packageId) so no
-- read path can join across projects.

create table "judge_scorecards" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "rubricHash" text not null,
  "rubricJson" text not null,
  "resultJson" text not null,
  "scoringVersion" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null
);

create index "judge_scorecards_projectId_idx" on "judge_scorecards" ("projectId", "createdAt");

create table "submission_packages" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "title" text not null,
  "descriptionJson" text not null,
  "reuseRequired" integer not null check ("reuseRequired" in (0, 1)),
  "reuseState" text not null default 'unconfirmed' check ("reuseState" in ('unconfirmed', 'confirmed')),
  "reuseConfirmedBy" text references "user" ("id"),
  "reuseConfirmedAt" date,
  "requirementsVersion" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null,
  check ("reuseState" <> 'confirmed' or ("reuseConfirmedBy" is not null and "reuseConfirmedAt" is not null))
);

create index "submission_packages_projectId_idx" on "submission_packages" ("projectId", "createdAt");

create table "submission_checklist_items" (
  "id" text not null primary key,
  "packageId" text not null references "submission_packages" ("id") on delete cascade,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "kind" text not null check ("kind" in ('video', 'repository', 'license', 'description', 'host_proof', 'reuse_disclosure', 'other')),
  "requirementText" text not null,
  "citationClaimId" text not null references "evidence_claims" ("id"),
  "citationQuote" text not null,
  "citationUrl" text not null,
  "status" text not null check ("status" in ('missing', 'declared', 'verified', 'conflict')),
  "evidenceJson" text not null default '[]',
  "createdAt" date not null
);

create index "submission_checklist_items_packageId_idx" on "submission_checklist_items" ("packageId");

create index "submission_checklist_items_projectId_idx" on "submission_checklist_items" ("projectId");

create table "submission_exports" (
  "id" text not null primary key,
  "packageId" text not null references "submission_packages" ("id") on delete cascade,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "exportHash" text not null,
  "requirementsVersion" text not null,
  "packageJson" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" date not null
);

create index "submission_exports_projectId_idx" on "submission_exports" ("projectId", "createdAt");

create index "submission_exports_packageId_idx" on "submission_exports" ("packageId");

create table "submission_confirmations" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "exportId" text not null references "submission_exports" ("id"),
  "exportHash" text not null,
  "attestationsJson" text not null,
  "note" text,
  "confirmedBy" text not null references "user" ("id"),
  "confirmedAt" date not null
);

create index "submission_confirmations_projectId_idx" on "submission_confirmations" ("projectId");
