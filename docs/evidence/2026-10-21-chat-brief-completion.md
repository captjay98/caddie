# Chat and Brief completion — 2026-10-21

Scope: complete the seven approved compact cards, retained decisions, chat/activity/composer consistency, responsive behavior and preview access. The four mobile tabs and persistent input stay in place. Projects/Discover redesigns remain paused for owner acceptance of this packet. Local workspace changes are uncommitted; unrelated onboarding, demo, config and colleague work were preserved.

## What changed

### Seven real card variants, shared between chat and Brief

**LOCAL VERIFIED** implementation: Plan approval, Live build, Repairing, Preview ready, Deadline, Opportunity fit and Earlier use the shared compact header/panel family, 13px corners, consistent primary/secondary controls and theme-aware tones. Typed state, server IDs and actions choose the design; display prose never determines authorization. Specialized workflow and discovery cards adapt their actual features/stages/rules to this family. Sample mockup features, check totals and countdowns are not fabricated when the records lack them.

```tsx
<CardHeader design={design} context={name} status={status} />
<CardPanel title="What you’re approving">{realPlanContent}</CardPanel>
```

Generic cards use `card-design.ts`; specialized workflow, build activity, spending approval and opportunity views reuse `CardHeader`. The repair style follows active failing checks. Technical file/command details fold beneath readable progress. Delivery/settings controls are available through “App settings, versions & delivery”; feature outcomes, the app itself and its test inbox remain directly available. Ready previews and saved opportunities stay visible in Brief instead of immediately folding away as handled work. Future armed schedules read “Watching”, not “Done”.

### Builds and repairs now appear in Brief

Reproduction: start a workflow build; chat shows it but `/api/brief` only contains approvals/older results. Root cause: no projection of `build_workflows` into Brief.

`server/brief.ts` now derives build, active repair, stopped and ready-preview cards from the workflow and its latest run round. A failed round while the workflow is building says the check needs another pass; it never claims the entire build stopped. The workflow owns completion and the preview’s exact output ID. All open work remains visible; the recent handled feed remains bounded.

### Earlier retains exact original decisions and can load older records

The previous recent window hid older approvals after enough new records accumulated. `GET /api/brief/history` now keyset-paginates durable handled/expired approvals in batches of 40, ordered by decision time and ID. It derives authorized project IDs from session membership, binds every SQL value, and excludes pending unexpired decisions. The cursor uses both timestamp and ID so equal timestamps neither duplicate nor skip records. History is loaded only after “Load older decisions”; empty returning-user Briefs also expose it.

```sql
and (decision_time < ? or (decision_time = ? and id < ?))
order by decision_time desc, id desc limit 41
```

The SQL uses the actual `coalesce(decidedAt, …)` expression for `decision_time`; the extra row determines whether another page exists. Every history card opens the original approval ID. The previously implemented read-only Plan history still matches the original resource ID and body hash, refusing to substitute a newer revision.

Chat’s immutable snapshots now follow the current Brief state. A generic build/repair snapshot follows its run into a ready preview even though its action target changes from run ID to output ID. When it leaves the recent feed it can read the workflow without opening another agent transport. A saved preview snapshot continues to open its own output, rather than silently following a newer one. Older approval snapshots read the durable approval record when outside the recent feed. Spending cards read server status on mount and keep decisions in the shared query cache; later revocation/supersession can replace a previous approval. Workspace refresh invalidates those records and history too.

### Chat, composer and feedback

- Live activity now reads Flue’s actual `dynamic-tool` events; the previous `tool-*` filter missed them. Active tool summaries use the working label directly, avoiding incorrect conjugations.
- Shared message spacing, readable line height, wrapping and contained code/table overflow support narrow panels.
- Composer input uses 16px text, 44px controls, 13px corners and a visible focus treatment. IME composition Enter does not prematurely send a message.
- A “Back to latest” button preserves intentional history reading and lets the person return to the newest turn. Mobile placement clears the existing fixed composer/navigation.
- Current-card observers reuse the account Brief cache without creating their own polling clocks. Active builds refresh more frequently; idle records less frequently. No claim of a measured whole-app speedup is made.
- Plan approval now says “Approve plan”; approval begins the design step, so the previous build wording was misleading.

