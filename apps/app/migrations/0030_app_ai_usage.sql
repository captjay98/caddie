-- 0030_app_ai_usage.sql — AI inside apps (Publish programme stage 9).
-- Additive only; SQLite dialect for D1.
--
-- Owns:
--   app_ai_usage   one row per AI call an app's server made through
--                  env.CADDIE.ai(), in its preview ('preview') or as a
--                  published app ('live'). Caddie pays the model provider;
--                  each project has a monthly allowance (APP_AI_MONTHLY_LIMIT_CENTS).
--                  A call is first RESERVED at its worst-case cost — the
--                  insert itself refuses when the month's spend plus the
--                  reservation would pass the allowance — then SETTLED at the
--                  provider's reported token usage, or FAILED at zero when the
--                  provider refused it. Money is integer micro-cents
--                  (millionths of a cent), so one short reply never rounds to 0.
--                  Prompts and replies are never stored.
create table "app_ai_usage" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "mode" text not null check ("mode" in ('preview', 'live')),
  -- UTC calendar month the call counts toward, e.g. '2026-10'.
  "month" text not null,
  "status" text not null check ("status" in ('reserved', 'settled', 'failed')),
  "routeId" text not null,
  "reservedMicros" integer not null check ("reservedMicros" >= 0),
  "costMicros" integer not null default 0 check ("costMicros" >= 0),
  "inputTokens" integer,
  "outputTokens" integer,
  -- Plain reason for a failed call (busy, timeout, provider error) — never prompt text.
  "outcome" text,
  "createdAt" text not null,
  "updatedAt" text not null
);

create index "app_ai_usage_project_month_idx" on "app_ai_usage" ("projectId", "month");
create index "app_ai_usage_project_created_idx" on "app_ai_usage" ("projectId", "createdAt");
