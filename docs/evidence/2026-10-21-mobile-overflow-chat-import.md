# Mobile overflow, flatter chat and first-project import — 2026-10-21

Owner feedback: populated Discover content overflows on mobile; chat has excessive nesting around activity and project cards; GitHub import should work as a first starting point. Projects list and full project workspace need a subsequent deliberate redesign, preserving the four steps and existing mobile navigation.

## Discovery overflow

**LOCAL VERIFIED reproduction:** signed-in page at 412px. Browser DOM measurements showed the results panel at 380px but its grid children, toolbar and cards at 678.6px, extending to x=694.6. The shell clipped the excess, so `documentElement.scrollWidth <= innerWidth` incorrectly looked healthy while actions and facts were off-screen.

Root cause: the results grid used an auto minimum track; toolbar minimum content width and non-wrapping facts enlarged the track. Fix at the layout layer:

```css
.discovery-panel { grid-template-columns: minmax(0, 1fr); }
.disc-toolbar, .disc-list, .disc-toolbar > * { min-width: 0; max-width: 100%; }
.disc-row-head, .disc-filter-chips { flex-wrap: wrap; }
.disc-fact { min-width: 0; max-width: 100%; white-space: normal; }
.disc-fact-value { min-width: 0; overflow-wrap: anywhere; }
```

Titles can wrap, verdicts move below the identity on mobile, and country/check controls wrap within the toolbar. Existing discovery actions and data remain unchanged. Live remeasurement at 412px showed cards at 380px, right edge x=396, main scroll width 412px. No new provider search was triggered.

The new browser regression measures actual toolbar, card, fact and action bounds at 320, 390, 412, 768 and 1440px. Its dense fixture uses the current `card.candidates` payload (not the legacy evaluation fallback), asserts all six fact pills render, and includes a long title and long themes. This avoids vacuous root-width-only proof.

## First-project GitHub import

Root cause: the import window derived `workspaceId` only from the first build project, so an account containing only Home was told to create a project first.

```ts
const workspaceId = chrome.buildProjects[0]?.workspaceId ?? chrome.homeProject?.workspaceId;
```

Preserves existing-account selection and falls back to the authenticated Home workspace for a new account. Workspace/repository authorization remains server-owned. The copy now explicitly says the selected repository is copied and checked while GitHub remains unchanged. Confirmation still creates the project and starts the import; merely opening or picking a repository does not import it. Existing improve/contest intent choices remain available.

**SIMULATED regression:** Home-only account opens the real RepositoryPicker and reads installations for the correct workspace without requiring a throwaway project. API boundaries are fixtures; no real repository was imported or provider build started.

## Flat assistant and project-card hierarchy

The assistant bubble previously framed activity and project cards, which then framed inner sections and feature cards. The outer assistant frame is now transparent with no border, shadow or padding. Actionable cards retain one 13px outer frame and consistent 18px desktop / 14px mobile padding. Plan sections and features inside workflow cards use text spacing and dividers rather than repeated bordered cards.

```css
.channel-pane .msg.assistant .bubble {
  background: transparent; border: 0; box-shadow: none; padding: 0;
}
.project-workflow.caddie-card .plan-feature {
  border: 0; border-top: 1px solid var(--color-line-soft);
  border-radius: 0; background: transparent;
}
```

Removed the user-facing “Thought it through” section and raw reasoning renderer. A currently working tool-only turn uses the single channel activity line; completed tool activity remains available as a flat disclosure. The active-state check uses channel transport status, so an unfinished historical snapshot is not silently hidden when no live run exists. Actual text replies, actionable cards, failure notices, attachments and specialist diagnostic disclosures remain available. A regression caught an over-broad empty-turn guard hiding the useful malformed-proposal notice; the guard now explicitly retains that notice.

An existing QR screenshot test intermittently captured content partially outside the transcript's clipped scroll viewport after scrolling controls changed layout. The latest button remains in its own non-overlay row; the test now centers the QR and asserts full viewport intersection before pixel decoding. No QR generator change or weakened assertion was made.

## Scope and files

Updated `apps/app/src/client/workspace.css`, `conversation/Channel.tsx`, `surface.tsx`; regressions in browser `discovery.spec.ts`, `projects-v2.spec.ts`, `conversation.spec.ts`, `project-workflow.spec.ts`.

This is a containment and hierarchy correction, not the full Projects redesign. Proposed next design review: lean project cards with one clear continuation; project detail with one header, the existing Plan → Build → Check → Submit/Share progression and one current-step workspace. Remove repeated project-summary panels rather than stacking overview cards inside detail pages. Owner review precedes that broader implementation.

## Verification

- **FAILED** — initial containment regression reproduced overflowing toolbar/cards/actions before the CSS correction.
- **SIMULATED** — initial Discovery suite after containment fix: 12 passed, 6.5s. Dense-candidate coverage was then strengthened to assert real fact pills rather than legacy metadata-free rows.
- **FAILED** — first combined affected-suite run: 87 passed, 2 failed (hidden malformed-proposal notice, clipped QR screenshot). Both were addressed as described above; this is not a green receipt.
- **LOCAL VERIFIED** — typecheck/build and whitespace check passed before final browser run. Final receipts follow below.

Local only; no deployment, remote publishing, real GitHub import or paid provider calls. Owner data, unrelated WIP, bottom navigation and persistent input preserved.

## Final receipts

**LOCAL VERIFIED** — `bun run typecheck`, `bun run build`, `git diff --check`: exit 0. Composed client build `a5c856e719c4`; existing build warnings remain.

**SIMULATED** — final affected browser selection:

```sh
XDG_CONFIG_HOME=/tmp/caddie-chat-brief-config \
WRANGLER_REGISTRY_PATH=/tmp/caddie-chat-brief-registry WRANGLER_SEND_METRICS=false \
bunx playwright test tests/browser/discovery.spec.ts tests/browser/projects-v2.spec.ts \
  tests/browser/conversation.spec.ts tests/browser/project-proposal.spec.ts \
  tests/browser/project-workflow.spec.ts --grep-invert 'an Android app runs its real Flutter' \
  --workers=1 --reporter=line --max-failures=3
```

89 passed, 1.1m, exit 0. Covers first-project import picker, existing confirm/import flows, flat assistant frame geometry, preserved malformed-proposal notice, project plan outer-frame geometry, seven card designs, refresh/drafts/mobile/long history, dense six-fact discovery rows at five widths, previews and unobscured QR screenshot decoding. Auth, repository APIs and model outputs are fixture-backed; this does not establish live GitHub import or model/sandbox success. The real Flutter/CDN journey remains excluded as documented in the previous packet.

Rendered screenshot `discovery-mobile-overflow-fixed.png` in the task visualization directory was inspected. It uses deliberately long fixture text and real client styling; it is not a screenshot of an imported owner repository or a live-provider result.
