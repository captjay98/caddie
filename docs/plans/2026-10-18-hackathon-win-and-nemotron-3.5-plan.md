# Caddie Forge — Nemotron 3.5 Upgrade, Implementation Hardening & Hackathon Win Plan

**Date:** 2026-10-18  
**Status:** APPROVED FOR EXECUTION  
**Target Contest:** Nebius × NVIDIA Global AI Hackathon (`nebiusglobalaihackathon.devpost.com`)  
**Submission Deadline:** October 30, 2026, 10:00 AM PDT (6:00 PM WAT)  
**Target Tracks:** Coding & Agentic Engineering / Best Apps & Agents + **Tavily $3,000 Bonus Award**  
**Repository:** `/Users/captjay98/projects/caddie-forge`

> **For the implementing agent:**  
> Read `AGENTS.md` and `docs/flue-contracts.md` first. Keep evidence classifications exact (`LOCAL VERIFIED`, `LIVE VERIFIED`, `SIMULATED`, `DOCUMENTATION ONLY`, `BLOCKED`, `FAILED`). Never print or commit secrets from `.dev.vars`. Do not perform production deployments or paid API calls beyond the bounded 3-request probe in Packet H01.1 without explicit owner authorization at execution time.

---

## 1. Executive Summary & Hackathon Compliance Matrix

### 1.1 Official Contest Rules & Judging Criteria
From `nebiusglobalaihackathon.devpost.com/rules` (snapshots in `/Users/captjay98/projects/nebius-forge-eval/research/01-compliance-matrix.md`, `findings/evidence/compliance-correction.md`, and `/Users/captjay98/projects/caddie/devpost/nebius-plan.md`):

1. **Stage One Pass/Fail (Mandatory Baseline):**
   - Must be *"a working software application that runs on either Nebius Token Factory or Nebius AI Cloud and uses at least one NVIDIA open source model."*
   - Must make **runtime calls to the Token Factory inference API** (`https://api.tokenfactory.nebius.com/v1`). Config-only mentions fail Stage One.
2. **Track Definitions & Top-of-Scale Bars:**
   - **Coding & Agentic Engineering Track:** *"Build coding agents and developer tools: agents that write, run, and test code in Token Factory."*
     - Organizers' top-of-scale bar: *"an agent that plans, writes, tests, and iterates on a real repo with minimal human input."*
   - **Best Apps & Agents Track:** *"Build any app or agent someone would actually use… using Nemotron models on Nebius through Token Factory."*
     - Organizers' top-of-scale bar: *"a multi-step autonomous workflow that chains tools end to end."*
     - Track guidance explicitly highlights tiered routing across Nemotron models (*"serious reasoning vs. fast everyday calls"*).
   - **Tavily Bonus Award ($3,000):** Requires functional runtime calls to the Tavily API (`/search` and `/extract`) as an integral part of the workflow.
3. **Stage Two Judging Rubric (4 Equal Criteria × 25%, scored 1–5; tie-breaker = Technological Implementation):**
   - **Technological Implementation (25%):** Depth and effectiveness of Nebius Token Factory + NVIDIA Nemotron + Token Factory Sandboxes + Tavily usage.
   - **Design (25%):** Complete, coherent product experience (not a raw PoC).
   - **Potential Impact (25%):** Credible, specific use case for solo builders, demonstrated end-to-end.
   - **Quality of the Idea (25%):** Creative, non-obvious use of Token Factory; host-enforced verification oracle instead of model self-reports.
4. **Mandatory Submission Artifacts:**
   - Public GitHub repository with an open-source **MIT `LICENSE` visible at the root**.
   - Root **`README.md`** highlighting NVIDIA Nemotron + Nebius Token Factory + Tavily usage.
   - **Written explanation of significant updates** during the Submission Period (required because the original `caddie` concept existed for the Devpost Learn hackathon; `caddie-forge` is a ground-up October 2026 rebuild).
   - **Live Demo URL** freely accessible to judges without paywalls or invite dead-ends throughout the judging window (**December 1–15, 2026**).
   - **YouTube Demo Video (< 3:00)** in English whose audio explicitly explains Nebius Token Factory and NVIDIA Nemotron usage.

---

## 2. Live Model Discovery & Benchmark Analysis (Owner-Confirmed)

