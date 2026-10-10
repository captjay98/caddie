# Caddie v2 redesign — packets

Proposed addition to `docs/plans/2026-10-03-fresh-build/packets.md`. Same format and
procedure as P00–P17 ("Required task procedure" applies unchanged). Spec:
`docs/design/2026-10-10-v2/HANDOFF.md` (cited below as §n).

UI packets are `U01`–`U10`; backend gaps are `B01`–`B06`. The integration lead adds the
`PACKET_MAP` entries (end of this file) to `scripts/verify-packet.ts` and applies every
route/contract/migration change serially. Packet agents propose those changes in their
receipt instead of editing the files.

Order: U01 → U02 → U03, then U04–U09 in any order (each depends only on U01–U03),
U10 last. B-packets can run alongside U-packets; a U-packet whose control depends on a
missing B-packet ships the honest "not yet" state and is revisited when the B-packet lands.

Visual-only reversible changes use browser verification, not contrived unit tests.

---

## U01 — Shell, resizable Caddie panel and theme

**Owner:** Frontend engineer. **Dependencies:** P06.

**Create/modify:**
- `apps/app/src/client/workspace/Chrome.tsx`
- `apps/app/src/client/workspace/Shell.tsx`
- `apps/app/src/client/workspace/ConvResize.tsx` (new)
- `apps/app/src/client/workspace.css`
- `apps/app/src/client/main.tsx`
- `packages/ui/src/tokens.css` (only if a token is missing; no palette changes)
- `tests/browser/workspace.spec.ts`
- Proposal only: breakpoint decision (§3.1), `/caddie` alias in `routes.tsx`

**Tests:** `tests/browser/workspace.spec.ts`, `tests/browser/shell-v2.spec.ts` (new).

1. Breakpoints per §3.1 (or 768px if the owner keeps it): two-panel, overlay
   `min(420px,100vw)` with scrim, mobile single panel. Content column never under 520px.
2. Resizable Caddie panel per §3.2: 40% default, 340px min, `min(60%, vw−520)` max,
   drag, keyboard (←/→ 2%, Shift 10%, Home, End, Enter), double-click reset, percent
   tip, `role="separator"` ARIA. Persist the fraction; re-clamp on resize.
3. Closed rail (64px, character only) and full-screen (`?pane=channel`); remember
   open/closed per browser.
4. Desktop capsule: Brief · Discover · Projects + search + avatar; account menu shows
   name and sign-in provider.
5. Theme per §3.9: keep `caddie-theme`; write only on explicit choice; toggle button
   labelled with the target theme.

**Acceptance:** At 1440px the panel opens at 40% ±1px; dragging past the limits clamps;
the content column is ≥520px at every width ≥1081px; reload restores width and
open/closed; keyboard resize works with screen-reader values; loading a page never
writes `caddie-theme`. 390/768/1440, light/dark, reduced motion verified.

**Verify:** `bun run verify:packet U01` + `bun run typecheck` + `bun run build`;
`bun run test:browser -- U01`.

**Commit:** `feat(u01): v2 shell and resizable caddie panel`.

## U02 — Mobile tabs, "Ask Caddie…" bar, "Talking about" and plain words

**Owner:** Frontend engineer. **Dependencies:** U01. B05 for real per-scope threads.

**Create/modify:**
- `apps/app/src/client/workspace/Chrome.tsx`
- `apps/app/src/client/workspace/AskBar.tsx` (new)
- `apps/app/src/client/conversation/Channel.tsx`
- `apps/app/src/client/conversation/Composer.tsx`
- `apps/app/src/client/conversation/channel-store.ts`
- `apps/app/src/client/copy.ts` (new: the §6 word list as constants)
- Visible labels across `surface.tsx`, `ProjectTabs.tsx`, `states.tsx`
- `tests/browser/workspace.spec.ts`, `tests/browser/conversation.spec.ts`

**Tests:** `tests/browser/conversation.spec.ts`, `tests/browser/shell-v2.spec.ts`.

1. Mobile tabs Caddie · Brief · Discover · Projects; Caddie default on first open
   (keep the approved `/` + `?pane=` semantics from the 2026-10-09 doc).
2. "Ask Caddie…" bar above the tab bar on non-Caddie tabs; tap opens Caddie scoped to
   the thing on screen.
3. "Talking about" switch (Everything + active projects). Draft per scope (already in
   `channel-store`). If B05 hasn't landed, show one thread and label the switch as
   filtering, not separate chats; record as SIMULATED.
4. Rename every visible label per §6 using `copy.ts`. Keep paths, API names and
   `data-testid`s; update spec text assertions.

