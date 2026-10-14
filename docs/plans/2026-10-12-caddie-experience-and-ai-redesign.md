# Caddie experience and AI redesign implementation plan

> **For the implementing agent:** Use the executing-plans workflow to implement this plan packet by packet. Read the repository's `AGENTS.md` and `docs/flue-contracts.md` first. Preserve existing work. This document authorizes planning; implementation, paid evaluation, deployment and publication have separate scopes. Do not interpret a proposed feature as already implemented.

**Goal:** Make Caddie a capable, trustworthy assistant that helps solo builders find suitable hackathons, plan and build software, and prepare submissions without requiring them to coordinate engineering work.

**Architecture:** Keep the existing Flue, Hono, D1, React and sandbox foundations. Consolidate the visible experience around Caddie, Brief, Discover and Projects; connect them through one server-authoritative project workflow and reusable contextual views. Extend concrete services and existing persistence rather than introducing a second agent framework, generic event platform or duplicate workflow engine.

**Tech stack:** Existing pinned Flue 2.2.2, Cloudflare Workers/Durable Objects/D1, Hono, React, TanStack Router/Query, Bun, Contree, Nebius and Astro landing. Output-stack scope remains React/Hono, TanStack Start, Laravel/React/Inertia, FastAPI/React and Flutter with a supported backend.

**Date:** 2026-10-12, Africa/Lagos. **Status:** DOCUMENTATION ONLY. Source paths below are relative to `/Users/captjay98/projects/caddie-forge` unless stated otherwise. New paths and types are proposals, not existing APIs.

---

## 1. Decisions and boundaries

### Confirmed direction

- Audience: nontechnical solo builders and technical people with little time. Caddie owns setup, internal handoffs, verification and bounded repair.
- Priority: find a suitable hackathon, then start a personal project, then continue/import existing work. All three remain supported.
- **Brief stays a dedicated primary destination.** It is the ongoing, actionable update surface inspired by the supplied Today.ai reference. It is not being folded into chat or reduced to notifications.
- Desktop retains navigable content on the left and persistent Caddie chat on the right, floating navigation within the content panel, and no full-width application header. Mobile retains the floating navigation aesthetic and defaults to Caddie chat.
- Preserve the user's visual identity and useful redesign work. Simplify the code and exposed choices, not the agreed capabilities.
- Keep standalone onboarding before the app, with the solo-builder profile, easy skills/interest entry, optional project highlight, event format and time/resources. A budget preference is not spending authorization.
- No framework rewrite is justified by the evidence so far. Improve the existing system and evaluate models under controlled conditions.

### Proposed implementation decisions

1. Desktop navigation: **Brief · Discover · Projects** in the left capsule; Caddie is the persistent right panel. Mobile navigation: **Caddie · Brief · Discover · Projects**. These are four product destinations without a redundant desktop Chat tab.
2. Default desktop view: Brief left, Caddie right. Default mobile view: Caddie. Restore an explicit deep link first, then actor-scoped session state. Never silently retarget a draft or action.
3. One project workspace with a current-stage canvas and three local views: **Overview · Plan · Preview**. **Details** is secondary. **Prepare submission** or **Share** appears when relevant as a contextual action/view, not another permanent global destination.
4. A single main action per state; chat and buttons call the same commands. No second approval process for the same plan.
5. Keep specialized runtime agents internal. More agent roles and stronger prompts do not substitute for complete execution contracts and reliable handoffs.

### Alternatives considered

| Approach | Benefit | Cost / reason not selected |
|---|---|---|
| Restyle each existing page | Smallest immediate change | Preserves fragmentation and contradictory status; does not fix execution |
| Chat-only product | Few visible surfaces | Hides persistent work and makes comparison, preview and updates harder; conflicts with retaining Brief |
| Four destinations plus contextual project workspace | Clear orientation, persistent updates and direct actions | Requires route consolidation and server/client contract work; recommended |

No native Caddie mobile app, plugin marketplace, team onboarding, autonomous final contest submission or parallel repair branches is added. Existing output stacks, import, GitHub, previews, rules monitoring, judging, memory and routines stay in scope. Delivery proceeds in gates rather than enabling every stack at once.

## 2. Evidence and present shortcomings

This is a source-grounded plan, not a fresh live acceptance report. Inspected on 2026-10-12: `client/routes.tsx`, `workspace/Chrome.tsx`, `workspace/Shell.tsx`, `workspace/ProjectTabs.tsx`, server Brief generation, coordinator context/host/workflow, provider routes, React/Hono recipe/template and existing audit/contract documents.

Earlier authenticated acceptance in this conversation established the following failures: a todo build never produced a verified working preview; the assistant repeatedly asked for approval already stored; users had to navigate among project surfaces; the failure destination exposed identifiers rather than an understandable diagnosis. These are prior observations to reproduce, not claims of a new live test today.

| Finding | Evidence / implication | Required response |
|---|---|---|
| Separate project Overview, Plan, Build, Check and Submit routes | `routes.tsx`, `ProjectTabs.tsx` | Consolidate presentation; preserve underlying capabilities and old links |
| Brief uses internal language | `server/brief.ts` emits “Run stopped: <issue>”, cron strings and approval resource IDs | Produce useful, typed summaries with real next actions |
| Context exists but discovery remains limited | `server/coordinator-context.ts` loads actor context and explicitly returns `liveWebSearch: false` | Do not repeat the older audit's claim that no context is loaded; finish live discovery and evaluate its actual use |
| Host scaffold and catalog recipe diverge | `coordinator-host.ts` creates a generic React scaffold; `stacks/react-hono/recipe.ts` and template define another path | One versioned, reproducible recipe used by both evaluations and real chat builds |
| Model selection currently has one route | `agents/providers.ts` registers Nemotron; route/payer/pricing are frozen per run | Controlled model evaluation, no invisible fallback or in-place route mutation |
| Workflow mixes delivery concerns with five coarse phases | `build-workflow.ts`: planning/review/building/blocked/ready plus pending dispatch | Define explicit action/projection semantics and durable dispatch; do not trust prose as state |
| Existing client dispatch helper | `conversation/workflow-dispatch.ts` | Prove approved work progresses after browser closes; move authoritative dispatch server-side if it currently depends on mounting a card |
| Prior tests passed while live todo failed | Previous turn's local regression evidence is narrower than product acceptance | Keep local, simulated and authenticated live evidence distinct |

