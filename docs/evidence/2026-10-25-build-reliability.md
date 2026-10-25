# Build reliability — evidence ledger

Living evidence record for the build-reliability wave (execution plan
`docs/plans/2026-10-25-build-reliability-execution.md`). Each packet appends its
own section. Classify every row: LOCAL VERIFIED · LIVE VERIFIED · SIMULATED ·
DOCUMENTATION ONLY · BLOCKED · FAILED.

## B00 — Baseline (2026-10-25)

### Checkout / runtime identity — LOCAL VERIFIED

| Fact | Value |
|---|---|
| HEAD | `f76db95068c72b08c9b29e0922806cdff7da534e` (branch `main`) |
| Working tree | clean (0 changes) at capture |
| bun | 1.3.14 |
| node | v26.3.0 |
| `@flue/sdk` | 2.2.2 (pinned; patched `patches/@flue%2Fsdk@2.2.2.patch`) |
| `@earendil-works/pi-ai` | 0.87.1 |
| Migration head | `0046_model_call_usage.sql` → **B01+ new migrations start at 0047** |

### Baseline regression suites — LOCAL VERIFIED

`bun test tests/build-workflow.test.ts tests/workflow-dispatch.test.ts tests/sandbox-durability.test.ts tests/build-spend.test.ts`