**Acceptance:** No visible "Home", "Chat", "Prove", "Ship", "Run N", "Revision",
"Automations", "Memory", "Usage" outside "For developers" folds (grep the built client
for the strings). Switching scope keeps each draft. 390px has no horizontal scroll.

**Verify:** `bun run verify:packet U02` + typecheck + build; `bun run test:browser -- U02`.

**Commit:** `feat(u02): mobile tabs, ask bar and plain words`.

## U03 — Character, page states and project header

**Owner:** Frontend design engineer. **Dependencies:** U01.

**Create/modify:**
- `packages/ui/src/Mascot.tsx` (new), `packages/ui/src/mascot.css` (new)
- `apps/app/src/client/states.tsx`
- `apps/app/src/client/workspace/ProjectTabs.tsx` → project header + step bar
- `apps/app/src/client/workspace.css`
- `tests/browser/workspace.spec.ts`

**Tests:** `tests/browser/shell-v2.spec.ts`, `tests/browser/states.spec.ts` (new).

1. `<Mascot mood size />` per §7 (flag block only), eight moods, reduced-motion static.
   Map moods from real state only (transport status, run status, pending approvals).
2. `StatePanel` loading/error per §3.8: title and steps stay, content replaced; keep
   existing state kinds.
3. Project header + Plan · Build · Check · Submit/Share bar per §3.7, step status in
   words from server data; gear → project settings (route from U08). Retire
   `ProjectSubTabs`.

**Acceptance:** No step shows green unless the server says done. Each mood has one
documented trigger. Error state keeps the page title. Favicon unchanged (§7).

**Verify:** `bun run verify:packet U03` + typecheck + build; `bun run test:browser -- U03`.

**Commit:** `feat(u03): caddie character, page states and project steps`.

## U04 — Brief and chat messages

**Owner:** Frontend engineer. **Dependencies:** U01–U03. B06 for the in-chat spend card.

**Create/modify:**
- `apps/app/src/client/workspace/Shell.tsx`
- `apps/app/src/client/brief/DecisionCard.tsx`
- `apps/app/src/client/conversation/Channel.tsx`
- `tests/browser/brief.spec.ts`, `tests/browser/conversation.spec.ts`

**Tests:** `tests/browser/brief.spec.ts`, `tests/browser/conversation.spec.ts`.

1. Brief per §4: date, title, ≤3 cards with one button each, trade-off card, deadline
   rows, folded done list; existing `GET /api/brief` + read state.
2. Chat message types per §3.6: folded working steps, result cards linking to screens,
   routine labels.
3. Unsent state: offline strip, "Not sent" with Send again · Edit · Discard reusing the
   idempotency key; "Draft from earlier" label.
4. "OK to spend?" card bound to the approvals API (needs B06; otherwise keep the
   current approval surface and record BLOCKED).

**Acceptance:** Never more than three Brief cards. Retry after a dropped send creates
exactly one submission. Spend card state follows the server after reload.

**Verify:** `bun run verify:packet U04` + typecheck + build; `bun run test:browser -- U04`.

**Commit:** `feat(u04): v2 brief and chat messages`.

## U05 — Discover, hackathon detail and Projects

**Owner:** Frontend engineer. **Dependencies:** U01–U03. B01 for Saved.

**Create/modify:**
- `apps/app/src/client/surface.tsx` (`DiscoverPage`, `ProjectsPage`)
- `apps/app/src/client/discovery/Results.tsx`
- `apps/app/src/client/repositories/RepositoryPicker.tsx` (reuse inside `import-repo`)
- `tests/browser/discovery.spec.ts`, `tests/browser/discovery-journey.spec.ts`

**Tests:** `tests/browser/discovery.spec.ts`, `tests/browser/discovery-journey.spec.ts`,
`tests/browser/projects-v2.spec.ts` (new).

1. Discover list per §4: For you · Saved, two filters, rows, hidden "can't enter" with
   reveal. Saved hidden until B01.
2. Hackathon detail: "Can you enter?", hand-in lines, folds, single "Find an idea";
   `explore-ideas` window creates the project only on confirm.
3. Projects cards with "Step N of 4 · <step>" text and bars; archived fold;
   **Bring your code** window (`import-repo`) on the GitHub installations/imports API.

**Acceptance:** Exploring ideas and cancelling creates no project. Import states that
Caddie only reads the repo first. Step bars match server stage state.

**Verify:** `bun run verify:packet U05` + typecheck + build; `bun run test:browser -- U05`.

**Commit:** `feat(u05): v2 discover, hackathon detail and projects`.

