# Sandbox setup (P04)

P04 implements the Workers-native sandbox adapter: a fetch-only port of the
adjudication's async contree client, because the contree CLI cannot spawn
under Workers (`docs/feature-ledger.md`, settled decision "Contree REST
sandbox client for Workers"). This page documents the REST surface the
adapter implements, the credentials an owner must provision, what is verified
against the local stub, and what stays BLOCKED until the real service can be
probed.

Files:

- `apps/app/src/server/adapters/sandbox.ts` — the `SandboxDriver`
  implementation (contracts.md "Sandbox and verification"), quotas,
  persistence ordering, reconciliation.
- `apps/app/src/server/adapters/contree.ts` — the fetch REST client. All
  endpoint spellings live ONLY here; the driver and tests never hardcode
  them, so documented-assumption drift is a mechanical fix in one file.
- `tests/fixtures/sandbox-stub.ts` — local stub HTTP server (binds
  127.0.0.1 only) emulating this surface, plus chaos controls.
- `tests/sandbox.contract.test.ts` — the contract tests over the stub.

## Environment variables (owner inputs)

| Variable | Required | Purpose |
|---|---|---|
| `CONTREE_BASE_URL` | yes | Base incl. service prefix, e.g. `https://api.tokenfactory.nebius.com/sandboxes`. The adjudication live-verified this base reachable over fetch. |
| `CONTREE_API_TOKEN` | yes | IAM bearer token (secret). Sent ONLY as `Authorization: Bearer …` — the driver refuses to place it in any sandbox-visible command text or env (`CREDENTIAL_IN_ENV` guard, test-proven). Store with `wrangler secret put CONTREE_API_TOKEN`; never in the repo. |
| `CONTREE_PROJECT_ID` | yes | Platform project id sent as the project header (`x-nebius-project-id`). See assumption note below. |

No value may be printed or committed. Local tests never read these: they use
an obviously fake token against the 127.0.0.1 stub.

## REST endpoint contract (implemented in contree.ts)

Evidence split — every item is one of:

- **ADJ (adjudication evidence)**: fact established live in
  `/Users/captjay98/projects/nebius-forge-eval/adjudication/evidence/phase-a.md`
  (ConTree CLI 0.9.4; documented REST `/sandboxes/v1/*` live-verified
  reachable via fetch with IAM + Project headers; operations carry a uuid and
  a RUNNING/PENDING/QUEUED-style status; `kill` cancels an operation; exec
  results are JSON with exit code/stdout/stderr/status; local abort releases
  the caller ~1.5s and cancels the remote op; SIGKILL orphans it).
- **ASSUMPTION (documented assumption)**: path spelling / field naming chosen
  to mirror the CLI verb surface 1:1. MUST be confirmed at the first
  owner-authorized live probe; a mismatch is fixed mechanically in
  `contree.ts`.

| Method + path (relative to `CONTREE_BASE_URL`) | Purpose | Request | Response | Evidence |
|---|---|---|---|---|
| `POST /v1/sessions` | create session (or restore) | `{sessionKey, image, workspaceRoot, restoreFrom?, isolation?}` | `200 {sessionId}` | path ASSUMPTION; `use <image>` verb ADJ; `workspaceRoot`/`isolation` fields ASSUMPTION |
| `POST /v1/sessions/{id}/files` | bounded single-file upload | `{path (absolute), contentBase64}` | `200 {saved:true}`; `400 {error:"path_escape"}` on containment violation | `file cp` verb ADJ; JSON+base64 shape ASSUMPTION |
| `POST /v1/sessions/{id}/exec` | async command dispatch | `{command, operationKey, timeoutSec, cwd?, env?}` | `202 {operationId}`; duplicate `operationKey` returns the SAME operation (idempotent) | `run` verb + result JSON ADJ; async-202 + idempotent-key ASSUMPTION |
| `GET /v1/operations/{id}` | poll operation | — | `200 {operationId, state, exitCode, stdout, stderr, outputBytes}`; `404` unknown | `ps`/operation status fields ADJ (RUNNING/PENDING/QUEUED observed); `outputBytes` field ASSUMPTION |
| `POST /v1/operations/{id}/cancel` | cancellation REQUEST | — | `202 {requested:true}` — proves nothing about termination | `kill` verb ADJ; 202-request semantics ASSUMPTION |
| `GET /v1/operations/by-key/{operationKey}` | provider correlation lookup by OUR key | — | `200 {operationId}` / `404` | ASSUMPTION (contracts.md requires correlation support; if the real service lacks it, ambiguous dispatch must stop at reconciliation-required in the P03 ledger instead) |
| `POST /v1/sessions/{id}/checkpoint` | snapshot session | — | `200 {checkpointRef}` | ASSUMPTION (checkpoint/fork isolation LIVE VERIFIED at provider level in the adjudication, REST shape not) |
| `GET /v1/sessions/{id}/export` | export workspace artifact | — | `200 {artifactRef, sha256}` | ASSUMPTION (sha256 field matches the contract's export shape) |
| `DELETE /v1/sessions/{id}` | dispose session | — | `204` | ASSUMPTION |

Headers on every request: `Authorization: Bearer <CONTREE_API_TOKEN>` (ADJ:
IAM header) and `x-nebius-project-id: <CONTREE_PROJECT_ID>` (ADJ: "Project
header" — exact header NAME is an ASSUMPTION to confirm at the live probe).

## Driver semantics (all stub-verified, see below)

- **Persistence before exposure.** The driver takes an injected persistence
  port `{save(record), load(key)}`; nothing here assumes D1 directly. Records:
  `session:<id>` (project/run/image/checkpoint binding), `op:<operationKey>`
  (remote id + state machine), `artifact:<sessionId>` (artifactRef + sha256).
  The session binding is saved before `create` returns, the remote operation
  identity is saved before any completion is exposed, and the artifact
  identity is saved before `export` returns — so a crash at any point leaves
  enough durable state to reconcile.
- **Every remote mutation carries a caller operation key.** Dispatch is
  idempotent server-side; the key is the correlation key for ambiguous
  outcomes (same policy as the P03 external-effects ledger — no second
  workflow engine).
- **Cancellation REQUEST ≠ termination.** `cancel` returns `{requested}`.
  Only `status` proving `cancelled` counts as termination. An abort mid-flight
  releases the caller promptly (bound asserted < 1s against the stub; the real
  service measured ~1.5s in the adjudication) AND requests the remote cancel;
  late proof is read via `status`/`reconcileOperation`.
- **Ambiguous dispatch.** A transport failure or timeout on the dispatch call
  throws `AMBIGUOUS_DISPATCH`, persists state `ambiguous` with no remote id,
  and NEVER retries blindly: `reconcileOperation(operationKey)` correlates by
  the persisted key, adopts the remote id, and polls to a terminal outcome or
  reports `unknown`.
- **Quotas (config, fail-closed).** `maxUploadBytes` (refused before any
  request), `maxOutputBytes` (output growth past the bound while running
  triggers a kill; typed `QUOTA_OUTPUT_EXCEEDED`, terminal state proven via
  status), `maxCommandTimeoutMs` (over-long `timeoutMs` refused with
  `QUOTA_TIME_LIMIT` before dispatch; a mid-flight deadline kills the command
  with `EXEC_TIMEOUT` and proves the kill via status).
- **Path hardening.** Upload paths must be workspace-relative: absolute paths
  and any `..` segment are rejected client-side (`UPLOAD_PATH_ESCAPE`) before
  anything is sent; the service-side containment check (symlink escapes) is
  defense in depth and maps to the same typed error.
- **Credential exclusion.** The API token travels in the Authorization header
  only. The driver refuses dispatch when the command text or any env value
  contains it (`CREDENTIAL_IN_ENV`). Sandbox env contains exactly the
  caller-passed keys — the driver adds nothing (asserted by deep equality in
  tests).
- **Isolation flags.** `isolation: {networkEgressDisabled: true}` is sent at
  session creation (documented assumption for the field name). Generated code
  never receives platform credentials (above).

### Persistence port — production wiring (PROPOSAL for the P05 integrator)

Tests use `InMemorySandboxPersistence`. Production should back the same
two-method port with D1, e.g.:

```sql
create table "sandbox_bindings" (
  "key" text primary key,          -- session:<id> | op:<operationKey> | artifact:<sessionId>
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

- create/execute/status/cancel/checkpoint/restore/export/dispose happy paths;
  operation-key idempotent dispatch; exec carries only caller-passed env and
  never the token in the body.
- persistence ordering: session/op/artifact records durable before exposure.
- abort semantics: pre-aborted signal never dispatches; mid-flight abort
  releases the caller promptly AND issues the remote cancel; status proves
  termination.
- ambiguous dispatch → `unknown` + reconciliation by persisted operation key
  (adoption of the remote id, no blind retry, exactly one dispatch on the
  wire).
- quota refusals and kills; traversal/symlink rejections; credential-exclusion
  guard; isolation flags on session create.
- chaos-stub proofs: restart during exec (fresh driver adopts persisted
  identity and settles the same work, single dispatch), restart after
  ambiguous dispatch (key-only correlation), cancellation request ignored by
  the remote (status honestly stays `running` until the cancel lands),
  session loss after export (persisted artifactRef/sha256 survive).

Test sensitivity was checked by mutation: disabling `reconcileOperation`
makes both restart tests fail (tests can fail).

BLOCKED (requires the real contree service + owner credentials; listed in the
packet text as probes 3):

- restart during exec ON THE REAL SERVICE (driver behavior is proven; the
  service's own recovery/eviction semantics are not).
- remote cancellation marker probe (cancel a command that writes a marker
  file; assert the marker stays absent on the real sandbox — the stub proves
  the driver asks for cancellation and reports honestly, not that the real
  service honors it within any bound).
- session loss / eviction and export behavior of the real service.
- exact header name for the project id, exact payload field spellings, and
  the existence/shape of the by-key correlation lookup (all ASSUMPTIONs in
  the table above; each is a mechanical fix in `contree.ts` once observed).

`bun run test:live -- P04` maps to `tests/live/sandbox.spec.ts`, which is
intentionally NOT created yet: writing it before an owner-authorized probe
would either fake live evidence or fail vacuously. It should be authored
during the authorized live probe, using this document's endpoint table and
the BLOCKED list above. Until then, live verification for P04 is BLOCKED
(verify-packet reports the missing mapped file — the honest failure mode).

## Rollback

Revert the packet's commits; the adapter is self-contained (no routes, no
migrations, no shared-contract edits) and nothing else consumes it before
P05 wiring.
