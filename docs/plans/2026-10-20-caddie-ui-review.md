# Caddie UI review — 2026-10-20

## Accepted visual direction

The owner individually accepted all seven interactive card mockups:
Plan approval, Live build, Repairing, Preview ready, Deadline, Opportunity fit,
and Earlier. The owner then chose **Compact** spacing and **13px** corners.
These choices apply to implementation of the accepted designs; the product has
not yet been changed to match them.

Reference implementation, read-only:
`/Users/captjay98/projects/caddie/src/components/TheCard.tsx` and
`src/styles/halo.css`. Retain distinct layouts by purpose, quiet card shells,
semantic inner accents, readable headlines, freshness, appropriate actions,
and less emphasis for informational content. Implement using Forge's typed
records and existing authorization checks.

Accepted mockups:
`/Users/captjay98/.codex/visualizations/2026/10/20/01a156e1-6c71-7120-8b86-2f4f02367ff6/caddie-card-review.html`.

## Additional owner requirements

- Desktop and mobile must support the same useful workflows. Responsive width
  alone is insufficient: navigation, input, dialogs, actions, scrolling, and
  previews must be usable by touch and with the keyboard open.
- Chat, project overview, Build and Brief must describe the same current state.
- Reload must not reconnect every historical project's conversation.
- Completed Brief decisions remain available in Earlier with their outcome and
  the exact plan/design/output they concerned.
- App previews need a clear way to open and expand, comparable to design
  previews. Downloading an HTML file is not the primary way to try the app.
- Run the current application in the in-app browser for the owner to review
  what to keep, change, refine or remove before the broader UI work.

## Review environment

- Local only: `http://localhost:5176/app/`, started with `bun run dev`.
- Current database was backed up, reset and all 39 migrations applied at the
  owner's request. No production database was reset.
- LOCAL VERIFIED: application returns HTTP 200 and the in-app browser displays
  the real sign-in screen with Google and GitHub actions.
- Authenticated browser review is now available: the owner completed sign-in
  and onboarding. Earlier sign-in blocking observations are superseded.
- The running page is the current implementation, not the new card mockup.
- No claim that the full UI has passed mobile acceptance yet.

## Source findings

### Historical project cards open live transports

`apps/app/src/client/conversation/ProjectProposalCard.tsx`:

```tsx
if (p.status === 'accepted' && p.projectId)
  return <ProjectWorkflow projectId={p.projectId} name={p.name} />;
```

`ProjectWorkflow.tsx` opens a Flue conversation when `showTranscript` is true
(the default). Historical accepted proposals can therefore open their project
transcripts while the Home transcript is rendered. The explicit channel footer
uses `showTranscript={false}`, but historical cards do not.

### Brief drops approvals after they are used

`apps/app/src/server/brief.ts`:

```sql
where "projectId" = ? and "status" = 'pending' and "expiresAt" > ?
```

The pending approval disappears from the projection once its state changes;
there is no corresponding completed approval card in that query. UI read markers
must remain distinct from the underlying decision and its outcome.

### Built-app preview lacks design-preview expansion

`apps/app/src/client/artifacts/DesignMockPreview.tsx` has a native dialog and
“View full size”. `InteractivePreview.tsx` provides a sandboxed app iframe and
“Download app”, with no equivalent expand control. `ProjectWorkflow.tsx` embeds
the interactive frame when the build is ready. Keep the preview's sandbox,
storage, request relay and exact output binding when changing its placement.

## Mobile and desktop acceptance matrix

Review at 320px, 390px, 768px and desktop width; include a short-height phone,
landscape, touch targets, keyboard focus, reduced motion, and light/dark themes.
These are planned checks, not passing evidence.

| Surface | Required review | Current evidence |
|---|---|---|
| Sign-in / onboarding | Button reachability, forms, keyboard, return navigation | Sign-in visible; full mobile check pending |
| Home / Brief | Card hierarchy, completed history, long content, no horizontal overflow | Pending |
| Discover / detail | Search, filters, detail sheet, eligibility and save actions | Pending |
| Projects | Long names, status, project selection, empty state | Pending |
| Chat | One active transport, reload, history, composer, attachments, keyboard, stop/send states | Pending |
| Project overview | Shared status, progression, next action, mobile chat navigation | Pending |
| Plan / design | Read/approve/refine flows, full-screen design, narrow dialogs | Pending |
| Build / repair | Consistent state, purposeful motion, stop/retry, stage transitions | Pending |
| App preview | Accessible outside chat, full-window view, interaction, exit, test data and versions | Pending |
| Delivery / submission | Checklists, artifacts, download, publishing approvals, Android actions | Pending |
| GitHub / repositories | Connect/import/save actions and clear blocked states | Pending |
| Profile / settings | Every section, menus, preferences, connections and usage | Pending |
| Notifications / history | Open correct project, retain outcomes, prevent duplicate effects | Pending |

Real browser observations and fixture-based checks must be recorded separately.
Fixtures may exercise unavailable build states without paid calls, but their
external/model behavior is SIMULATED, never live proof.

## Sign-in walkthrough changes

Owner requested a fourth capability item for symmetry and centered sign-in
copy on mobile. Added “Builds and repairs” between planning and shipping; the
four items now form a two-column grid. Below 720px, the title, supporting line,
and code-access note use `text-align: center` with centered alignment.