The earlier `docs/reviews/2026-10-11-ai-system-audit.md` is a historical baseline. Some missing context, tool and receipt protections have since been added in WIP. Reconcile every finding against current code before changing it. Do not restart solved work based on an old report. Likewise, old recipe comments claiming a verified fixture journey do not prove current freeform chat can reliably build an app.

## 3. The product experience

### Desktop, tablet and mobile

```text
Desktop >= 1081px
┌─────────────────────────────────────┬────────────────────────────┐
│ [Brief  Discover  Projects]  ⌕  ○   │ Caddie · current context   │
│                                     │                            │
│ Brief / discovery / project canvas │ Conversation + decisions   │
│                                     │                            │
│ Relevant plan or interactive app   │ Composer                   │
└─────────────────────────────────────┴────────────────────────────┘

Mobile <= 760px
┌────────────────────────────┐
│ Current destination        │
│                            │
│ Chat or focused content    │
│                            │
│ Composer (chat only)        │
│ [Caddie Brief Discover      │
│                 Projects]  │
└────────────────────────────┘
```

Preserve existing breakpoint bands initially: mobile <=760px, tablet 761–1080px with a chat overlay, desktop >=1081px. Test 320, 390, 768, 1024, 1280 and 1440px. Maintain desktop resize/collapse as an explicit preference; default open. Keep the chat mounted when navigating within the same scope. Background work must not depend on either panel being mounted.

Opening an item in chat reveals its relevant view on the left without losing the conversation or draft. On mobile, it opens a full-height focused view with a labelled return to Caddie; closing restores transcript and draft. User navigation wins over late AI responses: a response may offer “Open plan” but must not steal the screen from a different project the user has since opened.

Global views use the account conversation. A project view binds visibly to that project. Account chat may display a project action card without switching scope or leaking a second project's context into it. Record project identity on each card/action. If “continue it” is ambiguous, ask which project once with named choices. Do not infer identity from the last globally updated row.

### Caddie

The empty state offers three understandable starts, ordered by product priority: “Find a hackathon”, “Build an idea”, “Continue a project”. Once a profile exists, ask only for missing facts that matter to the current choice. Do not begin with agent roles, technology catalogs or account IDs.

Replies are brief, specific and action-oriented. Render plans as readable content with a short scope summary, not escaped Markdown. Use typed cards for plans, matches, previews and blockers. Hide tool names and raw reasoning. Streaming must never show `svg`, serialization fragments, reasoning tags or empty placeholder chains.

### Brief: continuous, actionable updates

Brief answers **what changed, why it matters, and what I can do now** across discovery and projects. It is useful while the user is away; it is not a dump of every agent operation.

Layout:

1. Date and short factual overview, e.g. “One plan needs your review. Your other app is ready to try.” Computable facts first; optional generated summaries cannot change status.
2. **Needs you**: concrete decisions or missing human input, ranked by urgency and consequence.
3. **Updates**: meaningful milestones, previews, new relevant matches and material rule changes, newest meaningful change first.
4. **Coming up**: actual deadlines and user-enabled reminders with timezone and source.
5. **Earlier**: compact resolved history, progressively loaded.

Do not label all updates “needs you”. An agent repairing a build should say it is working. If Caddie is blocked on its own execution problem, explain that limitation without pretending the user must debug it.

| Update | Example summary | Main action | Resolution |
|---|---|---|---|
| Plan decision | “Your task app plan is ready: six features, saved on this device.” | Review plan | Stored decision for this exact revision |
| Working app | “Your app passed the required checks. Try adding your first task.” | Try app | Remains an available result; read state is separate |
| Repair in progress | “I found a problem with saving tasks and am checking a fix.” | View progress | Replaced by success or an honest blocker |
| Repair stopped | “The saved-task check still fails after three repair attempts. Your work is saved.” | Review next step | Explicit chosen recovery, never dismiss/read |
| Opportunity | “This online event matches your interests. Solo eligibility still needs confirmation.” | Review match | Saved, dismissed or linked to a project |
| Deadline | “Submissions close tomorrow at 18:00 in your timezone.” | Prepare submission | Submission record or deadline passing; never mere read |
| Rule change | “The demo now needs a public video link; your package is missing one.” | Review requirement | Requirement addressed or uncertainty explicitly retained |

**Lifecycle:** source event -> scoped update -> fresh action -> resolution/supersession. Deduplicate by underlying entity and meaningful revision, not model wording. A repeated scheduler tick or tool retry must not create another card. Coalesce noisy progress; retain critical changes. Archive old resolved items; do not hide open deadlines or decisions merely because they were read.

Keep these independent: `seen`, `resolved`, `snoozedUntil`, `supersededBy`. Mark-read never approves, resolves, submits or grants spending. Existing explicit read actions remain; do not auto-resolve on navigation. Badges count unseen actionable items; show an independent pending-decision indicator when already-read work still needs a decision. Snoozing a decision changes visibility, not authorization; explain when a reminder will return.

Sources include build workflow transitions, approved-plan changes, verified previews, discovery results, verified event changes and schedule occurrences. Extend existing Brief/schedule/notification services. Event records must be durable and replay-safe; no new general-purpose message bus. Start with deterministic summaries and optionally add a bounded editorial summary later.

**Freshness:** show when discovery/rules were last checked, and distinguish “last updated” from “source verified”. Live updates use existing transport where possible and bounded focus-aware polling as fallback. Reconnect catches up from durable state. Opening Brief must not itself start inference or paid scouting. Recurring scouting has explicit frequency, scope and budget; notifications are opt-in and respect timezone/quiet hours. “Constant updates” means continuing useful changes, not constant paid activity.

### Discover

Lead with relevant matches and reasons, then concise filters. Separate hard eligibility from preference fit. Use country, attendance format, solo rules, interests, skills, time and reliable deadline/cost information. Avoid an invented percentage suggesting certainty.

Cards show event, format, deadline, two or three match reasons, eligibility status and last check. “Unknown” is distinct from “eligible”. Open details for authoritative rules, source links, uncertainty and effort expectations. “Explore an idea” starts the planning conversation with that event's context; it does not silently approve a build or enter a contest.

Empty results offer to broaden a specific filter or paste an event link. Failed retrieval must say the search could not finish, not “no events exist”. Cached results stay visibly dated. Preserve saved/dismissed opportunities and per-event evidence isolation.

### Projects and the project workspace

Project cards show name, one-sentence purpose, truthful state, last useful update and one action. Do not repeat the entire intake message as description. Prioritize work needing a decision, then active/recent projects. New/import actions are accessible but secondary to continuing existing work.

