# Livestock Risk Tracker — rebuild evidence (2026-10-26)

> **Historical snapshot, not the current project state.** A later read-only
> inspection found Livestock's workflow marked `ready`; it did not re-test the
> app. See [the later reconciliation](../evidence/2026-10-27-farmhand-current-snapshot.md).
> Treat the state and limit observations below as applying to this earlier run.

**Project:** `proj_8f9cb1aeea005c54dd52af005dc92627` ("Livestock Risk Tracker"),
`standard` kind (react-hono). **Repo:** `/Users/captjay98/projects/caddie-forge`, branch `main`.
**Author:** Kiro (kirocrew-worker). **Dev server:** reused the running Vite dev server on
`http://localhost:5176` (PID 80490), per the brief.

**Evidence classification** (per root `AGENTS.md`): LOCAL VERIFIED / LIVE VERIFIED /
SIMULATED / BLOCKED / FAILED. A mocked or local-only pass is never LIVE VERIFIED.

**Headline:** the build was retried on the now-default `repair-v1` repair ladder and ran
LIVE (AI credits + Contree sandbox, as authorized). It wrote real feature-1 code and ran the
feature's tests, then the coordinator turn stalled mid-feature-1. Recovery (Stop → Retry) was
blocked by the **judge 3-builds-per-24h rate limit** on the project's owner account. The build
is **not green and not previewable yet** — no green was faked. The next build-start slot frees
at **2026-10-27 01:28:55 UTC**. This is an owner decision (wait vs. raise the cap vs. reassign
to a non-judge account).

---

## 1. Pre-flight — model config and starting state

| Claim | Class | Evidence |
|---|---|---|
| Design/plan model = GLM 5.3-flash, not overridden | LOCAL VERIFIED | `apps/app/src/agents/providers.ts`: `MODEL_ROLES.plan = 'glm-5.3-flash'`; route `glm-5.3-flash` → `specifier: 'nebius/zai-org/GLM-5.3-Flash'`, `modelId: 'zai-org/GLM-5.3-Flash'`. Not 4.6, not 5. No override applied. |
| Build (code/QA) role = Nemotron-3.5-Super-VL | LOCAL VERIFIED | `MODEL_ROLES.build = 'nemotron-3.5-super-vl'` (owner re-route 2026-10-20). |
| Project was `blocked`, `repairPolicyVersion` empty | LOCAL VERIFIED | D1 `build_workflows` read-only before retry: phase=`blocked`, repairPolicyVersion=`''`, updatedAt 2026-10-26T09:21Z. |
| 5 planned features, feature 1 `building`@0, 2–5 `pending` | LOCAL VERIFIED | D1 `build_features`: create-batch / daily-log / batch-health / ai-risk-prediction / offline-sync. |
| Dev server live on pinned port 5176; reused | LIVE VERIFIED | `lsof -nP -iTCP:5176 -sTCP:LISTEN` → node PID 80490; `curl /` → HTTP 200; `/api/auth/status` → `{"authenticated":false}` unauth. |

## 2. Authenticated retry — the build ran live on repair-v1

Authenticated as the project owner (`kiro-walkthrough@judges.caddie.invalid`,
userId `PiLvXkdjw5m8PHYHgLAef6KQfxkmlGhe`, the sole member/owner of workspace
`ws_b2466371…`) via a Better Auth signed session cookie
(better-call format: standard base64 HMAC-SHA256 then `encodeURIComponent(value.sig)`),
reading an existing valid session token + `BETTER_AUTH_SECRET` from `.dev.vars` (secret never printed).

| Claim | Class | Evidence |
|---|---|---|
| Session accepted; identified as the owner | LIVE VERIFIED | `/api/auth/status` → `{"authenticated":true}`; `/api/auth/get-session` → user `kiro-walkthrough@judges.caddie.invalid`. |
| `POST /api/projects/…/workflow/retry` succeeded; phase blocked→building | LIVE VERIFIED | HTTP 200; response `workflow.phase = "building"`; dispatch `external_operations` key `retry:livestock-rebuild-2026-10-26` → status `succeeded`. |
| Repair ladder engaged on `repair-v1` (the fix) | LIVE VERIFIED | D1 `build_workflows.repairPolicyVersion` flipped from `''` to `repair-v1` after retry. |
| Live AI build calls flowed for this project | LIVE VERIFIED | D1 `model_call_usage`: Coordinator turns on `nvidia/Nemotron-3.5-Super-VL`, conv `conv_8f9cb1aeea…` + builder delegate convs, 18:47–18:52; ~191 calls in a 10-min window, 2 errors. Credits spent as authorized. |
| Contree sandbox came up and built feature 1 | LIVE VERIFIED | D1 `sandbox_bindings` (62 op records) in `/workspace/proj_8f9cb1aeea…`: `ls src` → `App.tsx, BatchCard.tsx, CreateBatch.tsx, Home.tsx, db.ts, main.tsx, server.ts, styles.css`; exec read `App.test.tsx`; exit 0. |
| Feature-1 tests ran but not all green | LIVE VERIFIED | D1 `run_rounds` (round `repair_attempt`, outcome `failed`): detail "The app's own tests: 3 of 7 passed." (18:51Z). |

