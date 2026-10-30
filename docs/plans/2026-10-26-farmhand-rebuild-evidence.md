# Farmhand demo build — paid feature-3 retry (rebuild evidence)

> **Historical snapshot, not the current project state.** Farmhand subsequently
> reached a saved `ready` output; see [the later read-only reconciliation](../evidence/2026-10-27-farmhand-current-snapshot.md).
> A saved output alone does not prove that its user journeys or deployment pass.

- **Project:** `proj_506d61ece6d7ca3a12fdd9a41a281960` (Farmhand demo, standard / react-hono)
- **Run:** `run_506d61ece6d7ca3a12fdd9a41a281960`  **Plan:** `pdr_5a801826-c745-4940-b035-99f77670c2fa`
- **Repair policy:** `repair-v1`  (routes: nemotron-3.5-super-vl → deepseek-v4.1-flash-1017 → glm-5.3)
- **Date:** 2026-10-26 (UTC times below; host clock is BST = UTC+1)
- **Scope:** paid retry of feature 3 (mortality-medication-logs) on the repair ladder,
  carry toward preview + checklist, **STOP before publish** (owner-gated).
- **Authorization:** owner authorized AI-credit spend + the live Contree sandbox on this app only.

**Outcome in one line:** the paid retry made **real progress** — the feature-3 render crash
(`current_count is not defined`) is **FIXED** — but the build loop then **STALLED on a local
dev-runtime limitation** (the Agents-SDK wake alarm does not fire in this long-idle miniflare
dev server), so feature 3 could not be driven to green and preview/screenshots were not reached.
**No publish occurred.** This is a `needs_human` blocker, not a faked green.

---

## 1. Pre-retry state — LOCAL VERIFIED (read-only D1, `?immutable=1`)

| pos | featureId | status | attempts | testsPassed |
|----:|-----------|--------|---------:|------------:|
| 1 | shared-backbone-crud | passed | 2 | 3 |
| 2 | offline-sync-queue | passed | 0 | 6 |
| 3 | **mortality-medication-logs** | **building** | **3** | — |
| 4–8 | mid-cycle-import … roles-visit-map | pending | 0 | — |

- `build_workflows.phase = blocked`, `repairPolicyVersion = repair-v1`.
- `build_repair_issues` (feature 3, admission `…1793011510278`): `failures=3, state=active`.
- Prior routes used: `nemotron, nemotron, deepseek` (10:46–10:49 UTC).
- Design/plan role = `glm-5.3-flash` (confirmed `apps/app/src/agents/providers.ts` `MODEL_ROLES.plan`);
  repair-ladder GLM = `glm-5.3` (`repair-escalation.ts REPAIR_ROUTES`). Both as required by the brief.
- Env present (`.dev.vars`): `CONTREE_BASE_URL/API_TOKEN/PROJECT_ID`, `CADDIE_LIVE_AUTHORIZED`, `NEBIUS_API_KEY`.
- Dev server up on `localhost:5176` (pid 80490, reused — not restarted); bun 1.4.0.

## 2. Paid retry fired — LIVE VERIFIED

Authenticated as the project owner (`captjay98@gmail.com`, the workspace `owner`) via a Better-Auth
signed session cookie. The session token was read read-only from the local D1 `session` table; the
cookie signature is **HMAC-SHA256 standard base64** over the token (probed: the running dev server
rejects base64url and accepts standard base64).

- **`POST /api/projects/…/workflow/retry {key:"farmhand-rebuild-2026-10-26-a"}` → HTTP 200**,
  `phase: blocked → building` (19:11 UTC region). `dispatchPendingWorkflow` self-fetched the
  coordinator conversation; the host loop re-entered at the first unfinished feature (feature 3),
  passed features 1–2 untouched (no re-spend).
- New spend admission opened: `build:run_…:1793040480826`.

Driver (not committed): `test-support/farmhand-retry-trigger.mjs`, poller `test-support/farmhand-poll.sh`.

