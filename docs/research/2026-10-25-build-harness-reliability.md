# Build-harness reliability — lessons from the proven OSS harnesses

Status: LOCAL VERIFIED for tonight's incident evidence (model_call_usage,
build_features, flue_agent_submissions on the dev DO/D1, 2026-10-25
03:49–04:15); DOCUMENTATION ONLY for the open-source reading. Owner ask:
"look at opensource projects like pi, openhands and the other popular harnesses
— make the building process as robust and reliable as possible, and document
how they work."

## 1. What actually broke tonight (evidence, not theory)

The Farmhand build (8 features) ran end-to-end for the first time with max
reasoning effort on every role. Three failure classes surfaced:

| # | Failure | Evidence | State |
| --- | --- | --- | --- |
| F1 | **Reasoning starved the output cap.** Delegates returned `"(task completed with no text)"`; five calls cut at exactly 8,192 output tokens. No test files were written, so `finish_feature`'s behavior-tests gate failed. | `model_call_usage`: five rows `routeId=nemotron-3.5-super-vl, outputTokens=8192` | FIXED 2026-10-25 — Super VL/Ultra caps 8192→32768, Lightning 4096→8192. Features 1–2 then **passed** (3 + 6 behavior tests). |
| F2 | **A delegate hung for 103 minutes** (6,189,040 ms) and only then errored (`isError=1`). Nothing bounds one delegated specialist's wall-clock. | `model_call_usage`: row `0/0 tokens, isError=1, durationMs=6189040` | OPEN — the biggest reliability hole. |
| F3 | **Transient provider errors surface un-retried.** A coordinator chat call errored in 46 ms (`isError=1, 0/0`); a GLM probe got HTTP 529 "System is overloaded" and needed manual retries. | `model_call_usage` row + probe-thinking log | OPEN — needs retry-with-backoff on 429/529/timeouts. |

