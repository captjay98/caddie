# Caddie: review before final testing

Date: 2026-10-19, Africa/Lagos
Reviewed revision: `3cb4ee5b6317927ca75b2d677ccd44bafd25d004`
Repository: `/Users/captjay98/projects/caddie-forge`
Working tree at review start: clean.

## Verdict

**REQUEST CHANGES before calling the next run final acceptance.** The implementation is substantially stronger than the version reviewed on October 12. Local verification is green. Three targeted local reproductions nevertheless expose handoff and quota defects that should be corrected before judge access is opened or a paid final rehearsal begins.

This is not a recommendation to rebuild the product again. Stabilize the existing work, complete a small number of missing invariants, and then perform a bounded real user journey. The current code is a credible candidate for that testing after the findings below are addressed; it is not yet evidence of a reliable live product.

Review scope: current source and commit history, redesign/submission/publish plans, relevant execution records, workflow and approval delivery, judge access and quotas, context/discovery tools, build checks and recipes, route/UI structure, CI and release evidence. This was not an exhaustive security audit of every publish, egress or generated-app authentication path.

## Fresh verification

| Check | Result | Meaning |
|---|---|---|
| `bun run test` | **LOCAL VERIFIED: 1,428 pass, 0 fail; 108 files; 6,780 assertions** | Current local suite, including service fixtures; not live model acceptance |
| `bun run typecheck` | **LOCAL VERIFIED: exit 0** | Root and app TypeScript checks |
| `bun run build` | **LOCAL VERIFIED: exit 0; zero asset collisions** | Current Astro/Vite/Worker asset composition |
| `bunx playwright test --reporter=line --global-timeout=420000` | **LOCAL VERIFIED UI execution: 212 passed, 44.1 seconds** | Built application, isolated preview state; external/API/model boundaries in these fixtures remain SIMULATED |
| Targeted service reproductions | **Three defects reproduced** | Real migrations/services, local in-memory SQLite/D1-shaped fixture; no provider requests |
| Direct current-app visual review | **BLOCKED** | Browser tool refused the existing tab under its URL policy; no workaround attempted |
| Fresh paid AI/sandbox product journey | **Not run in this review** | No new inference/sandbox acceptance, deployment or publication was performed |

Commands used Bun 1.4.0 and a PATH selecting the supported Homebrew Node before the shell's default Node 22. Browser persistence used `/tmp/caddie-review-20261019-preview`; the user's development database was not reset or migrated.

Local evidence:

- `/tmp/caddie-review-20261019-tests.log`
- `/tmp/caddie-review-20261019-types.log`
- `/tmp/caddie-review-20261019-build.log`
- `/tmp/caddie-review-20261019-browser.log`
- `/tmp/caddie-review-20261019-repro.ts`
- `/tmp/caddie-review-20261019-repro.log`

## What has materially improved

- Server-owned project dispatch replaces the browser as the normal coordinator handoff mechanism. This is the correct direction, though crash handling still has the defect below.
- `project-experience.ts` provides shared workflow-derived status and actions. Plan and design review now have explicit persisted states.
- Build work is broken into ordered features, with host-run checks, saved progress and a stall watchdog. Preview generation is tied to actual recorded output rather than assistant testimony.
- The sandbox installation failure has a dedicated verified installer and a recorded live template probe. This is meaningful infrastructure progress; the README correctly distinguishes it from a complete build through the product.
- Discovery now has actual retrieval adapters, profile-aware matching, sourced rules, uncertainties and plain explanations. The October 11 audit's claim that chat has no profile/discovery connection is obsolete.
- Versions, source snapshots, copied-app previews, application backends, generated-app sign-in, app AI and publishing adapters now exist. They introduce important new integration tests to perform before release.
- Judge access is separate from the owner's OAuth setup; the native email sign-in bypass has been closed; user-count reservations and event quotas exist. A finished example app can be provisioned for new judges.
- CI now derives packet coverage and runs browser acceptance. The six previously stale browser cases are reconciled; the fresh full browser run is green.

## Findings

### F01 — P1: an interrupted handoff can permanently discard the pending message

**Locations:** `apps/app/src/server/workflow-dispatch.ts:91` and `:126`; `apps/app/src/server/build-workflow.ts:533`; cron in `apps/app/src/cloudflare.ts`.

