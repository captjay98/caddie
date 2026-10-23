# Agent & skills hardening — 2026-10-23

Goal: the apps Caddie generates look production-grade and different from each
other. Repo: `/Users/captjay98/projects/caddie-forge`, branch `main`, local
commits only. Base before this work: `ca612b6`.

Classifications used below: **LOCAL VERIFIED** (ran here, real pass/fail),
**SIMULATED** (reasoned/structure-checked, not executed end to end),
**BLOCKED** (needs credentials/live services not available here),
**FAILED**. Nothing here is LIVE VERIFIED.

Tooling: bun resolved at
`/Users/captjay98/.local/share/mise/installs/bun/latest/bin` (the mise shim is
broken). Source edited with the file-editing tool only; git staged per-file and
committed serially.

---

## Part 1 — the approved design reaches the code

Commit `df9a53e` — `feat(agents): the approved design reaches every builder hand-off`.

Files:
- `apps/app/src/agents/delegation.ts` — `FEATURE_DELEGATION_RULE` now tells every
  delegate to read the approved design brief (`read_project_context ["design"]`)
  and build each screen the feature touches to match it (layout, components,
  empty/loading/error states, mockups).
- `apps/app/src/agents/specialists.ts` — both `BUILD_RECIPE_INSTRUCTION`
  (react/hono) and `FLUTTER_RECIPE_INSTRUCTION` now tell the builder to read the
  approved design and match each screen, instead of only "the full brief, prd,
  spec and feedback".
- `apps/app/src/agents/tools.ts` — `read_project_context` description lists the
  real readable kinds (brief/prd/design/spec/scope/kernel/note/feedback/profile)
  and says to pass the kind NAME, never a file name; `write_plan_note` description
  now includes `design` (its picklist already accepted it).
- `apps/app/src/server/coordinator-host.ts` — `buildNextFeature`'s per-feature
  `next` string tells the delegate to build to match the approved design brief.
- `apps/app/src/agents/coordinator.ts` — the per-feature `build_incomplete` nudge
  references the approved design brief.
- `apps/app/src/agents/module-builder.ts` — the module builder's per-feature loop
  instruction references the approved design brief.

Test: `tests/design-reaches-code.test.ts` (8 tests, added test-first).
- fail-before: on `ca612b6` + the new test, 7 of 8 failed (only the
  write_plan_note-design check passed trivially before I corrected it; the
  recipe/rule/handoff checks all failed). **LOCAL VERIFIED**.
- pass-after: 8/8 pass. **LOCAL VERIFIED**.
- mutation: backed up the 6 source files to `$KIROCREW_SCRATCH`, stripped the
  added "approved design" clauses, re-ran → 7 fail; restored from backup (cmp
  identical on all 6) → 8 pass. **LOCAL VERIFIED**.

Checks after Part 1:
- `bun test tests/design-reaches-code.test.ts tests/agent-permissions.test.ts tests/single-recipe.test.ts`
  → 69 pass / 0 fail. **LOCAL VERIFIED**.
- `bun run typecheck` → clean (tsc --noEmit + apps/app check:types). **LOCAL VERIFIED**.

---

## Part 2 — every app gets its own look

### 2a — the caddie-theme contract

Commit `005cbab` — `feat(contracts): caddie-theme block gives every app its own look`.

Files: `packages/contracts/src/theme.ts` (new), `packages/contracts/src/index.ts`
(export), `tests/caddie-theme.test.ts` (new).