LOCAL VERIFIED in the actual local app/in-app browser: at 1366px the four
items form two aligned rows; at 390px all three text blocks compute to centered;
at 320 × 568 the provider buttons remain within the viewport; no horizontal
overflow at any of those widths. Browser viewport override was reset afterward.

The owner accepted stacking the desktop left/right sign-in surfaces into
top/bottom sections on mobile. Implemented below 720px: a compact centered
brand/mascot introduction and four capability chips above the centered sign-in
area. The duplicate wordmark/footer are omitted on mobile; the existing page
header remains. The hero text is now available to assistive technology as well.

```css
.signin-split {
  grid-template-columns: 1fr;
  grid-template-rows: auto minmax(min-content, 1fr);
}
```

Content sets the top section's height rather than a forced 50/50 split. The
mascot and spacing shrink further on short screens; the form includes bottom
safe-area padding. Desktop retains its side-by-side layout.

LOCAL VERIFIED in the running app: stacked at 390 × 844, 320 × 568, and
667 × 375; no horizontal overflow. The GitHub button was reachable on the short
phone (bottom 488px in its 568px viewport after scrolling). At 1366 × 900,
hero/form remain side by side. Viewport override reset and review tab kept open.

### Balance refinement

Owner requested a slightly taller mobile top section and bottom-aligned login.
The mobile hero now uses `min-height: clamp(300px, 40svh, 380px)` and centers its
contents; the form uses `align-items: end` with 2rem bottom safe-area clearance.
The short-screen rule removes the hero minimum so the layout can scroll instead
of squeezing or overlapping content.

LOCAL VERIFIED at 390 × 844: hero height 337.6px (previously 269.2px), form
bottom 844px, content bottom 812px. At 320 × 568 and 667 × 375, no horizontal
overflow or overlapping sections; hero minimum resolves to 0px. Browser sizing
was restored after verification.

### Final accepted mobile proportions

The owner refined the layout to **50/50 top and bottom**, then accepted centering
the login content within the bottom half. This supersedes the taller-hero and
bottom-alignment experiment above.

```css
.signin-split {
  flex: none;
  grid-template-rows: repeat(2, 1fr);
  height: max-content;
}
.signin-form { align-items: center; }
```

LOCAL VERIFIED at 390 × 844: both halves are 385.0px beneath the header;
the login content has 58.5px space above and below. At 320 × 568 both halves
grow equally to 308.1px, with scrolling rather than squeezed content. The GitHub
button was reachable after scrolling (bottom 488.1px in the 568px viewport).
No horizontal overflow. Desktop styling remains outside these mobile rules.
Viewport override reset; local review tab remains open.
# Accepted onboarding direction — 2026-10-20

Final-step refinement: **Quick picks** implemented with **Open to anything** first/default and More topics revealing the existing searchable/custom interest picker. User subsequently chose the original Caddie character with bubbly eyes/pink cheeks and original colors; this supersedes the earlier welcome palette polish.

Your starting point is accepted and implemented. Keep today's Caddie; soften the welcome's blue/yellow palette toward Flag buddy without replacing the character. Native choices lead to Discover, existing idea entry or Home after the existing name/profile setup. Local checks and the completion redirect race fix are recorded in `docs/evidence/2026-10-20-onboarding-starting-point.md`.

## Whole-app discussion — current findings, 2026-10-20

Owner requests a joint design review of the shared card system, performance during active work, consistent actions, mobile shell/chat, resizing, Brief history, Discover cards/details, notifications, Projects cards and project workspace. Preserve the four project steps: Plan, Build, Check, Submit/Share. The seven earlier card variants remain approved but unimplemented.

**LOCAL VERIFIED (source inspection):** Brief and generic chat decision messages use `DecisionCardView`; the chat call omits `onAction`, while its primary action invokes only the optional callback. Proposals, workflow and hackathon cards have separate renderers. Shared visual components do not yet establish shared action behavior.

**LOCAL VERIFIED (source inspection):** accepted historical proposals mount `ProjectWorkflow` with default `showTranscript=true`, enabling coordinator connections when a workflow exists. The workflow snapshot is independently queried under `build-workflow` every 2s and `workflow-phase` every 4s; project activity/experience and Brief have additional polling. These are credible contributors to active-work slowdown and inconsistent surface timing. No active-build latency/CPU profile has been captured in this discussion; do not treat these mechanisms as a measured attribution.

**LOCAL VERIFIED (source inspection):** resize width state updates on pointer movement and window resize. Desktop chat has a 340px minimum, 40% default, maximum constrained to leave 520px for content; viewport modes switch at 760/1080px. Active streaming, keyboard-open phones, long transcripts and drag/collapse performance remain unverified.

**LOCAL VERIFIED (source inspection):** the notification bell polls unread records every 30s. Clicking marks the record read; only `build_paused` explicitly navigates to its project build, while other kinds expose Mark as read. Backend has durable dedupe/read records and email delivery support; no delivery provider or live email receipt was verified here. Read status must not resolve underlying work.

**LOCAL VERIFIED (actual browser):** Home/Brief currently repeats the empty message in both greeting and large empty-state card; it tells the owner to start in chat while chat is closed. Observed existing UI only; no fixes or performance claims from this empty-session view.

Recommended discussion order: shared shell/mobile chat and canonical state/actions → accepted card family and durable Earlier outcomes → Discover cards/detail → Projects cards → project workspace using the existing four steps → alerts and final interaction audit. This order is a proposal awaiting discussion, not implementation approval.

