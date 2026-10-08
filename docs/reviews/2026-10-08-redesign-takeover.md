# Caddie — redesign takeover: findings & resolutions

**Date:** 2026-10-08 · **Status:** VERIFIED (LOCAL UI-state proof)
**Companions:** `2026-10-08-surface-map.md` (as-built surface map + backend
gaps), `2026-10-08-bottom-nav-visions.html` (as-built shell mockup),
`2026-10-08-product-charter.md` (language + amendment notes).

This records the takeover review of the mid-flight discovery-first redesign
(agent handoff, uncommitted working tree), the defects found by probing the
live shell, the owner corrections folded in, and the verification evidence.

## What the review found and fixed

### 1. The desktop shell scrolled as one document (root cause: sr-only spans)

**User-visible:** the whole page scrolled (scrollbar + wheel) AND the left
panel scrolled internally; the sticky navigation capsule scrolled away with
the page instead of floating; the "two panels scroll independently" layout
was broken. `document.documentElement.scrollHeight` was 8017px at a 900px
viewport.

**Root cause:** the `.sr-only` accessibility labels (1px absolute spans inside
conversation messages) had `position: absolute` but **no positioned ancestor
anywhere in the message → panel → shell chain**, so each landed against the
initial containing block at its static position — deep inside the clipped
transcript — inflating the document height and making the viewport scrollable.

**Fix:** `.msg { position: relative }` — the sr-only spans are now contained
by their message; the transcript scrolls internally, the document stays at
100dvh. Verified: `scrollY` clamps to 0 after `scrollTo(0, 9000)`,
`docScrollH == 900`, on every desktop route.

### 2. Conversation context label duplicated the name

**User-visible:** "Caddie · General · Caddie" in the conversation header.

**Fix:** the general label is just "General" (the prefix already names
Caddie): "Caddie · General". Project scope reads "Caddie · <project name>".

### 3. Mobile duplicated the global navigation

**User-visible:** the sticky desktop-style capsule (wordmark + Home ·
Discover · Projects) rendered on mobile too, alongside the floating bottom
bar with the same three destinations — the same navigation visible twice at
one breakpoint.

**Fix (owner direction):** mobile now uses a **page-aware header** instead of
the capsule: identity on the left ("Caddie" on Home, the page name on every
other destination), Search + Account on the right, theme moved into the
Account menu. The bottom bar owns navigation; the capsule is desktop-only.

### 4. Mobile four-tab amendment (owner correction)

The bottom bar carries **Chat · Brief · Discover · Projects**. Home IS Chat:
`/app/` lands on the conversation by default (`?pane=channel`); the brief
content (the desktop left panel's Home) is its own tab (`?pane=brief`).
Legacy `?pane=brief` resolves to the brief surface, `?pane=runs` to Build.
The composer stays above the bar; the conversation context chip + Back still
close it.

## What the review verified as sound (no change needed)

- **Locked shell decisions hold:** no full-width desktop header; content
  left / conversation right (desktop, mirrored from the Today reference);
  floating rounded capsule inside the left panel; independent panel scroll;
  three global destinations on desktop; mobile keeps the floating rounded
  bottom bar with the composer above it; safe-area padding + no content
  behind the fixed bar.
- **Conversation scoping:** general scope (Home project) on global/account
  routes, selected project on project routes, never silently retargets;
  drafts/transport keyed by scope; invalid `?project=` renders the explicit
  not-in-your-list state (browser-tested).
- **Discovery without a project:** account-scoped, works with zero build
  projects; Save never creates a project, Explore commits one (browser-
  tested, A–G journey).
- **Honesty:** no fabricated match scores/win probabilities/usage numbers;
  backend gaps (account brief roll-up, usage summary, discovery namespace)
  render explicit states and are listed in the surface map as
  DOCUMENTATION ONLY.
- **Legacy deep links:** `/discovery` redirects to `/discover` carrying
  `?project=`; `?pane=channel|brief|runs` accepted; refresh/deep-link
  retention via `?project=`/`?section=`.

## Verification evidence (LOCAL UI-state proof)

- `bun run typecheck` + `bun run build` — green, 0 collisions.
- Browser packets P01/P06/P07/P11/P13/P14 — all PASS (workspace 17,
  discovery 9, submission, conversation suites included).
- `discovery-journey.spec.ts` (A–G, one account end-to-end) — PASS.
- Unit/integration: routing 13, discovery, agent-permissions 34,
  home-chat-tools 3, auth 15 — PASS. (`memory.integration.test.ts` keeps its
  2 pre-existing fixture failures on clean HEAD — unrelated, flagged.)
- Shell probes at 390/360/768/1280/1440, dark + light: document locked at
  viewport height, internal panel scroll only, capsule sticky on desktop,
  page-aware mobile header + four-tab bar, single composer per breakpoint,
  no horizontal overflow.
- Representative screenshots: `docs/reviews/screenshots-2026-10-08/`
  (desktop home/discover/projects/project overview dark + home light; mobile
  home/discover/projects/project overview + conversation, dark + light).

## Limitations

- The reviewing model cannot view images in this session: visual acceptance
  was done via DOM/geometry probes (computed styles, bounding boxes, scroll
  metrics) instead of pixel inspection. The screenshots are captured for the
  owner's visual pass.
- Real mobile-keyboard behaviour (safe-area + keyboard resizing) is not
  verifiable from viewport resizing; noted as a device-test item.
- Live agent round-trips (real model replies through the new shell) need
  credentials; the composer/scoping paths are stubbed-proofs plus the
  fail-closed auth probe.
## Second review wave (owner live corrections, same day)

### 5. Decision cards overflowed the mobile viewport (413px at 390px)

**Root cause:** `.r-link { white-space: nowrap }` inside decision-card action
rows ("Start with the Channel — your first message begins a run") forced the
card's min-content width past the viewport; the card was a grid item with the
default `min-width: auto`.

**Fix:** `min-width: 0` on `.decision-card`; action links wrap
(`white-space: normal; overflow-wrap: anywhere`). Verified: widest element on
the brief page is 374px at a 390px viewport, `overflowX: false` everywhere.

### 6. Home panels had no padding

**Root cause:** `.card-surface` deliberately carries no padding (surfaces add
their own); the `.home-panel` cards never did — content ran to the card
edges.

**Fix:** `.home-panel { padding: 1rem 1.1rem }`.

### 7. Content sat under the floating bottom bar

**Fix:** mobile clearance raised to `calc(172px + safe-area)` for the taller
four-tab bar.

### 8. Page geometry was inconsistent (owner: "Discover and Projects have
entirely different padding/margins")

Home ran in a 760px column under the main's 1.1rem padding; Discover/Projects
ran in an 860px column inside a second 1.5rem wrapper. Unified to ONE
geometry: `shell-main` sides 1rem; `.shell-loading.shell-page` padding 0 (the
column owns vertical space); `.page-col`/`.home-brief` both `max-width: 860px`
with `0.6rem 0 1.2rem` vertical padding; `.settings-stack` sides 1rem.

### 9. The mobile header is now page-aware with per-page actions (owner)

Each destination's header shows its own identity and one relevant action —
refresh on Brief and Discover, "New project" on Projects — with the avatar on
the right. Search left the header and moved into the Account menu (stable
fallback entry, per the surface map). Brand reads as a title ("Caddie·",
17px), page titles at 18px. Desktop capsule unchanged.
