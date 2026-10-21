# UI foundation — shared cards, history and responsive behavior

Local implementation and verification for the first packet in `docs/plans/2026-10-20-ui-foundation-implementation.md`. This is a shared, dirty checkout; unrelated onboarding and demo work was preserved. No deployment, remote publishing, new dependency, migration or live model run was part of this packet.

## Fixes

### 1. Generic chat cards had non-working primary actions

**Reproduction:** render a `data-decision-card` message and click its primary button. `Channel.tsx` supplied no `onAction`, so the optional callback in `DecisionCardView` did nothing.

**Fix:** `brief/actions.ts` supplies the same scoped navigation/read-marker behavior to Brief and generic transcript cards. Transcript cards prefer the matching current account-feed record over their immutable message snapshot, so a resolved decision no longer continues to display as pending merely because it was emitted earlier.

```tsx
const current = useCurrentDecisionCard(card);
return <DecisionCardView card={current} onAction={onAction} seen={current.seen} />;
```

Read marking remains separate from approval, execution or submission. No card click in this shared handler directly authorizes work.

### 2. Historical project proposals opened extra conversations

**Reproduction:** render an accepted project proposal in Home history. It mounted `ProjectWorkflow`, whose default `showTranscript=true` enabled a coordinator connection for that project as well as the active conversation.

**Fix:** accepted proposals remain passive project references with an explicit Open project action. Workflow cards default to `showTranscript=false`; the active shell owns conversation transport. The latest embedded workflow can still show a live plan/preview in Home using its HTTP snapshot, preserving approval and feedback behavior without opening that project's extra coordinator stream.

**Post-fix proof:** browser fixtures count coordinator requests: accepted history opens no foreign project transport or workflow read; Open project then opens the intended project. The existing Home plan card remains interactive and has no unopened project transport.

### 3. The same workflow had independent caches and refresh schedules

**Root cause:** `build-workflow` and `workflow-phase` independently fetched `/workflow` every 2/4 seconds; brief/phase selectors could describe different snapshots.

**Fix:** `workflow-query.ts` supplies a full actor/project snapshot and common options to workflow cards, phase/brief hooks and copied-app project reads. Active planning/design/building and import checking refresh at 2s; settled/waiting states refresh at 30s. Mutation refresh now invalidates workflow, experience and activity together.

```ts
queryKey: ['build-workflow', actorId ?? 'pending', projectId ?? 'none'],
refetchInterval: query => workflowRefreshMs(query.state.data),
```

The QueryClient regression proves simultaneous readers share one in-flight read while another actor or project receives a separate cache entry. This does **not** establish a whole-app latency improvement or prove every polling observer fires only once under all timing conditions. Activity/experience polling and long streamed-history CPU behavior remain profiling work.

### 4. Approved/rejected cards disappeared; feed caps also hid pending work

**Reproduction:** approve a pending record, then refresh Brief. Its SQL projection selected only pending/unexpired approvals. Separately, the project feed capped all cards at 24, the account feed capped all cards at 40, and the UI rendered only three large open cards.

**Fix:** retain stable approval card identities through approved/rejected/revoked/expired/superseded states, projecting them as handled outcomes. Earlier exposes each outcome and a working View decision action. Future schedule cards remain in the deadline lane. Removed the UI's silent three-card truncation; server limits now apply to recent handled history, never outstanding items.

**Retention limit:** this packet exposes a recent window (up to 24 handled items per project, up to 40 handled account items). Original approval rows remain durable, but browsing older history via pagination is **not implemented**. Recent history must not be presented as an unlimited archive.

**Post-fix proof:** a SQLite lifecycle test initially failed because the resolved card was absent, then passed for five terminal statuses. Another test creates 61 pending decisions and checks all 61 at both project and account scope. Cross-actor isolation remains green.

### 5. Opening an earlier approval could show the latest plan instead

**Fix:** handled approvals carry their exact approval ID into the Plan route. The read-only decision view checks project identity and matches original content by both `resourceId` and `revisionHash`:

```tsx
const original = planDocs.data?.revisions.find(revision =>
  revision.id === record.resourceId && revision.bodyHash === record.revisionHash);
```

It never substitutes the latest plan or exposes approval controls. If the original is unavailable (including non-document approval resources), it says so and retains the original identifiers in Record details. A browser regression supplies two revisions and verifies only the original approved content appears.

### 6. Shared card geometry and empty-state actions

`caddie-card` applies compact 13px shells, readable hierarchy, wrapping actions, 48px primary and 44px secondary controls to generic decision, proposal, approval and workflow cards. Earlier is subdued. The empty Brief now offers real Start with Caddie / Find a hackathon actions instead of directing someone to a closed chat without a button.

This is the shared foundation, **not completion of all seven rich approved card variants**. Purpose-specific feature lists, live build/repair composition and opportunity-fit redesign remain subsequent packets using real typed data.

### 7. Chat resizing and design-phase consistency

- `ConvResize.tsx` coalesces pointer-driven width changes through animation frames, persists the final pointer position and cancels pending frames on unmount/end. Geometry, keyboard controls and remembered open/closed state remain covered.
- Shared workflow types exposed missing design phases in the four-step header. Designing/design review now remain within Plan; Build is not marked started or finished prematurely. `BuildProgress` excludes those pre-build phases.

