-- Judge limits, follow-up (owner review of S07). Two discovery actions spend
-- Tavily and Nebius per click — `POST /projects/:projectId/discovery/feed` and
-- `POST /projects/:projectId/discovery/candidates/:candidateId/check-eligibility`
-- — and neither is a build start nor a Caddie message, so the rolling-24h
-- budget needs a third kind.
--
-- SQLite cannot widen a CHECK constraint in place, so the event table is
-- rebuilt with its rows preserved. This is the append-only way to do it:
-- 0034 stays exactly as it was committed, and every database that already ran
-- it migrates forward without losing an admitted event.
--
-- The index is recreated after the rebuild because dropping a table drops its
-- indexes with it.

create table "judge_usage_events_new" (
  "id" text not null primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "kind" text not null check ("kind" in ('build', 'message', 'discovery')),
  "createdAt" text not null
);

insert into "judge_usage_events_new" ("id", "userId", "kind", "createdAt")
  select "id", "userId", "kind", "createdAt" from "judge_usage_events";

drop table "judge_usage_events";

alter table "judge_usage_events_new" rename to "judge_usage_events";

create index "judge_usage_events_user_kind" on "judge_usage_events" ("userId", "kind", "createdAt");
