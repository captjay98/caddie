# Implementation packets

All files below are proposed relative to `/Users/captjay98/projects/caddie-forge`. No scripts or APIs are claimed to exist yet. The integration lead alone edits root manifests/lockfiles, shared contracts, route registration, DO class migrations and assigns D1 migration numbers. Other agents propose changes to these files; they do not race on them.

## Required task procedure

Each packet is split into the numbered slices below. For each slice: (a) add one meaningful failing behavior test (2–5 minute action), (b) run it and inspect the failure, (c) implement the smallest contract-preserving increment, (d) run the focused test/typecheck and inspect the diff, (e) record receipt and commit only owned files on its task branch. Repeat for additional behavior, not superficial line coverage. Visual-only reversible changes use browser verification rather than contrived unit tests. A packet can take multiple sessions; these action sizes are not promises about total duration.

Commands established by P00: `bun run verify:packet Pxx` runs listed tests with correct unit/workerd/browser harness and fails if none found; `bun run typecheck`; `bun run build`; `bun run test:live -- Pxx` fails clearly without required env instead of silently passing/skipping; `bun run test:browser -- Pxx`. Live invocation also requires authorized budget/environment/recipient. Pin command mapping in `scripts/verify-packet.ts`; default verification never deploys or spends.

Expected sequence for each behavior: RED for the intended missing invariant → PASS after implementation → independent spec review → independent code-quality review → integrated affected tests. Reviewer must not accept a mocked provider test as LIVE VERIFIED. Representative contracts/test examples are in contracts.md.

Commit procedure: `git diff --check`, inspect `git diff`, stage named owned paths only, then `git commit -m "feat(scope): description"`. Dirty source repositories are read-only references. Integration lead resolves conflicts and records final integrated SHA.

## P00 — Bootstrap and freeze shared contracts

**Owner:** Integration lead. **Dependencies:** None.

**Create/modify:**
- `package.json`
- `bun.lock`
- `AGENTS.md`
- `apps/app/src/app.ts`
- `apps/app/src/cloudflare.ts`
- `apps/app/vite.config.ts`
- `apps/app/wrangler.jsonc`
- `apps/site/astro.config.mjs`
- `packages/contracts/src/index.ts`
- `scripts/verify-packet.ts`
- `scripts/compose-assets.ts`
- `docs/feature-ledger.md`
- `docs/flue-contracts.md`

**Tests:** `tests/routing.test.ts`, `tests/contracts.test.ts`.

1. Generate the pinned Flue Cloudflare shape into the fresh repo; copy no legacy git history or environment files. Integrate React client under /app and a minimal Astro static page at /.
2. Freeze scope/run/artifact/approval/stack contracts from contracts.md; assign migration ownership and create package scripts, including packet verifier mappings to actual tests.
3. Populate feature ledger from every audit row, supported-stack availability and source provenance. Record evaluated Flue API lessons and exact lockfile versions.

**Acceptance:** One fetch entry handles auth/API/agents and assets correctly. /app deep links work; unknown /api is JSON 404, not index.html; Astro and SPA assets do not overwrite one another. Clean install/typecheck/build succeed. No fake verification success when tests are absent.

**Verify:** `bun run verify:packet P00` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P00` / `bun run test:live -- P00` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p00): bootstrap and freeze shared contracts` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P01 — Google and GitHub authentication

**Owner:** Backend identity. **Dependencies:** P00.

**Create/modify:**
- `apps/app/src/server/auth.ts`
- `apps/app/src/server/routes/auth.ts`
- `apps/app/src/server/session.ts`
- `apps/app/src/client/auth.ts`
- `tests/fixtures/auth.ts`
- `docs/setup/auth.md`

**Tests:** `tests/auth.integration.test.ts`, `tests/browser/auth.spec.ts`.

