# Build reliability implementation plan

**Status:** Ready for staged local implementation; includes owner-selected models, completed live model preflight, and the incident-review amendments below. Documentation is not implementation evidence. The previously implemented repair-window correction remains LOCAL VERIFIED; the remaining packets are not complete.

**Goal:** A nontechnical user can approve a sensible app, leave Caddie working, and return to a usable, independently checked result—or a clear, recoverable blocker—with verified work preserved.

**Architecture:** Retain Flue as execution authority and the existing host as approval, scope, budget and evidence authority. Extend existing operations, receipts, checkpoints and repair-window policies instead of introducing a competing workflow engine. Separate model/transport retry, code repair and explicit user recovery.

**Tech Stack:** Existing Bun/TypeScript application, Flue 2.2.2, Cloudflare Worker/Durable Objects/D1, current sandbox adapters, React and Playwright.

**Authority:** This file defines execution order and acceptance for the new reliability wave. Start with [the handover entry point](2026-10-25-build-reliability-handover.md) for the reading order and current evidence boundaries. [The source review](2026-10-25-build-reliability.md) explains findings and the twelve-project comparison. The fresh-build contracts and `docs/flue-contracts.md` remain authoritative runtime boundaries. This plan does not change approval authority or authorize paid calls, deployment or publishing.

---

## Product contract

The default experience remains: describe the outcome → review plan/design → approve → try the app. Caddie owns implementation choices, technical troubleshooting and safe recovery. Detailed checks, logs, commands and files remain optional.

A successful build means the approved journeys work, prior functionality remains intact, and the preview corresponds to the verified code and design. A passing process exit or an increased test count alone does not mean completion.

## Invariants

1. One logical effect has one durable identity. Transport retries do not create a second write or monetary reservation.
2. Ambiguous effects are reconciled with the provider receipt before replay; unknown is not failed or succeeded.
3. A passed feature retains its checkpoint across a failed repair, browser refresh and process restart.
4. Stop, revocation and exhausted limits prevent new effects; late callbacks cannot revive stopped work.
5. Only an authenticated explicit recovery opens a new repair/spend window. Reconnecting or reading status never does.
6. Completion evidence binds to the exact project, plan/design, feature, code/checkpoint, command/check version and actor scope.
7. A connection attempt is not build progress. Persisted Building status is not proof a worker is currently active.
8. Compaction may shorten active context; it must not discard decisions, pending effects, failed-attempt evidence or remaining limits.

## Execution discipline and ownership

- Stay in the existing shared checkout unless isolation becomes necessary. Capture HEAD/status before changes; preserve other sessions' WIP and the imported-app review routing fix.
- Integration lead applies shared contracts, migrations, manifest changes and packet mapping serially. Read `docs/flue-contracts.md` before changing agent/runtime code.
- For every packet: write the regression/fault case, run it and record the failure, implement the smallest responsible change, run its targeted suite, then run the nearest complete gate. Review the diff before a coherent commit. Stage explicit owned files only.
- Commit examples follow the existing Conventional Commits pattern: `test(build): cover interrupted operation recovery`, `fix(build): reconcile interrupted checks`, `feat(build): verify feature acceptance`.
- Use additive, append-only migrations with a new migration tag if needed. Do not allocate numbers until checking the current migration list. Preserve old records and readers during rollout.
- Classify each result: LOCAL VERIFIED, LIVE VERIFIED, SIMULATED, DOCUMENTATION ONLY, FAILED or BLOCKED. Local sandbox stubs do not establish live model quality.
- Each packet has an evidence checkpoint and can be paused independently. No implementation in this planning turn.

## B00 — Establish the baseline

**Owner:** Integration lead. **Depends on:** nothing.

**Read:** `apps/app/src/agents/permissions.ts`, `coordinator.ts`, `server/coordinator-host.ts`, `build-workflow.ts`, `operations.ts`, `build-features.ts`, `workflow-dispatch.ts`, `docs/flue-contracts.md`.

1. Capture current SHA, dirty files, installed runtime versions and supported output recipes. Verify the live local server's actual bundle identity.
2. Re-run the repair-window regression. Confirm explicit resume permits three new failures while all six historical failures and the prior checkpoint survive.
3. Record current Farmhand state read-only. Do not resume, stop or modify its approved artifacts to obtain evidence.
4. Create the reliability evidence ledger and a scenario-to-test index; retain the existing upstream source inventory.
5. Reconcile the historical incident report in `docs/research/2026-10-25-build-harness-reliability.md` with the current code. Trace the reported 103-minute interval to a concrete request/task/submission/operation identity; a model-usage duration alone does not locate the failed boundary. Reuse the already-installed spending interceptor, coordinator submission durability, sandbox command quotas and pi-ai retry facilities. Record effective switches, payer attribution, runtime/provider versions and retry/timeout configuration; do not create parallel controllers or infer live enforcement from configuration alone.

**Commands:**

```sh
bun run typecheck
bun test tests/build-workflow.test.ts tests/workflow-dispatch.test.ts tests/sandbox-durability.test.ts tests/build-spend.test.ts
```

**Gate:** current failures and pre-existing failures are identified. Existing unverified claims are not inherited as proof. The prior R00 repair-window fix is independently rechecked, not reimplemented.

## B01 — Build the failure laboratory

**Owner:** Build verification. **Depends on:** B00.

**Modify:** `tests/fixtures/sandbox-stub.ts`, `tests/build-workflow.test.ts`, `tests/workflow-dispatch.test.ts`, `tests/sandbox-durability.test.ts`.
**Create:** `tests/support/build-faults.ts`, `tests/build-fault-recovery.test.ts`, `docs/evidence/2026-10-25-build-reliability.md`.

1. Add deterministic injection points before dispatch, after remote acceptance, after receipt, after checkpoint and before product-state persistence.
2. Reproduce interrupted edits/checks, duplicate delivery, late completion after Stop, lost receipt, provider rate limit, exhausted quota, stale approval and restart during verification.
3. Recreate the narrow Farmhand failure shapes without private prompts or paid calls: repeated pause, interrupted repair and stale status with unavailable history.
4. Assert final state, effect count, retained checkpoint, budget accounting and public status—not just return values.
5. Add fake-clock cases for an HTTP request that never resolves, a stream that stalls after starting, an endlessly active stream with no feature progress, a specialist that never settles and a command whose cancellation is delayed. Assert the applicable deadline actually settles work.
6. Add cases for output-cap truncation, an empty answer after successful tools, an empty no-progress answer, lost/unknown tool effects, Retry-After beyond the remaining deadline and nested retry amplification. Restart and duplicate delivery must not reset deadlines/counters.
7. Exercise Stop and timeout immediately before dispatch, during a provider backoff, during a sandbox operation and immediately before a late completion callback. Assert no new effects or feature advancement, preservation of earlier checkpoints, and truthful public state.

**Command:** `bun test tests/build-fault-recovery.test.ts tests/workflow-dispatch.test.ts tests/sandbox-durability.test.ts`.