### 8. Mobile bottom navigation intercepted Earlier

**Reproduction:** at 390×844, a longer Brief with two active cards and one resolved card could not open Earlier. Playwright reported the floating bottom-nav pill intercepting the summary click for 60 seconds.

**Root cause:** the mobile main flex item could shrink below its content while its contents overflowed; its bottom padding did not reliably create scrollable clearance after the last action.

**Fix:** the mobile main keeps its content size (`flex: 1 0 auto; min-height: auto`), and the scrolling left panel reserves bottom scroll clearance. Also aligned the legacy mobile-shell media rule with the actual 760px JS boundary, avoiding a hidden tablet chat panel at 761–767px. Added a 761px overlay assertion to the tablet test.

```css
.shell-main { flex: 1 0 auto; min-height: auto; }
.shell-left { scroll-padding-bottom: calc(172px + var(--safe-bottom)); }
```

## Changed implementation files

- `apps/app/src/server/brief.ts`
- `apps/app/src/client/brief/{actions.ts,DecisionCard.tsx,navigate.ts}`
- `apps/app/src/client/conversation/{Channel.tsx,ApprovalCard.tsx,ProjectProposalCard.tsx,ProjectWorkflow.tsx}`
- `apps/app/src/client/workflow-query.ts`, `queries.ts`, `routes.tsx`, `surface.tsx`, `workspace.css`
- `apps/app/src/client/workspace/{Chrome.tsx,Shell.tsx,ConvResize.tsx,project-status.ts}`
- `apps/app/src/client/project/{FeatureChecklist.tsx,BuildProgress.tsx}`
- Focused tests: `brief.test.ts`, `workflow-query.test.ts`, `project-status.test.ts`, browser `brief.spec.ts`, `project-proposal.spec.ts`, `project-workflow.spec.ts`, `shell-v2.spec.ts`.

## Verification and limits

- **LOCAL VERIFIED** — `bun run typecheck`, `bun run build`, `git diff --check`: exit 0 on the implementation. Existing build warnings remain.
- **LOCAL VERIFIED** — `bun test tests/brief.test.ts tests/brief-lifecycle.test.ts tests/decision-card-status.test.ts tests/project-status.test.ts tests/workflow-query.test.ts`: 33 passed, 211 assertions, exit 0.
- **SIMULATED** — initial Brief/proposal/shell browser run: 35 passed. A new mobile reachability test then reproduced the bottom-nav defect (35 passed, 1 failed); after the CSS fix, all 36 passed in 19.6s, including mobile card geometry and 761px behavior. A final run also checks resolved generic chat cards against the current Brief state; its result is appended below.
- **SIMULATED** — workflow/resize browser selection: 9 passed in 7.9s. Covers design approval, plan approval, feedback/reload, pending server-owned dispatch, interactive app preview and mobile embedded workflow, plus drag/keyboard/collapse persistence. Auth/API/model data are fixture-backed, not live provider proof.
- **FAILED** — initial full unit/integration run could not write Wrangler's default registry under the restricted filesystem and was stopped. Retried with temporary `XDG_CONFIG_HOME`/`WRANGLER_REGISTRY_PATH` and local process permission.
- **FAILED** — the normal-timeout full retry: 1,714 passed, 4 failed, one error, 1,718 tests across 130 files. A discovery feed test exceeded 5s; worker termination then caused connection resets for the next three discovery tests. No UI assertion failed in this run.
- **SIMULATED** — isolated `bun test tests/planning.integration.test.ts --timeout 20000` with the same temporary configuration: 11 passed, 69 assertions, 17.10s; the discovery feed test took 14.23s. This diagnoses a timing issue but does not turn the normal full-suite run green. No test timeout was changed in repository configuration.
- **LOCAL VERIFIED** — actual signed-in dev app remains available at localhost:5176; the owner's current view and completed onboarding were preserved. Empty-session viewing does not verify an active model build's latency.

Full active-work performance profiling, long-history rendering, keyboard-open device acceptance, older-history pagination, exact preview targeting and the remaining surface/button redesigns remain open. No LIVE VERIFIED claim is made.

## Mobile interaction alternatives for review

Three inline-only proposals were created: Context switch (recommended baseline), Conversation sheet, Chat first. Each has illustrative project data, local chat/project/preview navigation, an unsent draft that survives switching, original-color Caddie with pink cheeks, 13px cards and 48px primary actions. The sheet can expand/close and makes background controls inert while open. Reviewed at 320px and 390px with no horizontal overflow at 390px; primary interactions were exercised and browser error logs were empty. These are **SIMULATED** design previews and do not change the app's navigation.

Final browser result: **SIMULATED** — Brief + project-proposal + shell suites: **37 passed in 19.3s**, exit 0. This includes the current-state chat card, retained original revision, mobile Earlier reachability, 48px primary actions, no 320px horizontal overflow and 761px overlay checks. The local implementation screenshot `shared-cards-mobile-implemented.png` in the task's visualization directory was rendered from stubbed API records and visually inspected; it is not live build evidence.