1. Validate and pin Better Auth Workers+D1 integration in a minimal local workerd fixture. Register social providers through library APIs; use dedicated secrets and explicit base URL.
2. Implement invite allowlist, provider-subject identity, logout/revocation and explicit signed-in linking. Do not automatically merge identities by email. GitHub sign-in must grant no repo access.
3. Add both sign-in buttons and visible error/retry states. Document exact callback URLs and credential setup without collecting secrets in chat.

**Acceptance:** Forged state/replayed callback rejected; session fixation/expiry/logout tested; uninvited user denied; explicit link of second provider preserves identity. Test both real OAuth callbacks in staging when credentials exist; mocks remain SIMULATED.

**Verify:** `bun run verify:packet P01` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P01` / `bun run test:live -- P01` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p01): google and github authentication` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P02 — Projects, scoped persistence and artifacts

**Owner:** Backend product. **Dependencies:** P00.

**Create/modify:**
- `apps/app/src/server/scope.ts`
- `apps/app/src/server/projects.ts`
- `apps/app/src/server/routes/projects.ts`
- `apps/app/migrations/0001_product.sql`
- `packages/contracts/src/projects.ts`

**Tests:** `tests/project-isolation.integration.test.ts`.

1. Create users/workspaces/memberships/projects/project-repo bindings/run bindings/artifact revisions. Align auth-owned tables with P01 via integrator; no duplicate identity table model.
2. Require explicit authenticated scope for every request. Bind delayed work to immutable stored scope; never infer active project at execution.
3. Implement project CRUD/archive, optional contest link, revisioned plan metadata, run lookup and conversation binding with server-derived identifiers.

**Acceptance:** Two users/two projects cannot list/read/update/archive each other records, artifact metadata or run identifiers. Project A/B switching never mixes latest plan docs. Missing scope throws rather than silently returning success. Integrate P01 session guard before exposing endpoints.

**Verify:** `bun run verify:packet P02` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P02` / `bun run test:live -- P02` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p02): projects, scoped persistence and artifacts` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P03 — Approvals, external effects and persistent spending

**Owner:** Backend governance. **Dependencies:** P01, P02.

**Create/modify:**
- `apps/app/src/server/approvals.ts`
- `apps/app/src/server/operations.ts`
- `apps/app/src/server/budgets.ts`
- `apps/app/src/server/credentials.ts`
- `apps/app/src/server/routes/approvals.ts`
- `apps/app/migrations/0002_controls.sql`

**Tests:** `tests/controls.integration.test.ts`, `tests/budget-races.integration.test.ts`.

1. Translate exact-revision approval invariants. Authenticated user endpoint records decision; agent tools can request/read only. Recheck actor scope, expiry, revocation and intent hash immediately before effect.
2. Implement unique operation key, provider receipt and reconciliation-required outcome. Distinguish pending remote operation from cancelled agent. No second workflow/lease framework.
3. Implement atomic reserve/settle/release, payer/model/pricing binding, encrypted BYOK handles and redaction. Prove D1 conditional updates; use one payer-scoped DO only if needed for atomicity, with explicit authority/reconciliation design.

**Acceptance:** Self/stale/cross-project/expired approval rejected; duplicate effect intents reconcile. Simultaneous reservations cannot exceed cap; restart and duplicate usage settlement cannot double-debit. Unknown provider usage retains liability until reconciled. Transport retries cannot change payer; unauthorized model fallback fails closed. No real paid model/sandbox call before this gate.

**Verify:** `bun run verify:packet P03` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P03` / `bun run test:live -- P03` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p03): approvals, external effects and persistent spending` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P04 — Workers-native sandbox adapter

**Owner:** Sandbox engineer. **Dependencies:** P00; P03 before live calls.

**Create/modify:**
- `apps/app/src/server/adapters/sandbox.ts`
- `apps/app/src/server/adapters/contree.ts`
- `tests/fixtures/sandbox.ts`
- `docs/setup/sandbox.md`

**Tests:** `tests/sandbox.contract.test.ts`, `tests/live/sandbox.spec.ts`.

