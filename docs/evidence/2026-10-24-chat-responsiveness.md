# Conversation, responsiveness and design quality — execution evidence

Updated 2026-10-24. **IN PROGRESS.** Owner approved implementation. No deployment or paid model comparison belongs to this pass. Local fixture boundaries remain SIMULATED; successful UI assertions are LOCAL VERIFIED, not provider/authenticated/live acceptance.

## Implemented

- Bounded, stable-ID transcript pages, lazy diagnostic contents, deferred streaming Markdown, bounded project-local idle Markdown preparation, editable queued follow-ups, reduced-motion-aware new-message feedback.
- Task-based Home/project ideation and explicit execution routing; separate helper roles retain Nano pending representative evaluations.
- Aggregated look/theme validation, canonical valid examples, bounded persisted repair attempts, independent optional screen composition per look, phone/desktop/fullscreen inspection and selected-screen handoff to build.
- Revision-bound plan state across chat/project/Plan; shared resources through Info; route-specific query ownership; slower refresh for inactive workflow phases.
- Shared spacing/control polish, project Settings grouped phone list/detail/back navigation, initial hash and history support, retained drafts.
- Brief hides read controls once read; Earlier uses the shared card family and recorded outcomes. Read state never resolves a decision.
- Original decision opens compactly, retains exact resource/hash identity, and exposes original text on demand. No approval action is available in history.
- Paired Projects phone actions fill their row. Existing shared paired-action rules remain in place.
- Development retires only Caddie's matching same-origin production-preview service worker, avoiding an obsolete offline shell after switching serving modes. No forced reload or draft loss.

Examples of the behavioral changes:

```tsx
// Current read status is useful only while there are unread updates.
{brief.data && unseenCount > 0 ? <div className="brief-feed-toolbar">…</div> : null}
```

```tsx
// The exact original revision stays available without displaying its full specification first.
<details className="decision-record-original">
  <summary>Read the original plan</summary>
  <div data-testid="decision-original-content"><Markdown text={original.body} /></div>
</details>
```

```ts
// Current Plan follows saved workflow; copied GitHub previews retain their own card.
const reviewingPlan = phase === 'review' && !workflow.data?.importPreview;
```

## Verification receipts

- `/tmp/caddie-punch-browser.log`: **67 passed** project/settings/focused workspace checks on the rebuilt preview. Includes grouped Project Settings at 320/390/412, hash/history navigation and unsaved repository form retention.
- `/tmp/caddie-brief-polish-all-browser.log`: **45 passed** Brief checks. Includes exact original revision, collapsed original text, 320px long-content overflow, recorded outcome links and read-state independence.
- `/tmp/caddie-punch-unit.log`: **44 passed**, provider selection and PWA/service-worker invariants.
- Submission documentation and plan-decision focused suite: **56 passed**; helper role table now matches the registry.
- `/tmp/caddie-punch-types.log`: root and app typecheck passed.
- `/tmp/caddie-punch-build-final.log`: composed build passed, assets stamp `c0782c09457b`. Subsequent source edits require a new build before claiming final coverage.
- `/tmp/caddie-punch-all-tests.log`: **2,616 passed, zero failed**, 209 files, 11,835 assertions. This completed before the final progressive-response component/test additions; those require their focused recheck.

Previous fixture performance evidence: 400 messages plus 1,600 closed tool rows became a 40-row page with no closed tool children mounted. One-sample earlier-history timings fell from 186–193ms to 40–89ms. These are scenario-specific lab samples, not p95 or whole-app claims. A later repeated driver-wall-time sample measured typing p95 95.7ms and history round trip p95 200.1ms. Driver wall time is not browser event-to-frame input latency; an event-to-frame measurement is being added. Actual transport still receives the coherent full Flue snapshot; this pass does not claim network history pagination.

Additional focused checks after the final progressive-response build:

- `/tmp/caddie-mobile-pairs-final.log`: **3 passed**, equal-width side-by-side Projects actions at 320, 390 and 412px, full row coverage and minimum 44px targets.
- `/tmp/caddie-chat-expanded-browser.log`: **9 passed** including giant single assistant turn, huge Markdown, reconnect, resize, project change, draft retention and normal/reduced motion without restored-history arrival replay.
- Twelve local input-event-to-next-frame samples: p95 **14.9ms**. Driver typing wall time p95 **11.2ms**; two history transitions round trip p95 **174.5ms**. Transcript 242–246 nodes; supported observer recorded zero interaction long tasks in this run. These are lab observations with SIMULATED transport, not actual account/browser proof.
- Huge completed reply: 9,517 characters/437 nodes initially; eleven explicit reveals reached the final Observation1199 and exact end marker, retaining the opening text. Closed tool rows stayed unmounted. One initial full run had an intermittent progressive-loop timeout; isolated and full reruns passed, and the test retains raw-tail/button diagnostics on failure. Continue monitoring rather than treating rerun success as proof of absence of flakiness.
- `/tmp/caddie-punch-final-types.log`: root and app typecheck passed after these changes.

