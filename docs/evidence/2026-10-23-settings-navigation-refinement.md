# Settings and account navigation refinement — 23 October 2026

## Changes

- `apps/app/src/client/workspace/Chrome.tsx`: reduced the shared account menu to account identity, Settings and Sign out. Search stays in the existing navigation; appearance stays in Settings. Settings opens the section index on mobile and the existing default Profile section on desktop.
- The expanded-chat return control appeared on mobile while `.conv-head-btn` styling was scoped to desktop. Render it only on desktop and label it “Return to split view”; mobile retains its existing bottom navigation.

```tsx
{chatFull && isDesktop ? (
  // Existing return-to-split-view button and navigation handler.
) : null}
```

- `apps/app/src/client/settings/Settings.tsx`: render the existing grouped sections as a mobile index, use the existing `?tab=` URLs for individual sections, and add an explicit Back to Settings action. Keep the desktop rail and existing section editors.
- `apps/app/src/client/workspace.css`: scope account Settings navigation rules, remove the horizontal mobile rail, use quiet desktop selection, 52px mobile section targets, 48px inputs/primary buttons, 16px input text and 13px control corners.

```css
.settings-account-layout[data-detail='false'] > .settings-content { display: none; }
.settings-account-layout[data-detail='true'] > .settings-rail { display: none; }
```

These visibility rules apply only below 720px. Project Settings remains separate.

## Verification

- LOCAL VERIFIED — `bun run typecheck`: exit 0, root and app TypeScript checks.
- LOCAL VERIFIED — `bun test tests/settings-model.test.ts`: 6 tests, 49 assertions passed.
- LOCAL VERIFIED — `git diff --check`: exit 0.
- LOCAL VERIFIED — actual authenticated local app: mobile Settings index → Profile → Back to Settings; simplified account menu; desktop grouped navigation and Profile editor. No user data saved or sign-out performed.
- LOCAL VERIFIED — measured mobile Profile inputs: 48px tall, 16px font; back action: 44px tall. At 320px all eight Settings rows are 52px tall and end at x=304 within the viewport. Screenshots inspected at 390px and desktop 1456px.
- BLOCKED — existing `tests/browser/settings.spec.ts` standalone component harness fails before rendering with `No QueryClient set, use QueryClientProvider to set one`. The first existing desktop test, the new mobile navigation test, and existing Interests test fail at missing UI locators. This is not passing automated browser evidence. The running Vite app renders correctly. A temporary attempt to deduplicate React Query through a CLI alias was unsupported by the installed Bun CLI and did not change repository build configuration.

Added a mobile list/detail regression in `tests/browser/settings.spec.ts`; rerun when the standalone harness dependency/provider problem is repaired. Other agents’ work was preserved. No deployment or remote publishing performed.

## Shared link-button alignment follow-up

`a.btn-key` and `a.btn-ghost` inherited button colours/padding but lacked a centering layout. A project-card minimum height exposed the link’s normal text baseline alignment. Added shared inline-flex, horizontal/vertical centering, icon gap and centered text in `workspace.css`, preserving semantic links and existing routing.

```css
a.btn-key, a.btn-ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}
```

LOCAL VERIFIED — actual Projects page at 1456px: Review plan label center differs from its button center by 0px on both axes. At 390px the full-width 324px button retains both centering properties. `git diff --check` passes. The application currently shares CSS button classes rather than a reusable React Button component.