1. Port asynchronous semantics to fetch REST: create session, upload files, exec, query status, cancel operation, checkpoint, export, dispose. Persist remote operation identity and session binding before exposing completion.
2. Use timeout/cancel propagation plus reconciliation for ambiguous dispatch. Reject traversal/symlink escapes, enforce output/time quotas and isolation; do not inject platform credentials into generated code.
3. Probe from workerd and staging Worker with bounded authorized budget: restart during exec, remote cancellation marker, session loss and export. Record API limitations without guessing endpoint behavior.

**Acceptance:** Actual cancel receipt or status proves remote termination; otherwise show pending/unknown. Marker after cancelled command stays absent. SIGKILL/retry cannot silently duplicate consequential operations. Loss of sandbox preserves exported artifacts and honest resumability. No CLI subprocess dependency under Workers.

**Verify:** `bun run verify:packet P04` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P04` / `bun run test:live -- P04` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p04): workers-native sandbox adapter` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P05 — Flue coordinator, specialists and skills

**Owner:** Agent-runtime engineer. **Dependencies:** P01, P02, P03, P04.

**Create/modify:**
- `apps/app/src/agents/coordinator.tsx`
- `apps/app/src/agents/specialists.tsx`
- `apps/app/src/agents/providers.ts`
- `apps/app/src/agents/tools.ts`
- `apps/app/src/server/runs.ts`
- `apps/app/src/server/routes/runs.ts`
- `apps/app/src/agents/skills/manifest.json`

**Tests:** `tests/agent-permissions.test.ts`, `tests/live/flue-lifecycle.spec.ts`.

1. Register Nebius provider with evaluated compatibility options; freeze exact model route/pricing per run. Register project conversation behind authenticated membership checks before generated agent router and stream endpoints.
2. Implement seven restricted specialist definitions: product, designer, tech lead, frontend, backend, mobile, QA. Activate versioned hashed skills through actual Flue mechanism; load only required context.
3. Bind authenticated design approval, review/autonomous policy, repair ledger, steering and completion hook to trusted acceptance evidence. Keep last good checkpoint; reject stale tool results after cancellation or plan revision.

**Acceptance:** Each specialist actually delegates/activates required skill with correct permissions; QA cannot overwrite protected checks. Runtime restart settles same work without duplicated product actions. Three failed repairs on same issue pause; diagnosis/transport/recovery separate. Browser reconnect/duplicate send and unauthorized stream access tested. Failed completion cannot claim success.

**Verify:** `bun run verify:packet P05` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P05` / `bun run test:live -- P05` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p05): flue coordinator, specialists and skills` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P06 — Workspace shell and typed conversation UI

**Owner:** Frontend engineer. **Dependencies:** P00, P01, P02; P05 for live acceptance.

**Create/modify:**
- `packages/ui/src/tokens.css`
- `packages/ui/src/Markdown.tsx`
- `packages/ui/src/time.ts`
- `apps/app/src/client/routes.tsx`
- `apps/app/src/client/workspace/Shell.tsx`
- `apps/app/src/client/conversation/Channel.tsx`
- `apps/app/src/client/brief/DecisionCard.tsx`
- `apps/app/src/client/runs/RunInspector.tsx`

**Tests:** `tests/browser/workspace.spec.ts`, `tests/browser/conversation.spec.ts`.

1. Port selective tokens/Markdown/time helpers; adapt responsive Card/Tasks/Channel and project selector. Render explicit loading/empty/stale/denied/offline/error/cancelled/limit states.
2. Use @flue/react for transport and typed tool/file parts. Keep transport status separate from durable business outcome; optimistic sends retain retry/idempotency key. Render trusted card union, artifacts and specialist summaries.
3. Add needs-you/changed/handled brief, trade-off options, provenance links, inspectable completed runs and cost/details disclosure. Avoid raw reasoning display and prose-derived IDs.

**Acceptance:** Keyboard/focus, 390px/768px/1440px, light/dark, reduced motion verified. Refresh retains selected project/run. Failed send retry creates one submission. Stop state does not become success on late output. No cross-account cached query/chat leakage.

