# Sandbox setup (P04/P05)

P04 implements the Workers-native sandbox adapter: a fetch-only port over the
real contree (Nebius TF Sandboxes) REST surface, because the contree CLI cannot
spawn under Workers (`docs/feature-ledger.md`, settled decision "Contree REST
sandbox client for Workers"). This page documents the REST surface the adapter
implements, the credentials an owner must provision, what is verified locally,
and what the authorized live probe proved.

Files:

- `apps/app/src/server/adapters/sandbox.ts` — the `SandboxDriver`
  implementation (contracts.md "Sandbox and verification"), quotas,
  persistence ordering, reconciliation.
- `apps/app/src/server/adapters/contree.ts` — the fetch REST client. All
  endpoint spellings live ONLY here; the driver and tests never hardcode
  them, so spec drift is a mechanical fix in one file.
- `tests/fixtures/sandbox-stub.ts` — local stub HTTP server (binds
  127.0.0.1 only) emulating this surface, plus chaos controls.
- `tests/sandbox.contract.test.ts` — the contract tests over the stub.
- `tests/live/sandbox.spec.ts` — the honest-gating LIVE probe (below).

## Environment variables (owner inputs)

| Variable | Required | Purpose |
|---|---|---|
| `CONTREE_BASE_URL` | yes | Base incl. service prefix: `https://api.tokenfactory.nebius.com/sandboxes` (matches the `contree_client` default). Endpoints live at `{base}/v1/…`. |
| `CONTREE_API_TOKEN` | yes | IAM bearer token (secret). Sent ONLY as `Authorization: Bearer …` — the driver refuses to place it in any sandbox-visible command text or env (`CREDENTIAL_IN_ENV` guard, test-proven). Store with `wrangler secret put CONTREE_API_TOKEN`; never in the repo. |
| `CONTREE_PROJECT_ID` | yes | Platform project id sent as the `Project` header. |
| `CONTREE_IMAGE` | no | Base image reference sessions bootstrap from. Default `tag:tt-base:1` (the adjudication-proven image). |
| `CONTREE_FLUTTER_IMAGE` | no (Track 3, not wired yet) | The Flutter build image, `1864960e-7449-4d26-ab77-9582989efc2e`, built 2026-10-19 by `scripts/build-flutter-image.ts` from `tag:tt-base:1`: OpenJDK 17, Flutter 3.44.8, Android SDK (platform 36, build-tools 36.0.0, NDK 28.2.13676358), with Gradle and pub caches warmed by a release build of `stacks/flutter/template`. Untagged: Contree may delete it 180 days after creation (about 2027-04-17), so re-run the script before relying on it past that. Build with Gradle's heap capped (`-Xmx1536m`): the sandbox has about 3.8 GB of memory. |

No value may be printed or committed. Local tests never read these: they use
an obviously fake token against the 127.0.0.1 stub.

## THE SESSION MODEL — there are no server-side sessions

Contree is content-addressed (contree-client 0.4.0, the OpenAPI-generated
library behind the CLI the adjudication used):

- `POST /v1/files` stores raw bytes → `{uuid, sha256, size}` (deduplicated);
- `POST /v1/instances` runs ONE command from an IMAGE (a filesystem snapshot
  uuid). A non-disposable run commits a NEW image layer (`result.image`) —
  that chain of images IS the session state;
- `GET /v1/inspect/{image}/download|list|archive?path=…` read files,
  directories and archives from any image without spawning anything.

A "session" is therefore OUR driver bookkeeping (exactly what the CLI keeps in
its local SQLite store behind `contree -S <key>`): a caller-chosen session key
mapped to the CURRENT image uuid plus the workspace root
(`/workspace/<projectId>`), persisted through the `SandboxPersistencePort`.

`SandboxDriver.ensureSession({sessionKey, image, projectId, runId})`:

- is the P05 fix for "sessions were never created": the agent tool path calls
  it lazily ONCE per (run, isolate) — memoized in `app.ts` AND single-flight
  inside the driver, so N racing tool calls share one creation;
- on first use runs ONE real instance (`mkdir -p <workspace-root>`) and
  persists the binding BEFORE returning;
- is idempotent afterwards (the persisted binding is returned unchanged; a
  fresh driver over the same persistence adopts it — restart semantics);
- refuses to rebind a key to a different project (`SESSION_KEY_CONFLICT`).

`dispose` is local truth (the binding is marked disposed; there is no
server-side session object to delete). `checkpoint` returns the current image
uuid — a committed snapshot; `restore` starts a NEW session from one.

## REST endpoint contract (implemented in contree.ts)

Evidence split — every row is one of:

- **SPEC (contree_client 0.4.0)**: shape taken from the OpenAPI-generated
  `contree_client` package (the library behind the contree CLI 0.9.4). Before
  the 2026-10-06 probe these were DOCUMENTATION ONLY; the probe upgraded the
  exercised paths to LIVE VERIFIED.
- **LIVE VERIFIED (2026-10-06 probe)**: actually executed against the real
  service by `tests/live/sandbox.spec.ts` with owner credentials
  (`CADDIE_LIVE_AUTHORIZED=1`); receipts in the execution ledger.
- **NOT YET PROBED**: spec-only; still DOCUMENTATION ONLY.

| Method + path (relative to `{base}/v1`) | Purpose | Request | Response | Evidence |
|---|---|---|---|---|
| `GET /inspect/?tag={name}` | resolve an image tag to its uuid | — | `302`, `Location: …/inspect/{uuid}/` | SPEC; LIVE VERIFIED (every session bootstrap resolves `tag:tt-base:1`) |
| `POST /files` | store content-addressed file | raw bytes (`application/octet-stream`) | `200 {uuid, sha256, size}` | SPEC; LIVE VERIFIED (probe write path) |
| `POST /instances` | run ONE command from an image; NON-disposable runs commit a new image | `{image, command, shell, disposable, cwd?, env?, timeout?, files?: {absPath: {uuid, mode?}}, truncate_output_at?}` | `200 {uuid}` (operation id) | SPEC; LIVE VERIFIED (bootstrap, exec, write-commit, injection check) |
| `GET /operations/{id}` | poll one operation | — | `200 {uuid, kind, status, error, duration, result: {image}, metadata: {result: {exit_code, stdout: {value, encoding, truncated}, stderr: {…}, state: {exit_code, timed_out}}}}`; `404` unknown | SPEC; LIVE VERIFIED (all probe polling) |
| `DELETE /operations/{id}` | cancellation REQUEST | — | `200`; termination proven by polling | SPEC (cancel itself not yet probed live — the probe never had to cancel) |
| `GET /inspect/{image}/download?path=` | read one file's bytes | — | `200` raw bytes / `404` | SPEC; LIVE VERIFIED (probe readFile + typed FILE_NOT_FOUND) |
| `GET /inspect/{image}/list?path=` | list one directory level | — | `200 {path, files: [{path, size, is_dir, is_regular, is_symlink, mtime, mode, …}]}` / `404` | SPEC; LIVE VERIFIED (probe stat + readdir) |
| `GET /inspect/{image}/archive?path=` | tar archive of a path | — | `200` tar bytes / `404` | SPEC; LIVE VERIFIED (probe export hashing) |
| `GET /whoami` | credential probe | — | `200 {token_uuid, …}` | SPEC; NOT YET PROBED |

Headers on every request: `Authorization: Bearer <CONTREE_API_TOKEN>` (the
P04-assumed `x-nebius-project-id` header name was wrong — the generated client
sends `Project: <CONTREE_PROJECT_ID>`; the live probe confirmed it works).

## Driver semantics (LOCAL VERIFIED against the stub; several live-proven)

- **Persistence before exposure.** The driver takes an injected persistence
  port `{save(record), load(key)}`; nothing here assumes D1 directly. Records:
  `session:<sessionKey>` (project/run/CURRENT IMAGE binding), `op:<operationKey>`
  (remote id + state machine), `artifact:<sessionId>` (artifactRef + sha256).
  The session binding is saved before `ensureSession` returns, the remote
  operation identity is saved before any completion is exposed, a successful
  run's new image is adopted into the session before the result is returned,
  and the artifact identity is saved before `export` returns.
- **Every dispatch carries a caller operation key — for OUR correlation.**
  The real API is NON-idempotent (no key replay: a re-sent POST could spawn a
  second instance). A transport failure on dispatch throws
  `AMBIGUOUS_DISPATCH` with state `ambiguous`; `reconcileOperation(key)` polls
  the persisted remote id when one was learned (and adopts the committed image
  into the linked session) — without a remote id it reports `unknown`.
  NEVER a blind re-dispatch (proven: exactly one dispatch on the wire).
- **Cancellation REQUEST ≠ termination.** `DELETE /operations/{id}` is a
  request; only `status` proving `cancelled` counts. An abort mid-flight
  releases the caller promptly AND requests the remote cancel; late proof is
  read via `status`/`reconcileOperation`.
- **Quotas (config, fail-closed).** `maxUploadBytes` (refused before any
  request), `maxOutputBytes` (sent as `truncate_output_at`; a truncated
  stream is a typed `QUOTA_OUTPUT_EXCEEDED` — never silently-shortened
  output), `maxCommandTimeoutMs` (over-long `timeoutMs` refused with
  `QUOTA_TIME_LIMIT`; a mid-flight deadline cancels the operation with
  `EXEC_TIMEOUT` and proves the kill via status).
- **Path hardening (NO shell built from model input).** readFile/writeFile/
  stat/readdir/exists travel over the content-addressed files API and inspect
  endpoints — no command text contains a model-controlled path. Only mkdir/rm
  run as instance commands; their paths are workspace-validated (absolute
  paths outside the workspace root and any `..` segment are rejected
  client-side with `UPLOAD_PATH_ESCAPE` — kept from P04) and embedded with a
  proven single-quote escaping primitive (`shellQuote`), unit-tested against
  injection payloads AND live-proven: an injection path on the real sandbox
  left no marker file (`/tmp/caddie-injection-check` stayed absent,
  stdout `clean`).
- **Credential exclusion.** The API token travels in the Authorization header
  only. The driver refuses dispatch when the command text or any env value
  contains it (`CREDENTIAL_IN_ENV`).
- **Flue adapter fidelity (P05).** The flue `SandboxDriver` adapter in
  `app.ts` maps `stat` to real inspect-list fidelity (isFile/isDirectory/
  symlink/size/mtime — the old hardcoded `{isFile: true}` fabrication is
  gone), passes `mkdir`'s `recursive` and `rm`'s `recursive`/`force` through,
  and forwards `exec` cwd/env/signal (abort releases the caller and cancels
  the remote op). The flue sandbox cwd is the session workspace root, so the
  runtime's path resolution lands inside the enforced workspace.

### Persistence port — production wiring (PROPOSAL for the integrator)

Tests use `InMemorySandboxPersistence`. Production should back the same
two-method port with D1, e.g.:

```sql
create table "sandbox_bindings" (
  "key" text primary key,          -- session:<key> | op:<operationKey> | artifact:<sessionId>
  "kind" text not null,            -- session | operation | artifact
  "sessionId" text, "projectId" text, "runId" text, "image" text,
  "checkpointRef" text, "operationKey" text, "remoteId" text,
  "state" text not null,
  "artifactRef" text, "sha256" text,
  "updatedAt" text not null
);
```

The migration file and its number belong to the integration lead (append-only
DO/D1 migration numbering); this adapter proposes the shape only. A D1-backed
port is a thin `save`/`load` over this table (upsert by key). Reconciliation
after a Worker restart then works unchanged: new driver instance + same D1
port + `reconcileOperation(operationKey)`.

## Verification status

LOCAL VERIFIED (against the in-process stub on 127.0.0.1 — driver mechanics,
NOT the real service; run `bun test tests/sandbox.contract.test.ts` or
`bun run verify:packet P04`):

- session-on-first-use: one bootstrap run per session, binding persisted
  before exposure, idempotent reuse, N-caller single-flight, key/project
  conflict refusal; `create()` key derivation.
- execute: receipt + committed image adopted before exposure; cwd defaults to
  the workspace root; only caller-passed env; token never in the body;
  truncate bound sent.
- files: content-addressed write + single commit run; batch = ONE commit;
  read round-trip; typed `FILE_NOT_FOUND`.
- injection: file operations dispatch ZERO shell commands; a hostile path
  becomes inert file paths; `shellQuote` round-trips adversarial inputs as
  exactly one argv with no top-level `;`.
- traversal: absolute-outside-root and `..` rejected client-side, nothing
  sent; absolute-under-root accepted (flue runtime resolves model paths
  against the sandbox cwd).
- stat/readdir fidelity; mkdir recursive/non-recursive; rm recursive/force
  and typed missing-path.
- checkpoint/restore/export/dispose: checkpoint = current image; restore sees
  checkpoint state only; bogus checkpoint typed 404; export hashed and
  persisted first; dispose is local truth with typed `SESSION_LOST` after.
- abort/timeout/ambiguous/restart semantics (single dispatch, honest unknown,
  image-chain adoption on reconciliation); quota refusals and typed
  truncation; credential exclusion.

Test sensitivity was checked by mutation in P04 (disabling
`reconcileOperation` fails the restart tests).

LIVE VERIFIED (2026-10-06, real contree service, `tests/live/sandbox.spec.ts`
via `bun run test:live -- P04`; receipts printed by the spec and recorded in
the execution ledger): tag resolution; session bootstrap (image committed);
session reuse across drivers (no second bootstrap); `echo live-sandbox-ok`
(op uuid + stdout received); content-addressed write → inspect read
round-trip; stat/readdir fidelity; injection path left NO marker file on the
real sandbox; typed `FILE_NOT_FOUND`.

BLOCKED / NOT YET PROBED (live):

- `DELETE /operations/{id}` cancellation semantics of the real service (the
  probe never had to cancel; the stub proves the driver's request/proof
  split).
- `GET /whoami` shape.
- ambiguous-dispatch behavior of the REAL service (the driver's honest
  `unknown` + no-blind-retry is stub-proven; the service's own behavior on a
  lost dispatch response is not).
- real-service restart/eviction semantics; operation timeout with the service
  killing the instance (driver deadline + cancel is stub-proven).

## Rollback

Revert the packet's commits; the adapter is self-contained (no routes, no
migrations, no shared-contract edits).