**Gate:** each injection is deterministic and shows the intended boundary. A failing implementation may produce an expected RED test, but the fixture itself must not fail because its environment is missing.

## B02 — Unify failure and recovery decisions

**Owner:** Runtime integration lead. **Depends on:** B01.

**Modify:** `apps/app/src/server/operations.ts`, `workflow-dispatch.ts`, `build-workflow.ts`, `coordinator-host.ts`, `model-call-instrument.ts`, `spend-instrument.ts`, `apps/app/src/agents/coordinator.ts`, `specialists.ts`, `providers.ts`, `permissions.ts`, and the existing sandbox adapter only where signal propagation requires it.
**Create:** `apps/app/src/server/build-recovery.ts`, `tests/build-recovery.test.ts`, `tests/build-deadlines.test.ts`, `tests/build-empty-result.test.ts`.
**Extend:** `tests/model-call-instrument.test.ts`, `tests/providers.test.ts`, `tests/build-spend.test.ts`. Any new usage columns need a serially allocated append-only migration; do not renumber existing migrations.

Proposed internal outcome vocabulary, to adapt to existing contracts rather than duplicate them:

```ts
type BuildFailureKind =
  | 'transient-service'
  | 'code-check'
  | 'effect-unknown'
  | 'needs-user'
  | 'budget-exhausted'
  | 'cancelled';

type RecoveryAction =
  | 'retry-same-operation'
  | 'repair-code'
  | 'reconcile-receipt'
  | 'wait-for-user'
  | 'stop';
```

1. Add a pure tested classifier. Temporary service failures get bounded backoff; code failures get a repair task; uncertain writes get receipt reconciliation.
2. Preserve logical operation keys and approvals across physical attempts. An explicit resume may open a new window; an SDK reconnect may not.
3. Make known terminal settlements promptly project into product state. First inspect Flue's existing lifecycle/recovery hooks; retain the watchdog as fallback and avoid a second scheduler.
4. End active orchestration on paused/cancelled/exhausted results. Do not spend more model turns rediscovering an unchanged pause.
5. Prove restart, Stop/late receipt races, same-key replay, revocation and quota cases from B01. Preserve current actor/project isolation.

**Command:** `bun test tests/build-recovery.test.ts tests/build-fault-recovery.test.ts tests/build-workflow.test.ts tests/workflow-dispatch.test.ts tests/build-spend.test.ts`.

**Gate:** no duplicate effects/reservations or lost verified checkpoints in the exercised cases; stale callbacks cannot advance work. Unknown outcomes remain explicitly reconciling.

**Rollback:** revert the new policy wiring; retain immutable operation/receipt history. Do not delete evidence or reset approvals to recover.

### B02 required controls — deadlines, empty results and cancellation

These are mandatory B02 acceptance requirements, incorporated from the incident review. Implement them before B03 and before enabling model escalation. They extend existing Flue/provider/host controls rather than adding a separate scheduler.

**A. Layered deadlines**

1. Capture the effective current runtime settings before choosing the narrowest enforcement point. The current coordinator declares a 60-minute submission timeout and three attempts; sandbox commands already validate a configured time quota. Neither proves a delegate or model stream is bounded correctly.
2. Add versioned request, stream-idle and specialist deadlines. Starting values for local fault tests are 300 seconds per physical model request, 90 seconds of stream inactivity, and 600 seconds per specialist task. These are initial engineering defaults to validate against representative workloads, not measured optimal limits. Do not lower existing output-token headroom to satisfy a timer.
3. Keep a persisted absolute build deadline shared across automatic runtime redeliveries, delegates, backoff and model switches. Use the admitted existing total allowance where available; the current submission's hour must not silently become three fresh hours. Persist the original admission time/deadline for legacy-compatible reads, and refuse expired work after cold restart. Only explicit authorized recovery may create a new window.
4. Derive each child deadline from the lesser of its policy allowance and the parent's remaining time. Track stream chunks separately from feature progress: chunks may reset an idle timer but cannot extend a hard deadline or prove useful progress. Keep command-specific quotas; do not impose a second arbitrary 120-second limit over existing recipe policy.
5. Enforce AbortSignal propagation and durable terminal state. A local Promise race that leaves remote work running is insufficient. Request remote cancellation where supported; if remote acceptance/effect is uncertain, enter reconciliation and fence later effects before starting replacement work.

Illustrative policy calculation; adapt names to existing contracts:

```ts
const effectiveDeadlineAt = Math.min(parentDeadlineAt, startedAt + policy.taskTimeoutMs);
const remainingMs = effectiveDeadlineAt - now;
if (remainingMs <= 0) return { kind: 'deadline-exhausted', next: 'reconcile-or-stop' };
// Persist admission/deadline before dispatch; never recompute it from restart time.
```

**B. One coordinated transient-retry policy**

1. Inspect the installed pi-ai retry helper and Flue redelivery behavior before wiring changes. Do not assume single-shot calls or stack an independent eight-retry wrapper around existing retries. Use one known physical-request counter and at most two transient retries after the original request as the initial policy, within the existing absolute deadline and spending allowance.
2. Retry only classified transient failures such as rate limits, temporary overload and transport errors when replay is safe. Respect Retry-After plus bounded jitter; if the delay exceeds remaining time, settle instead of sleeping past the deadline. Authentication, revoked permission, explicit budget denial, cancellation and exhausted quota are not ordinary retry cases.
3. Attribute/reserve every physical request or conservatively reserve the complete bounded retry envelope before dispatch. A per-logical-turn reservation must not silently pay for unlimited SDK retries. Preserve one logical effect identity; account for actual retry cost without double-counting operation/turn summaries.
4. Test cancellation during backoff, duplicate delivery, unknown usage and restart mid-retry. New model selection is B02a policy, not a fresh spend/resume window.

**C. Empty results and finish reasons**

1. Normalize provider finish reason, adapter stop reason, error class, truncation and token usage. Preserve `unknown`/NULL when the runtime does not expose a value; do not fabricate `length` from output count alone. Record original and normalized values, with route, task/attempt identity and timings. Do not store hidden reasoning text, credentials or complete prompts to diagnose termination.
2. Classify empty output using tool receipts and code/checkpoint changes. Successful tool-only work may be productive; an empty answer is not automatically a failed feature. Output-cap truncation needs a bounded change to headroom/context/task size, not identical blind re-delegation. A genuine no-progress empty result contributes to the B03/B02a failure fingerprint/counters. Ambiguous effects must be reconciled before re-delegation.
3. Prove that repeated identical empty delegates cannot spend indefinitely; also prove a successful tool-only task is not falsely retried. Host checks, not narration, decide completion. Technical incidents remain Caddie's responsibility.

**D. Cancellation and late-effect fencing**

1. Stop, deadline exhaustion, revocation and budget exhaustion must persist the applicable terminal/reconciling state before a fresh action is admitted. Existing in-flight operations retain identities and receipts for reconciliation.
2. Fence callbacks by run/admission/attempt generation and approval identity, using the existing host authority. A stale success cannot publish a preview, advance a feature, create another reservation or revive a cancelled run.
3. Test the write boundary as well as status projection. If a remote command cannot be cancelled immediately, retain its outcome as quarantined/reconciling and prove it cannot overwrite or promote the active verified checkpoint. Do not claim that a local abort instantly reverses an already-accepted remote write.