## Actual local runtime / freezes

On resuming this pass, elevated listener inspection and HTTP requests established there was **no server on :5176**. The user browser showed a connection error. Restarted the repository dev server on its pinned port; `GET http://localhost:5176/app/` then returned 200. Startup also recorded dependency-optimizer reloads and a missing temporary optimized module before recovering. Neither this startup observation nor fixture speed establishes the cause of the earlier freezes.

Actual authenticated conversation profiling remains **BLOCKED pending accessible browser state**: the browser tool refused the existing error-page tab under its URL policy. Requested user refresh; no alternate browser or policy workaround used. Continue unrelated local verification meanwhile.

## Surface acceptance matrix

Source inspection and fixture tests are distinct from rendered visual acceptance. Rows stay open until all relevant populated/empty/loading/failed/narrow states are proven.

| Surface | Source/current changes | Available browser evidence | Remaining |
|---|---|---|---|
| Chat / composer / history | Changed | Long-history, draft, follow-up fixture checks | Real conversation trace and streaming trace; giant turn/reconnect/p95 fixtures passed |
| Brief / Earlier | Changed | 45 passing current checks | Fresh full visual review across themes |
| Projects | Changed shared controls/status | Current project suite passed | 320/390/412 equal-width pair checks passed; rendered visual review remains |
| Project Plan / decision history | Changed | Exact revision, 320px overflow and no approval in history | Visual review of real populated plan |
| Build | Shared polish/resources | Current focused/workspace tests | Real active/stalled/repair state review |
| Check | Shared polish/resources | Prior broad fixture run | Refresh current empty/error/readiness states |
| Submit | Shared controls | Prior broad fixture run | Refresh narrow/error/required disclosure states |
| Looks / design review | Changed | Picker and preview fixture checks | Final visual review; interactive uncertainty prototype |
| Built preview | Selected screen handoff | Existing interactive preview fixtures | Built vs approved phone/desktop screenshots |
| Discover / event details | Shared polish | Prior broad fixture run | Current filters/details/local deadline visual states |
| Account Settings / dropdown | Shared controls | Prior broad Settings fixtures | Current all-section mobile/keyboard review |
| Project Settings | Changed | 320/390/412/hash/history/draft checks | Current screenshots/desktop review |
| Onboarding | Shared controls | Prior broad fixtures | Fresh visual review including error/retry |
| Repository import | Preserved imported review fix | Owner reports fresh targeted pass | Repeat integration regression after final build |
| Memory | Shared controls | Source reviewed | Dedicated narrow/empty/error acceptance |
| Tasks / routines | Info access preserved | Current resource/deep-link checks | Real schedule state and error/narrow review |
| Notifications / search | Navigation ownership changed | Prior broad fixtures | Current keyboard/deep-link/read-state checks |
| Publish / versions / AI / keys | Shared controls | Source reviewed | Secondary surface browser matrix |
| Artifacts / files / run inspector | Lazy secondary detail | Source reviewed | Large/error/mobile cases |
| Shared dialogs / recovery | Shared controls | Existing fixture coverage | Focus return/200%zoom/landscape audit |

## Unfinished full-plan gates

1. Profile real :5176 conversation and compare local production preview; gather repeated input/navigation measurements, request costs and long tasks. Validate giant turn, streaming, reconnect, resize, project switch, reduced motion and keyboard.
2. Record actual per-call model selection/reason and preserve accurate cost/budget accounting; run-level binding alone is insufficient when models change.
3. Conditional bounded interactive design prototype remains to implement. Static iframes stay script-free. Native sample interactions are not proof of backend saving/offline behavior.
4. Compare built application against approved design at phone and desktop sizes and provide a bounded repair/acceptance path; reference handoff alone does not prove fidelity.
5. Complete the surface matrix, final integrated checks and independent review. Do not mark the plan achieved from the punch list alone.
6. Representative Lightning/Nano comparison remains separately paid-call-gated. Local fixture preparation may proceed; no paid quality/latency conclusion is claimed.

## 2026-10-25 follow-up: real history replay and minimal review surfaces