**Verify:** `bun run verify:packet P06` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P06` / `bun run test:live -- P06` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p06): workspace shell and typed conversation ui` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P07 — Versioned plans, artifacts and private previews

**Owner:** Artifact/preview engineer. **Dependencies:** P02, P03, P04; P06 for browser acceptance.

**Create/modify:**
- `apps/app/src/server/artifacts.ts`
- `apps/app/src/server/previews.ts`
- `apps/app/src/server/routes/artifacts.ts`
- `apps/app/src/server/routes/previews.ts`
- `apps/app/src/client/artifacts/Viewer.tsx`
- `apps/app/src/client/planning/DesignReview.tsx`
- `apps/app/migrations/0003_artifacts.sql`

**Tests:** `tests/preview-access.integration.test.ts`, `tests/browser/artifacts.spec.ts`, `tests/live/preview.spec.ts`.

1. Store immutable scope/PRD/spec/design revisions, hashes and acceptance inputs; allow partial revision with diff, approval invalidation and export.
2. Validate private object store (proposed R2); preserve test/browser/diff/export artifacts after sandbox disposal. Download URLs require scoped authorization and safe content disposition.
3. Create private managed preview gateway on isolated origin. Enforce expiry/revoke/share on HTML/assets/WebSockets; raw upstream is not public bypass. Show exact build revision, last good preview and integration demo/live labels.

**Acceptance:** Two users denied each other artifacts/previews; token expiry/revoke works on all routes; generated JS cannot read Caddie cookies. Changed plan invalidates approval. Preview unavailable is explicit, no dead success URL. If upstream cannot be protected, gate that stack preview until a supported private host is implemented.

**Verify:** `bun run verify:packet P07` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P07` / `bun run test:live -- P07` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p07): versioned plans, artifacts and private previews` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P08 — GitHub App import and receipt-backed delivery

**Owner:** GitHub integration engineer. **Dependencies:** P01, P02, P03, P04.

**Create/modify:**
- `apps/app/src/server/adapters/github.ts`
- `apps/app/src/server/repositories.ts`
- `apps/app/src/server/routes/github.ts`
- `apps/app/src/client/repositories/RepositoryPicker.tsx`
- `docs/setup/github-app.md`

**Tests:** `tests/github.integration.test.ts`, `tests/live/github.spec.ts`.

1. Bind installation and selected repositories to workspace; verify install callbacks/webhook signatures and revocation. Keep OAuth identity separate from repo authorization.
2. Import selected commit and monorepo root through server boundary; allow only selected repo content. Safe handling of symlinks/submodules/untrusted instructions; no credential-bearing git config in sandbox.
3. Export verified patch to feature branch, atomic commit/PR where supported; reconcile timeout by operation key/branch/head. Prepare production/default-branch effects but execute only with exact approval.

**Acceptance:** Replay creates one logical PR; existing branch divergence produces reviewable conflict, not overwrite. Installation removal denies future operations. Two-user repo isolation and imported-existing-app behavior proven. Preserve unrelated source files and never force-push.

**Verify:** `bun run verify:packet P08` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P08` / `bun run test:live -- P08` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p08): github app import and receipt-backed delivery` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P09 — Complete React + Hono build proof

**Owner:** QA/integration engineer. **Dependencies:** P03, P04, P05, P06, P07, P08.

**Create/modify:**
- `stacks/react-hono/recipe.ts`
- `stacks/react-hono/template/`
- `tests/fixtures/forge-task-tracker/`
- `tests/acceptance/manifest.json`
- `tests/live/forge-react-hono.spec.ts`
- `scripts/run-journey.ts`

**Tests:** `tests/live/forge-react-hono.spec.ts`, `tests/browser/forge-journey.spec.ts`.