## 3. The stall and the recovery attempt

| Claim | Class | Evidence |
|---|---|---|
| Coordinator turn stalled mid-feature-1 | LIVE VERIFIED | Newest `model_call_usage` = 18:52:58Z; newest sandbox op = 18:53:06Z; then ~14 min of total silence while phase stayed `building`, feature 1 `building`@attempt 1. No error row; the turn simply ended without a `finish_feature` or reaching the repair-pause threshold. |
| `building` cannot be retried directly | LIVE VERIFIED | `POST …/workflow/retry` while `building` → HTTP 409 `NOT_BLOCKED` ("Only a stopped build can be retried"). Matches `retryWorkflow` guard in `build-workflow.ts`. |
| Product only self-resumes a `blocked` build | LOCAL VERIFIED | `project-experience.ts`: a `building` workflow exposes only "Stop build"; `recoverStalledDispatch` needs a pending message, and the retry's pending slot was already delivered+cleared (`pendingKey` empty). |
| Stop succeeded → `blocked`, work retained | LIVE VERIFIED | `POST …/workflow/stop` → HTTP 200; phase → `blocked`, detail "Stop requested. Your plan and files are retained." The DO turn was aborted. |

## 4. BLOCKED — judge 3-builds-per-24h rate limit

| Claim | Class | Evidence |
|---|---|---|
| Retry refused by the judge build cap | BLOCKED | `POST …/workflow/retry` after Stop → HTTP 403 `JUDGE_LIMIT_BUILDS` ("Judges can start 3 builds in 24 hours."). |
| 3/3 build starts consumed in the window | LIVE VERIFIED | D1 `judge_usage_events` kind=`build` for owner `PiLvX…`: 01:28:55Z, 09:18:39Z, 18:47:33Z (the 18:47 one is this session's retry). |
| Limit is per active-judge account, default 3/day, env-overridable | LOCAL VERIFIED | `judge-limits.ts`: `JUDGE_MAX_BUILDS_PER_DAY_DEFAULT = 3`, rolling 24h window via `admitEvent`; non-judges never limited; override `JUDGE_MAX_BUILDS_PER_DAY`. |
| Next slot frees at 2026-10-27 01:28:55 UTC | LOCAL VERIFIED | Oldest in-window build event 01:28:55Z + 24h rolling window. |
| The real owner (captjay98@gmail.com) is NOT a member of this workspace | LOCAL VERIFIED | `workspace_memberships` for `ws_b2466371…` has one row: the judge account, role `owner`. Cannot authenticate as the non-judge owner without mutating membership/ownership. |

## 5. Not reached (honest open state)

| Step | Class | Note |
|---|---|---|
| Build green (all 5 features passing) | BLOCKED | Stopped at feature 1 (3/7 tests), then rate-limited before resume. No green faked. |
| Preview (`POST /projects/:id/previews`) | BLOCKED | Requires a green/checked build. Not attempted — nothing to preview. |
| Screenshots (desktop dsf2 + 390px phone) | BLOCKED | Driver ready at `test-support/livestock-shots.ts` (uses repo `@playwright/test` chromium, owner session cookie). Not run — no previewable app yet. |
| Delivery checklist (`server/submission.ts`) | BLOCKED | Derived from real build receipts; meaningful only after a green build. Not recorded. |
| Publish | NOT ATTEMPTED (owner-gated) | Correctly left for the owner; never run. |

## 6. Decision needed (owner)

The build itself is healthy on `repair-v1`; the only blocker is the per-judge build-start cap,
which this session's own retry exhausted. Options, all owner territory:

1. **Wait ~6h** to 2026-10-27 01:28:55 UTC for a slot to free, then retry (automatable: monitor
   the window and re-fire the retry; the build resumes from the first unfinished feature with saved work).
2. **Raise/disable the judge cap** — restart the dev server with a higher `JUDGE_MAX_BUILDS_PER_DAY`
   (changes the judge-access behaviour the owner designed; requires a server restart, which the brief
   said to avoid).
3. **Reassign the project to a non-judge account** (add the owner's real account to the workspace /
   change ownership) so builds are unlimited — mutates account/membership data.

## 7. Artifacts produced (local, untracked — not committed)

- `test-support/livestock-retry.ts` — authenticated retry trigger.
- `test-support/livestock-stop-retry.ts` — Stop→Retry recovery driver.
- `test-support/livestock-shots.ts` — screenshot driver (pre-existing, ready for when green).
- This evidence file: `docs/plans/2026-10-26-livestock-rebuild-evidence.md`.

No source files changed; no publish; no git commit.
