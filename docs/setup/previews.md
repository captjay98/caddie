# Artifacts and private previews (P07) — storage, export and preview gateway

Status: LOCAL VERIFIED for everything in `apps/app/src/server/artifacts.ts`,
`previews.ts` and their routers (real workerd + real local D1 via the
integration fixture). The R2 binding and the isolated preview origin below
are PROPOSED production wiring — deliberately not implemented, not deployed,
and never faked as working.

## Artifact content storage

`apps/app/src/server/artifacts.ts` defines a storage PORT:

```ts
interface ArtifactContentStore {
  put(bytes: Uint8Array): Promise<{ contentHash: string; size: number; deduped: boolean }>;
  get(contentHash: string): Promise<Uint8Array | null>;
  delete(contentHash: string): Promise<boolean>; // GC only: unreferenced hashes
}
```

Local default: the D1 table `artifact_content` (migration
`0003_artifacts.sql`) — content-addressed rows (`contentHash` = hex SHA-256,
`bytes` BLOB, size CHECK-capped at 5 MiB = `MAX_ARTIFACT_BYTES` in
artifacts.ts). Identical payloads dedupe onto one row; revision rows in
`project_artifacts` are immutable and reference content by hash. Staleness is
a status flip (`markStaleForPlan`), never a delete: the last green revision
stays readable and downloadable after a plan change or failed repair.

### Proposed production binding: R2 (NOT WIRED)

Production moves blobs from the D1 table to an R2 bucket behind the SAME
port. When the bucket exists and the owner approves the binding:

1. Add to `wrangler.jsonc` (integration lead applies; this file proposes):

   ```jsonc
   "r2_buckets": [
     {
       "binding": "ARTIFACT_STORE",
       "bucket_name": "caddie-artifacts-<env>"
     }
   ]
   ```

2. Implement `createR2ContentStore(binding: R2Bucket): ArtifactContentStore`
   in `apps/app/src/server/artifacts.ts` (key = content hash, `put` with
   `hash` metadata, size cap enforced before upload).
3. Choose the implementation at the composition edge (`app.ts`) based on
   whether `ARTIFACT_STORE` is bound; the D1 store stays the fallback.
4. Migration of existing rows is a one-off script run under owner
   authorization; the table is kept until the migration is verified.

Until that binding exists there is no bucket, no URL, and no claim of object
storage — the local table is the only implementation.

## HTTP surface (authenticated, session + membership scoped)

All scope checks derive from the verified session (`requireProjectScope`) and
are re-verified against D1 in the service layer:

- `POST /api/projects/:projectId/artifact-revisions` — store content
  (`kind` in `plan | test-result | browser-capture | diff`, `planRevision`,
  `contentType`, `filename`, `contentBase64`); server computes sha256.
- `GET  /api/projects/:projectId/artifact-revisions[?kind=]` — metadata list.
- `GET  /api/projects/:projectId/artifact-revisions/:revisionId` — metadata.
- `GET  /api/projects/:projectId/artifact-revisions/:revisionId/content` —
  inline content.
- `GET  /api/projects/:projectId/artifact-revisions/:revisionId/download` —
  export; `Content-Disposition: attachment` with a server-sanitized filename.
- `GET  /api/projects/:projectId/artifact-revisions/:toId/diff?from=<id>` —
  line diff between two revisions of the same kind.

Every content response (inline and download) carries the sandbox class of
headers, so artifact bytes can never execute with app authority:

- `Content-Security-Policy: sandbox` — unique opaque origin; generated JS
  cannot read Caddie cookies, storage or credentials.
- `X-Content-Type-Options: nosniff` — bytes are never re-sniffed into an
  executable type.

The preview gateway (slice 2) and the client viewer (slice 3) are documented
below; see `docs/plans/2026-10-03-fresh-build/` for the packet plan.

## Private preview gateway (token-only)