### 2.1 Live Nebius Token Factory Catalog (`GET /v1/models?verbose=true`)
Querying `https://api.tokenfactory.nebius.com/v1/models?verbose=true` revealed **two new NVIDIA Nemotron 3.5 models** (`nvidia/Nemotron-3.5-Super-VL` and `nvidia/Nemotron-3_5-Lightning`) served alongside `nvidia/Nemotron-3-Ultra-550b-a55b` and `zai-org/GLM-5.3-Flash`, plus native Nebius pricing and context windows:

| Route ID | Nebius Model ID (`modelId`) | Gen / Params | Modality | Context | Quant | Nebius Price (In / Out per 1M) | Rate Limits (TPM / RPM) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `nemotron-3-ultra` | `nvidia/Nemotron-3-Ultra-550b-a55b` | 3.0 (550B / 55B active) | `text->text` | `1,048,576` | `fp4` | `$1.00 / $3.00` (`100 / 300` minor) | 200k TPM / 300 RPM |
| `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | **3.5** (120B / 12B active) | **`text+image->text`** | `1,048,576` | **`bf16`** | `$0.30 / $0.90` (`30 / 90` minor) | **2,000k TPM** / 300 RPM |
| `nemotron-3.5-lightning` | `nvidia/Nemotron-3_5-Lightning` | **3.5** (30B / 3B active) | `text->text` | `1,048,576` | **`bf16`** | `$0.06 / $0.24` (`6 / 24` minor) | 400k TPM / **600 RPM** |
| `glm-5.3-flash` | `zai-org/GLM-5.3-Flash` | 5.3 (320B / 18B active) | `text+image->text` | `1,024,000` | `fp4` | `$0.15 / $0.50` (`15 / 50` minor) | 400k TPM / 600 RPM |
| `nemotron-3-super` *(legacy)* | `nvidia/nemotron-3-super-120b-a12b` | 3.0 (120B / 12B active) | `text->text` | `262,144` | `fp4` | `$0.30 / $0.90` (`30 / 90` minor) | 200k TPM / 300 RPM |
| `nemotron-3-nano` *(legacy)* | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 3.0 (30B / 3B active) | `text->text` | `262,144` | `fp8` | `$0.06 / $0.24` (`6 / 24` minor) | 800k TPM / 100 RPM |

*(Retain `nemotron-3-super` and `nemotron-3-nano` in `MODEL_ROUTES` so existing D1 `run_bindings` rows and historical tests referencing those route IDs never fail closed on lookup.)*

### 2.2 Published Benchmark Comparison (Why Each Model Wins Its Role)

| Benchmark / Metric | **`nvidia/Nemotron-3.5-Super-VL`** (120B / 12B active, BF16) | **`zai-org/GLM-5.3-Flash`** (320B / 18B active, FP4) | **`nvidia/Nemotron-3_5-Lightning`** (30B / 3B active, BF16) | **`nvidia/Nemotron-3-Ultra-550b-a55b`** (550B / 55B active, FP4) |
| :--- | :---: | :---: | :---: | :---: |
| **Release Date** | **Oct 14–15, 2026** | Aug 26, 2026 | Aug 11, 2026 | June 2026 |
| **SWE-bench Pro** | **51.78%** *(surpasses Ultra)* | **50–52%** *(64-task subset)* | — | < 51.78% |
| **SWE-bench Verified** | **71.1%** | *Unpublished* | **51.56%** | **66.0%** |
| **LiveCodeBench v6** | **88.2%** | — | — | — |
| **Hermes Bench (Agentic Tool Use)** | **63.44%** *(surpasses Ultra)* | — | — | 56.33% |
| **LangChain Agent Evals** | **87.05%** *(surpasses Ultra)* | — | — | 84.30% |
| **PinchBench (High-Volume Agent)** | — | — | **85.37%** | — |
| **GPQA Diamond** | — | — | **75.44%** | — |
| **BrowseComp (Web Research)** | **78.0%** *(79.8% w/ verify)* | — | 36.97% | — |
| **Terminal-Bench 2.1** | 66.7% *(71.9% w/ verify)* | **84.3%** | — | — |
| **DeepSWE v1.1** | 34.5% *(w/ parallel verify)* | **63.4%** | — | — |
| **CharXiv (Visual / Chart QA)** | **80.8%** *(84% w/ code)* | **89.4%** *(CharXiv-R)* | Text-only | Text-only |
| **Output Throughput** | **600+ tok/s** *(MTP + LiLiCorr)* | **~49 tok/s** | **~314 tok/s** *(MTP)* | Slower (550B MoE) |

### 2.3 Locked Role-to-Model Assignment (`MODEL_ROLES` in `apps/app/src/agents/providers.ts`)

| Role (`MODEL_ROLES`) | Route ID | Nebius Model ID | `maxTokens` | Engineering & Benchmark Justification |
| :--- | :--- | :--- | :---: | :--- |
| **`ideation`** | `nemotron-3-ultra` | `nvidia/Nemotron-3-Ultra-550b-a55b` | `16,384` | **550B (55B active)** frontier judgment for the 30-turn Home brainstorming window (`IDEATION_TURN_WINDOW = 30`): asks one focused round of questions, critiques ideas against rules, and never confuses narrowing with choosing. |
| **`chat`** | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `16,384` | **120B (12B active) Nemotron 3.5**, `bf16`, 1M ctx, 2M TPM, 600+ tok/s, distilled from Ultra Base (1T tokens) and explicitly post-trained across the **Pi agent harness** (`@earendil-works/pi-ai`) used by Flue (`87.05%` LangChain Evals, `63.44%` Hermes Bench). |
| **`vision`** | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `16,384` | **Native `text+image->text` + `tools`** on NVIDIA's 3.5 architecture (`80.8%–84%` CharXiv, OCRBench v2 leader). *(Verified via Packet H01.1 live probe before switching from `glm-5.3-flash`; falls back to `glm-5.3-flash` only if the live image+tool probe fails.)* |
| **`helper`** | `nemotron-3.5-lightning` | `nvidia/Nemotron-3_5-Lightning` | `4,096` | **30B (3B active) Nemotron 3.5**, `bf16`, 1M ctx, **600 RPM** (6× higher than 3.0 Nano's 100 RPM), ~314 tok/s (`75.4%` GPQA, `85.4%` PinchBench) for Tavily query shaping, verbatim rule-quote extraction (`rules-reading.ts`), and candidate digests (`candidate-inspection.ts`). |
| **`app`** *(default)* | `nemotron-3.5-lightning` | `nvidia/Nemotron-3_5-Lightning` | `4,096` | Default fast tier for `env.CADDIE.ai({ messages })` inside user-generated apps (`server/app-ai.ts`): sub-second replies at `$0.06/$0.24` per 1M so a project's `$1.00/month` allowance stretches ~4× further than 3.0 Super. |
| **`appSuper`** *(`tier: "super"`)* | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `4,096` | Deeper reasoning tier for `env.CADDIE.ai({ messages, tier: "super" })` inside user-generated apps when an app feature requires multi-constraint reasoning, forecasting, or analysis (`$0.30/$0.90` per 1M). |
| **`plan`** | `glm-5.3-flash` | `zai-org/GLM-5.3-Flash` | `32,768` | **320B MoE (18B active)**, live-verified (`3d8bc1f6`, `276828cb`) emitting 18.9k-char (8.2k-token) comprehensive PRDs with valid ````caddie-features` JSON blocks and multi-screen ````html-mock` design briefs in a single `write_plan_note` tool call at `$0.15/$0.50` per 1M. |
| **`build`** | `glm-5.3-flash` | `zai-org/GLM-5.3-Flash` | `32,768` | **84.3% Terminal-Bench 2.1 / 63.4% DeepSWE v1.1**, live-verified on Caddie's feature-by-feature sandbox build & test loop (`frontend`, `backend`, `mobile`, `qa`). |

---

## 3. Sequenced Implementation Packets (H01–H06)

### Packet H01: Live Probe, Model Registry Upgrade & Dual-Tier `env.CADDIE.ai`

#### Step H01.1 — Guarded Live Verification Probe (3 requests, <$0.01)
Before changing `MODEL_ROLES`, run a small one-off probe (reading `NEBIUS_API_KEY` from `.dev.vars`, never printing the key) against `https://api.tokenfactory.nebius.com/v1/chat/completions`:
1. **`nvidia/Nemotron-3.5-Super-VL` (Text + Tool Call):** Send a prompt with a `remember` tool definition (`tool_choice: 'auto'`) and confirm HTTP 200 + `tool_calls` emitted.
2. **`nvidia/Nemotron-3.5-Super-VL` (Vision + Tool Call):** Send the split red/blue PNG inline `image_url` + the `remember` tool definition (matching the commit `96fe6771` probe) and confirm HTTP 200 + both colors identified + `tool_calls` emitted.
3. **`nvidia/Nemotron-3_5-Lightning` (Structured JSON Extraction):** Send a short rules excerpt with the `rules-reading.ts` system prompt (`temperature: 0, max_tokens: 4096`) and confirm HTTP 200 + valid `{"claims":[...]}` JSON output.
4. Record the probe receipt (status, latency, token usage, tool call presence) in `docs/plans/2026-10-03-fresh-build/execution-ledger.md`.

