-- 0031_app_sign_in.sql — sign-in codes for the people who use generated apps
-- (Publish programme stage 7). Additive only; SQLite dialect for D1.
--
-- Owns:
--   app_sign_in_emails  one row per code Caddie was asked to send for an app,
--                       in its preview ('preview') or as a published app
--                       ('live'). Used only to cap codes per app and per
--                       person per hour. The address is never stored here:
--                       recipientHash = sha256(projectId ':' lowercased email).
--   app_test_inbox      the preview's test inbox: codes an app sent while its
--                       owner tried it. Never emailed; shown in the project
--                       card; emptied by "Reset test data"; the newest 30 kept.
create table "app_sign_in_emails" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "mode" text not null check ("mode" in ('preview', 'live')),
  "recipientHash" text not null,
  "status" text not null check ("status" in ('inbox', 'sent', 'failed')),
  "createdAt" text not null
);

create index "app_sign_in_emails_project_idx" on "app_sign_in_emails" ("projectId", "createdAt");
create index "app_sign_in_emails_recipient_idx" on "app_sign_in_emails" ("projectId", "recipientHash", "createdAt");

create table "app_test_inbox" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "toEmail" text not null,
  "code" text not null,
  "createdAt" text not null
);

create index "app_test_inbox_project_idx" on "app_test_inbox" ("projectId", "createdAt");
