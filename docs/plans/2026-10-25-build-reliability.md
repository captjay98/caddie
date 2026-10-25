# Build reliability: source review and implementation plan

**Execution detail:** [Build reliability implementation plan](2026-10-25-build-reliability-execution.md) now defines the ordered work packets, tests, rollout and benchmark protocol. This source-review document remains the supporting rationale.

**Goal:** Caddie completes useful approved work, preserves verified work through interruption, and asks nontechnical users only for decisions the system cannot safely make itself.

**Architecture:** Retain Flue as the durable conversation/task runtime and the existing host as the authority for scope, approvals, receipts, budgets and verified checkpoints. Strengthen the boundaries between them. Do not add a second workflow engine or replace the runtime before a representative fault suite demonstrates a concrete advantage.

**Stack:** TypeScript, Flue 2.2.2, Cloudflare Worker/Durable Objects/D1, the existing sandbox adapters and host-owned check recipes. Caddie already uses `@earendil-works/pi-ai` for model access; this is not the Pi coding-agent lifecycle.

Reviewed 2026-10-25 against HEAD `95fb269d1cf2ab328b78de448c3b852a9cb5bd81` plus the shared dirty tree. Inventory: [upstream source records](../evidence/2026-10-25-agent-harness-source-inventory.json). Branches can move: the inventory records retrieval time and SHA-256 of every downloaded source. Popularity and license screening are not reliability certification. No upstream agent was executed and no paid build/model benchmark was run.

## Broader GitHub comparison

The review covered twelve representative projects, not an exhaustive ranking. Sources were read in the maintainers' repositories; small files were read directly and large implementation files were searched/read around the relevant methods. Lessons are candidates for Caddie, not claims that these projects guarantee correctness.

