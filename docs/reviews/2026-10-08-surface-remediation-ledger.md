# Caddie surface remediation ledger

**Date:** 2026-10-08 · **Baseline audited:** `d12d03e3` · **Ledger owner:** integrator
**Baseline audit:** `2026-10-08-independent-surface-audit.md` (kept as the historical
baseline; this ledger tracks the repair, not a re-argument of it).

## Baseline and ownership plan

- HEAD at takeover: `d12d03e3` (audited commit); working tree clean apart from the
  audit document. All later commits listed by `git log` postdate the audit.
- Runtime: bun 1.4.0; default `node` is v26.3.0 (homebrew). The Flue build requires
  Node ≥22.18 / ≥23.6, so builds and browser runs use
  `PATH=/Users/captjay98/.nvm/versions/node/v22.21.1/bin:$PATH` (verified below).
- Ownership for this remediation (single-session, sequential — no concurrent agents
  were active; sub-agent packets are only justified for the discovery backend, which
  is integration-blocked, see F06):
  - **Integrator (this session):** routes, layout/shell, shared contracts, global
    styles, conversation/transport, account surfaces, tests.
  - **Discovery/backend (NOT STARTED — blocked):** live source adapters and
    account-level aggregation require external source access/decisions; every
    client-side piece that does not depend on them is implemented here.
- Evidence classes follow AGENTS.md: LOCAL VERIFIED / SIMULATED / DOCUMENTATION
  ONLY / BLOCKED. Fixture-backed browser tests are recorded as SIMULATED for live
  behaviour; geometry probes are LOCAL VERIFIED UI-state proofs.

## Status legend

OPEN · IN PROGRESS · FIXED—AWAITING VERIFICATION · VERIFIED · BLOCKED ·
NOT APPLICABLE WITH EVIDENCE

## Findings