**Commands:**

```sh
bun test tests/build-deadlines.test.ts tests/build-empty-result.test.ts tests/build-recovery.test.ts tests/build-fault-recovery.test.ts
bun test tests/model-call-instrument.test.ts tests/providers.test.ts tests/build-spend.test.ts tests/sandbox-durability.test.ts
bun run typecheck
```

**Gate:** no exercised request, silent stream or delegate exceeds its enforced deadline without a recorded terminal/reconciling outcome; no automatic retry/redelivery resets the admitted deadline or multiplies the configured physical-call cap; all physical calls are covered by accounting; productive tool-only work survives; stop reasons remain truthful; late results cannot write into/promote the active workspace or advance cancelled work. Local tests use fake clocks and controlled adapters, not real ten-minute waits or paid inference.

## B03 — Detect lack of progress accurately

**Owner:** Build host. **Depends on:** B02.

**Modify:** `apps/app/src/server/coordinator-host.ts`, `build-activity.ts`, `apps/app/src/agents/permissions.ts`.
**Create:** `apps/app/src/server/build-progress-policy.ts`, `tests/build-progress-policy.test.ts`.

1. Write RED cases for equal-length changed files, unchanged repeated writes, productive repeated checks, alternating command/error loops and repeated blocker-only narration.
2. Replace byte-count equality with content fingerprints. Reuse existing metadata if adequate; otherwise add one integration-owned migration and old-reader fallback.
3. Examine a bounded recent window using action/result fingerprints and relevant code revision. Allow tests to repeat after a genuine code change.
4. Separate evidence of activity from evidence of progress. One recovery nudge may select another approach; continuing without change must eventually stop within existing limits.
5. Prove duplicate receipts/replays do not consume another logical attempt. Benchmark the policy locally to ensure it does not scan full conversation history.

**Command:** `bun test tests/build-progress-policy.test.ts tests/build-workflow.test.ts tests/sandbox-durability.test.ts`.

**Gate:** equal-size productive edits proceed; actual loops stop; neither outcome depends on a paid classifier. No arbitrary increases to retry or action limits.

## B04 — Make feature completion meaningful

**Owner:** Acceptance/check integration. **Depends on:** B02–B03.

**Modify:** `apps/app/src/server/build-features.ts`, `coordinator-host.ts`, `contract-checks.ts`, existing stack check recipes and contract generation.
**Create:** `apps/app/src/server/feature-acceptance.ts`, `tests/feature-acceptance.test.ts`.
**Extend:** `tests/host-checks-contract.test.ts`, `tests/contract-checks.test.ts`, `tests/build-workflow.test.ts`.

1. Define a versioned mapping from approved feature criteria to independently owned checks. Separate generated app tests from checks the builder cannot weaken.
2. Protect baseline tests/contracts and record their identities before repair. Verify receipts against exact code/checkpoint identity before feature advancement.
3. Replace net test-count growth as the sole feature gate. Existing-test repair can be valid; unrelated newly passing tests cannot prove a promised journey.
4. Add explicit criteria checks for persistence, actor isolation, error/retry and offline/reconnect where the approved feature requires them.
5. Keep legacy in-flight plans readable. If stronger checks require changed product scope or approval content, create a versioned review; never silently edit an approved plan/hash.

**Commands:**

```sh
bun test tests/feature-acceptance.test.ts tests/host-checks-contract.test.ts tests/contract-checks.test.ts tests/build-workflow.test.ts
bun test tests/contract-restart-spike.test.ts
```

**Gate:** meaningless extra tests, deleted/weakened tests, wrong-actor records and changed-after-check code fail; a valid repaired existing test can pass without artificial count inflation. Product flows are checked independently of agent self-reports.

## B05 — Restore the right work after interruption

**Owner:** Runtime/context integration. **Depends on:** B02 and B04.

**Modify:** `apps/app/src/server/coordinator-context.ts`, `coordinator-host.ts`, `code-versions.ts`, existing sandbox restoration paths and `apps/app/src/agents/coordinator.ts`.
**Create:** `apps/app/src/server/build-resume-context.ts`, `tests/build-resume-context.test.ts`.
**Extend:** `tests/coordinator-context.test.ts`, `tests/sandbox-durability.test.ts`.

1. Persist/reconstruct a bounded resume capsule: approved scope/design, current feature, last verified checkpoint, pending effects, latest failures, attempted fixes and remaining limits.
2. Validate workspace/checkpoint, tool and recipe compatibility before effects. A chat transcript alone is not enough to restore an execution environment.
3. Preserve unresolved tool outcomes through context reduction. Keep abandoned branches out of active recovery; retain their records for inspection.
4. Prove fresh-process restore after a long repair history and interrupted tool batch. Reopening a browser should only restore the view.

**Command:** `bun test tests/build-resume-context.test.ts tests/coordinator-context.test.ts tests/sandbox-durability.test.ts tests/build-fault-recovery.test.ts`.

**Gate:** a cold restart resumes the correct unfinished feature with prior verified features intact; incompatible restoration refuses effects with an actionable state. Limits and approval identities survive.

## B06 — Verify the delivered app and its design

**Owner:** Generated-app acceptance. **Depends on:** B04–B05.

**Modify:** `apps/app/src/server/visual-fidelity.ts`, `coordinator-host.ts`, the configured app capture adapter and existing recipe/browser checks.
**Extend:** `tests/visual-fidelity.test.ts`, `tests/browser/visual-fidelity.spec.ts`, `tests/browser/project-workflow.spec.ts`.

1. Wire real phone/desktop capture for the exact verified output. The current comparator/seam is insufficient by itself.
2. Compare representative approved screens, navigation and important states; keep visual differences and behavioural failures separately attributable.
3. Verify overflow, accessible controls, console failures and primary journeys at phone and desktop sizes. Include failure/recovery states, not only a screenshot of the happy path.
4. Permit bounded repairs within approved scope. A change to the approved product/design returns to review rather than silently rewriting the target.
5. Publish a preview only when required checks have evidence. A capture service being unavailable must not masquerade as a visual pass.

**Command:** `bun test tests/visual-fidelity.test.ts` followed by `bun run build` and the affected Playwright specs against that fresh build.

**Gate:** the preview is tied to verified code, required user journeys work, visual checks have genuine capture evidence, and missing evidence is explicit.

## B07 — Integrate truthful progress and complete the release gate

**Owner:** Integration lead/product acceptance. **Depends on:** B01–B06.

**Modify as needed:** `apps/app/src/client/conversation/ProjectWorkflow.tsx`, `ProjectChatSummary.tsx`, `Channel.tsx`, `apps/app/src/client/project/BuildProgress.tsx`, `workspace/project-status.ts`, and existing notification projections.
**Extend:** `tests/browser/focused-project-chat.spec.ts`, `tests/browser/chat-responsiveness.spec.ts`, `tests/browser/project-workflow.spec.ts`.

