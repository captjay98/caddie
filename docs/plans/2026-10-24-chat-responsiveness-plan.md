# Caddie conversation, responsiveness and design quality

Status: APPROVED FOR IMPLEMENTATION by the owner; execution in progress, updated 2026-10-24. Preserve the full scope below. Current evidence and unresolved gates are tracked in `docs/evidence/2026-10-24-chat-responsiveness.md`. Earlier observations below describe the baseline, not current completion.

## Agreed decisions

1. Make Caddie less chatty across the conversation. Routine replies lead with the outcome and next useful action; cards and artifacts carry the detail. Preserve material caveats and genuine blockers.
2. Evaluate Lightning separately for query shaping, summaries and rules extraction. Do not replace every helper route from one successful example, or retain Nano everywhere from one failed example. Keep the existing route until representative evidence supports a switch.
3. Select deeper brainstorming by task in Home and project conversations, rather than by page location. Project ideation retains project context and never silently revises approved scope. Specialists keep explicit model assignments.
4. Where useful, offer genuinely different screen compositions for look options, while comparing the same user task and underlying information. Recommend one; do not force every project through three elaborate design alternatives.
5. Use static visual review first, followed by a focused interactive prototype when interaction uncertainty warrants it. Distinguish static mock, prototype and built-app preview. Saving, offline operation and integrations require verification against the actual built app.
6. Validate complete generated design payloads before saving, return actionable errors together, and use bounded internal repair. Retain strict schemas, contrast validation and approval gates. Explain an unresolved blocker plainly instead of exposing repeated schema repair narration.

### Already changed locally

`apps/app/src/agents/coordinator.ts` now includes this response-style instruction:

```text
For routine progress and completed actions, use one to three short sentences:
the result first, then the next useful action if there is one.
Do not narrate tool calls, specialist handoffs, schema corrections or recovered retries.
```

LOCAL VERIFIED — 38 existing tests across providers, looks, design theme and coordinator follow-ups passed; root/app typecheck passed. This does not verify live model adherence. The instruction is local and uncommitted as of this update. No other implementation in this consolidated plan is claimed complete.

## Outcome

Caddie should feel like a responsive companion helping someone finish an app. The default conversation shows the outcome, current activity and next decision. Technical users can inspect the supporting details without making everyone read them.

Keep the desktop split workspace and the mobile bottom navigation and persistent composer. This pass concerns conversation, activity feedback, performance, model selection and the design-to-preview journey; it does not redesign unrelated pages or change approval authority.

## Evidence and limits

LOCAL VERIFIED — inspected current source and the running local mobile chat. A snapshot contained seven message rows, 27 Markdown blocks, 28 tool rows and approximately 15,575 transcript characters. This establishes presentation weight, not its CPU cost. Two workflow-summary elements were mounted; their provenance needs tracing before changing deduplication.

Subsequent repository change: `261edcd` addresses the duplicate project card beside Plan. Re-verify its behavior rather than treating the earlier snapshot as an outstanding confirmed defect.

LOCAL VERIFIED — `Channel.tsx` initially windows history to 40 messages, but Show earlier messages switches to rendering all history. A single large turn is not bounded by that message limit. Closed tool details still mount their child rows. `Markdown.tsx` already uses React memoization; adding that again is not a fix.

LOCAL VERIFIED — mascot elements have computed blink and tilt animations. Motion is already configured, but sending, screen changes, waiting and incoming results lack a consistent feedback system. Playback smoothness has not been profiled.

LOCAL VERIFIED — `bun test tests/transcript-window.test.ts`: four passed, zero failed. This proves those windowing cases, not responsiveness.

DOCUMENTATION ONLY — the supplied conversation records repeated incomplete-work markers and public schema-retry narration before a look-selection request. It is evidence of the conversation the user received, not proof of saved workflow state. The strict looks parser currently returns the first validation error, which can prolong corrective retries. Do not relax validation to conceal that problem.

