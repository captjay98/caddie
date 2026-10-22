# FarmBook (farm records core)

- id: farmbook-core
- size: medium
- source: /Users/captjay98/projects/farmhand/v0-farmops (read-only reference; its 48-table schema in scripts/001-schema.sql and app/actions/*)
- theme: Agriculture — the records core of a farm operations platform (the owner's existing FarmOps product)
- paired: yes
- teamMode: both

> Faithful description of v0-farmops's core (read read-only): farms each have
> members with roles (owner, manager, worker) — multi-tenant, every record
> farm-scoped; physical structures (poultry houses, fish ponds) and production
> units (batches) inside them; farm events (mortality, vaccination, a note on
> the day); feed, as feed types with a stock level and recorded usage against a
> unit; sales and expenses; tasks for the day; and one AI insight — a short
> daily read of the farm's own data. v0-farmops has 48 tables in total; this
> brief is the CORE slice a small/medium build can carry, not the whole
> platform (that is the big brief).

## What the person wants (their own words)

I run a small farm and want one place for its records instead of paper and
WhatsApp. I set up my farm and add the people who work on it, each with a role —
I'm the owner, some are managers, some are workers. I record my structures (my
poultry houses and ponds) and the batches of animals in them. Day to day I log
events — a death, a vaccination, a note — and I track feed: what feed types I
have, how much stock is left, and how much each batch used. I record my sales
and expenses, and I keep a list of tasks for the day. And I'd like one short
daily insight that reads my own numbers and tells me what stands out.

## Complete when

- I can sign in with an emailed code.
- I can create a farm (I'm its owner) and add members with roles (owner,
  manager, worker).
- Any farm member can see the farm's records; a person from another farm cannot
  see, change, or delete them, and my farm never appears in their lists.
- I can add structures and production units (batches) in them; both save.
- I can log a farm event, a feed type with a stock level, a feed-usage record, a
  sale, an expense, and a task; each saves.
- After a restart, every one of those records is still there with the same values.
- Each record type can be edited and deleted (by a member with the role the farm
  allows; workers cannot delete another member's records they shouldn't).
- One AI insight returns a short readable summary computed from the farm's saved
  data.
- Every screen shows what the server saved.
