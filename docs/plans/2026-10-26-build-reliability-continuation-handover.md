# Build reliability — continuation handover

**Date:** 2026-10-26, Africa/Lagos. **Task:** finish the approved implementation, verify it, then attempt a controlled local Farmhand resume. Return the completed diff and evidence for independent review by the original agent.

This file supersedes the **starting-state and remaining-work** sections of the older handover. The implementation authority remains `docs/plans/2026-10-25-build-reliability-execution.md`, including B00a and B02a. Do not write another replacement plan or start the implementation again.

> **Implementation checkpoint (2026-10-26):** R1–R3 are implemented and locally verified, including the actual isolated runtime executor and built-state navigator. Full suite: 2,783 passing; affected browser suite: 117 passing, one pre-existing skipped. See [completion evidence](../evidence/2026-10-26-build-reliability-completion.md) for current R4/runtime status. The starting-state descriptions below are historical; do not restart this work from them.

## 1. Current state and ownership

Repository: `/Users/captjay98/projects/caddie-forge`, shared `main` checkout.

Snapshot at handover:

- HEAD: `9af01e7 fix(app): idea onboarding lands on the split, not mobile chat-only`.
- Other agent's recent commit: `29197b6 fix(app): judge sign-in is its own titled form; subtitle breaks at the dash`.
- Reliability checkpoint: `6207f97 fix(build): persist repair escalation and bound provider work`.
- Earlier helper checkpoint: `d81dd87 fix(models): bound and account for physical helper retries`.
- There is substantial **uncommitted and untracked reliability implementation** on top. It is intentional work to audit and complete, not disposable noise. Capture fresh status/diffs before editing.

The other agent's recent committed work concerns authentication, onboarding destinations, routes and workspace styling. Preserve it. Build/chat/agent files, shared contracts, migrations and shared test registration are the overlap zone. Have one integration owner edit those serially; do not run competing build orchestration changes.

```sh
git status --short
git log -8 --oneline
git diff --stat
git diff --check
```

Do not blanket-reset, stash, clean, stage everything, overwrite another agent's files, or deploy. Checkpoint coherent verified packets using explicit-file staging and established Conventional Commits.

## 2. Read before editing

1. Root and applicable directory `AGENTS.md`; `docs/flue-contracts.md`.
2. `docs/plans/2026-10-25-build-reliability-execution.md` — full approved scope.
3. `docs/evidence/2026-10-25-build-reliability.md` — especially **Root takeover**, not just earlier COMPLETE headings. Some older close-out claims were not supported by runtime wiring.
4. `docs/plans/2026-10-25-build-reliability-handover.md` — original research/model evidence, with this file's newer implementation state taking precedence.
5. `docs/evidence/2026-10-25-model-validation/README.md`, `results.json`, `screenshots.json` — existing limited LIVE VERIFIED model calibration. Preserve these results; do not overwrite or rerun paid probes by default.

Caddie is for people who have never coded. It owns debugging, implementation choices, repair and model selection. Users review scope/design and try the app. An exhausted or unavailable build must report saved work and incomplete behavior plainly, never ask the user to inspect logs or fix code.

## 3. What is already implemented

### Committed foundation

`6207f97` includes:

- Durable checked-repair counters, receipt replay protection and pinned model selection.
- Registered/priced DeepSeek and GLM routes; existing role defaults retained.
- Actual provider request/stream cancellation bounds and disabled invisible SDK retries.
- Bounded content/outcome loop fingerprints, including alternating A/B cycles.
- Initial stale-result checks and removal of generic prior-red-check acceptance for flat test counts.
- Benchmark finite-budget validation and withholding host acceptance data from the executor.

```ts
const repairRoutes = [
  'nemotron-3.5-super-vl',
  'deepseek-v4.1-flash-1017',
  'glm-5.3',
];
// Two checked failures per model, six total, within the SAME admission/payer.
// Vision eligibility excludes the text-only glm-5.3 route.
```

### Uncommitted work to preserve and review