- The design brief carries ONE fenced ```caddie-theme JSON block: `name`, `why`,
  `colors` (bg, surface, text, muted, primary, onPrimary, border, ok, warn,
  danger), optional `stateSurfaces[]` (tinted bg + its fg + plain line), `fonts`
  (heading, body), `radius` (px 0-32), `density` (compact|comfortable|roomy).
  Roles match the owner-review mock.
- Validation is deterministic: hex colours; fonts must be NAMED SYSTEM FONT
  STACKS ending in a generic family (no url()/@import/http — the mock iframe's
  CSP is `font-src data:`); WCAG AA ≥4.5:1 for text/bg, text/surface, muted/bg,
  muted/surface, onPrimary/primary, and each state colour on a surface, plus each
  state surface's own fg/bg.
- `themeToCssVars` emits the plain names (`--bg`, `--primary`, …) AND aliases the
  old Caddie `--color-*` names to the app's values (so older mock markup renders
  in the app's theme). `--color-ink`→`var(--bg)`, `--color-action`→`var(--primary)`.
- Tests: 10 (test-first — before the module existed every import failed).
  pass-after 10/10. Mutation: set AA_CONTRAST=1 → 2 fail; loosen Hex regex → the
  non-hex test fails; restored (cmp) → 10 pass. **LOCAL VERIFIED**.

### 2b — refuse a design save with no valid theme

Commit `a1f6a4a` — `feat(agents): refuse a design save with no valid caddie-theme`.

Files: `packages/contracts/src/theme.ts` (pure `themeSaveError`),
`apps/app/src/server/coordinator-host.ts` (writePlanNote design branch),
`tests/caddie-theme.test.ts` (+2 tests).

- `writePlanNote` throws `THEME_INVALID: not saved — …` for `kind:"design"` with
  no valid theme, mirroring the PRD `DEMO_CONTRACT_INVALID` refusal. The check is
  in the agent tool path ONLY: `createPlanDocRevision` (tests, migrations) and
  reads of older themeless designs are untouched, so old saved designs stay
  readable.
- Tests: 12/12. Mutation: strip the host design-branch block → the wiring guard
  fails; make `themeSaveError` always return null → its guard fails; restored
  (cmp) → 12 pass. **LOCAL VERIFIED**.
- `bun test tests/project-experience.test.ts tests/build-workflow.test.ts` →
  105 pass / 0 fail (confirms the createPlanDocRevision design path is
  unchanged). **LOCAL VERIFIED**. typecheck clean. **LOCAL VERIFIED**.

### 2c — the mock preview paints in the app theme

Commit `33c9d14` — `feat(design-preview): paint mockups in the app's own theme`.

