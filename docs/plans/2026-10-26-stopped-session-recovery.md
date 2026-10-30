# Stopped build-loop session recovery

Recovered the parent Kiro Crew conversation `chat-40-1793025229` and its
Farmhand (`chat-47-1793026977`) and Livestock (`chat-46-1793026977`)
children from their local session transcripts on 2026-10-26. The user confirmed
that **Kiro chat credits**, rather than Nebius credits, ran out.

## Verified starting point

The child reports are historical snapshots, not the current build state.
Read SQLite with `mode=ro`, **without `immutable=1`**: the running server's
latest committed writes can still be in its WAL. An immutable connection can
silently omit them.

At 19:55 UTC, the existing local server was running on :5176:

| Project | Checked features | Current feature | Actual coordinator state |
| --- | --- | --- | --- |
| Farmhand | 4 / 8 | Voice Farmhand | Latest two submissions settled with timeout errors; workflow still `building` |
| Livestock Risk Tracker | 1 / 5 | Daily log, attempt 2 | Submission `running`, with an overdue delayed wake and no recent recorded sandbox work |

Farmhand's feature 3 passed 12 tests at 19:35:42 UTC; feature 4 passed 21 tests
at 19:45:09 UTC. Thus the old report's feature-3 regex failure was no longer
the current blocker. Neither project had reached a verified preview.

The latest delivery receipts were successful and `pendingKey` was null for
both projects. An older `reconciliation-required` operation existed for
Farmhand, but it was **not** the current pending delivery.

## Local recovery

At 19:57:35 UTC, used Farmhand's authenticated product controls:

1. Check build status confirmed no new activity.
2. Stop retained its plan, files and four passed feature checkpoints.
3. Retry was accepted; the new delivery receipt succeeded and its coordinator
   submission became `running` with attempt 1 and a fresh one-hour deadline.

The user browser account cannot open the Livestock judge-owned project. Do
not change workspace membership to work around this. Its previous test
driver uses that project's existing owner session against the normal product
Stop/Retry endpoints; no new session or membership is created.

At 19:59:35 UTC that driver observed Livestock already `blocked` by the
28-minute no-progress watchdog, then successfully retried it through the
product endpoint. The retry returned HTTP 200 / `building`. Farmhand recorded
new sandbox commands at 20:00:15 and 20:00:19 UTC after its retry; this is
execution evidence beyond merely receiving HTTP 200.

No database reset, deployment, publication, credit-limit change or server
restart was performed during this recovery.

## Open bug: terminal coordinator / orphaned wake recovery

**Status: reproduced local state; root cause and fix not yet established.**

Symptom: a workflow remains `building` after its coordinator submission has
settled with a timeout, or after its persisted delayed wake has become overdue.
The UI correctly falls back to “No recent activity,” but another authenticated
Stop/Retry is needed to start a fresh submission.

Two different boundaries must be tested separately:

- **Undelivered pending intent:** `recoverStalledDispatch` operates only while
  `pendingKey` and `pendingBody` exist. It already has tests for failed delivery,
  lease expiry, keyed replay and receipt-before-clear crashes.
- **Delivered but interrupted execution:** the latest receipt succeeded and
  cleared that slot. Re-delivering an old operation or retrying it forever does
  not establish recovery of this distinct state. Inspect Flue's submission,
  attempt/timeout state, scheduled wake and actual current tool receipts.

Do not conclude that production alarms are reliable, or that Miniflare always
requires a browser socket, from these observations. Neither claim was proved.
Do not increase timeout/attempt budgets or reset repair accounting as a fix.

Required regression evidence before closing:

1. A fresh accepted submission starts without a browser conversation socket.
2. Interrupt the runtime after input application, preserving its DO/D1 state;
   prove bounded recovery using the same durable operation identities.
3. A queued submission behind an expired turn receives its own valid processing
   deadline; capture the observed zero-timeout queued-record case separately.
4. A terminal coordinator cannot leave an indefinitely “working” workflow.
   Reconciliation must respect Stop, admission/payer, approved revisions,
   checkpoint identity and uncertain in-flight writes.
5. No automatic fresh payer, duplicate writer, repeated unchecked paid retry,
   owner debugging request or premature preview publication.

## Recovered Flutter work: local verification

The uncommitted Clean Architecture scaffold is self-contained in its serialized
file map; it does not depend on an ignored external source directory.

Re-ran on the recovered tree:

```sh
bun run typecheck
bun test tests/flutter-scaffold.test.ts tests/workflow-dispatch.test.ts
PATH="$HOME/.bun/bin:$HOME/fvm/versions/stable/bin:$PATH" \
  FLUTTER="$HOME/fvm/versions/stable/bin/flutter" \
  bun scripts/refresh-flutter-scaffold-lock.ts --check
```

**LOCAL VERIFIED:** typecheck passed; 29 tests / 186 assertions passed. The
full Flutter scaffold check passed with digest
`sha256:07aa2b63966fdaf432697eaf572cfb74d40080af4a71b23289c0c2bd1fbd2483`:
idempotent setup, unchanged locked installs, two Flutter and five server
examples, rejection of the bare scaffold by the real-test gate, acceptance
with a builder test, web build (2.65 MB), Workers server check and clean Flutter
analysis. The installed SDK needs its usual local cache writes outside the
workspace; the first sandboxed attempt was blocked there, then the permitted
verification completed.

This is not proof of a live Flutter sandbox image, Android APK, or either
generated app's finished preview. Existing dirty work is retained for review.