| Area | Main files | Actual state |
|---|---|---|
| Draft publication boundary | `server/artifact-quality.ts`, `projects.ts`, migration 0050 | Candidates stay outside published plan revisions; SQL triggers require an exact passing review, newest candidate and unchanged dependencies. New-policy projects only. |
| Independent reviewers | `server/artifact-quality-model.ts`, `packages/contracts/src/artifact-quality.ts` | Read-only plan/visual reviewer calls; pinned routes, real PNG input, bounded corrections, original preparation payer and per-call receipts. Local tests use fake model transport; no fresh live generation proof yet. |
| Design preview capture | `server/design-review-capture.ts`, `scripts/local-design-review-capture.ts`, `scripts/serve-design-capture.ts` | Actual isolated Chromium PNG capture works locally at phone/desktop sizes. This captures draft appearance, not functional generated-app behavior. |
| Recovery context/environment | `server/build-resume-context.ts`, `build-environment.ts`, agent `host-context.ts` | Durable stack/recipe guard and bounded recovery context wired to versioned repair admissions. Do not confuse a mutable working checkpoint with the base image. |
| Task deadlines | `server/task-deadlines.ts`, `task-deadline-context.ts`, `app.ts`, `agents/bounded-provider.ts` | Persisted delegate deadlines, async-local signal propagation, model/command cancellation and host guards. Current timeout callback blocks the build; audit automatic recovery/escalation expectations rather than declaring this complete. |
| Strong feature acceptance | `server/independent-acceptance.ts`, `coordinator-host.ts`, migration 0052 | Strict receipt validation and a private service interface are wired. **The actual independent runtime executor and criteria-to-check mapping are NOT implemented.** |
| Complete state comparison | `server/visual-fidelity.ts`, `coordinator-host.ts` | Complete declared inventory is considered; missing state navigation returns not-checked. **The actual built-app `captureState` navigator is NOT implemented.** |
| Completion safety | `build-features.ts`, `build-workflow.ts`, `coordinator-host.ts` | Added atomic phase/admission/design fences and publication-time design approval checks; final diff/race review remains necessary. |
| Accounting | `spend-instrument.ts`, `model-call-instrument.ts`, migration 0051 | Unknown/errored usage retains liability; actual completion metadata excludes private thought text. Preparation author/reviewer calls share the existing ledger. |
| Presentation | `conversation/Channel.tsx`, `ReplyText.tsx`, `ProjectWorkflow.tsx`, `draft-artifact.ts` | Raw draft specs/mockups are guarded behind an optional original-response inspector; published project artifacts remain the review authority. Preserve historical approved content. |

The source/test helpers are not proof these features work end to end. Do not satisfy missing executors with injected all-green ports or rename an author test count as independent acceptance.

## 4. Local database and running services

Farmhand:

```text
project: proj_506d61ece6d7ca3a12fdd9a41a281960
local URL: http://localhost:5176/app/runs?project=proj_506d61ece6d7ca3a12fdd9a41a281960
last observed: paused / Needs attention, 2 of 8 features checked
next feature: mortality/weight/water/observation/medication/vaccination logs
```

**Farmhand has NOT been resumed by this agent.** Re-read current state; another agent/user may have changed it.

- Existing local D1 and DO state was preserved. A consistent backup of all 16 SQLite files is at `/private/tmp/caddie-before-reliability-shixm28d`.
- Local migrations have been applied through **0053**. Migrations 0049–0053 remain untracked in Git: preserve them and their numbering. Never reuse or renumber an applied migration; corrections need a new migration.
- No database reset was authorized. “We might have to reset” is not permission to erase history. Use an isolated new local persistence directory for a fresh-run test, retaining the current database/checkpoints.
- Real local D1 previously identified at `apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c204843922c7d8b0460aacd7d5eef263a2ad6de9bd92c76a90ee80ed8b6b331b.sqlite`.
- Apply tracked migrations using the Wrangler bundled with `@cloudflare/vite-plugin`, matching the current dev runtime. Its path was saved in `/tmp/caddie-dev-wrangler-bin.txt`. Do not substitute a different Wrangler against these DO files, or blindly replay all ALTER statements.
- A private local capture service was started at loopback **5191**. Its config is `apps/app/.wrangler/reliability-capture.json`; captures are under `.wrangler/reliability-captures`. Inspect liveness before starting another copy.
- `DESIGN_CAPTURE_URL` and `DESIGN_CAPTURE_TOKEN` were added to gitignored `apps/app/.dev.vars`. Never print, commit or copy their values into a handover/report. The service requires authorization and denies network/scripts in draft HTML.

