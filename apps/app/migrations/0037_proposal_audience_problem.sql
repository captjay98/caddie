-- 0037_proposal_audience_problem.sql — plan 4.3 (live-test fixes, 2026-10-20).
-- Who the app is for and the problem it solves, kept in the person's own
-- words on the proposal: shown on its card, and carried into the brief.
alter table "project_proposals" add column "audience" text;
alter table "project_proposals" add column "problem" text;