**136 pass / 0 fail · 929 assertions · 4.27 s.** No pre-existing red in the B00
scope. The resume-aware repair-window fix (R00) is independently re-verified:
`tests/build-workflow.test.ts:1446` ("retry preserves evidence, is idempotent,
and allows only three new failures") and `:2094` ("resuming a feature opens a
fresh new-test repair window without deleting earlier failures"), both using
`workflowRepairPause(db, runId)` (resume-aware), not the lifetime per-issue
count.

## Pinned failure boundaries (from the incident report, located in HEAD)

The research report's three failure classes, traced to concrete code so B01 can
reproduce each at its real boundary (not a model-usage duration alone).

### F1 — Reasoning starved the output cap (FIXED, re-confirm in B01)
- **Symptom:** delegates returned "(task completed with no text)"; five
  `model_call_usage` rows cut at exactly 8,192 output tokens; no test files
  written → `finish_feature` behaviour-tests gate failed.
- **Boundary:** per-route `maxTokens` in `apps/app/src/agents/providers.ts`
  (`createProvider` → `models[].maxTokens`, line ~460) vs the `reasoning: true`
  + `max` reasoning effort policy (`providers.ts:331`). Output cap must leave
  room for tool arguments after reasoning.
- **Status:** caps already raised (Super VL/Ultra 8192→32768, Lightning
  4096→8192). B01 must keep an empty-result/finish-reason test so a future cap
  regression is caught; do NOT lower caps to satisfy a timer (plan B02 A.2).

### F2 — A delegate hung 103 min (6,189,040 ms) then errored — OPEN, headline bug
- **Symptom:** one `model_call_usage` row `0/0 tokens, isError=1,
  durationMs=6189040`. Nothing bounds a single delegated specialist's
  wall-clock.
- **Boundary:**
  - `apps/app/src/agents/specialists.ts` — delegate definitions pass an
    `AbortSignal` into `verifyBuild`/`runChecks` (lines 77, 79) but there is
    **no wall-clock deadline on the delegate `task()` itself**.
  - `apps/app/src/agents/coordinator.ts:711-712` — the ONLY current bound is
    Flue's submission `timeoutMs` ("Flue aborts and settles a submission past
    timeoutMs; the app's stall watchdog reports it"), via
    `Coordinator.durability = COORDINATOR_DURABILITY`.
  - `apps/app/src/server/build-workflow.ts:916` — `BUILD_STALL_MS = 20 * 60_000`
    (20 min); `reconcileStalledBuild` (`:944`, idle check `:954`) is the
    fallback, driven by the cron sweep in `apps/app/src/cloudflare.ts:55`
    (`sweepStalledBuilds`).
- **Gap:** the submission timeout is not observed by an application hook
  (`COORDINATOR_DURABILITY`); the 20-min watchdog is a coarse fallback, not a
  per-request / per-stream-idle / per-specialist deadline. B02 §A adds the
  layered deadlines; B01 reproduces the hang with a fake clock.

### F3 — Transient provider errors surface un-retried — OPEN
- **Symptom:** a coordinator chat call errored in 46 ms (`isError=1, 0/0`); a
  GLM probe got HTTP 529 "System is overloaded" needing manual retries.
- **Boundary:** `apps/app/src/agents/providers.ts` `createProvider({...})`
  (line ~442) sets `id/baseUrl/auth/models/api` but **no retry/backoff config**;
  grep for `maxRetries|retry|backoff|429|529|Retry-After` in `providers.ts`
  returns zero matches. The installed pi-ai adapter's effective retry config
  must be established in B01 before claiming "zero retries" (plan reconciliation
  note), then B02 §B wires ONE coordinated transient-retry policy (≤2 retries
  after the original, respect Retry-After within the deadline).

## Scenario → test index (B01 will create/extend these)

| Scenario (fault) | Class | Target test file | Status |
|---|---|---|---|
| Interrupted edit / check mid-operation | F2-adj | `tests/build-fault-recovery.test.ts` (new) | pending B01 |
| Duplicate delivery after remote accept | inv.1 | `tests/build-fault-recovery.test.ts` | pending B01 |
| Late completion after Stop | inv.4 | `tests/build-fault-recovery.test.ts` | pending B01 |
| Lost / unknown receipt | inv.2 | `tests/build-fault-recovery.test.ts` | pending B01 |
| Provider 429/529 rate limit | F3 | `tests/providers.test.ts` (extend) | pending B01/B02 |
| Exhausted quota / budget | inv.4 | `tests/build-spend.test.ts` (extend) | pending B01 |
| HTTP request never resolves (fake clock) | F2 | `tests/build-deadlines.test.ts` (new) | pending B02 |
| Stream stalls after starting (idle) | F2 | `tests/build-deadlines.test.ts` | pending B02 |
| Specialist never settles | F2 | `tests/build-deadlines.test.ts` | pending B02 |
| Delayed command cancellation | inv.4 | `tests/build-deadlines.test.ts` | pending B02 |
| Output-cap truncation | F1 | `tests/build-empty-result.test.ts` (new) | pending B02 |
| Empty answer after successful tools | F1 | `tests/build-empty-result.test.ts` | pending B02 |
| Empty no-progress answer | F1 | `tests/build-empty-result.test.ts` | pending B02 |
| Restart during verification | B05 | `tests/sandbox-durability.test.ts` (extend) | pending B01 |
| Repair-window: 3 post-resume failures | R00 | `tests/build-workflow.test.ts:1446/:2094` | **LOCAL VERIFIED** |

## Farmhand read-only state — LOCAL VERIFIED (2026-10-25)

No CURRENT Farmhand build row exists in this checkout to read. `apps/app/.wrangler`
holds only old/backup dev state — `state.bak-20261014-122714/` (2026-10-14) and
`state/integration-20261020/` (2026-10-20) — not a live build from the 2026-10-25
incident. Read-only listing only; nothing resumed, stopped or modified. The
authoritative incident evidence therefore remains the research report's
`model_call_usage` observations (F1/F2/F3 above), not a replayable local row.

## B01 fault seams already present in the harness — LOCAL VERIFIED

`tests/fixtures/sandbox-stub.ts` already exposes the deterministic injection
points B01 wraps into named scenarios (reuse, do not reinvent):
- `setBehavior(match, { delayMs, exitCode, stdout, stderr, writes })` — per-command
  outcome + latency + files written (the "interrupted edit / slow op" seam).
- `chaos.resetNextDispatch` — a lost dispatch response: the instance still runs
  remotely and commits an image we never learn (the honest divergence = lost
  receipt, inv.2).
- `chaos.ignoreCancel` — a cancel the remote ignores (late-effect-after-Stop seam,
  inv.4), see `sandbox-stub.ts:488`.
- `loseImage(uuid)` / `loseBuiltImages()` — image eviction after a long pause
  (restart-during-verification seam, B05).

B01 adds `tests/support/build-faults.ts` as named scenario builders over these,
plus fake-clock helpers for the F2 deadline cases (no real waits).

## F3 — pi-ai effective retry config — LOCAL VERIFIED (2026-10-25)

Read from the installed source (`node_modules/.bun/@earendil-works+pi-ai@0.87.1
+877b9547232df586/.../pi-ai/dist/`). **Corrects the incident report's
"single-shot / zero retries, add a wrapper" framing.**

- The `openai-completions` chat path Caddie uses (`api/openai-completions.js:197`)
  wraps the request in `retryProviderRequest(...)` and calls the OpenAI SDK with
  `maxRetries: 0` (line 195) — delegating retry to pi-ai's own wrapper.
- `utils/provider-retry.js`: the wrapper defaults **`maxRetries = options.maxRetries ?? 0`** (line 76). It retries 408/409/429/5xx only (`isRetryableProviderError`, lines 17-20), honours `retry-after-ms` then `retry-after` headers (lines 30-40), caps delay at `DEFAULT_MAX_RETRY_DELAY_MS = 60_000` (line 1), and is abortable via `options.signal`.
- Caddie's `apps/app/src/agents/providers.ts` `createProvider({...})` passes **no `maxRetries` / `maxRetryDelayMs`** → the effective retry count is **0**.

**Conclusion:** the transient-retry machinery is fully present and
spec-correct (429/5xx + Retry-After + bounded delay + abort). It is simply
**unconfigured** (0 retries). So B02 §B is a CONFIG wiring task — thread
`maxRetries` (≤2) and `maxRetryDelayMs` through the per-role model options and
coordinate with the absolute deadline — **not** a new retry loop. Do NOT stack a
second independent retry wrapper around this one (plan B02 §B.1).

## B00 — COMPLETE

Baseline green (136/0), runtime identity captured, F1/F2/F3 pinned to code,
F3 retry config settled from source, Farmhand confirmed reference-only. No
source edits, no commits in B00. Proceed to B01.

## Notes
- No paid inference in B00. The 23-request model preflight is separate,
  already-authorized evidence in `docs/evidence/2026-10-25-model-validation/`.
- Local fault tests (B01/B02) use fake clocks and controlled adapters — never
  real multi-minute waits or paid calls.

## B02 — close-out (2026-10-25)

Commits this wave (all LOCAL VERIFIED, test-first, mutation-proven where a fix
was involved):

| Commit | Section | What |
|---|---|---|
| `77c194a` | B01 | lock operation-identity + receipt invariants (inv.1/2/4 row level) |
| `8878294` | B02 §A | pure layered deadline policy (`build-deadlines.ts`) |
| `dc6e0e9` | B02 §A | enforce the absolute build deadline in the stall watchdog (WIRED) |
| `c3d7675` | B02 §B | bounded transient retry for direct helper model calls (WIRED) |
| `e32864a` | B02 §C | classify empty delegate results (`build-empty-result.ts`) |
| `c184c29` | B02 §C | guard the build loop against empty-delegate re-delegation (WIRED) |
| `504b3e1` | B02 §D | lock late-effect fencing at finish + publish (regression lock) |

### Per-request / stream-idle deadline — why no extra wiring (LOCAL VERIFIED reasoning)

The plan's B02 §A asks for request, stream-idle and specialist deadlines. A
single model REQUEST is already bounded in the live path, so the policy
`build-deadlines.ts` encodes is the decision layer, not a missing enforcer:

- `COORDINATOR_DURABILITY = { timeoutMs: 60*60_000, maxAttempts: 3 }`
  (`permissions.ts:183`) bounds a submission; Flue aborts and settles past it
  (`coordinator.ts:711`).
- Flue's runtime retries transient model failures itself
  (`MAX_TRANSIENT_MODEL_RETRIES = 3`, `@flue/runtime` conversation-stream) over
  pi-ai's `retryProviderRequest` (429/5xx + Retry-After + 60s cap).
- Flue cross-process abort is durable and enforced (flue-contracts: 5.3–6.6s to
  terminal-aborted, resurrection blocked).

The real missing layer was the ABSOLUTE build deadline — a build that kept
emitting intermittent activity reset the 20-min idle watchdog and could outlive
its admitted hour (the 103-min incident). That is now closed host-side
(`dc6e0e9`). `build-deadlines.ts`'s request/stream-idle verdicts remain the
policy the host would consult if it ever drove its own request loop; wiring a
second per-request timer over Flue's would violate plan §B.1 (no stacked
bounds), so it is deliberately NOT added.

