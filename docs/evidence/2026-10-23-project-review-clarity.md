# Project review clarity — 2026-10-23

## User-directed result

The first Plan implementation expanded raw PRD sections into the main reading flow. The user correctly identified this as a regression: changing the heading to “What your app will do” did not turn a technical document into a readable review. The correction makes the default concise and lets interested users expand the details.

The existing Farmhand v2 PRD was read from local D1 in read-only mode and used for a browser fixture. No saved plan, approval, build or project data was changed.

## Changes

- `planning/PlanReview.tsx`: one short overview excerpt, compact expandable journeys, optional complete feature list, and expandable scope, assumptions and acceptance criteria. The raw PRD heading and Overview/Goals blocks no longer fill the default screen. Approval follows the review; the complete saved specification remains available below it.
- `planning/plan-sections.ts`: preserves original text and citations, groups sections, extracts explicit journeys, and exposes material qualifications. Farmhand's actual document now gives four journey rows rather than a duplicate technical feature/test dump. Technical-backbone and editorial headings are not presented as user journeys. Photo-analysis uncertainty and incomplete role screens are short visible callouts; the underlying exact wording stays inspectable.
- `planning/DesignReview.tsx`: keeps the version/status header with Caddie and moves approval/change controls after the review. Existing revision-bound approval, change feedback and settled-decision protections are retained.
- `project/FeatureChecklist.tsx`: optional `showChecks={false}` separates a feature list from its acceptance criteria without altering the build list or its semantics.
- `runs/RunInspector.tsx`, `runs/run-status.ts`: the previous default “A build ran … on react-hono” was based on a saved binding, not proof of execution. It now says “Build request recorded … Its result is not confirmed here.” The template identifier appears in developer details, and the toggle says “View build record.” A completed attempt does not claim that application checks passed.
- `surface.tsx`, `submission/Package.tsx`, `workspace.css`: Caddie accompanies Check's empty/active view and Submit's heading. Neutral/needs states do not imply readiness. Responsive disclosure targets and layout follow the existing design.
- `agents/skills/planning/SKILL.md`, `manifest.json`: planning instructions now specify sensible technical defaults, complete connected journeys, readable first-pass summaries and only material follow-up questions. The planning skill version is 1.1.0 with an updated content hash. User participation hours are distinct from Caddie's coding capacity. The exact machine-readable feature block and required demo contract remain intact.

Representative presentation logic:

```tsx
<details data-testid="plan-checks">
  <summary>How Caddie will check it works · {checkCount} checks</summary>
  {/* Exact saved criteria are available here; they are not a passing result. */}
</details>
```

Truthful build history:

```ts
case 'recorded': // the default path
  return `Build request recorded ${when}. Its result is not confirmed here.`;
```

## Final evidence

LOCAL VERIFIED:

- `bun run typecheck` — root and app exit 0.
- `bun test tests/plan-presentation.test.ts tests/build-presentation.test.ts tests/build-timeline.test.ts` — **31 pass, 0 fail, 109 assertions**. Covers section grouping, source preservation, explicit caveats including wrapped paragraphs, short overview/journey extraction, and truthful run status.
- `bun run build` — exit 0, composition collisions 0. Packages the changed planning prompt and client. The existing large-client-chunk warning remains.
- `git diff --check` — exit 0.

SIMULATED: six local Playwright checks passed against the running dev SPA with fixture APIs:

1. Plan feature list and acceptance criteria remain readable and inspectable without raw feature JSON.
2. Approval admits the correct build and acknowledges its durable key.
3. Change feedback requires text and survives a new revision/reload.
4. Material qualifications stay visible; scope/checks/specification are optional; approval follows the review.
5. Check and Submit show appropriate Caddie states; build history separates a request from a result and retains developer metadata.
6. Farmhand's **actual saved v2 PRD**, loaded into a fixture, defaults to four compact journeys and less than 1,400 characters of visible review text. No PRD title, Overview dump or integer-naira implementation prose is visible by default. Verified at 1456px, 390px and 320px, without horizontal overflow.

Browser command used a temporary configuration pointing the repository workflow suite at `http://localhost:5176`; the actual-PRD check was appended only to the temporary suite so the real project's document is not committed as a fixture. Screenshots were inspected at `/tmp/caddie-farmhand-plan-compact-390.png`, `/tmp/caddie-check-390.png` and `/tmp/caddie-submit-390.png`. Existing history expectations in `project-v2.spec.ts` and `workspace.spec.ts` were updated; those complete suites were not run in this pass.

## Limits

The planning instruction change is DOCUMENTATION ONLY as evidence of model behaviour: it is packaged successfully but no paid/model generation was run. This pass does not prove that a newly generated first plan will satisfy the instructions. Existing plans are presented without silently revising what was approved. The short overview is a saved-text excerpt, not an AI rewrite; older plans may still use technical wording inside optional details.

No live build, repair, external submission, commit or deployment was performed. Source and screenshots demonstrate local UI behaviour; mocked API responses do not establish live provider or application readiness.

## Follow-up: minimal header and one full-plan view (latest approved design)

