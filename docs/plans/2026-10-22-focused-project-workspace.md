# Focused project workspace implementation plan

> Execution: writing-plans and subagent-driven-development, as selected in the authoritative project README. Current checkout is the running local review workspace; preserve unrelated receipts and other agents' work.

**Goal:** Implement the owner's accepted Focused workspace across the Projects list, project steps and contextual chat, for desktop and mobile.

**Architecture:** Reuse the actor/project-scoped workflow query and ProjectExperience. Project chat becomes a compact summary; full plan/design decisions, progress, preview and delivery controls live in the project workspace. Keep exact-output previews, server decisions and original approval records. No backend, agent, schema or paid-provider changes.

**Tech Stack:** Existing React, TanStack Router/Query, Bun and Playwright.

## Approved design

Reference: caddie-project-workspace-review.html, Focused workspace (owner accepted). One project header, four steps Plan → Build → Check → Submit/Share, current-step content first. No large summary card nested within its own page. Projects cards show name, purpose, real status and one continuation. Desktop keeps contextual chat; mobile keeps the four bottom tabs and floating composer. Files, versions, activity, tasks and original decisions remain reachable as supporting detail.

## Implementation packets

1. Compact chat: `conversation/ProjectWorkflow.tsx`, new summary component if needed. Default chat summary; explicit `presentation="workspace"` preserves full controls. Primary actions navigate to the correct project step or exact preview. No automatic decision or execution from reading.
2. Project workspace integration: `surface.tsx`, `workspace/ProjectTabs.tsx`, `project/BuildProgress.tsx`. Current-stage landing, full design review on Plan, full build/preview on Build/Check, delivery controls preserved. Fix Check's selected tab. Keep brief/history/tasks reachable.
3. Visual hierarchy: `workspace.css`. Compact list cards, quiet status, flat workspace, 44/48px touch controls, visible four-step navigation at phone widths, no nested build-card chrome. Respect current theme and reduced motion.
4. Regression verification: typecheck, build, targeted existing model tests and browser scenarios for list routing, design approval, build/repair, ready output, copied app, history, mobile overflow and contextual chat. Update obsolete layout expectations while preserving action/security assertions. Independent specification and code-quality review before handoff.

## Acceptance examples

```tsx
<ProjectWorkflow projectId={projectId} presentation="workspace" />
// Full workspace controls; chat renders its compact projection.
```

```ts
expect(projectCard.locator('.project-journey')).toHaveCount(0);
expect(chat.locator('iframe')).toHaveCount(0);
// Exact app preview remains reachable through its explicit action.
```

## Verification and stopping point

Run `bun run typecheck`, `bun run build` (local/default environment), relevant unit tests and composed-app Playwright suites. Record classifications and snippets under docs/evidence. Leave the app running locally for owner review. No deployment is part of this review pass.
