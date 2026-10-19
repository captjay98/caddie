-- 0037 — Track 3: files bigger than one D1 value, and the Android app itself.
--
-- Production D1 refuses any value over 2,000,000 bytes. An Android app's
-- browser preview page (a few MB) and its APK (about 16 MB) are stored as
-- chunks of at most 1,900,000 bytes, content-addressed by sha256 and written
-- together in one batch (large-content.ts).
create table "large_content" (
  "sha256" text not null primary key,
  "bytes" integer not null check ("bytes" > 0 and "bytes" <= 67108864),
  "chunks" integer not null check ("chunks" >= 1),
  "createdAt" text not null
);
create table "large_content_chunks" (
  "sha256" text not null references "large_content" ("sha256") on delete cascade,
  "idx" integer not null check ("idx" >= 0),
  "bytes" blob not null,
  primary key ("sha256", "idx")
);

-- The Android app a checked Flutter build produced: the APK's sha256 in the
-- store above and its size. Null for every web build.
alter table "workflow_outputs" add column "apkSha256" text;
alter table "workflow_outputs" add column "apkBytes" integer
  check ("apkBytes" is null or "apkBytes" > 0);