1. Align chat, Build, project cards and notifications to authoritative outcomes. Show plain progress, recovery, pause, user decision and ready states consistently.
2. Keep diagnostics optional. Failure text explains what is saved, what is incomplete and what Caddie/user can do next; never asks a nontechnical user to debug the harness.
3. Repeat refresh, reconnect, long history, project switching and mobile/desktop checks while fault injection is active. Preserve the recent overflow/layout fixes.
4. Run root typecheck, composed build, affected integration suites and browser suites. Review shared-tree changes independently and checkpoint only owned verified work.

**Gate:** no surface claims Working/Ready solely from connection status or an old workflow row. All required local checks pass against the recorded build stamp. No deployment is implied.

## B08 — Measure comparison with the other harnesses

**Owner:** Evaluation/release lead. **Depends on:** B07 for full evaluation; fixture preparation can start after B01.

**Create:** `docs/evidence/build-benchmark/tasks.json`, `docs/evidence/build-benchmark/protocol.md`, `scripts/benchmark-build.ts`, `tests/build-benchmark.test.ts`.

1. Freeze twelve tasks before model runs: three variants each across a small authenticated CRUD app, offline app, AI-backed app and imported repository. Include build, change and recovery work. Keep evaluator-owned checks separate from agent-visible instructions.
2. Select two representative comparators from the researched twelve based on headless support, compatible models and sandbox/permission boundaries. Record selection reasons; do not claim a twelve-way execution comparison from source review.
3. Use two tracks: a controlled harness comparison with the same model/budget/environment where supported, and a separately labelled product comparison with each tool's normal configuration. Do not merge their scores.
4. Prepare the local runner and cost estimate without paid calls. Request a concrete spend allowance before a live pilot. Start with a small pilot; only scale after the protocol and acceptance checks work.
5. For the formal suite, repeat tasks at least three times per runner. Record verified completion, interruption recovery, human interventions, duplicate/unsafe effects, regressions, design fidelity, elapsed time and measured cost. Publish all failures, denominator and missing data.
6. Use results to decide whether to keep strengthening the current runtime or trial a replacement behind the same acceptance suite. Runtime migration is an evidence-driven follow-up, not the starting assumption.

**Release conditions:** zero lost verified checkpoints, duplicate logical effects or unauthorized effects in the exercised safety suite; all mandatory acceptance journeys pass for the supported recipe; authenticated live recovery and representative builds have actual evidence. Benchmark superiority, latency and cost claims require measured results and sample sizes. These conditions do not guarantee absence of every production fault.

## Rollout and rollback

- Checkpoint one verified packet at a time. Do not deploy the entire shared dirty tree as one unreviewed change.
- Test compatibility against existing projects and interrupted runs before enabling stronger policy for new runs.
- Use the repository's existing release/config mechanism if a staged rollout is necessary; choose its exact switch after inspecting current configuration. Do not invent parallel policy systems.
- Roll back new policy wiring if a compatibility regression appears; preserve operation history, receipts, failure evidence and checkpoints. Append corrective migrations instead of rewriting applied migrations.
- CI/deployed SHA, authenticated journeys and live sandbox/provider evidence remain distinct from local tests. Deployment and paid evaluation need their own explicit authorization.

## First implementation action

Owner amendments: include B00a (pre-presentation artifact quality gates) and B02a (autonomous repair-model escalation) after their stated dependencies. This is a bounded internal continuation policy, not repeated user Retry.

Start B00, then B01 and the mandatory B02 deadline/empty-result/cancellation controls. Use the existing repair-window regression as the first passing control and the interrupted/ambiguous effect cases as the first new failure tests. Finish the failure corpus and recovery decisions before changing completion criteria or evaluating a replacement harness.

## Amendment: autonomous repair-model escalation (owner direction, 2026-10-25)

**Requirement:** Technical repair belongs to Caddie. A nontechnical user must not be asked to inspect logs, modify code, repair tests, set up the harness or work out which model should try next. Model escalation is an internal recovery policy, not another user workflow.

**Evidence:** [Nebius account catalog snapshot](../evidence/2026-10-25-nebius-model-catalog.json), read through the configured Nebius endpoint on 2026-10-25. Thirty model entries were returned. This is LIVE VERIFIED catalog metadata only, with **zero inference requests**. Tool support, prices and context are provider-advertised; availability of a listed route does not establish successful access, correct tool use or coding quality. Current Caddie routing in `apps/app/src/agents/providers.ts` uses Nemotron 3.5 Super VL for build/QA, GLM-5.3-Flash for planning and Nemotron Ultra for architecture. It is a static role map, not this proposed per-issue repair ladder.

### Candidate models

Prices below are USD per million uncached input/output tokens from the account catalog, not a build-cost estimate. Preserve the exact ID and revalidate before rollout.

| Candidate | Exact catalog model ID | Input / output | Advertised input | Evaluation role |
|---|---|---|---|---|
| Nemotron 3.5 Super VL | `nvidia/Nemotron-3.5-Super-VL` | $0.30 / $0.90 | Text + image | Current build baseline; ordinary code and visual diagnosis |
| Kimi K2.7 Code | `moonshotai/Kimi-K2.7-Code` | $0.95 / $4.00 | Text | Research comparison candidate; superseded in the default ladder by the owner’s DeepSeek V4.1 choice |
| DeepSeek V4.1 Flash 1017 | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | $0.30 / $1.20 | Text + image | Owner-selected first repair alternate and proposed independent plan/design reviewer; listed tools/reasoning, 1,048,576-token context |
| GLM-5.3 | `zai-org/GLM-5.3` | $1.40 / $4.40 | Text | Owner-selected third repair candidate; not eligible for screenshot review |
| DeepSeek V4 Pro | `deepseek-ai/DeepSeek-V4-Pro` | $1.75 / $3.50 | Text | Competing third-rung candidate; catalog lists a different region from the current build route |
| Reflection Beam | `reflection/beam` | $0.25 / $1.00 | Text | Cost-efficient coding candidate to evaluate; no success claim yet |
| MiniMax M3 | `MiniMaxAI/MiniMax-M3` | $0.30 / $1.20 | Text | Alternative coding/reasoning family to evaluate |
| MiniMax M3.1 Flash | `MiniMaxAI/MiniMax-M3.1-Flash` | $0.15 / $0.60 | Text + image | Newer lower-cost multimodal candidate to evaluate |
| Kimi K3 | `moonshotai/Kimi-K3` | $3.00 / $15.00 | Text + image | Expensive multimodal rescue candidate, only if justified by measured results and remaining allowance |
| Muse Spark Open | `meta-models/muse-spark-open` | $1.25 / $4.25 | Text + image | Alternate visual/code repair candidate |
| Nemotron Ultra | `nvidia/Nemotron-3-Ultra-550b-a55b` | $1.00 / $3.00 | Text | Already configured architecture route; evaluate for diagnosis before assigning direct repairs |