New policy switches remain opt-in:

```text
CADDIE_REPAIR_POLICY=repair-v1
CADDIE_QUALITY_POLICY=quality-v1
```

Do not enable the strict quality policy broadly while independent runtime acceptance/state-navigation infrastructure is absent. Preserve legacy approvals. Explicit Retry can admit a new repair policy; a model switch cannot open a fresh payer or reset counters.

## 5. Remaining implementation packets

### R1 — Audit and stabilize the existing uncommitted implementation

Read the actual diff before building on it. Prioritize:

- Real Flue task-boundary cancellation, not only pure helper tests. Confirm the async-local deadline survives the real runtime's delegate execution and recovery.
- The task timeout callback currently pauses work. Distinguish uncertain writes that require reconciliation from a safe read-only/model failure that Caddie can recover from automatically. Do not make users solve an internal timeout.
- Prove Stop/deadline/new admission immediately before a late mutation cannot advance a feature or publish an older build/design. Keep money, approval and membership checks authoritative.
- Review candidate concurrency, correction limits, exact dependency binding, replay after an uncertain model request, and complete physical-call accounting. Unknown usage is not free.
- Preparation defaults ($1, 15 minutes and 48 calls per stage/dependency admission) are engineering bounds, not measured-optimal product limits. Do not silently raise them to make tests pass.
- Add finite cancellation bounds to service seams that could ignore an AbortSignal; propagate cancellation to the real work and fence late callbacks. A Promise race alone is insufficient.

**Checkpoint:** targeted runtime/SQL/race tests pass; no unsupported completion claim or hidden spending reset.

### R2 — Implement the actual independent acceptance executor (B04)

Current seam:

```ts
interface IndependentAcceptancePort {
  check(input: {
    identity: AcceptanceIdentity;
    criteria: readonly AcceptanceCriterion[];
    operationKey: string;
    signal?: AbortSignal;
  }): Promise<IndependentAcceptanceResult>;
}
```

`FEATURE_ACCEPTANCE` is only the private service adapter. Implement a real host-owned executor and a versioned mapping from approved feature criteria to executable checks. The builder must not be able to weaken those checks.

- Cover prior verified features as well as the current feature.
- Exercise persistence/restart, isolation between real app users, retry/error handling and offline/reconnect when required by the approved scope.
- Bind results to exact plan, approved design, admission, checked image and criterion identity. Replayed receipts must not spend or execute twice.
- Use the existing recipe/contract generation and runtime where applicable: `server/host-checks.ts`, `contract-files.ts`, existing contract restart tests, and `scripts/brief-run/browser-check.ts`/`app-users.ts` provide useful proven components. The latter currently expects a ready preview; do not create premature public readiness just to reuse it.
- Safely check an unpublished candidate in isolation. Do not execute generated code in the host process, expose credentials, or invent another application runtime.
- Include deliberately broken app fixtures: fake saving, lost data after restart, cross-user leakage, dropped offline queue, missing promised behavior, and meaningless extra passing tests. Each must fail for its actual defect.

**Checkpoint:** a correct generated/representative app passes real checks and each defective app fails; a green stub is SIMULATED only.

### R3 — Implement built-app screen/state navigation and comparison (B06)

`FidelityPort.captureState` must really open/navigate the corresponding state in the checked app. It must not capture the home screen repeatedly under different labels.

- Derive a complete required screen/state inventory from the approved design and supported interaction contract.
- Capture required happy/empty/loading/error/recovery states at phone and desktop sizes. Missing coverage cannot silently pass; avoid truncating to the first four states.
- Bind PNG bytes/hash, document/image identity, dimensions and operation keys to actual captures.
- Reuse the isolated preview/browser machinery and existing local capture implementation. Preserve network/secret isolation.
- Keep appearance evidence separate from persistence/offline/integration evidence. Static design PNGs do not prove functioning app behavior.

**Checkpoint:** broken navigation, overflow and omitted states are caught by real browser tests; new-policy builds cannot publish a complete verification claim without complete evidence.

