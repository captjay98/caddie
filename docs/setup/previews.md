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
in their commits' ledgers; see `docs/plans/2026-10-03-fresh-build/` for the
packet plan.
