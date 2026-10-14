# Projects UX repair — 2026-10-11

Scope: focused repair of Projects, project overview, plan review, and conversation entry. The approved desktop split and mobile floating navigation remain intact. The complete AI build workflow is still OPEN.

## Problems and changes

| Problem | Repair |
| --- | --- |
| New project redirected a returning user into account onboarding | Opens the account conversation with an idea prompt; navigation creates no model request |
| Cards presented inferred progress and no clear continuation | Readable purpose, a status from actual brief events, and a Continue with Caddie action; pending decisions have their own action |
| A blocked result could mark Build as completed | Removed inferred step percentages/bars; blocked events report Needs attention |
| Empty project overview offered no next step | Provides a continuation action; project tasks fold below the main project information |
| A missing updates/preview response looked like no updates/no preview | Failures have explicit error states rather than an invented empty state |
| PRD, spec, and note revision counters were mixed | Plan review selects PRD revisions only |
| Raw Markdown, hashes, and policy details dominated review | Uses the existing Markdown renderer; approval details and history are folded below the plan |
| Approval state disappeared on reload | Authenticated exact-intent lookup restores the current revision's server decision; a changed revision does not inherit it |
| Suggest a change had nowhere to enter a change | Requires feedback and saves it against the revision using the existing plan-decision route |
| An approval failure immediately closed its own error window | Error stays visible; the window closes only after a successful save |
| Approved plans still offered opposite re-decisions | Settled decisions show one continuation action and cannot be re-decided through the review controls |
| Chat displayed two competing first-run messages | The shell's contextual welcome suppresses the generic empty-transcript prompt |

The readable renderer reuses existing code:

```tsx
<div className="plan-body" data-testid="plan-body-content">
  <Markdown text={latest.body} />
</div>
```

Conversation continuation uses the existing scoped workspace:

```tsx
onClick={() => chrome.openProject(project.id, true)}
```

No new UI framework, package, database migration, or agent orchestration system was added.

## Verification

- LOCAL VERIFIED: composed production build; app TypeScript check; 4 project-status tests.
- LOCAL VERIFIED: 24 controls integration tests against local workerd/D1, including exact-intent decision reads, changed-revision isolation, and rejection of another workspace's actor. OAuth and external-provider boundaries in these tests are SIMULATED.
- SIMULATED at the API boundary: 18 browser tests against the composed app. Covered desktop/mobile continuation, empty states, readable Markdown, persisted decision presentation, required feedback payloads, refusal errors, immutable decision controls, and existing artifact/build navigation.
- Visual review: desktop Projects, 390px mobile Projects, and plan review screenshots generated with test fixtures. These are not the signed-in user's project or a live AI build.
- Root typecheck: BLOCKED by DOM type errors in the separate concurrently present tests/browser/__colorprobe.spec.ts. That file and unrelated WIP were preserved. App typecheck passes.
- Build used the already installed Homebrew Node 26.3.0. Default Node 22.15.0 cannot load Flue's TypeScript configuration. No runtime was installed or upgraded.
- No paid provider calls, deployment, publishing, or commits.

## Runtime work still required

1. After creation, retain the original brief and move into project work automatically; Home still tells users to open another conversation.
2. A saved approval must resume the correct coordinator run. Continue with Caddie currently opens the scoped chat; it does not start a build.
3. Make saved change feedback available in the coordinator's project context and draft a new revision before further building.
4. Expose a usable preview directly in the project and chat. The current overview still points to a link in chat; preview metadata alone does not prove working software.
5. Verify build completion from trusted command receipts, retain sandbox state across requests/restarts, and fix the completion/role boundaries identified in the AI audit.

See the existing AI-system audit for the underlying runtime findings. These UI tests are not acceptance evidence for the complete todo-app build.
