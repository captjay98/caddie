# Farmhand safety change — rebuild blocked by the local runtime's wake/recovery gap

**Status:** the change lifecycle itself is LIVE VERIFIED; the safety-change REBUILD is
BLOCKED by a documented environment defect. The previous preview remains accessible.
No fabrication, no DB surgery, no further paid attempts after the evidence below.

## What completed (LIVE VERIFIED, paid)

- Heading change `chg_f1e52723…`: request → scoped proposal → hash-bound approval →
  bounded rebuild → checks green → new preview `out_569b9266…` (commit `56ae4b44…`),
  old output `out_02c537…` retained byte-identical. Verified in the DB and the browser.
- The 0057 proposal flow rendered in the real UI ("What will change" / "Things to know")
  and refused an approval that omitted the reviewed `proposalHash` (STALE_CHANGE), then
  accepted the exact-hash approval — the fencing works against a real caller mistake.
- The 60-minute watchdog swept the first stalled safety build (`chg_26653b84…`) to
  **ready + change failed + plain message + old preview intact** — failure
  non-poisoning proven under the real watchdog, not only in tests.

## What is blocked (three stall signatures, one root)

The safety change (sign-in scoping, atomic mortality/medication steps, stock validation,
inventory navigation, feed/triage honesty) was filed twice (`chg_26653b84…`,
`chg_c63b35d9…`), approved twice through the full flow, and both rebuild turns stalled
the same way:

1. The coordinator turn dispatches a `task` delegate (`input-available`, no output).
2. No `build_activity` rows and no `model_call_usage` rows appear for the delegate
   (last usage row 23:02:56Z; the turns ran 00:52–01:52Z).
3. The turn never continues — the miniflare wake-alarm class from
   `docs/plans/2026-10-26-farmhand-rebuild-evidence.md` §5, including with the browser
   Agents client attached (the warm-DO recipe did not save this attempt).

On the second attempt the specialist-deadline path then exposed the deeper blocker:
`recoverTimedOutTask` (task-recovery.ts) refuses to continue while ANY
`external_operations` row for the run is unsettled, and Farmhand's run carries four
zombie rows from Oct 25–26 (`retry:resume:986fedbb…`, `retry:resume:f13b3c4b…`,
`retry:farmhand-rebuild-2026-10-26-b`, `retry:resume:abf0200b…`, all
`reconciliation-required`). Their deliveries were consumed by the coordinator on Oct 26
(the transcript contains those retry prompts), but no supported product path settles
them, so every future specialist-timeout on this run blocks. This is the "terminal
coordinator / orphaned wake recovery" open bug from
`docs/plans/2026-10-26-stopped-session-recovery.md`, now with a live reproducible case.
The workflow ends at `blocked` with "Caddie is checking an interrupted operation…" while
the change row stays `approved` — recovery of THAT state (approved change + blocked run)
has no product path yet; `retryWorkflow`'s finished-app recovery returns idempotently
without flipping the phase because the approved change already holds the request hash.

## Exact state at hand-off (read-only, 2026-10-28 ~01:55 WAT)

- Workflow: `blocked`, detail "Caddie is checking an interrupted operation…",
  previewId `out_569b92660bada2b7cf0185a117279cfd` — **the working app is intact**.
- Change `chg_c63b35d9…`: status `approved`, proposal saved (admission token fencing
  intact). Change `chg_26653b84…`: `failed` by the watchdog sweep.
- Build activity: zero rows after 22:26:47Z for this project.

## Preview mount FIXED (2026-10-28, owner report)

The owner hit "The preview could not be loaded" on
`/app/preview?...&source=artifact` for the built output. Root cause: the page
routed `out_…` workflow outputs down the artifact-revisions document path
(imported previews only), which 404s `artifact_not_found`. Fixed in
`PreviewPage.tsx`: `out_…` ids always use the workflow preview path regardless
of a stale URL source; only `art_…` revisions use the artifact path. Verified
in the real browser: the frame mounts on the isolated preview origin and
Farmhand renders (cycle, count, navigation). All 13 interactive-preview specs
and both "preview beyond chat" specs pass.

## UX corrections applied (owner 2026-10-28)

- Tab rhythm: every project tab's content now starts at the same inset inside
  the same card frame (measured 263px on Plan, Build, Submit at 640px column).
- Build tab: the approved-change strip folds to one line + "What you asked
  for"; a ready app shows one "Open your app" entry instead of a second
  preview surface; the feature checklist is no longer pushed down.
- Submit tab: 864px of stacked sections reduced to 529px — the hand-in
  checklist is the surface; sourced rules, checklist citations, exports and
  technical detail fold into one "Requirements and checklist" disclosure.

## Current-version recheck (2026-10-28, LOCAL VERIFIED)

Read-only interaction in the authenticated local browser against the saved output
`out_569b92660bada2b7cf0185a117279cfd` (`source=workflow`). This is the last known
good heading-change output, **not** either safety-change build. No test data was
reset or submitted during this recheck.

- The isolated app frame loaded and showed the existing synthetic poultry cycle at
  **98 of 100**. The project shell still reports **Build · Needs your help** and
  **Preview · Ready to try**; this confirms the old preview remains reachable while
  the new change is blocked.