## U06 — Project Overview, Plan and Build

**Owner:** Frontend engineer. **Dependencies:** U03. B04 for stored plan decisions.

**Create/modify:**
- `apps/app/src/client/surface.tsx` (`ProjectOverviewPage`, `DesignReviewPage`,
  `RunsPage`, `ArtifactsPage`, `TasksPage`)
- `apps/app/src/client/planning/DesignReview.tsx`
- `apps/app/src/client/runs/RunInspector.tsx`
- `apps/app/src/client/artifacts/Viewer.tsx`
- `apps/app/src/client/tasks/Tasks.tsx`
- Proposal: redirects `/tasks`, `/artifacts` (§2)
- `tests/browser/artifacts.spec.ts`, `tests/browser/forge-journey.spec.ts`

**Tests:** `tests/browser/artifacts.spec.ts`, `tests/browser/project-v2.spec.ts` (new).

1. Overview: next step, app so far (preview), to-dos (`add-task`), folded recent.
2. Plan in the §4 order with folds and `#earlier`; `approve-plan` states the cap and
   goes through approvals; `request-changes`.
3. Build opens on the private preview; past builds as sentences; Activity · Files tabs;
   `run-drawer`; `change-request`.

**Acceptance:** Approving without a server approval id is impossible. Old `/tasks` and
`/artifacts` links land on the right tab. Code appears only under "For developers".

**Verify:** `bun run verify:packet U06` + typecheck + build; `bun run test:browser -- U06`.

**Commit:** `feat(u06): v2 overview, plan and build`.

## U07 — Check and Submit/Share

**Owner:** Frontend engineer. **Dependencies:** U03; P13.

**Create/modify:**
- `apps/app/src/client/surface.tsx` (`EvidencePage`, `JudgePage`, `SubmissionPage`)
- `apps/app/src/client/evidence/Drawer.tsx`
- `apps/app/src/client/judge/Scorecard.tsx`
- `apps/app/src/client/submission/Package.tsx`
- Proposal: redirect `/judge` → `/evidence?open=score`
- `tests/browser/submission.spec.ts`

**Tests:** `tests/browser/submission.spec.ts`, `tests/browser/check-v2.spec.ts` (new).

1. Check: "N of M ready", hand-in list with one fix each, judges' criteria with
   Caddie's read; `proof` drawer; `licence` window; personal "No judges here".
2. Score it yourself drawer: 1–5 + note per criterion, blanks named not zeroed, posts
   to `judge/scorecards`, disagreement callouts.
3. Submit (copyable Devpost fields, `video-link`, `record-submission`; Caddie never
   submits) and Share for personal projects.

**Acceptance:** A scorecard with any blank is rejected client- and server-side. No
submit-on-Devpost action exists. Personal projects show no contest rules.

**Verify:** `bun run verify:packet U07` + typecheck + build; `bun run test:browser -- U07`.

**Commit:** `feat(u07): v2 check and submit`.

## U08 — Settings and project settings

**Owner:** Frontend engineer. **Dependencies:** U01–U03. B03 for the notify toggle.

**Create/modify:**
- `apps/app/src/client/settings/Settings.tsx`
- `apps/app/src/client/settings/ProjectSettings.tsx` (new)
- `apps/app/src/client/memory/Memory.tsx`
- `apps/app/src/client/tasks/Schedules.tsx`
- `apps/app/src/client/surface.tsx` (`AutomationsPage`, `UsagePage`,
  `SchedulesPage`, `RepositoriesPage` become redirects)
- Proposal: project-settings route, `?tab=` on `/settings`, redirects (§2)
- `tests/browser/settings.spec.ts`

**Tests:** `tests/browser/settings.spec.ts`, `tests/browser/project-settings.spec.ts` (new).

1. Settings with 8 tabs and `?tab=`; Build tools from `/api/stacks` with ledger wording
   (react-hono "Being proven first", the rest "Later"); Spending from `/api/usage`;
   Appearance with theme + Reset Caddie width; facts with their source.
2. Project settings: General + `edit-description` (`PATCH /projects/:id`), Code +
   `connect-repo`, Routines + `new-routine`, What Caddie knows + `correct-memory`,
   Archive/delete + `delete-project` (typed name; archive-only until B-decision §8.4).
3. "Tell me when it's ready" toggles hidden until B03.

**Acceptance:** No tool shows "ready"/"verified" while `/api/stacks` says otherwise.
Empty description can't be saved. Old `/automations`, `/usage`, `/schedules`,
`/repositories` links land on the right tab.

**Verify:** `bun run verify:packet U08` + typecheck + build; `bun run test:browser -- U08`.

