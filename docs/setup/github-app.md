# GitHub App setup (P08)

Caddie talks to GitHub as a **GitHub App**, never as a personal PAT
(feature-ledger C17: the single-PAT file-by-file exporter is retired). OAuth
sign-in with GitHub (P01) grants **no repository access** — repo authorization
comes only from an installation of the App that a workspace owner explicitly
binds.

## 1. Create the GitHub App

Create a GitHub App (user or organization settings → Developer settings →
GitHub Apps → New GitHub App) with:

| Setting | Value |
| --- | --- |
| Homepage URL | Your Caddie origin (e.g. `https://app.example.com`) |
| Callback URL | `https://app.example.com/api/auth/callback/github` (P01 sign-in only — optional; repo access does not use OAuth callbacks) |
| Webhook URL | `https://app.example.com/api/github/webhook` |
| Webhook secret | A dedicated random secret (`GITHUB_WEBHOOK_SECRET`) — use a secret manager, not chat |
| Permissions → Repository → Contents | **Read-only** (`contents:read`) |
| Permissions → Repository → Pull requests | **Read & write** (`pull_requests:write`) |
| Subscribe to events | `installation`, `installation_repositories` |

Notes:

- The App requests **no other scopes**. `contents:read` covers import;
  `pull_requests:write` covers feature-branch commits and PR creation.
- Writing to the **default branch** is a separate governed effect: it is only
  ever prepared by the service and executes behind an exact, revision-bound
  approval (`merge-default-branch` action in the P03 approvals ledger).
- Generate the private key (App settings → Private keys → Generate a private
  key). Caddie needs the **PKCS#8 PEM** form (`-----BEGIN PRIVATE KEY-----`).
  Convert an older `RSA PRIVATE KEY` (PKCS#1) key with:
  `openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem`.
  Only a redacted fingerprint of the key is ever echoed by the service.

## 2. Configure the Worker environment

Dedicated secrets (wrangler secrets / `.dev.vars` — never committed, never
printed):

| Env var | Meaning |
| --- | --- |
| `GITHUB_APP_ID` | Numeric App id (the JWT `iss`). Required; blank/half-configured fails closed with `GITHUB_NOT_CONFIGURED`. |
| `GITHUB_APP_PRIVATE_KEY` | App private key, PKCS#8 PEM, as a single secret value. Never persisted; only a `sha256-…16` fingerprint is ever returned. |
| `GITHUB_WEBHOOK_SECRET` | Webhook signing secret. Without it **every** webhook is rejected (`invalid_signature`) — fail-closed. |
| `GITHUB_API_BASE_URL` | Optional override (local test stub on `127.0.0.1`). Defaults to `https://api.github.com`. |

Proposed `app.ts` addition (integration lead applies; see the P08 packet
report for the exact diff):

```ts
GITHUB_APP_ID?: string;
GITHUB_APP_PRIVATE_KEY?: string;
GITHUB_WEBHOOK_SECRET?: string;
GITHUB_API_BASE_URL?: string;
// and, in the /api composition:
api.route('/', createGithubRouter());
```

## 3. Install and bind

1. A workspace owner installs the App on their account/organization and
   selects the repositories to share. GitHub immediately POSTs
   `installation.created` and `installation_repositories` webhooks; Caddie
   records the installation **unbound** (binding is always an explicit user
   action) and maintains the selection set.
2. The owner binds the installation to their workspace:
   `POST /api/github/installations/bind` with `{installationId, workspaceId}`.
   Metadata is resolved live from the App API; one installation serves exactly
   one workspace (a second binding attempt is `installation_already_bound` —
   the imported-existing-app case is a typed conflict, never a takeover).
3. Repository selections sync via `installation_repositories` events. Only
   **selected** repositories can be imported or delivered to.

## 4. Operations

- **Import** — `POST /api/projects/:projectId/github/imports` with
  `{installationId, repoFullName, ref, root}`. Symlinks are rejected,
  submodules are skipped and recorded, size/file-count caps are enforced, and
  the manifest stores sha256 hashes with bytes stored content-addressed.
- **Export** — `POST /api/projects/:projectId/github/deliveries` with
  `{runId, installationId, repoFullName, headBranch, title, files, mode}`.
  `pull-request` mode creates a feature branch + one PR and settles a provider
  receipt on the operations ledger; a duplicate intent reconciles to the same
  PR. `merge-default-branch` mode stays `prepared` until an exact approval
  exists and then fast-forwards only.
- **Revocation** — the `installation.deleted` webhook marks the installation
  `revoked`; every later import/delivery is denied (`installation_revoked`).

## 5. Verification honesty

`bun run verify:packet P08` runs the local integration matrix against a real
workerd + D1 and a loopback GitHub REST stub — classified **LOCAL VERIFIED**
for Caddie's side and **SIMULATED** at the provider boundary. Real-GitHub
verification (`bun run test:live -- P08`, tests/live/github.spec.ts) requires
owner-provisioned App credentials plus `CADDIE_LIVE_AUTHORIZED=1`; without
those it is **BLOCKED**, not PASS.
