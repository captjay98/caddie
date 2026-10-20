# Caddie scheduled end-to-end test and repair

Date: 2026-10-20 (Africa/Lagos). Started about 03:50 Lagos time.
Base revision: `fcb3dec79f4359f13781f23646a42a2492dd00dd` plus the changes documented here.
Runtime: Bun 1.4.0, Node v26.3.0, pinned Flue 2.2.2, local Chromium/workerd.

## Verdict and scope

**LOCAL VERIFIED** for the tested application behavior below. Two application defects were reproduced and fixed. **BLOCKED** for a fresh real model → sandbox → generated app → repair → external delivery journey under this run's local-only, no-paid-provider authorization. This report does not grant full product or production acceptance.

The current repository contains later production deployment/sign-in records; the older fresh-build README's blanket “no deployment” description is stale. Those production claims were not reverified in this run. Existing review findings F01–F05 already have implementations and maintained tests in this revision; they were not reapplied or counted as new fixes.

The two pre-existing untracked documents were preserved:

- `docs/plans/2026-10-19-pwa-flutter-apk-monetization-plan.md`
- `docs/reviews/2026-10-19-pre-final-testing-review.md`

## Acceptance coverage

| Journey/check | Classification | Evidence and limit |
| --- | --- | --- |
| New judge account through the actual sign-in form | LOCAL VERIFIED | Real `/api/judge/start` returned 200; actual Better Auth cookie led to onboarding. No session/API mocks. |
| Profile onboarding and persistence | LOCAL VERIFIED | Country Nigeria, Africa/Lagos, intermediate experience and online format saved; actual profile and completed-onboarding reads verified. |
| Primary authenticated navigation | LOCAL VERIFIED | Actual Brief (`/app/`), Discover, Projects and Settings rendered. `/app/brief` is unsupported, not the Brief navigation target. |
| New project entry | LOCAL VERIFIED | New project button opened the idea composer. A paid AI-created project was not attempted; the zero message quota refused it. |
| Direct project persistence and reload | LOCAL VERIFIED | Actual project API created a scoped synthetic project (201); project Overview survived reload. This API creation is not proof of the AI project-creation path. |
| Discovery refusal | LOCAL VERIFIED | Actual POST returned 403 `JUDGE_LIMIT_DISCOVERY` with zero allowance; UI displayed the explanation. Real event retrieval/matching was not run. |
| Chat refusal, retry and draft recovery | LOCAL VERIFIED | Real 403 quota response now displays its explanation. Unsent text survives reload and Edit restores it. Browser regression additionally verifies identical retry idempotency keys. |
| New project without workflow | LOCAL VERIFIED | Overview says “Let's get started”; no “Caddie is working” claim. Real local project and browser fixture verified. |
| Sign-out and returning judge sign-in | LOCAL VERIFIED | Real UI sign-out made auth status false; returning name/password sign-in made it true. |
| Actor isolation | LOCAL VERIFIED | Second actual local account received 403 for the first account's project; anonymous project list returned 401. Full maintained suite adds broader isolation coverage. |
| Desktop/mobile rendering | LOCAL VERIFIED | Visually inspected synthetic desktop/mobile screenshots; 390 × 844 mobile document width remained 390, with no horizontal overflow. This is not real-phone installation or subjective user acceptance. |
| Plan/design approvals, build/stop/preview, version restore, copied app, GitHub delivery and publishing UI | LOCAL VERIFIED / SIMULATED | Maintained browser suite runs the real composed SPA and SDK. Auth, workflow, model, generated output and integration responses in those cases are network fixtures. No paid build, GitHub write, merge, publish or deploy occurred. |
| Durable dispatch/recovery, budgets, quotas, approvals and project services | LOCAL VERIFIED / SIMULATED | Full service suite includes real local workerd/D1 and SQLite adapters. Injected coordinator/provider boundaries remain simulated. |
| Real OAuth callbacks, AI quality, sandbox-generated output/repair, external delivery, published app and other stacks | BLOCKED | Not executed under this task's local-only/no-paid-call rules. Credential presence or older receipts are not evidence for this run. |

