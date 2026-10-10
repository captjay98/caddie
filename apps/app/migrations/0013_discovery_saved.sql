-- 0013_discovery_saved.sql — saved hackathons separate from accepting (B01).
-- Append-only (P00 numbering). A saved candidate is a bookmark on the
-- project's shortlist: `savedAt` is its own axis, never a status — saving
-- never creates a project and never accepts the candidate. Unsave clears it.

alter table "discovery_candidates" add column "savedAt" text;