### R4 — Final verification, controlled resume, fresh-run preparation

1. Finish R1–R3 and review the combined diff.
2. Run typecheck, affected tests, the full suite, composed build and relevant browser suites against a fresh bundle.
3. Checkpoint only verified owned files. Record final SHAs, remaining limitations and rollout settings.
4. Re-read Farmhand's actual state and original approval/checkpoint. The user authorized a controlled local resume; preserve the original plan/design and existing spending cap. Do not silently rewrite scope or erase history.
5. Try resuming, then observe real persisted activity and progress. A Working label alone is not evidence. Confirm operations/checks/feature changes, actual payer/model attribution and truthful stop/recovery behavior.
6. Prepare a separate fresh local run if needed. Do not wipe the existing database. Broad paid benchmark execution and deployment require their own appropriate authorization; prepare the runner locally first.

## 6. Verification evidence and commands

Latest **completed broad run** before the final source-assertion updates:

```text
2765 passed / 2 failed, 239 files, 168.57 seconds
/tmp/caddie-reliability-full-final.log
```

The failures were outdated source assertions in `tests/plan-features.test.ts` and `tests/coordinator-followups.test.ts`. They were updated for guarded draft rendering and trusted author-route metadata. Their affected tests passed afterwards, but **the final entire tree has not had a completed clean full rerun**. Additional task/state/fence changes followed that broad run.

Other useful LOCAL VERIFIED evidence (not a whole-tree release verdict):

- Root and app typechecks repeatedly passed during the packets.
- Quality/host integration packet: 129 passed (`/tmp/caddie-quality-host-integration.log`).
- Quality/coverage/registry packet: 120 passed (`/tmp/caddie-quality-final-targeted.log`).
- Atomic fence/deadline packet: 112 passed (`/tmp/caddie-final-fence-tests.log`).
- Actual Chromium captured two draft states at both viewports; manifest `/private/tmp/caddie-quality-capture-proof/manifest.json`.
- Private HTTP capture endpoint returned 401 without authorization and valid phone/desktop PNGs with authorization; `/private/tmp/caddie-quality-capture-proof/http-manifest.json`.
- A composed build passed, but rebuild after the final source changes. Earlier bundle success is not proof of current dist.

Temporary logs/capture files may disappear; rerun when absent. Never infer LIVE VERIFIED product acceptance from local fixtures or static screenshots.

```sh
bun run typecheck
bun run verify:packet REL26
bun test tests/workflow-dispatch.test.ts tests/sandbox-durability.test.ts tests/spend-instrument.test.ts tests/model-call-instrument.test.ts
bun run test
bun run build
bunx playwright test tests/browser/focused-project-chat.spec.ts tests/browser/looks-picker.spec.ts tests/browser/project-workflow.spec.ts tests/browser/design-review-team.spec.ts tests/browser/build-progress-team.spec.ts tests/browser/visual-fidelity.spec.ts
```

Workerd/Chromium tests need local server/process permissions. Do not misdiagnose a sandbox startup failure as an application defect. Do not run competing composed builds against the same dist directory or accidentally test stale servers. Browser fixtures honor `CADDIE_BROWSER_BASE` and `CADDIE_TEST_BASE_URL`; set both consistently when using an isolated alternate port.

Read/register every new suite in `scripts/packet-list.ts`; the NET completeness test is mandatory. No paid model calls are required for deterministic local/fault gates.

## 7. Review return package

Give the original reviewer:

- Final commit identities and any remaining dirty files with ownership.
- A concise implementation map for R1–R4 and original B00a/B02a/B04/B05/B06 gates.
- Exact command exits and current bundle identity.
- Actual runtime/capture/behavior receipts, with LOCAL VERIFIED / LIVE VERIFIED / SIMULATED / BLOCKED distinctions.
- Farmhand's before/after state, preserved checkpoints, spending attribution and observed progress or concrete blocker.
- Policy rollout status, database migration state and rollback instructions.
- Any service still absent or any criterion/state still unchecked. Do not hide it behind a helper, a port interface or a completion label.

The original agent will independently review the code and rerun targeted evidence after implementation. Do not deploy this new wave as part of the handover.
