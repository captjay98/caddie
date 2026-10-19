-- Judge limits (submission plan S07, decision D4). Per judge account: 3
-- projects, 3 build starts per 24 hours, 300 Caddie messages per 24 hours.
-- The limits apply only to judge accounts (`judge_accounts.state = 'active'`);
-- the owner and invited users are never counted.
--
-- Why an event table: two of the three limits have no durable source of truth
-- to count. Build starts happen on several paths (plan approval, design
-- approval, Retry, and the chat `continue_project` route), and `run_bindings`
-- only records the FIRST run of a project — a 3rd build on an existing project
-- would leave no trace there. Caddie messages are not in D1 at all: they live
-- in the Flue Durable Object, so the conversation itself cannot be counted.
-- Counting projects needs no table (the `projects` rows are the record), so
-- only 'build' and 'message' are recorded here.
--
-- The row is written by the limiter itself, at the same moment it admits the
-- event, so the count and the event cannot drift: `countJudgeUsage(db, userId,
-- 'build', now)` refuses the 4th start in the window and every admitted start
-- is exactly one row. Pruned after 24 hours, which is also the window.

create table "judge_usage_events" (
  "id" text not null primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "kind" text not null check ("kind" in ('build', 'message')),
  "createdAt" text not null
);

-- The only read is "this user's rows of this kind since <cutoff>", so the index
-- carries all three columns in that order.
create index "judge_usage_events_user_kind" on "judge_usage_events" ("userId", "kind", "createdAt");
