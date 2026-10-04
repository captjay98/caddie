# Caddie Forge Implementation Plan

> Execution workflow: use the writing-plans and subagent-driven-development skills. Implement the packets in `packets.md`, with independent specification review followed by code-quality review. User has already selected subagent-driven execution; do not ask them to select it again.

**Goal:** Build fresh Caddie: a persistent, evidence-backed assistant that discovers opportunities, plans projects, builds and repairs applications through Flue specialists, and prepares verifiable delivery/submission artifacts.

**Architecture:** One product application on Cloudflare Workers/Hono, Flue Durable Objects for agent execution, D1 for product state. React SPA with TanStack Router/Query and @flue/react; separate Astro static landing build. Narrow sandbox and external-effect adapters; no service per specialist or second workflow engine.

**Tech Stack:** Bun workspace tooling; TypeScript/React/Vite; Flue; Hono; Cloudflare Workers/DO/D1; Astro static; private object storage proposed as R2; Playwright and runtime-appropriate tests. Google and GitHub social sign-in, separate GitHub App repository access.

**Status:** PLAN ONLY. No app scaffolding, provider resource, deployment, repository fork, paid operation or data migration has been performed. Target folder `/Users/captjay98/projects/caddie-forge`. No deadline was supplied: gates determine ordering, not invented delivery dates.

## Authority and decisions

Human-confirmed on 2026-10-03: fresh repository named caddie-forge; product name Caddie; Flue; Workers+DO+D1; React SPA/Router/Query; Astro permitted for landing; GitHub+Google sign-in; solo owner aided by subagents. All five generated-app stacks remain in scope.

Precedence: latest human decisions → this plan's explicit scope/contracts → carryover audit → evaluation evidence. Old Caddie PAT/seeded-variant/one-stack-only/parallel-repair/hosting instructions are historical. Other agents' reports are evidence, not independent grants of authority.

Sources:
- `/Users/captjay98/projects/caddie/docs/flue-carryover-audit.md` and `flue-carryover-audit-feedback.md`.
- `/Users/captjay98/projects/nebius-forge-eval/adjudication/ADJUDICATION.md`, `evidence/flue-react.md`, `evidence/flue-deploy-mode.md`, Flue app and shared fixture.
- `/Users/captjay98/projects/hacksteward/docs/ux/2026-09-workspace-overhaul/reference-observations.md` and `docs/mockups-ops-workspace/today-ai-feature-map.md`: historical observations; private screenshots are not to be copied.
- Interaction-pattern inspiration is ALREADY captured in-repo: the two HackSteward reference docs above (authenticated-app observations) and the existing Caddie implementation (the design reference and benchmark for this build). Do NOT browse external sites (today.ai, deepseek.com) — their public pages add nothing beyond the in-repo references and browsing them is out of scope for all packets.

The evaluation established useful local workerd behavior and real provider experiments. Its single successful React send is not reconnect/failure coverage. A gate file is not human authorization. A local abort is not necessarily remote termination. Operational counters are not monetary reservations. These remain packet acceptance gates.

## User journey and complete scope

1. Sign in with either provider, pass invite gate, create a project or select an existing one. Start from an idea, opportunity, or selected GitHub repository (one repo/run, including monorepos).
2. Caddie gathers relevant profile/context, captures sources when contest-related, sharpens scope, and creates versioned scope/PRD/spec/design/acceptance artifacts. A project does not require a contest.
3. User selects one of five stacks and approves the design boundary. Review mode additionally pauses at feature gates; autonomous mode proceeds within approved boundaries. Both preserve explicit production/deletion/default-branch approval gates.
4. Coordinator delegates product, design, technical lead, frontend, backend, mobile and QA work. Roles use restricted tools and versioned skills, one conversation, one shared execution system.
5. Build in isolated sandbox; independent acceptance and browser checks; bounded repair; report real progress. Three unsuccessful repair attempts on the same issue pause. Retry, diagnosis and recovery do not count as repairs.
6. Inspect screenshots, private expiring preview, artifacts, diff, costs and checks. Steer or stop; resume without losing completed work. Deliver repository/PR with receipts and explicit approvals where required.
7. Sentinel monitors rules; scouting and reminders surface useful changes; Judge uses actual rubric and evidence. Submission package identifies missing fields and human attestations.