One workspace progressively reveals the relevant artifact:

| State | Main canvas | Main action |
|---|---|---|
| Clarifying | Idea summary and only unresolved meaningful questions | Answer question |
| Planning | Scope being prepared, actual progress | Continue conversation |
| Plan ready | Readable outcome, features, exclusions, costs and acceptance | Approve plan / suggest change |
| Building/checking/repairing | Useful progress; stable previous preview if one exists, labelled as previous | Stop work |
| Preview ready | Real interactive app, check summary and limitations | Try app; request a change |
| Needs input | Exact missing choice or connection, retained work | One specific input action |
| Stopped/failed | What stopped, what was preserved, next supported recovery | Resume only when actionable |
| Submission preparation | Requirement checklist, drafts, links and missing attestations | Review submission package |

Plan remains inspectable after approval. Preview remains absent until actual verified output exists; no fake screenshot labelled as a working app. During changes, the last good preview can stay available with a clear version label. Approving a revised plan invalidates old approval only for new effects; do not erase past work or claim the old version is the new one.

Details contains actual failure summaries, test receipts, files, diff, runs, spend and evidence. A “View details” action must land on relevant evidence, not a list of opaque IDs. Technical users can inspect/export; nontechnical users can finish without opening Details.

### Complete surface disposition

| Current surface / route | Disposition | New location / compatibility behavior |
|---|---|---|
| Landing `/` outside app | Keep | Astro; update product claims only after evidence supports them |
| Sign-in | Keep | Standalone, return to landing works; safe callback preserved |
| `/app/onboarding` | Keep/improve only where needed | Before shell; restore progress; server gate remains |
| `/app/` + `pane=channel` | Keep | Mobile Caddie; desktop Brief plus persistent Caddie |
| `/app/` + `pane=brief` | Keep | Explicit Brief, including mobile |
| `/app/discover` | Keep/redesign | Primary Discover; details use selected candidate in same surface |
| `/app/discovery` | Preserve alias | Redirect to Discover with supported identity parameters |
| `/app/projects` | Keep/redesign | Primary Projects list |
| `/app/project?project=…` | Consolidate | Canonical project workspace |
| `/app/design-review` | Merge | Project `view=plan`; exact revision/decision context retained |
| `/app/runs` | Merge | Project Details > Activity; live stage visible in Overview |
| `/app/runs?tab=files` and `/app/artifacts` | Merge | Project Details > Files; exact artifact selection retained |
| `/app/evidence` | Merge | Project Details > Checks; claim/requirement focus retained |
| `/app/judge` | Merge | Submission readiness/assessment contextual view; advisory score labelled |
| `/app/submission` | Merge | Project `view=submission`; Share variant for personal projects |
| `/app/tasks` | Merge | Project Overview milestones; no global task-management product |
| `/app/schedules` | Merge | Project settings > Routines, with outcome updates in Brief |
| `/app/repositories` | Merge | Project settings > Code/source; import entry also in Projects |
| `/app/project/settings` | Keep secondary | Compact project settings; route may stay for compatibility |
| `/app/search` | Keep secondary | Search overlay; direct URL remains usable on mobile and reload |
| `/app/settings` | Keep secondary | Profile/memory, appearance, connections, spending, routines/notifications |
| `/app/usage`, `/app/automations` | Keep aliases | Existing Settings destinations; no primary nav entries |
| Preview share URL | Keep separate | Private/revocable/expiring boundary; no application cookies |
| Not-found, forbidden, offline/error states | Improve | Clear recovery; never expose implementation routing explanations |

Old links resolve through explicit, tested adapters. Do not redirect away `project`, revision, artifact, claim, package or intended settings tab. Unknown/forbidden identity produces a safe error, never another project's default. Avoid keeping both old and new full page implementations after migration.

## 4. Visual and interaction system

Retain the blue identity, Inter typography, existing light/dark seeds, mascot restraint and floating navigation. Use the existing `packages/ui/src/tokens.css` and brand spec as the starting point. Reference Today.ai only for the actionable editorial rhythm and panel model supplied by the user; do not claim a fresh audit of its current product.

Consolidate into a small reusable set: page frame, section heading, project summary, update card, decision card, progress row, empty/error state, detail disclosure, contextual panel and composer. Avoid a new bespoke card/layout for every backend entity.

Proposed token contract, adapted to existing names rather than duplicated:

```css
/* Proposal: promote repeated values into existing tokens. */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-6: 24px;
--space-8: 32px;
--page-gutter: clamp(16px, 2.4vw, 32px);
--reading-width: 68ch;
```

Body/composer text: 16px; supporting copy generally 14px; 12px reserved for ancillary metadata. Use mono only for optional technical details, not every label. Keep existing panel/control radii unless the design review shows a consistent reason to change them. Buttons have clear verb labels and consistent sizes; mobile targets at least 44x44px. One filled primary action per local decision, quiet alternatives, danger styling only for consequential destructive actions.

No header/nav duplication, full-screen approval wall of hashes, giant project descriptions or stacks of nested borders. Short summaries first; depth on demand. Preserve visible keyboard focus, labelled icon buttons, meaningful headings, contrast, reduced motion and accessible live regions. Announce stage changes rather than every token. Restore focus on drawer/overlay close. Composer and nav respect keyboard and safe-area insets.

Review actual light/dark states at narrow and wide widths: empty, loading, long names, populated, error, streaming, decision pending, failed build, ready preview. Screenshots alone do not prove focus/keyboard/scroll behavior.

## 5. AI and execution redesign

### One authoritative context and capability boundary

Build a bounded server-derived snapshot for every turn and refresh after consequential actions. Include confirmed profile/memory, chosen opportunity with sourced constraints, selected project, exact plan/approval, current execution state, usable integrations, recent relevant results, and remaining allowed budget. Distinguish profile preferences from permission; distinguish submitted user data and retrieved content from instructions.

Provide explicit tools for capability/status reads, profile/memory reads, real discovery, event inspection, save/select opportunity, propose plan, request revision, authorize an exact proposed decision through the product command boundary, continue/stop, preview, submission preparation and routine management. Reuse existing scoped services. Tools must report enabled/unavailable with reasons and next supported action. The coordinator should not say it cannot search if an enabled discovery integration exists, or advertise an unavailable capability as working.

Tool implementations reauthorize session/membership and immutable project/run binding on every effect. Authorization never comes from the model's actor ID or text. A UI-provided selected project narrows context; it does not grant access. Inferred memory requires confirmation; corrected/retracted facts disappear from future context and summaries. Account switching clears cached user data and drafts appropriately.

