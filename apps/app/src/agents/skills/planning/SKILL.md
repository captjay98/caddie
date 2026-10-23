---
name: planning
description: Turn an accepted brief into versioned scope, PRD and spec documents
---

# Planning skill (P05 v1)

Turn an accepted brief into versioned scope, PRD and spec documents.

## Discipline

- Read the project's existing plan notes first; you are revising, not inventing.
- Every requirement cites the evidence it came from (claim id or source URL).
- Scope: complete connected user journeys within the platform’s supported
  execution, verified time and budget limits. Make any cut list explicit; the
  user’s available hours describe participation, not Caddie’s coding capacity.
- PRD: user-visible behavior only. Spec: interfaces, data, and acceptance checks.

## Quality bar: a useful app with a convincing demonstration

A complete PRD must describe a useful app whose connected workflows actually
work, not merely a collection of tables or attractive screens. For a contest,
the demonstration highlights that value in three minutes.

- Name ONE real integration the core value depends on (usually Caddie's AI via
  `c.env.CADDIE.ai`, called from `src/server.ts`) and make it do real work on
  real input. It is not decoration, and a mock may never carry it.
- Mocks are allowed only where they do not carry the demo. A mock price feed,
  seed dataset or rule table may support a screen; it cannot be the product.
- Every feature must serve an approved user journey. Supporting workflows
  still belong when they are necessary to complete that journey, even if they
  do not appear in a three-minute demonstration.
- Prefer one deep, working flow over five shallow screens. A judge remembers
  the moment the thing did something they did not expect, not the settings page.
- The demo path must survive a skeptical judge: real input, a visible result,
  and a reload that still shows the saved state.
- Output goes through `write_plan_note` with `planRevision` set to the revision
  you were briefed on. Never edit history; append new revisions.
- If a requirement conflicts with a pinned claim, surface the conflict instead
  of resolving it silently.

## Plan for a person who has never coded

The user describes a useful app; Caddie owns the implementation choices. Do not
ask them to choose a database, API design, framework, specialist role, or test
tool. Choose supported defaults from the project and platform, and record them
in the technical specification. Do not treat the user's available hours as the
number of coding hours Caddie has: those hours describe their participation.
Use verified delivery constraints and platform limits when reducing scope.

The default review must feel like a short note from Caddie, not a PRD dump.
Write the overview in at most two short sentences, using ordinary words. Give
journeys short names that explain the user's task, without implementation
terms or editorial labels. Keep fields, endpoints, model tiers, individual test
steps and detailed reasoning in the technical specification. State material
exclusions and limitations plainly; do not hide a reduced capability in jargon.

Before the technical specification, write these readable sections in the first
saved PRD, with all meaningful choices already resolved:

- **What your app will do:** concrete, connected user journeys and their results.
- **Who uses it and where:** one plain line naming the audience and the setting
  they use it in (a farmer in bright sun on a phone; an accountant at a desk).
  Keep it short and readable — it is what the design step uses to choose the
  app's look, so it must be honest about who and where.
- **Included in this version / left for later:** explicit boundaries. Do not
  quietly replace a requested capability with a smaller or simulated one.
- **Important limitations:** assumptions, unavailable integrations, offline
  limits, and meaningful compromises. For example, text interpretation is not
  photo analysis; call out that difference before asking for approval.
- **How Caddie will check it works:** observable behavior, including saving,
  reopening, permissions, errors and recovery where relevant.

Ask a follow-up only when the missing answer materially changes the user's
workflow, privacy, costs, or scope and cannot be safely defaulted. Bundle those
necessary choices. Later questions should concern new requirements or genuine
scope adjustments, not fill holes in the first plan. Keep the exact demo
contract and feature block below; these readable sections do not replace them.

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
