-- 0027_app_secrets.sql — keys a generated app needs for outside services
-- (Publish programme stage 8). Additive only; SQLite dialect for D1.
--
-- Owns:
--   app_secrets   one row per key name per project. The builder can ASK for a
--                 key ('requested': no value yet, a plain description and an
--                 optional help link); the project owner pastes it once
--                 ('set'). The value is stored ONLY as an AES-256-GCM
--                 envelope (secret-box.ts) sealed under APP_SECRETS_KEYS and
--                 bound to (projectId, name); it is opened server-side only,
--                 to inject into the app's preview runtime and its published
--                 Worker. It is never returned by any API, never shown to the
--                 AI model, never written into the build sandbox.
--   keyId         which keyring entry sealed the envelope, so a key rotation
--                 can find what still needs re-sealing without opening it.
create table "app_secrets" (
  "projectId" text not null references "projects" ("id") on delete cascade,
  "name" text not null,
  "status" text not null check ("status" in ('requested', 'set')),
  "envelope" text,
  "keyId" text,
  "description" text,
  "helpUrl" text,
  "requestedBy" text,
  "updatedBy" text,
  "createdAt" text not null,
  "updatedAt" text not null,
  primary key ("projectId", "name"),
  check (("status" = 'requested' and "envelope" is null and "keyId" is null)
      or ("status" = 'set' and "envelope" is not null and "keyId" is not null))
);

create index "app_secrets_key_idx" on "app_secrets" ("keyId");