### Deterministic state and decisions

Keep execution truth separate from the assistant's narrative. Derive one shared projection used by chat cards, Brief, Projects and the workspace. Extend the existing workflow and run records; do not create independently writable state copies in each UI.

Suggested boundary shape (validate with existing Valibot conventions):

```ts
type ProjectExperience = {
  projectId: string;
  version: number; // monotonic optimistic-concurrency version
  stage: 'planning' | 'review' | 'building' | 'checking' |
    'repairing' | 'ready' | 'blocked' | 'stopped';
  plan: null | { id: string; revision: string; approved: boolean };
  preview: null | { id: string; revision: string; current: boolean };
  message: string; // bounded, user-facing, derived from actual state
  actions: Array<{
    kind: 'review_plan' | 'approve_plan' | 'suggest_change' |
      'stop' | 'retry' | 'open_preview' | 'resolve_input';
    label: string;
    enabled: boolean;
    reason?: string;
  }>;
};
```

This is a UI projection, not a mandate to add a table per field. Ready-to-submit is a separate checklist outcome; do not conflate it with app build readiness. Stopped is distinct from a failed build and from an operator outage.

Command boundary example:

```ts
// Proposed command input. Scope is derived from the authenticated server context.
type ApprovePlanCommand = {
  projectId: string;
  planRevisionId: string;
  expectedVersion: number;
  idempotencyKey: string;
};
// Recheck membership, exact current revision and policy before committing.
// Atomically store decision + eligible dispatch intent; duplicate is a no-op.
// A stale revision returns a refreshable conflict, never builds a newer plan.
```

Buttons and an unambiguous conversational “approve this plan” invoke the same command for the presented revision. If the conversation reference is stale or ambiguous, show the current plan for confirmation. Once approved, no further “say Approved” loop for that revision. Separately governed deployment/destruction/default-branch changes remain separate decisions. Every action handles pending, success, stale, denied and failed responses consistently.

### Durable orchestration and handoff

The browser displays work; it does not own starting or continuing it. Inspect the current pending dispatch helper, then ensure server-side enqueue/drain/reconciliation using the existing Flue/DO runtime and D1 intent records. Work must continue after tab close, page navigation, stream reconnect and Worker restart. Duplicate delivery must reuse the same logical action and external-effect identity. Uncertain remote effects require reconciliation rather than blind replay.

Transitions:

```text
idea -> planning -> exact plan review -> approved dispatch
     -> build -> independent checks -> verified preview
                 | failure -> diagnose -> bounded repair -> checks
                 | missing input / budget / infrastructure -> pause
any active work -> stop requested -> cancellation confirmed -> stopped
ready -> change request -> revised plan when scope changes -> new checks
```

Plan changes inside an already authorized scope versus changes needing fresh approval must follow an explicit policy, not model discretion. Record approval scope; use conservative revision binding where uncertain. Caddie proposes defaults and tradeoffs; the host enforces authority.

Pass each specialist the full relevant user request, approved scope, current files/output identity, relevant previous attempts and its acceptance responsibility. Specialists return structured results plus artifacts, not a prose claim that work is finished. Use the smallest necessary set of roles per task; a small client-only app does not require seven sequential ceremonies. Product/technical planning, implementation and independent verification are responsibilities; frontend/backend/mobile specialization follows the actual work.

### Model evaluation rather than guessing

Freeze a small behavior suite before comparing routes. First run the current route with corrected tools/context and the same recipe; then compare eligible alternatives under the same conditions. Check the actual event's current competition rules and official provider availability/pricing before selecting a new route. This plan does not assert any alternative is currently allowed or available.

Evaluate: profile recall/correction, personalized live discovery with unknown rules, clarification, exact plan revision, tool selection, same-project continuation, code/test quality, repair convergence, honest blocked response, no reasoning leakage and concise user-facing replies. Track real task success, human interventions, latency, token/sandbox spend and repeatability. A polished transcript with a broken app fails.

Use at least three independent fresh runs per candidate for each critical workflow once paid evaluation is separately authorized and capped. Keep prompts/tools, recipe/version, tasks and acceptance constant; record variance, not just the best demo. Zero unauthorized effects, fabricated passes or cross-project leaks is mandatory. No route ships on average success alone when a safety invariant fails.

Model routes remain frozen per run, including payer/key-reference/pricing. A role-specific routing profile can be introduced only with a persisted immutable mapping and reconciled billing for every specialist. The simpler initial choice is one evaluated route for a run. Never silently mutate an existing run or fall back to another paid model.

### Reproducible build and bounded recovery

Unify real builds and evaluation around `stacks/react-hono/recipe.ts` plus its template. Add a known working React/Bun DOM test setup, reproducible dependencies/lockfile, actual entry point and consistent commands. Run the same install/test/build/preview path in CI, local fixtures and Contree. Do not bake todo-specific implementation or assertions into the generated template.

Keep generated application tests and independent protected acceptance distinct. Agent-accessible shell commands can edit files; naming a role QA is not isolation. Keep the evaluator, manifest and expected behavior outside candidate-write control. Bind receipts to project/run, plan revision, code/image digest, command, environment and actual result. Verify behavior, not merely compilation or a nonempty pass count. Agent-written summaries cannot mint completion evidence.

Repair policy: diagnose, propose a concrete fix, change code, rerun relevant checks. Three unsuccessful repairs on one issue pause; repeat reads are not repairs. In addition, enforce total tool/effect, model-turn, elapsed-time and cost ceilings across install/build/retry loops. A syntax matcher for `bun test` is not a complete budget. Distinguish dependency/network outage, capability/configuration gap and application defect. Retry transient infrastructure only within bounded policy, with no extra approval if already authorized and affordable.

Stop propagates through coordinator, child work and in-flight remote calls. Show “Stopping” until confirmed; reconcile any unknown remote outcome and spending before claiming cancellation is complete. Fresh explicit retry opens a bounded recovery window without erasing history or changing approved scope. No automatic resumption from a passive page read, stale card, duplicate event or expired authorization.

### Discovery, monitoring and submission

Connect configured real retrieval through the existing adapter/evidence boundary; do not disguise stored seeds as live search. Use source URLs, capture times and event-scoped structured rule claims. Treat fetched material as untrusted; retain conflicts and unknowns. Recheck eligibility/deadlines before consequential plans and submission preparation.

