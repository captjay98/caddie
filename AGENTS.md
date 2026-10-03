# Caddie Forge

Fresh build of Caddie: a persistent, evidence-backed assistant that discovers
opportunities, plans projects, builds and repairs applications through Flue
specialists, and prepares verifiable delivery/submission artifacts.

Authoritative plan: `docs/plans/2026-10-03-fresh-build/` (README for authority,
packets.md for scope/sequencing, contracts.md for boundaries). Status and
evidence: `docs/plans/2026-10-03-fresh-build/execution-ledger.md` and
`docs/feature-ledger.md`.

## Layout

- `apps/app/` — Flue (pinned 2.2.2) cloudflare app: Hono fetch entry in
  `src/app.ts`, agents in `src/agents/`, product services in `src/server/`,
  React SPA in `src/client/` served under `/app`.
- `apps/site/` — static Astro landing, composed into the same Worker assets.
- `packages/contracts/` — shared serializable schemas/types only.
- `stacks/` — versioned output-stack recipes and fixtures.
- `scripts/` — build composition, packet verification, release evidence.
- `tests/` — integration/browser fixtures and acceptance tests.
- `docs/` — decisions, feature ledger, evidence, runbooks.

## Commands

- `bun run build` — Astro build + Vite build + asset composition into one
  Workers assets tree (no deploy).
- `bun run typecheck` — root project + apps/app project.
- `bun run verify:packet Pxx` — runs that packet's mapped tests; FAILS when a
  mapped test file is missing or contains no tests. Never vacuous.
- `bun run test:live -- Pxx` / `bun run test:browser -- Pxx` — live/browser
  harness per packet; fails clearly when prerequisites are absent.

## Rules

- Local verification only by default: no deploys, no paid API calls, no
  purchases, no remote publishing, no new git remotes. `.dev.vars`/`.env` are
  gitignored; never print or commit secrets.
- Classify evidence exactly: LOCAL VERIFIED, LIVE VERIFIED, SIMULATED,
  DOCUMENTATION ONLY, BLOCKED, FAILED. A mocked or local-only pass is never
  LIVE VERIFIED. Agent/model self-reports are never success evidence.
- Integration-lead-owned files (route registration, manifests/lockfile, shared
  contracts, migration numbering, wrangler/vite/astro config, ledgers): other
  agents propose changes, integration lead applies them serially.
- Flue runtime contract lessons live in `docs/flue-contracts.md` — read before
  writing agent code; re-verify on any version bump.
- Cloudflare DO migrations are append-only; every agent adds a migration tag.

## Reference material (read-only)

`/Users/captjay98/projects/caddie` (carryover audit source) and
`/Users/captjay98/projects/nebius-forge-eval` (adjudication evidence). Do not
modify them; do not copy git history, env files, or secrets from them.
