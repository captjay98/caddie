# Selected-model live preflight and implementation handover

**Decision: GO for staged local implementation. Not a production enablement or harness-reliability certification.**

Owner authorized live model tests in this conversation on 2026-10-25. Synthetic inputs only; no real conversation, credentials, customer code or project data sent. No production routes, defaults, approvals, builds or deployment changed.

## Evidence

- **LIVE VERIFIED:** 23 physical Nebius inference requests, no automatic transport retries, 20 scored cases: 19 passed, one failed. Provider usage reported 63,815 total tokens. Estimated list-price cost **$0.13037670**, not an invoice. Conservative reservations totalled $1.60494960 within the $3 run ceiling. Maximum completion cap 16,384; reasoning requested `max`. A cap sufficient for these fixtures is not a recommendation to lower existing production caps.
- **LOCAL VERIFIED:** actual Chromium PNG capture at 390×844 and 1440×900; good, deliberately broken and blank screens, with network blocked. Six screenshots, dimensions and hashes in `screenshots.json`.
- **LOCAL VERIFIED:** host repair assertions accept known correct code and reject wrong currency arithmetic, duplicate application and omitted amount validation; strict-schema validator rejects extra keys. Root and app typechecks pass.
- First Chromium launch was sandbox-blocked before inference; authorized unsandboxed capture succeeded. After the text cases, an overly restrictive base64 byte guard stopped before sending any vision request. The corrected guard allowed a bounded continuation using the same accumulated request/cost counters. No text cases were repeated and no hidden retries were added.
- `results.json` contains usage, timings, answers, host checks and per-case verdicts. Reasoning text and credentials are omitted. `fixtures.json` and the probe source preserve the synthetic task contracts. Images are calibration fixtures, not generated Farmhand designs.

| Route | Scored cases | Result | Checked repair time | Intended use |
|---|---:|---|---:|---|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 8 | 8 passed | 27.0 s | Alternate repair; independent plan reviewer; primary visual reviewer |
| `zai-org/GLM-5.3` | 5 | 5 passed | 44.4 s | Alternate repair; text plan-review fallback; never visual review |
| `nvidia/Nemotron-3.5-Super-VL` | 7 | 6 passed, 1 failed | 13.7 s | Existing repair route; tested visual-review fallback |

These are single small calibration cases, not latency rankings or broad quality estimates. No large-context, sustained-load, outage/restart, long-horizon agent or repair-ladder benchmark ran here.

## What was actually tested

1. **Actual pi-ai adapter tool round-trip:** local provider registration uses the installed `@earendil-works/pi-ai@0.87.1` and the existing compatibility flags (`supportsDeveloperRole:false`, `supportsStore:false`, `maxTokensField:max_tokens`). Its streaming implementation emits a parsed tool call with the right arguments and consumes the tool receipt on continuation. A fresh random receipt nonce and negative check result must appear in the final answer. Actual HTTP requests are counted through the injected fetch; `maxRetries:0`. This tests the adapter, not a full Flue durable run or production registration of the new routes.
2. **Strict JSON request and local schema validation:** deadline/eligibility case distinguishes checked legal eligibility from an elapsed deadline and converts UTC to Africa/Lagos correctly. All three returned the required schema and correct values. This does not prove provider-side strict schema enforcement for arbitrary schemas; keep host validation.
3. **Repair with host-run checks:** generated pure JavaScript corrects kobo arithmetic, duplicate event delivery, offline queueing, later sync, synced-then-unsynced replay, input immutability, empty events, fractional/NaN amounts and invalid initial balance. Eight deterministic case groups; all three models passed first try. No model self-report substitutes for test execution. No autonomous multi-attempt build was executed.
4. **Independent plan review:** deliberately bad draft contains a photo/actual-modality mismatch, no offline support, missing farm isolation, user debugging and author self-approval. DeepSeek and GLM found all scored blockers. Super VL rejected the plan and found the other problems, but **missed author self-approval**: this case is FAILED. Do not waive it or promote Super VL as the plan gate on this evidence. Approval separation must remain host-enforced for every reviewer.
5. **Sound-plan negative control:** DeepSeek and GLM both accepted a scoped, coherent single-owner notebook plan instead of inventing blockers or requesting unnecessary scope expansion.
6. **Actual visual grounding:** DeepSeek and Super VL saw phone and desktop PNG bytes for three independent outcomes. Both accepted good screens, rejected broken screens (near-invisible contrast, tiny text, horizontal clipping and off-screen actions) despite the accompanying prose claiming all was fine, and classified blank captures as `unavailable`. No text-only fallback. This is a small calibration, not proof every design defect will be found. Super VL also misstated a minor screenshot value in one finding; semantic/content checks remain necessary.

## Concrete handover

Implement `docs/plans/2026-10-25-build-reliability-execution.md` end to end in its staged dependency order. Preserve the dirty checkout and existing imported-app review fix. Start B00/B01; do not rewrite the architecture or make another plan before coding. Checkpoint coherent, verified changes using established Conventional Commits and explicit-file staging. Keep deployment separate.

Use the owner-selected, versioned candidate ladder:

```ts
const candidateRepairModels = [
  'nvidia/Nemotron-3.5-Super-VL',
  'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  'zai-org/GLM-5.3',
] as const;
// At most 2 checked repair attempts/model; 6 total per issue.
// Provider retries and all actual calls also count against admitted limits.
```

Implement the shared eligibility/accounting foundation before the pre-presentation gate; the full repair supervisor still depends on progress fingerprints and independent host checks. The new routes need actual production registry entries, correct pricing snapshots and capability profiles; this probe's ephemeral registrations did not modify product defaults. Preserve existing maximum reasoning policy/output headroom. Pin DeepSeek's exact tested `1017` ID; do not silently use the unversioned alias. Do not infer GLM-5.3 vision support from the separate GLM-5.3-Flash model.

For plan review use DeepSeek, GLM as the text fallback, distinct from the author. For design review use DeepSeek, Super VL as the vision fallback, with actual captured images and complete required-screen/state coverage. Retain deterministic approval authority, tenant isolation, scope/manifest checks and exact revision binding regardless of reviewer prose. Re-check actual route distinction if the author escalates.

Finish the deterministic fault/recovery/publication/budget/stop tests and local end-to-end journeys before enabling the policy. This preflight resolves basic selected-model access and compatibility uncertainty; it does not replace B01/B04/B06/B08. Broad comparison runs, new live agent workloads and deployment are outside this probe authorization. Do not automatically spend on model reviews from polling GETs or revalidate existing approved Farmhand artifacts.

Failures remain Caddie's responsibility: bounded alternate-model repair, preserved checkpoints and a truthful status. Never ask a nontechnical user to debug code, read logs or choose repair models. Ask only for genuine product, access or spending decisions.

## Reproduction

No inference:

```sh
bun scripts/probe-reliability-models.ts --self-test
bun run typecheck
```

Paid fresh preflight (only with explicit live authorization; overwrites this output directory, so preserve an earlier result first):

```sh
CADDIE_LIVE_AUTHORIZED=1 bun scripts/probe-reliability-models.ts
```

The `--vision-only` switch is a continuation for the interrupted first run: it restores its physical-call/reservation counters and performs sound-plan controls plus vision cases. It is not an unbounded retry command. Do not run it against the completed 23-request evidence.
