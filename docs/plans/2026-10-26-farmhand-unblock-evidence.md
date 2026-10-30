# Farmhand demo build — feature-3 unblock investigation

> **Historical snapshot, not the current project state.** Farmhand subsequently
> reached a saved `ready` output. See [the later read-only reconciliation](../evidence/2026-10-27-farmhand-current-snapshot.md)
> for exact output and version identifiers. That later record does not establish
> that the demo journeys or the current deployment have passed acceptance.

- **Project:** `proj_506d61ece6d7ca3a12fdd9a41a281960` (Farmhand demo, standard / react-hono stack)
- **Run:** `run_506d61ece6d7ca3a12fdd9a41a281960`  **Plan:** `pdr_5a801826-c745-4940-b035-99f77670c2fa`
- **Workflow phase:** `blocked`  **Repair policy:** `repair-v1`
- **Date:** 2026-10-26
- **Scope of this item:** diagnose read-only, confirm in code, make a *local platform* fix if one clears the block, otherwise return a precise `question`. **Local verification only — no deploys / pushes / paid calls / live-data destruction.**

All reads below were done read-only against the local D1 sqlite
(`apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c204843922…sqlite`, opened `?immutable=1`)
and against the tracked source. No build was run; no paid model call was made; nothing was published.

---

## 1. Build-loop mechanics (how a blocked feature resumes) — LOCAL VERIFIED (read)

Read `build-workflow.ts`, `build-features.ts`, `coordinator-host.ts`, `repair-escalation.ts`, `build-recovery.ts`, `feature-acceptance.ts`, `code-store.ts`, `build-sandbox.ts`.

