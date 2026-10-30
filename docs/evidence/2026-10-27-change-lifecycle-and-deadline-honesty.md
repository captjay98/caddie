# Post-ready change lifecycle + honest deadline presentation — 27 October 2026

> **Historical implementation snapshot.** The change lifecycle and deadline
> copy evolved after this report. See [the later change-proposal evidence](2026-10-27-change-proposal-continuation.md)
> for the current local verification limits. In particular, no real paid
> post-ready Farmhand change or process-restart recovery has been established,
> and the test counts below do not describe the current moving worktree. The
> current Brief says “time not confirmed”; it does not assert that the linked
> rules omit the time. Check the current source before relying on exact copy.
> The false local clock time was removed; the plan's sourced exact-time and
> user-timezone presentation is still unverified, so “FIXED” below applies
> only to that earlier removal, not the full deadline requirement.

Implementation evidence for `docs/plans/2026-10-27-design-quality-and-farmhand-readiness.md`
steps 1–2 (P0 "freeze evidence / source truth" and P0 "make changes safe"). Companion to
`docs/evidence/2026-10-27-farmhand-ready-freeze.md` (the frozen baseline). All work local;
no deploy, no paid model call, no publication. Classification: **LOCAL VERIFIED** for
everything below; browser fixtures remain SIMULATED.

## 1. Urgent deadline discrepancy — FIXED (LOCAL VERIFIED)

**Root cause (traced, freeze doc §deadline):** the stored Nebius listing is date-only
("Aug 26 - Oct 30, 2026"); `brief.ts` `hackathonDeadlineCard` fabricated
`${deadline}T23:59:59Z` and rendered it with a "Your time →" line — the observed
"Oct 30 at 11:59 PM local" was an invented instant, ~6 hours later than the official
10:00 AM PDT close. Not a timezone-conversion bug.

**Fix:**
- `apps/app/src/server/brief.ts` — the deadline card shows the calendar date only,
  `daysLeft` from the documented end-of-day countdown in `daysUntil`, and
  `timeLabel: "not stated by the source"`. No invented clock time, no "Your time" line.
  The summary names the gap: "The source lists only a date, not a closing hour — confirm
  the exact time on the contest site before you rely on it."
- `apps/app/src/client/brief/DecisionCard.tsx` — the countdown block renders
  `card-time-unstated` ("not stated by the source — confirm the exact closing hour with
  the source before you rely on this date.") whenever a time label says unstated, because
  the compact card truncates long summaries. The source stays cited on the card.
- The now-unused `deadlineParts` helper (the only fabrication site left) was removed.

**Regression coverage:** `tests/brief-card-redo.test.ts` pins: timeLabel matches
/not stated/i, contains NO clock time, `localTimeLabel` undefined, summary carries
"confirm the exact time", source cited. `tests/deadline-time.test.ts` (client, Oct 23)
continues to cover zone conversion / unknown time / date-only. 47 tests across the four
deadline files pass.

**Real-browser check (browser-use, dev :5176, owner session):** the Farmhand Brief card
shows "3 days left · Friday 30 October · Nebius x NVIDIA Global AI Hackathon" with NO
clock time anywhere, the unstated-hour line visible, and the "Deadline source" citation
disclosure opening. Screenshots in the session transcript.

## 2. Post-ready change lifecycle — IMPLEMENTED + TESTED (LOCAL VERIFIED)

**The failure that was (reproduced in tests, then made impossible):** a ready app plus a
change request hit `requireBuildApproval`'s `phase === "building"` gate; the coordinator's
`report_blocker` then overwrote `ready` with `blocked` (Farmhand, frozen state).
`tests/build-workflow.test.ts` now pins that a refused attempt on a ready app KEEPS
`phase='ready'` with the detail visible and the preview untouched.

**The durable lifecycle** (`apps/app/src/server/build-workflow.ts`, migration
`0056_ready_changes.sql`):

- **Request** (`requestReadyChange`, `POST /workflow/change`): only a `ready` workflow
  with a live preview can take a 1–2000 char request. The row records the immutable
  `baseOutputId` (the live preview) and a `requestHash`. One open change per project
  (partial unique index) fences concurrent changes; a same-hash replay is idempotent; a
  different request is refused `CHANGE_IN_REVIEW`. The dispatch slot carries a
  draft-the-proposal prompt to the coordinator (analysis only — build tools stay locked
  because the phase stays `ready`).
- **Decision** (`decideReadyChange`, `POST /workflow/change/decision`): CAS on
  `status='proposed'`; a stale review hash is refused `STALE_CHANGE`; a non-member is
  refused. Approval re-checks the plan approval is still live, opens a FRESH spend payer
  (bounded new build, new limit) and judge admission BEFORE the decision lands, then CAS
  the workflow `ready → building` guarded on the exact `previewId = baseOutputId` — an
  app that moved since the review cannot silently start a build (`STALE_CHANGE`,
  change marked failed with a plain reason).
- **Completion**: `storeBuildOutput` completes the change in the SAME batch as the
  preview swap, so a crash cannot leave a published output with a change still
  "approved". The old output stays stored and byte-identical.
- **Failure non-poisoning**: `setWorkflowBlocker` is change-aware — during an approved
  change build, failure restores `phase='ready'`, keeps `previewId` (the old app stays
  openable), records the failure on the change row, and notifies once. A ready app is
  never demoted to `blocked` by a refused attempt at all.
- **Stop**: stopping a change build cancels the change and returns to `ready`.
- **Recovery of the real Farmhand state**: `retryWorkflow` on a blocked workflow with an
  intact preview and NO unfinished feature now parks the request as a change proposal and
  returns the workflow to `ready` — the supported recovery path, no DB surgery. A blocked
  build with unfinished features still resumes the feature loop (pinned by test).
  Replay-safety via a `workflow_resumes` row.
- The workflow snapshot exposes `change` (tolerates a pre-0056 database).

**Regression matrix (tests/build-workflow.test.ts, 9 new tests; file total 115 pass):**
ready refusal keeps ready · request records proposal without leaving ready (idempotent
replay, CHANGE_IN_REVIEW, non-member, NOT_READY) · decision fencing (stale hash,
non-member, double decision) + approval starts a bounded new build with a fresh payer ·
new preview published, old output byte-identical, change completed · failed change
returns to ready with the old preview readable and the failure recorded · stop during a
change → ready + cancelled · rejected change clears review, new requests accepted ·
Farmhand-style blocked recovery → change proposal, replay-idempotent · unfinished
features still resume the loop. Full suite: **2,803 pass / 0 fail (245 files)**.

**Client:** `AskForChange.tsx` sends the request to the new route (dialog with honest
copy: "your app keeps working exactly as it is until then") and moves to the conversation
for Caddie's proposal; `ProjectWorkflow.tsx` renders the review strip — proposed →
Approve/Cancel, approved → "your current app stays right here until the new version
passes its checks", failed → plain failure + old-app reassurance + technical report
disclosure. Browser specs (`focused-project-chat.spec.ts`, 390+1440) drive
request → review → cancel end-to-end: pass.

**Real-browser check (dev :5176):** the launch → isolated-origin document chain for
Farmhand's ready output returns 200 with the CSP'd document on
`p-<hash>.preview.localhost:5176` (verified from the page context). The preview FRAME
itself currently shows "The preview could not be loaded" — diagnosed as the parallel
session's in-flight `InteractivePreview`/shell mount work (their uncommitted files, no
server-side error; the API chain this plan depends on is intact). Not caused by this
workstream; left for that session to finish.

