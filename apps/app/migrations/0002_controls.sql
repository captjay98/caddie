-- 0002_controls.sql — P03 governance controls (D1, SQLite dialect).
--
-- Additive only (append-style; no ALTER of earlier migrations, no drops).
-- Owns: approvals (H4), external_operations (H5), budgets (H16) and the
-- redaction-only credential-handle store. Migration number assigned by the
-- integration lead (packets.md P03). Trigger DDL formats `end;` on its own
-- line so statement splitting stays deterministic.

-- --- approvals (H4: durable revision-bound approvals) -----------------------------
--
-- One row per approval intent lifecycle. intentHash is the canonical key-sorted
-- SHA-256 of the exact action/resource/revision with policy version
-- (@caddie/contracts approvalIntentHash). Exactly ONE live pending request may
-- exist per intent (partial unique index below); history rows accumulate.
-- decidedBy carries the session-verified deciding user id. It is intentionally
-- NOT a foreign key: approval evidence must survive user deletion (audit trail),
-- and integrity comes from the decision path (session-derived actor), not from
-- the column.

create table "approvals" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "action" text not null check ("action" in ('design', 'feature-review', 'deploy-production', 'destructive-database-change', 'merge-default-branch')),
  "resourceId" text not null,
  "revisionHash" text not null,
  "policyVersion" text not null,
  "intentHash" text not null,
  "decidedBy" text,
  "status" text not null default 'pending' check ("status" in ('pending', 'approved', 'rejected', 'revoked', 'expired', 'superseded')),
  "expiresAt" date not null,
  "createdAt" date not null,
  "decidedAt" date
);

create unique index "approvals_pending_intent_idx" on "approvals" ("intentHash") where "status" = 'pending';

create index "approvals_intent_project_idx" on "approvals" ("intentHash", "projectId");

create index "approvals_projectId_idx" on "approvals" ("projectId");

create index "approvals_intent_fields_idx" on "approvals" ("action", "resourceId", "revisionHash", "policyVersion");

-- --- external_operations (H5: receipts and reconciliation) --------------------------
--
-- The external-effect ledger. operationKey is the durable idempotency key of the
-- LOGICAL action/revision (never an attempt id); its unique insertion elects the
-- one dispatcher. `cancel-requested` and `cancelled` are distinct states: a
-- cancellation REQUEST is not confirmed termination — only a provider receipt
-- proves it. `reconciliation-required` marks an ambiguous dispatch (timeout /
-- unknown outcome); the row can only leave it via a real receipt, never a blind
-- retry. runId is the Flue-side run identity (text, not FK — work may exist
-- before a run binding does).

create table "external_operations" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "runId" text not null,
  "operationKey" text not null unique,
  "provider" text not null,
  "remoteId" text,
  "status" text not null default 'prepared' check ("status" in ('prepared', 'dispatched', 'succeeded', 'failed', 'cancel-requested', 'cancelled', 'reconciliation-required')),
  "receiptId" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

create index "external_operations_projectId_idx" on "external_operations" ("projectId");

create index "external_operations_runId_idx" on "external_operations" ("runId");

create index "external_operations_provider_key_idx" on "external_operations" ("provider", "operationKey");

-- --- budgets (H16: persistent spending) ----------------------------------------------
--
-- Integer minor-unit money only (no floats anywhere). budget_pricing is
-- versioned per model route; an unknown (modelRouteId, pricingVersion) fails
-- closed in the service. The live liability is the sum of budget_reservations
-- rows with status 'reserved' — the cap is enforced ATOMICALLY by the trigger
-- below, inside the INSERT statement itself, so two concurrent reserves
-- serialize on SQLite's write lock and the over-cap one aborts (mapped to 402
-- budget_exceeded). No counter column exists, so no drift is possible.

create table "budget_payers" (
  "payerId" text not null primary key,
  "limitMinorUnits" integer not null check ("limitMinorUnits" >= 0),
  "currency" text not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

create table "budget_pricing" (
  "modelRouteId" text not null,
  "pricingVersion" text not null,
  "unitPriceMinorUnits" integer not null check ("unitPriceMinorUnits" >= 0),
  "currency" text not null,
  "createdAt" date not null,
  primary key ("modelRouteId", "pricingVersion")
);

create table "budget_reservations" (
  "id" text not null primary key,
  "payerId" text not null references "budget_payers" ("payerId"),
  "reservationKey" text not null unique,
  "amountMinorUnits" integer not null check ("amountMinorUnits" > 0),
  "settledAmountMinorUnits" integer check ("settledAmountMinorUnits" >= 0),
  "status" text not null default 'reserved' check ("status" in ('reserved', 'settled', 'released')),
  "runId" text,
  "modelRouteId" text not null,
  "pricingVersion" text not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

create index "budget_reservations_payer_status_idx" on "budget_reservations" ("payerId", "status");

create index "budget_reservations_runId_idx" on "budget_reservations" ("runId");

create trigger "budget_reservations_cap_guard"
before insert on "budget_reservations"
when new."status" = 'reserved'
begin
  select raise(abort, 'budget_exceeded')
  where (
    select coalesce(sum("amountMinorUnits"), 0)
    from "budget_reservations"
    where "payerId" = new."payerId" and "status" = 'reserved'
  ) + new."amountMinorUnits"
  > (select "limitMinorUnits" from "budget_payers" where "payerId" = new."payerId");
end;

-- --- credential handles (BYOK, redaction-only placeholder) ----------------------------
--
-- Stores ONLY non-reversible fingerprints of secrets plus an envelope marker.
-- The secret material itself is never persisted and no function in
-- credentials.ts returns it. Real envelope encryption / key rotation lands with
-- P04/P08 usage; until then this table is identification-only by design.

create table "credential_handles" (
  "id" text not null primary key,
  "projectId" text not null references "projects" ("id") on delete cascade,
  "provider" text not null,
  "fingerprint" text not null,
  "envelope" text not null,
  "createdAt" date not null
);

create unique index "credential_handles_identity_idx" on "credential_handles" ("projectId", "provider", "fingerprint");