Five outputs: (1) React/Vite/TanStack Router+Query/Bun/Hono; (2) TanStack Start; (3) Laravel/React/Inertia; (4) FastAPI/React; (5) Flutter paired with a supported backend, with Android APK and emulator evidence. Prove #1 before activating others. Defer parallel repair branches, not stack scope.

Also required: persistent projects, GitHub App, private previews with revocation/expiry/sharing, demonstrably separate demo/live integrations, platform/BYOK payer binding and quotas, owner-only invite launch with team-ready data ownership. No native Caddie mobile app, arbitrary plugin marketplace, automatic final competition submission or legacy-user migration is silently added.

## Simple repository shape (proposed, not existing)

```text
apps/app/                  # generated Flue/Hono entry + React client
  src/app.ts               # authenticated route composition
  src/cloudflare.ts        # Flue-generated Workers entry, adapted minimally
  src/client/              # routes, query hooks, presentation
  src/agents/              # coordinator, specialist definitions, skills
  src/server/              # product services and external adapters
  migrations/              # ordered D1 product migrations
apps/site/                 # Astro static landing; no second application server
packages/contracts/        # shared serializable schemas/types only
packages/ui/               # tokens + a few actually shared primitives
stacks/                    # versioned output-stack recipes and fixtures
scripts/                   # build composition, verification, release evidence
 tests/                    # integration/browser fixtures and acceptance manifest
 docs/                     # decisions, feature ledger, evidence, runbook
```

Use concrete modules/functions; introduce interfaces at external boundaries only. Do not add generic repositories/services/event buses for every noun. No copied Python backend. Keep SQL portable where convenient, but prove D1 transactions/concurrency semantics rather than promising another runtime. Pin evaluated Flue package versions consistently (2.2.2 baseline) and record deliberate upgrade checks.

Astro emits static landing assets; app SPA lives under `/app`, APIs under `/api`, authenticated agent endpoints under `/agents`. P00 proves merging static outputs without asset collisions, SPA fallback swallowing API errors, or duplicate fetch handlers. A separate static deployment is a documented fallback if composition fails; it is not assumed to require an Astro SSR runtime. Preview content uses a separate origin without application cookies.

Auth implementation proposal: Better Auth, contingent on the P01 Workers+D1 adapter spike. Official social provider docs support Google/GitHub; this does not prove our integration. No custom password crypto. Account linking is explicit and authenticated, not automatic solely because emails match. Provider registration/domain values remain setup inputs.

## Design direction

Landing: PORT the existing Caddie landing design (READ-ONLY reference: `/Users/captjay98/projects/caddie/src/components/Landing.tsx` + the `.pb` style blocks in `src/styles/halo.css`) as the structure and visual identity — run-spine composition (hero with product captures + overlapping phone, act sections with sticky rail, honesty rails, the card, closing access board), halo tokens, amber action color, mono type, full-bleed 24px gutter. Update content for the fresh product: acts reflect the new journey (discover → build/Forge → deliver with evidence), copy matches feature-ledger availability (request access / invite-only until auth lands), and hero art uses clearly-labelled illustrative composition until real fresh-workspace captures exist (old screenshots are design reference, not new-build proof). Keep the invariants the P16 slices already proved: static-readable without client JS, reduced-motion, keyboard, mobile behavior, honest stack availability. Astro serves meaningful content without client JS.

App: Caddie's blue identity, warm readable light theme and dark alternative, Card/Tasks/Channel continuity, visible project/run context, collapsible detail. Today-inspired actionable editorial cards, genuine trade-off options, source/fact provenance, task-linked artifacts, Tasks/Scheduled toggle, scoped search, inline errors/limits, editable memory. Completed runs remain inspectable. No human-facing raw chain-of-thought; show concise progress and tool/verification evidence.

Suggested card contract (full schema in contracts.md): `kind`, `projectId`, `runId`, `headline`, `summary`, `evidenceIds`, `primaryAction`, `status`. UI must not parse display prose into authorization or repo identity.