- Inventory showed **0 items**. Clicking **Add stock item** returned to Farmhand
  Home instead of presenting a form. No stock was added. The known inventory and
  medication journey remains blocked on this saved output.
- Feed showed **0 days**, **14 g/bird/day**, and a **0 kg** draft reorder while
  Inventory showed no stock items. The screen does not identify that consumption
  as a sample/estimate or explain its source. This remains a data-truthfulness gap;
  the displayed number is not verified consumption.
- Triage opened with symptom choices and a disabled camera capture control. This
  recheck did not submit symptoms or a photo, so diagnosis and image inference remain
  unverified.
- The Brief still labels the Nebius contest closing hour as unconfirmed. The current
  official rules state **Friday, October 30, 2026 at 10:00 AM Pacific Time**; on
  October 28 that is **6:00 PM in Lagos (WAT)**. This verifies the source fact, but
  does not mean Caddie's stricter, freshness-bound local evidence record has been
  refreshed. The user-facing warning is therefore honest; refresh and persist the
  cited rule evidence through the product's supported rules-reading path before
  replacing the warning.

The browser check is local evidence for this exact output only. It does not verify
the pending safety change, other accounts, production, or every app journey.

## Coordinator receipt reconciliation follow-up (2026-10-28, LOCAL VERIFIED)

The active local D1 still has four `coordinator-dispatch` operations in
`reconciliation-required`; the workflow is `blocked`, has no pending dispatch body,
and still points to the preserved preview. Their `receiptId` fields are empty.

I checked the corresponding Flue Durable Object store read-only. Flue 2.2.2 derives
the durable `submissionId` from the exact tuple `(agent, conversation id,
idempotency key)`. The four derived IDs have no matching submission row in any
current local `FlueCoordinatorAgent` store. This means there is no receipt in the
current local persistence to attach to those operations. A missing row is not enough
to prove what happened in a prior runtime state, so these four effects remain
ambiguous and must not be force-marked failed or succeeded. The earlier note that
their prompts appeared in the transcript is not a provider receipt.

The forward path now preserves Flue's `submissionId` as the operation receipt and
requires a valid admission response before acknowledging a dispatch. If an accepted
response is lost while its pending body remains, the existing same-key/same-body
redelivery can recover that durable receipt. This code change does not reconcile the
four legacy rows or unblock this old run.

The wake-alarm explanation in the earlier “What unblocks it” list is not yet proven
as the cause for every stall. Treat wake recovery as a separate runtime hypothesis
until a controlled interruption reproduces it with fresh receipts. No old rows were
edited; no resume, paid call, database reset or deploy was performed.

## What unblocks it (owner/reliability actions, in order)

1. Keep the four legacy operations blocked until a supported Flue/runtime receipt or
   an explicitly authorized, evidence-backed recovery is available. Do not settle them
   with direct D1 writes. The new forward path stores Flue admission IDs; it does not
   repair these old rows or recover their lost request bodies.
2. Reproduce the delegated-task wake stall separately, with a fresh operation whose
   durable submission ID is recorded. The current evidence does not establish that
   Miniflare alarm behavior caused all four legacy ambiguities, or that production
   Cloudflare alarms will behave differently.
3. The safety change `chg_c63b35d9…` is already approved, but its rebuild is not
   resumable until the operation ambiguity is resolved. A new paid build/resume also
   needs an explicit spend boundary. Do not re-approve or re-file to bypass the gate.

Nothing in this block undermines the earlier verification: the lifecycle, proposal
flow, hash fencing, watchdog sweep and failure non-poisoning all behaved exactly as
designed and were verified on the real app. The blocked item is the generated app's
safety rebuild, waiting on the runtime fix above.

## Final local verification recheck (2026-10-28)

The coordinator forward path now requires and records Flue's durable submission ID
before acknowledging server-owned dispatch. A 2xx response without that ID is treated
as unconfirmed, so the workflow keeps its pending intent for same-key recovery:

```ts
if (!admission || typeof admission.submissionId !== 'string' || !admission.submissionId.trim()) {
  return { delivered: false };
}
return { delivered: true, receiptId: admission.submissionId };
```

Local verification on this tree:

- `bun run typecheck` — PASS.
- `bun run build` — PASS; output is dev-shaped and not deployable to production.
  Wrangler printed a non-fatal log-write warning in the sandbox.
- `bun run test` — **2,841 passed, 0 failed** across 246 files, 12,882 expectations.
  Wrangler-backed fixtures required local permission to write their temporary
  registry/log files under `~/Library/Preferences/.wrangler`.
- `bun run verify:packet REL26` — PASS, all 27 mapped test files; the browser
  acceptance integration passed 7/7.

The older “no source changes” checkpoint above is historical and is superseded by
this receipt-preservation fix and fixture update. These checks do not settle the four
ambiguous historical operations: the saved Farmhand workflow remains blocked, the
existing preview remains intact, and no resume, paid generation, database write,
reset, production deploy or publish occurred. Recovery still requires supported
evidence for those old operations or an explicitly authorized recovery path that
does not guess their outcomes.
