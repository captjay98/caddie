-- 0017_profile_preferences.sql — onboarding profile preferences (D1, SQLite
-- dialect). Appends to user_profiles from 0008; migration tags are
-- append-only — never renumber or rewrite an applied file.
--
-- Every column is nullable or defaulted so existing rows keep their meaning:
-- absence means "never asked", surfaced as such, never guessed.
--   formatPreference — online / in person / either (event attendance filter)
--   skills           — JSON array, distinct from stackIds and interests
--   projectHighlight — one previous build, free text
--   budgetMode/Amount/Currency — comfort budget for planning ONLY; it never
--                      authorises spending (approvals stay explicit).
alter table "user_profiles" add column "formatPreference" text check ("formatPreference" in ('online', 'in_person', 'either'));
alter table "user_profiles" add column "skills" text not null default '[]';
alter table "user_profiles" add column "projectHighlight" text;
alter table "user_profiles" add column "budgetMode" text check ("budgetMode" in ('free_only', 'set', 'not_sure'));
alter table "user_profiles" add column "budgetAmount" integer;
alter table "user_profiles" add column "budgetCurrency" text;
