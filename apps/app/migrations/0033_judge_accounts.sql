-- Judge access (submission plan S06). Hackathon judges sign in with an access
-- code, a judge name and a password, so they need no Google or GitHub account
-- and no email is ever delivered to them. Their accounts still live in Better
-- Auth's own identity tables (no identity schema changes): the judge name maps
-- to a synthetic `<judge-name>@judges.caddie.invalid` address, which can never
-- be a real Google or GitHub address, so account linking can never attach to a
-- judge account and the mailer has nothing deliverable to send.
--
-- `judge_accounts` is the roster AND the invite-gate ticket. The route writes a
-- row in state 'starting' immediately before it creates the user; the invite
-- gate (`databaseHooks.user.create.before`) admits a `@judges.caddie.invalid`
-- address only while a matching 'starting' row exists and is fresh. The route
-- then flips the row to 'active' with the user id. A crashed start therefore
-- leaves a name reserved for ten minutes at most, and the route clears a stale
-- 'starting' row before it writes a new one.
--
-- `judge_access_attempts` counts judge starts and judge sign-ins per keyed IP
-- hash (HMAC of the address with Caddie's own secret and the label
-- 'caddie-judge-ratelimit:v1', the same derivation the report page uses), so
-- the two routes can refuse a flood with plain words. Only the hash is stored.

create table "judge_accounts" (
  "judgeName" text not null primary key,
  -- Null until the user exists. Set together with the flip to 'active'.
  "userId" text references "user" ("id") on delete cascade,
  "state" text not null default 'active' check ("state" in ('starting', 'active')),
  "createdAt" text not null,
  "lastSignInAt" text
);

-- One judge account per user, while still allowing many NULLs (SQLite treats
-- NULLs as distinct in a unique index): every 'starting' row has no user yet.
create unique index "judge_accounts_user" on "judge_accounts" ("userId");
create index "judge_accounts_starting" on "judge_accounts" ("state", "createdAt");

create table "judge_access_attempts" (
  "id" text not null primary key,
  "action" text not null check ("action" in ('start', 'sign_in')),
  "ipHash" text not null,
  "createdAt" text not null
);

create index "judge_access_attempts_ip" on "judge_access_attempts" ("ipHash", "createdAt");
create index "judge_access_attempts_created" on "judge_access_attempts" ("createdAt");
