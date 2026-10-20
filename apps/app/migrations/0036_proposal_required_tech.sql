-- 0036_proposal_required_tech.sql — plan 4.2 (live-test fixes, 2026-10-20).
-- A hackathon's rule naming what entries must use (quoted from its rules) is
-- kept on the proposal, so accepting it carries the rule into the project's
-- brief and from there into its plan. Null when the hackathon has no such rule.
alter table "project_proposals" add column "requiredTech" text;
