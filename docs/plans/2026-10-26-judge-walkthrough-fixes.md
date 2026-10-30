# Judge-walkthrough fixes — apply-ready spec

**Date:** 2026-10-26, Africa/Lagos. **Author:** Kiro (this session), from a full judge-persona
walkthrough of the local app (project `proj_8f9cb1aeea005c54dd52af005dc92627`, judge
`kiro-walkthrough`).

**Why this is a spec, not a diff:** every file these fixes touch is in the **overlap zone** and is
currently **uncommitted by the other agent** finishing the build-reliability continuation
(`docs/plans/2026-10-26-build-reliability-continuation-handover.md` §1): `coordinator.ts`,
`specialists.ts`, `host-context.ts`, `tools.ts`, `coordinator-host.ts`, `conversation/ReplyText.tsx`,
`ProjectWorkflow.tsx`, `Channel.tsx`, `draft-artifact.ts`, and the sha256-pinned skills. Editing them
now would collide with that work. Apply this spec **after** the other agent's wave is committed, one
integration owner, test-first with mutation discipline, explicit-file staging.

All evidence below is LOCAL VERIFIED from the walkthrough + the local D1 read-only
(`…/miniflare-D1DatabaseObject/c204843922…sqlite`).

---

## A. Build reliability (the blocker — already owned by the other agent)

Root cause of the judge build failing at feature 1 of 5 (behavior-tests 0/5 → retry 3/4 → blocked):

1. **IndexedDB absent in the test env.** The generated offline app stores in IndexedDB; the
   behavior-test runtime has none, so the first test run is 0 passing.
2. **Repair ladder was dormant.** `CADDIE_REPAIR_POLICY=repair-v1` is unset everywhere, so
   `repairPolicyVersion` was never stamped (`build_repair_issues`/`build_repair_attempts` empty for
   the run). The build fell back to the weak 3-attempt, single-model path instead of the committed
   6-attempt, 3-model escalation ladder (`repair-escalation.ts`, `6207f97`).
3. **Quality policy dormant too** (`CADDIE_QUALITY_POLICY=quality-v1` unset) — but per the handover
   this MUST stay opt-in until R2 (independent-acceptance executor) and R3 (state navigator) are
   actually implemented; defaulting it now makes builds fail (executor returns not-checked → pause).

**Planned fix (after the other agent lands R2/R3):** make the repair ladder default-and-only
(stamp `repair-v1` unconditionally in `openBuildSpendPayer`, `build-workflow.ts` ~L141), test-first,
with a test that fails if a build silently falls back to the weak path. Owner authorized the cost on
2026-10-26 (cost is bounded by the $5/build cap and only incurred when a feature is struggling).

---

## B. Coordinator under-delegates design/planning (model + quality)

**Finding (D1 evidence):** on the judge build, EVERY model call was `agentName=Coordinator` — 74 on
`Nemotron-3.5-Super-VL` (chat role), 2 on GLM-5.3-Flash, 2 Ultra (ideation). There were **no
`designer`/`product`/`frontend` specialist calls.** The coordinator did planning AND design itself,
inline, on its expensive chat model.

**This is NOT a providers.ts routing bug.** The role→model table is correct: `plan: 'glm-5.3-flash'`,
`build: 'nemotron-3.5-super-vl'`, and `specialistModelRole()` correctly maps the designer
(skills include `planning`) to `plan`. The problem is the coordinator **chooses not to delegate** —
`teamMode=0`, and its prompt permits doing the work inline.

**Consequence:** design/looks ran on Super-VL (~2× the Flash price the owner chose for planning/design)
and did not use the purpose-built designer prompt. Cost + quality both suffer.

**Fix (coordinator.ts prompt, ~L696, overlap zone):** make delegation of the designer step
mandatory, not optional, even with team mode off — "Always delegate the design/looks step to the
`designer` specialist; never author the design brief or looks inline." Keep the existing fallback
(if the delegate saves nothing, write the note directly) only for the PRD, not for design. Add a test
asserting a design-phase turn dispatches the designer declaration.

---

## C. The plan never proposes a marketing/landing page

**Finding:** `grep -rniE "landing page|marketing|homepage"` across `apps/app/src/agents/` returns
nothing in any specialist prompt. The `product` specialist shapes PRD + features but has no notion of
a landing/marketing page. A non-technical user won't know to ask for one; for a hackathon a landing
page is a scoring asset.