Context: when model calls *complete*, the pipeline is sound — feature 1 passed
on attempt 2, feature 2 passed first try with 6 tests, repair rounds are
bounded and honestly reported ("could not get the app checks passing after
three attempts"). The failures are all **resource-boundary** failures, not
reasoning failures.

## 2. How the proven OSS harnesses bound themselves

### OpenHands (ex-OpenDevin)
Layered budget controls, per their docs and SDK paper:
- **Iteration caps per task** (`MAX_ITERATIONS`, default ~100) and a
  **hard accumulated-cost cutoff** — a run cannot spend without bound.
- **`LLM_NUM_RETRIES` (default 8)** with backoff — transient provider errors
  are absorbed by the harness, not surfaced to the user.
- **Sandbox command timeouts** (default ~120 s per command) — one hung shell
  call cannot stall the run.
- **Condensers** — context compression per step so long runs do not blow the
  window; constrains tokens per step, which is also a cost lever.
- **Goal-completion loop with judge feedback** re-prompts until done or a hard
  iteration cap.
- Known lesson: enforcement has edge cases ([issue #6857] — `max_iterations=1`
  kept running to step 6), so caps must be enforced at the loop, not the prompt.

### SWE-agent
The **ACI (Agent–Computer Interface)** paper + harness guardrails:
- Purpose-built tools with **guardrails and feedback** (lint-on-edit, guarded
  file viewers) instead of raw shell — interface design alone drove large gains.
- The harness enforces, per run: **step limit, cost limit, timeout, and a
  consecutive-failure counter** that stops runaway loops.
- Their lesson: **harness quality is worth 10–15+ points** of end-to-end
  performance — the same model, better scaffold.

### Aider
- **Retry-on-implausible**: the benchmark harness re-ran a problem whenever
  aider itself reported an error or implausible result — simple, and it set
  SOTA at the time.
- **Verification loops pay**: adding a reviewer/verifier pass lifted resolution
  from ~80% to ~90% at ~2.2× time cost (community experiment on 100
  SWE-bench instances).
- **Context selection (repo map)** is core: custom retrieval + retry policies
  are exactly where vendor harnesses outperform thin loops.

## 3. Gap analysis — our pipeline vs theirs

| Control | OpenHands / SWE-agent / Aider | Ours (Flue pipeline) | Gap |
| --- | --- | --- | --- |
| Per-delegate wall clock | Command timeouts (OH ~120 s), run timeout (SWE-agent) | **None** — F2 hung 103 min | **P0** |
| Provider-error retries | `LLM_NUM_RETRIES=8` with backoff | Single-shot; 529s surfaced | **P0** |
| Empty-result guard | — (their tools return structured errors) | Plan loop has the `plan_incomplete` anti-re-delegate signal; **build loop lacks it** (5 identical empty re-delegations tonight) | **P0** |
| Run/cost budget | MAX_ITERATIONS + cost cutoff (OH), step+cost limit (SWE-agent) | Repair rounds bounded (3), submission attempts bounded (3) — no token/$ cutoff per run | P1 |
| Context compaction | OH Condensers; Aider repo map | Flue threshold compaction + fold checkpoints exist | P2 — tune for long builds; delegate inputs hit 21.6k tokens |
| Verification before done | SWE-bench gates; OH judge loop; reviewer pass (+10 pts) | `finish_feature` behavior-tests gate is **already strong** | P2 — optional reviewer pass per feature |
| Observability | — | `model_call_usage` (per call), `build_activity`, check history | Add `finish_reason`/stop-reason to usage rows |

## 4. Prioritized upgrades (file targets; apply when the tree is free)

**P0 — stop the bleeding**
1. **Per-delegate wall-clock timeout** (e.g. 10 min hard) in the specialist
   delegation path (`apps/app/src/agents/specialists.ts` / flue `task` options):
   on timeout, error the delegate honestly and let the bounded repair loop
   retry with a fresh delegate. A 103-minute hang must be impossible.
2. **Retry with backoff on 429/529/network** for model calls in
   `providers.ts`/flue config (mirror `LLM_NUM_RETRIES=8`): absorb provider
   overload; only then surface.
3. **Anti-re-delegate guard for empty build delegates** — mirror the
   coordinator's `plan_incomplete` signal: a delegate result of "(task
   completed with no text)" must never be retried as-is; the coordinator
   re-delegates with narrowed instructions or calls `report_blocker`.

**P1 — bounded runs**
4. **Run-level token/$ budget** with a hard cutoff (OH-style): meter
   `model_call_usage` per run; at the limit, stop and report honestly.
5. **Per-command sandbox timeout** (120 s, OH default) if TF Sandboxes don't
   already bound each command.
6. **Record `finish_reason`** on every `model_call_usage` row — tonight's
   starvation was provable only because outputTokens == cap; make it explicit.

**P2 — quality multipliers**
7. **Reviewer pass per feature** before `finish_feature` (Aider lesson:
   +10 pts for 2.2× time) — the architect delegate pattern already exists.
8. **Delegate-prompt context packer** (repo-map style) to keep specialist
   inputs lean as features stack.

## 5. Sources (DOCUMENTATION ONLY)

- [OpenHands SDK Architecture](https://docs.openhands.dev/sdk/arch/overview) ·
  [SDK paper](https://arxiv.org/html/2511.03690v2) ·
  [goal loop](https://docs.openhands.dev/sdk/guides/convo-goal) ·
  [issue #6857](https://github.com/OpenHands/OpenHands/issues/6857) ·
  [guide](https://docs.clore.ai/guides/ai-platforms-and-agents/openhands)
- [SWE-agent ACI docs](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md) ·
  [paper](https://arxiv.org/html/2405.15793v3) ·
  [harness deep dive](https://dev.to/truongpx396/swe-agent-deep-dive-build-your-own-guide-ade) ·
  [harness-engineering analysis](https://pub.towardsai.net/harness-engineering-how-interface-design-quietly-tripled-ai-coding-performance-swe-8f08e80eba9b)
- [aider-swe-bench harness](https://github.com/Aider-AI/aider-swe-bench) ·
  [aider SOTA post](https://aider.chat/2024/06/02/main-swe-bench.html) ·
  [harness-gap analysis](https://tianpan.co/blog/2026/04/09/agentic-coding-production-swebench-gap) ·
  [reviewer-loop experiment](https://www.reddit.com/r/ClaudeAI/comments/1qi2gh0/i_ran_100_swebench_tests_comparing_1_agent_vs_2)