LOCAL VERIFIED (2026-10-24 evening, ZCode session) — the navigation freeze is measured and fixed. Root cause: every `useFlueAgent` mount creates and disposes its own session, and each session replays the whole conversation stream (the owner's real conversation: 607 batches, 8,009 reasoning + 1,221 text deltas); ProjectWorkflow remounted per route visit, twice-over with the chrome transport. Long tasks of 1.8–9.1s per navigation, all attributed to `@durable-streams/client` replay. Fix: `apps/app/src/client/conversation/agent-keeper.tsx` keeps one shared warm session per conversation (LRU 4, 5-minute idle grace, refcounted); ProjectWorkflow and the chrome transport adopt it. After: route changes 18–158ms, worst long task 221ms, transcript row count stable over 10s (no flashing — the keeper also holds the last good transcript through reconnect rebuilds). Evidence: `scripts/probe-chat-freeze.ts` (SIMULATED transport, real bundle: zero long tasks at 2.5x the real transcript weight) + live measurement on the owner's dev session.

KNOWN, UNFIXED (pre-existing, now cheap enough to see): the flue observation restarts every ~1.3s (history → newest → first page; no `live=sse` establishes). It predates the keeper (SSE closed after ~478ms with 5-page refetch cycles before it). Each cycle re-reduces one page (~200ms long task). The app-level flash guard hides it from the transcript; the real fix belongs in the pinned @flue 2.2.2 SDK/server stream lifecycle and needs its own investigation.

DOCUMENTATION ONLY — the model registry records a failed Lightning rules-extraction probe at the 4,096-token cap, while the execution ledger records a successful later JSON probe through the app API. These differ in prompt and request path; neither establishes universal suitability. No new paid comparison was run for this plan.

LOCAL VERIFIED — `coordinatorModelRole` currently selects ideation only with `isHome && ideationTurnsLeft > 0`; specialist declarations explicitly choose plan/build models. The routing comment that attributes the Home restriction to inherited specialist models is inconsistent with those declarations and needs correction alongside any routing change.

## Model selection workstream

Keep one authoritative role registry in `apps/app/src/agents/providers.ts`. Trace actual coordinator, specialist, helper and generated-app call paths before changing it. Separate helper roles only where task evidence warrants it; do not duplicate configuration across callers.

Evaluate rules extraction against source-backed claims: valid structured output, exact quote fidelity, correct restriction interpretation and appropriate abstention. Evaluate query shaping and summaries with their own fixtures. Record latency, token use, cost and failed/retried calls; do not choose from token price alone. Live comparisons require separately authorized paid calls. Local transport fixtures are SIMULATED.

Proposed selection intent, not a drop-in code change:

```ts
// Conversation location does not determine reasoning quality.
if (hasImage) return 'vision';
if (task === 'substantive-ideation') return 'ideation';
return 'chat';
```

Define how the task is entered/exited, persist it across reconnects, and avoid upgrading routine acknowledgments or every project message. Preserve explicit specialist routing. Log the actual per-call model and reason with accurate budget accounting; a run-level label is insufficient when a conversation switches models.

## Design and preview workstream

Current sequence remains Plan approval → looks → look selection → screen design → design approval → build. Make that sequence understandable without introducing more top-level project tabs.

Look alternatives may vary information hierarchy, navigation and task emphasis as well as palette, typography and spacing. Keep the app's important capabilities constant across alternatives so users can compare presentations without accidentally choosing a different scope. Describe each difference in one plain sentence and recommend a direction based on the audience.

The current `LooksPicker.tsx` applies different themes to one shared screen. Meaningfully different layouts require an explicit contract change in `packages/contracts/src/looks.ts`, with backward-compatible rendering of saved shared-screen sets. Scope this migration before editing shared contracts. Approval must identify the exact chosen revision and option; later changes invalidate affected approvals rather than silently replacing what was reviewed.

Use static previews for appearance; use a bounded, sandboxed prototype for important interactions where necessary. Label sample data and simulated behavior. Define the prototype's limited journey, resource limits and isolation before allowing scripts; do not simply enable scripts in the existing static iframe. Reuse approved design artifacts during the build and compare screenshots at actual phone and desktop widths. Acceptance requires behavior tests against the built app, including failures and offline/reconnect where relevant.

Generation should start from canonical typed examples, validate the full envelope and themes, report independent actionable failures together and stop after a bounded repair budget. No invalid option reaches the picker. A save failure must retain the last valid revision and must not advance the workflow.

## Approved expanded scope

Update from owner: all previously proposed areas are agreed, including drafting while work runs, distinct follow-up versus stop/change-direction semantics, continuity, state consistency, recovery and design fidelity. The following product-wide polish requirements are also agreed. Detailed layouts and implementation sequencing still need to be made reviewable before implementation.

These are proposed acceptance topics, not newly confirmed defects:

- **One coherent project state:** which action needs the user now, where it appears across chat/Brief/project, and how completed or superseded decisions remain inspectable.
- **Context and continuity:** preserve important choices across long conversations; do not repeatedly ask answered questions. Attribute assumptions and revisions, and resolve conflicts without silently dropping scope.
- **Waiting and recovery:** distinguish active work, waiting on the user, disconnected transport and genuinely stalled work. Offer supported recovery without duplicate work or charges.
- **Composer and scrolling:** decide whether a user may queue a follow-up while work runs; retain drafts, attachments, keyboard focus and reading position across refresh, mobile keyboard changes and panel resizing.
- **Confidence before approval:** show a small set of representative journeys and important limitations, while technical detail remains optional. Avoid presenting a polished mock as evidence of working capability.
- **Design fidelity after building:** define how Caddie detects and repairs visual drift from the approved design, alongside functional checks.
- **End-to-end acceptance:** define one realistic beginner journey and one technical inspection journey, with explicit local versus external proof and a measured performance baseline.

Final packets must link these decisions to real files, dependencies, rollback strategy and measurable acceptance. The owner approved implementation of the expanded scope; complete it progressively with the acceptance evidence below.

## Product-wide UI/UX standard

Nontechnical-first applies to every surface, including secondary dialogs, settings, exports and errors. Default content answers: what is happening, what can I do next, and what matters before I decide? Technical inspection remains available through consistently named detail views, without a separate global technical mode. Material scope limitations, costs, privacy and publication decisions must remain understandable and visible at the relevant action.

Use a shared spacing scale (proposed: 4, 8, 12, 16, 24, 32, 48px) with semantic roles rather than identical padding everywhere: compact control gaps, card interiors, section gaps and page gutters. Define paired desktop/mobile values; align headings, body text, metadata and action rows to deliberate edges. Keep paragraph width readable in expanded chat; use the actual container width for split-panel layout decisions rather than viewport width alone.

Consolidate shared button/link-button, input, selection, icon-action, status, card, dialog and empty-state patterns before replacing local overrides. Preserve meaningful density variants. Primary form inputs/buttons normally use 48px height, mobile interactive targets at least 44px, 16px editable text and the agreed 13px corners where appropriate. Small metadata badges are not controls. Do not force every icon, badge or desktop toolbar to 48px visually. Labels center correctly on both anchors and buttons; icons and text share one alignment rule.

Illustrative semantic tokens (names to align with the existing token system):

```css
--space-control: 8px;
--space-card: 24px; /* 16px in narrow containers */
--space-section: 32px;
--control-height: 48px;
--target-min: 44px;
```

Keep one clear primary action per task region. Secondary actions can sit alongside when readable, then wrap deliberately on narrow screens without squeezed labels. Avoid nested surfaces unless each level conveys a distinct relationship. Keep headings, status, metadata and actions in predictable positions; do not use centering indiscriminately to compensate for poor hierarchy.

Loading, empty, error, offline, stale and success states are first-class layouts. Preserve useful cached content during refresh and distinguish initial loading from background updating. Avoid full-page flashes, status changes based on incomplete initial data, disappearing actions and layout shifts. Reserve space for avatars/media/loading content where useful. Never turn failed mutations into optimistic success; reversible UI-only updates may be optimistic with rollback.

Accessibility gates: keyboard operation, visible focus, modal focus containment/return, meaningful labels for icon buttons, screen-reader status announcements without stream spam, contrast in every palette/theme, 200% zoom and reduced motion. Phone gates include safe areas, keyboard opening/closing, internal dialog scrolling, long labels, landscape and narrow containers. Preserve the approved mobile bottom navigation and composer.

Performance covers cold entry, warm navigation, typing, streaming, large history, previews, scroll and resize. Measure client, server and model latency separately. Prioritize usable input and cached navigation over decorative effects; lazy-load expensive secondary content and bound polling/rendering where traces justify it. CSS file length alone is not evidence of runtime cost. Motion must never hide a slow request or pretend work is occurring.

## All-surface audit and proposed direction

This matrix is the coverage checklist for the consolidated plan, not a claim that every state has been browser-tested. Current browser inspection covered desktop split chat, Plan, Build empty state, Check empty state, Discover, Projects and Profile Settings, plus initial Submit loading. Source inventory covered the remaining routes/components. Fresh mobile and completed-build/prototype states still require fixture-backed browser review; no paid work or new workflow was started to populate them.

| Surface and primary source | Default experience / proposed polish | Optional depth and acceptance |
| --- | --- | --- |
| Sign-in and onboarding — `sign-in.tsx`, `onboarding/` | Preserve the approved mobile composition and mascot. One question at a time, consistent next/back controls, clear resume state. | Verify returning users, validation, long names, shared profile controls and mobile keyboard; do not restart onboarding to test a signed-in user's account. |
| Workspace/navigation — `workspace/Chrome.tsx`, `ConvResize.tsx`, `ProjectTabs.tsx` | Stable desktop split and mobile four-destination navigation. Clear chat context, compact headers, deliberate collapse/fullscreen affordances. | Distinguish viewed tab from lifecycle status. Preserve URL/context/draft/scroll through back, refresh, panel resize and project switching. |
| Caddie conversation — `conversation/Channel.tsx`, `Composer.tsx`, cards | Concise outcomes, one truthful activity indicator, useful composer, single-level result surfaces and durable decision outcomes. | Lazy technical activity and searchable earlier history. Test attachments, failures, follow-ups, cancellation, reconnect, very long replies and keyboard scrolling. |
| Brief — `brief/`, home surface | Preserve approved date-first personal Caddie header and feed metadata before first card. Prioritize genuine decisions over informational updates. | Mark-read is not approval. Preserve Earlier details; unread, needs-action and completed are different states. Empty Brief should be reassuring and useful. |
| Discover and event detail — `discovery/Results.tsx`, `ContestDetailPane.tsx` | Compact equal-height titles/cards, intentional filters, readable key facts, local deadline/time zone, clear entry eligibility versus realistic time-to-build. | Source-backed entry rules/prizes remain accessible. Verify long prize text, missing data, closed deadlines and detail scrolling; do not equate eligibility with feasibility. |
| Projects — project list surface | Project name, concise purpose, truthful stage and one resume action. Contest/deadline/update metadata should form a deliberate footer on phone and desktop. | Longer purpose and history accessible without crowding. Verify actual stage consistency with Plan/Brief/chat and truncation that preserves access to full names. |
| Plan — `planning/PlanReview.tsx`, `DesignReview.tsx` | Minimal review surface: useful journeys, included scope, important limitations and one next decision. Keep project context in Info. | Scope/checks/specification/revision history in focused detail views, not a stack of competing accordions. Explain look selection then screen review plainly. |
| Looks and screen design — `planning/LooksPicker.tsx`, `artifacts/DesignMockPreview.tsx` | Recommended direction, meaningful alternatives when useful, clear screen/phone/desktop controls and readable full-size review. | Versioned choice, request-changes flow, explicit static/prototype labels. Test keyboard selection, active-tab semantics, revisions, empty/error states and narrow carousel interaction. |
| Build — `project/BuildProgress.tsx`, `NowPanel.tsx` | What is being made now, feature outcomes and next useful action; honest stale/stalled states and Caddie empty state. | Files, commands and check attempts under Technical activity. Avoid implying empty state means no past work when historical evidence exists. |
| Check — evidence surface, `evidence/Drawer.tsx`, `judge/Scorecard.tsx` | What works, what still needs attention, what user can try, with evidence confidence in plain language. | Exact receipts, check history and manual scoring optional. Never conflate local tests with external/live proof or infer a personal-project fallback while project context loads. |
| Submit / Share — `submission/Package.tsx` | Concrete preparation checklist, missing items and the next hand-in/share action; distinguish prepared from actually submitted/published. | Rules evidence, exports and receipts. User answers facts about their reuse, not interprets regulations. Preserve explicit publishing/submission approvals. |
| Built-app preview — `artifacts/PreviewPage.tsx`, `InteractivePreview.tsx` | Open/try/full-size affordances outside chat, readable viewport controls, clear preview and data status, easy return. | Runtime errors and inspection optional. Reset sample data is distinct from production deletion. Verify keyboard, external links, permission boundaries and build-design fidelity. |
| Start/import code — `repositories/RepositoryPicker.tsx`, proposal and import components | Explain the desired outcome: start fresh, improve an existing app or prepare it for an event. State copying/access implications before consequential action. | Repository/branch details, logs and permissions inspectable; original code writes require appropriate approval. Cover unavailable GitHub, empty repositories and retry. |
| Account/settings — `settings/Settings.tsx`, `settings-model.ts` | Keep grouped desktop sidebar and mobile section-list/back flow. Account dropdown stays identity, Settings and Sign out. Shared fields and save feedback. | Profile/interests, notifications, memory, routines, accounts, spending and appearance each have a focused purpose. Explain spending clearly without default technical configuration. |
| Project settings — `settings/ProjectSettings.tsx` | General, code, routines and project memory organized around user goals; distinguish account-wide from project-wide changes. | Keys, deployment/version operations and archive in relevant detail views; explain the effect and preserve necessary confirmations. |
| Memory — `memory/Memory.tsx`, `conversation/MemoryOffers.tsx` | Understandable remembered facts, their scope and ability to correct/remove. No opaque facts or repeated offers. | Source and history where useful; corrections must affect subsequent context and stay separate between projects. |
| Routines/tasks — `tasks/`, `project/AppJobs.tsx` | Plain-language schedule, next run in local time, last actual outcome, pause/resume and clear ownership. | Raw expressions/execution receipts optional. Differentiate Caddie routines from jobs inside the generated app; do not imply queued means completed. |
| Notifications and search — `workspace/NotificationsBell.tsx`, `search/` | Useful destination and reason, coherent read state, scannable results grouped by type. Search retains project context deliberately. | No permission request before benefit is explained. Test empty/error/loading, keyboard, mobile overlay and deep links to the exact item. |
| Publish, versions, app AI, keys and operational tools — `project/` | Reveal at the point of need using outcome language: share app, connect a service, see usage, restore a version. | Technical settings/logs remain available. Never present sample integration status as working, expose secrets or obscure irreversible effects. |
| Files/artifacts/run inspector — `artifacts/Viewer.tsx`, `runs/RunInspector.tsx` | Secondary inspection destinations; readable files, downloads and error explanations. | Full code, execution receipts and raw diagnostics retained without being prerequisites to using Caddie. Large content loads on demand. |
| Cross-cutting dialogs, confirmations and errors — `project/ProjectDialog.tsx`, `states.tsx`, `routes.tsx` | Consistent header/body/footer spacing, clear close/back behavior and useful recovery with preserved input. | Explain relevant consequences at the action, with debugging details optionally available. Verify focus, Escape, background scrolling and small-screen overflow. |

### Additional audit observations

LOCAL VERIFIED — the current browser Plan surface showed Changes requested while chat presented Plan ready to review and older prose claimed looks were saved. This demonstrates a consistency gap; the exact stale-state or revision mechanism needs tracing. Do not fix it by changing the visible label alone.

LOCAL VERIFIED — current source includes differing local button rules (including 38px card/project actions and 44/48px surface overrides). Computed size and touch-target verification is still needed before classifying each instance as a defect. Consolidation must preserve deliberate density and avoid a broad blind CSS replacement.

LOCAL VERIFIED — Build/Check empty surfaces still include repeated supporting accordion rows. Recommended adjustment is consistent access to shared resources through Info or one resource entry, leaving each tab focused on its job. Retain access and deep links; do not remove capabilities to make the page appear minimal.

LOCAL VERIFIED — grouped Account Settings navigation is already present, and other agents are editing Settings/tasks during this audit. Reconcile their changes before planning edits. The inspected settings URL's `tab=profile` also appeared on unrelated navigation links; include route-specific search-parameter ownership in navigation verification rather than carrying irrelevant state between pages.

### Delivery approach

Recommend progressive consolidation: first inventory shared patterns and agree the default hierarchy; then fix state/latency foundations; apply the shared primitives to representative chat, project and settings screens; review real desktop/mobile checkpoints; migrate the remaining surfaces in bounded groups. A cosmetic-only pass leaves the workflow issues intact, while a full simultaneous rewrite makes regressions and other agents' changes harder to control.

For every surface, acceptance must cover populated, empty, loading, failed and narrow layouts where supported. Before calling the product-wide pass complete, maintain a matrix of source reviewed, browser reviewed, changed, verified and blocked states. Source review alone cannot close browser acceptance. Each packet must include relevant regression evidence and a reversible change boundary, with no broad rewrite of `workspace.css` solely for file organization.

## Proposed experience

### Conversation

- Assistant prose sits directly in the transcript, without an extra bubble around every result card. Preserve a deliberate single card surface for decisions/results.
- Give each reply a short outcome followed by its next action. Retain complete source text and decision history; long material can open separately.
- Use one current project decision card derived from authoritative state. Preserve earlier decisions and their outcomes in Earlier, with original revision details accessible.
- Consolidate recovered retries into optional Technical activity. Keep unresolved failures, missing credentials and user decisions visible in plain language. Do not hide a genuine blocker or falsely report success.
- The looks step should read like this when durable state confirms it:

```text
I've prepared three looks for Farmhand.
Choose the one you prefer before I design the screens.

[Choose a look]
```

Not a transcript of JSON field corrections, specialist handoffs or save attempts.

### Activity and composer

Use one compact Caddie activity line while work is active. Wording follows real lifecycle events: Sending, Working on the looks, Waiting for your choice, or Could not finish. Show elapsed/stale information only when useful, with a clear recovery action. Never infer live progress from an old active status or display invented percentages.

The composer should acknowledge a send immediately, preserve drafts across resizing/navigation and expose Stop only where cancellation is supported. Keep buttons and focus states consistent with the shared control system.

### Motion

- Subtle entrance for a newly received result or decision: approximately 120–180ms opacity/transform, once per new item.
- Brief, interruptible transitions for sheets, panel collapse and route changes; they must not delay input or navigation.
- State-grounded mascot activity, with quiet idle behavior. No constant bouncing across the transcript.
- Respect reduced motion with instant state changes and static activity feedback. Avoid animating layout dimensions of long messages.
- Polling, reconnect and history restoration must not replay entrance animations.

## Approved implementation packets

### 1. Establish the baseline

Profile both development and a local production preview with the same deterministic long-history fixture. Exercise typing while streaming, scrolling, loading earlier history, navigation, project switching, refresh and split-panel resizing. Record main-thread long tasks, React render duration, request frequency/payload sizes, mounted nodes and input/navigation timing. No paid requests are needed: transport fixtures are SIMULATED; local measurements are LOCAL VERIFIED.

Relevant files: `apps/app/src/client/conversation/Channel.tsx`, `apps/app/src/client/coordinator.ts`, `apps/app/src/client/workspace/Chrome.tsx`, `apps/app/src/client/queries.ts` and existing browser tests. Reuse existing tooling before adding dependencies.

Gate: a repeatable baseline and evidence-ranked cause list, including whether dev tooling materially affects the result.

### 2. Bound expensive work

Replace the all-history expansion cliff with incremental, bounded history access and stable scroll anchoring. Profile message/turn boundaries and large single turns before selecting a virtualization strategy. Lazily mount diagnostic contents. Isolate completed turns from streaming and unrelated shell updates where traces justify it. Change transport replay or polling only if measurements identify redundant work.

Preserve message search access, attachments, draft state, approval revision identity, project/account boundaries and reconnect behavior. Rendering optimization must not change dispatch or idempotency semantics.

Gate: loading older history does not suddenly mount the complete conversation; typing and scrolling remain responsive during replay/streaming.

### 3. Simplify chat and reconcile state

Verify the duplicate-card fix in `261edcd` and trace remaining card sources before making further deduplication changes. Render the current action from saved workflow state; distinguish Plan review, choosing a look, screen review and Build. Fix the source of schema trial and error with a canonical valid payload/template and useful preflight validation feedback, considering aggregated errors where appropriate. Keep strict contrast and schema checks.

Primary files: `Channel.tsx`, `ProjectChatSummary.tsx`, `ReplyText.tsx`, existing activity/card styles. Agent/schema changes, if required, must follow `docs/flue-contracts.md` and current workflow contracts. Coordinate with existing WIP before editing.

Gate: recovered retries no longer dominate normal chat; real blockers remain visible; prose and current card agree with durable state. Show a realistic desktop/mobile checkpoint before proceeding to broad styling.

### 4. Add restrained feedback

Implement the motion and composer behavior above using existing mascot and shared controls. Animate only newly observed lifecycle changes, with reduced-motion support.

Gate: feedback is perceptible and truthful, with no repeated animations on polling/reload and no extra interaction delay.

### 5. Verify and report

Run relevant existing unit/browser checks and a local production build. Compare the same performance scenarios before/after. Cover 320px and 390–412px mobile widths, desktop split and expanded chat, keyboard scrolling, reduced motion, hundreds of turns, one unusually large turn, earlier-history expansion, reload, reconnect and project switching.

Proposed lab budgets, to confirm against the baseline: p95 composer input feedback below 50ms and immediate navigation feedback below 150ms on the recorded test machine. Record hardware/browser conditions, raw results and remaining regressions; these are lab targets, not universal device guarantees.

Document changed files with concise before/after snippets, commands and outcomes. Separate LOCAL VERIFIED, SIMULATED and any BLOCKED external verification. No deployment is included.

## Scope boundaries

Do not change the chosen mobile navigation, remove technical inspection, suppress meaningful limitations or turn model self-reports into completion evidence. Recheck current git state and reconcile the other agent's completed or ongoing work before implementation. No deployments or paid model comparisons are authorized by this documentation step.