- The feature loop is **host-owned**. The coordinator asks for the current feature (`build_next_feature`) and asks the host to pass it (`finish_feature`); the host passes it only when the fixed host checks (`dependencies` / `behavior-tests` / `bundle`, see `runHostChecks` in `coordinator-host.ts`) are green **and** the passing-test count grew (`acceptanceVerdict` in `feature-acceptance.ts`).
- A feature is **not** resumed by editing files locally. The generated app is built **inside a remote Contree sandbox** (`buildSandboxFromEnv` requires `CONTREE_BASE_URL` / `CONTREE_API_TOKEN` / `CONTREE_PROJECT_ID`; files are written with `driver.writeFile`, checks run with `driver.execute`). A blocked build resumes only when the owner presses **Retry**, which re-enters the host loop and **re-delegates the feature to a model** (paid) that rewrites files in the sandbox and re-runs the checks.
- The code store (where a passed feature's snapshot would be committed) is **empty for this project** — `select count(*) from local_code_commits` = `0`, `local_code_heads` empty. Caddie's server commits a snapshot only when a feature *passes* (`recordFeaturePassed`); feature 3 never passed, so **no generated source was ever committed locally**.
- `build_activity` stores file writes as **path + size + content hash only** (no source bytes; the table has a `contentHash` column and no output/body column). So the generated `src/App.tsx` and `src/mortality-medication.test.tsx` are **not** recoverable from the local DB.

**Consequence:** the generated materials that would need fixing live only in the remote sandbox. They cannot be read or edited from this machine.

## 2. Repair-ladder state for feature 3 — LOCAL VERIFIED (read)

`build_features` rows (read-only):

| pos | featureId | status | attempts | testsPassed |
|----:|-----------|--------|---------:|------------:|
| 1 | shared-backbone-crud | passed | 2 | 3 |
| 2 | offline-sync-queue | passed | 0 | 6 |
| 3 | **mortality-medication-logs** | **building** | **3** | — |
| 4–8 | mid-cycle-import … roles-visit-map | pending | 0 | — |

`build_repair_issues` for feature 3: `failures=3`, `requiresVision=0`, **`state='active'`** (not `exhausted`), `policyVersion='repair-v1'`.
`build_repair_attempts`: 3 attempts, routes `nemotron-3.5-super-vl, nemotron-3.5-super-vl, deepseek-v4.1-flash-1017`.

Reading `repairState` / `repairRoute` (`repair-escalation.ts`): `exhausted` (paused) needs **6** failures; this issue is at 3, so `paused=false` and **repair allowance remains** (next routes would be `deepseek`, then `glm-5.3`, up to 6 total). The workflow is therefore **not** paused by the repair ladder — the `blocked` phase was set by something build-wide (spend window / stall), consistent with `spend-instrument.ts` setting a build-wide blocker that `coordinator-host.ts` never touches.

## 3. Confirmed root cause — LOCAL VERIFIED (from the stored failing receipt)

The recorded `build_workflows.detail` says the block is a *test-authoring / DOM mismatch* (tests written without reading `App.tsx`). **The stored evidence refutes that.** The latest `behavior-tests` verification receipt (`run_verifications`, 2026-10-26T10:49:08Z, `bun run test`, exit 1) contains the full vitest output, including the rendered DOM. All three client tests fail for **one reason**: the generated app throws a runtime error and renders its **error boundary** instead of the UI.

Rendered DOM at the point of failure (verbatim from the receipt):

```text
<div aria-live="polite" class="error-banner" role="alert">
  <div class="message">
    <svg aria-label="Error" …/>
    current_count is not defined
  </div>
  <button class="retry">Retry</button>
</div>
<nav aria-label="Bottom navigation" class="tab-bar"> Home / Records / Medication / Inventory </nav>
```

vitest summary (ANSI stripped):

```text
src/mortality-medication.test.tsx:
(fail) mortality & medication records > Record a mortality event and see it reduce the cycle count
(fail) mortality & medication records > Record a medication with dosage and see it link to inventory
(fail) mortality & medication records > Filter the Records Timeline by log type (mortality, medication, vaccination)
src/mortality-medication-server.test.ts:
(pass) mortality-medication-logs API > …  (all 3 server tests pass)
 9 pass / 3 fail / 77 expect() calls — Ran 12 tests across 4 files.
```

**Root cause (in the generated product code, not the tests):** `src/App.tsx` references an **undefined identifier `current_count`** → `ReferenceError: current_count is not defined` at render → the app's error boundary renders → every client behavior test that mounts the app finds the error banner instead of "Current count" / the Records timeline, and times out at `waitForWrapper`. The 3 **server** tests pass because they don't mount `App.tsx`. The client tests are asserting reasonable user-visible behaviour; **they are not the defect.**

### Failure trajectory (why this was misdiagnosed) — LOCAL VERIFIED

Scanning every `behavior-tests` receipt for this run oldest→newest shows the failure mode **changed** across attempts:

- **2026-10-25 03:22 → 18:14 (early):** different failures — first "0 tests found" (test filename lacked `.test`), then a `DIAG > diagnose initial load` failure. This is the *original* phase the stale `detail` describes.
- **2026-10-26 00:09 → 10:49 (latest, current block):** `current_count is not defined` appears in **every** receipt. A repair attempt introduced (or failed to remove) a genuine runtime `ReferenceError` in `App.tsx`.

So the block the owner sees now is a **product bug**, and the recorded `detail` is **stale/incorrect** — it still blames the tests.

## 4. Option analysis against the task's (a)/(b)/(c) — LOCAL VERIFIED (reasoned from code + evidence)

- **(a) Fix the generated app's test/DOM directly on disk — NOT POSSIBLE LOCALLY.** The real fix is a one-identifier correction in the generated `src/App.tsx` (define/rename `current_count`, almost certainly meant to be the existing `currentCount`/count state). But that file exists **only in the remote Contree sandbox** — 0 local commits, no local workdir, no source bytes in `build_activity`. It cannot be read or edited from here, and writing it back requires `driver.writeFile` against the live sandbox.
- **(b) Re-run the build workflow for feature 3 — the correct unblock, but PAID.** Repair allowance remains (3 of 6), so a Retry would re-enter the host loop, refresh the model route (next: `deepseek-v4.1-flash-1017`, then `glm-5.3`), re-delegate feature 3, rewrite `App.tsx` in the sandbox, and re-run checks. This spends **paid model credits** and uses a **live sandbox** — explicitly out of this item's scope.
- **(c) Platform defect in how Caddie authors client tests vs the DOM — RULED OUT for this block.** The tests match plausible DOM; the app crashes before rendering it. There is a *separate* platform-quality observation (below), but no change to the test-authoring prompt/specialist would make these 3 tests pass while `App.tsx` throws — so **no local platform fix clears this specific block.**

## 5. Local platform fix made — NONE (DOCUMENTATION ONLY)

No local code change was made, because the defect is in remote-sandbox-only generated code and no platform change unblocks it. A branch, guard test, and mutation proof would be fabricated if claimed — so none are. (Platform verification scripts available if a fix were warranted: `bun run typecheck`, root `bun run verify:packet` / `bun run test`.)

## 6. Secondary platform finding (for a future item — NOT fixed here) — LOCAL VERIFIED (observation)

Worth the conductor's note, but **out of scope** for "unblock this demo":

1. **Stale `build_workflows.detail`.** It still blames test-authoring, while the live receipt shows a product-code `ReferenceError`. Any surface that shows `detail` to the owner is now misleading.
2. **Repair misdiagnosis loop.** The repair ladder treated a runtime `ReferenceError` in `App.tsx` as a test problem across ≥3 attempts and never corrected the actual undefined identifier. A cheap platform guard — surfacing an app-level error-boundary message (e.g. `… is not defined`) from the behavior-test receipt to the repair prompt as "the app is crashing at render; fix the app, not the test" — would likely have cleared this without escalation. This is a real platform improvement, provable test-first against the receipt-parsing code, and a good candidate for a separate item.

---

## Verdict / what I need from the conductor

**This item cannot be completed as a local fix.** The confirmed root cause is a runtime `ReferenceError: current_count is not defined` in the generated `src/App.tsx`, which lives only in the remote Contree sandbox. Clearing the block requires **option (b): a paid build re-run** (model credits + live sandbox), which this item forbids me to run.

**Reporting `question`** (not `done`, not `blocked`): the decision — spend paid credits on a Retry of feature 3 — is the owner's, via the conductor.

### Precise cost/spend of a re-run (for the owner's decision)
- **Action:** owner presses **Retry** on the Farmhand build → host loop re-delegates feature 3.
- **Spend:** 1+ coordinator/specialist model turns to rewrite `App.tsx` and re-run checks. Up to **3 more repair attempts** remain (routes `deepseek-v4.1-flash-1017`, then `glm-5.3`); each failed check burns another attempt. Realistically a few model calls; worst case exhausts the remaining ladder.
- **Sandbox:** a live Contree session runs `bun install` + `bun run test` + bundle per attempt.
- **Blast radius:** the demo build only; nothing published (publish stays owner-gated). The one-line fix is small (define/rename `current_count`), so a single targeted repair turn with the corrected diagnosis should pass.
- **Cheaper alternative:** ship the platform guard in §6.2 first (so the repair agent is told "the app is crashing at render — fix the app"), then Retry — higher odds of a one-shot pass.
