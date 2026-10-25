# Build reliability — implementation handover

**Decision:** ready for staged local implementation. The earlier working tree has now been checkpointed; see [verified checkpoint and commit identities](../evidence/2026-10-25-handover-checkpoint.md). Start coding against the execution plan; do not produce another replacement plan. This handover changes documentation only and does not claim the packets are implemented.

## Read in this order

1. `AGENTS.md` and applicable directory instructions; `docs/flue-contracts.md`; `docs/plans/2026-10-03-fresh-build/README.md` and `contracts.md` for authority/runtime boundaries.
2. **Implementation authority:** `docs/plans/2026-10-25-build-reliability-execution.md`. Includes B00–B08, B00a artifact publication/review, B02a repair-model escalation, and mandatory layered deadlines/empty-result/finish-reason/cancellation requirements inside B02. The amendments are part of the implementation scope.
3. **Live model evidence and limitations:** `docs/evidence/2026-10-25-model-validation/README.md`, then `results.json` and `screenshots.json` in that same directory. Keep the entire directory available: it includes prompts, exact generated-code answers, usage, timings and six calibration PNGs.
4. **Supporting source research:** `docs/plans/2026-10-25-build-reliability.md`, `docs/evidence/2026-10-25-agent-harness-source-inventory.json`, and `docs/evidence/2026-10-25-nebius-model-catalog.json`.
5. **Historical incident evidence:** `docs/research/2026-10-25-build-harness-reliability.md`. Apply the corrections in the execution plan's final reconciliation section. This report does not override execution order or establish that currently present controls are absent.

The repository is the handover package: do not copy only Markdown into an empty workspace. The implementation depends on the checkpointed source/test changes as well as the documentation; the checkpoint report records the implementation commit identities. Capture a fresh HEAD/status and preserve any newer unrelated WIP. No blanket stash/reset, mass staging or force-push.

## Immediate work

1. B00: capture current checkout/runtime/bundle identity, rerun the baseline and the existing repair-window regression, and inspect Farmhand read-only. Keep the imported-app review-routing fix and existing historical approvals.
2. B01: build deterministic fault cases before edits, especially request/stream/delegate hangs, empty results and Stop/late-effect races.
3. B02: wire one recovery policy into existing Flue/host authority. Enforce persisted deadlines, bounded provider retries, finish/stop reasons, complete accounting and cancellation fencing. Reuse existing spending/durability/command controls.
4. Implement B03/B04 and the B02a eligibility/accounting foundation. B00a depends on B00/B01/B02 and those shared foundations; the full B02a repair supervisor additionally depends on B03/B04. Do not introduce a circular dependency.
5. Complete B05/B06/B07, including fresh-process recovery, actual captures, user journeys and truthful nontechnical-first status. Prepare B08 locally; broad paid evaluation and deployment retain their explicit authorization gates.

Use the execution plan's exact file targets, commands, gates and rollback rules. Write the regression, establish RED, implement narrowly, run the targeted and nearest complete gates, review the diff and checkpoint a coherent change using Conventional Commits with explicit-file staging. New migrations/shared contracts/manifest edits are integration-lead owned and applied serially. Allocate migration numbers against the actual current tree.

## Model policy to implement

```ts
const repairModels = [
  'nvidia/Nemotron-3.5-Super-VL',
  'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  'zai-org/GLM-5.3',
] as const;
const bounds = { maxCheckedAttemptsPerModel: 2, maxCheckedAttemptsPerIssue: 6 };
```

These checked-attempt caps do not replace physical-call, time, token, action or money limits. Switching models cannot reset any issue/build limit or open a fresh spend window. Reconcile ambiguous writes before replay. Reviewers are read-only and cannot grant user approval.

- Plan review: DeepSeek; GLM text fallback, always distinct from the actual author.
- Design review: DeepSeek; Super VL vision fallback, with actual phone/desktop image input and complete required-screen/state coverage. GLM-5.3 is text-only and ineligible.
- DeepSeek 1017 and GLM are not yet installed as production routes by the probes. Register/pricing-bind them through existing providers; preserve role defaults unless a packet explicitly changes them.
- Preserve current output-token headroom and maximum-reasoning policy. Calibration fixture success is not proof a smaller cap suffices for real generation.

Live preflight: 23 requests, estimated list-price cost $0.13037670 (not an invoice). DeepSeek passed 8/8 cases, GLM 5/5, Super VL 6/7. Super VL missed an author-self-approval flaw in a bad plan; keep deterministic approval separation and do not use it as the plan reviewer on this evidence. Both vision routes passed good/broken/blank calibration. This proves limited compatibility/calibration, not production reliability or full Flue recovery.

The prior owner authorization covered those bounded probes. Do not rerun paid probes by default or assume a broader live benchmark/deployment allowance. No inference is needed for the initial fault corpus and local implementation gates.

## Completion report required

Report separately: implemented packets, local verification, actual live verification, untested/blocked work and deployment status. Include command exits, final commit identities and any pre-existing failures. A model's success report, connection status, larger test count or stale workflow row is never completion evidence.

The product is for nontechnical users first: Caddie owns repair and internal recovery; users review scope/design and try the app. Technical details are optional. Never route a code/test/model-selection problem back to the user as a debugging task.

## No-inference evidence checks

```sh
bun scripts/probe-reliability-models.ts --self-test
bun run typecheck
```

`CADDIE_LIVE_AUTHORIZED=1 bun scripts/probe-reliability-models.ts` is a paid probe, not an ordinary local test, and overwrites its evidence output directory. Preserve prior evidence and obtain the appropriate live authorization before a new run.