## Critical path and independent lanes

| Wave | Ready work | Gate |
|---|---|---|
| 0 | P00 bootstrap/contracts/verification commands | Typecheck, build and routing smoke; ownership map frozen |
| 1 | P01 auth; P02 product model; P16 Astro with synthetic demo | No runtime effects yet; P01/P02 integration required |
| 2 | P03 approval/effects/budgets; P04 sandbox; P06 UI once auth/product contracts ready; P10 evidence | Provider calls remain disabled until P03 controls exist |
| 3 | P05 Flue integration; P07 previews; P08 GitHub | Each external boundary gets negative/recovery evidence |
| 4 | P09 first complete React/Hono journey | Install/build/test/injected repair/browser/preview/export/recovery/stop |
| 5 | P11 discovery; P12 Sentinel; P13 Judge; P14 memory/search/settings; P15a–d remaining stacks in readiness order | Do not enable unverified stacks; preserve full scope |
| 6 | P17 integration, deployment, release evidence | Hosted acceptance, operational recovery, full feature-ledger coverage |

P03 gates all paid/effectful work. Offline unit fixtures may run earlier; credentials plus positive budget and explicit test authorization are required for live probes. Dependencies in packets.md are authoritative over this overview. With four agent slots use coordinator + up to two disjoint implementers + reviewer as available; review independence matters more than filling slots. Repository coding agents are separate from Caddie's runtime specialists.

## Carryover and claims

Port unchanged only narrow tokens, Markdown wrapper, honest time helpers and pure receipt formatting. Adapt Card/Channel/Tasks, onboarding, artifacts and profiles. Adapt HackSteward evidence, approval, GitHub and submission invariants/tests. Rebuild auth, project scoping, execution, budgets and effects. Retire placeholder snapshots, optional owner parameters, user-wide latest-document queries, prompt-only approval, PATs, old runner, duplicate navigation and learner-only restrictions on autonomy.

Every audit row must appear in `docs/feature-ledger.md` with source path, disposition, destination, packet, evidence and availability. P00 imports this mapping; reviewers reject unmatched capability losses. Optional ideas remain explicitly optional.

## Acceptance and release discipline

Use LOCAL VERIFIED, LIVE VERIFIED, SIMULATED, DOCUMENTATION ONLY, BLOCKED, FAILED separately. Record command, exit, SHA, environment, version, artifact hash and test/provider receipt IDs. Claim no production readiness from a local build. No provider secrets or private reference screenshots in artifacts/logs.

P00 defines reproducible commands; packets give exact intended invocations. No command below exists or passes merely because it appears in this plan. Tests must fail for missing functionality; avoid scaffolding that produces vacuous green checks.

Final acceptance includes all five stacks, both sign-ins, two-user isolation across HTTP/agent streams/artifacts, import/new projects, restart during model/tool/effect, duplicate delivery, stale approvals, over-budget races, remote cancellation, preview expiry/revocation, mobile responsiveness and keyboard operation. Production/deletion/default-branch actions require concrete owner approval at execution time. Prepare release artifacts fully before asking.

## Inputs needed later, not blockers to writing this plan

No delivery deadline given. Before live setup: owner chooses application/preview domains, supplies OAuth/GitHub App registrations, Cloudflare/Nebius/Tavily credentials and explicit live-test budget. Email delivery provider is selected in P12 based on configured service; absence is a visible blocked integration. R2 is a proposed private artifact store to validate in P07. Commercial pricing/payment checkout is not specified: build entitlements and usage ledger without inventing subscriptions. New GitHub remote/visibility and final publication require their own concrete setup decision.

References checked 2026-10-03: [Astro static rendering](https://docs.astro.build/en/guides/on-demand-rendering/), [Google auth](https://better-auth.com/docs/authentication/google), [GitHub auth](https://better-auth.com/docs/authentication/github), [Better Auth D1 release source](https://github.com/better-auth/better-auth/blob/main/docs/content/blogs/1-5.mdx). Pin and verify actual installed APIs in P00/P01.
