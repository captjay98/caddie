-- 0038 — Track 3: Android apps built with Flutter.
--
-- Which kind of app a proposal starts: a web app ('react-hono', every app
-- before Track 3) or an Android app ('flutter'). Starting the proposal writes
-- the same id into run_bindings.stackId, whose CHECK already allows 'flutter'.
-- Existing rows become web apps, which is what they were.
alter table "project_proposals" add column "stackId" text not null default 'react-hono'
  check ("stackId" in ('react-hono', 'flutter'));