### App previews outside chat, without resetting the running app

Reproduction: the only generated-app entry point is an inline frame plus Download app. Full-window controls existed for design previews, but not interactive apps. Brief preview actions also went to Files, dropping the exact preview identity.

Changes:

1. `/app/preview?project=…&preview=…&source=workflow|share|artifact` is a refreshable app view. Chat’s “Open app preview”, Brief’s preview action and project Overview’s “Try your app” all reach it.
2. Share previews resolve their own revision ID. Missing, expired or revoked shares show an explicit state; they never substitute the latest app.
3. Interactive preview has a native full-window dialog. The same iframe DOM node remains mounted through expand/close, retaining unsaved form state, storage and the server bridge. Escape and the close control restore inline viewing. Generated code keeps its opaque-origin sandbox and existing network policy.
4. Independent review found that consulting the *current* workflow’s kind/server flags could break an older preview during a new build. The new scoped metadata endpoint binds capabilities to the requested output:

```ts
const manifest = await readOutputManifest(db, scope, outputId);
// Response contains outputId, kind and hasServer — no generated file bodies.
```

The client caches this by actor, project and output ID. It does not switch an open web preview to Flutter or remove its bridge when the newest workflow changes. Copied apps use the same exact-output path. Downloads remain secondary.

### QR regression found during verification

The delivery-disclosure checks exercise Android download and private QR controls with fixture URLs. Screenshot decoding exposed a real obstruction: the new floating “Back to latest” control covered part of the QR image. Visual inspection showed the button directly over the lower QR cells. Moved that control into its own layout row, reserving mobile composer clearance, rather than overlaying app content. The browser test also waits for image decoding before inspecting pixels. The QR generator remains unchanged. No token is sent to an external QR service. Post-fix results are recorded below.

## Implementation files

New: `client/brief/{CardFrame.tsx,card-design.ts,DecisionHistory.tsx}`, `client/artifacts/PreviewPage.tsx`.

Updated: `client/brief/{DecisionCard.tsx,actions.ts,navigate.ts}`, `client/conversation/{ApprovalCard.tsx,Channel.tsx,Composer.tsx,ProjectWorkflow.tsx,HackathonResultsCard.tsx}`, `client/project/BuildProgress.tsx`, `client/{queries.ts,routes.tsx,surface.tsx,workspace.css}`, `client/workspace/{Chrome.tsx,Shell.tsx}`, `server/brief.ts`, `server/routes/{brief.ts,build-workflow.ts}`. Earlier foundation files remain part of the local packet; see `2026-10-20-ui-foundation.md` for those reproductions and fixes.

Tests: `tests/card-design.test.ts`, `brief.test.ts`, `decision-card-status.test.ts`; browser `brief`, `conversation`, `project-proposal`, `project-workflow`, `project-v2` suites. Existing shell and interactive-preview tests were also exercised.

## Verification receipts

- **LOCAL VERIFIED** — focused unit/service checks, including real SQLite migrations, approval pagination/scope, workflow projection, cache/phase behavior, build output/import/judge-example cases: 125 passed, 782 assertions, nine files; exit 0 before the final review refinements. Final receipts appended below.
- **LOCAL VERIFIED** — `bun run typecheck`, `bun run build`, `git diff --check` passed before the final review refinements. Final receipts appended below.
- **SIMULATED** — composed-app browser checks use fixture auth/API/model boundaries, not paid/live providers. Initial runs caught obsolete test interactions after controls became disclosures, then 105/107 passed with a card-fixture ambiguity and QR decoding failure. The fixture ambiguity was corrected; a subsequent 106/108 pass still exposed QR decoding. Those failed runs are not green evidence.
- **FAILED** — the first sandboxed browser launch and preview registry setup failed due to macOS process/Wrangler permissions. Tests were restarted with process permission and temporary registry/config paths. No application success is inferred from setup attempts.
- **FAILED** — the broad first run’s real Flutter build/CDN journey exceeded its timeout. It is excluded from the final fixture-backed UI selection; actual Flutter toolchain/CDN execution is not verified by this packet. Existing sandbox/CSP behavior was retained.
- **DOCUMENTATION ONLY** — independent code review identified exact-output metadata, stale run/approval snapshots, schedule labeling and mobile latest-button clearance; all were corrected and re-reviewed with no remaining material finding. Browser regressions supply runtime proof separately.

