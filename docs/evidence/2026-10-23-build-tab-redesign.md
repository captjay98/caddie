# Build tab redesign — 2026-10-23

## Result

LOCAL VERIFIED: the Build presentation is implemented locally. Typechecking and focused unit checks pass. SIMULATED: five browser regressions pass against the running local SPA with API fixtures. No model, sandbox build, repair, deployment, or published app was exercised by this UI verification.

The shared files were restored by another process during the initial verification. After the user confirmed the other agent had finished and authorized taking over, the implementation was restored and the final checks rerun. Earlier screenshots/test runs are not the basis for the final verdict.

## Changes and reasons

- `apps/app/src/client/project/BuildProgress.tsx`: one status panel instead of repeated headings, stop controls, stage summary and nested frames. Features remain visible; stages, all recorded files/commands and check history are optional. Raw historical JSON remains available under “Exact recorded result.” Refresh refetches real status and workflow state; it never admits another build. Stop uses the existing workflow stop endpoint.
- `apps/app/src/client/project/build-presentation.ts`: observed activity takes precedence over a persisted `building` label. The existing server quiet threshold remains unchanged. Unreadable activity has a distinct status. A quiet build does not animate the mascot or claim it is running.
- `apps/app/src/client/project/FeatureChecklist.tsx`: “built and checked,” “Next,” and “Waiting” distinguish completed and queued features. Exact test/attempt counts move into Check details. Rollback keeps its existing confirmation and server route.
- `apps/app/src/client/conversation/ProjectWorkflow.tsx`: the building phase delegates its heading and Stop control to BuildProgress; other phases retain their existing controls.
- `apps/app/src/client/conversation/ProjectChatSummary.tsx`: the chat card uses the same observed build status. Repair/build actions open Build.
- `apps/app/src/client/workspace/ProjectTabs.tsx`: a quiet/unreadable build gets the corresponding step status, using the shared activity query without another poller.
- `apps/app/src/client/workspace.css`: scoped single-panel layout, 48px recovery buttons, wrapping technical records and mobile two-column actions. The surrounding Build containers are unframed.
- `tests/build-presentation.test.ts`, `tests/browser/project-workflow.spec.ts`, `tests/browser/build-progress-team.spec.ts`: status and disclosure regressions, responsive checks and updated selectors for the new interface. The workflow browser suite accepts `CADDIE_BROWSER_BASE` for testing the running dev SPA.

Representative status logic:

```ts
const view = buildPresentation(data, Boolean(activity.error));
// Quiet activity yields:
// title: “Let’s check this build.”
// summary: “No new activity has been reported. I can’t confirm the build is still running.”
```

Status refresh reads existing state only:

```ts
const [result] = await Promise.all([
  activity.refetch(),
  props.onRefresh?.(),
]);
if (result.error) throw result.error;
```

## Final verification

LOCAL VERIFIED:

```sh
bun run typecheck
# root and app: exit 0
bun test tests/build-presentation.test.ts tests/build-timeline.test.ts
# 25 pass, 0 fail, 90 assertions

git diff --check
# exit 0
```

SIMULATED: Playwright against `http://localhost:5176`, five tests passed:

1. A finished build retains feature progress and rolls back to a save point in two clicks.
2. Build has exactly one status panel with unframed feature/technical rows; its details open correctly.
3. Stop sends one request and retains the stopped project.
4. History presents readable summaries while preserving exact recorded results behind disclosure.
5. A quiet build offers a status refresh without another build admission, agrees with the chat summary, and supports mobile and desktop widths.

The selected tests were copied to a temporary Playwright configuration to target the existing dev server. Final invocation:

```sh
CADDIE_BROWSER_BASE=http://localhost:5176 CADDIE_SHOTS=/tmp \
  bunx playwright test --config /tmp/caddie-build-redesign-playwright.config.ts \
  --grep 'quiet build|Stop build is one|check history uses|build card has one|a finished build shows each feature'
# 5 passed
```

Screenshots inspected at 390px, 1456px and 320px. The narrow test also asserts no document horizontal overflow. Captures: `/tmp/build-redesign-mobile.png`, `/tmp/build-redesign-desktop.png`, `/tmp/build-redesign-320.png`.

Initial browser retries exposed an ambiguous text selector and an outdated assertion expecting zero framed descendants inside the now-unframed workflow container. The test now checks exactly one status frame and verifies both surrounding containers have zero border width. The final five checks pass.

## Limits and next discussion

The long-running real project has not been stopped, retried, or repaired by these tests. This change makes its uncertainty visible and provides real status/stop controls. Command stdout/stderr and file diffs are not present in the activity payload; the UI states that limit rather than inventing output.

No commit or deployment performed in this pass. Plan has not been changed: its current presentation opens Overview and Goals, then folds other sections into Reference. Scope exclusions, assumptions and important requirements should be promoted before approval in the next reviewed design.

## Follow-up: Caddie in pre-build and Plan states

User requested Caddie in the Build empty state and Plan page. Updated `surface.tsx` to present a 56px shared Mascot, “Let’s get ready to build,” an explanation of approval, and a 48px Go to Plan action. The initial no-plan state also uses Caddie. `planning/DesignReview.tsx` places the 48px mascot beside the existing plan version heading; `planning/PlanReview.tsx` covers its alternate decision entry point. No workflow or approval behavior changed.

```tsx
<div className="project-caddie-heading">
  <Mascot mood={approved ? 'done' : 'needs'} size={48} />
  <h2 className="ev-title">Plan version {latest.revision}</h2>
</div>
```

LOCAL VERIFIED: `bun run typecheck` and `git diff --check` pass. SIMULATED: two browser checks pass (existing plan checklist plus a temporary responsive verification of the Build → Plan navigation, mascot state and horizontal overflow at 1456px, 390px and 320px). Screenshots inspected at 390px: `/tmp/caddie-build-empty-390.png` and `/tmp/caddie-plan-mascot-390.png`. No live build/model calls or deployment.
