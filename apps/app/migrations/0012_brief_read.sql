-- 0012_brief_read.sql — per-actor unseen/read state for the account Brief.
-- Append-only (P00 numbering). Read state is EXPLICITLY separate from
-- resolution: a row here only records that the actor saw the card; the
-- underlying approval/schedule/artifact/preview rows are untouched.

create table if not exists "brief_read_state" (
	"actorId" text not null,
	"cardKey" text not null,
	"seenAt" text not null,
	primary key ("actorId", "cardKey")
);