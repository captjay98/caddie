-- 0045_notification_prefs.sql — per-user notification preferences and web push
-- subscriptions. D1 / SQLite dialect. Append-only migration tag; runs once.
--
-- The in-app inbox (0007 notifications) is ALWAYS on — it is the record, and
-- its send receipts already live in 0007's notification_deliveries (channel is
-- free text there, so 'push' needs no schema change). These two tables add the
-- OPT-IN delivery channels on top of the inbox:
--   notification_prefs    per (user, kind): is email on? is push on?
--   push_subscriptions    a browser's Web Push endpoint for a user
--
-- Design rules carried from the established migrations: text PKs, ISO-8601
-- strings in date columns, per-user access paths index userId first, state
-- vocabularies pinned with CHECK so storage cannot drift from logic.

-- --- per-kind delivery preferences -------------------------------------------
-- A ROW means the user set an explicit choice for that kind; its ABSENCE means
-- "use the default for this kind" (the server owns the default map, so adding a
-- new kind never needs a backfill). in-app is not stored — it is always on.
create table "notification_prefs" (
  "userId" text not null references "user" ("id") on delete cascade,
  "kind" text not null,
  "email" integer not null default 0 check ("email" in (0, 1)),
  "push" integer not null default 0 check ("push" in (0, 1)),
  "updatedAt" date not null,
  primary key ("userId", "kind")
);

-- --- web push subscriptions --------------------------------------------------
-- One row per browser/device a user turned push on in. The endpoint is unique
-- (the same browser re-subscribing updates its keys in place). p256dh + auth
-- are the Web Push encryption keys the browser's PushManager returns.
create table "push_subscriptions" (
  "id" text not null primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "endpoint" text not null unique,
  "p256dh" text not null,
  "auth" text not null,
  "createdAt" date not null,
  "lastUsedAt" date
);

create index "push_subscriptions_user_idx" on "push_subscriptions" ("userId");