Brief discovery updates come from completed permitted scouting, not fabricated proactive messages. Monitoring compares meaningful source changes, identifies affected projects, and suggests a concrete response. Schedules and notifications use existing occurrence keys, actor/project scope and budget controls; no duplicate delivery on replay.

Submission preparation gathers actual app links, repository/export, demo/video requirements, narrative drafts and human attestations. Rubric scoring is advisory and evidence-linked; no guaranteed prize or invented compliance. Final contest submission remains the user's action unless explicitly authorized in a later scope.

## 6. Data, performance and maintainability

Prefer additive migrations and adapters over resets. Preserve existing profiles, conversations, projects, plans, approvals, run receipts, preview versions, Brief read states and schedule history. Inspect migration numbers before allocating the next one. A backfill must be resumable and idempotent; missing historical data stays unknown rather than manufacturing events.

Keep project state responses compact. Avoid making route transitions await model calls or a complete account audit. Brief currently assembles project information; measure its query behavior before adding more per-project work. Batch/index scoped lookups, paginate updates/projects, fetch technical details lazily and cancel obsolete requests. Cache keys include actor and project; clear on sign-out/account changes. Preserve useful previous data while revalidating with a visible stale state where relevant.

Proposed performance acceptance targets, to measure rather than claim: warm navigation shows usable cached content within 200ms p95; cold destination data/meaningful UI within 1.5s p95 under an agreed representative network; visible send acknowledgement within 100ms; no blank shell on navigation. Measure at least 30 repeated navigations and include a populated fixture (20 projects, 500 historical updates), not just empty accounts. Record hardware, network, build and cache state. Track model time-to-first-useful-response separately; do not fake progress to meet a latency number.

Do not add a generalized workflow DSL, agent bus, repository layer for every noun or multiple copies of state. Extract focused modules from the current large files only when required by an owned responsibility. API/schema changes are integrated serially by the integration lead.

## 7. Implementation packets and ownership

Execution is designed for the user's solo build with coding agents. Assign narrow independent packets to subagents when implementation is authorized; runtime specialists inside Caddie are separate from these repository contributors. With four slots, use integration lead, up to two implementers and an independent reviewer. Do not assign four people to `routes.tsx` or `workspace.css` concurrently.

Each packet follows: reproduce/fixture -> focused failing behavioral test where applicable -> smallest implementation -> targeted check -> reviewer evidence -> integrate. Pure visual changes use browser review rather than tests mirroring CSS. Commit only the packet's explicitly selected files when committing is authorized; preserve unrelated dirty work.

### R00 — Baseline, route inventory and evidence ledger

**Owner:** integration lead. **Dependencies:** none.

- Read `AGENTS.md`, `docs/flue-contracts.md`, `docs/plans/2026-10-03-fresh-build/{README,contracts,packets,execution-ledger}.md`, `docs/feature-ledger.md`, the three 2026-10-11 review reports and current WIP.
- Record `git status --short`, SHA, toolchain, currently running services and authenticated flow without extracting tokens. Separate historical fixture success from current live failure.
- Create `docs/reviews/2026-10-12-redesign-execution-ledger.md` with one row per packet and acceptance scenario. Capture before screenshots and exact route/action behavior. Do not reset the user DB.
- Amend outdated status in `docs/reviews/2026-10-11-chat-build-remediation.md` with dated evidence reconciliation, preserving historical context.

**Gate:** all surfaces above accounted for; no unsupported completeness claims; current data/WIP preservation documented.

### R01 — Shared experience contract and transition matrix

**Owner:** integration lead with backend reviewer. **Depends on:** R00.

**Modify:** `packages/contracts/src/index.ts`, `server/build-workflow.ts`, `server/routes/build-workflow.ts`, `server/approvals.ts`, `client/workspace/project-status.ts`. **Create if useful:** `packages/contracts/src/experience.ts`, `server/project-experience.ts`, `tests/project-experience.test.ts`.

1. Write table-driven tests for planning/review/approved/building/failed/stopped/ready, stale revision and preview mismatch.
2. Define the shared projection and command contracts, keeping actor authorization server-derived.
3. Implement conditional/versioned transitions and exact decision idempotency on existing tables, adding only required fields in a new migration.
4. Make all surfaces consume this projection; avoid separate client guesses from last message or last run.
5. Run `bun test tests/build-workflow.test.ts tests/plan-decisions.integration.test.ts tests/project-status.test.ts tests/project-experience.test.ts` and typecheck.

**Gate:** duplicate approval, stale approval, incorrect preview revision and denied actor cannot start work. Show a short passing/failing state matrix, not just a suite count.

### R02 — Durable delivery and bounded cancellation/recovery

**Owner:** runtime engineer. **Depends on:** R01.

**Modify:** `agents/coordinator.ts`, `agents/host-context.ts`, `server/coordinator-host.ts`, `server/build-workflow.ts`, `server/operations.ts`, `client/conversation/workflow-dispatch.ts`, `client/conversation/ProjectWorkflow.tsx`; integrate route/runtime changes through lead. **Tests:** `tests/build-workflow.test.ts`, `tests/sandbox-durability.test.ts`, `tests/controls.integration.test.ts`, `tests/live/flue-lifecycle.spec.ts`.

1. Reproduce browser-dependent dispatch, duplicate delivery and approval-reprompt cases with controlled fixtures.
2. Implement server-owned durable dispatch using supported pinned Flue APIs and existing intent/effect keys; reduce client helper to requesting/observing commands.
3. Propagate full request/current plan/context to child work; reconcile remote identity before retry.
4. Add holistic ceilings and explicit stopping/cancelled/uncertain outcomes, preserving saved files and liability.
5. Verify tab-close, reconnect, process restart, duplicate event, stop-during-install, revoked membership and stale approval.

**Gate:** one approval -> one logical job without an open browser; no work after confirmed stop/revocation; no self-resuming repair loop. Live recovery evidence is separate from local simulation.

**Scope note (2026-10-12 source-inspection spike, LOCAL VERIFIED by code read; no sandbox run or paid call made).** The feasibility risk this packet was pulled forward to retire is resolved in the architecture's favour; the implementation surface is smaller than step 2 above implied. Findings:

