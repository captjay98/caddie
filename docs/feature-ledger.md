# Caddie feature ledger

Imported in P00 from every row of the carryover audit
(`/Users/captjay98/projects/caddie/docs/flue-carryover-audit.md`, 2026-10-03)
and its post-adjudication companion
(`flue-carryover-audit-feedback.md`). Every audit row appears here with
source, disposition, destination, owning packet, evidence basis, and
availability. Reviewers reject unmatched capability losses; a DROP removes an
implementation, never an agreed capability.

Dispositions: PORT AS-IS · ADAPT · IMPROVE · REBUILD · DROP · OPTIONAL
(feedback amendments noted inline). Availability: `available` (evidence
exists), `planned` (packet owns it; not built yet), `optional` (explicit
product decision required).

Evidence bases: AUDIT = carryover audit; FB = audit feedback (post-adjudication
amendments); ADJ = `nebius-forge-eval/adjudication/ADJUDICATION.md` +
`evidence/*` (live/local verification of Flue behaviors); LOCAL P00 = this
repository's P00 verification.

## Caddie inventory rows

| # | Area | Disposition | Destination | Packet | Evidence | Availability |
|---|------|-------------|-------------|--------|----------|--------------|
| C1 | Halo identity, dark/light colors, typography, status colors | PORT AS-IS selectively | `packages/ui/src/tokens.css` | P06 | AUDIT (token blocks in `src/styles/halo.css`) | planned |
| C2 | Markdown rendering | PORT AS-IS | `packages/ui/src/Markdown.tsx` | P06 | AUDIT (`src/components/Markdown.tsx`) | planned |
| C3 | Honest time formatting | PORT AS-IS | `packages/ui/src/time.ts` | P06 | AUDIT (`src/lib/format.ts`) | planned |
| C4 | Brand voice, compact status grammar (`CADDIE_SYSTEM`) | PORT AS-IS as editorial guidance | Coordinator instruction | P05 | AUDIT (`src/lib/llm.ts`); no Google-only wiring | planned |
| C5 | Card + Channel, mobile bottom nav, task lane | ADAPT (FB: expect route/data layer to change shape — server fns → Hono REST + Query) | `apps/app/src/client/workspace/`, `conversation/` | P06 | AUDIT + FB shell amendment | planned |
| C6 | Card visual primitives | ADAPT / IMPROVE — typed payloads, never parse prose for data/authorization | `apps/app/src/client/brief/` | P06 | AUDIT defect #3 class; DecisionCard contract in `packages/contracts` | planned (schema available, LOCAL P00) |
| C7 | Chat rendering and tool banners | FB amendment: transport ADOPT @flue/react; ADAPT presentation | `apps/app/src/client/conversation/` | P06 | ADJ `evidence/flue-react.md` (LIVE VERIFIED status lifecycle, typed parts, settlements, failed-send retry) | planned (transport decision closed) |
| C8 | Profile: experience, hours, location, stack chips | ADAPT / IMPROVE — structured model, stack IDs distinct from free text | `apps/app/src/server/profiles.ts`, onboarding UI | P14 | AUDIT | planned |
| C9 | Multiple contests / "bags" | REBUILD data model; ADAPT interaction — workspace→project→runs, optional contest, A/B isolation | `apps/app/migrations/0001_product.sql`, `src/server/projects.ts` | P02 | AUDIT defect #2 (latest-per-user query must not travel) | planned |
| C10 | Devpost discovery and weekly picks | IMPROVE — validated candidate IDs, intent-aware ranking, visible partial failures | `src/server/discovery.ts` | P11 | AUDIT (`discover.ts`, `scout.ts`) | planned |
| C11 | Rules capture and pinned claims | REBUILD using HackSteward concepts — immutable snapshot, locator/quote, freshness | `src/server/evidence/*` | P10 | AUDIT defect #1 (claims→marker snapshot) | planned |
| C12 | Sentinel / rules recheck | IMPROVE — normalized claim diff, project/source binding, noise suppression | `src/server/sentinel.ts` | P12 | AUDIT | planned |
| C13 | Idea kernel, scope, PRD, spec, plan viewer | ADAPT / IMPROVE — versioned revisions, approval bound to revision, partial edits | `src/server/artifacts.ts`, `client/planning/` | P07 (+P11) | AUDIT | planned |
| C14 | Six Devpost Learn skills | ADAPT content; DROP incompatible learner-pause policy | `src/agents/skills/` versioned Flue skills | P05 | AUDIT + FB (skills mechanism verified: `useSkill`/`activate_skill` reach subagents) | planned |
| C15 | Judge scorecard | IMPROVE — actual rubric/weights, artifact-backed, structured schema | `src/server/judge.ts`, `client/judge/` | P13 | AUDIT | planned |
| C16 | Submission checklist | REBUILD rules derivation — project/contest-specific, citations, unknowns stay unknown | `src/server/submission.ts` | P13 | AUDIT (hardcoded video/repo rules must not travel) | planned |
| C17 | GitHub repository creation / docs export | REBUILD adapter; ADAPT journey — GitHub App, selected repo, atomic bundles, receipts | `src/server/adapters/github.ts`, `repositories.ts` | P08 | AUDIT (single-PAT file-by-file writes retired) | planned |
| C18 | Authentication and password recovery | REBUILD — Better Auth on Workers+D1, dedicated secrets, explicit linking | `src/server/auth.ts`, `routes/auth.ts`, `session.ts` | P01 | AUDIT defect #5 (session key from LLM key must not travel); P01 spike gates the choice | planned |
| C19 | Task runner and scheduled jobs | REBUILD — Flue machinery (leases, alarms) + app-owned schedule/operation records | `src/server/tasks.ts`, `schedules.ts` | P12 | AUDIT + FB (durable cross-process abort LIVE VERIFIED, `evidence/flue-deploy-mode.md`) | planned |
| C20 | Email and digests | ADAPT / IMPROVE — escaped templates, opt-in, dedupe, delivery receipts | `src/server/notifications.ts` | P12 | AUDIT | planned (email provider chosen in P12) |
| C21 | Landing page | ADAPT — fresh claims only, synthetic demo until real evidence | `apps/site/src/pages/` | P16 | AUDIT | planned (P00 scaffold LOCAL P00) |
| C22 | Existing SQL migrations, destructive reset, "latest per user" queries | DROP implementation | — (fresh D1 schema; explicit import mapping only if later requested) | — | AUDIT; no-migration stance FB item 7 | dropped (capability retained via C9 rebuild) |

