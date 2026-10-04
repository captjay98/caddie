# Execution ledger

Status, evidence, review verdicts and integrated SHA. Planning-only rows say NOT STARTED.

| Packet | Status | Owner | Spec review | Quality review | Evidence / SHA |
|---|---|---|---|---|---|
| P00 | LOCAL VERIFIED | Integration lead (coordinator) | PASS | PASS (RECHECK: PASS after fixes) | 879e0f1 |
| P01 | LOCAL VERIFIED (real OAuth callbacks BLOCKED on owner credentials) | Backend identity engineer (subagent); integrated by lead | PASS | PASS (fixes applied: AUTH_TEST_MODE fence, dead helper removal, DDL-drift guard, log cleanup) | see evidence records (c41dc19 + integration b1b4d4e + review fixes) |
| P02 | NOT STARTED | Unassigned | Pending | Pending | — |
| P03 | NOT STARTED | Unassigned | Pending | Pending | — |
| P04 | NOT STARTED | Unassigned | Pending | Pending | — |
| P05 | NOT STARTED | Unassigned | Pending | Pending | — |
| P06 | NOT STARTED | Unassigned | Pending | Pending | — (tokens port pulled forward to P16, see P16 record) |
| P07 | NOT STARTED | Unassigned | Pending | Pending | — |
| P08 | NOT STARTED | Unassigned | Pending | Pending | — |
| P09 | NOT STARTED | Unassigned | Pending | Pending | — |
| P10 | NOT STARTED | Unassigned | Pending | Pending | — |
| P11 | NOT STARTED | Unassigned | Pending | Pending | — |
| P12 | NOT STARTED | Unassigned | Pending | Pending | — |
| P13 | NOT STARTED | Unassigned | Pending | Pending | — |
| P14 | NOT STARTED | Unassigned | Pending | Pending | — |
| P15a | NOT STARTED | Unassigned | Pending | Pending | — |
| P15b | NOT STARTED | Unassigned | Pending | Pending | — |
| P15c | NOT STARTED | Unassigned | Pending | Pending | — |
| P15d | NOT STARTED | Unassigned | Pending | Pending | — |
| P16 | LOCAL VERIFIED | Integration lead (rework; initial slices by subagent) | PENDING (quota — re-review when subagent dispatch returns) | PENDING (quota) | see evidence records (pit-board port per amendment 3054ee2) |
| P17 | NOT STARTED | Unassigned | Pending | Pending | — |

## Evidence records

```json
{
  "packet": "P00", "status": "LOCAL VERIFIED", "sha": "879e0f1",
  "commands": [
    {"command": "bun run build", "exitCode": 0},
    {"command": "bun run verify:packet P00", "exitCode": 0,
     "receipt": "contracts: 11 tests passed; routing: 12 tests passed"},
    {"command": "bun run typecheck", "exitCode": 0},
    {"command": "bun run verify:packet P07", "exitCode": 1,
     "receipt": "honest failure: MISSING tests/preview-access.integration.test.ts"},
    {"command": "bun run verify:packet P99", "exitCode": 1,
     "receipt": "honest failure: unknown packet"},
    {"command": "bun run test:live -- P04", "exitCode": 1,
     "receipt": "BLOCKED without CADDIE_LIVE_AUTHORIZED=1"}
  ],
  "artifacts": [{"path": "apps/app/dist/composition-manifest.json",
                 "note": "collisions: [], spa.scanned/landing.scanned > 0 asserted by tests/routing.test.ts"}],
  "environment": "local workerd via `vite preview` (miniflare), bun 1.4.0, node v26.3.0, macOS arm64; @flue/* 2.2.2 pinned, @cloudflare/vite-plugin 1.39.2, vite 8.0.14, wrangler 4.113.0",
  "providerCalls": "none",
  "specReview": "PASS (independent subagent; 9 acceptance items verified incl. live HTTP spot-checks)",
  "qualityReview": "PASS (independent subagent; 8 findings fixed and RECHECK: PASS)",
  "limitations": [
    "browser/live tests not applicable to P00 (test:browser -- P00 reports NOT APPLICABLE, exit 0)",
    "agents mount but do not execute under the preview harness (flue 2.2.2 startActiveSpan bug — documented in docs/flue-contracts.md); agent execution evidence belongs to P05",
    "landing assets resolution loop becomes meaningful in P16"
  ]
}
```

