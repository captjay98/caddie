# Evidence — the look-and-feel picker (choose-a-look step)

**Date:** 2026-10-24
**Scope:** a new workflow step between plan approval and design, where Caddie
proposes 2–3 looks and the owner picks one; the designer then draws every screen
in the chosen look. Plus app-wide 44px touch targets.
**Classification key:** LOCAL VERIFIED / LIVE VERIFIED / SIMULATED / BLOCKED / FAILED.

## What shipped

A plan approval now enters a `looks` phase (Caddie prepares looks), stops at
`looks-review` for the owner, and only advances to `design` once a look is
chosen. The chosen look's theme is handed to the designer, who must carry it in
the brief unchanged.

Commits (local `main`, this session):

- `dfb9ee8` feat(contracts): the `caddie-looks` block and `parseLooks` (part 1, earlier).
- `cf1d47a` feat(looks): the choose-a-look step — migration 0044, `decideLooks`, the route, experience stages.
- `1d3bd4c` feat(looks): client status copy and routing for the look step.
- `700f51c` test(looks): the look step wired through every design-path harness.
- `fe9c28a` feat(looks): the agents taught the look step comes before design (coordinator, designer, design skill v1.2.0).
- `8ac4c84` feat(looks): the LooksPicker component, and 44px touch targets.

## The contract — LOCAL VERIFIED

`packages/contracts/src/looks.ts`, `tests/looks.test.ts` (8 tests). `parseLooks`
checks: the block exists and is JSON; 2–3 looks; slug ids; unique ids and names;
each look passes `validateAppTheme`; no two looks share both bg and primary; the
recommended look exists; exactly one `html-mock` key screen. Mutation-proven —
three mutations each failed their named test, then the file was restored
byte-identical.

## The server step — LOCAL VERIFIED

`apps/app/src/server/build-workflow.ts` + `routes/build-workflow.ts`.

- Migration `0044_looks_phase.sql` rebuilds `build_workflows` with phases
  `looks` / `looks-review` and two nullable revision baselines
  (`looksBaseline`, `designBaseline`). Applied to a **copy of the real local
  D1**: every existing row identical, the index preserved, the new phases
  accepted and a bogus phase refused by the CHECK.
- Stale-revision detection uses the revision-number baselines, not timestamps:
  a looks or design note from an earlier plan version is never shown as current,
  and a design written before the look was chosen cannot skip the choice.
- `tests/build-workflow.test.ts`: **92 pass / 0 fail**, including three focused
  look tests (choose → design in that look; "show other looks" → new looks; a
  stale/replayed answer records and sends nothing).

### Every design-path harness updated — LOCAL VERIFIED

A shared fixture (`tests/fixtures/looks-fixture.ts`: `saveLooks`, `chooseLook`)
carries approved plans through the look step. 11 harnesses apply 0044 and choose
a look before the design brief; stage expectations after approval move from
`design` to `looks`. The 19-file design-path run: **313 pass / 0 fail**, typecheck
clean.

## The agents — LOCAL VERIFIED

`coordinator.ts`, `specialists.ts`, `design/SKILL.md` (v1.2.0, manifest hash
updated). A LOOKS STEP instruction and a `looks_incomplete` continuation nudge
(parallel to `design_incomplete`) so a turn that ends without a saved
`caddie-looks` note cannot park the project in `looks`. The design step, the
designer specialist and the design skill now require the brief to carry the
chosen look's `caddie-theme` block unchanged. **Fixed a gap in the prior agent
work:** the design fallback nudge never mentioned the theme block, so Caddie's
own fallback design saves would be refused by the host — it now copies the
chosen theme. `tests/skills-solid.test.ts` + `tests/coordinator-followups.test.ts`:
**32 pass / 0 fail**.

## The picker — LOCAL VERIFIED (browser)

`apps/app/src/client/planning/LooksPicker.tsx`, wired into `ProjectWorkflow` for
`looks-review` (picker) and `looks` (a working state). Each look previews the
SAME shared key screen painted in its own theme (`themeToCssVars` inside the
same locked-down, script-free iframe `DesignMockPreview` uses).

`tests/browser/looks-picker.spec.ts`, against the composed build — **6 pass / 0
fail**:

- desktop: the three looks side by side, the recommended one picked, its button
  reads "Use Field-ready", the audience shown;
- phone: name tabs; picking the "Warm and bold" tab makes it the choice (the
  button reads "Use Warm and bold", its `aria-pressed` is true);
- no horizontal overflow at 320 / 390 / 412px, and the primary button, "Show
  other looks" and the tabs are all ≥44px tall.

![Desktop — three looks side by side](shots/looks-picker-desktop.png)
![Phone — name tabs, one look in view](shots/looks-picker-phone.png)

## Touch targets — LOCAL VERIFIED

`apps/app/src/client/workspace.css`: `.btn-key` / `.btn-ghost` (were 31–32px),
the phone `.project-step` tab (38px) and `.project-back` (32px) all lifted to a
≥44px minimum, with no page-specific exceptions. The ≥44px assertion above
covers the picker's own buttons and tabs at three phone widths.

## Not done here

- The full browser suite was not run (host memory pressure); the picker spec was
  run in isolation.
- Flutter theme mapping remains deferred.
- Owner decisions still open: the designer model route, and `delivery-checklist`
  keep-or-remove.