## HackSteward recovery rows

| # | Capability | Disposition | Destination | Packet | Evidence | Availability |
|---|------------|-------------|-------------|--------|----------|--------------|
| H1 | Source snapshots, citations, claim history, conflicts | ADAPT — high priority; one authority vocabulary | `src/server/evidence/{sources,claims,authority}.ts` | P10 | AUDIT (`domain/evidence.py` etc.) | planned |
| H2 | Deadline normalization | ADAPT / IMPROVE — missing timezone/time stays ambiguous | `src/server/evidence/deadlines.ts` | P10 | AUDIT (`domain/deadlines.py` + fixtures; midnight assumption corrected) | planned |
| H3 | Eligibility matching | ADAPT / IMPROVE — unknown for unsupported, fit never overrides hard restriction | `src/server/eligibility.ts` | P11 | AUDIT (`domain/eligibility_rules.py`) | planned |
| H4 | Durable revision-bound approvals | ADAPT — foundational; FB: write-path gate + `useAgentFinish` refusal, both live-tested | `src/server/approvals.ts`, migration 0002 | P03 | AUDIT + ADJ (durable record checked at write path; blocked run honestly FAILED) | planned (schema available, LOCAL P00) |
| H5 | External-action receipts, ambiguous outcomes | ADAPT — foundational; stay narrow, no second workflow engine | `src/server/operations.ts` | P03 | AUDIT + FB (neither framework is exactly-once; keyed/idempotent reconciliation mandatory) | planned (schema available, LOCAL P00) |
| H6 | GitHub App adapter behavior/tests | ADAPT — high priority; durable dedupe replaces in-process cache | `src/server/adapters/github.ts` | P08 | AUDIT (`adapters/github_rest.py` + tests) | planned |
| H7 | Source registry and evidence inspector UI | ADAPT — embed in project details | `src/client/evidence/Drawer.tsx` | P10 | AUDIT | planned |
| H8 | Human-readable receipt formatting | PORT AS-IS selectively — pure helpers, display only | `packages/ui` (display), receipts model P03 | P03/P06 | AUDIT (`receipt_inspect.tsx` helpers + tests) | planned |
| H9 | Workspace companion ergonomics | ADAPT selected behavior — keep Caddie's simpler shell | `apps/app/src/client/workspace/Shell.tsx` | P06 | AUDIT (`two_pane_shell.tsx`) | planned |
| H10 | Living builder memory | ADAPT / IMPROVE — inspect/correct/delete; proposed vs confirmed | `src/server/memory.ts` | P14 | AUDIT (`steward_memory.py`) | planned |
| H11 | Submission preparation, missing-field handling | ADAPT / IMPROVE — high value; derive from actual requirements | `src/server/submission.ts` | P13 | AUDIT (`submission_preparation.py`) | planned |
| H12 | Submission handoff | ADAPT contract; browser automation OPTIONAL | copy/export package first | P13 | AUDIT (`browser_handoff.py`); populated ≠ submitted | planned / optional |
| H13 | Strategy, effort, capacity, risk, critical path | ADAPT selectively — labeled heuristics, no win probabilities | `src/server/planning.ts` | P11 | AUDIT (`strategy_calculation.py`) | planned |
| H14 | Outcomes and learning after judging | OPTIONAL | compact outcome record | P13 (later) | AUDIT (`domain/outcomes.py`) | optional |
| H15 | Model routing | ADAPT policy/tests — bound to Flue provider route, payer; fail closed on fallback | `src/agents/providers.ts`, run bindings | P05 | AUDIT (`model_routing.py`) + FB (Nebius compat block) | planned |
| H16 | Billing entitlements | ADAPT vocabulary only; REBUILD spend accounting | `src/server/budgets.ts` | P03 | AUDIT; subscriptions ≠ per-run reservations | planned |
| H17 | Native mobile UI (Caddie companion) | OPTIONAL reference — not auto-ported; Flutter output stack is separate scope | — | — | AUDIT | optional |
| H18 | Generated clients and contract tests | ADAPT practice — share types directly | `packages/contracts` | P00/P02 | AUDIT; LOCAL P00 (frozen schemas + tests) | available |
| H19 | Backend worker, custom workflow state machine, deployment stack | DROP implementation | — (Flue is the runtime; business state stays app-owned) | — | AUDIT + FB | dropped |
| H20 | Overlapping pages, competition-specific playbooks | DROP duplication / rewrite useful actions as skills | — | P05 | AUDIT | dropped |
| H21 | Old agent scaffolding, generated repository guides | DROP wholesale copying | — (fresh `AGENTS.md`, reviewed skill content only) | P00 | AUDIT; LOCAL P00 (`AGENTS.md` written fresh) | available |