The dispatcher records `dispatched` before calling the coordinator. A later invocation treats that state as proof that delivery succeeded and clears the pending slot:

```ts
if (existing.status === 'succeeded' || existing.status === 'dispatched') {
  await acknowledgeDispatch(db, scope, key);
  return { outcome: 'noop', operationKey: key };
}
// Later in the same function:
await markDispatched(db, key, conversationId);
const result = await deliver({ conversationId, body, idempotencyKey: key });
```

**Trigger:** the Worker stops after `markDispatched` but before coordinator admission. The coordinator never received a submission, so its own restart/drain cannot recover it. Retrying the dispatch clears the pending message without sending it. A concurrent second dispatcher can also clear the slot while the first attempt is still uncertain.

Local reproduction, seeding precisely that production crash cut:

```json
{
  "case": "crash-before-coordinator-admission",
  "dispatch": "noop",
  "sends": 0,
  "pendingBefore": true,
  "pendingAfter": false,
  "phase": "design",
  "watchdogAfterOneHour": 0
}
```

The watchdog only scans `building`; it does not recover a stranded `planning`/`design` handoff. Uncertain delivery is also left in `reconciliation-required` without a coordinator-delivery reconciliation consumer in the inspected code. Comments promising reconciliation are not an implementation.

**Fix:** only an acknowledged coordinator admission/receipt may clear pending work. Keep an explicit in-flight/uncertain state, reconcile by the stable submission/idempotency identity, and implement durable server-side recovery for pre-admission failures. If replay is used, establish the pinned runtime's deduplication behavior for that exact request before retrying. Do not simply remove idempotency or blindly resend.

**Acceptance:** inject crashes before send, after admission/before receipt, and before ack; inject two concurrent dispatchers and a non-2xx response. Each logical request must either reach one accepted submission or show a recoverable blocker, with the original pending intent retained until resolved. Cover planning and design as well as building.

### F02 — P1: judge spending limits are bypassable through alternate AI entry points

**Locations:** `apps/app/src/server/coordinator-host.ts:727`; `apps/app/src/server/routes/runs.ts:220`; `apps/app/src/agents/hello.ts`.

The two HTTP discovery mutations call `admitJudgeDiscovery`, but the chat tool calls the paid discovery service directly:

```ts
discover: (input) => discoverForActor(env.DB, scope, input, {
  tavilyApiKey: env.TAVILY_API_KEY,
  nebiusApiKey: env.NEBIUS_API_KEY,
}),
```

A local reproduction configured an active judge with `JUDGE_MAX_DISCOVERY_PER_DAY=0`, passed a fake fixture key, and replaced all fetches with a rejecting local stand-in. The host discovery tool still attempted retrieval and recorded no usage:

```json
{
  "case": "chat-discovery-zero-quota",
  "limit": 0,
  "attemptedNetwork": 2,
  "discoveryError": null,
  "usageRows": { "n": 0 }
}
```

No requests reached the network. This proves the quota boundary is absent on the chat path; it is not a measurement of real spend. Normal chat has a message cap, but that does not enforce the separate discovery cap or guarantee one retrieval per message.

Separately, the scaffold `/agents/hello/*` guard checks session authentication only, while `Hello()` selects the paid helper model. A signed-in judge can reach an AI agent outside the coordinator message quota. This second path is source-confirmed, not exercised against a live model.

**Fix:** centralize paid-capability admission in the shared server service/tool boundary and pass the effective deployment limits. Ensure HTTP and chat paths count the same logical action once. Cover research and other paid helpers deliberately; do not leave them accidentally unlimited. Remove the scaffold agent from production or put it behind the same quota/role controls.

**Acceptance:** with every relevant limit at zero, HTTP discovery, chat discovery/research and all exposed model routes must make zero provider calls. At the limit, replay remains idempotent. Verify the normal non-judge path separately and do not double-charge a tool call already admitted through a route.

### F03 — P2: concurrent project creation exceeds the judge project cap

**Locations:** `apps/app/src/server/judge-limits.ts:251`; `apps/app/src/server/projects.ts:256`; also the chat intake's separate check/insert path in `build-workflow.ts`.

Admission reads the current count and returns; the caller inserts the project later:

