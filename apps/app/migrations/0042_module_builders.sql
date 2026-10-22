-- 0042_module_builders.sql — Parallel module builders (lane 12, plan part P / D12).
--
-- Additive only (append-style; no ALTER that drops, no edit of an earlier
-- migration). D1/SQLite dialect, matching 0040's conventions: quoted
-- identifiers, text ids, text ISO-8601 timestamps, a CHECK for every enum, an
-- index for every lookup. Trigger DDL keeps `end;` on its own line so the test
-- harness's statement splitter stays deterministic.
--
-- 0040 already created build_modules (id, projectId, buildSeq, moduleId,
-- status, sessionKey, checkpointRef, builderId, timestamps) and
-- integration_locks. This migration adds what the slot logic (server/
-- module-slots.ts) and the orchestration (server/modules.ts) need on top:
--   - build_modules.attempts    — a module's own 3-try repair budget (part P);
--   - build_modules.dependsOn   — the module's dependencies (JSON array of
--                                 moduleId), so modules.ts starts a module only
--                                 after all of them are merged (part P step 2);
--   - build_modules.payerId     — the build's shared spend payer (part A), so a
--                                 ModuleBuilder turn is charged to it
--                                 (resolveTurnPayer refuses when it is absent);
-- plus the atomic slot ledger that caps concurrency at 4 per build and 8 across
-- all of Caddie (D12).

-- --- build_modules: the columns the slot + orchestration logic needs ---------
--
-- 0040 made build_modules; these adds keep its quoted style. attempts counts a
-- module's failed build tries (its own 3-try limit, part P). dependsOn is the
-- module's dependency list as a JSON array of moduleId; '[]' means no
-- dependency (core). payerId names the build's shared payer in
-- build_spend_limits so every ModuleBuilder turn charges the one build limit
-- (part A step 4) — NULL until the module row is created from a build that has
-- opened its payer.
alter table "build_modules" add column "attempts" integer not null default 0 check ("attempts" >= 0);
alter table "build_modules" add column "dependsOn" text not null default '[]';
alter table "build_modules" add column "payerId" text;

-- --- build_module_slots (part P / D12) ---------------------------------------
--
-- One row per HELD builder slot. A slot is taken atomically when a module
-- starts building and released on finish, stop or failure. The two D12 caps are
-- enforced ATOMICALLY by the trigger below, inside the INSERT itself: the slot
-- is refused when the build already holds 4 slots, or when 8 slots are held
-- across all of Caddie. Two concurrent takes serialize on SQLite's write lock
-- and the over-cap one aborts, so the caps are hard.
--
-- The slot's identity is the module's instance id `<projectId>:<buildSeq>:
-- <moduleId>` (plan part P): one module can hold at most one slot, and
-- re-taking a slot it already holds is harmless (the PK makes a second insert a
-- no-op the caller treats as "already held"). buildKey is `<projectId>:
-- <buildSeq>` so the per-build cap counts a build's own slots.
create table "build_module_slots" (
  "instanceId" text not null primary key,
  "buildKey" text not null,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "buildSeq" integer not null check ("buildSeq" >= 0),
  "moduleId" text not null,
  "createdAt" text not null
);

create index "build_module_slots_build_idx" on "build_module_slots" ("buildKey");

-- The hard caps, enforced in the insert. A new slot is refused when the build
-- already holds BUILD_SLOT_MAX (4) slots, or when CADDIE_SLOT_MAX (8) slots are
-- held across every build. released slots are DELETEd rows, so both counts are
-- live. The literals here MUST match server/module-slots.ts
-- (BUILD_SLOT_MAX = 4, CADDIE_SLOT_MAX = 8); a test proves a 5th in one build
-- and a 9th across Caddie both wait.
create trigger "build_module_slots_cap_guard"
before insert on "build_module_slots"
when not exists (select 1 from "build_module_slots" where "instanceId" = new."instanceId")
begin
  select raise(abort, 'module_slot_build_cap')
  where (
    select count(*) from "build_module_slots" where "buildKey" = new."buildKey"
  ) >= 4;
  select raise(abort, 'module_slot_caddie_cap')
  where (
    select count(*) from "build_module_slots"
  ) >= 8;
end;