### Scenario → test index — B02 status

| Scenario | Class | Covered by | Status |
|---|---|---|---|
| Duplicate receipt replay is a no-op | inv.2 | build-fault-recovery.test.ts | **LOCAL VERIFIED** |
| Different receipt on settled row = conflict | inv.2 | build-fault-recovery.test.ts | **LOCAL VERIFIED** |
| One logical effect = one identity | inv.1 | build-fault-recovery.test.ts | **LOCAL VERIFIED** |
| Ambiguous dispatch → reconciliation-required | inv.2 | build-fault-recovery.test.ts | **LOCAL VERIFIED** |
| Request/specialist never resolves (103-min hang) | F2 | build-deadlines.test.ts + build-workflow.test.ts (absolute deadline) | **LOCAL VERIFIED** |
| Stream stalls / chunk can't extend hard deadline | F2 | build-deadlines.test.ts | **LOCAL VERIFIED** |
| Absolute deadline survives restart | F2 | build-deadlines.test.ts | **LOCAL VERIFIED** |
| Transient 429/529 un-retried (helper path) | F3 | helper-model-call.test.ts | **LOCAL VERIFIED** |
| Output-cap truncation / empty-after-tools / no-progress | F1 | build-empty-result.test.ts | **LOCAL VERIFIED** |
| Build loop re-delegates an empty hand-off | F1 | build-empty-delegate.test.ts | **LOCAL VERIFIED** |
| Late effect after Stop can't advance/publish | inv.4 | build-workflow.test.ts (§D lock) | **LOCAL VERIFIED** |