All candidates above advertise tools/reasoning in this catalog. That does not prove strict schema compatibility or successful tool execution. Qwen coding models appear on Nebius's public marketing pages, but **no Qwen-Coder route was returned in this account snapshot**; do not configure an assumed ID. Public catalog descriptions: [Kimi](https://nebius.com/services/token-factory/models/kimi-models-inference), [GLM](https://nebius.com/services/token-factory/models/glm-models-inference), [Beam](https://dev.nebius.com/cookbook/beam-reflection-token-factory), [new model families](https://nebius.com/blog/posts/three-new-open-weight-models-from-us-companies-give-builders-more-choice).

### Owner-selected repair ladder, pending compatibility and paid repair evaluation

```ts
const REPAIR_ESCALATION_V1 = {
  maxModelsPerIssue: 3,
  maxCheckedRepairAttemptsPerModel: 2,
  maxCheckedRepairAttemptsPerIssue: 6,
  candidateRoutes: [
    'nvidia/Nemotron-3.5-Super-VL',
    'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'zai-org/GLM-5.3',
  ],
} as const;
```

These are proposed bounds, not deployed configuration or proven optimal values. Fix the runtime causes and measure candidates before enabling the ladder. The routing policy is frozen/versioned at admission; models do not choose arbitrary replacements themselves. Distinct families are intended to provide different repair approaches, not a guaranteed increase in capability or a price-based quality ranking. The owner selected DeepSeek V4.1 Flash 1017 and GLM-5.3 as the alternates. Other catalog candidates remain comparisons, not extra automatic rungs. The selected IDs still require compatibility and live repair evaluation before enablement.

1. A **repair attempt** is a bounded patch followed by the host's required checks, not an individual tool call or a transport retry. Only new host-verified failure evidence consumes a checked repair attempt. Replay of the same logical attempt cannot count twice.
2. After two unsuccessful checked repairs for the same issue, move to the next eligible model automatically. If a repeated no-progress fingerprint is detected, escalate earlier instead of wasting the remaining patch slot. Early escalation cannot increase the issue's total allowance.
3. At most three distinct models and six checked repair attempts run for one issue episode. Track stable criterion/root-cause identity across changes to error wording; agents cannot get a fresh allowance by renaming an issue or opening a new conversation.
4. Every model call, malformed response, compatibility retry and physical transport retry still counts against actual cost, model-call, token, time and sandbox-action limits. The checked-attempt counter alone is not a spending bound. Allocate per-issue ceilings from the existing admitted build allowance and measure conservative reservations before live rollout.
5. Service retries have their own small bounded policy (proposed maximum two physical retries after the original request), respecting retry advice within the deadline. Exhausting transport retries may select an eligible healthy route; it does not masquerade as a failed code patch or bypass account-wide limits. Coordinate with Flue/provider retries so nested layers cannot multiply attempts invisibly.
6. Eligibility requires account access, permitted region/data policy, tool/schema compatibility, adequate context/output headroom and the required input modality. Preserve output space for tool arguments; do not repeat the earlier reasoning-token exhaustion failure. A model advertised without the required capability is skipped, not tried until it fails.
7. A text-only model cannot silently receive an incomplete visual task. Route screenshot-dependent repairs through a separately evaluated vision-capable ladder, also capped at three models/six checked repairs for the issue. A vision-derived diagnostic can support a text repair only when its limitations are explicit and independent visual verification follows. Changing profiles must not reset issue counters.
8. Model changes stay within the original approved product scope, tools, permissions and spending cap. **Never call `retryWorkflow` or create `workflow_resumes` to move between rungs**: those represent explicit user recovery/new windows. Automatic escalation is internal continuation of the existing window.
9. The current legacy three-failure pause cannot remain as a competing controller that cuts this ladder off midway. Introduce one versioned host-owned policy that accounts for per-model and total attempts together. Preserve legacy in-flight semantics until an explicit, safe policy transition is defined; do not reinterpret historical run rows silently.

### Handoff and verification

Persist the chosen route and a compact repair capsule before delegating. Include approved plan/design hashes, stable issue/criterion ID, current workspace/code revision, last verified checkpoint, relevant files/diff, failing commands and exact receipts, attempted fixes, observed regressions and remaining allowance. Logs and repository content remain untrusted inputs. Transfer factual summaries, not private reasoning transcripts or credentials.

The alternate model continues from the appropriate working state; do not restart the entire feature or discard verified features. If an unsuccessful patch breaks a previously passing baseline, restore only that patch to the last suitable checkpoint before handing off. Reject stale completions using operation/attempt identity and workspace revision. Only one writer owns the issue at a time; three-model parallel writes are not the default strategy.

Every rung uses the same independent acceptance and baseline protections. A model declaring success, adding trivial tests or weakening an assertion cannot close the issue. The successful repair stops the chain immediately. A model may be retained for the current repair episode rather than bouncing back to the cheapest model after every tool call; future route preferences require explicit policy/evaluation, not agent self-modification.

### Accounting and current routing contracts

The catalog currently binds model/pricing at run creation while role-level model selection and per-call instrumentation also exist. The new policy must reconcile these boundaries explicitly:

- Preserve historical run bindings and pricing. Do not overwrite the model recorded for earlier work.
- Persist the repair policy/version and actual model/pricing snapshot per logical repair attempt before inference admission; charge/reserve the actual selected route rather than the baseline route.
- Update `model-call-instrument.ts` selection-reason validation so an authorized alternate model is recorded as escalation, not dropped as a static-role mismatch. Preserve immutable runtime turn IDs and actual requested/returned model IDs.
- Keep code-repair model routing separate from Home brainstorming, planning, cheap helpers and the generated app's default AI. This amendment does not silently change those defaults.
- An out-of-budget, revoked, cancelled or unsafe operation stops regardless of available models. Switching models must not evade a refusal or obtain broader tool rights.

### Exhaustion without making the user the debugger

A finite ladder cannot guarantee every program is repairable. Exhaustion means: preserve verified work, stop new spending, record an internal repair incident with reproducible evidence, and show a plain incomplete state. Do not ask the user to fix code, interpret test output, choose an AI model or forward specialist instructions. Do not automatically publish an issue or message an external maintainer; internal incident handling remains inside the authorized application.

A suitable message is: “Caddie couldn’t finish this part. Your completed work is saved.” Technical detail is optional. Service outages can have bounded internal delayed recovery; no endless background attempts or invented completion. User input is reserved for a real product choice, user-owned authorization/credential or an additional spending decision. Caddie's own infrastructure failures are Caddie's responsibility. Asking to remove a promised feature is not the automatic substitute for fixing it.

### New packet B02a — Durable escalation supervisor

**Owner:** Integration lead. **Depends on:** B01 and B02 failure classification; B03 progress fingerprints; B04 independent checks must be available before the ladder is used as a production completion gate. Local fixture preparation can proceed earlier.

**Create:**