## Decisions settled post-audit (feedback) — carried into P00

| Decision | Disposition | Destination | Evidence | Availability |
|----------|-------------|-------------|----------|--------------|
| Hosting: Workers + DO + D1, single flavor; portability rules for a Node flavor | SETTLED | `apps/app`, `docs/flue-contracts.md` | FB item 1; ADJ deploy-mode (DO crash recovery LIVE VERIFIED) | available (P00 generates this shape) |
| Product UI: no TanStack Start; React SPA + Router/Query on the Flue Hono worker | SETTLED | `apps/app/src/client` | FB item 2 | available (P00 composes SPA under /app, LOCAL P00) |
| Chat transport: @flue/react | SETTLED (amends C7) | P06 | ADJ `evidence/flue-react.md` | decision available; integration P06 |
| Day-one carry-ins: self-report-never-success invariant; Flue contract lessons; harness assets (async contree client, rounds ledger, manifest tooling, seed-and-accept, browser check, journey runner) | SETTLED | `AGENTS.md`, `docs/flue-contracts.md`, later packets | FB item 4; ADJ | lessons documented (LOCAL P00); code assets per packet |
| Contree REST sandbox client for Workers (CLI cannot spawn under workerd) | SETTLED | P04 | FB item 5; one endpoint live-verified via fetch | planned (P04) |

## Defects that must not travel (audit #1–#7)

Tracked as constraints on the owning packets: #1 claims→marker snapshot (P10),
#2 user-level latest-document queries (P02), #3 optional owner / silent no-op
success (P02/P12 — scope mandatory in service signatures), #4 prompt-only
approval (P03/P08 — execution-side checks), #5 auth coupled to model key
(P01), #6 contradictory authority mapping (P10 — one shared vocabulary),
#7 helpers advertised as full capabilities (P04/P08 — honest capability
boundaries). Each packet's acceptance must show the invariant holding.

## Supported stack availability (frozen scope)

| Stack | ID | Status |
|---|---|---|
| React/Vite/TanStack Router+Query + Bun/Hono | `react-hono` | proving first (P09 gate) |
| TanStack Start | `tanstack-start` | planned (P15a) |
| Laravel + React/Inertia | `laravel-inertia` | planned (P15b) |
| FastAPI + React | `fastapi-react` | planned (P15c) |
| Flutter + supported backend | `flutter` | planned (P15d) |

Stacks activate only after their own gate; `unverified` is the default in
every recipe until then.