#### Step H01.2 — Update `apps/app/src/agents/providers.ts` & `apps/app/src/client/coordinator.ts`
1. Add two new routes to `MODEL_ROUTES` in `apps/app/src/agents/providers.ts`:
   ```ts
   {
     id: 'nemotron-3.5-super-vl',
     specifier: 'nebius/nvidia/Nemotron-3.5-Super-VL',
     providerId: 'nebius',
     modelId: 'nvidia/Nemotron-3.5-Super-VL',
     pricingVersion: '2026-10-nemotron-tier',
     unitPriceMinorUnits: 90, // output $0.90/Mtok (budget ceiling)
     inputPriceMinorUnits: 30, // $0.30/Mtok
     outputPriceMinorUnits: 90, // $0.90/Mtok
     currency: 'usd',
     contextWindow: 1048576,
     maxTokens: 16384,
   },
   {
     id: 'nemotron-3.5-lightning',
     specifier: 'nebius/nvidia/Nemotron-3_5-Lightning',
     providerId: 'nebius',
     modelId: 'nvidia/Nemotron-3_5-Lightning',
     pricingVersion: '2026-10-nemotron-tier',
     unitPriceMinorUnits: 24, // output $0.24/Mtok (budget ceiling)
     inputPriceMinorUnits: 6, // $0.06/Mtok
     outputPriceMinorUnits: 24, // $0.24/Mtok
     currency: 'usd',
     contextWindow: 1048576,
     maxTokens: 4096,
   },
   ```
