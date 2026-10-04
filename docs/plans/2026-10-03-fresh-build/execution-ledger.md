# Execution ledger

Planning only. No packet implemented. Keep status, evidence, review verdicts and integrated SHA current.

| Packet | Status | Owner | Spec review | Quality review | Evidence / SHA |
|---|---|---|---|---|---|
| P00 | LOCAL VERIFIED | Integration lead (coordinator) | PASS | PASS (RECHECK: PASS after fixes) | 879e0f1 |
| P01 | NOT STARTED | Unassigned | Pending | Pending | — |
| P02 | NOT STARTED | Unassigned | Pending | Pending | — |
| P03 | NOT STARTED | Unassigned | Pending | Pending | — |
| P04 | NOT STARTED | Unassigned | Pending | Pending | — |
| P05 | NOT STARTED | Unassigned | Pending | Pending | — |
| P06 | NOT STARTED | Unassigned | Pending | Pending | — |
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
  "packet": "P16", "status": "LOCAL VERIFIED (rework per amendment 3054ee2)", "sha": "see git log feat(p16): port pit-board landing",
  "commands": [
    {"command": "bun run build", "exitCode": 0},
    {"command": "bunx playwright test tests/browser/landing.spec.ts", "exitCode": 0, "receipt": "13 passed — pit-board structure, amber kickers rgb(240,168,60), honesty band, stackgrid disclosure, availability honesty, invariants (static-readable/no scripts, reduced-motion w/ control, keyboard/skip, 390px sections-in-viewport, metadata/no external URLs)"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "12 passed"},
    {"command": "bun run typecheck", "exitCode": 0}
  ],
  "artifacts": [{"path": "apps/site/dist/index.html", "note": "pit-board port: run-spine (6 acts, sticky rail), honesty rails, card band, stacks band, request-access close; zero <script> tags; mailto placeholder marked in shipped HTML"}],
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