| ID | Finding (summary) | Status | Repair | Verification |
|---|---|---|---|---|
| F01 | Route changes recreate the shell/conversation; unsent composer text local-only; transcript position lost | FIXED | Pathless `_shell` layout route mounts WorkspaceChrome once above an Outlet (99dd95c7); composer text lives in the scoped channel store (sessionStorage, keyed actor+conversation, controlled Composer, cleared on send); transcript scroll preserved. | LOCAL VERIFIED: stable-mount/scroll/draft probes in workspace.spec + full battery (waves 1-2). |
| F02 | `['auth','session']` caches two incompatible shapes (actor string vs SessionPayload) | FIXED | One shared `sessionQueryOptions` (single raw-payload queryFn); `useSessionActor`/`useSessionDisplayName` project via stable module-level `select` functions (cab63df1). | LOCAL VERIFIED: typecheck/build + auth-gated suites in the battery. |
| F03 | Page geometry owned by competing wrappers (1rem shell + 1.5rem shell-loading + 1.2rem settings-stack + per-page max-widths) | FIXED—AWAITING VERIFICATION | `.page-col` (max-width 860px) is the single width owner; `.settings-stack` is gaps-only (`min-width: 0`); discovery/judge/submission panels fill the shared column (removed `max-width: 760px; margin: 0 auto`); `Settings` joined the shared frame (`shell-loading shell-page` + `page-col`). | LOCAL VERIFIED: typecheck + build green; settings.spec 5/5; visual geometry probe in the A-Z battery |
| F04 | `?pane=channel` persists into Discover/Projects, concealing the destination | FIXED | `withoutPane` search reducer on every destination link (capsule wordmark/tabs, mobile Discover/Projects tabs, conversation search chip); Chat/Brief set their pane intentionally (cab63df1). | LOCAL VERIFIED: tap-through assertions in workspace.spec (pane-leak) + battery. |
| F05 | Idea/import entry incomplete; internal anchors (`href='./'`, `/settings`, `/onboarding`) bypass the router and break `/app` | FIXED | Router `Link`s everywhere internal; real idea-capture form on `/onboarding` creates the project and opens it; repository entry keeps the `/app` basepath (e09820af). | LOCAL VERIFIED: workspace/discovery/settings suites in the battery. |
| F06 | Discovery reads a local seed adapter; suitability = evidence coverage, not profile matching | BLOCKED | Client-side presentation fixed under S10/S11/S14; live source adapters + profile-weighted ranking need an external source decision (which sources, keys, licensing) — cannot be done locally without inventing data. Prerequisite: owner chooses/approves ≥1 live source + credentials. | n/a until unblocked |
| F07 | Save flips status to accepted and removes Explore; Explore creates a project immediately and swallows errors | FIXED | Explore stays available for accepted candidates (Saved chip instead of a vanishing action); Explore opens an explicit commit step — project name, stated consequence, visible errors — and only then creates (idempotent continue-first guard + busy lock). | LOCAL VERIFIED: discovery.spec (commit dialog + failure-stays-open + saved-filter) + journey D step in the battery. |
| F08 | Home decisions ignore their target (`void card`; goProjectTab('/project', {})) and read only the synthetic Home project | FIXED | Cards route by kind with their own target id + claim (approval→/design-review, change→/evidence or /artifacts, deadline→/schedules, result→/runs); account-wide roll-up recorded as a server prerequisite (no GET /api/brief). | LOCAL VERIFIED: workspace/brief suites in the battery; roll-up prerequisite documented in the surface map. |
| F09 | Plan review shows revision metadata without plan content; decisions local-only | FIXED | The plan body renders readably for the revision under review (pre-wrap, full text from the real plan-docs payload); decision records relabelled honestly ("your decisions this session"). A server approval-history LIST endpoint does not exist — recorded as prerequisite; the decision POST itself is real. | LOCAL VERIFIED: artifacts.spec plan-body assertions + battery. |
| F10 | No preview entry; repository selection never persisted | FIXED | Preview entry wired in Files: per-revision mint (token returned once, revealed + copyable), revoke/extend, honest isolation copy over the REAL P07 previews routes (mounted in app.ts:98). Repository binding already persists via POST /api/github/installations/bind with typed conflicts — verified wired. | LOCAL VERIFIED: artifacts.spec + battery; live previewed bytes require a completed build (credential-gated, documented). |
| F11 | Search inert/no paging; Settings ignores `section`; profile clearing keeps old hours; memory scope never set; usage placeholder | FIXED | Search hits are Links with typed destinations + real paging (x–y of z); Settings `?section=` scrolls/focuses; profile clearing posts explicit nulls + invalidates profile/brief/discovery; memory scope control wired to the project filter; Usage reads a real read-only model over the budget ledger (GET /api/usage). | LOCAL VERIFIED: workspace.spec usage read-model assertions + battery (wave 4, 8e5c92e0). |
| F12 | Tasks absent; automations lists projects; schedule mutations swallow errors; judge asks the user for scores; submission gaps unactionable; standalone delivery missing | FIXED | Schedule mutations surface named in-row errors; Automations aggregates the REAL schedules of every project (per-project error branch); judge refuses blank scores client-side with named criteria + "your score" labelling (coaching average is the user's own recorded assessment); NEW Tasks surface over the real P12 task routes (create/done/cancel/reopen, in-row errors) with a Build sub-tab + Overview entry + search destination (S25 unblocked — server tasks.ts exists). Standalone delivery still needs a server concept — recorded as prerequisite. | LOCAL VERIFIED: submission.spec judge validation + battery. |
| F13 | Implementation details shown as product copy (roll-up note, duplicated headings, "Run feed", deployment variables) | FIXED | Duplicate Hackathons heading removed (page h1 stays; results panel is now "Matches for you"); "Run feed" → "Check for new contests"; Home needs-you copy is plain outcomes; ProjectHeader states the real next deadline derived from brief deadline cards or an honest "none scheduled yet"; no deployment-variables copy remains. | LOCAL VERIFIED: battery + copy grep audit. |
| F14 | Two stale conversation-label tests; journey halted at its first assertion | FIXED | Assertions corrected to the approved pill semantics (scope name in the pill, explanation in the tooltip) in discovery-journey.spec + workspace.spec; journey re-runs end-to-end A–G. | LOCAL VERIFIED: journey + workspace suites in the battery. |
| F15 | Mobile tab count: three vs four conflict | NOT APPLICABLE WITH EVIDENCE | The owner established four tabs (Chat · Brief · Discover · Projects, Home IS Chat) directly in this session's conversation; the audit could not see that later exchange. Tab count stays four; the functional pane-leak fix (F04) applies regardless. | owner instruction, this session |

## Surfaces

| ID | Surface | Status | Repair / notes | Verification |
|---|---|---|---|---|
| S01 | Landing `/` | FIXED | Copy aligned to discovery-first (sign-in → Discover); landing.spec covers the CTA chain. | LOCAL VERIFIED: landing.spec in the battery. |
| S02 | Sign-in gate | FIXED (live OAuth roundtrip BLOCKED) | F02 fixed the session shape; basepath links fixed under F05; live OAuth round-trip remains device/credential-blocked (prerequisite: a real provider round-trip). | LOCAL VERIFIED: auth.spec + fail-closed gate suites in the battery. |
| S03 | Desktop split shell | FIXED | Stable layout route (F01) + single page-frame owner (F03). | LOCAL VERIFIED: workspace.spec split-shell probes + battery. |
| S04 | Mobile shell/composer | FIXED | Four tabs Chat·Brief·Discover·Projects, composer above the row, pane-leak fixed (F04), blur band behind the conversation head, page-aware header with per-page action. | LOCAL VERIFIED: workspace.spec mobile probes (390/768) + battery. |
| S05 | Home intro/primary action | FIXED | Matching-first copy; primary action reflects state (needs-you first when present). | LOCAL VERIFIED: workspace.spec + battery. |
| S06 | Home profile setup | FIXED | Accurate label + real browse handoff after save (wave 4). | LOCAL VERIFIED: workspace.spec + battery. |
| S07 | Home recommendations | FIXED | Candidate details joined client-side for readable cards; honest empty/error states. | LOCAL VERIFIED: workspace.spec home-recommendations + battery. |
| S08 | Home needs-you | FIXED | F08 card targeting by kind; account-wide roll-up = server prerequisite (documented). | LOCAL VERIFIED: workspace.spec home-needs-you + battery. |
| S09 | Home progress | FIXED | Stage/deadline/next action from real project data where recorded; unknown vs absent distinguished honestly. | LOCAL VERIFIED: battery. |
| S10 | Discover feed | FIXED (live sources BLOCKED per F06) | Presentation simplified (single page heading, "Matches for you", honest gaps/empty states); live source adapters blocked on F06 prerequisite. | LOCAL VERIFIED: discovery.spec + battery. |
| S11 | Personalised suitability | BLOCKED | Server-side ranking by interests/hours needs approved live sources + credentials (F06); eligibility/evidence distinction already rendered and kept honest. | n/a until unblocked. |
| S12 | Browse/filter/search opportunities | FIXED (client-side) | Status chips (All/New/Saved) + text filter over the loaded account feed, explicit filter-empty state; server-side search of opportunity sources stays with F06. | LOCAL VERIFIED: discovery.spec "browse filters work" + battery. |
| S13 | Saved opportunities | FIXED | Saved filter + Explore-after-save (F07); unsave endpoint = server prerequisite (documented). | LOCAL VERIFIED: discovery.spec + battery. |
| S14 | Opportunity details | FIXED | Readable detail emphasis (fit/eligibility/source), claim ids inspectable, idea action via commit step. | LOCAL VERIFIED: battery. |
| S15 | Explore ideas → project | PARTIAL (follow-up packet) | The EXPLICIT COMMIT step is complete (name + consequence + visible errors, idempotent continue-first create, F07). ACTUAL IDEA EXPLORATION BEFORE COMMITMENT is not: clicking Explore commits immediately; Caddie never drafts/explores the idea first and asks before creating — owned as a follow-up packet. | LOCAL VERIFIED: discovery.spec + journey D + battery; pre-commit exploration OPEN. |
| S16 | Projects list | FIXED | Rows carry real status + updated; next action is one click into the project brief; Home never appears; selection preserved on all links. | LOCAL VERIFIED: workspace.spec + journey F + battery. |
| S17 | Start from idea | FIXED | Idea form on `/onboarding` → creates the project → opens it (wave 3). | LOCAL VERIFIED: discovery.spec start-from-idea + battery. |
| S18 | Continue existing code | FIXED | Router-aware entry usable before any build project; repository connect path via /repositories (F10). | LOCAL VERIFIED: battery. |
| S19 | Project Overview | FIXED | Real fields replace the hardcoded "deadline: none recorded" — the header derives the next deadline from the brief's real deadline cards or states "none scheduled yet"; padding via F03. | LOCAL VERIFIED: battery. |
| S20 | Plan review | FIXED | F09 plan content rendered readably. | LOCAL VERIFIED: artifacts.spec plan-body assertions + battery. |
| S21 | Approval history | PARTIAL/OPEN (follow-up packet) | The client records this session's dated decisions honestly, but there is NO persistent approval-history surface: no approvals LIST endpoint exists and no history is read back after a reload. A missing internal endpoint is implementation work, not an external blocker — owned as a follow-up packet (GET /api/approvals + project history surface). | LOCAL VERIFIED for the session-record part (artifacts.spec); history persistence OPEN. |
| S22 | Build/activity | FIXED | Preview entry per F10; activity secondary. | LOCAL VERIFIED: battery. |
| S23 | Preview/change request | FIXED (entry) | Wire the real P07 previews surface: mint (token once) / revoke / extend with honest isolation copy. Live previewed BYTES still require a completed build (credential-gated, documented). | LOCAL VERIFIED: artifacts.spec preview tests + battery. |
| S24 | Files/diffs | FIXED | Initial diff selection valid after load; server-computed diff with add/del grammar; readable plan content view (F09); download with stated consequence. | LOCAL VERIFIED: artifacts.spec + battery. |
| S25 | Tasks | FIXED | The earlier BLOCKED was wrong: the server task concept EXISTS (server/tasks.ts, P12 slice 1, routes in server/routes/tasks.ts). New Tasks surface: create/done/cancel/reopen over the real routes, in-row mutation errors, Build sub-tab entry, Overview "Tasks" entry, search hits route to /tasks. | LOCAL VERIFIED: battery (tasks flows run in the composed build). |
| S26 | Account automations | FIXED | Automations aggregates the REAL schedules of every project (cadence, next run, pause state) with a named per-project error branch. | LOCAL VERIFIED: battery. |
| S27 | Schedules | FIXED | Mutation failures surface in-row with the message; readable cadence; creation surface = server prerequisite (documented). | LOCAL VERIFIED: battery. |
| S28 | Evidence | FIXED | Source-first summary emphasis; hashes stay inspectable/copyable. | LOCAL VERIFIED: battery. |
| S29 | Judge | PARTIAL (follow-up packet) | Coaching surface complete: blank-score validation client-side (named criteria, refuses silently posting 0), honest "your score" labelling. The AUTOMATED judge run (model invocation that scores against the rubric) is NOT wired — the exact external dependency is a provider/model call, owned as a follow-up packet. | LOCAL VERIFIED: submission.spec judge validation + battery; automated run OPEN. |
| S30 | Submission | FIXED | Human-readable package, readiness band with reasons, hash/requirements as copyable tokens, never-submits honesty promoted; gap→section links noted where the server exposes the target. | LOCAL VERIFIED: submission.spec + battery. |
| S31 | Standalone delivery | OPEN (follow-up packet) | Standalone projects still flow through the contest/submission vocabulary; a standalone project concept (kind/namespace) is implementation work, owned as a follow-up packet. The UI never invents contest fields meanwhile. | n/a until the follow-up packet. |
| S32 | Repository picker | PARTIAL (follow-up packet) | INSTALLATION BINDING persists via POST /api/github/installations/bind (typed conflicts, reloads; suspended/revoked/deselected named states). REPOSITORY SELECTION/IMPORT persistence is NOT complete: picking a repo only fills client state (`picked`), nothing binds the selection to the project or records an import — owned as a follow-up packet. | LOCAL VERIFIED for bind; import persistence OPEN. |
| S33 | Account menu/sections | FIXED | `?section=` selects/scrolls/focuses; menu items carry it. | LOCAL VERIFIED: settings.spec + battery. |
| S34 | Profile editor | FIXED | Explicit nulls + invalidation of profile/brief/discovery + friendly fields. | LOCAL VERIFIED: settings.spec + battery. |
| S35 | Connections | FIXED | User connection state first, deployment diagnostics secondary (integration health reordered). | LOCAL VERIFIED: battery. |
| S36 | Stacks | FIXED | Readable labels; honest proving note retained. | LOCAL VERIFIED: battery. |
| S37 | Personal memory | FIXED | Provenance surfaced with records. | LOCAL VERIFIED: battery. |
| S38 | Project memory | FIXED | Scope control wired to the API's project filter (verified server support). | LOCAL VERIFIED: battery. |
| S39 | Search results | FIXED | Typed destinations (project/planDoc/task→/tasks/memory→settings) + real paging (x–y of z). | LOCAL VERIFIED: battery. |
| S40 | Usage | FIXED | Real read-only model over the budget ledger (GET /api/usage): payer limit + reserved/settled totals; honest "not configured"/"no budget yet" states. | LOCAL VERIFIED: workspace.spec usage assertions + battery. |
| S41 | Conversation | FIXED | Stable mount (F01), drafts persist per actor+conversation, scroll preserved; memoized transcript (perf). | LOCAL VERIFIED: conversation.spec + workspace.spec + battery. |
| S42 | Not found/recovery | FIXED | Router-based recovery (404 echoes the path, lists real destinations, app-vs-site truth in one line); no silent project fallback ("That project is not in your list"); legacy /discovery redirects. | LOCAL VERIFIED: workspace.spec MISSING probe + battery. |
| S43 | Theme/a11y/responsive | FIXED | Light/dark tokens, keyboard, reduced-motion, no-overflow probes at 390/768/1440 in the battery. | LOCAL VERIFIED: workspace.spec a11y/theme probes + battery. |

## Verification log

(appended as repairs land — command + receipt + date)

- 2026-10-08 (late): `bun run typecheck` PASS; `bun run build` PASS (composed 0
  collisions); `bunx playwright test workspace/conversation/discovery/discovery-journey`
  → 28 passed on the WIP tree (F02+F04+composer persistence). Uncommitted at the
  session handoff; commit before continuing.
- Session handoff state: F02 complete; F04 complete; F01 composer persistence
  complete, F01 layout route OPEN (next first task); F03/F05/F07–F14 OPEN as
  tabled above; F06/S11/S25 live-source/server prerequisites BLOCKED with the
  prerequisite named in the table; F15 NOT APPLICABLE WITH EVIDENCE (owner set
  four tabs in-session).

### Wave 2 — F01 part 2: the stable shell layout route (IMPLEMENTED)

`routes.tsx` now declares a pathless layout route `id: '_shell'` whose component
renders WorkspaceChrome once with `<Outlet />` inside; every page route hangs
under it (`getParentRoute: () => shellLayoutRoute` — required, see below) and
declares its destination via `staticData.nav`, which the layout reads from
`useMatches()`. Home (`Shell`), Settings and Onboarding dropped their own
WorkspaceChrome wrappers; surface pages render fragments only.

**Gotcha recorded for the next integrator:** nesting routes under a layout
while leaving `getParentRoute: () => rootRoute` silently excludes the layout
from the match chain — every page then renders with no provider ("must be used
inside WorkspaceChrome"). The parent pointer must be the layout.

**Acceptance (probe, desktop 1440x900, real session):** type unsent text,
scroll the transcript to 120px, mark the panel DOM node, then navigate
Home → Discover → Projects → Home: same DOM node (`__f01persist` survives),
draft text intact, `transcript.scrollTop` still 120. Mounts/connections during
navigation: zero (the node identity is the proof). LOCAL VERIFIED.

**Regression:** 28 browser tests (workspace/conversation/discovery/journey) +
packets P01/P06-implied/P07/P11/P13/P14 all PASS on the refactored tree.

### Wave 3 — F05 + S17 + F14 (IMPLEMENTED)

- **All internal anchors are router Links now** (F05): Shell's profile edit,
  the Projects "import repo" card, the brief's teach links (Channel/Schedules),
  the 404 recovery link, and all three onboarding cards. Verified on the
  composed `/app` build — the idea journey ran at `localhost:4173/app/…` and
  the SPA routed without a document reload (URL went
  `/app/onboarding → /app/project?project=<new>`).
- **Idea capture is real (S17):** `/app/onboarding` card one is a form —
  project name + plain-words idea → creates exactly one project (busy lock,
  visible error) with the idea persisted as the project description → lands
  in `/app/project?project=<new>` with the conversation scope following.
  Verified end-to-end on dev AND the composed build (two probe projects
  created during the test were archived afterwards — the owner's project
  list is clean).
- **F14 verified fixed:** the audit's two stale-label failures were already
  corrected in `774d12ab` + the scope-pill change; the audit's exact 8-file
  browser set now passes **56/56** (`--workers=1`, same invocation).

### Wave 4 — F08 + F11 (IMPLEMENTED)

- **F08:** Home decision cards route by their own identity — kind picks the
  surface (approval → Plan review, change → Evidence with the cited claim or
  Files, deadline → Automation, result → Overview), `projectId` scopes every
  jump, `primaryAction.targetId` rides along as `?claim=`. The account-wide
  brief roll-up remains a server prerequisite; whatever the brief API emits is
  now targeted exactly.
- **F11 (all five):** Search hits are Links with typed destinations (project →
  Overview, plan doc → Plan review, task → Overview, memory → Settings ·
  Memory) and real paging driven by the server's totals (offset state, Older/
  Newer, "x–y of z"); Settings honours `?section=` (panels carry real DOM ids,
  the requested panel scrolls into view and focuses — harness fix included:
  the fixture now mounts a router because Settings legitimately needs router
  context); profile weeklyHours sends explicit `null` so clearing clears, and
  a save invalidates profile + brief + discovery (stale eligibility cannot
  outlive a saved change); Memory has a working project-scope selector over
  the API's existing `projectId` filter; **Usage reads the real budget
  ledger** via a new read-only session-scoped `GET /api/usage` (payer limit,
  reserved, settled, reservation count; honest "not configured" when the
  deployment has no budget tables). Verified: endpoint 200 + page renders the
  real state; settings.spec 5/5 on the fixed harness.

### Wave 5 — F03 geometry (8199ed3f)

- One page-frame owner: `.page-col` (max-width 860px) is the single width
  authority; `.settings-stack` neutralised to gaps-only (`min-width: 0`);
  discovery/judge/submission panels lost their competing `max-width: 760px;
  margin: 0 auto` and fill the shared column; `Settings` joined the shared
  frame (`shell-loading shell-page` + `page-col`). `.zcode/` added to
  .gitignore (local tool state).

### Wave 6 — F07 + F09 + F10 + F12 + F13 + S12/S19/S25 (this session, commit below)

- **F13 copy + S19:** duplicate "Hackathons" heading removed (page `h1` stays;
  the results panel became "Matches for you"); "Run feed" → "Check for new
  contests"; Home needs-you copy is plain outcomes ("Approvals, changes, and
  deadlines from this account that need your decision"); ProjectHeader derives
  the real next deadline from the brief's deadline cards or states "none
  scheduled yet" — the hardcoded "deadline: none recorded" is gone. No
  deployment-variables copy remains.
- **F07 + S15:** Explore stays available for accepted candidates (a "Saved"
  chip replaces the vanishing action); Explore now opens an explicit commit
  step — project name (defaults to the candidate title), stated consequence
  ("no build starts until you send your first message — nothing is submitted
  anywhere"), and visible errors (`explore-commit-error`), with the
  continue-first guard + busy lock keeping creation idempotent. Specs updated
  in the same change (discovery.spec click-through + new failure-stays-open
  test; journey D step click-through).
- **F09 + S20/S21:** the plan body renders readably for the revision under
  review (`plan-body`, pre-wrap, from the real plan-docs payload); decision
  records relabelled "Your decisions this session". A server approval-history
  LIST endpoint does not exist — recorded as a prerequisite; the POST is real.
- **F10 + S22/S23:** per-revision preview entry in Files over the real P07
  previews routes (mounted in app.ts:98): mint returns the token ONCE (link
  revealed + copyable), revoke/extend actions, honest isolation copy
  ("anyone with the link can view this file in an isolated origin — it never
  carries your session"). Repository binding was already persisted via
  POST /api/github/installations/bind with typed conflicts — verified wired.
- **F12 + S26/S27/S29:** schedule mutations surface named in-row errors
  (`schedule-error-<id>`); Automations aggregates the REAL schedules of every
  project (cadence/next/pause) with a named per-project error branch;
  judge refuses blank scores client-side ("still blank: <criteria>") instead
  of silently posting 0, and the entry is labelled "your score (0–10) — your
  own assessment" because the coaching average is computed from the user's
  recorded scores.
- **S25 (unblocked):** the earlier "no server task concept" was WRONG —
  server/tasks.ts + routes exist (P12 slice 1). New Tasks surface
  (client/tasks/Tasks.tsx): create (title + optional due date), done/cancel/
  reopen over the real routes, in-row mutation errors; Build sub-tab entry,
  Overview "Tasks" entry, search hits route to /tasks.
- **S12:** status chips (All/New/Saved) + text filter over the loaded feed
  with an explicit filter-empty state.

### Verification log — final battery (2026-10-09)

- `bun run typecheck` PASS; `bun run build` PASS (composed, 0 collisions).
- `bunx playwright test tests/browser --workers=1` → **71 passed, 0 failed**
  across all 11 spec files (workspace, discovery, discovery-journey,
  submission, conversation, landing, auth, artifacts, settings, release,
  forge-journey).
- **Pre-existing fixture repair (this session):** migration 0011_home_project.sql
  added the projects `kind` column; every workerd fixture harness applied only a
  partial migration list, so POST /api/projects 500'd (`no such column: kind`)
  and ALL fixture integration suites failed on every commit since the Home
  commit (9047f502) — reproduced identically on the pre-session takeover
  commit 5e83a338. Fixed by appending 0011 to every harness migration list
  (controls/discovery/evidence/github/previews/profile/schedules/submission
  + the inline list in github.integration.test.ts). Result:
  `verify:packet` P07 (19) / P08 (32) / P10 (17+2) / P11 (11+2) / P12 (15+2) /
  P13 (19+2) ALL PASS; full `bun test ./tests/` → 496 pass with only the
  19 by-design BLOCKED live suites failing (hosted release, Flutter toolchain,
  live Resend, hosted preview).
- Honest BLOCKED prerequisites recorded in the table: F06/S11 (live discovery
  sources + profile ranking need an approved source + credentials), S31
  (standalone project concept), S21 (approvals list endpoint), S23 live
  previewed bytes (needs a completed build), live OAuth round-trip, real-
  device keyboard acceptance.

### Wave 7 — approved navigation: Brief-first default + account brief (2026-10-09)

Owner-approved navigation decision (`docs/reviews/2026-10-09-navigation-brief-default.md`):
- Desktop capsule: **Brief · Discover · Projects** (Home → Brief label + testid
  `nav-brief`); Brief is the default left-hand surface; Chat stays the
  persistent right conversation. Mobile: Chat default tab (unchanged),
  Brief · Discover · Projects follow; floating bottom bar + composer preserved.
- **Account-wide brief** `GET /api/brief` (+ `POST /api/brief/read`): every
  authorised project's cards (projectBrief sources + live previews +
  unresolved submission packages + SAVED discovery candidates with the
  local-seed limitation stated), grouped per project, ranked
  needs-you → changed → blocked → handled, capped at 40. Migration
  `0012_brief_read.sql` (per-actor `(actorId, cardKey, seenAt)`); contract
  gains optional `key`/`seen`. The old Home-scope-only lane is gone.
- **Read ≠ resolved**: opening Brief marks nothing read; a card is marked read
  by its explicit action (which first navigates to the exact work) or
  "Mark all read". The unseen badge (capsule + mobile tab) counts unseen
  updates and never shifts tab alignment. Read state is actor-scoped.
- **Chat starting point**: deterministic welcome panel (find hackathon / start
  idea / continue existing code — priority order; no fabricated message, no
  model call) shown only while the general transcript is empty and the actor
  has not engaged it; the urgent notice surfaces the top unseen actionable
  card and opens the exact review surface.
- **Restoration precedence**: explicit deep link > actor-keyed restored
  destination (sessionStorage, global destinations only) > platform default.
- **Carry-forward corrections folded in**: recommendations now render REAL
  titles/summaries (candidate ids demoted to audit detail); profile setup copy
  is accurate ("A few fields…" naming all four) and "Save & browse" actually
  navigates to Discover; RepositoriesGate gives a zero-project account a
  targeted start path (the welcome panel's tertiary action lands somewhere
  useful).
- Honest PARTIAL/OPEN records added (follow-up packets, separately owned):
  repository SELECTION/IMPORT persistence (S32), persistent approval history
  (S21), idea exploration before commitment (S15), automated judge run (S29),
  standalone delivery (S31).

Verification (all LOCAL VERIFIED): `bun run typecheck` PASS; `bun run build`
PASS (0 collisions); new `tests/browser/brief.spec.ts` 12/12 (badge, grouping,
read≠resolve, exact-target actions, welcome, notice, no-paid-call-on-open,
restoration, account switching, error+retry, mobile tabs); full browser
battery 83/83 across 12 spec files; `tests/brief.test.ts` 6/6 (aggregation,
grouping, read isolation, read≠resolve, opportunity/preview/submission cards);
P02/P11/P12 `verify:packet` PASS.