B02 §A–§D addressed. Next: B03 — progress detection by content fingerprint.

## B03 — close-out (2026-10-25)

Commit `501aaaf` (pure `8878294`-style policy `f4e1e7e` + wiring + migration).
Repeat guard now compares file CONTENT (sha256), not byte count: equal-length
different edits proceed, identical rewrites and alternating cmd/error loops
stop. Append-only migration `0047` adds `build_activity.contentHash` (a hash,
never contents). LOCAL VERIFIED, mutation-proven.

## B04 — close-out (2026-10-25)

Commits `7df8512` (pure `feature-acceptance.ts`) + `db376a4` (wiring).

- finishFeature's `passing <= baseline` reject is replaced by
  `acceptanceVerdict`: a dropped count rejects (weakened/deleted baseline), a
  grown count accepts, and a FLAT count accepts only when this feature repaired
  a real host check that was failing.
- **Repair signal:** a prior FAILED `run_rounds` row for this feature on a real
  check (`issue LIKE '<featureId>:%' AND issue <> '<featureId>:new-tests'`).
  NOT `attempts > 0` (too loose — the full suite caught that: a feature that
  only failed the new-tests gate repaired nothing and must still add coverage).
- **Honest limitation (documented, not faked):** host-check receipts carry
  per-check pass/fail + passed/baseline COUNTS, not per-test NAMES. So "a named
  test exists per doneWhen criterion" is NOT enforced — it needs per-test
  identity the host does not record today. Recorded as a follow-up, not claimed.

LOCAL VERIFIED, mutation-proven; full build-workflow + feature-acceptance 105/0.


## B05 — close-out (2026-10-25)

Commits: pure `build-resume-context.ts` (`restoreCompatibility`) + wiring
`20c7201`.

- On a cold restart `openWorkingCopy` rebuilds scope + run and re-opens the
  saved working copy. A Restore pointer (`build_sandbox_sessions`) carries the
  image saved at rollback time; the reopen used `override.image` with no
  comparison to the image the run now expects, so a recipe/image bump between
  sessions silently rebuilt on a stale base.
- `restoreCompatibility({expectedStack, restoredStack, expectedCheckpointRef,
  availableCheckpointRef, expectedRecipeVersion?, restoredRecipeVersion?})`
  refuses effects on a stack mismatch, a missing/moved verified checkpoint, or
  a known recipe-version drift; an absent recipe version (legacy run) is not a
  blocker, and a first feature with no checkpoint is compatible.
- **Wired at `openWorkingCopy`** — then REVERTED (`git revert 20c7201`). The
  wiring used `override.image != ctx.baseImage` as the drift signal, but that
  inequality is the NORMAL rollback case: a rollback deliberately reopens on a
  prior save-point image, which differs from the current `baseImage` by design.
  The guard therefore rejected 5 legitimate restore/rollback/parts flows with
  `RESTORE_INCOMPATIBLE`. Image alone cannot distinguish a deliberate rollback
  from stale-recipe drift — that needs a recipe/stack version recorded on the
  `build_sandbox_sessions` pointer, which does not exist today. Caught by the
  full build-workflow suite before it could ship; reverted rather than weaken
  the test or break rollback.
- **FOLLOW-UP:** add a `recipeVersion` (and/or stack) column to
  `build_sandbox_sessions`, populate it at save time, then wire
  `restoreCompatibility` safely — it can then tell a same-recipe rollback
  (allowed) from a cross-recipe drift (refused). The pure guard already
  implements that decision; only the pointer identity is missing.
- **Honest scope:** in-process one run maps to one stack maps to one image
  family, so the stack dimension is construction-safe. The pure
  `restoreCompatibility` unit + its 7/0 test REMAIN committed as the
  enforcement point once the pointer records recipe identity.

B05 landed as PURE-GUARD-ONLY. Pure unit LOCAL VERIFIED, mutation-proven
(`build-resume-context.test.ts` 7/0); wiring reverted; build-workflow back to
107/0.

---

### Session close-out (2026-10-25) — B00–B05 shipped

