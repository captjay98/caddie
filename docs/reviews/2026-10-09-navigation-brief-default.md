# Approved navigation — Brief-first implementation outline

**Date:** 2026-10-09 · **Status:** IMPLEMENTATION PLAN (owner-approved navigation decision)
**Supersedes:** the "Home" destination label in the discovery-first shell
(`docs/reviews/2026-10-08-surface-map.md` — updated in the same change).
**Evidence classes:** everything here is LOCAL VERIFIED unless stated; no
deploys, no paid calls.

## Approved navigation (from the owner brief)

- **Mobile:** four bottom tabs Chat · Brief · Discover · Projects; Chat is the
  initial default; floating rounded bottom bar + composer above it (preserved).
- **Desktop:** persistent conversation RIGHT; navigable content LEFT; **Brief is
  the default left-hand surface**; floating capsule inside the left panel:
  **Brief · Discover · Projects**; no full-width header; compact Search +
  Account.
- One root destination `/` renders Chat on mobile and Brief beside the
  persistent conversation on desktop. `?pane=` state stays explicit across
  resize/refresh/history.

## What changes vs. the built shell (2026-10-08 remediation)

| Area | Today | After |
|---|---|---|
| Desktop capsule | Home · Discover · Projects | **Brief** · Discover · Projects (label + testid `nav-brief`) |
| Mobile tabs | Chat · Brief · Discover · Projects | unchanged (already approved) |
| Desktop `/` left content | HomeBody (intro + Home-scope needs-you) | **Account Brief** (aggregated updates/decisions) with discovery primary action for new users |
| Brief data | `GET /api/projects/:home/brief` (Home scope only) | **`GET /api/brief`** — aggregated across every authorised project |
| Read state | none | **unseen/read** per card, persisted per actor (migration 0012), explicit-action semantics |
| Badge | none | unseen count on the Brief entry (capsule + mobile tab) |
| Chat for new users | empty transcript + "Message Caddie" | **deterministic welcome panel** (find hackathon / start idea / continue code) — no fabricated message, no model call |
| Chat urgent decisions | none | **compact notice bar** from real brief state, links to the exact review surface |
| Restoration | platform default only | **deep link > restored destination > platform default**, account-isolated |

## State / restoration / read semantics (concise)

1. **Read ≠ resolved.** Marking a card seen only records `(actorId, cardKey,
   seenAt)` in `brief_read_state` (migration 0012, PK actor+key). It never
   touches approvals, schedules, artifacts or runs. Opening Brief does **not**
   mark anything read. Cards are marked read by (a) clicking the card's
   primary action (navigates to the exact work first), or (b) the explicit
   "Mark all read" control.
2. **Card identity.** Each card gets a stable `key =
   <projectId>:<kind>:<primaryAction.targetId>` derived server-side from real
   rows (approval id, schedule id, artifact id, preview id, run id,
   candidate id). Grouping dedupes on `(kind, targetId)` per project, so one
   unresolved issue never repeats a card per event.
3. **Badge = unseen important updates** (unseen count from the account brief).
   Badges are absolutely positioned so they never shift tab alignment.