1. Create immutable evaluator manifest outside editable workspace; bind executable commands, fixture hash and environment. Use Bun/Hono API and React/TanStack client with persisted behavior appropriate to fixture.
2. Run brief→plan/design approval→specialists→install→implement→test→deliberate red→repair→browser→preview→artifact→PR. Test both review and autonomous gates.
3. Inject process interruption, duplicate request, quota edge, remote stop and steering revision; reconcile and compare last good work. Reviewer inspects artifacts and executes independent acceptance.

**Acceptance:** No handcrafted completion or model report substitutes for command exit and browser assertions. Record actual latency/cost/repair classes. New repo and imported repo happy/adverse paths pass. Only now label stack #1 verified; do not call five-stack product complete.

**Verify:** `bun run verify:packet P09` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P09` / `bun run test:live -- P09` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p09): complete react + hono build proof` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P10 — Source evidence and rule normalization

**Owner:** Evidence backend engineer. **Dependencies:** P00, P02; P03 before live retrieval.

**Create/modify:**
- `apps/app/src/server/evidence/sources.ts`
- `apps/app/src/server/evidence/claims.ts`
- `apps/app/src/server/evidence/authority.ts`
- `apps/app/src/server/evidence/deadlines.ts`
- `apps/app/src/client/evidence/Drawer.tsx`
- `apps/app/migrations/0004_evidence.sql`

**Tests:** `tests/evidence.test.ts`, `tests/evidence.integration.test.ts`.

1. Translate selected HackSteward domain functions/fixtures: source capture, deterministic claim identity, supersession, conflict, provenance and narrow normalization.
2. Validate extracted quote/locator against immutable actual snapshot; distinguish original and rendered content. Apply one shared authority vocabulary; unknown is not low-confidence verified.
3. Treat missing timezone or time-of-day as ambiguous. Fetch through allowed URL policy with redirect/private-network controls, response limits and safe rendering.

**Acceptance:** Repeated extraction yields same logical evidence; placeholder snapshots rejected. Equal-authority disagreement retained; same-source revision supersedes history. DST/offset equivalence and absent time/date edge cases pass. Snapshot access remains project-scoped.

**Verify:** `bun run verify:packet P10` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P10` / `bun run test:live -- P10` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p10): source evidence and rule normalization` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P11 — Discovery, fit and planning carryover

**Owner:** Product/backend engineer. **Dependencies:** P06, P07, P10; P14 profile contract.

**Create/modify:**
- `apps/app/src/server/discovery.ts`
- `apps/app/src/server/eligibility.ts`
- `apps/app/src/server/planning.ts`
- `apps/app/src/client/discovery/Results.tsx`
- `apps/app/src/agents/skills/planning/SKILL.md`

**Tests:** `tests/discovery.test.ts`, `tests/planning.integration.test.ts`, `tests/browser/discovery.spec.ts`.

1. Adapt Caddie feed/Scout candidate binding, query intent and ranking; source adapters include Tavily search/extract for research path with provenance and real call receipts.
2. Translate conservative eligibility checks; separate open feed, personal eligibility and fit/effort heuristics. Missing or unsupported interpretation remains unknown.
3. Create kernel/scope/PRD/spec and deadline-linked milestones from accepted requirements; preserve user revisions and support contest-free projects. Drop learner-only forced pauses in autonomous mode.

**Acceptance:** Fabricated candidate IDs rejected; hard ineligible cannot rank as eligible; partial feed failure visible. Each fit/requirement points to evidence and assumptions. Cross-project plan isolation and edit-one-section behavior pass.

**Verify:** `bun run verify:packet P11` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P11` / `bun run test:live -- P11` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p11): discovery, fit and planning carryover` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P12 — Tasks, schedules, Sentinel and notifications

**Owner:** Backend scheduling engineer. **Dependencies:** P03, P05, P06, P10.

**Create/modify:**
- `apps/app/src/server/tasks.ts`
- `apps/app/src/server/schedules.ts`
- `apps/app/src/server/sentinel.ts`
- `apps/app/src/server/notifications.ts`
- `apps/app/src/client/tasks/Schedules.tsx`
- `apps/app/migrations/0005_schedules.sql`