## 3. Brief unread strip — REMOVED (LOCAL VERIFIED, plan P1)

The "N new updates / Mark all read" toolbar strip interrupted the date-first greeting
(plan surface audit, Brief row). Removed from `Shell.tsx`; the nav unread badge and each
card's New state are untouched, and the count now lives in the feed's own quiet header
row (`AccountBriefV2`'s header, testid `brief-feed-head`, un-hidden in the workspace):
"N updates · X waiting on you · Y unseen" with the explicit **Mark all read** rendered
there only while unread exists. Read semantics unchanged (acting on a card reads exactly
that card; marking read never resolves work). The v2 header previously shared the
`brief-head` testid with the date header — renamed to avoid the ambiguity.

Browser specs updated and passing (aggregation badge + mark-all-read-clears, including
the regression assertion that the removed strip never returns). Real-app check on the
dev server: strip gone, feed header shows "4 updates · 1 waiting on you · updated just
now", Mark-all-read absent while nothing is unread, deadline honesty line visible.
Final gates on the finished tree: typecheck pass, `bun run build` pass, full unit suite
**2,803 pass / 0 fail (245 files, exit 0)**.

## 4. What was NOT done (honest gates)

- **P0-3 Farmhand demo-spine repair (stock navigation, medication journey, feed/triage
  labels) — BLOCKED on paid-call authorization.** Fixing the generated app requires a new
  paid build via the change lifecycle. The local, authorized slice is DONE: the lifecycle
  exists, Farmhand's blocked state has a supported recovery (Retry → change proposal →
  review), and the immutable baseline is frozen. Do not click Retry/Approve on real
  Farmhand until the owner authorizes the spend: the request/approval routes dispatch a
  coordinator turn, which is a paid model call.
- **P1-5 planning/design model-routing proof — BLOCKED on paid-call authorization** (the
  plan's own gate; routing table + cost decision are recorded in the plan).
- **P1-6 deployment/judge readiness — deployment BLOCKED on owner authorization.** The
  owner authorized browser-use and judge-account use (saved to memory); a local judge
  walkthrough remains available next, but the preview-frame mount issue above should land
  first. Local success is not deployment or live verification.
- **Concurrent-session note:** a second agent (Qoder) worked the same checkout throughout
  (shell/preview WIP). Two `focused-project-chat.spec.ts` tests ("exact preview beyond
  chat") fail on launch-write assertions from that workstream — pre-existing, not from
  this workstream. Shared routes/contracts/migrations were only touched by this session
  serially (migration 0056 is the only new migration today).
- **Robustness note for the launch route:** `POST …/launch` parses the body without a
  `.catch`, so an empty body yields an opaque 500 instead of a 400
  (`routes/build-workflow.ts`, launch handler). Left as-is: that route is the parallel
  session's active file.