```ts
if ((await countJudgeProjects(db, userId)) >= limits.projects) {
  throw new ScopeError(403, 'JUDGE_LIMIT_PROJECTS', ...);
}
// In createProject(), after the helper returns:
await insertProject(db, project);
```

Five simultaneous calls against an active judge with a three-project limit produced:

```json
{"case":"concurrent-project-cap","allowed":3,"created":5,"stored":5}
```

This is a service-level race reproduced with real migrations and a local D1-shaped adapter, not proof from deployed D1. The production statements likewise contain no atomic quota reservation linking the read and insert.

**Fix:** combine conditional admission with durable creation/reservation, and share it across direct creation, chat and repository-start paths. Keep Home/example exemptions explicit. Failed creation must not permanently consume a slot; replay of an existing project must not take a new slot.

**Acceptance:** start at two projects and issue several concurrent creates through mixed paths; exactly one additional project may persist. Repeat on a real D1-compatible runtime for the transactional semantics.

### F04 — P2: project Overview reads a different preview truth from the built-app workflow

**Locations:** `apps/app/src/client/surface.tsx:785` and `:925`.

The “Your app” panel fetches the older `/projects/:id/previews` metadata once per project, separately from workflow output/import-preview state. Its fallback says:

```tsx
Your app appears here once the plan is approved and built.
```

A generated checked output or copied judge example can be available through the workflow while this older private-share list is empty. Even a new share created while the page remains mounted does not update this local state automatically. When a share exists, the panel tells the user to find the link in chat rather than providing the direct action.

**Fix:** derive available app/version from the shared experience plus workflow/import-preview result. Distinguish “app available” from “share link created”, and provide “Try app” directly. Subscribe/invalidate the relevant query when output changes. This is a focused consistency fix, not a reason for another broad redesign.

**Acceptance:** checked app with no private share, copied example with no build workflow, build becoming ready while Overview is open, revoked share with an owner-accessible app, and unavailable output. The overview and chat must agree in each state.

### F05 — P2: recorded live receipts cannot establish readiness of a particular release

**Locations:** `scripts/live-receipts.ts:25–56`; `scripts/release-check.ts:85–96`.

Receipts contain packet, files, pass count and timestamp, but no tested code revision, target environment or artifact identity. `readLiveReceipts` checks only packet/file-list shape. The release check grants PASS for any loaded receipt:

```ts
status: receipt ? 'PASS' : gate.configured ? 'PROVISIONED' : 'BLOCKED'
```

Consequently an old receipt can satisfy the same packet after code, mapped specs or target environment change. Even missing current provisioning does not prevent the receipt branch from reporting PASS. This is especially important before the new final run starts producing receipts.

**Fix:** record tested SHA (or source/artifact digest when appropriate), environment/target, exact spec-set digest, positive pass count, relevant versions and receipt identifiers. Validate shape and compatibility with the release candidate. Retain old records as historical evidence, but classify mismatched receipts as stale rather than current PASS. Do not make documentation-only changes unnecessarily invalidate identical tested artifacts; define that policy explicitly.

**Acceptance:** missing fields, zero passes, changed code/artifact, changed spec list and wrong environment cannot satisfy the current live gate. A valid matching receipt can. Presence of credentials remains provisioning only.

## Product and surface assessment

This table is based on source inspection and fresh automated browser coverage, not a fresh subjective visual review. The browser-policy restriction prevents signing off current visual cohesion, padding or mobile appearance by direct inspection in this session.