## 3. Repair ladder ran — LIVE VERIFIED (paid model calls + live sandbox)

New admission `…1793040480826`, `build_repair_attempts` (feature 3):

| ordinal | route | at (UTC) |
|--------:|-------|----------|
| 1 | nemotron-3.5-super-vl | 2026-10-26 18:48:34 |
| 2 | nemotron-3.5-super-vl | 2026-10-26 18:51:03 |
| 3 | deepseek-v4.1-flash-1017 | 2026-10-26 18:52:33 |

Each attempt ran a live Contree sandbox (`bun install` + `bun run test` + bundle). `failures=3, state=active`
(allowance remains; next route at failures 4–5 would be **glm-5.3**).

## 4. The render crash is FIXED — LIVE VERIFIED (latest sandbox receipt)

Latest `behavior-tests` verification receipt (`run_verifications`, 2026-10-26 **18:52:33** UTC,
`bun run test`), ANSI-stripped:

```text
(pass) shared backbone CRUD > …                       (3 pass)
(pass) offline sync queue > …                         (3 pass)
src/mortality-medication.test.tsx:
# Unhandled error between tests
SyntaxError: Invalid regular expression: unmatched parentheses
src/mortality-medication-server.test.ts:
(pass) mortality-medication-logs API > Record a mortality event … reduce the cycle count
(pass) mortality-medication-logs API > Record a medication with dosage … link to inventory
(pass) mortality-medication-logs API > Filter the Records Timeline by log type …
 9 pass / 1 fail / 1 error / 76 expect() calls — Ran 10 tests across 4 files.
error: script "test" exited with code 1
```

- The old `ReferenceError: current_count is not defined` (render crash → error boundary) is **GONE** —
  the deepseek repair fixed `src/App.tsx`. `dependencies` check now passes (`bun install … no changes`, exit 0).
- The **new, narrower** failure is `SyntaxError: Invalid regular expression: unmatched parentheses`
  thrown in the `src/mortality-medication.test.tsx` path (an unhandled error between tests — a malformed
  regex in generated code, most likely the Records-timeline log-type filter). This is one more repair
  attempt away from green (next route glm-5.3); it is **not** faked and **not** resolved.

## 5. BLOCKER: the build loop stalled on a local dev-runtime limitation — LIVE VERIFIED

After the 3rd attempt, the host loop stopped advancing. Root cause, from the coordinator Durable
Object store (`.wrangler/state/v3/do/caddie-app-FlueCoordinatorAgent/0d6a3e11….sqlite`):

- The Cloudflare Agents SDK schedules a wake callback `__flueWakeAgentSubmissions` (`cf_agents_schedules`)
  to continue the in-flight submission between turns. The row is **overdue** (`time` in the past) with
  `running=0` and `execution_started_at` empty — **miniflare is not firing the overdue DO alarm** in this
  long-idle local dev server. The submission (`flue_agent_submissions.status='running'`) sits waiting on
  a wake that never comes.
- This is an **environment** problem, not an app defect: on Cloudflare the alarm fires reliably; locally
  it needs a live Agents client (WebSocket) keeping the DO continuously warm.

Mechanisms tried to force the alarm, all CONFIRMED INEFFECTIVE (the schedule stayed `running=0`, no 4th attempt):

- Re-`POST /workflow/retry` with the SAME key (replay branch → `dispatchPendingWorkflow`) — no-op (pending slot already cleared).
- `GET /api/projects/…/experience` polled ~20× / 3s (the documented `recoverStalledDispatch` trigger) — nothing stranded to resend.
- `GET /agents/coordinator/<conv>` ×20 (reaches the DO; returns 500 on a non-Agents-shaped request) — alarm not ticked.
- A raw WebSocket to `/agents/coordinator/<conv>` — handshake refused (needs the Agents-SDK client protocol).
- **stop → retry (new key `…-b`)**: `POST /workflow/stop` → `phase=blocked`, then `POST /workflow/retry` → `phase=building`.
  This DID restart the submission (`attempt_count 1→2`, `started_at` 19:12:53 UTC) and created a FRESH wake
  schedule (`time=1793042003`), but that fresh alarm also stayed `running=0` and did not fire. Loop still stalled.