**Tests:** `tests/schedules.integration.test.ts`, `tests/sentinel.test.ts`, `tests/live/notifications.spec.ts`.

1. Implement human tasks and schedules with timezone/next/last result/pause/edit; unique occurrence keys trigger Flue work, not a parallel scheduler runtime. Define missed-run coalescing policy.
2. Compare normalized rule claims and affected plans/checklists; suppress cosmetic noise, retain old/new evidence and severity. Scheduled work stores project/source IDs.
3. Implement in-app alerts, opt-in email weekly scout/due checklist and useful rule changes; quiet preferences, escaped copy, configured origin, delivery receipts and retry dedupe.

**Acceptance:** Overlapping cron fires once per occurrence; project switch does not retarget. Date changes recalculate reminders without deleting history. Failed mail leaves domain success intact and retry visible. Run actual configured mail test only with authorized recipient; absent provider remains BLOCKED.

**Verify:** `bun run verify:packet P12` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P12` / `bun run test:live -- P12` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p12): tasks, schedules, sentinel and notifications` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P13 — Judge coaching and submission package

**Owner:** Product/QA engineer. **Dependencies:** P07, P09, P10, P11.

**Create/modify:**
- `apps/app/src/server/judge.ts`
- `apps/app/src/server/submission.ts`
- `apps/app/src/client/judge/Scorecard.tsx`
- `apps/app/src/client/submission/Package.tsx`
- `apps/app/src/agents/skills/submission/SKILL.md`

**Tests:** `tests/judge.test.ts`, `tests/submission.test.ts`, `tests/browser/submission.spec.ts`.

1. Extract actual rubric/weights and compare artifact evidence. Validate structured scoring; separate declared/local/deployed and unknown access. Include demo script/friction log/pre-mortem derived from actual requirements.
2. Generate contest-specific checklist and submission description from real plans, git history and receipts; title is project title. Missing video/repo/license/host proof stays missing.
3. Export/copy package with source citations, reuse disclosure and user attestations. Record confirmed submission distinctly from prepared package; final external submission stays human action.

**Acceptance:** No universal video duration/public repo assumption. No invented links or win probability. Malformed model result rejected and partial evidence clearly shown. Export artifact hash/requirements version recorded; later rule change invalidates readiness.

**Verify:** `bun run verify:packet P13` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P13` / `bun run test:live -- P13` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p13): judge coaching and submission package` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P14 — Profile, memory, search and settings

**Owner:** Full-stack product engineer. **Dependencies:** P01, P02, P06; P03/P05/P07 for integration.

**Create/modify:**
- `apps/app/src/server/profiles.ts`
- `apps/app/src/server/memory.ts`
- `apps/app/src/server/search.ts`
- `apps/app/src/client/onboarding/Start.tsx`
- `apps/app/src/client/settings/Settings.tsx`
- `apps/app/src/client/memory/Memory.tsx`
- `apps/app/src/client/search/Search.tsx`

**Tests:** `tests/memory.integration.test.ts`, `tests/search-isolation.test.ts`, `tests/browser/settings.spec.ts`.

1. Build three entry paths and structured stack interests/country/timezone/hours/experience. Keep supported stack IDs distinct from free text; no complete-profile wall before useful work.
2. Implement personal/project memory with source/version, explicit correction/deletion and proposed vs confirmed facts. Preferences cannot change authorization or hard eligibility.
3. Search messages/files/links/images with scoped permission filters. Show actual integration health, enabled stacks/specialists/skills and payer/usage controls; no fake buttons or inherited pricing plans.

**Acceptance:** Memory deletion stops future injection; cross-project/private facts excluded. Search cannot expose denied snippets/counts. Secret values never echo to client/logs. Interrupted settings save preserves draft/error; quota display agrees with durable reservations.

**Verify:** `bun run verify:packet P14` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P14` / `bun run test:live -- P14` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p14): profile, memory, search and settings` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P15a — TanStack Start generated apps