- `apps/app/src/server/repair-escalation.ts` — pure selection/counter policy plus persistence integration.
- `tests/repair-escalation.test.ts` — deterministic state-machine tests.
- `tests/repair-escalation-integration.test.ts` — mocked provider + real host admission/receipts/restore.
- `tests/fixtures/repair-model-scenarios.ts` — frozen bugs and compatibility scenarios.

**Modify:**

- `apps/app/src/agents/providers.ts` — validated candidate route metadata and capability/pricing snapshots.
- `apps/app/src/agents/coordinator.ts`, `specialists.ts` — pass a host-selected per-attempt model through scoped execution; do not mutate global role defaults.
- `apps/app/src/server/coordinator-host.ts`, `build-workflow.ts` — integrate one authoritative repair policy, terminal-state handling and model handoffs.
- `apps/app/src/server/model-call-instrument.ts`, `helper-model-call.ts` where applicable — retain actual route/reason/cost.
- `apps/app/src/agents/permissions.ts`, shared contracts and an integration-owned append-only migration only where existing storage cannot represent the policy/counters. Allocate the migration number at implementation time.
- `scripts/packet-list.ts` and the reliability evidence ledger.

**Steps:**

1. Capture RED cases for two failures moving to another model, restart mid-escalation, duplicate attempt delivery and the legacy three-strike gate prematurely stopping the chain.
2. Implement persistent issue/model/attempt identities and conditional transitions. First prove the six-attempt and three-model bounds across restarts and concurrent deliveries.
3. Enforce capability, context, region and allowance eligibility before inference. A skipped/unavailable candidate does not permit an unbounded search through the catalog.
4. Persist the factual handoff, actual route and reservation; delegate exactly one repair. Reconcile its effect before moving on.
5. Feed independently checked outcomes back into the supervisor. Early success terminates the ladder; no progress can escalate early; repeated compatibility failures quarantine the route within the policy.
6. Exercise Stop, cancellation, revoked approval, exhausted limits and late results at every boundary. Failed services or unsupported tools never become a user's coding task.
7. Prepare a costed compatibility/repair evaluation against the verified catalog. Inference runs require separate explicit authorization; this investigation did not run them.
8. Enable for new admitted builds only after local and authorized live gates pass. A staged rollout retains old runs and supports rollback without deleting model-call or repair history.

**Commands once implemented:**

```sh
bun test tests/repair-escalation.test.ts tests/repair-escalation-integration.test.ts
bun test tests/build-workflow.test.ts tests/build-spend.test.ts tests/model-call-instrument.test.ts tests/providers.test.ts
bun run typecheck
```

**Acceptance matrix:** baseline succeeds with no escalation; first/second alternate succeeds; all fail within the bound; output/token exhaustion; malformed tool arguments; route unavailable; 429/backoff; unsupported image input; smaller context; region refusal; no-progress early switch; duplicate/lost response; worker restart; checkpoint mismatch; Stop/late receipt; revoked approval; budget exhausted before the next rung; attempted issue rename; concurrent writers; truthful user-facing exhaustion; and no change to helper/generated-app defaults.

**Rollback:** disable escalation for new admissions through the existing rollout mechanism, retain policy/version and actual-model history for existing attempts, reconcile pending operations and preserve checkpoints. Do not silently reset attempts or switch back to a cheaper route mid-effect.

### Changes to the release and comparison gates

B07 must cover escalating/recovering states without exposing model selection or debugging to the default user. B08 must compare the single-model baseline with the bounded ladder on the same frozen bugs and allowance; measure repair success, total billed cost, model calls, time, regressions and escalation frequency. A more expensive token price is not evidence of a better fix, and a cheaper failed loop is not a cheaper completed task.

The escalation policy is planned, not implemented or enabled. Candidate order is provisional until Caddie's own tool-compatibility and repair evaluations justify it.


## Amendment: independent plan and visual-design review before presentation

**Owner direction, 2026-10-25:** Use DeepSeek V4.1 and GLM-5.3 as the repair alternates. Add an independent model review/fix loop before the user sees a plan or design as ready. Design validation must use actual images and a vision-capable model.

### Model assignments

| Role | Initial assignment | Boundary |
|---|---|---|
| Plan/design author | Existing planning route: GLM-5.3-Flash | Preserve current author choice unless a separate measured policy changes it |
| Plan quality reviewer | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | Fresh review context; compare draft against user intent, supported stack and acceptance criteria |
| Plan reviewer fallback | `zai-org/GLM-5.3` or eligible existing different-family route | Text review only; never the same exact route that authored this revision; prefer a different family |
| Design quality reviewer | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | Must receive screenshots captured from the actual draft previews and inspect them |
| Design reviewer fallback | Existing `nvidia/Nemotron-3.5-Super-VL` | Vision-capable and distinct from the author; a fallback is ineligible if it authored the revision |
| Build repair alternates | DeepSeek V4.1 Flash 1017, then GLM-5.3 | Keep the existing two repairs/model, three models/issue, six checked-repair ceiling |

DeepSeek V4.1 Flash 1017 is the versioned route from the authenticated catalog. The unversioned `deepseek-ai/DeepSeek-V4.1-Flash` alias has different context metadata and no explicit feature list in the recorded response; do not silently substitute it. The catalog advertises image input for the versioned route, but actual image grounding and structured review must pass a compatibility probe before enablement. GLM-5.3 is text-only: it is never a visual reviewer. GLM-5.3-Flash is a different route and must not be confused with GLM-5.3.

If the author escalates onto the designated review model, the host selects an eligible independent reviewer. It cannot let the author approve its own output merely because the role names differ. Lack of an eligible reviewer is a retained internal failure, not an automatic pass.

### User-facing lifecycle

```text
User intent
  → internal plan draft
  → deterministic checks + independent plan review
  → author fixes material findings
  → review the exact revised plan
  → reviewed plan becomes visible for USER approval
  → internally prepare and visually check look options
  → USER chooses a look
  → internal screen design
  → capture phone/desktop screenshots
  → independent visual review + scope checks
  → author fixes material findings and recaptures
  → reviewed design becomes visible for USER approval
  → build and independent runtime checks
```

The normal user sees the first reviewed ready version, not drafts, schema corrections or specialist debate. Calm progress such as “Preparing your plan” or “Checking your design” is enough. Technical users may inspect clearly marked internal evidence on demand; it must not appear as an approval-ready artifact.

“Reviewed” is not “perfect” or “production-ready.” These checks reduce preventable scope and design defects; they cannot prove the future app's saving, AI integrations or offline behaviour. Those still require B04/B06 runtime evidence. The user's plan approval, look selection and design approval remain separate authority boundaries.

### What the plan reviewer must check

- The proposed app solves the stated problem for the stated people; core journeys and requested features are accounted for.
- Included scope, deferred work, limitations and consequential assumptions are explicit in plain language. A photo feature quietly becoming text-only, or a requested role having no usable screens, is material.
- The plan is feasible with Caddie's supported recipes and available platform features. Required integrations, credentials, dependencies and contest constraints are grounded in provided evidence; missing facts are not invented.
- Acceptance criteria are observable, specific and suitable for independent checks. Implementation order includes prerequisites and a useful end-to-end journey early.
- Data ownership, isolation, persistence, privacy and failure recovery are addressed where applicable. The reviewer supplements, and never weakens, existing architectural/security gates.
- The readable version is coherent and concise. Internal database/API details remain optional. The reviewer cannot add new product requirements based on personal preference.