| Surface | Assessment | Before final acceptance |
|---|---|---|
| Sign-in/onboarding | Normal and judge paths exist; two-step profile is an intentional later change, not an accidental loss of the earlier three-step plan | Real returning/new-user and judge onboarding with normal auth; expiry and account switching |
| Caddie chat | Rich workflow cards, contextual actions, attachments and server handoffs are present | Fix F01/F02; evaluate actual model behavior, repetitions, continuity and response latency |
| Brief | Retained as primary actionable feed; read state separate from decisions | Validate real build/rules/preview events arriving while away, deduplication and correct action targets |
| Discover | Live adapters, checked rules, assumptions and plain fit explanations are substantial progress | Fix shared paid admission; run real matching from a completed profile and verify source/freshness |
| Projects | Current status and ready example/copy support present | Test empty/new/returning accounts and concurrency; confirm direct next action |
| Project Overview | “Now”, idea, app and task sections exist | Fix F04 and review the number of competing status blocks |
| Plan/design | Persisted plan and design decisions exist | Explain the two decisions clearly; no repeated approval for an unchanged revision |
| Build/preview | Feature loop, output checks, backend preview and saved versions implemented | Full generated app through the actual UI; real interaction/reload and failure/retry/stop |
| Checks/details | Receipt and activity surfaces exist | Ensure failures explain impact/recovery and do not require the user to debug |
| Submission/Share | Contextual capability exists, but still separate routes | Verify actual generated app/repository/demo evidence populates package; no invented compliance |
| Settings/spending | Profile/appearance/connections/routines present | Spending remains unmetered for main Caddie inference; define an operator ceiling for live testing |
| Imported projects | “Start from my GitHub repo” and copied preview implemented | Test the supported Caddie-generated-app import; do not advertise arbitrary-repository support beyond proven scope |
| Publish/app keys/app logins/app AI | Considerable implementation; new external boundaries | Dedicated deployed tests required; local pass does not prove Workers for Platforms, Artifacts, email or outbound behavior |
| Judge example | Locally tested seeding and ready-card behavior | Configure a suitable demo project and verify first login on the actual hosted environment; seeding alone is not setup |

The original consolidation plan is not fully implemented literally: `ProjectTabs.tsx` still exposes Plan/Build/Check/Submit and those routes still render separate pages. The newer project view has improved significantly, but route reduction is partial. Do not mark the entire October 12 UX plan complete merely because R06 is labelled done in an older ledger. Decide from actual usability whether further consolidation is necessary; do not undertake a large refactor just to match a filename in the plan.

## Remaining evidence gaps, distinct from defects

1. **A real new app through current Caddie.** README explicitly says the recent live success is the generic scaffold, not a complete product-driven build. A model endpoint probe and template test do not close this gap.
2. **AI quality under the currently selected routes.** Context/tool wiring and local scripted evaluations cannot establish that the live assistant understands, plans, repairs and explains well. Test the full request and a subsequent change, not only a single builder turn.
3. **Deployed integrations.** Hosted judge login/example, Worker Loader previews, publishing, Artifacts, generated-app sign-in/email and app AI need target-environment evidence.
4. **Four other output stacks.** README correctly calls their live gates blocked. Keep full-scope readiness separate from a React/Hono milestone.
5. **Cost control.** `reserveBudget` remains without application callers. Judge quotas are operation counters, not a dollar ceiling. Main inference and sandbox spending need an explicit operator-bound test budget even after F02/F03 are fixed; do not claim automatic spend limits from the existence of `budgets.ts`.
6. **Performance/visual review.** The main JS bundle is about 992 kB minified / 285 kB gzip; CSS about 171 kB / 28 kB gzip. This is a measurement, not proof of slow navigation. Measure actual navigation/first useful response on mobile and a populated account before prioritizing splitting. Direct visual approval is still outstanding.

## Recommended next sequence

1. Fix F01–F03, add the demonstrated regression cases to the maintained suites, and rerun their targeted checks.
2. Fix F04 and F05 before final evidence capture. These are bounded changes, not a new product redesign.
3. Establish one reproducible release candidate, current migration state, normal authenticated browser and explicit test spend ceiling. Configure the judge example deliberately; retain its source/version.
4. Run the primary journey: profile -> find a real suitable hackathon -> inspect rules -> idea -> saved plan/design -> approval -> build -> interactive preview -> requested change -> checked new version -> submission preparation.
5. Run a separate personal todo journey to isolate build reliability from discovery, with add/Enter/trim/reject blank/complete/reopen/delete/filters/clear completed/counts/persistence/reload/mobile/keyboard checks against the generated app. Do not hand-build it outside Caddie or weaken failed assertions.
6. Exercise close-tab/reconnect/restart, duplicate decisions, provider outage, stop during work, exhausted quota, stale approval and no-progress recovery. A success-only demo is insufficient.
7. Run a judge rehearsal on the deployed environment, then separate publication/import/generated-app identity and billing tests. Keep remaining-stack readiness separately tracked.
8. Record exact receipts and obtain nontechnical-user feedback before a release decision. No new feature expansion until these journeys are stable.

No application source was changed by this review. The report and temporary local reproductions are the review deliverables; normal generated test/build artifacts were produced. No new paid API acceptance or deployment was performed.
