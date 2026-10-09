# Caddie surface remediation ledger

**Date:** 2026-10-08 · **Baseline audited:** `21538d1d` · **Ledger owner:** integrator
**Baseline audit:** `2026-10-08-independent-surface-audit.md` (kept as the historical
baseline; this ledger tracks the repair, not a re-argument of it).

## Baseline and ownership plan

- HEAD at takeover: `21538d1d` (audited commit); working tree clean apart from the
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
| F01 | Route changes recreate the shell/conversation; unsent composer text local-only; transcript position lost | IN PROGRESS | DONE: composer unsent text moved into the scoped channel store (sessionStorage, keyed actor+conversation; controlled Composer on both the desktop pane and the mobile bar; cleared on send). REMAINING: the stable layout route (WorkspaceChrome + conversation above the Outlet) — this is the next session's first task; the transcript still remounts per navigation until then. | composer persistence: LOCAL VERIFIED (typecheck/build/28 browser tests); layout route: OPEN |
| F02 | `['auth','session']` caches two incompatible shapes (actor string vs SessionPayload) | FIXED—AWAITING VERIFICATION | One shared `sessionQueryOptions` (single raw-payload queryFn); `useSessionActor`/`useSessionDisplayName` project via stable module-level `select` functions. Both mount orders now read the same cached payload. | LOCAL VERIFIED: typecheck + build green; 28 browser tests incl. auth-gated suites pass. Behavioural probe (mount-order flip) still to run. |
| F03 | Page geometry owned by competing wrappers (1rem shell + 1.5rem shell-loading + 1.2rem settings-stack + per-page max-widths) | FIXED—AWAITING VERIFICATION | `.page-col` (max-width 860px) is the single width owner; `.settings-stack` is gaps-only (`min-width: 0`); discovery/judge/submission panels fill the shared column (removed `max-width: 760px; margin: 0 auto`); `Settings` joined the shared frame (`shell-loading shell-page` + `page-col`). | LOCAL VERIFIED: typecheck + build green; settings.spec 5/5; visual geometry probe in the A-Z battery |
| F04 | `?pane=channel` persists into Discover/Projects, concealing the destination | FIXED—AWAITING VERIFICATION | `withoutPane` search reducer on every destination link (desktop capsule wordmark + tabs, mobile Discover/Projects tabs, conversation search chip). Chat/Brief tabs intentionally set their pane. | LOCAL VERIFIED: typecheck/build; tap-through assertion to be added to workspace.spec (recorded as remaining). |
| F05 | Idea/import entry incomplete; internal anchors (`href='./'`, `/settings`, `/onboarding`) bypass the router and break `/app` | OPEN | Router `Link`s everywhere internal; idea capture form on `/onboarding` (S17); repository entry keeps `/app` basepath. | pending |
| F06 | Discovery reads a local seed adapter; suitability = evidence coverage, not profile matching | BLOCKED | Client-side presentation fixed under S10/S11/S14; live source adapters + profile-weighted ranking need an external source decision (which sources, keys, licensing) — cannot be done locally without inventing data. Prerequisite: owner chooses/approves ≥1 live source + credentials. | n/a until unblocked |
| F07 | Save flips status to accepted and removes Explore; Explore creates a project immediately and swallows errors | OPEN | Explore stays available for accepted candidates; Explore shows an explicit review/commit step with visible errors; Save/Explore states separated. | pending |
| F08 | Home decisions ignore their target (`void card`; goProjectTab('/project', {})) and read only the synthetic Home project | OPEN | Cards route by kind with target id + claim; account-wide roll-up needs a server endpoint — client targeting fixed now, aggregation recorded as server prerequisite. | partial→pending |
| F09 | Plan review shows revision metadata without plan content; decisions local-only | OPEN | Render the persisted plan body for the exact revision; fetch persisted decision records if the server exposes them (verify server surface first); otherwise record server prerequisite. | pending |
| F10 | No preview entry; repository selection never persisted | OPEN | Preview: server `previews` surface investigated and wired if it exposes URLs; repository persistence needs a server binding endpoint — investigate `server/repositories.ts` (bind endpoint exists per picker docs) and wire it. | pending |
| F11 | Search inert/no paging; Settings ignores `section`; profile clearing keeps old hours; memory scope never set; usage placeholder | OPEN | All five implemented client-side; usage additionally needs a server read model — implemented if budgets data is exposed, else honest BLOCKED. | pending |
| F12 | Tasks absent; automations lists projects; schedule mutations swallow errors; judge asks the user for scores; submission gaps unactionable; standalone delivery missing | OPEN | Per-item: schedules errors surfaced; automations aggregates real schedules; judge validates blank + honest labelling; submission gap links; tasks/standalone need server concepts — record prerequisites where absent. | pending |
| F13 | Implementation details shown as product copy (roll-up note, duplicated headings, "Run feed", deployment variables) | OPEN | Copy pass per surface; diagnostics into details. | pending |
| F14 | Two stale conversation-label tests; journey halted at its first assertion | OPEN | Assertions corrected to approved semantics; journey re-run end-to-end. | pending |
| F15 | Mobile tab count: three vs four conflict | NOT APPLICABLE WITH EVIDENCE | The owner established four tabs (Chat · Brief · Discover · Projects, Home IS Chat) directly in this session's conversation; the audit could not see that later exchange. Tab count stays four; the functional pane-leak fix (F04) applies regardless. | owner instruction, this session |