| Project | Source inspected | Relevant lesson |
|---|---|---|
| Pi | [agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts), [session lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts) | Separate model interaction, tool results and persisted session lifecycle; retain full history while managing active context. |
| OpenHands | [conversation state](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/state.py), [stuck detector](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py) | Explicit running/paused/stuck states; detect repeated action/error cycles and monologue; verify compatibility on restored state. |
| OpenCode | [session contract](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md), [retry policy](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/retry.ts) | Durable admission before execution; separate logical work from physical retry; reconcile orphaned tools without blindly replaying ambiguous effects. |
| Cline | [checkpoints](https://github.com/cline/cline/blob/main/docs/core-workflows/checkpoints.mdx), [restore implementation](https://github.com/cline/cline/blob/main/sdk/packages/core/src/session/checkpoint-restore.ts) | Distinguish restoring files from restoring conversation/task state. A checkpoint needs explicit scope and restoration semantics. |
| Roo Code | [checkpoint lifecycle](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/checkpoints/index.ts) | Handle initialization contention, timeouts and unavailable checkpoint services explicitly. |
| Goose | [retry operation](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/agents/state_machine/ops_retry.rs) | Separate completion, continuation and retry; preserve attempt accounting across retry context changes; bound success/failure commands. |
| Continue | [retry classifier](https://github.com/continuedev/continue/blob/main/core/llm/utils/retry.ts) | Classify retryable transport/provider errors; bound attempts and delay; distinguish those failures from code repairs. |
| Codex | [response retry logic](https://github.com/openai/codex/blob/main/codex-rs/core/src/responses_retry.rs) | Centralize transport retry/fallback decisions; preserve configured limits and expose retry scheduling. This source review is not a proposal to use the desktop app as Caddie's runtime. |
| Aider | [coder loop](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py), [lint/test workflow](https://aider.chat/docs/usage/lint-test.html) | Integrate edit validation with lint/test feedback and bounded reflection. Passing a command alone does not prove a user journey. |
| SWE-agent | [agent/attempt lifecycle](https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/agents.py) | Separate attempts and trajectories; carry remaining cost limits into subsequent attempts rather than starting each with an unlimited budget. |
| Gemini CLI | [loop detection](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/loopDetectionService.ts) | Distinguish repetitive productive batch work from no-progress loops, using recent actions and context. Model-assisted detection is not the only possible policy. |
| Qwen Code | [workflow checkpoint](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/agents/workflow-checkpoint.ts), [agent loop](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/core/agent-loop.ts) | Persist evidence of an in-flight run so a later process can identify interruption; retain correlated outputs. |

These are differing designs, not twelve interchangeable drop-in libraries. Desktop shadow-Git checkpoints, Python workspaces and Rust process lifecycles cannot simply replace Caddie's remote sandbox and Durable Objects. Reuse contracts and tested mechanisms first.

## What Caddie already has

Source-confirmed: ordered feature rows; approval checks before effects; durable sandbox operation keys/receipts; checked checkpoint references; repair windows recorded by `workflow_resumes`; bounded actions; a repeated-action guard; persisted coordinator continuation counters; spend admission; a stale-build watchdog; user Stop/Retry and rollback paths.

`runHostChecks` verifies receipt ownership, command, working directory, terminal success, exit status, timeout/truncation and test output. These are valuable boundaries to preserve. No claim that Caddie has no recovery or verification is justified.

## Findings and current evidence

1. **Fixed locally: one repair gate used the wrong retry window.** In `coordinator-host.ts`, the new-tests gate used `recordRepairRound().paused`, a lifetime per-issue count, while most other gates use `workflowRepairPause`, which counts failures after the latest explicit resume. A regression reproduced the first post-resume failure immediately pausing the build. The gate now uses the resume-aware policy. The test retains six historical failures and the first feature's checkpoint while proving three attempts in each window. All 95 build-workflow tests passed locally. This does not establish the exact cause of every Farmhand failure.
2. **Source-confirmed weakness: test count is a proxy.** `finishFeature` requires a larger passing-test count than earlier features. This can reject legitimate repairs that improve existing tests and cannot show that new tests cover the current acceptance criteria. Team-mode contracts add checks, but independent acceptance must not depend solely on generated tests or that mode.
3. **Source-confirmed weakness: repeat detection compares file size, not content.** `guardAction` uses subject and byte count for file writes. Equal-length productive edits can be misclassified as unchanged; alternating command/error cycles and repeated blocker narration need separate detection. Prove the equal-length case before changing schema or behavior.
4. **Observed integration gap: chat transport and project status can disagree.** Farmhand showed saved Building state while conversation history was unavailable. Latest live inspection subsequently showed history and 2/8 checked with the build paused. UI recovery now distinguishes loading/connection from active work; a ten-second read delay offers a read-only reload. This is not proof that backend bootstrap/recovery is permanently fixed.
5. **Source-confirmed settlement gap:** `COORDINATOR_DURABILITY` documents that submission timeout is not observed by an application hook; the 20-minute stall watchdog is the fallback. Audit Flue's existing recovery first, then project terminal settlements promptly without inventing a second execution authority.
6. **Unproven:** process death during effects, checkpoint/database gaps, interrupted streams, long repair context, flaky tests, checkpoint compatibility after tool/recipe changes and actual saved-design fidelity. Existing isolated green tests are not enough to close these gates.

## Implementation packets

Integration lead owns shared contracts, migrations and manifests. Apply these serially; preserve the imported-app route fix and other sessions' WIP. Each packet starts with a regression/fault case, ends with the nearest complete gate, and receives a coherent commit containing only its files.

### R00 — Consistent repair windows (implemented, local evidence)

- Files: `apps/app/src/server/coordinator-host.ts`, `tests/build-workflow.test.ts`.
- Use `workflowRepairPause(env.DB, runId, pauseScope)` after recording the new-test failure; keep all historical rounds.
- Proof: three failures pause; explicit resume permits three fresh failures; prior checkpoints stay identical. Same-key retry must not create a new window.
- Rollback: revert only this policy change. No migration or data rewrite.

### R01 — Reproducible failure corpus and authoritative timeline

- Extend `tests/fixtures/sandbox-stub.ts`, `tests/build-workflow.test.ts`, `tests/workflow-dispatch.test.ts`, `tests/sandbox-durability.test.ts` and existing Flue restart fixtures.
- Capture content-free logical operation IDs, attempt/window, feature, plan/design identity, checkpoint and terminal outcome. Do not copy secrets or user prompts into logs.
- Reproduce Farmhand-like interrupted repair and repeated pause as deterministic cases. Record inferred causes separately from actual receipts.
- Acceptance: failure reports name the exact boundary; duplicate delivery does not advance the feature or charge twice; browser reconnection does not resume work.

### R02 — Typed failure policy and interruption recovery

- Primary files: `apps/app/src/server/operations.ts`, `workflow-dispatch.ts`, `build-workflow.ts`, `coordinator-host.ts`, `apps/app/src/agents/coordinator.ts`, `permissions.ts`.
- Distinguish transient provider/transport failure, code/check failure, missing user decision, exhausted budget, explicit cancellation and ambiguous effect outcome.
- Reconcile ambiguous effects through the existing operation receipt before retry. Never promote a timeout to an invented success or blindly rerun a write.
- A paused/terminal result ends the active orchestration path; prevent repeated model calls that only rediscover the pause. Preserve the explicit user-resume boundary and approvals.
- Acceptance: abort before/after dispatch, late receipt, duplicate callback, provider 429/5xx, worker restart and approval revocation. Enforce unchanged logical IDs, cost boundaries and state after fresh-process reload.

### R03 — Progress-aware loop detection

- Files: `coordinator-host.ts`, `build-activity.ts`, `permissions.ts`; an append-only migration only if existing metadata cannot carry a content digest.
- Fingerprint actual file content, relevant code state and normalized failure results. Distinguish repeated productive tests from unchanged failing checks and alternating tool loops.
- Use a bounded recent window. Give one precise recovery instruction, then stop within budget if no new evidence appears. Do not silently raise limits.
- Acceptance: same-length changed content proceeds; identical unchanged edits and repeated equivalent failures stop; duplicate receipts are replay-safe; detection never invokes a paid classifier in local tests.

### R04 — Independent feature completion and protected baselines

- Files: `build-features.ts`, `coordinator-host.ts`, `contract-checks.ts`, recipe/check support and `tests/host-checks-contract.test.ts` / `contract-checks.test.ts`.
- Map each acceptance criterion to independently owned checks. Preserve baseline tests and approved scope. Use test-count growth as diagnostic information rather than the sole completion condition.
- Check feature behavior, earlier-feature regressions, type/build validity and saved-checkpoint identity. Reject weakened checks or a different revision's receipts.
- Acceptance includes a meaningless added test, deletion of a failing test, an existing-test repair with no count growth, wrong-actor data, offline/reconnect where required, and code changed after verification.

### R05 — Resume capsule, tool compatibility and design fidelity

- Files: `coordinator-context.ts`, `coordinator-host.ts`, `coordinator.ts`, existing code-version/sandbox adapters and `visual-fidelity.ts`.
- Preserve a structured capsule: approved scope/design, current feature, last verified checkpoint, latest failing evidence, attempted fixes, remaining limits and pending tool outcomes. Do not compact away unresolved calls or replay abandoned branches.
- Restore compatible tools/recipes and workspace/checkpoint identity before continuing. Make unsupported restoration explicit.
- Wire the actual phone/desktop capture adapter; current local comparator/host seam is not production fidelity proof. Retain generated-app errors and accessibility findings as evidence, not model self-reports.
- Acceptance: long-context restart preserves decisions, mismatched restoration refuses effects, approved screens and built screens can be compared with a bounded repair path.

### R06 — Release gate

- Run the fault corpus across a small CRUD app, offline app, AI-backed app and imported repository. Prove interruptions during editing, tests and preview publication; Stop plus late completion; retry exhaustion; stale approvals; quota exhaustion; failed checkpoint persistence; concurrent ownership; and real browser journeys.
- Report success rate, recovery rate, wasted/duplicate work, latency distributions and actual cost only for measured runs. Do not invent targets from one successful fixture.
- Local fixtures: no paid calls. A representative live model/sandbox evaluation is a separate explicitly authorized gate. Require authenticated proof before a production-ready claim.

## Stop condition and recommendation

Do not recommend a runtime migration, more agents or larger limits merely because a popular project has them. The first decision is whether these boundaries can be made correct in the present runtime. Only benchmark a replacement when the failure corpus demonstrates a specific unresolved limitation and the candidate can preserve Caddie's approvals, receipts, isolation and nontechnical workflow.

This plan is an implementation sequence, not a completion claim. The one repair-window fix is locally verified; the broader reliability gate remains open.

## Owner amendment: autonomous model escalation

The execution plan now includes B02a: evaluate Nebius alternatives and implement at most three models/two checked repairs per model within the existing admitted allowance. The authenticated catalog snapshot returned 30 models with zero inference calls. Technical repair remains Caddie-owned; all-model exhaustion must preserve work and produce a plain incomplete state rather than instructions asking a nontechnical user to debug. See the execution plan for exact candidate IDs, capability/region gates, cost accounting, legacy-pause compatibility and acceptance cases.

## Owner amendment: selected alternates and pre-presentation validation

The default candidate ladder now uses Nemotron 3.5 Super VL → DeepSeek V4.1 Flash 1017 → GLM-5.3. Kimi remains research context, not the chosen alternate. The execution plan adds B00a: an independent plan and actual-screenshot design review/fix gate before publication, with bounded cycles and retained user approvals. The recorded Nebius catalog advertises the pinned DeepSeek V4.1 route as image-capable; GLM-5.3 is text-only and excluded from visual review. Actual vision/schema quality still requires authorized live evaluation.
