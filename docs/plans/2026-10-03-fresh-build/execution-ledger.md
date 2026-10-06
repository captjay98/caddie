# Execution ledger

Status, evidence, review verdicts and integrated SHA. Planning-only rows say NOT STARTED.

| Packet | Status | Owner | Spec review | Quality review | Evidence / SHA |
|---|---|---|---|---|---|
| P00 | LOCAL VERIFIED | Integration lead (coordinator) | PASS | PASS (RECHECK: PASS after fixes) | 879e0f1 |
| P01 | LOCAL VERIFIED (real OAuth callbacks BLOCKED on owner credentials) | Backend identity engineer (subagent); integrated by lead | PASS | PASS (fixes applied: AUTH_TEST_MODE fence, dead helper removal, DDL-drift guard, log cleanup) | see evidence records (c41dc19 + integration b1b4d4e + review fixes) |
| P02 | LOCAL VERIFIED | Backend product engineer (subagent; slice 3 completed by lead after dispatch loss) | PASS | PASS (fixes applied + re-verified) | see evidence records (4a0eda2/66c2cf2/0ea748a + integration 801f97e + fixes 196ac63) |
| P03 | LOCAL VERIFIED (gate for ALL paid/effectful work — now open for local, closed for live until P04/P05 credentials) | Backend governance engineer (subagent); integrated by lead | PASS | PASS (P2 currency fence applied + re-verified) | see evidence records (164eace/0de2638/71f0a66 + integration ee5fca4 + fence fix) |
| P04 | LIVE VERIFIED (sandbox session + remote exec via contree CLI); REST adapter spellings need correction from live evidence | Sandbox engineer (subagent); integrated by lead | PASS | PASS (2 P2s fixed) | see evidence records + live probe |
| P05 | LIVE VERIFIED (model route: real Nebius completion 200 with usage) + LOCAL VERIFIED for everything else | Integration lead (quota window); specialist wiring from subagent scripts | FAIL→fixes applied→PASS | PENDING (quality re-dispatch after network outage) | see evidence records + 70131bf + live probe |
| P06 | LOCAL VERIFIED (transport wiring is P05's live acceptance) | Frontend engineer (subagent); integrated by lead | PASS | PASS | see evidence records (tokens port pulled forward to P16 | record) |
| P07 | IN PROGRESS (implementer dispatched; previews/artifacts) | Artifact engineer (subagent) | Pending | Pending | — |
| P08 | IN PROGRESS (implementer dispatched; GitHub App) | GitHub engineer (subagent) | Pending | Pending | — |
| P09 | PARTIAL — local scaffolding done; live journey BLOCKED on owner credentials | Integration lead | PENDING | PENDING | see evidence records |
| P10 | LOCAL VERIFIED (live external retrieval BLOCKED without owner authorization) | Evidence engineer (subagent); integrated by lead | PASS | PASS (2 P2s fixed on main) | see evidence records |
| P11 | NOT STARTED | Unassigned | Pending | Pending | — |
| P12 | LOCAL VERIFIED (real cron dispatch + real email BLOCKED: cron timer = P09/P17, SMTP = P17) | Scheduling engineer (subagent); integrated by lead | PENDING | PENDING | see evidence records |
| P13 | NOT STARTED | Unassigned | Pending | Pending | — |
| P14 | LOCAL VERIFIED | Full-stack product engineer (subagent); integrated by lead | PENDING | PENDING | see evidence records |
| P15a | LOCAL VERIFIED (template/recipe/skill scaffolding; live acceptance BLOCKED on P09 window) | Integration lead | PENDING | PENDING | see evidence records |
| P15b | LOCAL VERIFIED (scaffolding only; live acceptance BLOCKED on P09 window + PHP toolchain) | Integration lead | PENDING | PENDING | see evidence records |
| P15c | LOCAL VERIFIED (scaffolding only; live acceptance BLOCKED on P09 window + Python toolchain) | Integration lead | PENDING | PENDING | see evidence records |
| P15d | LOCAL VERIFIED (scaffolding only; live acceptance BLOCKED on P09 window + Android SDK/emulator) | Integration lead | PENDING | PENDING | see evidence records |
| P16 | LOCAL VERIFIED | Integration lead (rework; initial slices by subagent) | PENDING (quota — re-review when subagent dispatch returns) | PENDING (quota) | see evidence records (pit-board port per amendment 3054ee2) |
| P17 | PARTIAL — local harness LOCAL VERIFIED; hosted acceptance BLOCKED (needs all packets + live credentials + deployment authorization) | Integration lead | PENDING | PENDING | see evidence records |

## Evidence records

```json
{
  "packet": "P07+P08+P14 integration", "status": "ALL LOCAL VERIFIED", "sha": "see git log after 'fix: mount ALL missing routers'",
  "commands": [
    {"command": "bun run build", "exitCode": 0},
    {"command": "bun test tests/preview-access.integration.test.ts tests/github.integration.test.ts tests/memory.integration.test.ts tests/search-isolation.test.ts tests/schedules.integration.test.ts tests/sentinel.test.ts", "exitCode": 0, "receipt": "146 passed — P07 previews 19, P08 github 32, P14 memory+search 36, P12 schedules+sentinel 59"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "13 passed (composed worker with all routers)"},
    {"command": "bun run verify:packet P07", "exitCode": 0}, {"command": "bun run verify:packet P08", "exitCode": 0}, {"command": "bun run verify:packet P14", "exitCode": 0},
    {"command": "bun run typecheck", "exitCode": 0}
  ],
  "environment": "local workerd + D1",
  "providerCalls": "none",
  "specReview": "P14 SPEC REVIEW: FAIL (found profile router not mounted — integration gap); FIXED. P07/P08 spec reviews PENDING",
  "qualityReview": "P14 QUALITY REVIEW: PENDING. P07/P08 quality reviews PENDING",
  "limitations": [
    "P14 spec review noted: search scope (projects/planDocs/tasks/memory only — no messages/files/links/images tables exist yet), stacks panel hardcodes react-hono as 'enabled' (P09 PARTIAL), no payer/usage HTTP surface yet, Memory UI personal-only",
    "P08 noted: local D1 emulator INSERT ON CONFLICT bug → select-then-write guards; PR resume via provider lookup + already-exists 422; merge resume walks first-parent history",
    "P07 noted: markStaleForPlan is a system hook (P11 wires it); R2/preview origin are proposals"
  ]
}
```


```json
{
  "packet": "P12", "status": "LOCAL VERIFIED (real cron dispatch + real email BLOCKED on P09/P17 wiring)", "sha": "p12-impl merged + integration",
  "commands": [
    {"command": "bun run verify:packet P12", "exitCode": 0, "receipt": "2 checks PASS: schedules 44 + sentinel 15"},
    {"command": "bun test tests/schedules.integration.test.ts tests/sentinel.test.ts", "exitCode": 0, "receipt": "59 passed — DST cron math (fall-back/spring-forward through real workerd ICU), occurrence key idempotency, 75-min outage coalescing, cosmetic suppression, authority-severity, dedupe, failed mail leaves domain success intact, retry visible"},
    {"command": "bun test tests/auth+isolation+controls", "exitCode": 0, "receipt": "65 passed unchanged"},
    {"command": "bun run typecheck", "exitCode": 0},
    {"command": "bun run build", "exitCode": 0}
  ],
  "artifacts": [{"path": "apps/app/migrations/0007_schedules.sql", "note": "tasks, schedules, schedule_occurrences (unique key = idempotency core), sentinel_results, notifications (unique dedupeKey), notification_deliveries; additive; all per-project indexes lead with projectId"}],
  "environment": "local workerd + local D1 (miniflare); real Better Auth sessions",
  "providerCalls": "none",
  "specReview": "PENDING (queued)", "qualityReview": "PENDING (queued)",
  "limitations": [
    "real cron timer = P09/P17 (fixture /__test/tick is the stand-in; dispatchDueSchedules exported for the P09/P17 timer)",
    "SMTP driver = P17 (NoopMailer default; failed-mail retry-row tested)",
    "sentinel re-fetch/capture on a tick = P09/P17 (checks compare existing snapshots)",
    "weekly digest composition + HTML email template = P17"
  ]
}
```


```json
{
  "packet": "P04-live", "status": "LIVE VERIFIED (sandbox session + remote exec via contree CLI)", "sha": "main at live-probe time",
  "commands": [
    {"command": "contree -S p04-live-probe use tag:tt-base:1", "exitCode": 0},
    {"command": "contree -S p04-live-probe -o json run -- echo live-sandbox-ok", "exitCode": 0,
     "receipt": "uuid 01a111cb…, status SUCCESS, stdout 'live-sandbox-ok', exit_code 0, duration 6.9s — real remote execution in the TF sandbox"}
  ],
  "artifacts": [],
  "environment": "contree CLI 3.14 (owner-installed) against https://api.tokenfactory.nebius.com/sandboxes/ with CONTREE_* credentials from .dev.vars",
  "providerCalls": "contree sandbox session + one remote command",
  "limitations": [
    "P04 REST adapter endpoint spellings were ASSUMPTIONS — POST /v1/sessions returned 404; the real REST surface must be corrected from the CLI's wire traffic (the CLI itself talks REST to the same base)",
    "the CLI works from Bun locally; under deployed Workers the REST port is required (same API base, corrected spellings)",
    "the reference adjudication client used the CLI too (contree-async.ts) — no REST client existed in the evaluation either"
  ]
}
```

```json
{
  "packet": "P05-live", "status": "LIVE VERIFIED (model route round-trip)", "sha": "main at live-probe time",
  "commands": [
    {"command": "POST https://api.tokenfactory.nebius.com/v1/chat/completions (nvidia/nemotron-3-super-120b-a12b)", "exitCode": 0,
     "receipt": "status 200; content '4' (reasoning model, visible after reasoning); usage total_tokens recorded; NEBIUS_API_KEY from .dev.vars via aside provisioning"}
  ],
  "artifacts": [],
  "environment": "direct fetch to Nebius TF with owner credentials",
  "providerCalls": "two small completions (probe + probe with 512 tokens)",
  "limitations": [
    "this proves the MODEL ROUTE (provider, key, model id, pricing surface) — full agent round-trips through the Flue DO still need the dev server run (P09 live window)"
  ]
}
```


```json
{
  "packet": "P17", "status": "PARTIAL — local harness LOCAL VERIFIED; hosted acceptance BLOCKED", "sha": "ee48a50",
  "commands": [
    {"command": "bun scripts/release-check.ts", "exitCode": 1,
     "receipt": "honest: 17 PASS, 6 FAIL (in-flight/unstarted packets), 5 BLOCKED (live gates + deployment authorization); refuses a release request while anything fails"},
    {"command": "bun test tests/p09-local.test.ts", "exitCode": 0, "receipt": "4 passed (regression check in p17 worktree)"}
  ],
  "artifacts": [
    {"path": "scripts/release-check.ts", "note": "full local gate: typecheck, build, all 21 packet verifications, live gates BLOCKED, deployment always owner-gated"},
    {"path": "docs/runbooks/operations.md", "note": "verification loop, evidence rules, recovery rules, deployment gates in order"},
    {"path": ".github/workflows/ci.yml", "note": "CI: build + typecheck + all packet verifications; live gates report BLOCKED without failing the build"}
  ],
  "environment": "local bun",
  "providerCalls": "none",
  "specReview": "PENDING (packet partially complete — remaining work gated on other packets landing)",
  "qualityReview": "PENDING",
  "limitations": [
    "release-check honestly reports 6 FAILs: P07/P08 in flight, P11/P13 not yet started",
    "hosted acceptance, staging deployment, hosted 2-user tests, backups/restore, logs redaction review — all BLOCKED on credentials + deployment authorization",
    "D1 migration numbering skips 0003 until P07 lands (append-only respected)"
  ]
}
```


```json
{
  "packet": "P15a-d", "status": "LOCAL VERIFIED — scaffolding only; live acceptance BLOCKED on P09 window + toolchains (PHP/Python/Flutter+Android SDK)", "sha": "5374d88 + merge 188755f",
  "commands": [
    {"command": "bun test tests/p15a-local.test.ts tests/p15bcd-local.test.ts", "exitCode": 0, "receipt": "14 passed — all 4 recipes validate against frozen StackRecipeSchema (availability=unverified), templates complete, skills carry their disciplines (disposable test DB for Laravel, uv sync --frozen + no wildcard CORS for FastAPI, real device evidence for Flutter), flutter defaults to Hono backend with android-emulator preview"},
    {"command": "bun run typecheck", "exitCode": 0}
  ],
  "artifacts": [{"path": "stacks/", "note": "react-hono (P09), tanstack-start (P15a), laravel-inertia/fastapi-react/flutter (P15b/c/d) recipes + template manifests + agent skills"}],
  "environment": "local bun; templates NOT executed (toolchains not provisioned)",
  "providerCalls": "none",
  "specReview": "PENDING", "qualityReview": "PENDING",
  "limitations": [
    "LIVE acceptance BLOCKED for all stacks: needs the P09 live window (sandbox + model credentials) AND per-stack toolchains in the sandbox (PHP/Composer+npm for 15b, uv/Python for 15c, Flutter SDK+Android emulator for 15d)",
    "templates are structural manifests, not executed apps — first live install/build/start happens in the sandbox",
    "flutter Android evidence additionally needs an emulator (available locally via tooling; not yet wired to the journey)"
  ]
}
```


```json
{
  "packet": "P09", "status": "PARTIAL — local scaffolding LOCAL VERIFIED; live journey BLOCKED on owner credentials", "sha": "merge of p09-journey + fixture self-install fix",
  "commands": [
    {"command": "bun test tests/p09-local.test.ts", "exitCode": 0, "receipt": "4 passed — manifest valid with protected paths; fixture complete and its own tests pass (self-installs deps on fresh clone); recipe validates against frozen StackRecipeSchema with availability=unverified; journey runner fails honestly BLOCKED without credentials (never fakes a run)"},
    {"command": "bun run verify:packet P09", "exitCode": 0, "receipt": "1 check PASS"}
  ],
  "artifacts": [
    {"path": "tests/acceptance/manifest.json", "note": "immutable evaluator contract with phases (install/seeded-tests-green/build/deliberate-red/server-start/browser-check) and repair policy"},
    {"path": "tests/fixtures/forge-task-tracker/", "note": "standalone fixture app (Hono API + tests) with seeded baseline"},
    {"path": "stacks/react-hono/recipe.ts", "note": "frozen StackRecipe, commands curated"},
    {"path": "scripts/run-journey.ts", "note": "journey harness: verifies manifest+fixture hashes, fails BLOCKED without credentials, never fakes"}
  ],
  "environment": "local bun",
  "providerCalls": "none",
  "specReview": "PENDING (packet partially complete)",
  "qualityReview": "PENDING",
  "limitations": [
    "LIVE journey execution BLOCKED: requires CADDIE_LIVE_AUTHORIZED=1, CONTREE_* sandbox credentials, NEBIUS_API_KEY",
    "remaining P09 work (journey phases, repair injection, browser proof against sandboxed server, cost/latency recording) executes in the live window"
  ]
}
```


```json
{
  "packet": "P05-spec-review-fixes", "status": "FIXES APPLIED", "sha": "70131bf",
  "sourceReview": "SPEC REVIEW: FAIL (independent reviewer found 8 gaps; all locally provable)",
  "fixes": [
    "coordinator used a stub findModelRoute (bisect leftover) — restored real frozen-route registry; provider registration now called at startup",
    "conversation middleware read c.req.param under a '*' wildcard (always undefined → 404 for every request) — now derives conversationId from the path and writes the run's plan revision into the cache",
    "useSandbox declared via sandboxFromDriver adapter over the P04 session driver (FileStat/SandboxFactory shapes matched to runtime types)",
    "operation keys were random per call (attempt IDs) — now deterministic SHA-256 of the logical action",
    "sandbox_exec could write protected paths via shell redirection — commands now scanned with mentionsProtectedPath (includes-based, bias-to-blocking) before dispatch",
    "record_acceptance was a self-report channel — now requires the operationKey of the producing sandbox_exec; gate records without one are not acceptance evidence",
    "gate ledger semantics aligned with the D1 evaluator: latest-per-check wins (append order), corrupt lines skipped, missing operationKey refused"
  ],
  "commands": [
    {"command": "bun test tests/agent-permissions.test.ts", "exitCode": 0, "receipt": "24 passed (added: gate needs operationKey, latest-per-check, exec path scan, benign command passes)"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "13 passed"},
    {"command": "bunx playwright test tests/browser/conversation.spec.ts", "exitCode": 0, "receipt": "3 passed"},
    {"command": "bun run typecheck", "exitCode": 0},
    {"command": "bun run build", "exitCode": 0}
  ],
  "limitations": [
    "verifyExecution cross-check of operationKey against persisted ops requires the D1-backed persistence port (P09); the key requirement is enforced, the cross-check is the P09 wiring",
    "full gate ledger lives in the sandbox; D1 mirror (run_verifications) is the product-side log — P09 wires the reconciliation"
  ]
}
```


```json
{
  "packet": "P05", "status": "LOCAL VERIFIED (live model round-trips BLOCKED on NEBIUS_API_KEY)", "sha": "74c613b + integration b074a29",
  "commands": [
    {"command": "bun test tests/agent-permissions.test.ts", "exitCode": 0, "receipt": "20 passed — permission matrix (QA holds no write tools; every policy name is a known tool), protected-path guard refuses driver calls, skill hash integrity, completion gate (no record / failing record / stale revision all refuse; corrupt line skipped; latest-per-check wins), run lifecycle (frozen route fails closed on unknown; 3 failed repairs pause with diagnosis exempt; completion needs machine-checked evidence under current revision; cross-project snapshot 404)"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "13 passed (worker boots with FlueCoordinatorAgent DO)"},
    {"command": "bunx playwright test tests/browser/conversation.spec.ts", "exitCode": 0, "receipt": "3 passed — standby channel honest, draft key stable across retry, drafts survive reload"},
    {"command": "bun run test:live -- P05", "exitCode": 1, "receipt": "BLOCKED: requires CADDIE_LIVE_AUTHORIZED=1 + NEBIUS_API_KEY (spec fails clearly, never silently)"},
    {"command": "bun run typecheck", "exitCode": 0},
    {"command": "bun run build", "exitCode": 0, "receipt": "worker boots with FlueCoordinatorAgent; SPA composed"}
  ],
  "artifacts": [{"path": "apps/app/src/agents/", "note": "coordinator.ts (use agent; completion gate via useAgentFinish reading .caddie/gates ledger), specialists.ts (7 roles, no model on definitions), permissions.ts (role policy + protected paths), tools.ts (Valibot schemas), skills.ts (hash-verified ?raw), providers.ts (Nebius compat block, frozen routes)"}],
  "environment": "local workerd; no model calls (all provider interaction BLOCKED)",
  "providerCalls": "none",
  "specReview": "PENDING (queued for next dispatch window)",
  "qualityReview": "PENDING (queued)",
  "limitations": [
    "PLAN DRIFT: packets.md lists coordinator.tsx/specialists.tsx — the flue plugin scans .ts/.mts only, so agent modules are .ts (renamed; no JSX was used)",
    "PLAN DRIFT: conversation.spec.ts was P06-listed; delivered under P05 as the shared conversation-surface file (transport acceptance items remain in tests/live/flue-lifecycle.spec.ts)",
    "coordinator context uses InMemorySandboxPersistence per isolate — D1-backed port + real revision cache are P09 wiring; agent runs fail closed without CONTREE_* env",
    "DecisionCard onAction is unwired (no transport produces cards yet) — P05/P09 wiring",
    "repair delegation records round starts; outcome reporting path is P09"
  ]
}
```


```json
{
  "packet": "P03", "status": "LOCAL VERIFIED", "sha": "71f0a66 + integration ee5fca4 + currency fence",
  "commands": [
    {"command": "bun run verify:packet P03", "exitCode": 0, "receipt": "2 checks PASS: controls 23 + budget-races 7"},
    {"command": "bun test tests/controls.integration.test.ts", "exitCode": 0,
     "receipt": "23 passed — stale/expired/revoked/wrong-actor/wrong-project approvals rejected AT EFFECT TIME with distinct codes and ZERO provider invocations (D1-counted fake); duplicate operationKey 409; reconciliation-required + late-receipt reconcile; agent bridge request/read only (no decide route exists, DB-truth pending rows)"},
    {"command": "bun test tests/budget-races.integration.test.ts", "exitCode": 0,
     "receipt": "7 passed — contracts.md race proven: limit 100, two simultaneous 70-unit HTTP reserves, exactly 1×200 + 1×402 budget_exceeded, row-sum 70, 3 rounds, real workerd D1 (trigger-guarded INSERT, no JS mutex); settle idempotent; unknown pricing fails closed; cancelled run stays reserved"},
    {"command": "bun test tests/project-isolation.integration.test.ts tests/auth.integration.test.ts", "exitCode": 0, "receipt": "42 passed unchanged"},
    {"command": "bun run typecheck", "exitCode": 0}
  ],
  "artifacts": [{"path": "apps/app/migrations/0002_controls.sql", "note": "approvals (partial unique index on pending intentHash), external_operations (unique operationKey), budget_payers/pricing/reservations + budget_reservations_cap_guard trigger (server-side atomicity), credential_handles (fingerprints only)"}],
  "environment": "local workerd + local D1 (miniflare); provider is a counting fake in fixtures — zero-call proofs are about the GATE, not about any real provider",
  "providerCalls": "none",
  "specReview": "PASS (independent subagent; 8 acceptance items incl. independent bun:sqlite reproduction of the cap trigger)",
  "qualityReview": "PASS (independent subagent; P2 fixed: currency change refused while reservations outstanding — fence + re-verified 30/30; P3s noted: reservationKey-duplicate error precedence, safe-integer uniformity, concurrent-receipt idempotent branch, release/settle window honesty, substring error classification, date-affinity nits, expired-pending refresh behavior documented)",
  "limitations": [
    "credentials.ts is a REDACTION-ONLY placeholder: fingerprints + envelope marker, no encryption at rest, no reveal path (module-surface test proves no secret export) — real envelope encryption/rotation lands with P04/P08 usage; classified DOCUMENTATION ONLY for encryption-at-rest",
    "agent-bridge request/read is FK-validity-only; agent identity binding to run scopes arrives with P05",
    "budget cap = outstanding-liability cap; period/billing-window accounting is P05 run accounting",
    "race proven on local workerd D1 (SQLite serialization); hosted-D1 reproduction is P17 staged work"
  ]
}
```


```json
{
  "packet": "P02", "status": "LOCAL VERIFIED", "sha": "0ea748a + integration 801f97e + review fixes 196ac63",
  "commands": [
    {"command": "bun run verify:packet P02", "exitCode": 0, "receipt": "27 test(s) passed"},
    {"command": "bun test tests/project-isolation.integration.test.ts", "exitCode": 0,
     "receipt": "27 passed — two-user isolation (list/read/update/archive/plan-docs/run-bindings/artifacts) with database-truth assertions; A/B latest-plan-doc independence; missing-scope throw; 401/403 route mapping; run-binding stored-project lookups; duplicate runId typed 409; identity-DDL drift guard"},
    {"command": "bun test tests/auth.integration.test.ts", "exitCode": 0, "receipt": "15 passed (identity untouched, drift guard intact)"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "13 passed (incl. new composed-worker /api/projects 401 probe)"},
    {"command": "bun run typecheck", "exitCode": 0},
    {"command": "bun run build", "exitCode": 0}
  ],
  "artifacts": [{"path": "apps/app/migrations/0001_product.sql", "note": "product tables appended after IDENTITY-DDL-BOUNDARY: workspaces, workspace_memberships, projects (nullable contest link), project_repo_bindings, plan_doc_revisions, run_bindings, artifact_revisions; additive; identity section drift-guarded"}],
  "environment": "local workerd + local SQLite-backed D1 (miniflare), bun 1.4.0",
  "providerCalls": "none (stub OAuth in-process — SIMULATED at provider boundary)",
  "specReview": "PASS (independent subagent; 7 acceptance items verified incl. built-worker spot-check of the projects mount)",
  "qualityReview": "PASS (independent subagent; P2s fixed: malformed JSON now 400 invalid_input, workspaceId validated 400 before scope derivation; P3s fixed: atomic workspace+membership via db.batch, duplicate-runId 409 test, composed-worker probe, stale comments; P3s noted: 409 message embeds constraint text, DDL splitter is fixture-only, plan-doc latest without kind spans incomparable counters — documented in route)",
  "limitations": [
    "session.ts plan-slot note also applies to P02 file-list drift handling (lead-owned ledgers updated instead of editing packets.md)",
    "plan-doc latest without ?kind= compares per-kind counters; clients should pass kind (documented in route)"
  ]
}
```


```json
{
  "packet": "P00", "status": "LOCAL VERIFIED", "sha": "879e0f1",
  "commands": [
    {"command": "bun run build", "exitCode": 0},
    {"command": "bun run verify:packet P00", "exitCode": 0,
     "receipt": "contracts: 11 tests passed; routing: 12 tests passed"},
    {"command": "bun run typecheck", "exitCode": 0},
    {"command": "bun run verify:packet P07", "exitCode": 1,
     "receipt": "honest failure: MISSING tests/preview-access.integration.test.ts"},
    {"command": "bun run verify:packet P99", "exitCode": 1,
     "receipt": "honest failure: unknown packet"},
    {"command": "bun run test:live -- P04", "exitCode": 1,
     "receipt": "BLOCKED without CADDIE_LIVE_AUTHORIZED=1"}
  ],
  "artifacts": [{"path": "apps/app/dist/composition-manifest.json",
                 "note": "collisions: [], spa.scanned/landing.scanned > 0 asserted by tests/routing.test.ts"}],
  "environment": "local workerd via `vite preview` (miniflare), bun 1.4.0, node v26.3.0, macOS arm64; @flue/* 2.2.2 pinned, @cloudflare/vite-plugin 1.39.2, vite 8.0.14, wrangler 4.113.0",
  "providerCalls": "none",
  "specReview": "PASS (independent subagent; 9 acceptance items verified incl. live HTTP spot-checks)",
  "qualityReview": "PASS (independent subagent; 8 findings fixed and RECHECK: PASS)",
  "limitations": [
    "browser/live tests not applicable to P00 (test:browser -- P00 reports NOT APPLICABLE, exit 0)",
    "agents mount but do not execute under the preview harness (flue 2.2.2 startActiveSpan bug — documented in docs/flue-contracts.md); agent execution evidence belongs to P05",
    "landing assets resolution loop becomes meaningful in P16"
  ]
}
```

```json
{
  "packet": "P01", "status": "LOCAL VERIFIED — real OAuth callbacks BLOCKED on owner credentials", "sha": "c41dc19 (branch), integrated b1b4d4e",
  "commands": [
    {"command": "bun test tests/auth.integration.test.ts", "exitCode": 0,
     "receipt": "14 passed — real workerd + local D1 + in-process stub provider; forged-state/replay, session fixation/expiry/logout, invite allowlist both ways, explicit linking preserves identity, GitHub scopes read:user user:email asserted"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "12 passed with auth router mounted (post-integration)"},
    {"command": "bunx playwright test tests/browser/auth.spec.ts", "exitCode": 0, "receipt": "2 passed — sign-in buttons render, error state visible"},
    {"command": "bun run verify:packet P01", "exitCode": 0, "receipt": "14 test(s) passed"},
    {"command": "bun run typecheck", "exitCode": 0}
  ],
  "artifacts": [{"path": "apps/app/migrations/0001_product.sql", "note": "identity tables = Better Auth 1.7.7 migrator output, byte-matched to tests/fixtures/auth-schema.sql"}],
  "environment": "local workerd + local D1 (miniflare), better-auth 1.7.7 (Kysely adapter on D1 binding)",
  "providerCalls": "none (stub provider inside workerd — OAuth boundary SIMULATED)",
  "specReview": "PASS (independent subagent; 8 acceptance items verified; noted: session.ts plan-slot not materialized — mechanics live in auth.ts; forged-state test cannot attribute rejection to state-validation specifically; empty-allowlist fail-closed documented but untested; staging verification owed when credentials arrive)",
  "qualityReview": "PASS (independent subagent; P2 fixed: test-only env knobs now require AUTH_TEST_MODE=1 or createAuth throws; P3s fixed: dead mount helpers removed, DDL-drift guard added, /tmp log cleanup; P3s noted: app.ts typing honesty kept as deployment contract, browser error-path env-sensitivity acknowledged, emailVerified hardening deferred to P02/P03 authorization work)",
  "limitations": [
    "SPIKE PASSED: Better Auth 1.7.7 accepts the D1 binding directly (bundled Kysely adapter); documented at better-auth.com/docs/concepts/database",
    "PLAN DRIFT (recorded, packets.md is owner-amended only): packets.md P01 file list names src/server/session.ts; session mechanics live in auth.ts instead — feature-ledger C18 destination updated to match reality",
    "session secret is dedicated BETTER_AUTH_SECRET — audit defect #5 (derive-from-model-key) verified absent",
    "real Google/GitHub callbacks BLOCKED pending owner-provided OAuth registrations + BETTER_AUTH_URL; callback URLs documented in docs/setup/auth.md",
    "lead integration diff (b1b4d4e): auth router mounted at /api, SignInPanel in SPA scaffold, identity DDL seeded into 0001_product.sql"
  ]
}
```

```json
{
  "packet": "P16", "status": "LOCAL VERIFIED (rework per amendment 3054ee2)", "sha": "see git log feat(p16): port pit-board landing",
  "commands": [
    {"command": "bun run build", "exitCode": 0},
    {"command": "bunx playwright test tests/browser/landing.spec.ts", "exitCode": 0, "receipt": "13 passed — pit-board structure, amber kickers rgb(240,168,60), honesty band, stackgrid disclosure, availability honesty, invariants (static-readable/no scripts, reduced-motion w/ control, keyboard/skip, 390px sections-in-viewport, metadata/no external URLs)"},
    {"command": "bun test tests/routing.test.ts", "exitCode": 0, "receipt": "12 passed"},
    {"command": "bun run typecheck", "exitCode": 0},
    {"command": "typography slice (owner-directed): @fontsource/inter 400-700 + @fontsource/ibm-plex-mono 400/500 added to apps/site, imported in index.astro, bundled by Vite", "exitCode": 0,
     "receipt": "38 woff2 subset files in dist/_astro, zero external font URLs; document.fonts.check true for Inter 400/600 + Plex Mono 400/500; computed h1 = Inter 600, letterSpacing -3.08px (-0.035em), lineHeight 1.050; visual comparison vs caddie/docs/screens/landing-pitboard-top.png and landing-run-spine.png confirms tight-and-confident h1, legible 9px mono at 390px, visible 550/700 weight steps; port bug found+fixed: .pb had no base font-family (serif fallback) — font-family: var(--font-ui) added; reference mobile single-CTA rule ported (quiet topbar link hidden <=640px)"}
  ],
  "artifacts": [{"path": "apps/site/dist/index.html", "note": "pit-board port: run-spine (6 acts, sticky rail), honesty rails, card band, stacks band, request-access close; zero <script> tags; mailto placeholder marked in shipped HTML"},
                {"path": "apps/site/dist/_astro/*.woff2", "note": "38 self-hosted font subsets (Inter 400/500/600/700, IBM Plex Mono 400/500) — no runtime font fetches"}],
  "environment": "local workerd via vite preview (playwright webServer), chromium; composed build; @caddie/ui halo tokens",
  "providerCalls": "none",
  "specReview": "PENDING — independent reviewers blocked by provider rate limit (resets 2026-10-10); re-review scheduled",
  "qualityReview": "PENDING — same",
  "limitations": [
    "AMENDMENT 3054ee2 SUPERSESSION: the atmospheric-blue landing (merged earlier same-day) is replaced by this pit-board port; blue site token set retired",
    "DEPENDENCY AMENDMENT: halo token port (packages/ui/src/tokens.css) pulled forward from P06 — feature-ledger row C1 updated; P06 still owns Markdown.tsx, time.ts and app-side verification",
    "reveal-on-scroll/scroll-spy from the reference intentionally NOT ported (client JS) — static readability without scripts is an acceptance invariant",
    "mailto contact uses placeholder hello@example.com — OWNER INPUT needed before public deployment (marked in shipped HTML)",
    "hero art is illustrative composition (plan amendment) — real captures require a real accepted build (P09)"
  ]
}
```