- **Approval write path is already durable and server-authoritative.** `decideWorkflow()` in `server/build-workflow.ts` records the durable approval, writes the `plan_decisions` row and transitions `phase` to `building` with `pendingKey = decision:<approvalId>` + `pendingBody`, all inside the approve HTTP call — not in any mounted React component. Its `phase === 'review'` guard plus the keyed `pendingKey` already enforce one-approval-one-build idempotency (the §5 `expectedVersion`/`idempotencyKey` contract, implemented).
- **The sole browser dependency is dispatch delivery.** `client/conversation/workflow-dispatch.ts` parks the pending `(pendingKey, pendingBody)` in D1 and relies on the browser calling `resumeWorkflow()` -> `createFlueClient().send()` to hand the submission to the coordinator DO. A tab closed between approval-write and that client send leaves the intent recorded but never delivered. This is the one real browser-dependency to remove.
- **Flue 2.2.2 already provides the durable-delivery primitive.** Per `docs/flue-contracts.md`, the coordinator DO drains unsettled submissions on `onStart` (30s lease + 15s scan, same-`submissionId` replacement), LIVE VERIFIED after whole-runtime SIGKILL, with zero application recovery code. Durable abort (`abort_requested_at`, resurrection blocked) is likewise already proven and backs the stop/revocation half of the Gate.

**Narrowed step 2:** move dispatch from the browser `client.send()` to a server-side enqueue performed at approval time, keyed by `decision:<approvalId>`, and let the DO's existing drain own execution and re-delivery. Reduce the client helper to *observing* workflow state, not *driving* it. Do not build a new enqueue/drain/abort mechanism — reuse the proven runtime primitives.

**The one item still requiring LIVE proof (not a code read):** Flue's drain is at-least-once, never exactly-once (`docs/flue-contracts.md`: "interrupted remote work re-runs; keyed/idempotent reconciliation is application policy"). The sandbox already keys every `execute` by `operationKey` and reconciles via `getOperationReceipt`, so re-delivery should reuse the same logical operation — but this is the behaviour step 5's tab-close + process-restart + duplicate-event checks must actually exercise in a supported runtime. Treat that reconciliation under re-delivery as the packet's load-bearing live gate; the rest is LOCAL VERIFIED foundation.

### R03 — Single recipe and protected acceptance

**Owner:** build/runtime engineer. **Depends on:** R01; coordinate same-file edits after R02.

**Modify:** `stacks/react-hono/{recipe.ts,template/}`, `server/coordinator-host.ts`, `agents/specialists.ts`, `agents/skills/build-verify/SKILL.md`, `agents/completion-gate.ts`, `server/adapters/{sandbox,sandbox-persistence}.ts`. **Tests:** `tests/sandbox.contract.test.ts`, `tests/agent-permissions.test.ts`, `tests/p09-local.test.ts`, `tests/live/forge-react-hono.spec.ts`.

1. Write a minimal generic component/environment smoke case that fails under the current inconsistent setup.
2. Make the real chat scaffold use the same versioned recipe and frozen dependency setup as evaluation. Recompute expected recipe digest deliberately.
3. Isolate protected checks and bind actual executor/browser receipts to the candidate version.
4. Detect removed/weakened acceptance, empty tests, fabricated receipts and a screenshot without a usable app.
5. Run install/test/build locally and then within an authorized sandbox. Preserve truthful capability labels if either fails.

**Gate:** generic React fixture passes reproducibly; injected application defect fails protected acceptance; identical recipe used by chat. Fixture success is not yet the live todo acceptance.

### R04 — AI context, tools, response quality and evaluation harness

**Owner:** AI engineer. **Depends on:** R01, with final live evaluation after R02/R03.

**Modify:** `server/coordinator-context.ts`, `agents/{coordinator,tools,permissions,specialists,providers}.ts`, `server/{profiles,memory}.ts`, `client/conversation/Channel.tsx`. **Tests:** `tests/coordinator-context.test.ts`, `tests/home-chat-tools.test.ts`, `tests/memory.integration.test.ts`, `tests/conversation-scope.test.ts`. **Create:** `tests/acceptance/ai-behavior-cases.json`, `scripts/evaluate-ai-behavior.ts`.

1. Freeze behavior cases and actual output rubric before tuning prompts.
2. Complete capability/state reads and scoped commands; ensure model context reflects actions immediately.
3. Replace contradictory instructions with a concise role and authoritative tools. Do not rely on a growing list of exact phrase patches for general intent handling.
4. Render typed public parts only; reject reasoning/serialization leakage at the transport presentation boundary.
5. Add a dry-run/evaluation harness with no network by default. Implement a separately enabled, budgeted live mode recording model/version, receipts, time and spend.
6. Compare only approved/eligible routes after verifying official rules and pricing; new runs for changed routing.

**Gate:** corrected context is used accurately; no double approval or invented success; ambiguous target clarified; a generic tool failure produces useful recovery. Local mocked replies cannot prove model behavior.

### R05 — Brief update model and producer integration

**Owner:** product/backend engineer. **Depends on:** R01; parallel with R02 using disjoint files.

**Modify:** `server/{brief,schedules,notifications,sentinel}.ts`, `server/routes/brief.ts`, `client/queries.ts`, `client/brief/navigate.ts`; contracts/migrations through lead. **Tests:** `tests/brief.test.ts`, `tests/schedules.integration.test.ts`, `tests/stack-notify.integration.test.ts`. **Create if needed:** `tests/brief-lifecycle.test.ts`.

1. Test event identity, repeated ticks, resolution, superseded revision, seen versus pending, timezone, snooze and cross-actor isolation.
2. Extend existing Brief representation for useful updates; keep action payloads typed and validated.
3. Connect workflow/preview/discovery/rule/schedule sources; batch and paginate account aggregation.
4. Give every unresolved item a supported next action or clear informational status; replace internal-ID headlines.
5. Retain read state where identity maps safely; otherwise mark migrated state unknown, not resolved.

**Gate:** one real change yields one useful update; replay creates no duplicates; opening/reading never approves; stale action refreshes safely; events continue while browser is closed.

### R06 — Shell, spacing and project workspace consolidation

**Owner:** frontend engineer; one owner for shared CSS. **Depends on:** R01. Can prepare fixture-backed layouts while backend packets proceed.

**Modify:** `client/workspace/{Chrome,Shell,ProjectTabs}.tsx`, `client/{routes,surface}.tsx`, `client/workspace.css`, `packages/ui/src/tokens.css`, `client/conversation/{ProjectWorkflow,Channel}.tsx`, `client/planning/DesignReview.tsx`, `client/artifacts/InteractivePreview.tsx`. **Create:** `client/project/ProjectWorkspace.tsx`; extract other components only as needed.

