# Caddie product charter — the loop, the language, the surfaces

**Date:** 2026-10-08 · **Status:** SUPERSEDED ON NAVIGATION (see revision below)
**Companion to:** `caddie-ui-review-board.html` (screen-level fixes) and
`2026-10-08-bottom-nav-visions.html` (the as-built shell). This document is the
level above them: what the product *is*, how it is organised, and what every
surface must say.

> **Revision — approved navigation (2026-10-09).** The navigation rows below
> are superseded by `docs/reviews/2026-10-09-navigation-brief-default.md`:
> the three global destinations are **Brief · Discover · Projects** (the
> first destination renamed Home → Brief and re-scoped as the account-wide
> updates & decisions feed with per-actor read state); Chat is the mobile
> default tab and the persistent conversation on desktop; Brief is the
> default left-hand surface. The product language (loop, workspace
> vocabulary, honesty rules) is unchanged.

> **Revision — discovery-first (2026-10-08, same day, later).** The loop-as-nav
> model in §1–§2 was replaced the same day. The product now exposes **exactly
> three global destinations — Home · Discover · Projects** — plus **one
> persistent Caddie conversation**. `Find / Plan / Build / Prove / Ship` are no
> longer nav slots: *Find* is folded into the **Discover** surface and *Plan /
> Build / Submission* live as **project-local** tabs inside a project. §1's five
> verbs stay the honest description of what Caddie *does*, but they are no longer
> the navigation. The rest of this charter (the chat-is-the-interface rule §4,
> the language rules §5, and the honesty invariants) still holds unchanged.
>
> **Mobile amendment (same day, even later).** The mobile bottom bar carries
> **four** tabs — **Chat · Brief · Discover · Projects**. Home IS Chat on
> mobile: the conversation is the default landing (`?pane=channel`), and the
> brief (the desktop left panel's Home content) is its own tab (`?pane=brief`).
> The desktop capsule keeps the three global destinations; the page-aware
> mobile header shows the wordmark on Chat and the page name elsewhere, with
> Search + Account on the right (theme moved into the Account menu).

---

## The diagnosis

The UI passed its screen-level review but fails a simpler test: a visitor —
technical or not — cannot read the product from it.

1. **The nav is a function list, not a story.** Brief · Runs · Discovery ·
   Judge · Submission · Schedules · Settings · Integrations: eight flat items
   in no order. Nothing tells a newcomer what this product does, in what
   order things happen, or where to go next.
2. **Half the product is invisible.** Plan review, Files, Evidence and
   Repositories are in no navigation at all — reachable only by knowing URLs
   or clicking cards that may not exist yet.
3. **No page says what it is for.** Every surface opens with an internal noun
   (Discovery, Judge coaching, Submission package, Artifact revisions) and no
   sentence about what the visitor is supposed to do there.
4. **The first thing a new user sees is an empty data pane.** Desktop home
   defaults to the Brief panel, which is empty on a fresh project — the
   product's actual spine (the conversation) shares the stage with nothing.
5. **Redundancy reads as confusion.** Settings and Integrations are two nav
   items for one page.

## The decision

### 1. The product is the loop

Caddie's entire reason to exist, in five verbs:

> **Find → Plan → Build → Prove → Ship**

The navigation *is* the loop. A person who reads the nav row understands the
product without a docs page: you find a contest, you approve a plan, Caddie
builds it, the work is proven, you ship the package. The home/workspace sits
outside the loop as the place the loop is steered from (the conversation).

### 2. Stage = nav item (one word each)

| Stage | Nav label | Primary route | Siblings (page tabs) |
|---|---|---|---|
| — | **Home** | `/` (workspace: chat + decisions + activity) | — |
| Find | **Find** | `/discovery` | — |
| Plan | **Plan** | `/design-review` | — |
| Build | **Build** | `/runs` (Activity) | Files `/artifacts` · Automation `/schedules` |
| Prove | **Prove** | `/evidence` | Judge review `/judge` |
| Ship | **Ship** | `/submission` | — |
| — | **Settings** | `/settings` | Integrations inside; Repositories `/repositories` linked from setup + onboarding |

Rules:

- Stages are verbs, destinations are nouns. Nav row reads `Home · Find ·
  Plan · Build · Prove · Ship` with Settings alone at the far right.
- Every destination is reachable from the nav in at most two clicks; stages
  with several surfaces carry a visible tab strip on each sibling page, so
  the siblings are never orphaned.
- Repositories is setup, not a stage: it stays linked from onboarding and
  Settings, and keeps its own route.

### 3. Every page answers two questions

Every page head is: **stage kicker** (FIND / PLAN / BUILD / PROVE / SHIP /
SETUP) + **plain-noun title** + **one-sentence lede** that says what is here
and what you do. The honesty copy the product is known for is folded into
the ledes, never dropped (e.g. Ship: "Prepare here, submit elsewhere — this
tool never submits anywhere.").

Titles in user language: **Hackathons** (not Discovery), **Plan review**
(not the gate sentence), **Activity** (not Runs), **Files** (not Artifact
revisions), **Automation** (not Schedules), **Evidence**, **Judge review**
(not Judge coaching), **Submission** (not Submission package).

### 4. The chat is the universal interface

Anything the product can do, the conversation can do — or hands you to the
exact screen that does it. **An agent reply that says "go create it yourself
somewhere else" is a bug**, not an answer. The owner stated this directly
after being told to create a project "outside of this chat": the home
conversation now creates real projects (`create_project` tool, same
permission-checked service as the REST route) and answers stack questions
from the real registry (`list_stacks`).

Rule for every future capability: if a specialist can do it, the chat can
start it; if only a screen can do it, the reply links to that screen with the
context carried over. Never a dead end, never a homework assignment.

### 5. Language rules

- User-facing nouns name what the user already knows: hackathons, plan,
  files, evidence, submission. Internal nouns (packets, revisions, claims,
  artifacts, specialists) remain in evidence/detail views, where they are
  precise — they never name a nav destination or a page title.
- Empty states say how to fill them; actions say what they will do before
  you do them.
- First run teaches the loop: the zero-project home shows the five-step
  strip (Find → Plan → Build → Prove → Ship) above the starting cards.

### 6. Visual feel (unchanged in kind, completed in degree)

The token system, 11px type floor, quiet tool strips, chat-as-spine layout
and light/dark seeds stay exactly as shipped. What this charter adds is the
missing *identity layer*: stage kickers, page titles with ledes, tab strips,
and the loop strip — the elements that make a set of screens read as one
product.

## Waves

- **Wave 1 (this commit):** stage nav, stage tab strips, page
  kicker/title/lede on all routed surfaces, tab vocabulary on the
  workspace (Decisions / Activity / Chat), five-step loop strip on first
  run, the missing /runs route behind the Build link, the chat-first tools
  (create_project, list_stacks), the draft-lingering fix, and spec updates
  for renamed navigation.
- **Wave 2 (needs server data in the chrome):** per-stage status dots in the
  nav (Plan: awaiting your approval · Prove: unreviewed scorecard · Ship:
  package ready); decision cards surfaced as a compact "Needs you" strip on
  Home; Repositories under Setup in the nav.
- **Wave 3 (only if the top row caps out):** left-rail layout replacing the
  top nav row; landing site half of the language pass.