**Commit:** `feat(u08): v2 settings and project settings`.

## U09 — Quick search, search results, welcome, sign-in and not found

**Owner:** Frontend engineer. **Dependencies:** U01–U03. B02 for hackathon/chat search.

**Create/modify:**
- `apps/app/src/client/search/Search.tsx`, `surface.tsx` (`SearchPage`)
- `apps/app/src/client/onboarding/Start.tsx`
- `apps/app/src/client/states.tsx` (sign-in, not found)
- `tests/browser/auth.spec.ts`, `tests/browser/onboarding-v2.spec.ts` (new),
  `tests/browser/search.spec.ts` (new)

**Tests:** `tests/browser/auth.spec.ts`, `tests/browser/search.spec.ts`,
`tests/browser/onboarding-v2.spec.ts`.

1. ⌘K / `/` palette with "See all results for…"; results page with type labels,
   highlights, counted filters, 5 per page, empty/no-match/loading/error, honest
   "chats aren't searched yet".
2. Welcome intro per §4: lines with mood changes, name prefilled from
   `session.user.name` with the username rule, skip, replay, reduced motion; saves the
   profile name; then the existing three steps.
3. Sign-in with theme toggle; not found + missing project.

**Acceptance:** A GitHub login-only name (`captjay98`) leaves the box empty; "Ada
Lovelace" suggests "Ada". A name containing markup renders as text everywhere.
Pagination never requests past the total.

**Verify:** `bun run verify:packet U09` + typecheck + build; `bun run test:browser -- U09`.

**Commit:** `feat(u09): v2 search, welcome and entry screens`.

## U10 — Landing refinement

**Owner:** Frontend design engineer. **Dependencies:** P16, U03 (character). Supersedes
nothing in P16; it refines the ported landing.

**Create/modify:**
- `apps/site/src/pages/index.astro`
- `apps/site/src/components/Hero.astro`, `ProductDemo.astro`
- `apps/site/src/styles/site.css`
- `tests/browser/landing.spec.ts`

**Tests:** `tests/browser/landing.spec.ts`.

1. Plain-word steps and copy per §4 Landing; "Your brief" section; "What it can build"
   with feature-ledger statuses.
2. One "Request access" primary per viewport; "Sign in" outline; mobile bar hides at the
   closing card.
3. Character in wordmark/closing card; hero illustration of the v2 shell, labelled;
   theme toggle sharing `caddie-theme`, pre-paint, device default.

**Acceptance:** Page readable with JS disabled. Request access still reaches its real
endpoint. No more than one primary button visible at 390/768/1440.

**Verify:** `bun run verify:packet U10` + typecheck + build; `bun run test:browser -- U10`.

**Commit:** `feat(u10): refine landing for v2`.

---

## B01 — Saved hackathons

**Owner:** Backend engineer. **Dependencies:** P11.
**Create/modify:** `apps/app/src/server/discovery.ts`, `server/routes/discovery.ts`;
proposals: candidate status/flag contract, migration.
**Tests:** `tests/discovery-saved.integration.test.ts` (new).
1. Save/unsave a candidate without accepting it; list saved per actor.
2. Saved state isolated per account and project.
**Acceptance:** Saving never creates a project or acceptance. **Commit:** `feat(b01): saved hackathons`.

## B02 — Search: hackathons and chats

**Owner:** Backend engineer. **Dependencies:** P14.
**Create/modify:** `apps/app/src/server/search.ts`, `server/routes/profile.ts`;
proposal: search result `type` union.
**Tests:** `tests/search-isolation.test.ts` (existing; extend).
1. Add `hackathon` results from discovery candidates.
2. Message search over chat history (scope- and account-filtered), or record BLOCKED
   with the reason if the Flue session store can't be queried.
**Acceptance:** Counts and items stay inside permission scope. **Commit:** `feat(b02): search hackathons and chats`.

## B03 — "Tell me when it's ready" for build tools

**Owner:** Backend engineer. **Dependencies:** P12 notifications.
**Create/modify:** `apps/app/src/server/stacks.ts`, `server/routes/profile.ts`,
`server/notifications.ts`; proposals: contract, migration.
**Tests:** `tests/stack-notify.integration.test.ts` (new).
1. Toggle a per-actor subscription for a `planned` stack.
2. When a stack flips to `enabled`, one notification in chat and Brief per subscriber.
**Acceptance:** Subscribing to an `enabled` stack is rejected. **Commit:** `feat(b03): stack availability alerts`.

## B04 — Plan content and stored decisions

