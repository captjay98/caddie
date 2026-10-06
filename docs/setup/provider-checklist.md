# Provider checklist (P17) — every owner-side provisioning step

The concrete provider-side actions an owner (or the aside agent) performs,
with the env vars each feeds and what it unblocks. This page is the
checklist; the per-packet detail lives in the referenced docs, and
`docs/setup/owner-inputs.md` records provisioning status. Secrets go only
into `.dev.vars` (gitignored) or `wrangler secret put` — never chat, tickets,
or this repository.

## Cloudflare (hosting — everything else sits on this)

- [ ] Account exists; `wrangler login` works locally.
- [ ] D1 database created; `apps/app/migrations/` applied **append-only**
      (migration numbering is integration-lead-owned; never edit history).
- [ ] Durable Objects available on the account/plan (the Flue runtime binds
      DOs — docs/flue-contracts.md).
- [ ] Secrets provisioned per environment: `BETTER_AUTH_SECRET`,
      `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`,
      `INVITE_ALLOWLIST` (docs/setup/auth.md), `CONTREE_BASE_URL/API_TOKEN/PROJECT_ID`
      (docs/setup/sandbox.md), `NEBIUS_API_KEY` (P05), `RESEND_API_KEY/RESEND_FROM`
      (P12), `GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_WEBHOOK_SECRET`
      (docs/setup/github-app.md — when P08 goes live).
- [ ] Origin hostnames decided: the app origin (sets `BETTER_AUTH_URL`) and,
      when P07's isolated preview is wired, `preview.<env>` (docs/setup/previews.md).

**Unblocks:** any deployment; P17 hosted acceptance.

## Google OAuth (sign-in, P01) — detail: docs/setup/auth.md

- [ ] OAuth client (type: Web application) with BOTH redirect URIs registered
      exactly:
      - dev: `http://127.0.0.1:<port>/api/auth/callback/google` (per port used)
      - production: `https://<BETTER_AUTH_URL>/api/auth/callback/google`
- [ ] Scopes: `openid email profile` only.

Status: dev client PROVISIONED (owner-inputs.md); production redirect pending
the canonical origin decision.

## GitHub OAuth App (sign-in only, P01) — detail: docs/setup/auth.md

- [ ] Callback URL for dev and production: `<origin>/api/auth/callback/github`.
- [ ] Scopes: `read:user user:email` — deliberately **no repository scopes**;
      repo access comes only from the GitHub App below.

Status: dev OAuth App PROVISIONED (owner-inputs.md); production callback
pending.

## GitHub App (repo access, P08) — detail: docs/setup/github-app.md

- [ ] App created with webhook URL `https://<origin>/api/github/webhook` and a
      dedicated `GITHUB_WEBHOOK_SECRET`.
- [ ] Permissions: Repository **Contents read-only** + **Pull requests
      read & write**; subscribe to `installation` +
      `installation_repositories`.
- [ ] Private key generated in **PKCS#8 PEM** form (conversion command in
      github-app.md).

Status: deferred by owner decision (owner-inputs.md) until the P08 live
window.

## Nebius (model provider, P05/P09)

- [ ] `NEBIUS_API_KEY` issued and stored in `.dev.vars` / wrangler secrets.

Status: PROVISIONED; P05 model round-trip LIVE VERIFIED
(docs/release-evidence.md).

## TF Sandboxes / contree (P04/P09 sandbox phases) — detail: docs/setup/sandbox.md

- [ ] `CONTREE_BASE_URL` (incl. service prefix), `CONTREE_API_TOKEN` (IAM
      bearer — Authorization header only, never in command text/env),
      `CONTREE_PROJECT_ID` (sent as `x-nebius-project-id`).
- [ ] First authorized probe reconciles the adapter's documented-assumption
      REST spellings against the real surface (sandbox.md endpoint table).

Status: PROVISIONED (whoami verified; P04 CLI probe LIVE VERIFIED); REST
spelling reconciliation is an open follow-up.

## Resend (outbound email, P12)

- [ ] Sending domain verified (SPF/DKIM) in Resend.
- [ ] `RESEND_FROM` = an address on the verified domain; `RESEND_API_KEY`
      stored.

Status: dev key provisioned; one real send to the owner's own address LIVE
VERIFIED (receipt id in docs/release-evidence.md). Production-domain sending
pending the verified domain.

## Stack toolchains (P15a–d live journeys)

Each live spec probes for its toolchain and names what is missing (never
installs):

| Stack | Needs | Where |
|---|---|---|
| `react-hono`, `tanstack-start` | Bun | dev host (present) |
| `laravel-inertia` | composer + php + npm | dev host (present) or the frozen sandbox image |
| `fastapi-react` | uv + python3 + bun | dev host (present) or the frozen sandbox image |
| `flutter` | Flutter SDK + Android SDK (`ANDROID_HOME` with platform-tools) + a **booted emulator** | dev host (present; emulator booted per run) |

If the contree sandbox path is taken instead, the image digest is frozen into
the recipe's `imageDigest` before the stack flips to verified.

**Unblocks:** `bun run test:live -- P15b/P15c/P15d` (all additionally gated on
`CADDIE_LIVE_AUTHORIZED=1`).

## Per-run authorization

- [ ] `CADDIE_LIVE_AUTHORIZED=1` set explicitly by the owner for the run,
      with budget/env/recipient understood. Never assumed, never committed;
      verify-packet refuses the live category without it.
