# EggOps Nigeria local build — what broke and what was fixed (2026-10-29/30)

LOCAL VERIFIED unless marked. One full A→Z run (Find → idea → plan → looks →
build) on the local dev server with live Nebius models and the live sandbox.
This is the running list the owner asked for, so every fix lands in the
version we ship and the demo build does not hit the same walls.

## Breakages and fixes

| # | What broke (seen) | Cause | Fix (file) | Status |
|---|---|---|---|---|
| 1 | Plan/looks lost ~30 min each to runtime crashes | Local workerd memory climbs to 1–2 GB; the project agent's stream store hit "Producer ownership is stale" | Recovery recipe (stop → retry before opening chat); not fixed in code. The project DO stored 47 MB of streamed reasoning deltas | OPEN — watch on prod (128 MB DO limit) |
| 2 | Looks never saved: screen checker down, sticky repair counter, `&#8594;` read as a hex colour | Checker browser died; counter reset only on user messages | Checker relaunches its browser; counter resets per start; entity-aware hex check (`serve-design-capture.ts`, `coordinator.ts`, `looks.ts`) | FIXED |
| 3 | First part failed 4/4 browser checks for ~1 h | App routed by `location.pathname`; Caddie's checks open `#/farm` | Builder rule + repair brief: hash routes (`HASH_ROUTES_RULE`, `specialists.ts`, `independent-acceptance.ts`) | FIXED |
| 4 | Checker signed in on a fresh first screen with no sign-in | Sign-in did not follow the journey's earlier taps | Checker replays the stranger's opens/taps first (`scripts/acceptance-browser.ts`) | FIXED |
| 5 | Repairs ran blind ("independent criteria failed") and broke passing tests | Checker reasons never reached the builder | Reasons + host steps + rules in the repair brief, rules first (`independent-acceptance.ts`, `coordinator-host.ts`) | FIXED |
| 6 | Checks that can never pass ("sign in → See all days → expect 205" for a brand-new person) | Journey author did not know each check runs on an empty account | Journey guide rule `JOURNEY_EMPTY_START_RULE`; repair brief flags checks that save nothing | FIXED for new plans |
| 7 | A part paused after five of the builder's own test runs | Mid-work `run_checks` failures spent repair tries | Builder iterations are ledgered as diagnosis, not tries (`coordinator-host.ts`) | FIXED |
| 8 | Super VL as the last repair rung: 10–35 s per call, no writes, broke tests | Slow, weak at code repair | Last rung is DeepSeek; Super VL only for image issues (`repair-escalation.ts`) | FIXED |
| 9 | Build paused "checking an interrupted operation" | A 9-hour-old coordinator hand-off from the looks step counted as an unsettled effect | Only this attempt's outside effects block (`task-recovery.ts`) | FIXED |
| 10 | Build paused on "150-step budget" | Per-attempt action allowance exhausted by repair rounds | Resumes by itself once per run, counted apart from the watchdog's two (`budgetPaused`, `BUILD_BUDGET_AUTO_RESUMES` in `build-workflow.ts`) | FIXED |
| 11 | Build paused on the one-hour limit | Mac slept on battery mid-build | `caffeinate` while building; not a code bug | ENV |
| 12 | Builder tried `python3` seven times (exit 127) | Not installed in the sandbox | Builder told to use bun / whole-file writes (`specialists.ts`) | FIXED |
| 13 | Owner saw "Send your message again" after a build turn crashed | Generic chat failure notice | Build-aware notice (`settlement-notice.ts`) | FIXED |
| 14 | Only the first pause of a run notified; no "app is ready" notice existed | Dedupe key per run; no ready notice | Per-attempt key; `build_ready` notice with email + push (`build-workflow.ts`, `notifications.ts`) | FIXED, not live-tested |
| 15 | Builder chatter and jargon in chat ("frontend delegate is exhausted", "review controls") | No quiet rule during builds; host hand-back text | `BUILD_QUIET_RULE`; plain `pausedNext` hand-back | FIXED (model may still slip) |
| 16 | Daily spend cap would pause the build before it finished | Cap below one full run's cost | Caps off for local runs; prod needs caps set above one build | ACTION before prod |

| 17 | ~12 repair rounds on the last two parts went on checks that can never pass: pressing Save with nothing typed, expecting "205" with nothing typed, clicking a bare number | Designer wrote journeys that skip setup; nothing checked them before the build | Design save refuses them with the exact fix (`journeyLintIssues` in `acceptance-journeys.ts`, `checksLintIssues` at the looks save in `coordinator-host.ts`). For THIS local run the two tip checks' steps were corrected by hand in the approved design (criterion text unchanged; DB backup in `/tmp/caddie-d1-backup-*`) | FIXED for new designs; this run's tip part is LOCAL VERIFIED against corrected checks |
| 18 | Build "interrupted" three times this afternoon | Editing server files reloads the local worker (Vite HMR), and running browser specs beside the build restarted workerd | Local-only: no server edits or browser specs while a local build runs. Prod has no HMR | ENV |
| 19 | "conversation read failed … ctx.id.name is not set" after a restart; the project agent storage is now 163 MB (130 MB stream batches) | Flue keeps every streamed delta (reasoning and the builder's whole-file tool calls) | Restart recovered it. Not fixed in code | OPEN — prod risk on long builds; demo uses a fresh project and a 3-part first version |
| 20 | Attempts list showed the same rules preamble on every browser-check row | Repair brief puts rules first and the activity read cuts round text at 300 characters | Attempts and Checks views rebuilt (grouped by part, failing checks named); server cut to be fixed after this build | PARTLY FIXED |
| 21 | A stopped build could offer "Continue the plan" | New paused-step logic ignored the stop | A stop is always a stopped build (`ProjectWorkflow.tsx`) | FIXED |
| 22 | First versions too big (4 parts × 4 checks = 16 browser checks re-run on every hand-in) | Limits 6 parts / 4 checks | 3 parts / 3 checks (`FIRST_VERSION_MAX`, `ITEM_CHECKS_MAX`) | FIXED for new plans |
## Cost and time of this run (approx.)

Idea + plan $0.24 · looks $0.32 · build ~$3.6 so far (four parts, many
repair rounds; DeepSeek repairs ~$0.15–0.20 each). The first part alone took
about 1 h 40 min of build time before fixes 3–5; later parts took 10–30 min.

## Before the prod demo build

- Judge limits: 3 build starts/day and every Retry counts — raise for the one
  shared judge account.
- Spend caps on prod: defaults are $3/day and $2.50/project — below one build.
- Prod has never run a full build; the agent storage growth (#1) is the main
  unknown against the 128 MB Durable Object limit.
- Push notifications: test end to end on prod over HTTPS with a real phone or
  desktop Chrome. Chrome for Testing's push registration fails locally
  (`DEPRECATED_ENDPOINT`), so local push is BLOCKED, not verified.
- Do not edit server files or run browser specs while a local build runs
  (#18).