**Owner:** Stack engineer. **Dependencies:** P09; stack contract frozen.

**Create/modify:**
- `stacks/tanstack-start/recipe.ts`
- `stacks/tanstack-start/template/`
- `apps/app/src/agents/skills/tanstack-start/SKILL.md`

**Tests:** `tests/live/stacks/tanstack-start.spec.ts`.

1. Implement template and stack recipe with full-stack server behavior, environment schema, install/test/build/start/export and private preview strategy.
2. Run same feature intent and protected acceptance; inject and repair failure, then import existing fixture and edit narrowly.
3. Record source/recipe hashes and server/client browser evidence. Enable only after gate.

**Acceptance:** Full-stack behavior persists across requests, production build starts, private preview auth applies. TanStack Start remains an output stack even though Caddie uses SPA.

**Verify:** `bun run verify:packet P15a` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P15a` / `bun run test:live -- P15a` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p15a): tanstack start generated apps` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P15b — Laravel + React/Inertia generated apps

**Owner:** Laravel stack engineer. **Dependencies:** P09; stack contract frozen.

**Create/modify:**
- `stacks/laravel-inertia/recipe.ts`
- `stacks/laravel-inertia/template/`
- `apps/app/src/agents/skills/laravel-inertia/SKILL.md`

**Tests:** `tests/live/stacks/laravel-inertia.spec.ts`.

1. Declare PHP/Composer/Bun requirements and supported database/test service; template uses Laravel/React/Inertia session behavior.
2. Install, migrate only disposable test DB, test/build/serve; demonstrate failure repair and existing-repo patch; export reproducible setup.
3. Verify private preview supports PHP backend and client assets; document explicit production target separately from Caddie hosting.

**Acceptance:** Server validation/auth and UI work; destructive real DB migration requires gate. Tests plus browser proof pass in actual stack runtime; no frontend-only badge.

**Verify:** `bun run verify:packet P15b` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P15b` / `bun run test:live -- P15b` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p15b): laravel + react/inertia generated apps` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P15c — FastAPI + React generated apps

**Owner:** Python stack engineer. **Dependencies:** P09; stack contract frozen.

**Create/modify:**
- `stacks/fastapi-react/recipe.ts`
- `stacks/fastapi-react/template/`
- `apps/app/src/agents/skills/fastapi-react/SKILL.md`

**Tests:** `tests/live/stacks/fastapi-react.spec.ts`.

1. Declare uv/Python + Bun React/Vite/TanStack client install/build/test/server commands and contract-generation boundary.
2. Run Python API and frontend under private preview with explicit routing and environment; no permissive wildcard auth shortcut.
3. Prove injected repair and narrow imported-project update; record reproducible artifact.

**Acceptance:** API and UI integration, validation/error cases, both test suites and browser interaction pass. Cross-origin/session policy proved for chosen template.

**Verify:** `bun run verify:packet P15c` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P15c` / `bun run test:live -- P15c` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p15c): fastapi + react generated apps` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P15d — Flutter generated apps and mobile specialist

**Owner:** Mobile engineer. **Dependencies:** P09; P15c only if using FastAPI backend instead of default Hono.

**Create/modify:**
- `stacks/flutter/recipe.ts`
- `stacks/flutter/template/`
- `apps/app/src/agents/skills/flutter/SKILL.md`
- `scripts/capture-android.ts`

**Tests:** `tests/live/stacks/flutter.spec.ts`.

1. Default template pairs Flutter with proven Hono API; alternative supported backend requires its own integration fixture. Preflight actual SDK/Android toolchain/emulator availability.
2. Produce source, tests, debug APK and emulator screenshots/video for primary journey; exercise API and demo/live integration labels. Preserve agreed platform breadth without promising store distribution.
3. Inject failing widget/API contract and repair; verify imported Flutter fixture and export setup/signing guidance. If sandbox lacks emulator capability, implement isolated compatible runner adapter before availability.