Only genuine product ambiguity that materially changes the app may return to the user. Routine technical choices, contradictions the system can resolve and coding mistakes are repaired internally. A failed model review is not a reason to make the user debug the plan.

### What design review must actually inspect

1. Capture the real sandboxed HTML previews, with the selected theme, at consistent phone and desktop sizes (initial presets: 390×844 and 1440×900). Keep scripts/network locked down; do not relax the static preview sandbox for capture.
2. Produce an image manifest covering every required screen and relevant state. Batch captures/reviews within the stage allowance; a subset cannot be described as full coverage. Empty/loading/error states require evidence where specified. Look proposals may use their representative key screens; final design review covers the full required inventory.
3. Send actual image inputs to the reviewer, together with user intent, approved plan, chosen look, screen identities and a short rubric. HTML, JSON, prose or alt text alone do not satisfy visual review.
4. Evaluate hierarchy, density, typography, spacing, alignment, contrast, readable labels, mobile overflow/clipping, navigation consistency and primary actions. Check missing/blank screens, inconsistent components and decorative emoji icons that violate the professional icon-system requirement.
5. Require findings tied to a screen/capture and a concrete region or element. Generic “looks good” prose, an inaccessible image or a blank capture is insufficient evidence.
6. After an edit, recapture and review the changed screens plus affected shared components. Reuse a previous unchanged-screen review only when its content/render dependencies and rubric identity still match. A CSS/theme change invalidates every dependent capture.
7. If the capture or vision service fails, record `unavailable` and use a bounded eligible recovery/fallback. Never treat unavailable visual evidence as a pass or substitute a text-only reviewer.

Before enabling the route, test vision grounding using known good/bad screens: clipped mobile actions, unreadable contrast, missing primary flow, blank render and an intentionally contradictory written brief. The review must use the screenshot evidence rather than repeat the prose. Schema compliance and a coloured-image probe alone are insufficient evidence of design-review quality.

### Structured findings and bounded correction

Proposed internal contract (final schema is integration-lead owned):

```ts
type ArtifactQualityReview = {
  artifactId: string;
  artifactHash: string;
  rubricVersion: string;
  reviewerModel: string;
  verdict: 'pass' | 'revise' | 'unavailable';
  coverage: { required: string[]; reviewed: string[] };
  issues: Array<{
    id: string;
    severity: 'blocker' | 'material' | 'advisory';
    criterionId: string;
    evidenceRef: string;
    requiredCorrection: string;
  }>;
};
```

The host validates and persists the report against trusted request identity and actual provider receipts. The reviewer has read-only access to the draft and evidence; its only write is a narrowly scoped review record. It cannot approve the product, change scope, execute repository instructions or grant itself tools. Artifact text, screenshots, repositories and logs are untrusted inputs, not instructions to the reviewer.

- Initial bound: one draft review plus at most two author-correction/review cycles per artifact stage: **three review passes maximum**, with explicit provider/model-call/token/time caps underneath. These are starting policy bounds to evaluate, not a claim of optimal quality.
- Zero unresolved blockers/material issues, complete required coverage and valid deterministic checks are required for publication. Advisory preferences do not create an endless refinement loop.
- The author receives actionable findings and makes a new internal revision. Findings close only on new evidence, not on the author's assertion. A reviewer disagreement can be resolved with evidence; it cannot silently delete requirements or lower the rubric.
- No-progress, unavailable reviewers and malformed reports use the bounded failure/escalation policy. All nested calls count against one stage allowance; neither changing reviewer nor regenerating a draft resets it.
- If the bound is exhausted, preserve the drafts/checkpoints and record an internal incident. Do not publish a known-defective plan/design as ready or ask the user to fix it. Explain the incomplete preparation plainly.
- A necessary product/scope change after user approval requires the appropriate new user review. Internal pre-presentation checking is not permission to alter an already approved artifact silently.

### Publication, persistence and race safety

Current source inspection found `workflowSnapshot` promotes a newly saved PRD directly to `review`, and promotes an undecided saved design directly to `design-review`. The new quality gate must change that ownership boundary; a client-only hide/show flag is insufficient.

- Separate the current internal candidate from the current published reviewable revision. Keep prior published/approved versions readable while a new draft is checked.
- Review dispatch is a durable internal action with an idempotent identity derived from project, artifact hash, rubric and selected review policy. Polling GET routes and page refreshes must not initiate additional paid reviews.
- Promote the exact candidate only after a matching successful review and deterministic checks. In one conditional transition, verify it is still the newest intended candidate and its approved dependencies have not changed. Stale reviewer results cannot publish an older draft.
- Bind plan review to user-intent/scope inputs. Bind design review to the approved plan, chosen look/theme, complete mock inventory, rendered image hashes/dimensions and capture/rubric versions. Changed input invalidates the affected review.
- Update plan-doc/workflow/brief/chat/notification/preview reads so an unreviewed candidate does not leak as ready via another surface. Guard inline artifact rendering in `conversation/ReplyText.tsx` and `Channel.tsx` as well: an author pasting HTML-mock/plan content into chat cannot bypass publication checks. Keep original transcript/evidence available in an explicitly marked inspector rather than deleting it. The host-backed published artifact is the authority for the normal approval surface. An original decision record must still show the exact historical approved revision.
- Existing approvals stay intact. Existing already-approved runs are not automatically rewritten, cancelled or sent through paid validation. Introduce a versioned policy for new preparation/revision admissions, with explicit legacy handling.
- Existing team-mode architecture/security review remains mandatory where applicable. The new all-project quality gate is not restricted to team mode and cannot waive security findings.

### Stage budgets and compatibility

Plan/look/design checking happens **before** the current design-approval build payer is opened. Therefore B02a's existing-build allowance is not by itself a valid payer for these calls. Define a bounded preparation/review allowance through the existing budget ledger and product/service allocation, reserve it before inference, and account for every author/reviewer/capture call. The user should not configure model settings or token counters to get a usable first plan. A larger spending decision, if genuinely needed, is an ordinary budget choice—not a request to debug.

Persist actual author/reviewer route, pricing version, purpose (`plan_quality_review`, `look_quality_review`, `design_visual_review`), artifact identity, input modality and usage. Repeated delivery of a review receipt must not double charge. Unknown usage remains unknown; catalog estimates are not invoices.

## New packet B00a — Pre-presentation artifact quality gate

**Depends on:** B00 baseline, B01 fault fixtures and B02 typed recovery. Split B02a into shared route-eligibility/accounting foundations and the full build-repair supervisor: the foundations are needed here, while the full supervisor keeps its B03/B04 dependencies. This avoids making preparation validation wait for an unrelated test-count gate replacement.