B00–B05 of the build-reliability plan are complete, each test-first and
mutation-proven. B06 (device-capture visual fidelity + folded craft-skills),
B07 (truthful progress + release gate), B08 (benchmark — paid, gated) remain
and were deliberately NOT opened near the patrol-budget cap rather than left
half-done.

## B06 — close-out (2026-10-25)

Verify the delivered app and its design. The existing `visual-fidelity.ts`
gate already covered most of B06; the work was to find the real gaps rather
than re-implement what holds.

- **B06.1/.2/.5 — already satisfied.** `reviewVisualFidelity` captures both
  real viewports, validates every capture (hash/viewport/freshness), treats a
  missing port as `not-checked` (never a pass), never turns an invalid compare
  or a browser failure into a pass, leaks no provider-error secrets, and
  propagates cancellation. Covered by the 8 existing `visual-fidelity.test.ts`
  cases — not re-wired.
- **B06.4 — enforced upstream (documented, not re-wired).** A design change
  returns to review rather than silently rewriting the target: the visual check
  runs behind `requireBuildApproval`, which re-reads approval before effects and
  denies expired/revoked, and `approvedDesignRevisionId` is read fresh at verify
  time. Tested: `build-workflow.test.ts:666` (expired/revoked re-read and denied
  before effects), `:720` (forged phase cannot bypass review). A staleness guard
  inside the visual checker would be dead code.
- **B06.3 — pure helper shipped (`a9ea4d7`).** The gate compared only the first
  html-mock, so a broken error/empty/recovery state could pass behind a good
  home screen. `approvedAppearanceDocuments(body)` now yields one sandboxed
  document per titled designed state (the design format already allows one mock
  per screen OR state, e.g. "Today · empty"), capped at
  `MAX_APPEARANCE_STATES=4`. `approvedAppearanceDocument` delegates to the first,
  so single-mock designs are unchanged (8 existing tests stay green). 9/0,
  mutation-proven, typecheck clean.
- **B06.3 capture — honest boundary (follow-up).** Multi-state *capture of the
  built app* is NOT pure-wireable: `builtDocument` at the call site
  (`coordinator-host.ts:1462`) is a single render of the running app, and
  driving it into each state needs real browser interaction. Comparing N
  approved states against one built render would false-flag every non-home
  state. Recorded as browser-spec scope (`tests/browser/visual-fidelity.spec.ts`)
  rather than shipped as a wire that would make the gate lie.

## B07 — close-out (2026-10-25)

Truthful progress + release gate. The surfaces already carried honest copy in
places; the work was to lock the invariants and fix the real gaps found.

- **B07.1 — header tied to authoritative state (`9f2079e`).** The build header
  read "Ready to try" from `workflow.phase === 'ready'` alone, so a ready row
  whose preview was withdrawn (`previewId` null) still told a nontechnical user
  the app was ready. New pure `workflowHeaderStatus` gates "Ready to try" on an
  actual `previewId`; a ready phase with no preview reads "In progress". Every
  other branch unchanged. 15/0, mutation-proven, typecheck clean.
- **B07.2 — failure text is truthful, never asks the user to debug (`c085e82`).**
  Pure `buildFailureMessageOk` locks every user-facing build-failure message:
  it must say what is SAVED, give a NEXT step, and carry no debug/secret jargon
  (stack trace, exit code, stderr, token, …). The corpus test over the real
  blocker strings SURFACED a genuine gap — the visual-repair blocker named what
  was saved but not what happens next — now fixed to end "…The app is not ready
  to try yet." 6/0, mutation-proven.
- **B07.3 — resilience under fault (browser-spec, documented).** Refresh,
  reconnect, long history, project-switching and mobile checks live in
  `tests/browser/{focused-project-chat,chat-responsiveness,project-workflow}.spec.ts`
  (100 lines matching reload/reconnect/refresh/mobile/viewport/overflow/offline).
  These are the B07.3 checks; running them live needs a composed build + browser
  and is browser-harness scope — documented as existing coverage, not faked. The
  earlier overflow/layout fixes in `BuildProgress.tsx` / `workspace.css` /
  `project-review.css` are preserved.
- **B07.4 — release gate.** Root `bun run typecheck` clean; all affected unit
  suites green (project-status, visual-fidelity, build-failure-message,
  feature-acceptance, build-resume-context = 42/0; build-workflow 107/0 from
  B05). The composed `bun run build` was DEFERRED under sustained host
  memory-pressure/load (8–22/core across cycles) — forcing a full Astro+Vite
  build on a thrashing host proves nothing; to be run on a calm host as the
  final integration confirmation. Recorded honestly, not claimed.