**Acceptance:** Real Android APK launch and emulator interaction receipt, not Flutter web screenshot. Generated code has no platform credentials; user project signing material is not copied. No stack-ready badge while emulator/provider capability is blocked.

**Verify:** `bun run verify:packet P15d` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P15d` / `bun run test:live -- P15d` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p15d): flutter generated apps and mobile specialist` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P16 — Astro landing and product demonstration

**Owner:** Frontend design engineer. **Dependencies:** P00; P06 identity; P09 before real build-success claims.

**Create/modify:**
- `apps/site/src/pages/index.astro`
- `apps/site/src/components/Hero.astro`
- `apps/site/src/components/ProductDemo.astro`
- `apps/site/src/styles/site.css`
- `apps/site/public/`
- `tests/browser/landing.spec.ts`

**Tests:** `tests/browser/landing.spec.ts`.

1. PORT the existing Caddie landing design (read-only reference: /Users/captjay98/projects/caddie/src/components/Landing.tsx + `.pb` styles in src/styles/halo.css; tokens via the packages/ui halo port): run-spine composition (sticky-rail acts, hero with product captures + overlapping phone, honesty rails, closing access board), amber action color, mono type, full-bleed gutter. Content updated for the fresh product and honest availability; hero art is clearly-labelled illustrative until real fresh-workspace captures exist. This SUPERSEDES the previously committed P16 landing slices — replace the atmospheric-blue implementation; retain the proven invariants (static-readable, reduced-motion, keyboard, mobile, honest availability, working request-access endpoint) and update tests/browser/landing.spec.ts to the ported structure. Keep meaningful text readable without JS.
2. Show discover/build/prepare stories and honest stack availability; use synthetic clearly illustrative demo until real accepted evidence. Request-access action must work through explicit intended endpoint or configured contact, not no-op UI.
3. Check mobile, keyboard, contrast, reduced motion, metadata, external links and bounded asset weight; avoid heavy video/autoplay dependencies.

**Acceptance:** Static page works without client JS; CTA routes correctly; no unsupported testimonials/features or raw private screenshots. Demonstration reflects real product states and never masquerades as live run.

**Verify:** `bun run verify:packet P16` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P16` / `bun run test:live -- P16` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p16): astro landing and product demonstration` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

## P17 — Hosted acceptance, operations and launch

**Owner:** Release QA/integration lead. **Dependencies:** P01–P16 including P15a–d.

**Create/modify:**
- `scripts/release-check.ts`
- `docs/runbooks/operations.md`
- `docs/release-evidence.md`
- `docs/setup/provider-checklist.md`
- `.github/workflows/ci.yml`
- `tests/live/release.spec.ts`

**Tests:** `tests/live/release.spec.ts`, `tests/browser/release.spec.ts`.

1. Integrate all packets, reconcile every audit/feature-ledger row and independent reviews. Build/migration dry-run and staging deployment plan; obtain concrete authorization before deployment/paid probes.
2. Run hosted two-user/effect/cost/recovery/preview tests and each stack. Validate logs redact secrets, bounded retention, revocation, cleanup, backups/restore and no orphaned billing liability.
3. Prepare exact release SHA, artifact hashes, rollback package and owner-facing feature limitations. Check current official contest rules/prior-work disclosure if entering contest; never assume fresh repo itself establishes compliance.

**Acceptance:** All agreed capabilities have receipts or explicit blockers; no overall complete claim while a required stack missing. D1/DO migrations append safely; rollback compatibility and restore tested. Final production deployment approved against concrete release; post-deploy smoke tied to SHA.

**Verify:** `bun run verify:packet P17` + `bun run typecheck`; browser/live tests above run through `bun run test:browser -- P17` / `bun run test:live -- P17` when applicable. Expected exit 0 with named checks and receipts; missing credentials/capability is BLOCKED, not PASS.

**Commit:** `feat(p17): hosted acceptance, operations and launch` after review. Roll back by reverting only this packet’s code or disabling its capability; never delete user data to undo a migration.