## Surfaces

| ID | Surface | Status | Repair / notes | Verification |
|---|---|---|---|---|
| S01 | Landing `/` | OPEN | Copy aligned to discovery-first; verify CTA → sign-in → Discover. | pending |
| S02 | Sign-in gate | OPEN | Fixed by F02; basepath link fixed by F05; live OAuth roundtrip remains device/credential-blocked. | pending |
| S03 | Desktop split shell | OPEN | Fixed by F01 (stable layout) + F03 (geometry). | pending |
| S04 | Mobile shell/composer | OPEN | Fixed by F04 + existing composer treatment. | pending |
| S05 | Home intro/primary action | OPEN | Matching-first copy; primary action reflects state (needs-you first when present). | pending |
| S06 | Home profile setup | OPEN | Accurate label ("a few fields"), real browse handoff after save. | pending |
| S07 | Home recommendations | OPEN | Join candidate details for readable cards (client join with the evaluated list). | pending |
| S08 | Home needs-you | OPEN | F08 client targeting; account roll-up = server prerequisite (documented). | pending |
| S09 | Home progress | OPEN | Show stage/deadline/next-action from real project data where recorded; distinguish unknown vs absent. | pending |
| S10 | Discover feed | BLOCKED(live)/OPEN(presentation) | Presentation simplified (single heading, honest states); live sources blocked per F06. | pending |
| S11 | Personalised suitability | BLOCKED | Server-side ranking by interests/hours — prerequisite as F06; eligibility/evidence distinction already rendered and kept honest. | pending |
| S12 | Browse/filter/search opportunities | OPEN | Client-side filters (saved/state/text) over the loaded account feed; server-side search of opportunities = with F06. | pending |
| S13 | Saved opportunities | OPEN | Saved filter + Explore-after-save (F07); unsave endpoint = server prerequisite. | pending |
| S14 | Opportunity details | OPEN | Readable detail emphasis; idea action; claim ids stay inspectable. | pending |
| S15 | Explore ideas → project | OPEN | Commit step (name + idea), visible errors, idempotent create (F07). | pending |
| S16 | Projects list | OPEN | Stage/next action from real data where recorded. | pending |
| S17 | Start from idea | OPEN | Idea form on `/onboarding` → creates the project → opens it (F05). | pending |
| S18 | Continue existing code | OPEN | Router-aware entry before any build project; repository connect path per F10. | pending |
| S19 | Project Overview | OPEN | Real fields replace hardcoded "deadline: none recorded"; padding via F03. | pending |
| S20 | Plan review | OPEN | F09 plan content. | pending |
| S21 | Approval history | OPEN | F09 persisted decisions (server permitting). | pending |
| S22 | Build/activity | OPEN | Preview entry per F10; activity secondary. | pending |
| S23 | Preview/change request | BLOCKED→OPEN | Wire the existing server previews surface if it serves URLs; real generated-app preview requires a completed build (credential-gated). | pending |
| S24 | Files/diffs | OPEN | Initial diff selection valid after load; readable content view where supported. | pending |
| S25 | Tasks | BLOCKED | No server task concept found — record prerequisite; entry points must not fake it. | pending |
| S26 | Account automations | OPEN | Aggregate real schedules client-side across the actor's projects + error state. | pending |
| S27 | Schedules | OPEN | Surface mutation failures; readable cadence; creation surface = server prerequisite. | pending |
| S28 | Evidence | OPEN | Source-first summary emphasis; keep hashes inspectable. | pending |
| S29 | Judge | OPEN | Blank-score validation + honest "you score, guided by rubric" labelling (the automated judge run itself is provider-gated). | pending |
| S30 | Submission | OPEN | Gap→section links; readable exports; keep never-submits honesty. | pending |
| S31 | Standalone delivery | OPEN | Standalone projects get export/share delivery framing without contest fields. | pending |
| S32 | Repository picker | OPEN | Bind via the real bind endpoint; hide collapses; removed repos not selectable. | pending |
| S33 | Account menu/sections | OPEN | `?section=` selects/scrolls/focuses; menu items carry it. | pending |
| S34 | Profile editor | OPEN | Explicit nulls + invalidation + friendly fields. | pending |
| S35 | Connections | OPEN | Reorder: user connection state first, deployment diagnostics secondary. | pending |
| S36 | Stacks | OPEN | Readable labels; honest proving note retained. | pending |
| S37 | Personal memory | OPEN | Provenance surfaced with records. | pending |
| S38 | Project memory | OPEN | Scope control wired to the API's project filter (verify server support). | pending |
| S39 | Search results | OPEN | F11 destinations + pagination. | pending |
| S40 | Usage | OPEN | F11 read model or honest BLOCKED. | pending |
| S41 | Conversation | OPEN | F01 stable mount, drafts, scroll. | pending |
| S42 | Not found/recovery | OPEN | Useful recovery links via router; drop SPA implementation note. | pending |
| S43 | Theme/a11y/responsive | OPEN | Covered by the final visual pass (light/dark, widths, focus). | pending |

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
  corrected in `65df59f5` + the scope-pill change; the audit's exact 8-file
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
