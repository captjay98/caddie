# Caddie — surface map & backend gap list (discovery-first)

**Date:** 2026-10-08 · **Status:** AS BUILT — navigation REVISED 2026-10-09
(owner-approved decision, `2026-10-09-navigation-brief-default.md`): the first
global destination is **Brief** (updates & decisions, default left-hand surface
on desktop); Chat is the mobile default tab; the Brief feed is the
ACCOUNT-wide aggregation (`GET /api/brief`) with per-actor read state. All
"Home" labels in this map read "Brief" from 2026-10-09.
**Companions:** `2026-10-08-bottom-nav-visions.html` (nav review),
`2026-10-08-product-charter.md` (product language),
`tests/browser/{workspace,discovery,discovery-journey,submission,conversation}.spec.ts`
(verification).

This maps every routed surface to its chrome scope, its conversation binding,
the REST it reads, and its browser-spec testids; then lists the backend gaps the
redesign surfaced but did **not** paper over.

## Mobile amendment (owner, same day, later)

The mobile bottom bar carries **four** tabs — **Chat · Brief · Discover ·
Projects** — not three. The conversation IS the mobile home: `/app/` lands on
the chat pane by default (`?pane=channel` semantics; `?pane=brief` shows the
Home brief content). The brief (this map's Home surface) is its own tab on
mobile; the desktop capsule keeps the three global destinations with the
conversation persistently on the right. Everything else in this map stands
unchanged.

## Mobile amendment (owner, same day, later)

The mobile bottom bar carries **four** tabs — **Chat · Brief · Discover ·
Projects** — not three. The conversation IS the mobile home: `/app/` lands on
the chat pane by default (`?pane=channel`); `?pane=brief` shows the Home
brief content. The brief (this map's Home surface) is its own tab on mobile;
the desktop capsule keeps the three global destinations with the conversation
persistently on the right. Everything else in this map stands unchanged.

## The one rule

Three global destinations — **Brief · Discover · Projects** — plus one persistent
Caddie conversation. Brief is the default left-hand surface on desktop; Chat is
the initial default on mobile (the same `/` root renders Chat on mobile and
Brief beside the persistent conversation on desktop). Everything else is either
an **account surface** (reached from the capsule's Search / Account controls) or
a **project-local tab**. The conversation binds to a *safe* scope: the account
**Home** project on global and account routes (**General**), the resolved
**selected project** on a project route. It never silently retargets to an
unrelated project.

## Global destinations

| Surface | Route | chrome `nav` | Conversation scope | REST read | Primary testids |
|---|---|---|---|---|---|
| Brief — updates & decisions | `/` | `brief` | General (Home project) | `/api/projects`, `/api/home-project`, `/api/profile`, **`/api/brief`** (account-wide aggregation + read state), `/api/projects/:home/discovery/candidates` | `brief-screen`, `brief-primary`, `brief-find-hackathon`, `brief-start-idea`, `brief-continue-code`, `profile-setup`/`profile-complete`, `home-recommendations`, `brief-lane-panel`, `account-brief-lane`, `brief-groups`, `brief-caught-up`/`brief-new-user` |
| Discover — account-level hackathons | `/discover` | `discover` | General (Home project) | `/api/projects/:home/discovery/candidates?evaluate=1`, `…/discovery/feed`, `…/discovery/candidates/:id/accept` (POST) | `discovery-results`, `explore-ideas-<id>` (primary), `save-candidate-<id>` (secondary), `eligibility-<id>`, `feed-gaps`, `discovery-error` |
| Projects — real builds + start paths | `/projects` | `projects` | General (Home project) | `/api/projects` (Home excluded) | `project-list`, `project-row-<id>`, `new-idea-project`, `import-repo-project` |

The persistent right panel (desktop) / `?pane=channel` view (mobile): `conversation-panel`,
`conv-context[data-scope=general|project]`, `conv-context-label` ("Caddie · …"),
`composer`/`composer-input`/`composer-send`, `draft-row`/`draft-retry`/`draft-discard`.

## Account surfaces (capsule Search / Account menu)

| Surface | Route | Conversation scope | REST | Notes |
|---|---|---|---|---|
| Search | `/search` | General | `/api/search?q&limit&offset` (permission-filtered) | real endpoint; out-of-scope items never appear |
| Automations | `/automations` | General | `/api/projects` (picks a project) | scheduled runs are per-project; entry routes to `/schedules?project=` |
| Usage & budget | `/usage` | General | — | honest gap, see below; `usage-panel`, `usage-budget-state` |
| Profile / Memory / Connections / Settings | `/settings` (+ `?section=`) | General | `/api/profile` (GET/PUT) | one page, `section` anchors |
| Onboarding / existing-code import | `/onboarding` | none (account) | `/api/repositories`, `/api/projects`, `/api/workspaces` | idea-first + repo import start paths |

## Project-local surfaces (only inside a project, all keep `?project=`)

Primary tabs — `project-tabs`, `project-tab-overview|plan|build|submission`:

| Tab | Route | chrome `nav` | Conversation scope | REST |
|---|---|---|---|---|
| Overview | `/project` | `project` | selected project | `/api/projects/:id/brief`, artifacts, run-bindings |
| Plan | `/design-review` | `project` | selected project | `/api/projects/:id/plan-docs` |
| Build | `/runs` (Activity) | `project` | selected project | `/api/projects/:id/run-bindings`, `…/artifacts` |
| Submission | `/submission` (Package) | `project` | selected project | submission package + evidence + judge |

Secondary sub-strips — `project-subtabs-build|submission`, `sub-tab-*`:

- Build: Activity `/runs` · Files `/artifacts` (`…/artifact-revisions`) · Automation `/schedules`.
- Submission: Package `/submission` · Evidence `/evidence` (`?project=&claim=` focus) · Judge review `/judge`.

Also project-scoped (linked from Overview/setup/onboarding, not in a strip):
`/repositories` (`…/repositories`), and run detail via `/runs`.

## Deep-link compatibility

The redesign renames navigation but must not orphan old URLs:

| Old | Behaviour now |
|---|---|
| `/discovery` | `beforeLoad` **redirect → `/discover`**, carrying `?project=` (never a dead end) |
| `/runs`, `/artifacts`, `/schedules`, `/design-review`, `/evidence`, `/judge`, `/submission`, `/project` | still valid; resolve under the **project** scope; `?project=` retained |
| `?pane=channel` | mobile: show the conversation full-height |
| `?pane=brief` / `?pane=runs` (legacy) | **accepted**, resolve to a real surface (Home brief / Build) instead of throwing |
| invalid / hidden `?project=` | **MISSING** — explicit "That project is not in your list", never a silent fallback to another project |

`routes.tsx` `validateSearch` accepts `project`, `pane ∈ {channel,brief,runs}`,
`section`; `validateEvidenceSearch` additionally accepts `claim`.

## Backend gap list

These are real server gaps the discovery-first UX works **around honestly**
(empty/explicit states), not fakes. Each is DOCUMENTATION ONLY until the server
adds it — no UI here claims LIVE VERIFIED for them.

1. **~~No account-wide brief roll-up~~ FIXED 2026-10-09.** `GET /api/brief`
   aggregates every authorised project's approvals / conflicts / stale
   artifacts / failed rounds / schedules / previews / submission gaps / saved
   opportunities, grouped per project, with per-actor read state
   (`POST /api/brief/read`, migration 0012).
2. **No read-only account usage / budget summary.** Budgets are enforced
   server-side per run (`server/budgets.ts`), but there is no account roll-up to
   read, so Usage shows "not exposed" rather than a number. *Needed:*
   `GET /api/usage` (spend vs budget per payer, read-only).
3. **No workspace list endpoint.** The P02 surface has no `GET /api/workspaces`;
   a first project bootstraps a "Home" workspace explicitly (POST). Fine for now
   (single implicit Home), but multi-workspace selection has no list to read.
4. **Discovery is piggy-backed on the Home project id.** There is no
   account-scoped discovery namespace; the client reads
   `/api/projects/:home/discovery/*` (the Home project stands in for the account
   scope). Works, but it is a naming/ownership stretch — a dedicated
   `/api/account/discovery/*` (or an explicit account-scope concept) would be
   cleaner and decouple discovery from the synthetic Home project.
5. **Conversation needs a project to exist.** The run transport binds a
   conversation to a **project run** (`/api/projects/:id/runs`). The "General"
   scope is therefore implemented as a conversation on the **Home project**, not
   a true project-less thread. A first-class account/generic conversation would
   remove that dependency.
6. **Home project is load-bearing.** `Project.kind='home'` + `ensureHomeProject`
   create one synthetic Home project per actor so Discover / general conversation
   exist with zero real builds. Any future "delete your last project" flow must
   protect the Home row from appearing in Projects or being deleted.
7. **Progressive profile has no recommendation weighting endpoint yet.** The Home
   profile fields (country/timezone/hours/experience) feed eligibility verdicts
   through discovery, but there is no `POST /api/recommendations`-style account
   ranking beyond the per-scope `…/discovery/candidates?evaluate=1`.

## Verification mapping (LOCAL UI-state proof)

Run against the composed build (`bun run build` → local workerd on
`127.0.0.1:4173`, SPA under `/app`). These are **route-interception UI-state
proofs**, not auth or live-data evidence — the single live, un-stubbed probe is
the fail-closed `/api/auth/status`.

- `workspace.spec.ts` (17): shell grammar, conversation scoping + never
  retargets, invalid-`?project=` MISSING, drafts/key/retry/discard/reload, list
  loading·error·denied·limit·offline, theme, keyboard, reduced-motion, no
  overflow at 390/768/1440, mobile single-composer, account menu → Usage.
- `discovery.spec.ts` (9): unauth fails closed, Discover with zero builds,
  eligibility/evidence/named gaps + no win-probability, Explore+Save (no bare
  Accept), Save creates no project / Explore creates one, Explore continues an
  existing linked project, denied classification, legacy `/discovery` redirect,
  capsule Discover from Home.
- `discovery-journey.spec.ts` (1): scenarios **A–G** in one account, end-to-end
  (Home→Discover→Save→Explore→project→Projects→scoped composer→MISSING).
- `submission.spec.ts`, `conversation.spec.ts`: judge/submission honesty + the
  composer/draft surface, updated to the `/app/project?project=` entry.