No deployment, publishing, remote push, purchase, paid provider call or production data mutation was performed. The signed-in owner’s local account was preserved without injecting fixture projects or cards. A prior full-repository run had discovery timing failures (see the foundation report); this packet’s scoped checks do not claim release-wide readiness. Native-device keyboard acceptance and real provider build execution remain outside this fixture-backed proof. The owner’s visual acceptance is the next checkpoint; further surface redesigns wait.

## Local acceptance

Open http://localhost:5176/app/ and test Caddie/chat and Brief. Review an actual plan, continue into build/repair/ready, refresh, read Earlier and load older decisions. Resize/collapse/reopen chat while keeping a draft; check narrow/mobile scrolling. Use Full screen, Close/Escape and Open app preview, then reload the preview page. Existing account data may be empty, so cards appear when genuine workflow records exist; no demo data was installed into the account.

## Final post-fix receipts

All commands below ran against the final local implementation; no source edits followed them.

**LOCAL VERIFIED** — `bun run typecheck`: exit 0. `bun run build`: exit 0; composition build `409b16b44a2f`, no asset collisions. Existing Vite deprecation and chunk-size warnings remain. `git diff --check`: exit 0.

**LOCAL VERIFIED** —

```sh
bun test tests/card-design.test.ts tests/brief.test.ts tests/brief-lifecycle.test.ts \
  tests/decision-card-status.test.ts tests/project-status.test.ts tests/workflow-query.test.ts \
  tests/build-workflow.test.ts tests/import-preview.test.ts tests/judge-example.test.ts
```

125 passed, 782 assertions, nine files, 3.91s; exit 0. Real schema/service boundaries are tested locally; sandbox/model adapters inside relevant unit fixtures remain simulated.

**SIMULATED** —

```sh
XDG_CONFIG_HOME=/tmp/caddie-chat-brief-config \
WRANGLER_REGISTRY_PATH=/tmp/caddie-chat-brief-registry WRANGLER_SEND_METRICS=false \
bunx playwright test tests/browser/brief.spec.ts tests/browser/project-proposal.spec.ts \
  tests/browser/shell-v2.spec.ts tests/browser/project-workflow.spec.ts \
  tests/browser/conversation.spec.ts tests/browser/interactive-preview.spec.ts \
  --grep-invert 'an Android app runs its real Flutter' --workers=1 --reporter=line --max-failures=3
```

111 passed, 54.8s; exit 0. Includes all seven card variants in both surfaces, actual 13px geometry, actionable original and older history, current run-to-preview cards, approval then revocation in the same mounted chat, 160-message chat history, preserved reading position and draft, collapse/reopen, mobile jump-button clicking and refresh, mobile navigation/composer invariants, drag/keyboard resize, interactive sandbox/storage isolation, exact share targeting, full-window unsaved form preservation, separate preview-page reload, copied-app server relay, and older output capabilities while a new build is changing. Android QR images decode from rendered screenshots after moving the latest-button row out of the content overlay.

**SIMULATED** — `bunx playwright test tests/browser/project-v2.spec.ts --grep 'Try your app opens the exact app' --workers=1 --reporter=line`: one passed, 2.9s; exit 0. Verifies the existing mobile Overview entry point opens the separate exact-output preview page. Total scoped browser acceptance: 112 passed.

**DOCUMENTATION ONLY** — independent review re-read the fixes and found no remaining material issue in those changes. After the pixel test exposed the overlay, the latest-button placement was further changed to its own layout row; the final long-chat/mobile and QR screenshot checks above verify the result.

**LOCAL VERIFIED** — signed-in app inspected in the in-app browser, preserved owner account/onboarding, no page error after a fresh load; dev server remains listening on localhost:5176 (PID 60813). The empty owner account was not seeded with fixture data. This is availability evidence, not a live provider-build claim. Owner visual/workflow acceptance remains pending.
