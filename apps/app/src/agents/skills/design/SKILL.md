---
name: design
description: Turn an approved PRD into a comprehensive, reviewable design brief with a visual mockup
---

# Design skill (v1)

The PRD is approved. Your job is the DESIGN STEP: turn that PRD into one
comprehensive design brief the user can review and approve BEFORE any code is
written. A design brief is not "some notes about the UI" — it is the spec a
builder lays out screens against, and it carries a VISUAL mockup so the user
approves something they can SEE, not only read.

## Discipline

- Read the approved PRD first (the latest `prd` plan note) and the project's
  design system. You are translating a settled PRD into screens, not reopening
  product decisions. If the PRD is genuinely ambiguous about a screen, choose a
  sensible default and label it `assumption:` — never stop to ask one question
  at a time.
- Save the brief through `write_plan_note` with `kind: "design"` and the
  `planRevision` you were briefed on. Append a new revision; never edit history.
- A design brief carries NO `caddie-features` block — that belongs to the PRD.
  The design brief describes HOW the approved features look and behave.
- After you save ONE design brief, STOP for review. Do not build. The build gate
  stays closed until the design review is approved.

## A design brief is COMPREHENSIVE — never drip-fed

Write the whole thing the first time. Every brief MUST cover each section (write
the heading even when short; say "none" rather than omitting one):

1. **Screen inventory** — every screen/route the app has, each with its one-line
   purpose and how the user reaches it. No vague "a few screens".
2. **Key-screen layouts** — for each primary screen, the layout in words: the
   regions top-to-bottom, what sits in each, the hierarchy (what is the one
   primary action), and how it reflows on a narrow (≤390px) phone. Name the
   real components, not "some cards".
3. **Component & token choices** — the concrete components each screen uses and
   the design-system tokens they paint with (color, spacing, radius, type
   scale). Every surface names a background AND its text color together — never
   a bare background. Name the input pattern for each field (a form, a
   segmented picker, a searchable select, a tri-state radio) — not just "an
   input".
4. **Empty / loading / error states** — for ANYTHING that loads or saves, the
   three states explicitly: what the empty state says and offers, what loading
   shows, and the honest error with its recovery action. A screen with data is
   not designed until its no-data and failure states are designed.
5. **Interaction & motion** — the important transitions and when motion carries
   meaning (ordered steps, change over time), plus the still default. Respect
   reduced-motion.
6. **Accessibility** — focus order, keyboard operability for every custom
   control, labels, and contrast (text on its surface must be legible in the
   app's dark default). Call out anything that needs an aria role.

## Craft rules (hold these, they are the point)

- Warmth over coldness: this is a tool for a solo nontechnical builder. Reassure,
  don't lecture. No meta copy that explains the interface to itself.
- Use the project's Icon set — NEVER emoji — for glyphs.
- No double padding, no box-in-box: one framed surface, not a card inside a card
  inside a panel. No header/title duplication (one kicker + one page title).
- Prefer segmented pickers and searchable fields over long dropdowns; short copy
  on mobile.
- Never render a section heading with nothing beneath it — show an honest state
  with an inline action instead.

## The visual mockup (what makes this step worth having)

Reading a described layout is not the same as seeing it. Alongside the prose,
include mockups the review card can render. The user switches between them with
a screen picker and checks each at phone (390px) and desktop (1280px) width.

- One `html-mock` fenced block PER SCREEN OR STATE, with the screen's name after
  the info string. Mock the key screen, then its empty state and its error
  state (and loading, if that screen loads data). At most 6 blocks:

  ````
  ```html-mock Today
  <main>…the key screen, real structure…</main>
  ```

  ```html-mock Today · empty
  <main>…the same screen with no data, and what it offers…</main>
  ```

  ```html-mock Add entry · error
  <main>…the honest error and its recovery action…</main>
  ```
  ````

- Style ONLY with the design-system tokens, never a literal hex or `bg-white`.
  The roles are fixed — get them right:
  - `var(--color-ink)` is the PAGE BACKGROUND (dark in the default theme), never text.
  - `var(--color-bright)` is the main TEXT; `var(--color-muted)` secondary text.
  - `var(--color-panel)` / `var(--color-raised)` are card and raised surfaces;
    `var(--color-line)` / `var(--color-line-soft)` are borders.
  - `var(--color-action)` fills the one primary action, with its label in
    `var(--color-ink)`; `var(--color-ok)`, `var(--color-warn)`,
    `var(--color-danger)` mark states.
  Set every surface's background AND text color together. The frame already
  paints the page background and body text, so a mock only styles its own parts.
- Static markup only: no `<script>`, no external assets or fonts, no network,
  no `<form action>`. The frame runs no scripts at all. Interaction that CSS can
  show is welcome: `:hover` and `:focus-visible` styles, `<details>`/`<summary>`
  for expandable parts. Click-through between screens is the picker's job.
- Lay each screen out fluidly (no fixed page width) so the same markup reads at
  390px and at 1280px — the phone view is how the user checks your reflow.
- Keep it focused: the screens and states that carry the product's feel. The
  prose inventory covers every other screen.

If a brief genuinely cannot carry a mockup yet (e.g. the design system has no
token for something central), say so in one line under the Component section and
proceed with the prose — do not invent a palette.
