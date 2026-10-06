-- 0008_profile.sql — P14 profile + memory (D1, SQLite dialect).
--
-- NOTE ON NUMBERING: 0006/0007 may be appearing in parallel from other
-- packets; P14 was assigned 0008 regardless. Migration tags are append-only —
-- never renumber or rewrite an applied file.
--
-- user_profiles: one row per user (userId PK). Every column is optional —
-- the profile is never a wall before useful work (feature-ledger C8). The
-- country is a free-form but strictly validated 2-letter ISO-3166 alpha-2
-- code, timezone is an IANA string validated with Intl at the service
-- boundary, stackIds/freeTextInterests are JSON arrays kept DISTINCT from
-- each other (structured stack IDs vs free text) and validated app-side
-- against the frozen StackId union in @caddie/contracts.
create table "user_profiles" (
	"userId" text not null primary key references "user" ("id") on delete cascade,
	"country" text,
	"timezone" text,
	"weeklyHours" integer,
	"experienceLevel" text check ("experienceLevel" in ('beginner', 'intermediate', 'senior')),
	"stackIds" text not null default '[]',
	"freeTextInterests" text not null default '[]',
	"createdAt" date not null,
	"updatedAt" date not null
);

-- memory_facts: living builder memory (feature-ledger H10). Personal facts
-- have projectId NULL and belong to their owner only; project-scoped facts
-- are visible to members of the fact's project workspace but only ever
-- MUTATED by their owner. There is no hard delete: "deletion" is a status
-- transition to 'retracted' and every read/injection path excludes
-- retracted rows, so history is always retained. correctsId links a
-- correction to the fact it supersedes (the old row is retracted, never
-- removed).
create table "memory_facts" (
	"id" text not null primary key,
	"userId" text not null references "user" ("id") on delete cascade,
	"projectId" text references "projects" ("id") on delete cascade,
	"kind" text not null check ("kind" in ('preference', 'fact', 'correction')),
	"content" text not null,
	"status" text not null check ("status" in ('proposed', 'confirmed', 'retracted')),
	"sourceRunId" text,
	"correctsId" text references "memory_facts" ("id"),
	"createdAt" date not null,
	"updatedAt" date not null
);

create index "memory_facts_userId_idx" on "memory_facts" ("userId");

create index "memory_facts_projectId_idx" on "memory_facts" ("projectId");

create index "memory_facts_user_status_idx" on "memory_facts" ("userId", "status");