2. Update `nemotron-3-ultra` in `MODEL_ROUTES`:
   - `contextWindow: 1048576` (up from `262144`, matching `/v1/models?verbose=true`)
   - `maxTokens: 16384` (up from `8192`)
3. Update `VISION_ROUTE_IDS`:
   - `export const VISION_ROUTE_IDS: readonly string[] = ['nemotron-3.5-super-vl', 'glm-5.3-flash'];` (if Step H01.1 vision+tool probe passes; otherwise keep `['glm-5.3-flash']` and `vision: 'glm-5.3-flash'`).
4. Update `MODEL_ROLES`:
   ```ts
   export const MODEL_ROLES = {
     chat: 'nemotron-3.5-super-vl',
     ideation: 'nemotron-3-ultra',
     plan: 'glm-5.3-flash',
     build: 'glm-5.3-flash',
     helper: 'nemotron-3.5-lightning',
     app: 'nemotron-3.5-lightning',
     appSuper: 'nemotron-3.5-super-vl',
     vision: 'nemotron-3.5-super-vl',
   } as const satisfies Record<string, string>;
   ```
5. Update `COORDINATOR_MODEL_ROUTE` in `apps/app/src/client/coordinator.ts:31`:
   - Set `const COORDINATOR_MODEL_ROUTE = 'nemotron-3.5-super-vl';` (must equal `MODEL_ROLES.chat`).