LOCAL VERIFIED: the real Everything conversation replayed because the patched SDK removed `offset` from the update stream options. History loaded at checkpoint `…0185`, but updates restarted at `-1`; transcript replacement and React update-depth errors repeated. The SDK patch now passes the checkpoint to both stream options and URL parameters. The app's installed SDK regression test exercises the actual patched module. Vite explicitly prebundles SDK and React together to invalidate the old development bundle. The owner subsequently confirmed the flicker stopped. Source edits can still produce a development HMR context error; a clean reload clears that distinct development condition.

Native history now starts with a 40-record request and reads older cursor pages on upward intent. Rendered readable rows remain bounded; internal records are filtered before windowing. The browser regression proves one page per gesture, anchored history, jump-to-latest and no update-depth errors in that scenario. This is not a whole-app latency claim.

Plan has an internal Plan/Design switch; the saved design stays accessible after building begins. Design previews lead, the readable brief opens in a modal, machine theme JSON is omitted from that readable view, and more than six screen previews are reachable (bounded to 32). An explicitly part-numbered design is refused before approval/admission/writes for every workflow mode. The real Farmhand brief was saved across three separate revisions: this change does not silently merge or approve those revisions. It still requires a consolidated design. The explicit marker guard does not prove semantic coverage.

Build no longer repeats the overview Building strip. Its default feature view shows the current position and checked count; the exact checklist is on demand. Duplicate numeric prefixes are removed from displayed feature titles; saved titles and approval records are unchanged. Chat activity uses folded work summaries and named tools rather than generic Worked rows. Full raw/private reasoning is not exposed.

Current checks: 103 focused unit tests passed; root/app typecheck passed; composed build passed. The final browser run covers the Plan/Design switch, read-only saved design after approval, incomplete-design refusal on phone/desktop, compact Build checklist, native paging, reconnect, giant turns, and restored-history animation. API/model fixtures are SIMULATED, not deployed or paid-model verification.

Progress since the earlier unfinished-gates list: per-call model usage instrumentation, a bounded optional native prototype, and a visual-fidelity host seam/local comparator now exist with local tests. They do not establish deployed accounting, production capture-adapter operation, semantic visual acceptance, or paid model quality. Full surface acceptance and release checks remain open.

Final follow-up browser run: **39 passed** (10.4s), after build stamp `05c3c9faa466`. Focused units: **103 passed**, zero failures. Root/app typecheck and composition passed. A previous composition attempt found an existing composed subtree; the next pristine root build succeeded. No deployment or commit was performed by this pass.

Remaining actual local runtime issue: after development source reloads, the project conversation again returned PartyServer `.name` / missing `__ps_name` errors in `/tmp/caddie-checkpoint-dev.log` while the Build read model remained visible. This is distinct from the fixed Everything replay loop. No state wipe, forced build stop, or restart of the owner's active build was performed. Local runtime identity/recovery remains unresolved and must not be described as production-ready.

## Owner review corrections, 2026-10-25

The prior UI pass was functionally checked but visually insufficient: disconnected Build sections, unpadded modal bodies, oversized secondary navigation and mobile preview-control overflow. The corrected pass adds a shared padded dialog body; a quiet Plan/Design navigation row; contained preview controls with a mobile screen selector; readable inferred names for previously untitled screens; optional saved specifications; read-only access to saved parts and earlier look options; and one integrated Caddie Build surface with checked-feature progress and structured activity views. Build records are explicitly history rather than another claim of completed work. Original generated HTML, approval identities and the running build were not rewritten or resumed.

LOCAL VERIFIED: 47 focused browser checks passed after the final client rebuild, including 320/390/412/768/1440 widths, design details, earlier-look comparison, feature checklist, failed-design status, native history paging, and unavailable-history recovery. The earlier broader run passed all project-workflow cases; its remaining failed-design-heading assertion was updated to target the intentionally deduplicated status label, then passed in the focused rerun. Root/app typecheck and composed build passed. Browser APIs/model boundaries are SIMULATED. Captured local fixture screenshots: `/tmp/caddie-build-refined-mobile.png`, `/tmp/caddie-build-refined-desktop.png`.

Latest actual authenticated browser inspection showed Farmhand history present again, 2/8 checked, and a paused build after unsuccessful checks. That supersedes the earlier 0/8/loading snapshot. The history view now offers read-only reload on error or a ten-second delay; a connecting transport does not claim active work. This observation is not a durable fix claim for every underlying runtime interruption.

The subsequent build reliability review is recorded in `docs/plans/2026-10-25-build-reliability.md` and its upstream source inventory. A regression first failed because the first new-test failure after explicit resume immediately paused the build. The host now enforces the resume-aware window consistently; 95 build-workflow tests passed while preserving six historical failures and the earlier checkpoint in that regression. No paid build, deployment or automatic resumption of Farmhand was initiated by this work.