### 5a. Browser-drive attempt (follow-up) — LIVE VERIFIED INEFFECTIVE

Asked whether the browser could be used, I drove the **real app client** against the dev server to
try to warm the DO (driver `test-support/farmhand-drive-app.mjs`, repo `@playwright/test` chromium
`chromium-1243`, headless). It injected the owner's signed session cookie and opened
`/app/project?project=…` (then `…&pane=channel`).

- The page loaded **authenticated** (title "Caddie", stayed on the project URL — not bounced to sign-in).
- The dev-server log (`/tmp/caddie-devserver-5176.log`) shows `[agent] Coordinator@conv_506d…281960 started`
  (the DO instantiated / `onStart` ran) on the resulting requests.
- BUT the only WebSocket the browser opened was the **Vite HMR socket** (`ws://localhost:5176/?token=…`);
  **no coordinator/Agents WebSocket was established**, and the page logged repeated `500 (Internal Server
  Error)` on resource loads. `GET /agents/coordinator/<conv>` returns 500 (that path wants a WS upgrade,
  not a GET, so the 500 is partly request-shape — but the client never opened the WS either).
- Net: the `__flueWakeAgentSubmissions` schedule stayed `running=0`, no 4th repair attempt ran, repair
  `failures` stayed at 3. The browser did **not** unstick the loop in this environment.

`playwright-cli open` separately failed — its own chromium is not installed
(`chrome-headless-shell-mac-arm64` missing); the repo `@playwright/test` chromium is what was used above.

**Conclusion reinforced:** neither server-side nudges nor the real browser client fire the Agents-SDK
wake alarm in this local miniflare dev server. This is an environment/runtime limitation, not something
an agent session can clear here.

## 6. Preview + screenshots + checklist — NOT REACHED (BLOCKED)

Preview, screenshots (repo `@playwright/test` chromium, dsf-2 desktop + 390px phone) and the delivery
checklist all depend on a green/previewable build. Because feature 3 is not green (and features 4–8 never
started), **none of these were produced.** Claiming any would be fabricated, so none are. No screenshots exist.

## 7. Publish gate — RESPECTED (LOCAL VERIFIED)

`select count(*) from app_publications where projectId='proj_506d61ece6d7ca3a12fdd9a41a281960'` = **0**.
Nothing was published; no deploy/production call was made.

---

## Verdict / what is needed

The paid retry **advanced the build** (render crash fixed; 9/10 tests pass; one narrow regex
SyntaxError remains, one repair attempt from green). It could **not** be carried to green/preview
because the **local Agents-SDK wake alarm does not fire in this miniflare dev server**, and every
server-side nudge available to an agent failed to force it. Resolving this needs a person:

1. **Drive the loop from the real app** — open `http://localhost:5176/app/` in a browser signed in as
   the owner (or add `localhost:5176` to the dashboard's Built-in Browser Local Origins). The browser
   Agents client holds a WebSocket to the coordinator DO, which keeps it warm so the overdue wake alarm
   fires and the repair ladder continues (next route glm-5.3) — very likely clearing the regex error in
   one attempt, then letting features 4–8 build. Then re-run preview + screenshots + checklist.
2. **Or** restart the dev server fresh and immediately drive the retry with the app open, so the DO never
   goes idle long enough for the alarm to stall.

State is intact and resumable: `phase=building`, feature 3 submission `running`, repair `failures=3 active`,
features 1–2 saved. Retry keys used: `farmhand-rebuild-2026-10-26-a`, `…-b`. No fabricated greens.