#### Step H01.3 — Dual-Tier `env.CADDIE.ai` (`Lightning` + `Super`) for User-Generated Apps
1. **`apps/app/src/server/app-ai.ts`:**
   - Export `type AppAiTier = 'fast' | 'super';`
   - In `readRequest(input: unknown)`:
     - Accept optional `tier?: unknown` on the request object.
     - If `body.tier !== undefined && body.tier !== 'fast' && body.tier !== 'super'`, return `fail('invalid_request', 'Choose tier "fast" or "super".')`.
     - Return `tier: body.tier === 'super' ? 'super' : 'fast'` on the validated request.
   - In `reservationFor(route: ModelRoute, chars: number, messageCount: number, maxTokens = route.maxTokens)`:
     - Use `const outputCap = Math.min(maxTokens, 4096);` so both `app` (`nemotron-3.5-lightning`, `maxTokens: 4096`) and `appSuper` (`nemotron-3.5-super-vl`, whose Coordinator `maxTokens` is `16384`) reserve and cap at `4,096` output tokens for in-app calls.
   - In `runAppAi`:
     - Select `const route = findModelRouteForRole(read.tier === 'super' ? 'appSuper' : 'app');`
     - Pass `max_tokens: Math.min(route.maxTokens, 4096)` in the `/chat/completions` request body.
2. **`stacks/react-hono/server-files.ts` (`caddie/ai.ts`):**
   - Add `tier?: "fast" | "super";` to `CaddieAiRequest`:
     ```ts
     export interface CaddieAiRequest {
       /** Up to 40 messages, 32,000 characters in total. */
       messages: CaddieAiMessage[];
       /** Ask for one JSON object back. */
       json?: boolean;
       /** "fast" (default, Nemotron 3.5 Lightning) for everyday replies, or "super" (Nemotron 3.5 Super) for deeper reasoning. */
       tier?: "fast" | "super";
     }
     ```
   - Update the comment in `caddie/ai.ts` to document `tier: "super"` for deeper reasoning.
   - Run `bun scripts/refresh-scaffold-lock.ts` and verify `bun scripts/refresh-scaffold-lock.ts --check` exits 0.
3. **`apps/app/src/agents/specialists.ts` (`BUILD_RECIPE_INSTRUCTION`):**
   - Update the `c.env.CADDIE.ai` guidance to mention `tier?: "fast" | "super"` (*"omit `tier` for fast everyday replies on Nemotron 3.5 Lightning, or pass `tier: 'super'` on Nemotron 3.5 Super when a feature needs deeper reasoning or analysis"*).
4. **Update & Add Tests:**
   - `tests/providers.test.ts`: Assert `nemotron-3.5-super-vl` and `nemotron-3.5-lightning` are present in `MODEL_ROUTES`, update role expectations (`chat` → `nemotron-3.5-super-vl`, `helper` → `nemotron-3.5-lightning`, `app` → `nemotron-3.5-lightning`, `appSuper` → `nemotron-3.5-super-vl`, `plan` & `build` → `glm-5.3-flash`, `ideation` → `nemotron-3-ultra`, `vision` → `nemotron-3.5-super-vl`), and fix the stale test description on line 54.
   - `tests/attachments.test.ts`: Update expected `modelRouteId` for text turns (`nemotron-3.5-super-vl`) and image turns (`nemotron-3.5-super-vl`).
   - `tests/app-ai.test.ts`: Add tests verifying default/`tier: "fast"` calls `nvidia/Nemotron-3_5-Lightning`, `tier: "super"` calls `nvidia/Nemotron-3.5-Super-VL` with `max_tokens: 4096` and records `routeId = 'nemotron-3.5-super-vl'` in `app_ai_usage`, and invalid `tier` returns `invalid_request`.

---

### Packet H02: Finish & Merge `feat/publish-on-cloudflare` into `main`

1. **Verify All Publish Programme Stages (`docs/plans/2026-10-17-publish/README.md`):**
   - Stages 1 (Code store + Versions UI + working-copy restart + Start from my GitHub repo), 2 (Backend-ready stack), 3 (Worker Loader Previews + PreviewDatabase DO), 4 (Publish service + WfP adapter), 5 (Safety: URL Scanner + Web Risk + Report/Operator pages), 7 (App logins + preview test inbox), 8 (AES-256-GCM App Keys), and 9 (In-app AI `env.CADDIE.ai`) are implemented across migrations `0001`–`0031`.
   - Complete or cleanly fence Stage 6 (Custom Domains) if in flight.
2. **Run Full Local Gate:**
   ```sh
   bun scripts/refresh-scaffold-lock.ts --check
   bun run typecheck
   bun run build
   bun run test
   bun scripts/release-check.ts
   ```
3. **Merge `feat/publish-on-cloudflare` into `main`** cleanly.

---

### Packet H03: Close Implementation & Browser Test Sharp Edges

