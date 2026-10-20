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

> **Availability reconciliation (2026-10-16).** The `Availability` column in the
> two inventory tables below (C1–C22, H1–H21) is the state **as imported at P00
> on 2026-10-03** and is now largely stale: a row reading `planned` there whose
> owning packet is LOCAL/LIVE VERIFIED in
> `docs/plans/2026-10-03-fresh-build/execution-ledger.md` is **available today**.
> All 21 packets (P00–P17) are implemented and integrated; the authoritative,
> current availability is the per-packet status table in the execution ledger
> plus the dated wave sections lower in this file. Concretely, every row whose
> packet is one of P01/P02/P03/P05/P06/P07/P08/P10/P11/P12/P13/P14/P16 is
> **available (LOCAL VERIFIED)**; P09 stack #1 is **available (LIVE VERIFIED)**;
> rows marked DROP/OPTIONAL keep that disposition. The original `planned`
> labels are retained below only as P00-import provenance — do not read them as
> current. The dated sections ("Caddie v2 redesign wave", "UI overhaul waves"
> via the execution ledger, and "2026-10-07..15 discovery/model/chat/project
> wave" below) carry the real evidence.

## Caddie inventory rows

| # | Area | Disposition | Destination | Packet | Evidence | Availability |
|---|------|-------------|-------------|--------|----------|--------------|
| C1 | Halo identity, dark/light colors, typography, status colors | PORT AS-IS selectively | `packages/ui/src/tokens.css` | P06 (tokens ported early via P16 amendment 3054ee2) | AUDIT (token blocks in `src/styles/halo.css`); LOCAL P16 (tokens live on the landing) | available (Markdown/time remain P06) |
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
| C21 | Landing page | ADAPT — pit-board port of the reference design (amendment 3054ee2); fresh claims only, synthetic demo until real evidence | `apps/site/src/pages/` | P16 | AUDIT + plan amendment | available (LOCAL P16: 13 browser checks) |
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

## Caddie v2 redesign wave (2026-10-10, packets U01–U10 + B01–B06)

Source: `docs/design/2026-10-10-v2/` (owner-reviewed prototype). Additions to
the product surface, all LOCAL VERIFIED:

| Capability | Status | Evidence |
|---|---|---|
| Resizable Caddie panel (fraction-persisted, ARIA separator, keyboard) | LOCAL VERIFIED | tests/browser/shell-v2.spec.ts (13) |
| Viewport bands: mobile / tablet overlay / desktop two-panel | LOCAL VERIFIED | shell-v2 + workspace specs |
| Mobile tabs Caddie·Brief·Discover·Projects + Ask bar | LOCAL VERIFIED | shell-v2 (U02 tests) |
| "Talking about" scope switch (Everything + projects) | LOCAL VERIFIED (filtering semantics; threads verified per-scope in B05) | shell-v2 (U02 tests) |
| Character (8 moods, real-state mapping, reduced-motion static) | LOCAL VERIFIED | tests/browser/states.spec.ts (7) |
| v2 Brief (≤3 cards, deadline rows, Done fold) | LOCAL VERIFIED | tests/browser/brief.spec.ts (14) |
| v2 Discover (For you/Saved, can't-enter reveal, plain verdicts) | LOCAL VERIFIED | tests/browser/discovery.spec.ts (11) |
| Two-step explore-ideas (no project before confirm) | LOCAL VERIFIED | discovery + journey specs |
| v2 Projects cards (step text from real brief cards, archived fold, import window) | LOCAL VERIFIED | tests/browser/projects-v2.spec.ts (6) |
| Overview next-step / app-so-far / to-dos / recent fold | LOCAL VERIFIED | tests/browser/project-v2.spec.ts (13) |
| Plan decision bar + approve window with real spend cap + suggest-a-change | LOCAL VERIFIED | project-v2 + artifacts specs |
| Build tabs Activity/Files, builds as sentences, change-request → chat draft | LOCAL VERIFIED | project-v2 + workspace specs |
| Check page (N of M ready, hand-in list, judges, proof drawer, personal variant) | LOCAL VERIFIED | tests/browser/check-v2.spec.ts (4) |
| Submit: video-link draft + "I've submitted" window (never submits) | LOCAL VERIFIED | tests/browser/submission.spec.ts (6) |
| Settings 8 tabs + Project settings (new route, typed-name archive) | LOCAL VERIFIED | settings + project-settings specs (13) |
| ⌘K quick search + results page (chips, highlights, 5/page, recents) | LOCAL VERIFIED | tests/browser/search.spec.ts (3) |
| Welcome intro (mood lines, username rule, saved name) | LOCAL VERIFIED | tests/browser/onboarding-v2.spec.ts (3) |
| Landing refinement (plain steps, Your brief, ledger-faithful stack statuses, theme sharing) | LOCAL VERIFIED | tests/browser/landing.spec.ts (16) |
| Saved hackathons (B01) | LOCAL VERIFIED | tests/discovery-saved.integration.test.ts (4) |
| Search: hackathon section (B02) | LOCAL VERIFIED | tests/search-isolation.test.ts (14) |
| Message search over chats (B02 part 2) | BLOCKED | Flue stream store lives inside the agent DO; no cross-DO query surface. Client says "Chats aren't searched yet" |
| Stack notify subscriptions + enable-flip notification (B03) | LOCAL VERIFIED | tests/stack-notify.integration.test.ts (4) |
| Plan decisions per revision (B04) | LOCAL VERIFIED | tests/plan-decisions.integration.test.ts (5) |
| Per-scope chat threads (B05) | VERIFIED (pre-existing; pinned) | tests/conversation-scope.test.ts (4) |
| In-chat spend approval card (B06) | LOCAL VERIFIED | tests/approval-card.test.ts (4) |

Migrations added (append-only, every harness + inline test list updated):
0013_discovery_saved, 0014_stack_notify, 0015_plan_decisions.

## 2026-10-07..15 — discovery / model / chat / project waves

Owner-directed work after the v2 redesign wave, on `main`. All LOCAL VERIFIED
(typecheck 0, build 0 collisions, named test receipts) unless marked; no deploys
and no paid calls beyond the already-recorded guarded live probes. The appended
D1 migrations (append-only; every fixture harness now derives its list from the
filesystem via `tests/fixtures/migrations.ts`, so no harness can drift again):

| # | Migration | What it backs |
|---|-----------|---------------|
| 0016 | `0016_onboarding.sql` | onboarding capture (minimal first-run) |
| 0017 | `0017_profile_preferences.sql` | profile preferences (CL1–CL4 "Caddie learns you") |
| 0018 | `0018_build_workflow.sql` | build workflow + brief column read by the Build/runs surface |
| 0019 | `0019_github_project_repo.sql` | linked project repo + join-progress |
| 0020 | `0020_discovery_digest_cache.sql` | cached per-candidate AI digest (rules-first detail pane) |
| 0021 | `0021_project_proposals.sql` | propose-then-confirm project proposals |
| 0022 | `0022_build_activity.sql` | build activity feed (project page "what Caddie is doing now") |

| Capability | Status | Evidence |
|---|---|---|
| Tavily as the REQUIRED PRIMARY discovery source + NVIDIA Nemotron model tiers | LIVE VERIFIED | execution ledger P11 (guarded Tavily/Devpost probe, 15 real contests); commit `06c85528` |
| Devpost API primary + quoted-rule eligibility + AI fit | LOCAL VERIFIED | commit `1d51a831` |
| Image attachments + voice input; image turns routed to the served Token Factory VLM (gemma-3-27b-it) | LIVE VERIFIED (model id confirmed served via GET /v1/models + probe) | commits `980f9029`, `2be6354f`, `f5126af9`; lesson in learned-corrections |
| Text-file attachments delivered to Caddie as fenced blocks | LOCAL VERIFIED | commit `247ae683` |
| Model routing: planning on ultra, building moved to glm-5.3-flash, vision on glm-5.3-flash | LOCAL VERIFIED | commits `b595b7be`, `ed1fd326`, `03c7591c`, `c204611f` |
| Hackathon results card + rules-first detail pane with cached AI digest; follow-ups read the stored checked detail | LOCAL VERIFIED | commits `eca3f5e9`, `ef30534a`, `87fa5fae` |
| Discovery returns results without waiting for the digest pre-warm (237s → 38s) | LOCAL VERIFIED | commit `ec3a0832` |
| Persistent adaptive home header; theme picker (palettes + light/dark) | LOCAL VERIFIED | commits `ffda52fd`, `0196f4fa` |
| Shared InterestPicker (open to anything); settings redesign (one header, grouped sections) | LOCAL VERIFIED | commits `7e63f5b3`, `2671c63e` |
| Slower ideation on ultra; project page non-technical users understand; project page redesigned around "what Caddie is doing now" | LOCAL VERIFIED | commits `c4865abd`, `b37b0aa6`, `5a3fbed3` |
| Server-side coordinator dispatch forwards worker bindings; coordinator message posted in Flue's flat wire shape | LOCAL VERIFIED | commits `0edd26a4`, `5fc7f8f7` |
| Bound search-path requests + explain stopped turns in chat | LOCAL VERIFIED | commit `9c42be11` |

Security/correctness pass (2026-10-16, independent review): four P1s fixed —
Resend key threaded from the Worker `env` (was `process.env`, dead in prod);
email recipient resolved from the session user's own verified address (open mail
relay closed); `/agents/hello` guarded + off the hardcoded Anthropic model;
`mentionsProtectedPath` matches a path with or without a trailing slash. Two red
mapped tests (P12 schedules, P11 eligibility) fixed at root — fixture migration
lists now derive from the filesystem. Pre-existing `coordinator-context` test
("CHECKED verdict / rulesRead") fixed by scoping an authoritative eligibility
claim to its own candidate (or a standalone rules host) rather than every
candidate in the project. Full unit suite **1054 pass / 0 fail**.

Live-test fixes and Track 3 integration (2026-10-20, merged on `main`): the
owner's live walkthrough findings landed on `fix/live-test-findings`
(`e70e534`, plan `docs/plans/2026-10-20-live-test-fixes.md`) and were merged at
`afeebad` together with the two earlier chat-limit and idle-status fixes; Track 3
Android apps (`feat/track3-flutter`, `2d176fa`, plan
`docs/plans/2026-10-19-pwa-flutter-apk-monetization-plan.md`) were merged after
it. Everything below is LOCAL VERIFIED (fixture, stub or local workerd) unless a
row says otherwise; provider behaviour at the edges is SIMULATED; no deploy and
no paid call beyond the recorded phase 9 probes.

| Capability | Status | Evidence |
|---|---|---|
| A message reads "Sending…" then "Not sent" (with the server's own reason, e.g. a judge limit), never duplicated and never shown as a second copy | LOCAL VERIFIED | commits on `fix/live-test-findings`; `tests/browser/conversation.spec.ts`, `tests/send-failure.test.ts` |
| Replies read as prose: neighbouring text parts joined; a tool call written as text is explained, never rendered as the proposal itself | LOCAL VERIFIED | conversation UI + coordinator instructions; `tests/browser/conversation.spec.ts` |
| One build record: the "paused" brief, both Stop buttons, the Build tab and the chat card agree; check history is sentences, counts are per attempt | LOCAL VERIFIED | plan 3.1–3.6; build-workflow/build-timeline tests, `tests/browser/project-workflow.spec.ts` |
| Plans use the platform's AI, the hackathon's quoted rules and the person's own words (`requiredTech`, `audience`, `problem`; migrations 0036/0037) | LOCAL VERIFIED | proposals/coordinator + `tests/project-proposals.test.ts` |
| Polish wave: styled workspace gate, one shared split sign-in, page-shaped skeletons, plain-words "Details", project card variants B+C | LOCAL VERIFIED | plan 5.1–5.7; browser specs |
| GitHub connects in one click, and an installation can only be bound by the GitHub account that owns it (both routes fail closed) | LOCAL VERIFIED; GitHub/OAuth SIMULATED | `tests/github.integration.test.ts` on local workerd (45 pass, incl. both exploit paths) |
| Memory learns: project chats keep project facts, a stated lasting preference is offered once for confirmation, and what waits appears under the message (also when a model proposes it after the turn) | LOCAL VERIFIED | plan 6.2; `tests/stated-preference.test.ts`, memory browser spec |
| Memory offers keep the order they were written, even when two arrive in the same millisecond (ordering was by random id, so the chat's order drifted) | LOCAL VERIFIED | fixed in `stated-preference.ts` (`rowid` tiebreak); deterministic regression in `tests/stated-preference.test.ts` |
| Track 3 Android apps: Flutter scaffold + locked installs, Flutter web preview, stack-aware build loop, the APK as a non-blocking native check | LOCAL VERIFIED | `stacks/flutter/`, `tests/flutter-*.test.ts`, `tests/android-app.test.ts` |
| The APK is built and read back inside the production Flutter sandbox image | LIVE VERIFIED | phase 9.2 probe: 14,884,096 bytes, sha256 `5631cde4…0c53f4`; evidence `docs/evidence/2026-10-20-kiro-integration/` |
| Download and publish an Android app: private 30-minute link, QR, published download page carrying the APK hash/size/API base | LOCAL VERIFIED; hosting SIMULATED | `tests/browser/project-workflow.spec.ts`, publish/page tests |
| Flutter's never-landed migrations renumbered to 0038/0039 so 0036/0037 keep their meanings | LOCAL VERIFIED | all 39 migrations apply in order to a fresh local D1 |
