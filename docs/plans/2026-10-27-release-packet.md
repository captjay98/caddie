# Release packet — 27 October 2026 (prepared, NOT deployed)

Plan step 6 (judge readiness and deployment) deliverable: the concrete packet a release
decision reviews, and the exact gates that still refuse a deploy. Nothing was uploaded,
published, or changed anywhere remote ("deploy-preflight: Not ready to deploy. Nothing
was uploaded or changed.").

## What would ship (this tree, on top of HEAD 5824450)

- Post-ready change lifecycle (migrations 0056 and 0057; scoped proposal, approval,
  change-aware blocker/stop/publish and blocked-finished-app recovery). The local
  saved Farmhand version contains the heading change; the current saved version does
  **not** contain the reported demo-spine fixes. See [read-only reconciliation](../evidence/2026-10-27-farmhand-current-snapshot.md).
  The proposal lifecycle has now been driven through a paid real rebuild once
  (heading change: request → scoped proposal → hash-bound approval → checks green →
  new preview `out_569b9266…`, previous output retained byte-identical). The safety
  change `chg_26653b84…` (sign-in scoping, atomic mortality/medication steps, stock
  validation, navigation, feed/triage honesty) was approved through the same flow and
  its rebuild was in flight at report time — see the change evidence doc for its
  outcome before relying on it.
- Honest deadline presentation (no invented closing time; visible confirm-the-hour line;
  source citation). 
- Brief unread strip removal (count + Mark-all-read in the feed header).
- Model-role split per the owner's 2026-10-27 decision (planAuthor=deepseek-v4.1-flash-
  1017, planReviewer=glm-5.3, designAuthor=minimax-m3.1-flash registered with live-checked
  catalog values, legacy `plan` kept; family-level self-review fencing in the quality
  gate). 
- Deadline + change-lifecycle regression tests; providers/quality tests updated.

## Gates that run before any deploy — current status

| Gate | Status |
|---|---|
| `bun run typecheck` | PASS |
| `bun run build` (dev-shaped) | PASS — a deploy needs `CLOUDFLARE_ENV=production bun run build` (preflight FAILs on the dev-shaped dist by design) |
| Full unit suite | **2,841 pass / 0 fail (246 files; 12,882 expectations)** on the 2026-10-28 locally verified tree. |
| Browser/runtime acceptance | REL26's Worker-backed browser acceptance integration passes 7/7; this verifies the fixture journeys, not the blocked Farmhand safety rebuild or hosted judge flow. |
| `bun scripts/deploy-preflight.ts` | **FAIL (by design today)**: dev-shaped dist, production routes not carried, and the hosted preview values are unset |
| Production smoke + rollback | DOCUMENTATION ONLY (runbook) — never run against production |

## What only the owner can do before a real deploy

1. **Hosted preview origin** (runbook `docs/runbooks/production-deploy.md`, "Once",
   step 5): a dedicated preview zone with a wildcard route
   (`*.previews.example.net/*`), `PREVIEW_BASE_URL` on that zone, and a separate
   32+ char `PREVIEW_SIGNING_SECRET`. Without these, every web build in production
   pauses at "Caddie could not prepare the isolated preview" — deploying before this
   would regress ready-app production flows. Cloudflare dashboard/DNS work.
2. **Separate production keys** (preflight WARN): NEBIUS/TAVILY/CONTREE tokens
   currently match local; separate keys keep judging spend separate and revocable.
3. **The explicit release go** under the established procedure, then post-deploy
   verification of the deployed SHA + authenticated journeys + rollback readiness.

## Judge-readiness status

- Local: the heading-change version (`out_569b9266…`, commit `56ae4b44…`) was journey-
  checked in a real browser. The safety change (`chg_c63b35d9…`: sign-in scoping, atomic
  mortality/medication steps, stock validation, navigation, feed/triage honesty) was
  approved through the full proposal flow but its rebuild is BLOCKED by the local
  runtime's wake/recovery gap (zombie external_operations + miniflare wake stall —
  see `docs/evidence/2026-10-28-farmhand-safety-change-blocked.md`). Until it lands with
  same-version journey evidence, the safety repairs remain UNVERIFIED on the current
  preview, and Farmhand must not be represented as judge-ready.
- Recheck on 2026-10-28 against that exact saved output reconfirmed the preview loads,
  but **Add stock item still returns to Home** and Feed still displays an unlabelled
  `14 g/bird/day` estimate with zero inventory. The safety-change build remains the
  required next step; see the current-version evidence section in the linked report.
- The hosted judge path (fresh judge account → seeded example → shareable URL) is
  NOT verified: it requires the deployed candidate above. Never wipe judge accounts to
  reseed; use fresh test accounts.
- The preview FRAME host bug in the workspace is the parallel session's in-flight fix;
  the launch→isolated-document API chain it depends on is verified working.

## Continuation checkpoint — 28 October 2026

ZCode session `session_4837f3958729dd9cbd13e26bd4f63fba` stopped after the full
suite was reported as 2,838 passed / 0 failed; its next model turn hit the GLM-5.3
usage limit. The remaining paid Farmhand rebuild, same-version browser journey, and
final release decision were not completed. The real saved preview was re-opened in
this continuation and the unresolved inventory/feed gaps were confirmed; see the
LOCAL VERIFIED evidence in `docs/evidence/2026-10-28-farmhand-safety-change-blocked.md`.

Checks run in this continuation:

- `bun run typecheck` — PASS.
- `bun test tests/task-recovery.test.ts tests/build-workflow.test.ts tests/build-fault-recovery.test.ts` — 138 passed, 0 failed.
- `bun test tests/preview-location.test.ts` — 3 passed, 0 failed.
- `bunx playwright test tests/browser/interactive-preview.spec.ts` — BLOCKED before useful test execution: the local Vite preview server could not write its Wrangler log/registry under `~/Library/Preferences/.wrangler` (`EPERM`). This is an environment permission issue; it is not a product assertion failure. Prior browser evidence remains separate.
- The last reported full suite (2,838/0) and `bun run build` are from the stopped session and were not rerun here.

No source changes, paid calls, data resets, deployment or publication were made in
this continuation. Next: resolve the safe local Flue/Miniflare recovery issue without
guessing external-operation outcomes; then obtain authorization and a spend boundary
before any new paid generation, run a new immutable Farmhand output through the real
inventory/medication/feed/triage journeys, and refresh the release packet from that
same output. Production deploy remains out of scope until the owner's hosted preview
configuration and explicit release go are present.

## Final local recheck — 28 October 2026

The latest source adds Flue admission-receipt preservation for new server dispatches.
`bun run typecheck`, `bun run build` (dev-shaped), `bun run test` (2,841/0 across 246
files), and `bun run verify:packet REL26` (27/27 mapped tests, including 7/7 browser
acceptance integration) pass locally. Wrangler fixtures required permission to write
temporary registry/log files outside the repo; this is only a local harness prerequisite.

This does not resolve the old Farmhand run's four receipt-less reconciliation rows and
does not unblock its approved safety-change rebuild. No paid build, database mutation,
reset, deployment or publish was performed. The saved output remains the one whose
inventory-add and feed-estimate gaps are documented above, so it is not judge-ready.
See [current blocked-build evidence](../evidence/2026-10-28-farmhand-safety-change-blocked.md).