1. **Fix the `Stop build` Browser Test (`tests/browser/project-workflow.spec.ts`):**
   - Commit notes on `276828cb` and `baabbbf6` noted that the `Stop build` case in `tests/browser/project-workflow.spec.ts` failed since commit `99db7c55` (the one-bubble turn + plan-approval card redesign).
   - Run `bunx playwright test tests/browser/project-workflow.spec.ts`, inspect the selector/state mismatch on `Stop build`, and fix the test or component so all cases in `project-workflow.spec.ts` pass.
2. **Verify Stack Honesty & Spend/Allowance Copy:**
   - Confirm `apps/app/src/server/stacks.ts` exposes `react-hono` as the sole `enabled` stack and keeps `tanstack-start`, `laravel-inertia`, `fastapi-react`, and `flutter` as `planned` with "Notify me" (`B03`).
   - Confirm `Settings › Spending` and `AppAi.tsx` accurately describe the active controls (`BUILD_ACTION_BUDGET = 150` steps per build window, per-feature 3-strike repair limit, and per-project monthly AI allowance).

---

### Packet H04: Frictionless Hackathon Judge Access & Live Deployment (`P17`)

> **Critical Contest Rule (§Testing):** The deployed demo URL must be free, accessible without paywalls, and remain live throughout judging (**December 1–15, 2026**).

1. **Judge Access Mode (`apps/app/src/server/auth.ts`):**
   - Currently, if `INVITE_ALLOWLIST` blocks unlisted emails, judges signing in with their own Google/GitHub accounts receive `403 invite_required`.
   - Ensure judges can access the app seamlessly during the judging window via either:
     - An owner-configurable open sign-in mode (e.g., `OPEN_SIGNUP=1` or allowing authenticated Google/GitHub sign-ins when `INVITE_ALLOWLIST` is set to `*`, relying on per-run `BUILD_ACTION_BUDGET = 150` and per-project `APP_AI_MONTHLY_LIMIT_CENTS = 100` to cap spend per judge), **AND/OR**
     - A 1-click **Judge Demo Sign-In** / pre-seeded judge test credentials provided in the Devpost submission testing instructions.
2. **Production Cloudflare Deployment *(Requires Explicit Owner Authorization at Execution Time)*:**
   - Apply all D1 migrations (`0001`–`0031+`) to the production D1 database.
   - Configure production Worker secrets (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, Google/GitHub OAuth credentials, `NEBIUS_API_KEY`, `TAVILY_API_KEY`, `CONTREE_BASE_URL`, `CONTREE_API_TOKEN`, `CONTREE_PROJECT_ID`, `APP_SECRETS_KEYS`, `RESEND_API_KEY`, `RESEND_FROM`).
   - Deploy the composed Worker and run the hosted smoke suite:
     ```sh
     CADDIE_LIVE_AUTHORIZED=1 CADDIE_RELEASE_URL=<prod-url> bun run test:live -- P17
     ```
   - Record the `LIVE VERIFIED` receipt in `docs/release-evidence.md`.

---

### Packet H05: Root `LICENSE` (MIT) & Judge-Focused `README.md`

1. **Create `/LICENSE` (MIT License):**
   - Mandatory per Contest Rules §Submission (*"Open source license file visible at the top level of the repository"*). Currently missing at the root of `caddie-forge`.