This supersedes the earlier accordion presentation described above. The user approved moving context behind Info and replacing the Plan fold stack with plain rows and one optional detail view.

- `workspace/ProjectTabs.tsx`: Info sits immediately left of Settings. Description, linked event, eligibility and deadline move into “About this project.” Exact timestamps use the existing `deadlineTime` formatter with the profile timezone; date-only deadlines explicitly retain their unknown closing time. An urgent/closed deadline remains outside Info. The Plan page's supporting resources are passed into this dialog and mounted only when opened.
- `project/ProjectDialog.tsx`: shared native `<dialog>` gives modal focus containment, Escape, focus restoration and an explicit close button. CSS renders a bottom sheet on mobile and centered dialog on desktop. Content is mounted on demand; backdrop clicks close only when outside the dialog bounds.
- `planning/PlanReview.tsx`: short overview, four plain Farmhand journey rows, concise material caveats, decision controls and one “Explore the full plan” action. No default journey, scope or checks accordions. The larger optional dialog has Scope, Checks and Technical specification tabs, including keyboard arrow/Home/End navigation.
- `planning/DesignReview.tsx`: the exact revision hash and earlier-version list move into the technical view. The architecture component moves into optional Scope. Earlier versions remain readable without approving or restarting anything.
- `surface.tsx`: Plan's supporting-resource stack moves into Info instead of remaining below the main decision.
- `workspace.css`: scoped header icon, responsive native dialogs, quiet explore action, plain journey rows and section tabs.

Representative use:

```tsx
<ProjectDialog open={infoOpen} onClose={() => setInfoOpen(false)} title="About this project">
  {/* Full saved description, event and deadline; no clipped header copy. */}
</ProjectDialog>
```

LOCAL VERIFIED: final typecheck, production asset build (composition collisions 0), `git diff --check`, and **31 unit checks / 109 assertions** pass. The existing bundle-size warning remains.

SIMULATED: **8 browser checks pass**, with fixture APIs against `localhost:5176`:

1. Feature list and acceptance criteria remain accessible through the full-plan view.
2. Plan approval still admits the correct build through the existing server-owned path.
3. Change feedback and revised plans survive reload.
4. Material warnings stay on the page; Scope/Checks/Technical content is inspectable in the modal; keyboard tabs and Escape/focus restoration work.
5. Info placement, complete description, contest link and local deadline work at 1456/390/320px. A 23:59 UTC deadline correctly displays on the following day in Africa/Lagos. Hidden content and resources are absent until opened; no horizontal overflow.
6. An urgent deadline stays visible without opening Info. A date-only deadline never invents a local closing hour.
7. Earlier versions and their exact revision hash remain inspectable; viewing them records no decision/admission.
8. Farmhand's actual saved v2 PRD (read-only local data injected into a temporary fixture) shows four plain journey rows and no default folds, with under 900 characters of visible review text at 1456/390/320px. Its eight features and individual checks remain accessible in the modal.

The temporary browser configuration reused the repository suite and appended the actual-PRD check; no real model/build was run. Screenshots inspected: `/tmp/caddie-farmhand-minimal-390.png`, `/tmp/caddie-project-info-390.png`, `/tmp/caddie-full-plan-390.png`. One initial test used the wrong selector for the existing copy-hash control; correcting that selector produced the final 8/8 result.

No commit or deployment performed. Existing saved plans and decisions are unchanged.

## Follow-up: one review surface and honest design-step wording

The user requested one enclosing surface while retaining the minimal content. Added `plan-review-surface` to `planning/DesignReview.tsx` and scoped themed border/background, 13px corners, 24px desktop / 16px mobile padding in `workspace.css`. The note, journey rows and actions remain unframed. Tightened decision-heading spacing inside that surface.

Investigating where design enters exposed an existing label defect: the workflow-backed PRD button said “Approve and build,” but `decideWorkflow()` changes `review` to `design`, and `requireBuildApproval()` refuses building until `decideDesign()` records design approval. The controls now say **Approve plan**; the next-step sentence and confirmation dialog explain that Caddie prepares the screens for review before building. The generic PlanReview decision heading now asks “Does this plan look right?” The four top-level destinations remain unchanged; design is the next phase within Plan.

```ts
// Existing server gate, unchanged:
const phase = input.decision === 'approved' ? 'design' : 'planning';
```

The workflow browser fixture also previously jumped from PRD approval straight to building, hiding this distinction. Its plan-approval response now enters design, and the existing approval/reload assertion follows that state.

LOCAL VERIFIED: typecheck passes; the existing `tests/build-workflow.test.ts` test “approving the PRD enters design, not building; building stays gated until the design brief is approved” passes (**1 test, 12 assertions**) against its local database. No server gate was changed.

SIMULATED: three browser tests pass: screen-mock design review and design approval; PRD approval/reload entering design; and the enclosing surface plus truthful labels/confirmation at 1456px and 390px in light and dark themes. Screenshot inspected: `/tmp/caddie-plan-surface-light-1456.png`. No real design generation or build was initiated.
