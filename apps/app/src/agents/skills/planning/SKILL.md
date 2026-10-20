---
name: planning
description: Turn an accepted brief into versioned scope, PRD and spec documents
---

# Planning skill (P05 v1)

Turn an accepted brief into versioned scope, PRD and spec documents.

## Discipline

- Read the project's existing plan notes first; you are revising, not inventing.
- Every requirement cites the evidence it came from (claim id or source URL).
- Scope: what one builder can ship in the stated hours, with the cut list explicit —
  but cut breadth, never the one thing that makes the demo worth watching.
- PRD: user-visible behavior only. Spec: interfaces, data, and acceptance checks.

## Quality bar: plan a demo, not a CRUD app

A complete PRD can still describe a toy. The plan is judged by what a judge can
see working in three minutes, not by how many tables it names.

- Name ONE real integration the core value depends on (usually Caddie's AI via
  `c.env.CADDIE.ai`, called from `src/server.ts`) and make it do real work on
  real input. It is not decoration, and a mock may never carry it.
- Mocks are allowed only where they do not carry the demo. A mock price feed,
  seed dataset or rule table may support a screen; it cannot be the product.
- Every feature must move the demo forward. If a feature would not appear in the
  three-minute path, cut it or explain in one line why it still matters.
- Prefer one deep, working flow over five shallow screens. A judge remembers
  the moment the thing did something they did not expect, not the settings page.
- The demo path must survive a skeptical judge: real input, a visible result,
  and a reload that still shows the saved state.
- Output goes through `write_plan_note` with `planRevision` set to the revision
  you were briefed on. Never edit history; append new revisions.
- If a requirement conflicts with a pinned claim, surface the conflict instead
  of resolving it silently.

## A PRD is COMPREHENSIVE on the first pass — never drip-fed

The user should not have to ask for the schema, then "it's not comprehensive",
then "there's still ambiguity". Write the WHOLE thing the first time. A PRD that
leaves a builder guessing is a failed PRD — specificity is the job, not an
upgrade you add when nagged. Every PRD you save MUST cover each of these
sections (write the heading even when a section is short, and say "none" rather
than omitting one):

1. **Overview & goals** — one paragraph on what it is and who it's for, then the
   explicit goals and NON-goals (what it deliberately does not do this cycle).
2. **User stories / flows** — the concrete things a user does, in order, each as
   a short "As a … I … so that …" or a numbered flow. No vague "manage data".
3. **Data model** — every table/entity with its FIELDS and TYPES, keys, the
   important constraints and indexes, and how records relate. Name real types
   (text, integer, timestamptz, integer-minor-units for money), not "etc.".
4. **API surface** — the endpoints the frontend calls (method + path + the
   shape in and out), or the explicit statement that it is local-only with no
   server API. Hono routes when there is a backend.
5. **Frontend** — the screens and the key components each needs, plus the
   empty / loading / error state for anything that loads or saves. Name the
   interaction pattern for each input (a form, a segmented picker, a list).
6. **Offline / sync** (when the brief says offline or PWA) — what is stored
   locally (IndexedDB / cache), what syncs, and the conflict rule.
7. **AI / integrations** — the SPECIFIC model or service, how it is called,
   what it is given and returns, and the fail-soft behavior when it is
   unavailable. Never "an AI model" with no name or call path.
8. **Success metrics** — how you know each goal is met, observably.
9. **Demo contract** — required, and checked when the PRD is saved. Use this
   exact shape (the labels are parsed, so do not rename them):

   ```
   ## Demo contract

   **One-line pitch:** what a judge hears first (one sentence).
   **Demo path (3 minutes):**
   1. the first thing the judge does, with real input
   2. the core value happening in front of them
   3. the result they can see and check
   **Real integration:** the model or service the core value depends on, the
   exact call path, and what the judge sees it do; when that call is
   `c.env.CADDIE.ai`, name the tier it waits on (`"fast"` or `"super"` — super
   is the deeper one, ~3.75x cost, for the call a judge watches). "None" is
   allowed only with a reason the app is still real.
   **Mocks:** every mocked thing and why it does not carry the demo; "None"
   when nothing is mocked.
   **Why this wins:** the hard part, and why a generic CRUD entry would lose.
   ```

   At least three numbered demo steps. The real integration cannot be a mock,
   and the path must be something a person can actually do in the preview.

Then end with the `caddie-features` block (the discipline below). The prose
above it is the spec a builder implements against; the block is the ordered
build list. If a brief genuinely lacks the information a section needs, write
the section with the SENSIBLE DEFAULT you chose and label it "assumption:" so
the user can correct one line — do not leave the section blank or ambiguous and
do not stop to ask one question at a time.

Prefer thorough over short: within the stack this project builds on
(React + Bun + Hono), name the concrete choice rather than listing options.