## Fix 1: chat quota refusal was reported as an outage

**Reproduction:** sign into the actual local Worker as a synthetic judge with `JUDGE_MAX_MESSAGES_PER_DAY=0`, send a message, and wait for the 403 response. The server correctly returned:

```json
{"error":"JUDGE_LIMIT_MESSAGES","message":"Judges can send 0 Caddie messages in 24 hours. Everything else works the same."}
```

The settled chat instead said “Caddie can't be reached right now.” The first-send path could omit the error banner entirely. The unsent message was retained; this was an explanation/transport projection defect, not lost work or a quota bypass.

**Root cause:** the initial message uses out-of-band `createFlueClient().send()` before `useFlueAgent` adopts the conversation. That admission failure never enters the hook's error state. The channel then rendered one unconditional connectivity message for all error states. The SDK keeps the public refusal in `FlueApiError.body`; its generic `message` does not expose the server's top-level explanation.

**Change:** `apps/app/src/client/coordinator.ts` now captures rejection from either send path, retains the actual error in the channel source, and scopes it to actor/project so a late rejection does not appear in another conversation. It clears that local failure on the next attempt and still rethrows to the existing draft-retention logic. `conversation/send-failure.ts` accepts only HTTP 403 SDK errors with the known `JUDGE_LIMIT_MESSAGES`, `JUDGE_LIMIT_BUILDS` or `JUDGE_LIMIT_DISCOVERY` codes. Other errors retain the generic fallback; arbitrary runtime details are not displayed. `conversation/Channel.tsx` uses the explanation and labels its icon “Message not sent.”

```tsx
{quotaRefusalMessage(source.error) ??
  "Caddie can't be reached right now. What you send waits here until you send it again."}
```

**Regression:** the new case in `tests/browser/conversation.spec.ts` failed on the old composed build, then passed after rebuilding. It verifies first send, retry, retained text, stable retry key and Edit. `tests/send-failure.test.ts` verifies all three allowed quota codes and rejects generic/private/malformed errors. It is mapped to P06 in `scripts/packet-list.ts`; the coverage completeness gate initially caught the missing mapping, which was corrected.

**Real local verification:** actual judge quota response displayed verbatim; unsent text survived reload and Edit. See [quota refusal](quota-refusal-desktop.png).

## Fix 2: a project with no workflow claimed work was running

**Reproduction:** create a project with a description through the actual project API and open Overview before any plan/build workflow exists. The mobile screenshot showed “Let's get started” alongside “Caddie is working on this right now — its status is in ‘Now’ above.” There was no Now panel and no running work.

**Root cause:** the experience projection intentionally returns `version: 0, stage: 'planning'` when no workflow exists. Overview checked only the stage when computing the note's `working` flag, unlike the Now panel which already respects version 0.

**Change:** `apps/app/src/client/surface.tsx` now requires an actual workflow version before treating that stage as running:

```ts
const working = experienceParsed?.success === true
  && experienceParsed.output.version > 0
  && experienceStage !== null
  && workingStages.includes(experienceStage);
```

**Regression:** `tests/browser/project-v2.spec.ts` gained a no-workflow case that failed before the fix. Its existing active-planning case now also asserts that the activity note remains visible for real work. No schema or server workflow semantics changed.

**Real local verification:** Overview of the persisted synthetic project no longer contained the note. See [desktop](project-desktop.png) and [mobile](project-mobile.png).

## Verification receipts

Final results are for the same final source and composed build, including both fixes:

| Command | Result | Classification |
| --- | --- | --- |
| `bun run typecheck` | Exit 0 | LOCAL VERIFIED |
| `bun run build` | Exit 0; asset composition reported zero collisions | LOCAL VERIFIED |
| `bun run test` with scratch Wrangler paths | Exit 0; 1,548 passed, 0 failed, 7,688 assertions, 116 files | LOCAL VERIFIED, simulated external boundaries |
| `bunx playwright test --reporter=line --global-timeout=420000` with migrated scratch state | Exit 0; 230 passed, 1 optional screenshot-only case skipped; 34.1 seconds | LOCAL VERIFIED, simulated boundaries as described above |
| `bun run verify:packet P06` | Exit 0 | LOCAL VERIFIED |
| `bun run verify:packet U06` | Exit 0 | LOCAL VERIFIED |
| Real local Chromium probe | Actual quota, draft reload/Edit, no-workflow status, sign-out/sign-in, 403 cross-actor denial, 401 anonymous denial; no uncaught page errors | LOCAL VERIFIED |
| `git diff --check` | Exit 0 | LOCAL VERIFIED |

The single intentionally skipped browser case is `tests/browser/app-install.spec.ts`'s optional screenshot capture, gated on `CADDIE_SHOTS`. No behavioral acceptance was removed or weakened.

The build still warns about the approximately 998 kB minified main JavaScript chunk (about 287 kB gzip). This run did not establish a performance regression or change bundling.

## Local runtime setup and initial failures

All custom authenticated testing used a temporary copy of only compiled Worker code, a fresh local D1 database with all 35 committed migrations, and synthetic auth settings at `http://127.0.0.1:8799`. It copied no `.dev.vars` or `.prod.vars`, provided no OAuth/model/search/sandbox credentials, and configured message/discovery/build allowances to zero. Existing development database state was not migrated or reset.

Runtime adjustments, not application fixes:

1. The first sandboxed Wrangler/browser attempts failed on the default registry path and Chromium launch permissions. Writable scratch config paths and approved local execution outside the filesystem sandbox resolved those restrictions.
2. The first unsandboxed preview reused a broken sandbox-started listener; that test-owned process was stopped and restarted cleanly.
3. The isolated Worker initially used Bun to invoke Wrangler. Wrangler requires Node; Node was used thereafter. Mixing top-level Wrangler migration metadata with the Vite plugin's older workerd also caused `_cf_ALARM` column mismatch in disposable state. A fresh database migrated and served with the same plugin-bundled Wrangler 4.97.0 resolved it.
4. Database persistence initially sat inside watched source files, causing reloads. Moving it under the ignored `.wrangler/state` directory stopped that loop.
5. An empty browser scratch D1 caused a 500 console error in the release boot smoke test on one rerun. All 35 migrations were then applied to that scratch database using the same compatible Wrangler; the smoke assertion was retained. The authenticated test Worker had already been migrated separately.
6. Rebuilding while the isolated server was open invalidated its old static asset manifest. Restarting that test-owned Worker loaded the new build. Temporary probes also corrected an assumed `/app/brief` route and supplied the required `workspaceId` on direct project creation; those were probe mistakes.

Scratch browser setup used `XDG_CONFIG_HOME=/tmp/caddie-scheduled-config`, `WRANGLER_SEND_METRICS=false` and `CADDIE_TEST_STATE=/tmp/caddie-scheduled-20261020-preview`. Migrations were applied with the plugin-bundled Wrangler, the original local database ID `local-dev-placeholder`, the repository migration directory, and that scratch persistence root. Unit integration fixtures used scratch config/registry paths as well.

Raw execution logs and temporary real-browser probes remain under `/tmp/caddie-e2e-*` and `/tmp/playwright-test-caddie-*.js`; these are temporary diagnostics, not durable release receipts. The maintained regression tests and screenshots in this directory are the durable proof artifacts. No authenticated cookie/storage files, secret-bearing generated configuration, or runtime database was added to the repository.

## Remaining gate

Run one separately authorized, budget-bounded product journey with real providers: discovery/rules → idea → plan/design decisions → generated build → interactive preview → requested change/injected failure → repair → checked version → delivery. Then exercise restart/reconnect, stop, duplicate/stale decisions and provider outage in that actual runtime. Production OAuth, hosted preview/publishing, generated-app identity/email/AI and non-React stacks require their own target evidence. This local run cannot substitute for them.