**Owner:** Backend engineer. **Dependencies:** P07, P11.
**Create/modify:** `apps/app/src/server/planning.ts`, `server/routes/discovery.ts`;
proposals: plan-doc sections contract, migration.
**Tests:** `tests/plan-decisions.integration.test.ts` (new).
1. Plan payload with summary, before/after, screens, rules check, left-out, versions.
2. Persist approve / suggest-a-change decisions per version, linked to the approval id.
**Acceptance:** A decision is bound to one version; a newer version needs a new decision. **Commit:** `feat(b04): plan decisions`.

## B05 — One chat thread per "Talking about" scope

**Owner:** Agent/runtime engineer. **Dependencies:** P05, P06. Read `docs/flue-contracts.md`.
**Create/modify:** `apps/app/src/client/coordinator.ts`, coordinator agent session keying.
**Tests:** `tests/browser/conversation.spec.ts`, `tests/conversation-scope.test.ts` (new).
1. Verify current behaviour first; record whether threads are already per project.
2. If not, key sessions by actor + scope; Everything is its own scope.
**Acceptance:** Switching scope shows only that scope's messages, after reload, with no
cross-account leakage. **Commit:** `feat(b05): per-scope chat threads`.

## B06 — In-chat spend approval card

**Owner:** Agent/runtime engineer. **Dependencies:** P03, P05.
**Create/modify:** coordinator tool part for approval requests; `conversation/Channel.tsx` card type.
**Tests:** `tests/approval-card.test.ts` (new).
1. Coordinator emits a typed approval part carrying the approval id and cap.
2. Allow / Not now call the approvals API; card state reloads from the server.
**Acceptance:** Card text can never approve anything without a server approval id. **Commit:** `feat(b06): in-chat spend approval`.

---

## Proposed `PACKET_MAP` entries (integration lead)

```ts
U01: { tests: [], browser: ['tests/browser/workspace.spec.ts', 'tests/browser/shell-v2.spec.ts'], live: [] },
U02: { tests: [], browser: ['tests/browser/conversation.spec.ts', 'tests/browser/shell-v2.spec.ts'], live: [] },
U03: { tests: [], browser: ['tests/browser/shell-v2.spec.ts', 'tests/browser/states.spec.ts'], live: [] },
U04: { tests: [], browser: ['tests/browser/brief.spec.ts', 'tests/browser/conversation.spec.ts'], live: [] },
U05: { tests: [], browser: ['tests/browser/discovery.spec.ts', 'tests/browser/discovery-journey.spec.ts', 'tests/browser/projects-v2.spec.ts'], live: [] },
U06: { tests: [], browser: ['tests/browser/artifacts.spec.ts', 'tests/browser/project-v2.spec.ts'], live: [] },
U07: { tests: [], browser: ['tests/browser/submission.spec.ts', 'tests/browser/check-v2.spec.ts'], live: [] },
U08: { tests: [], browser: ['tests/browser/settings.spec.ts', 'tests/browser/project-settings.spec.ts'], live: [] },
U09: { tests: [], browser: ['tests/browser/auth.spec.ts', 'tests/browser/search.spec.ts', 'tests/browser/onboarding-v2.spec.ts'], live: [] },
U10: { tests: [], browser: ['tests/browser/landing.spec.ts'], live: [] },
B01: { tests: ['tests/discovery-saved.integration.test.ts'], browser: [], live: [] },
B02: { tests: ['tests/search-isolation.test.ts'], browser: [], live: [] },
B03: { tests: ['tests/stack-notify.integration.test.ts'], browser: [], live: [] },
B04: { tests: ['tests/plan-decisions.integration.test.ts'], browser: [], live: [] },
B05: { tests: ['tests/conversation-scope.test.ts'], browser: ['tests/browser/conversation.spec.ts'], live: [] },
B06: { tests: ['tests/approval-card.test.ts'], browser: [], live: [] },
```

New spec files named here don't exist yet; `verify:packet` fails until each packet's
first slice adds them, which is intended.

## Prompt for each packet

> Implement packet `<ID>` from `docs/design/2026-10-10-v2/PACKETS.md`, following
> `HANDOFF.md` in the same folder. The HTML there is visual reference only: rebuild in the
> existing React components and `packages/ui` tokens; don't copy prototype markup, demo
> data or `caddie2.*` storage keys. Read `AGENTS.md` and `docs/flue-contracts.md` first.
> Propose route, contract, migration and ledger changes in your receipt instead of
> applying them. Classify evidence per `AGENTS.md` and run `bun run typecheck`,
> `bun run build` and `bun run verify:packet <ID>` before reporting.
