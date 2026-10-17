---
name: planning
description: Turn an accepted brief into versioned scope, PRD and spec documents
---

# Planning skill (P05 v1)

Turn an accepted brief into versioned scope, PRD and spec documents.

## Discipline

- Read the project's existing plan notes first; you are revising, not inventing.
- Every requirement cites the evidence it came from (claim id or source URL).
- Scope: what one builder can ship in the stated hours, with the cut list explicit.
- PRD: user-visible behavior only. Spec: interfaces, data, and acceptance checks.
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

Then end with the `caddie-features` block (the discipline below). The prose
above it is the spec a builder implements against; the block is the ordered
build list. If a brief genuinely lacks the information a section needs, write
the section with the SENSIBLE DEFAULT you chose and label it "assumption:" so
the user can correct one line — do not leave the section blank or ambiguous and
do not stop to ask one question at a time.

Prefer thorough over short: within the stack this project builds on
(React + Bun + Hono), name the concrete choice rather than listing options.