`apps/app/src/server/previews.ts` + `routes/previews.ts` implement the
managed private preview link. Previews are NOT public URLs: the only
credential is the preview token, so a separate isolated origin can serve a
preview without ever receiving Caddie's cookies.

Token model:

- 32 random bytes, base64url (43 URL-safe chars) — the secret IS the URL
  segment. It is returned exactly once at creation (`POST` response `token`)
  and never stored: only its hex SHA-256 (`tokenHash`, unique) is persisted.
- Rows live in `preview_tokens` (revision-bound, project-bound) and are never
  deleted; revocation sets `revokedAt`, expiry compares ISO `expiresAt`.
- Every resolve attempt appends a `preview_access_log` row
  (`served | denied | gone`). Unknown secrets are logged as a non-reversible
  hash marker (`unknown:<hash16>` / `malformed`), never the secret.

Management surface (authenticated, membership-scoped):

- `POST /api/projects/:projectId/previews` `{ revisionId, ttlSeconds? }` —
  mint; default TTL 7 days, max 30 days; the revision must belong to the
  scoped project.
- `GET  /api/projects/:projectId/previews` — metadata list (no secrets).
- `POST /api/projects/:projectId/previews/:id/revoke` — share-off; a second
  revoke is 409; revoked wins over extend and expiry.
- `POST /api/projects/:projectId/previews/:id/extend` `{ ttlSeconds }` —
  new window from now; can revive an expired link (explicit owner action),
  never a revoked one (409).

Resolution surface (PUBLIC, no session, no cookie):

- `GET /api/previews/resolve/:token`
  - valid + unexpired + not revoked -> 200 bytes with `Content-Type` from the
    revision, `Content-Security-Policy: sandbox`, `X-Content-Type-Options:
    nosniff`, `Cache-Control: no-store`. The sandbox header is the
    cookie-isolation guarantee: previewed (generated) content runs in an
    opaque origin and cannot read Caddie cookies or storage.
  - unknown or malformed token -> `404 {"error":"not_found"}` — existence is
    never confirmed and no 401/403 distinction is exposed.
  - expired or revoked -> `410 {"error":"preview_gone","reason":"expired" |
    "revoked"}`.

## Client surfaces (slice 3)

- `apps/app/src/client/artifacts/Viewer.tsx` — revisions list (kind, plan
  revision, short sha256, size, status incl. the stale marker), a compare
  control that fetches the real diff URL and renders add/del/context lines,
  and a sandboxed download link per revision. Presentational: the shell
  (P06/P11 integration) supplies query data; failures render the shared state
  grammar.
- `apps/app/src/client/planning/DesignReview.tsx` — latest plan revisions
  with the revision hash visible, Approve/Reject posting the REAL intent
  (`action: 'design'`, `resourceId` = plan revision id, `revisionHash` =
  bodyHash) to `/api/approvals`. decidedBy is always server-derived; a
  server-side refusal (e.g. the revision changed after an approval, a
  re-decision conflict) renders as an explicit state, never silent success.

Browser-level proofs live in `tests/browser/artifacts.spec.ts` (network-
stubbed UI-state proofs + the CSP-sandbox cookie-isolation frame check); the
real-data proofs are the integration suite. `tests/live/preview.spec.ts`
(additional live checks against a deployed isolated origin) is a later
packet's live harness and intentionally absent — its absence FAILS
`bun run test:live -- P07` loudly instead of passing vacuously.

## Proposed isolated preview origin (NOT WIRED)

The production intent (packets.md P07 slice 3) is a managed preview gateway
on an origin separate from the app (e.g. `preview.<env>.example.com` pointing
at this Worker, or a dedicated Worker per environment). Nothing is deployed;
when the owner provisions the hostname, the resolution route above is the
entire origin surface (token-only, no session routes, sandbox headers on
every response). HTML/assets served there stay un-cached and un-framed
outside the sandbox policy. If/when a stack's upstream cannot be protected
this way, that stack's preview stays gated (contracts.md), never public.