**Create:**

- `packages/contracts/src/artifact-quality.ts` — versioned review/coverage schemas, exported through the integration-owned contracts entrypoint.
- `apps/app/src/server/artifact-quality.ts` — scoped immutable review persistence, input identities, correction bounds and publication decision.
- `apps/app/src/server/design-review-capture.ts` — locked-down capture manifest/adapter for actual draft previews, reusing B06 infrastructure where suitable.
- `tests/artifact-quality.test.ts`, `tests/artifact-quality-workflow.test.ts`, `tests/design-review-capture.test.ts`.
- `tests/fixtures/artifact-quality-cases.ts` — good/bad plans, partial designs and misleading text/screenshot pairs.

**Modify:**

- `apps/app/src/server/build-workflow.ts`, `projects.ts` and actual plan-doc/workflow/preview route handlers located during implementation — candidate/publication boundary and race-safe transition.
- `apps/app/src/server/coordinator-host.ts`, `coordinator-context.ts`, `apps/app/src/agents/coordinator.ts`, `specialists.ts`, `providers.ts` — scoped author/reviewer dispatch and correction handoff.
- `apps/app/src/agents/skills/planning/SKILL.md`, `design/SKILL.md`, integration-owned skill manifest — author requirements and mandatory independent checks.
- `apps/app/src/server/model-call-instrument.ts`, budget admission and relevant notification/brief projections — actual model/purpose/cost and no premature ready events.
- `apps/app/src/client/planning/DesignReview.tsx`, `conversation/ProjectWorkflow.tsx`, `ProjectChatSummary.tsx`, `ReplyText.tsx`, `Channel.tsx`, `queries.ts` — quiet preparation states, inline-artifact publication guards and reviewed-only default rendering.
- Append-only migrations and packet mapping, applied serially by the integration lead. Choose migration numbering from the current tree at implementation time.

**Execution:**

1. Write RED cases proving current save→review promotion leaks an unchecked candidate; include PRD and design, team mode off, stale result and browser-refresh replays.
2. Add candidate/publication records and the versioned review schema. Preserve old approved artifacts and decision hashes.
3. Implement deterministic completeness/schema/coverage checks first; partial multi-part notes cannot pass as a complete design.
4. Add read-only independent plan review with a simulated provider and bounded author correction. Bind every result to exact input hashes.
5. Add actual preview capture and vision-review dispatch; verify image bytes/manifests are present, valid and appropriate to the selected route. Test with an isolated local renderer before any paid model evaluation.
6. Add review/fix/recheck publication transitions, aggregate stage allowance, unavailable-reviewer handling and independent fallback eligibility.
7. Exercise restart, duplicate callback, changed draft during review, changed CSS/plan/look, budget exhaustion, unknown usage and revoked dependency approval.
8. Verify mobile/desktop user surfaces and notifications reveal only the reviewed ready artifact, with optional marked evidence. Real user approval is still required before the next product stage.
9. Prepare a costed live comparison of the selected DeepSeek route and vision fallback on known good/bad examples. Run only after explicit paid-evaluation authorization; record false acceptance, false rejection, correction success, latency and measured cost.

**Commands once implemented:**

```sh
bun test tests/artifact-quality.test.ts tests/artifact-quality-workflow.test.ts tests/design-review-capture.test.ts
bun test tests/build-workflow.test.ts tests/providers.test.ts tests/model-call-instrument.test.ts
bun run typecheck
bun run build
bunx playwright test tests/browser/focused-project-chat.spec.ts tests/browser/looks-picker.spec.ts tests/browser/project-workflow.spec.ts
```

**Acceptance:** no unreviewed draft is presented as ready; exact revised artifact passes before publication; screenshot-based findings are grounded; GLM-5.3 is refused as a visual reviewer; the author cannot self-review; stale/missing/incomplete review evidence cannot pass; bounded failure remains Caddie-owned; all-project mode and existing security gates coexist; approved historical versions and original user decisions remain accurate.

**Rollout/rollback:** enable the versioned quality policy for new preparation admissions only after local and authorized live gates pass. On rollback, stop admitting new reviews and retain candidate/review evidence; reconcile in-flight work before reverting publication wiring. Do not expose unchecked drafts as ready, rewrite historical approvals or start an automatic paid review of every existing project.

The owner’s model choices and this review requirement are now in the plan. Runtime routing, quality dispatch and publication gates are not implemented or enabled by this documentation change.


## Selected-model live preflight — 2026-10-25

**GO for staged local implementation.** Owner-authorized probes completed: 23 physical inference requests; DeepSeek V4.1 Flash 1017 passed 8/8 calibration cases, GLM-5.3 passed 5/5, Super VL passed 6/7. Tool round-trips used the installed pi-ai adapter. Repair success was checked by host assertions, not model claims. Both vision routes passed good/broken/blank phone+desktop screenshot calibration; GLM-5.3 remains text-only. DeepSeek and GLM accepted the sound-plan control and detected the bad-plan blockers. Super VL missed author self-approval in the bad plan; retain deterministic host approval enforcement and do not make it the plan-review gate on this evidence.

Full evidence, limitations, costs, commands and the implementation handover are in [the preflight report](../evidence/2026-10-25-model-validation/README.md). Estimated list-price inference cost was $0.13037670, not an invoice. This resolves basic route-access/compatibility smoke tests; production registration, durable recovery, complete visual coverage and B08 evaluation remain implementation/enablement gates. No runtime routing or production policy was enabled by these tests. Existing approvals are unchanged.


## Incident research reconciliation — 2026-10-25

Use `docs/research/2026-10-25-build-harness-reliability.md` as a historical incident report, not a second implementation authority. Its 103-minute interval, output-starvation observations and empty-delegate symptoms seed B01 regression cases; identify their exact runtime boundaries before assigning causes. Do not inherit these unsupported/outdated conclusions:

- Spending enforcement is already implemented and wired through `server/build-spend.ts`, `server/spend-instrument.ts` and `app.ts`; audit coverage and physical retries rather than rebuilding it from usage-row totals. Observability is not a transactional budget ledger.
- The installed pi-ai adapter has retry machinery; establish effective configuration before claiming zero retries or adding another loop.
- Coordinator durability and command time quotas already exist; delegate/request/stream coverage still requires proof.
- Increased passing-test count is not independent feature acceptance. Keep B04 as a core gate; a reviewer cannot replace host-owned checks.
- OpenHands' current SDK source declares five retries and separate request/idle deadlines; older eight-retry application settings are not a default to copy. Pin source version and distinguish application, SDK, request, task and command limits. Reference: <https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-sdk/openhands/sdk/llm/llm.py>.
- Community reviewer gains and historical benchmark scores are background, not a promised Caddie improvement or a justification for unbounded reviewer calls. Aider's published methodology kept held-out acceptance evaluation separate: <https://aider.chat/2024/06/02/main-swe-bench.html>. Measure Caddie's own completion, cost and recovery in B08.

The four incident-derived requirements are integrated into B01/B02 above, not deferred to an optional follow-up.