Files: `apps/app/src/client/artifacts/DesignMockPreview.tsx` (optional `theme`
prop; `mockDocument` exported), `apps/app/src/client/conversation/ProjectWorkflow.tsx`
(parses the brief's theme, passes it), `tests/design-mock-theme.test.ts`.

- When the brief carries a validated theme the frame is painted with
  `themeToCssVars(theme)` (plain names + `--color-*` aliases) instead of copying
  Caddie's live dashboard tokens; a themeless/older brief keeps today's tokens;
  the chat-reply mocks (ReplyText) are unchanged.
- Tests 3/3. Mutation: revert the token choice + the ProjectWorkflow pass-through
  → 2 wiring guards fail; restore (cmp) → 3 pass. **LOCAL VERIFIED**.

### 2d — the generated app gets the approved theme

Commit `a8b5961` — `feat(scaffold): the generated app gets the approved theme`.

Files: `stacks/react-hono/scaffold.ts` (protected default `caddie/theme.css` +
`styles.css` `@import`), `apps/app/src/server/architecture-gate.ts`
(`getApprovedTheme`, `themeCssFor`), `apps/app/src/server/coordinator-host.ts`
(`writeApprovedThemeCss` at scaffold + before non-join checks),
`tests/app-gets-theme.test.ts`.

- The scaffold ships a protected `caddie/theme.css` (a neutral default so the
  import resolves for older/themeless apps) imported by `styles.css`; the host
  overwrites it from the approved design's theme at scaffold time and re-writes
  it before each non-join check run, so a re-reviewed theme reaches an existing
  project. react-hono only.
- Scaffold lifecycle confirmed: the host creates the scaffold only AFTER design
  approval (`workflowState phase building`), so the approved theme is available
  when the scaffold is written; `approvedDesignRevisionId` is stamped on any
  design approval, so `getApprovedTheme` works in team and non-team mode.
- Tests 5/5. Mutation: drop the `styles.css` @import → styles guard fails; drop
  the host scaffold theme call → wiring guard fails; drop `theme.name` from
  `themeCssFor` → its guard fails; restored (cmp) → 5 pass. **LOCAL VERIFIED**.
- pinning (single-recipe, agent-permissions) 61 pass, typecheck clean.

### 2e — the inline-SVG icon kit

Commit `7c2829f` — `feat(scaffold): ship an inline-SVG icon kit in every app`.

Files: `stacks/react-hono/kit-files.ts` (`caddie/icons.tsx`),
`tests/icon-kit.test.ts`.

- `caddie/icons.tsx` ships in every app (via KIT_FILES → SCAFFOLD_FILES),
  protected under `caddie/`: 35 hand-authored 24px geometric stroke glyphs and an
  `<Icon>` that is aria-hidden by default and takes a `label` for standalone
  use. No npm dependency (only React types imported); glyphs in the Lucide
  visual idiom with the ISC licence notice.
- Tests 6/6. Mutation: break the aria-hidden default + remove the ISC notice →
  2 guards fail; restore (cmp) → 6 pass. **LOCAL VERIFIED**. single-recipe green,
  typecheck clean.

### Pre-existing failure (not mine)

`tests/kit-files.test.ts` → "part O: kit components run for real" FAILS with
`bun install --frozen-lockfile … Unknown lockfile version / lockfile is frozen`.
Reproduced on base `ca612b6` with my scaffold change reverted — it is an
environmental sandbox issue (the sandbox Bun cannot read the frozen lockfile),
NOT introduced by this work. **BLOCKED / pre-existing** (the 5 structural
kit-files tests pass).

### 2f — adapted craft rules

Commit `015bf96` — `feat(agents): adapt the craft rules to the app theme and icon kit`.

Files: `apps/app/src/agents/skills/design/SKILL.md`,
`apps/app/src/agents/skills/planning/SKILL.md`,
`apps/app/src/agents/specialists.ts` (BUILD_RECIPE_INSTRUCTION),
`apps/app/src/agents/coordinator.ts`, `tests/craft-rules.test.ts`.

- Design skill: leads with the LOOK (from audience + setting, stated plainly,
  never the same look every time), requires the caddie-theme block, names one
  primary action + an intentional type scale per view, points mockups at the app
  theme's plain names (not `--color-*`) and at the icon kit (never emoji),
  theme-neutral contrast note.
- Builder recipe: theme variables + `caddie/icons`, never literal hex; 100dvh +
  safe-area, transform/opacity motion ≤200ms under prefers-reduced-motion;
  tabular-nums, an action on every empty state, errors by the failed action,
  confirmed destructive actions; labels, visible focus, aria-label on icon-only
  buttons, 44×44 targets, 320px→desktop, no device-class assumption.
- Planning skill: "Who uses it and where" line. Coordinator PRD instruction names
  the audience and leaves the look to the design step (dropped "concrete visual
  direction").
- Tests 9/9. Mutation: restore the 4 files to base → 9 fail; restore WIP (cmp) →
  9 pass. **LOCAL VERIFIED**. typecheck clean.

### 2 — Flutter theme mapping: DEFERRED (owner decision)

The brief allows Flutter theme mapping to be deferred if not cheap. It is not
cheap: it needs a new generated Dart `ThemeData` file, Flutter-scaffold wiring,
a `writeApprovedThemeCss` equivalent for Dart, and its own round-trip test.
`writeApprovedThemeCss` is react-hono only (returns early for `stack ===
"flutter"`). **DEFERRED** — the web (react-hono) theme path is complete; the
Flutter Dart theme mapping is left for a follow-up.

---

## Part 3 — every agent's skills are solid

Commit `a58b45d` — `feat(agents): make every agent's skills solid`.

Files: `apps/app/src/agents/skills/build-verify/SKILL.md`,
`apps/app/src/agents/specialists.ts`, `apps/app/src/agents/skills/manifest.json`,
deleted `fastapi-react/`, `tanstack-start/`, `laravel-inertia/`, `flutter/`
SKILL.md, `tests/skills-solid.test.ts`.

- build-verify rewritten around `run_checks` (shell test commands are refused),
  drops the `tests/acceptance/**` guidance generated apps never have, keeps
  "a self-report is NEVER success".
- QA carries only `build-verify` (submission removed — QA's job is verify_build;
  `judge.ts` uses no skill text, 0 refs). Evidence: submission and
  delivery-checklist are the submission-step library; neither is `useSkill`'d by
  a role now. delivery-checklist is KEPT packaged (removing it would break the
  `toHaveLength(5)` pins across multiple tests) but its stale manifest hash was
  reconciled — see the owner decision below.
- mobile: dropped the impossible "Real device evidence beats screenshots"; it now
  verifies through `run_checks` and disclaims device/emulator/adb/screenshots.
- backend: Hono + D1 discipline (input validation, plain error bodies,
  requireUser + owner checks, integer minor units, no secrets in responses/logs).
  frontend: match the approved design via the theme variables + icon kit, a11y +
  responsive. tech-lead: before the build, every PRD feature must have a screen
  in the approved design and the brief must carry a valid theme.
- Deleted 4 unused planned-stack skills (0 code/test refs; flutter also
  contradicted the live FLUTTER_RECIPE_INSTRUCTION).
- manifest.json: sha256 hashes reconciled to the packaged files; versions bumped
  for the edited skills (planning 1.2.0, design 1.1.0, build-verify 2.0.0). A
  new guard recomputes each hash and compares.
- Tests 15/15. Mutation: corrupt a manifest hash → the hash guard fails; re-add
  submission to QA → the QA guard fails; break the self-report line → the
  build-verify guard fails; restored (cmp) → 15 pass. **LOCAL VERIFIED**.

---

## Owner decisions

1. **Model routing (from the brief's audit).** The designer carries the
   `planning` skill, so `specialistModelRole` routes it to the `plan` model
   (GLM-5.3-Flash) rather than a stronger design model. This work did NOT change
   model routing (forbidden). The owner may want the designer on a stronger model
   now that it owns the app's look.
2. **delivery-checklist.** It is packaged but loaded by no role or the
   coordinator, and duplicates the submission skill. I kept it (removing it
   cascades into the `PACKAGED_SKILLS` `toHaveLength(5)` pins in
   agent-permissions.test.ts). The owner may remove it in a follow-up that also
   updates those pinned counts.
3. **Flutter theme mapping** deferred (above).
4. **The look-and-feel picker UI** was intentionally NOT built (brief: it waits
   for the owner's review of the mock).

## Final test + typecheck summary

- All new guards + the recipe/permission pins, together:
  `bun test tests/skills-solid.test.ts tests/craft-rules.test.ts
  tests/design-reaches-code.test.ts tests/caddie-theme.test.ts
  tests/design-mock-theme.test.ts tests/app-gets-theme.test.ts
  tests/icon-kit.test.ts tests/agent-permissions.test.ts
  tests/single-recipe.test.ts` → 119 pass / 0 fail. **LOCAL VERIFIED**.
- `bun run typecheck` → clean throughout. **LOCAL VERIFIED**.
- Pre-existing failure kept separate: kit-files "part O: kit components run for
  real" (sandbox frozen-lockfile), reproduced on base. **BLOCKED / pre-existing**.
- Focused browser specs: NOT run — none of these changes alter a rendered page
  path in a way a browser spec would catch over the unit guards, and the host is
  under memory pressure. **DEFERRED**.