4. **Restoration precedence.** (1) explicit deep link / current URL wins;
   (2) otherwise a valid restored destination for the signed-in actor
   (`sessionStorage caddie:last-dest:<actorId>`, global destinations only,
   project param validated against the user's project list); (3) otherwise
   platform default — mobile Chat (`/`), desktop Brief + Chat (`/`). Restore
   is a one-shot `replace` navigation; account switching clears restored
   state because the key carries the actor id. A deleted/unauthorised project
   is dropped, never substituted.
5. **Conversation safety (unchanged).** Run creation stays lazy on first
   send (coordinator.ts) — opening a tab never starts a paid run; drafts and
   the transport key off the conversation scope; destination links strip
   stale `?pane=` (withoutPane, F04).
6. **Freshness/offline.** The payload carries `asOf`; refetch keeps the last
   known cards while updating (stale chip + "last updated …"); retrieval
   failure renders an explicit error with retry.

## Backend (smallest scoped support)

- `apps/app/migrations/0012_brief_read.sql` — `brief_read_state(actorId,
  cardKey, seenAt)` PK(actorId, cardKey). Append-only migration; every
  fixture harness + inline test list gets 0012 (the 0011 drift lesson).
- `server/brief.ts` — `accountBrief(db, actorId)`:
  - every project the actor can access (build projects + the Home scope for
    discovery): per-project `projectBrief` cards;
  - preview-ready cards (live previews, `primaryAction.kind: 'preview'`);
  - submission-unresolved cards (pending checklist gaps → "Prepare
    submission");
  - opportunity cards from **saved** discovery candidates (explicit
    local-seed wording — the live-source limitation stays visible);
  - grouping dedupe by `(kind, targetId)` per project; ranking
    needs-you → changed → blocked → handled, newest first within band;
  - `seen` join + `unseenCount`; `projects: [{id, name}]` for grouping UI.
- `routes/brief.ts` — `GET /api/brief` (session actor), `POST /api/brief/read`
  `{ keys }` (idempotent, actor-scoped).
- Contract: `DecisionCardSchema` gains optional `key` + `seen` (additive).

## Client

- `queries.ts`: `useAccountBrief`, `useMarkBriefRead` (invalidates the brief
  query + refreshAll).
- `Chrome.tsx`: nav id `home` → `brief` (routes.tsx staticData, capsule,
  MobileHeader, MobileNav); badge on both Brief entries; the Chat wrapper
  renders the welcome panel (new users: zero messages, not seen, general
  scope) and the notice bar (top unseen actionable card) above the Channel;
  restoration effect.
- `Shell.tsx`: HomeBody → BriefBody — account BriefLane (grouped by project,
  seen dot, freshness, mark-all-read), new-user intro panel with the three
  actions, then the existing Recommendations + Progress panels.
- `DecisionCard.tsx`: BriefLane account mode (group headers, seen marker,
  empty states: new user / "You're caught up" / error / stale).
- `surface.tsx`: RepositoriesPage zero-project branch — targeted "start a
  project to connect a repository" state (welcome tertiary action must work).

## Tests

- `tests/brief.test.ts`: accountBrief aggregation, grouping, read-state
  isolation (bob never sees alice's reads), explicit-action semantics at the
  service level.
- New `tests/browser/brief.spec.ts` (stubbed `/api/brief` + read): badge
  count; opening Brief does not mark read; action marks read + opens exact
  target; grouping; empty/caught-up states; welcome panel on first open +
  hidden after send; notice bar → exact review surface; **no POST /runs on
  tab open**; restoration per actor.
- Existing specs updated: `nav-home` → `nav-brief`, "Home" label assertions
  → "Brief", mobile header identity ("Caddie" on Chat, "Brief" on the brief
  tab), workspace/landing/journey suites re-run.

## Verification + deliverables

`bun run typecheck` · `bun run build` · `bunx playwright test tests/browser
--workers=1` · `bun run verify:packet P02/P11/P12` (touched packets) ·
screenshots at 390×844 / 768×1024 / 1440×900 of `/`, `/discover`,
`/projects` and a project route · docs update (surface-map, charter revision
note, ledger wave) · independent acceptance review against the owner brief.

Remaining honest limitations: discovery sources are still the local seed
(opportunity cards say so); live OAuth round-trip and real-device keyboard
acceptance stay device/credential-gated (viewport resizing is not a
device-keyboard proof).

## Independent acceptance review (2026-10-09, read-only agent)

20/20 acceptance checks PASS against the owner brief. Issues found and fixed
in the same change: the AccountBriefLane error state lacked its Retry action
(the fix had landed only in the project lane); stale "Home" copy/comments
(Channel no-project state, MobileNav/routes/ProjectTabs doc comments);
`groupCards` had no direct test (now exported + proven: dedupe on
(projectId, kind, targetId), newest wins, nothing lost across projects);
mark-all-read badge clearing is now proven END-TO-END (the stub's read state
is dynamic — the badge disappears and the unseen count drops after the
refetch).

Accepted, documented limitations (follow-up packets, separately owned):
- Brief actions open the exact project + surface; per-TARGET deep focus
  (e.g. highlight the specific revision/schedule/package) needs per-surface
  focus params — the opportunity action opens Discover, which has no
  per-candidate route yet.
- Welcome-hide-after-send is implemented via the transcript gate
  (`source.messages.length === 0`) but not end-to-end tested (would require
  stubbing the flue agent snapshot).
- Automated judge run, repository import persistence, persistent approval
  history, idea exploration before commitment, standalone delivery — recorded
  as PARTIAL/OPEN follow-up packets in the remediation ledger.