1. Build reviewable desktop/mobile fixture states for Brief, plan, building, failure and preview; retain existing design language.
2. Introduce common frame/spacing/action patterns and the workspace's Overview/Plan/Preview views.
3. Make chat and workspace reuse the same plan/decision/progress/preview components.
4. Implement selected-view URL state and the explicit legacy route map; test Back/Forward/reload and selection identity.
5. Keep chat drafts/scroll/transport stable, tablet overlay focused, mobile composer above nav/keyboard.
6. Remove old page renderers only after redirect and capability coverage passes.

**Tests:** `tests/browser/{shell-v2,project-v2,projects-v2,project-workflow,interactive-preview,artifacts,states}.spec.ts`, `tests/routing.test.ts`. Add focused redirect tests for every row in the surface matrix.

**Gate:** no regression in access to plan/files/checks/submission; no manual navigation required to approve or try an app; six viewport sizes and both themes reviewed with recorded defects closed.

### R07 — Brief experience and contextual details

**Owner:** frontend engineer. **Depends on:** R05/R06.

**Modify:** `client/workspace/Shell.tsx`, `client/brief/{DecisionCard.tsx,navigate.ts}`, `client/queries.ts`, `client/runs/RunInspector.tsx`, `client/evidence/Drawer.tsx`, `client/settings/Settings.tsx`; CSS through its owner. **Tests:** `tests/browser/{brief,project-workflow,settings,search}.spec.ts`.

1. Build Needs you / Updates / Coming up / Earlier with honest empty/stale/error states.
2. Wire one meaningful primary action; plan decisions inline or contextually opened without a full-page detour.
3. Implement independent seen/resolved/snooze state and transparent notification/routine preferences.
4. Make failure details show actual failed check, plain implication, attempts and supported recovery; receipts are secondary.
5. Verify expired/revoked previews and changed plans update both card and workspace together.

**Gate:** users can identify what needs them, what Caddie is doing and what is ready in ten seconds during a moderated review; no technical explanation required to act.

### R08 — Real discovery and event-aware planning

**Owner:** discovery/backend engineer. **Depends on:** R04/R05; UI shares R06 patterns.

**Modify:** `server/{discovery,eligibility,coordinator-context,planning}.ts`, `server/evidence/{sources,claims,authority,deadlines}.ts`, `server/routes/discovery.ts`, `agents/tools.ts`, discovery components currently in `client/surface.tsx`. **Tests:** `tests/{discovery,discovery-saved.integration,coordinator-context,evidence}.test.ts`, `tests/browser/discovery-journey.spec.ts`.

1. Inventory configured adapters/credentials and identify the authoritative sources; verify current external API/rules docs when implementing.
2. Add real retrieval behind existing allowlisted fetch/adapters, with failure/stale markers and no hidden paid calls.
3. Apply event-specific eligibility and explainable profile fit; preserve unknown solo/age/country/cost rules.
4. Connect selected opportunity -> scoped idea -> saved plan -> actionable Brief update.
5. Verify live current event results against official source details within the approved test budget.

**Gate:** completed profile materially influences recommendations; multiple events cannot borrow each other's rules; expired events aren't recommended as open; original source and check time are available.

### R09 — Import, delivery and remaining-stack continuity

**Owner:** integrations engineer. **Depends on:** R02/R03/R06; activate stacks sequentially after first-stack gate.

**Modify:** `server/{repositories,submission,judge,previews,stacks}.ts`, corresponding route modules, `client/submission/Package.tsx`, `client/settings/ProjectSettings.tsx`, the five `stacks/` recipes and `agents/skills/` as needed.

1. Map all original P01–P17 capabilities to the new surfaces; no silent deletions.
2. Import only authorized repositories with detected stack/branch and proposed changes; preserve history and existing tests. Do not execute untrusted imported scripts outside the sandbox.
3. Integrate export/repository/PR, preview lifecycle, rubric and submission package into contextual project actions. Keep publication and final attestations explicit.
4. Prove each remaining stack using its own install/test/build/artifact/browser or emulator requirements; Flutter additionally needs device/emulator evidence and backend contract checks.
5. Label currently unverified outputs honestly and offer a supported route; do not turn “later activation” into removal from agreed scope.

**Tests:** existing `tests/github.integration.test.ts`, `tests/preview-access.integration.test.ts`, `tests/submission.test.ts`, `tests/judge.test.ts`, stack-specific tests under `tests/live/stacks/` and relevant browser suites.

**Gate:** personal and hackathon projects both reach useful delivery; import has a real edit/check/diff journey; all five stacks have tracked acceptance before full-scope completion.

### R10 — Integrated usability, performance and release decision

**Owner:** independent reviewer with integration lead. **Depends on:** R02–R09 for full scope; first-stack milestone may be reviewed earlier and explicitly labelled partial.

- Run the acceptance matrix below with new and returning accounts, desktop/mobile and two-user negative isolation.
- Measure navigation, query volume, stream recovery and model response time separately. Fix missing invalidations, remounts and redundant loads before speculative optimization.
- Have at least one nontechnical participant and one time-constrained technical participant complete the core scenario without developer coaching. Agent role-play is not human usability evidence.
- Update feature ledger and release evidence with exact environment, SHA/WIP digest, fixtures versus live boundaries, provider receipts, artifact hashes, costs and limitations.
- Roll out only after explicit release authorization and hosted checks; a local demo is not production readiness.

**Gate:** no unresolved critical journey failures, contradictory approvals, false readiness, data leaks or inaccessible primary actions. Record GO/NO-GO for the tested scope, not the entire product by implication.

## 8. Dependency sequence and review checkpoints

```text
R00 -> R01
        ├─ R02 -> R03 -> runtime proof
        ├─ R04 -> R08
        ├─ R05 -> R07
        └─ R06 -> R07 -> R09
Runtime + AI + UI + discovery -> first-stack integrated acceptance
R09 remaining stacks + R10 -> full agreed-scope acceptance
```

Coordinate overlaps explicitly: R02/R03 both touch host runtime; R04/R08 share tools/context; R06/R07 share Shell/CSS. Run those overlapping edits serially or through the file owner. Shared contract/route/config/migration/lockfile changes are integration-lead-owned per AGENTS.md.

Review points: (A) state/route contracts, (B) desktop/mobile fixture designs, (C) actual approved build reaches working preview, (D) discover-to-submission and import, (E) full stack/release evidence. The user should review concrete screens and journeys, not abstract framework choices. Do not start a broad visual rewrite before (A), or polish every secondary panel before (C).

## 9. Acceptance matrix

