-- --- output_contract_receipts (part G) ---------------------------------------
--
-- Team mode: one row per workflow output recording whether that output's own
-- contract checks (sign-in, second-person, restart) passed. The host writes it
-- when verify_build runs the team-mode contract checks (host-checks.ts /
-- coordinator-host.ts), and publish-safety (publish.ts) reads it back BOUND TO
-- THE OUTPUT ID — so a green receipt on a different output never counts (part
-- G: "bound to the output id"). No receipt for the output being published
-- blocks a team-mode publish.
--
-- `checks` is a JSON object { "sign-in": bool, "second-person": bool,
-- "restart": bool }. One row per output; rebuilt per verify via delete+insert.
create table "output_contract_receipts" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "outputId" text not null,
  "checks" text not null,
  "createdAt" text not null
);

create index "output_contract_receipts_project_idx" on "output_contract_receipts" ("projectId");

create unique index "output_contract_receipts_output_idx" on "output_contract_receipts" ("projectId", "outputId");
