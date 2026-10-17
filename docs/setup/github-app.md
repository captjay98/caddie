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
| Permissions → Repository → Contents | **Read & write** (`contents:write`) |
| Permissions → Repository → Pull requests | **Read & write** (`pull_requests:write`) |
| Permissions → Repository → Administration | **Read & write** only if Caddie should create new repos for projects; otherwise leave it off |
| Subscribe to events | `installation`, `installation_repositories` |

Notes:

- `contents:write` is required for every git write GitHub documents under
  Contents: blobs, trees, commits and branch refs (so every save, including a
  pull request on a `caddie/...` branch) and merging a pull request. It also
  covers import (reads). `pull_requests:write` covers opening, reading and
  closing pull requests. Before any write Caddie reads the installation's
  live permissions and refuses with `github_contents_write_required`
  instead of failing halfway with GitHub's 403.
- After changing the App's permissions, the installation owner must accept
  them on the installation (GitHub asks on the installation's settings
  page); until then the refusal above stays in place.
- Writing to the **default branch** is a separate governed effect: a direct
  write (`merge-default-branch` delivery) and merging a pull request both
  execute only behind an exact approval (`merge-default-branch` action in
  the P03 approvals ledger; for a merge the approval names the PR and its
  head commit).
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
| `GITHUB_APP_SLUG` | Optional, public. The App's URL name (`github.com/apps/<slug>`); enables the "Install the Caddie GitHub App on GitHub" button. Unset means no button and no guessed URL. |

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
  exists and then fast-forwards only. Files may be `encoding: "base64"`
  (binary); `deletePaths` removes paths, applied only where the base tree
  has them.
- **Save the code** — `POST /api/projects/:projectId/github/source` with
  `{outputId}`. The server reads the checked build's source from that
  output's sandbox image (dependencies, build output and secret files are
  never read; a secret inside a source file refuses the save; hard caps of
  200 files / 512 KB per file / 8 MB) and opens a pull request on a
  `caddie/source-<hash>` branch. Saving the same build again replays the
  same PR; a later save removes files an earlier save added that the build
  has since deleted. `GET` on the same path returns the latest save, its
  PR's live state and the exact approval a merge needs.
- **Close / merge a Caddie PR** — `POST
  /api/projects/:projectId/github/pulls/:n/close` with `{repoFullName}`
  (reversible; never deletes the branch) and `.../merge` with
  `{repoFullName, headSha}`. A merge is refused unless the PR is open, still
  at `headSha`, not conflicting, and an approval for exactly that PR and
  commit exists; the merge call is pinned to `headSha`, so a push after the
  approval is refused by GitHub itself. Only PRs Caddie opened for the
  project can be closed or merged.
- **Revocation** — the `installation.deleted` webhook marks the installation
  `revoked`; every later import, delivery, save, close and merge is denied
  (`installation_revoked`).

## 5. Verification honesty

`bun run verify:packet P08` runs the local integration matrix against a real
workerd + D1 and a loopback GitHub REST stub — classified **LOCAL VERIFIED**
for Caddie's side and **SIMULATED** at the provider boundary. Real-GitHub
verification (`bun run test:live -- P08`, tests/live/github.spec.ts) requires
owner-provisioned App credentials plus `CADDIE_LIVE_AUTHORIZED=1`; without
those it is **BLOCKED**, not PASS.