**Fix (specialists.ts `product` + `TEAM_MODE_PRODUCT_INSTRUCTION`, overlap zone):** add a line to the
product prompt — "Consider whether the app needs a simple landing/intro screen that explains what it
is and gets a first-time visitor to the main task; include it as a feature when it helps a non-technical
user or a judge understand the app in the first 10 seconds." Keep it a *consideration*, not forced, so
it doesn't bloat every tiny app. Add a planning test that a consumer-facing brief yields a
landing/intro feature.

---

## D. Design/frontend skills are thin

**Finding:** `agents/skills/design/SKILL.md` and `planning/SKILL.md` exist but are light; the manifest
pins each by sha256, so any edit must regenerate the hash in `manifest.json` (loaded via
`specialists.ts` — overlap zone).

**Plan:** research modern design-system / frontend-quality skills (component hierarchy, real-data
mocks, empty/loading/error discipline, responsive + a11y, visual rhythm) from reputable public repos,
and strengthen `design/SKILL.md`. Regenerate its manifest sha256. Test: the NET skill-registry
completeness check still passes; the skill loads.

---

## E. Non-blocker UI/UX issues (from the walkthrough)

Apply in `conversation/*.tsx` / `coordinator-host.ts` (overlap zone) once free:

1. **🔴 "Choose a look" preview defaced** — green highlight bars slash the thumbnail text, "Selected"
   chip clipped. First design a judge sees; looks broken. Finished screens render clean, so it's
   isolated to the look-thumbnail CSS/markup. (Highest-value cosmetic fix.)
   **Investigation 2026-10-26 (cause NOT yet pinned — do this first before editing):**
   - The look thumbnail IS iframe-isolated (`LooksPicker.tsx` → `mockDocument` → `srcDoc`, sandboxed),
     so the app's global `mark {}` rule (`workspace.css:7222`) and `.draft-text`/`.diff-line`
     line-through rules CANNOT bleed in. Ruled out.
     `LooksPicker.tsx` and `DesignMockPreview.tsx` are currently CLEAN (not in the other agent's set;
     only `InteractivePreview.tsx` is modified) — so this fix is likely collision-free when resumed.
   - The `design`/`looks` plan-note bodies for the judge project contain NO `<mark>` and NO
     `line-through`; the only "green" is prose ("one obvious green primary action"). So the bars are
     NOT in the generated mock HTML and NOT the global mark rule.
   - Remaining hypothesis to test next: the bars are an artifact of the SCALED thumbnail iframe (the
     small look-preview scales a full mock down — `design-mock__stage`), or a style inside the
     look's own caddie-theme block rendered at thumbnail scale. REPRODUCE against a live look-preview
     and inspect the iframe's computed styles before changing any CSS. Do not push a speculative fix.
2. **🟡 Engineer-speak leaks into chat** — raw IDs (`pdr_c1cdd490…`), internal agent instructions
   ("write_plan_note kind:'looks'", "camelCase onPrimary; density compact") shown to the user.
3. **🟡 Dense plan summary** — "IndexedDB", "integer kobo", "PRD", "kernel" in the right panel. Left
   card is well-pitched; right reads like engineering notes.
4. **🟡 "PRD was rejected" shown to the user** — honest self-correction reads like an error to a novice.
5. **🟡 Stale trailing line** after "Start this project" (said "press Start this project…" though the
   card had flipped to PROJECT STARTED).
6. **🟡 Step tracker lagged in the Design phase** (stayed on "1 Plan"; fine in Build).
7. **🟡 Ideation asks 3 questions in one message** — a one-answer user stalls; flow waits silently.
8. **🟡 "repair allowance" jargon** in the build-failure message; Retry gives no "why".
9. **🟡 Duplicate phrasing** — plan card "IS THIS OK?" vs body "Does this plan look right?".

## F. Strengths (keep; do not regress)

Grounded ideation (quotes the Nebius/NVIDIA rule, confirms eligibility); excellent AI-risk screen
(specific signal + cause + action); 6 real design states incl. empty/error; honest calm failure
handling with a plain-language feature checklist; clear safety-gated approvals; offline + naira
domain fit; strong specialist prompts (frontend: theme-vars-only, a11y, states; backend:
owner-checks, integer money, Workers-only).

## G. Corrections to my own earlier claims (for the record)

- "Composer loses/strands messages" — NOT an app bug; I was passing the element ref with a `ref=`
  prefix playwright-cli rejects, so my clicks silently no-op'd.
- "providers.ts design-model routing bug" — NOT a bug; the table is correct. The real issue is the
  coordinator under-delegating (§B).
- "Make both repair + quality default" — WRONG for quality; it must stay opt-in until R2/R3 exist.