| Scenario | Required evidence |
|---|---|
| New user signs in | Standalone profile before app; no bypass via direct project URL |
| “What do you know about me?” | Correct stored profile/confirmed facts; no invented facts; correction persists |
| “Find hackathons that fit me” | Actual retrieval or truthful disabled-source explanation; profile reasons; official sources; no ineligible-as-eligible claims |
| Opportunity -> idea | Event constraints carry into saved scoped plan without copy/paste |
| Personal todo request | Same project, clear proposal, no agents/tool jargon, no needless stack interrogation |
| Approve plan from chat or Brief | One exact revision decision, one logical build, immediate state agreement everywhere |
| Browser closes after approval | Work continues or honestly pauses for a server-defined reason; reopening catches up |
| Build fails | Real diagnosis and bounded repair; no repeated approval for unchanged plan; no false ready |
| Repair exhausts limit | Clear plain blocker, retained files/history, no further unapproved effects or endless streaming |
| Stop during remote work | Cancellation intent propagates, confirmed/unknown result shown accurately, no resurrection |
| Ready preview | Actual iframe, current version and receipt-backed checks; protected against candidate tampering |
| Request a change | Uses same project and retained prior version; precise revised scope/approval if required |
| Brief updates | Durable, deduplicated, source-backed, useful action; read/snooze never decide |
| Old deep links | Exact project/artifact/claim/revision retained or safe specific error |
| Imported repo | Existing app inspected, requested change applied and checked, diff preserved, no destructive default-branch effect |
| Submission | Real links and requirements, unknowns/missing attestations explicit; no silent final submission |
| Access boundaries | Account/project isolation across HTTP, streams, cards, artifacts, previews and cached context |
| Responsive/accessibility | Keyboard and screen reader basics, light/dark, mobile keyboard/safe area, tablet overlay, desktop independent scrolling |

**Todo behavioral acceptance:** add with button and Enter; trim whitespace/reject blank; complete/reopen; delete; All/Active/Completed; clear completed only; accurate counts; useful empty states; local persistence after reload; responsive 320px; keyboard/focus/labels. Test the real generated preview, including reload. Do not manually implement the todo outside Caddie or delete failed checks to make the run pass.

The first milestone requires one complete real todo journey plus a change request. Reliability sign-off requires at least three fresh independently generated successes under the selected configuration, plus deterministic and live failure/recovery coverage. Report the sample size; three runs are a release gate, not statistical proof of universal reliability. Paid repetition requires a separate bounded evaluation authorization; prior permission for one todo acceptance run is not unlimited evaluation permission.

## 10. Verification commands, evidence and rollback

Existing commands, run from repository root unless specified:

```bash
git status --short
bun run typecheck
bun test tests/build-workflow.test.ts tests/coordinator-context.test.ts tests/agent-permissions.test.ts tests/sandbox-durability.test.ts tests/sandbox.contract.test.ts tests/project-status.test.ts tests/controls.integration.test.ts
bun test tests/brief.test.ts tests/discovery.test.ts tests/conversation-scope.test.ts
bun run build
bunx playwright test tests/browser/shell-v2.spec.ts tests/browser/brief.spec.ts tests/browser/project-workflow.spec.ts tests/browser/interactive-preview.spec.ts
```

New test paths named in packets are to be created; they do not pass merely because this plan lists them. Run the relevant suites after each packet; run the broader acceptance set at integration. Confirm supported runtime first: prior environment required Node 26 for Flue/Vite, while default Node 22 failed. The root Playwright config starts/reuses a local preview on 4173; isolate test state and verify the process/build instead of accidentally reusing unrelated state. Never reset the user's development DB for verification.

`vite preview` can prove built routes/UI with fixtures but the pinned Flue contract documents an agent-dispatch limitation there. Real agent acceptance uses a supported dev/live runtime and normal authentication, with real configured providers. Browser fixture success is SIMULATED at mocked boundaries even when Chromium/React are real.

Evidence ledger columns: packet/scenario, code version, environment, prerequisites, command or journey, exit/outcome, source/model/sandbox receipts, artifact/version, screenshot/trace, cost, reviewer, remaining gaps. Use exactly LOCAL VERIFIED, LIVE VERIFIED, SIMULATED, DOCUMENTATION ONLY, BLOCKED or FAILED. Never print credentials, session tokens or private chain-of-thought.

Rollout/rollback:

1. Add shared projection/commands while old UI still works through adapters.
2. Switch shell/workspace/Brief behind a temporary internal rollout flag if needed; do not duplicate state storage.
3. Verify migration/backfill and old links against a copied fixture, then integrate.
4. Roll back the UI to the compatible renderer if necessary; retain new durable decisions/effects and records. Do not reverse reality or delete executed work.
5. Pause new admissions on a runtime invariant failure; preserve current artifacts and reconcile uncertain operations. Schema rollback must never restore permission for an already revoked action.
6. Remove rollout flag and obsolete renderers once evidence is complete. Update docs and feature ledger in the same packet.

## 11. Ready-to-use agent handoff

> Implement `docs/plans/2026-10-12-caddie-experience-and-ai-redesign.md` in `/Users/captjay98/projects/caddie-forge`. Start with R00 and R01. Preserve the dirty worktree and all user data. Keep Brief as a primary destination for continuing actionable updates; keep persistent right-hand desktop chat and the mobile floating Caddie/Brief/Discover/Projects navigation. Build one consolidated project workspace and a reliable server-owned workflow, not another set of disconnected pages. Read AGENTS.md and Flue contracts. Use narrow subagent packets with disjoint ownership where useful, and an independent reviewer; integrate shared contracts/routes/config/migrations serially. Treat prior audit claims as historical and verify the current code. Do not claim readiness from mocks, agent prose or a template demo. Prove the full todo journey through Caddie, then a change request, discovery, import and delivery. Preserve all five agreed output stacks with staged verification. Do not run new paid model comparisons, deploy, publish, reset databases or commit unrelated work. Prepare a concrete bounded live-evaluation request when that gate is reached. Report exact evidence, unresolved failures and the next packet; keep explanations understandable to a nontechnical owner.

## 12. Definition of completion

The redesign is complete when users can understand their updates, discover suitable opportunities, approve a plan once, receive a working application, request changes and prepare delivery without coordinating specialists or navigating diagnostic pages. All preserved capabilities have a clear home, all required output stacks have their own evidence, and machine state, chat claims and Brief agree. A simpler-looking interface with the same unreliable execution does not meet this plan.
