-- 0036 — Track 3: Android apps built with Flutter.
--
-- Which kind of app a proposal starts: a web app ('react-hono', every app
-- before Track 3) or an Android app ('flutter'). Starting the proposal writes
-- the same id into run_bindings.stackId, whose CHECK already allows 'flutter'.
-- Existing rows become web apps, which is what they were.
alter table "project_proposals" add column "stackId" text not null default 'react-hono'
  check ("stackId" in ('react-hono', 'flutter'));

-- The Android app a checked Flutter build produced: the content hash of the
-- APK in the APK store (R2 in production, see apk-store.ts) and its size.
-- Null for every web build and for Flutter builds made before the APK step.
alter table "workflow_outputs" add column "apkSha256" text;
alter table "workflow_outputs" add column "apkBytes" integer
  check ("apkBytes" is null or "apkBytes" > 0);