2. **Create `/README.md` Designed for Stage One & Stage Two Judges:**
   - **Section 1 — Overview & The 5-Stage Loop (`Find → Plan → Build → Prove → Ship`):**
     - Explain how Caddie turns opportunity discovery, rules verification, PRD + visual screen mockup planning, isolated sandbox building, and one-click Cloudflare publishing into one evidence-backed workflow, illustrated with screenshots from `docs/reviews/screenshots-*`.
   - **Section 2 — How Caddie Uses Nebius Token Factory & NVIDIA Nemotron (Required by Rules):**
     - Include the **8-Role Multi-Model Routing Table** (`Nemotron 3 Ultra 550B` for ideation, `Nemotron 3.5 Super VL 120B` for Coordinator chat & multimodal vision, `Nemotron 3.5 Lightning 30B` for high-speed Tavily rule extraction, `GLM-5.3-Flash` for 32k-token PRD/design-mock & sandbox code emission, **plus dual-tier `Nemotron 3.5 Lightning` + `Nemotron 3.5 Super VL` inside every user-generated app via `env.CADDIE.ai`**).
     - Explain **Token Factory Sandboxes (Contree)** VM-isolated execution, image checkpointing, and the host-enforced feature loop (`build_next_feature` → `run_checks` → `finish_feature` requiring `passing > baseline` test progression → `verify_build` + Cloudflare `Worker Loader` `server-starts` check).
   - **Section 3 — How Caddie Uses Tavily ($3,000 Bonus Award Section):**
     - Document `apps/app/src/server/tavily.ts`, `discovery.ts`, and `rules-reading.ts`: live multi-platform sweep across Devpost, Devfolio, MLH, HackerEarth, DoraHacks, ETHGlobal, and Kaggle via Tavily `/search`, followed by full rules-page extraction via Tavily `/extract` into `Nemotron 3.5 Lightning` for verbatim quoted eligibility claims, plus the conversational `research` tool.
   - **Section 4 — Written Explanation of Significant Updates (Required by Rules §New & Existing Projects):**
     - Clear disclosure that while the original `caddie` concept was built for the Devpost Learn hackathon, `caddie-forge` is a ground-up October 2026 rebuild (31+ D1 migrations, 1,285+ passing tests) introducing Flue 2.2.2 Durable Objects, Nebius Token Factory multi-model routing (`Nemotron 3.5 Super VL`, `Nemotron 3.5 Lightning`, `Nemotron 3 Ultra`), Token Factory Sandboxes (Contree), Tavily primary discovery, Cloudflare Worker Loader full-stack previews, and one-click app publishing with built-in auth, D1, sealed secrets, and dual-tier AI.
   - **Section 5 — Local Setup & Verification Commands:**
     - Document `bun run typecheck`, `bun run build`, `bun run test`, `bun run verify:packet P00..P17`, and `bun scripts/release-check.ts`.

---

### Packet H06: Golden-Path Live Demo & <3-Minute Video Script (Oct 27–29)

Record a **2:45 YouTube video** (judges may stop at 3:00; audio must explicitly explain Nebius Token Factory, NVIDIA Nemotron 3.5/3.0, Token Factory Sandboxes, and Tavily):

1. **0:00 – 0:25 | Intro & Find (`Tavily` + `Nemotron 3.5 Lightning` & `Super VL`):**
   - Show the v2 workspace (`Brief · Discover · Projects` + persistent `Caddie` conversation). Ask Caddie to find AI hackathons. Show the live `HackathonResultsCard` (powered by Tavily `/search` + `/extract` and `Nemotron 3.5 Lightning` verbatim rule extraction) and open a contest's rules-first detail pane showing cited eligibility claims.
2. **0:25 – 0:55 | Brainstorm & Propose (`Nemotron 3 Ultra 550B`):**
   - Brainstorm an app idea for the hackathon (e.g., an AI app that uses both fast and deep AI tiers), and click **"Start this project"** on the `ProjectProposalCard`.
3. **0:55 – 1:30 | Comprehensive PRD & Interactive HTML Design Mocks (`GLM-5.3-Flash`):**
   - Review and approve the comprehensive PRD (data model, `/api/*` routes, `caddie-features` list).
   - Inspect the Designer's interactive ````html-mock` screen previews (`DesignMockPreview` across phone & desktop widths, empty/error states) and approve the design to start the build.
4. **1:30 – 2:10 | Autonomous Sandboxed Feature Loop (`Token Factory Contree Sandbox` + `Flue Specialists`):**
   - Show `FeatureChecklist` and `BuildProgress` as Caddie builds each feature in the Token Factory Contree sandbox, writes `.test.tsx` + Hono `/api/*` + D1 migrations, verifies growing test counts (`run_checks` → `finish_feature`), and passes the `server-starts` Cloudflare Worker Loader check (`verify_build`).
5. **2:10 – 2:45 | Live Full-Stack Preview, In-App Dual-Tier Nemotron AI & One-Click Publish:**
   - Interact with the working full-stack app inside the preview card (signing in via the preview test inbox, saving data to its preview D1 database, and triggering an in-app `env.CADDIE.ai` call powered by **Nemotron 3.5 Lightning / Super VL**).
   - Show the **Versions / Keys / Publish** controls and the **Judge Scorecard / Submission Package** readiness check.