```json
{
  "packet": "P01", "status": "LOCAL VERIFIED — real OAuth callbacks BLOCKED on owner credentials", "sha": "c41dc19 (branch), integrated b1b4d4e",
  "commands": [
    {"command": "bun test tests/auth.integration.test.ts", "exitCode": 0,
     "receipt": "14 passed — real workerd + local D1 + in-process stub provider; forged-state/replay, session fixation/expiry/logout, invite allowlist both ways, explicit linking preserves identity, GitHub scopes read:user user:email asserted"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "12 passed with auth router mounted (post-integration)"},
    {"command": "bunx playwright test tests/browser/auth.spec.ts", "exitCode": 0, "receipt": "2 passed — sign-in buttons render, error state visible"},
    {"command": "bun run verify:packet P01", "exitCode": 0, "receipt": "14 test(s) passed"},
    {"command": "bun run typecheck", "exitCode": 0}
  ],
  "artifacts": [{"path": "apps/app/migrations/0001_product.sql", "note": "identity tables = Better Auth 1.7.7 migrator output, byte-matched to tests/fixtures/auth-schema.sql"}],
  "environment": "local workerd + local D1 (miniflare), better-auth 1.7.7 (Kysely adapter on D1 binding)",
  "providerCalls": "none (stub provider inside workerd — OAuth boundary SIMULATED)",
  "specReview": "PASS (independent subagent; 8 acceptance items verified; noted: session.ts plan-slot not materialized — mechanics live in auth.ts; forged-state test cannot attribute rejection to state-validation specifically; empty-allowlist fail-closed documented but untested; staging verification owed when credentials arrive)",
  "qualityReview": "PASS (independent subagent; P2 fixed: test-only env knobs now require AUTH_TEST_MODE=1 or createAuth throws; P3s fixed: dead mount helpers removed, DDL-drift guard added, /tmp log cleanup; P3s noted: app.ts typing honesty kept as deployment contract, browser error-path env-sensitivity acknowledged, emailVerified hardening deferred to P02/P03 authorization work)",
  "limitations": [
    "SPIKE PASSED: Better Auth 1.7.7 accepts the D1 binding directly (bundled Kysely adapter); documented at better-auth.com/docs/concepts/database",
    "PLAN DRIFT (recorded, packets.md is owner-amended only): packets.md P01 file list names src/server/session.ts; session mechanics live in auth.ts instead — feature-ledger C18 destination updated to match reality",
    "session secret is dedicated BETTER_AUTH_SECRET — audit defect #5 (derive-from-model-key) verified absent",
    "real Google/GitHub callbacks BLOCKED pending owner-provided OAuth registrations + BETTER_AUTH_URL; callback URLs documented in docs/setup/auth.md",
    "lead integration diff (b1b4d4e): auth router mounted at /api, SignInPanel in SPA scaffold, identity DDL seeded into 0001_product.sql"
  ]
}
```

```json
{
  "packet": "P16", "status": "LOCAL VERIFIED (rework per amendment 3054ee2)", "sha": "see git log feat(p16): port pit-board landing",
  "commands": [
    {"command": "bun run build", "exitCode": 0},
    {"command": "bunx playwright test tests/browser/landing.spec.ts", "exitCode": 0, "receipt": "13 passed — pit-board structure, amber kickers rgb(240,168,60), honesty band, stackgrid disclosure, availability honesty, invariants (static-readable/no scripts, reduced-motion w/ control, keyboard/skip, 390px sections-in-viewport, metadata/no external URLs)"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "12 passed"},
    {"command": "bun run typecheck", "exitCode": 0},
    {"command": "typography slice (owner-directed): @fontsource/inter 400-700 + @fontsource/ibm-plex-mono 400/500 added to apps/site, imported in index.astro, bundled by Vite", "exitCode": 0,
     "receipt": "38 woff2 subset files in dist/_astro, zero external font URLs; document.fonts.check true for Inter 400/600 + Plex Mono 400/500; computed h1 = Inter 600, letterSpacing -3.08px (-0.035em), lineHeight 1.050; visual comparison vs caddie/docs/screens/landing-pitboard-top.png and landing-run-spine.png confirms tight-and-confident h1, legible 9px mono at 390px, visible 550/700 weight steps; port bug found+fixed: .pb had no base font-family (serif fallback) — font-family: var(--font-ui) added; reference mobile single-CTA rule ported (quiet topbar link hidden <=640px)"}
  ],
  "artifacts": [{"path": "apps/site/dist/index.html", "note": "pit-board port: run-spine (6 acts, sticky rail), honesty rails, card band, stacks band, request-access close; zero <script> tags; mailto placeholder marked in shipped HTML"},
                {"path": "apps/site/dist/_astro/*.woff2", "note": "38 self-hosted font subsets (Inter 400/500/600/700, IBM Plex Mono 400/500) — no runtime font fetches"}],
  "environment": "local workerd via vite preview (playwright webServer), chromium; composed build; @caddie/ui halo tokens",
  "providerCalls": "none",
  "specReview": "PENDING — independent reviewers blocked by provider rate limit (resets 2026-10-10); re-review scheduled",
  "qualityReview": "PENDING — same",
  "limitations": [
    "AMENDMENT 3054ee2 SUPERSESSION: the atmospheric-blue landing (merged earlier same-day) is replaced by this pit-board port; blue site token set retired",
    "DEPENDENCY AMENDMENT: halo token port (packages/ui/src/tokens.css) pulled forward from P06 — feature-ledger row C1 updated; P06 still owns Markdown.tsx, time.ts and app-side verification",
    "reveal-on-scroll/scroll-spy from the reference intentionally NOT ported (client JS) — static readability without scripts is an acceptance invariant",
    "mailto contact uses placeholder hello@example.com — OWNER INPUT needed before public deployment (marked in shipped HTML)",
    "hero art is illustrative composition (plan amendment) — real captures require a real accepted build (P09)"
  ]
}
```
