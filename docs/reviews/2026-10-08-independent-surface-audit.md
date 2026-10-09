# Caddie surface acceptance audit

Date: 2026-10-08 (Africa/Lagos). Reviewed HEAD: `21538d1d3e50d170b9e447707b59454ee88577c9`.

## Verdict: NO-GO for the agreed end-to-end product

The split shell and floating navigation are a usable visual foundation, but the product is not ready for nontechnical users. Several primary actions do not complete their promised journey. Discovery currently reads a local seed source rather than a live opportunity source; personalised suitability is not implemented as advertised. Plan review lacks readable plan content, Build lacks a preview entry, and idea/import entry paths are incomplete. Performance and spacing problems have shared structural causes.

This is an inventory and remediation audit, not an implementation change. No application source was changed, no provider messages were sent, and nothing was deployed. Existing `.zcode/` was left untouched.

### Evidence boundaries

- **LOCAL VERIFIED:** source and route/service inspection at the above HEAD; typecheck; production build using installed Node 22.21.1; existing local browser suite results below; authenticated read-only browser inspection of Home, Discover, Projects, Onboarding and Settings/Memory entry on the existing localhost:5176 dev server.
- **SIMULATED:** authenticated acceptance tests intercept API responses. These prove rendered fixture states, not working live providers or complete backend journeys.
- **DOCUMENTATION ONLY:** previous agent claims of production navigation improving from 8.5 seconds to 0–420ms. Those numbers were not independently reproduced here.
- **BLOCKED / not established:** hosted release, fresh OAuth roundtrip, paid build execution, real provider discovery, real mobile keyboard/device acceptance, and production p50/p95 navigation timing. Do not treat native automation tool durations as application latency.
- Existing screenshot files were visually inspected as historical evidence, not fresh captures. In particular, the saved mobile overview screenshot visibly clips content; it does not establish whether every current viewport still clips.

Coverage is complete as a source-level surface inventory, with targeted browser verification. It is not a claim that every populated state was exercised against real services.

## Surface inventory

Status: **FAIL** = broken or missing required journey; **PARTIAL** = useful implementation but below acceptance; **CHECK** = no specific functional blocker established, acceptance still incomplete. “Check” does not mean release-approved.

Paths in the tables are relative to `/Users/captjay98/projects/caddie-forge`. All authenticated routes have the deployed `/app` prefix.

| ID | Surface / entry | Status | What falls short | Required correction / acceptance |
|---|---|---|---|---|
| S01 | Astro landing `/` | PARTIAL | Copy says live feed and stack ranking while feed is also marked planned. Technical run/evidence language dominates the intended matching-first proposition. | Align claims to actual capability; lead with finding suitable hackathons; verify CTA → sign-in → discovery. Source: `apps/site/src/pages/index.astro:74`. |
| S02 | Sign-in / session gate | PARTIAL | Provider buttons and failure states exist, but shared session query has incompatible cached shapes; “Landing” router link points to app root. | Repair F02 and basepath link. Fresh Google/GitHub auth return checks remain required; do not infer OAuth success from configuration presence. |
| S03 | Desktop split shell | PARTIAL | Correct left content/right chat appearance; shell recreated per route, inconsistent widths/gutters, technical conversation and account UI. | F01/F03: stable layout route, consistent geometry, scoped draft/scroll preservation. |
| S04 | Mobile shell / composer | FAIL | `pane=channel` can persist into Discover/Projects and conceal destination; four tabs rather than three are present. | Clear pane on destination changes; verify all tap paths. Treat tab count as decision provenance issue, not unilateral redesign; see F15. |
| S05 | Home introduction / primary action | PARTIAL | Still leads with “build assistant”; discovery action is static regardless of urgent project decisions. | Matching-first introduction; next action based on actual user/project state. |
| S06 | Home profile setup | PARTIAL | “Two fields” shows four; raw country/timezone input; Save & browse only saves; no interests in this quick setup. | Friendly controls, accurate labels, real browse handoff; progressive personalisation. |
| S07 | Home recommendations | FAIL | Raw candidate IDs and evidence counts instead of usable event summaries. | Join candidate details, readable title, deadline, fit reasons and opportunity action. |
| S08 | Home Needs you | FAIL | Reads only synthetic Home project; action ignores card target and opens project without ID. | Account-wide scoped aggregation and exact project/action/revision deep links. |
| S09 | Home project progress | PARTIAL | Generic active status rather than useful stage, deadline and next action. | Typed authoritative project summary; distinguish unknown from absent. |
| S10 | Discover feed | FAIL | Local-seed adapter only; empty real account requires “Run feed”; duplicate Hackathons headings; technical sweep copy. | Wire supported live sources, freshness and recovery; simplify presentation. |
| S11 | Personalised suitability | FAIL | Fit measures evidence coverage; country informs eligibility, but interests/skills/hours do not meaningfully rank suitability. | Separate eligibility, personal fit and evidence completeness; implement actual profile matching. |
| S12 | Browse/filter/search opportunities | FAIL | No complete discovery browse/filter/search controls. | Add useful filters and search with scoped data, honest empty/error states. |
| S13 | Saved opportunities | FAIL | Save changes status to accepted, which removes Explore; no dedicated saved view or unsave. | Independent saved state; keep Explore available; Save → reopen → Explore must work. |
| S14 | Opportunity details / sources | PARTIAL | Expandable diagnostics instead of full decision page; source claim IDs not actionable; useful deadline presentation missing. | Readable detail with fit, constraints, deadline, sources and idea action. |
| S15 | Explore ideas → project | FAIL | Immediately creates active project named after event, with no idea choice; errors swallowed. | Resumable exploration, chosen idea, explicit commit, idempotent creation and visible failure recovery. |
| S16 | Projects list | PARTIAL | Names/status/update date exist; promised next action and deadline absent. | Show useful stage/next action; preserve selected project on all links. |
| S17 | Start from idea / onboarding | FAIL | Start routes to `<Start />` without callback; its primary link returns Home. No idea capture. | Actual idea-first form/conversation → persisted project → scoping. |
| S18 | Continue existing code entry | FAIL | Projects link escapes `/app`; onboarding calls feature “coming soon”; repository surface requires an existing project. | Router-aware import entry usable before build project, connected repository selection and committed handoff. |
| S19 | Project Overview | PARTIAL | Hardcoded “deadline: none recorded · progress: see Build”; nested padding; brief only. | Real project summary, next action, work preview and task entry. |
| S20 | Plan / visual design review | FAIL | Revision ID/hash/timestamp with approval, but no readable plan or design. | Show exact content being approved; scope/design/change request; preserve revision binding. |
| S21 | Approval history/status | FAIL | Decisions stored in local state; reload loses visible history/status. | Fetch authoritative persisted decisions; show superseded/revoked/current accurately. |
| S22 | Build / activity | FAIL | RunInspector metadata dominates; no preview opening/rendering action. | Make actual private preview primary, activity secondary; expiry/failure recovery. |
| S23 | Preview / change request | FAIL | No ordinary client preview surface/action found. | Complete build → view app → request change journey, with preview authorization and expiry intact. |
| S24 | Files / artifact revisions / diffs | PARTIAL | Real download/diff endpoints; hash-heavy UI; initial diff selection stale after async load; no normal content viewer. | Initialize valid revisions, readable file content where supported, working download/diff/return flow. |
| S25 | Tasks / complete task list | FAIL | No task destination/list/controls or View all tasks; only search type mentions tasks. | Project task list and overview entry with task actions and correct deep links. |
| S26 | Account Automations | PARTIAL | Lists projects, not configured automations; missing project fetch error branch. | Aggregate actual schedules with project, state, next/last outcome; explicit error/retry. |
| S27 | Project schedules / monitoring | PARTIAL | List/pause/resume/run-now wired; errors swallowed; technical cron/IDs; no creation/configuration surface. | Visible mutation failures/receipts; readable scheduling controls and contextual watch/remind entries. |
| S28 | Evidence / sources / conflicts | PARTIAL | Scoped rich inspector exists; technical hashes/ranks lead. Not every source-linked route is wired. | Keep full traceability in details, readable source-first summary and working claim links; populated/conflicting/stale browser checks. |
| S29 | Judge review | FAIL | Says automated judge, but user supplies scores and API records them. Empty score can become zero. | Actual review invocation/results/fixes; distinguish manual assessment; validate blank score. |
| S30 | Submission checklist/package/export | PARTIAL | Real checklist/export/attestation plumbing; gaps lack resolution actions; raw JSON dominates export experience. | Human-readable package, per-gap fix/evidence action, clear readiness and action-specific errors. |
| S31 | Standalone project delivery | FAIL | Same contest/submission/reuse workflow regardless of standalone context. | Relevant export/share/publish delivery actions without invented contest requirements. |
| S32 | Repository picker / installation | FAIL | Selection only stored in React state; manual installation ID; hide button does not collapse; removed repos selectable. | Real install/callback, persisted selected repo/import, reliable collapse, removed/revoked recovery. |
| S33 | Account menu / section destinations | FAIL | Memory/Connections set `section`, Settings ignores it; hash links target absent IDs. | Render/select/scroll/focus requested section and preserve return navigation. |
| S34 | Profile editor | PARTIAL | Hours cannot be cleared; save does not invalidate related queries; technical selectors/copy. | Explicit null clearing, dependent invalidation, understandable fields. |
| S35 | Connections / integration health | PARTIAL | Deployment configuration presence instead of user's connection management. | User connected/reconnect/disconnect state; technical diagnostics secondary; keep GitHub sign-in separate from repo access. |
| S36 | Stack availability | PARTIAL | Enabled/planned distinction exists; raw stack IDs and proving copy. | Readable labels and honest support evidence; do not relabel planned stacks supported for presentation. |
| S37 | Personal memory | PARTIAL | Confirm/correct/retract endpoints exist; provenance not adequately surfaced. | Show source and history; populated mutation/error acceptance. |
| S38 | Project memory | FAIL | `projectId` state never set; only personal records listed. | Personal/project scope control, project memory inspection/correction and provenance. |
| S39 | Search | FAIL | Results noninteractive; fixed first ten without paging; duplicated embedded settings surface. | Typed result destinations, pagination, explicit scope, useful empty/error states. |
| S40 | Usage / budget / payer | FAIL | Explicit “not exposed” placeholder; no useful spending or limit visibility. | Read-only authorised usage summary, limits/payer and actionable budget state before paid journeys. |
| S41 | Conversation / activity details | PARTIAL | Scope-labelled transcript and send states exist; route remount defeats persistence; unsent input local-only; technical copy. | Stable scoped conversation, draft/scroll retention, long-history performance and honest action handoffs. |
| S42 | Not found / missing project / recovery | PARTIAL | Explicit states exist, but not-found includes SPA implementation explanation and relative links; old/internal anchors bypass router. | Useful recovery, no silent project fallback, correct `/app` URLs and context. |
| S43 | Theme/accessibility/responsive states | PARTIAL | Themes and existing basic checks present; uneven gutters, tablet split pressure, mobile interaction gaps. | Page-by-page light/dark, keyboard/focus, real keyboard, long content and populated narrow viewport acceptance. |

## Prioritised findings and exact repairs

### F01 — P1: route changes recreate the supposedly persistent conversation

`apps/app/src/client/routes.tsx:40` renders only an Outlet at the root. Sibling page components each own WorkspaceChrome. `workspace/Chrome.tsx:232` owns the channel and transport; `coordinator.ts:48` owns run state and the Flue hook. Changing sibling route unmounts that subtree. Transcript memoization in `conversation/Channel.tsx:369` cannot retain values across unmounts. `conversation/Composer.tsx:20` keeps unsent textarea contents in local `useState('')` only; submitted/failed draft persistence is not preservation of unsubmitted typing.

```tsx
// Current root shape, while each page creates its own shell:
component: () => <Outlet />
// Current composer:
const [value, setValue] = useState('');
```

Repair: put the persistent shell/conversation above the changing page Outlet in a stable layout route. Derive page context from validated route metadata. Keep unsent drafts keyed by actor/conversation, not one shared string. Preserve scroll and transport for same-context navigation. Do not cache authorisation indefinitely to hide delays.

Acceptance: type without sending; navigate Home → Discover → Projects → Home; preserve draft and transcript position; count mounts/connections; confirm no history reload for unchanged context. Repeat with a long real transcript and cold/warm queries. Measure route intent → visible content and input responsiveness independently from network data completion. Proposed target: warm navigation visible in <200ms at p95 on the agreed test machine with no multi-second main-thread freeze; explicitly document test conditions before adopting a release threshold.

Current quantitative limitation: the previous 8.5s → 0–420ms claim is historical. Native UI tool calls include accessibility/screenshot overhead and cannot establish p95 application latency. The lifecycle issue is source-confirmed, but its exact share of current delay requires profiling.

### F02 — P1: one auth cache key stores two incompatible types

`queries.ts:51–88` uses `['auth','session']` once for an actor string and once for SessionPayload. Which observer fetches can change the cached shape; the display name can disappear and actor-scoped consumers can receive the wrong type.

```tsx
// Current competing functions under the same key:
queryFn: async () => (await fetchJson<SessionPayload>('/api/auth/get-session')).user?.id
queryFn: () => fetchJson<SessionPayload>('/api/auth/get-session')
```

Repair: one canonical raw-session query, with actor and display-name `select` functions. Verify both mount orders, refetch, sign-out and account switch. No permission bypass or cross-account disclosure was demonstrated; this is a correctness defect in an identity-sensitive boundary.

### F03 — P2, required for UX sign-off: inconsistent spacing is structural

`workspace.css:2305` adds 1rem outer sides. `.shell-loading` adds 1.5rem (`:1561`), `.settings-stack` adds 1.2rem (`:1498`). Ordinary `.shell-page` resets wrapper padding to zero (`:1572`). Root panel widths vary independently.

| Surface | Effective wrapper rule before card interior |
|---|---|
| Home and standard page-col | 1rem shell sides, max860 content |
| Settings | 1rem + 1.5rem + 1.2rem sides, max760 inner stack |
| Overview, Build, Repositories | standard page-col plus 1.2rem settings-stack inset |
| Discover, Judge, Submission | header max860; body max760, independently centred |
| Plan | inner max820 |
| Evidence, Files | inner max860 |
| Onboarding | extra 1.5rem horizontal / 2.5rem top |

Repair: one PageFrame owns outer width/gutters; a neutral Stack owns gaps only; cards own interior padding. Narrow long-form text intentionally inside the common frame. Remove conflicting legacy shell rules after use-site audit, rather than appending another override block.

```css
/* Proposed ownership, not an applied patch. */
.page-frame { width: 100%; max-width: var(--page-width); margin-inline: auto; }
.page-stack { display: grid; gap: var(--section-gap); }
.panel { padding: var(--panel-padding); }
/* The shell alone owns the outer page gutter. */
```

Acceptance: record title/body left and right bounds, first content top, section gaps and card padding on all routes at 390/768/1280/1440. Compare corresponding elements, not merely absence of overflow. At 768px current chat reserves at least340px (`workspace.css:2291`), leaving428px for the desktop content/capsule; choose breakpoint from usable minimum panel widths and share it between JS/CSS.

### F04 — P1: mobile navigation can retain a hidden destination

`Chrome.tsx:212–216` interprets pane=channel as full-height chat. Discover/Projects links (`:751/:761`) retain search via keepSearch (`:487`). Main content is hidden at `:408`. Clicking Discover from an explicit chat pane can therefore change route while leaving chat visible. Clear the pane for global destination links; preserve only relevant context. Add Chat → Discover → Projects tap-through tests. This is independent of whether the final approved nav has three or four tabs.

### F05 — P1: idea/import entry is incomplete; internal links force reloads

`routes.tsx:169–173` renders `<Start />` without its action callback; `onboarding/Start.tsx:94–112` falls back to `href='./'`. Browser inspection confirms “Describe what you want to build” has only “Open the workspace”, no idea field. `surface.tsx:220` uses `/onboarding`, outside deployed `/app`; `Shell.tsx:127` does the same with `/settings`. Other internal anchors in RunInspector/DecisionCard/Start reload the document.

Repair: actual idea capture/scoping handoff and typed router Links, including import. Test composed `/app` deployment, not just root dev mode; ensure return/auth callback context survives. Keep external URLs as ordinary anchors.

### F06 — P1: discovery is not the promised personalised live finder

`server/routes/discovery.ts:114–124` runs `adapters: [createLocalSeedAdapter(c.env.DB)]`. `actorEligibilityProfile` (`:103–111`) supplies country only; `server/discovery.ts:553–595` computes evidence coverage rather than skills/interests/time suitability.

Repair: real supported source adapters, fresh event retrieval and explicit failure/provenance; suitability based on profile plus opportunity constraints. Keep eligibility, match reasons and evidence completeness distinct. No invented numeric scores. Test a real event with source receipt, open/closed status, timezone-correct deadline and two profiles with explainably different matches.

### F07 — P1: Save prevents progression; Explore bypasses idea choice

`discovery/Results.tsx:279–306` renders Explore only for status=new; server accept changes to accepted (`server/discovery.ts:535`). `surface.tsx:143–164` creates a project immediately and hides errors by only clearing busy. Repair separate bookmark state, stable saved list, exploration before explicit project commit, visible errors and idempotency. Test save/reload/explore, rejected request, uncertain retry and existing linked project.

### F08 — P1: Home decision targets are discarded

`Shell.tsx:275–295` reads the Home-project brief rather than all projects and routes every card without its target:

```tsx
function onCardAction(card: DecisionCardType) {
  void card;
  chrome.goProjectTab('/project', {});
}
```

Repair scoped account aggregation with project/revision/action identity; preserve exact target. Test two projects with different pending approvals; each Home action opens the correct one. Do not expose “backend roll-up not exposed” implementation copy as a substitute for completion.

### F09 — P1: approval without readable plan, and lost visible decision history

`planning/DesignReview.tsx:183–230` renders revision metadata/hash and Approve/Reject. Its input lacks plan body/design (`:36–40`). Decision history is local-only (`:62,79–84,122–149`). Repair read/render exact immutable plan content and designs, fetch authoritative approval status, support contextual changes. Reload must retain decision and identify superseded revisions. Never loosen server approval binding.

### F10 — P1: build result and repository import have no complete UI journey

`surface.tsx:425–460` only mounts RunInspector; no working preview entry in client. `surface.tsx:572,596–605` only calls `setPicked` on repository selection. Repair preview display/open with private expiry and real generated app; persist selected repo and import analysis with permission validation. Test refresh and interrupted import. Keep activity and hashes in details.

### F11 — P1/P2: account surfaces are not actionable enough

- Search (`search/Search.tsx:55–57,130–139`): inert div results, fixed offset0. Add destinations/pagination and scope.
- Settings: `section` ignored; hash anchors target testids rather than DOM ids (`Settings.tsx:103–119`). Browser confirms choosing Memory lands at the profile-first settings page. Add actual selected section/anchor focus.
- Profile (`Settings.tsx:170`, `server/profiles.ts:216`): clearing hours omits field, preserving previous value. Send explicit null; invalidate dependent queries.
- Memory (`memory/Memory.tsx:43–49`): projectId remains empty. Add scoped project inspection/provenance, preserve correction/retraction semantics.
- Usage (`surface.tsx:700–734`): placeholder only. Implement read model for payer/spend/reservation/limit and errors before paid acceptance.

### F12 — P1/P2: tasks/automation/submission are incomplete workflows

- No complete task surface or View all tasks entry found. Add scoped project task list/actions.
- Account Automations (`surface.tsx:673–697`) lists projects, not schedules; add actual aggregate state and fetch errors.
- Schedules (`tasks/Schedules.tsx:80–82`) swallows mutation failures; surface errors/receipts and creation/configuration controls.
- Judge (`judge/Scorecard.tsx:126–145,173,255–275`; `server/routes/judge.ts:99–112`) asks user for scores while claiming automated review. Add actual scoring workflow or clearly label current manual tool while retaining automated review as unfinished. Blank score must not silently become zero.
- Submission provides plumbing but not useful gap-resolution actions/human-readable package. Add per-gap fixes, evidence attachment and appropriate export; distinguish preparation from actual external submission.
- Standalone projects always get contest-oriented SubmissionPackage (`surface.tsx:510–517`). Provide appropriate independent delivery view.

### F13 — P2: presentation still exposes implementation details

Browser-visible Home explains missing account roll-up, Discover repeats “Hackathons” and asks to “Run feed”, Settings explains deployment variables and stack identifiers. These are developer-oriented states. Move diagnostics into details, use plain outcomes/actions, and avoid presenting an empty inspector as a finished product surface. Evidence/hashes should remain inspectable, not removed.

### F14 — P2: test assertions and documentation drift

Fresh selected browser suite: 56 passed, 2 failed. Both failures are stale conversation-label expectations (expected “General · Caddie” / “Caddie ·”, actual “General”). Do not revert intended UI merely to satisfy stale labels. Correct tests against approved semantics and add missing journey assertions. The discovery journey currently fails at its initial label check, so downstream acceptance did not run in this execution.

More importantly, tests accepting immediate Explore→project creation cannot prove the approved idea-choice workflow. Existing green tests do not establish real discovery, preview, import, automated judge or all supporting surfaces.

### F15 — decision provenance: mobile four-tab amendment

Current code and takeover docs state a later owner amendment to Chat · Brief · Discover · Projects with Chat as mobile Home. The conversation supplied to this review last explicitly agreed three global destinations. This audit does not treat an agent-written owner attribution as independent confirmation, nor assume the user did not change it elsewhere. Reconcile the canonical decision with the owner/session evidence before changing tab count. The functional pane-leak and persistence defects need fixing under either layout.

## Verification receipts

1. `bun run typecheck` — PASS, exit0.
2. Default `bun run build` — FAILED because shell selected Node22.15.0; Flue requires >=22.18 or >=23.6. This is a local runtime selection issue, not an application compile defect.
3. `PATH=/Users/captjay98/.nvm/versions/node/v22.21.1/bin:$PATH bun run build` — PASS, exit0, composition collisions0. Log: `/tmp/caddie-review-build.log`.
4. `PATH=/Users/captjay98/.nvm/versions/node/v22.21.1/bin:$PATH bunx playwright test tests/browser/workspace.spec.ts tests/browser/discovery.spec.ts tests/browser/discovery-journey.spec.ts tests/browser/settings.spec.ts tests/browser/artifacts.spec.ts tests/browser/submission.spec.ts tests/browser/conversation.spec.ts tests/browser/landing.spec.ts --workers=1` — FAILED overall, 56 passed / 2 failed in27.7s. Log: `/tmp/caddie-review-browser.log`.
5. Fresh native-browser inspection of authenticated localhost:5176: verified Home technical/empty copy, duplicated Discover headers, sparse Projects, incomplete onboarding, wrong `/onboarding` link, account menu entries and Memory section not selected. Read-only; no new model messages.
6. Separate source reviews covered discovery/onboarding, supporting surfaces and shell/performance. Their conclusions were reconciled against concrete source snippets and browser observations, not treated as runtime measurements.

No release/hosted acceptance claim is made. No fresh real-device keyboard check or production navigation benchmark was completed.

## Repair order and sign-off gates

1. **Shared correctness and navigation:** F02 auth cache; F01 stable layout/drafts; F04 mobile pane reset; F05 router links. One integration owner for shared shell/routes/contracts. Gate: same-context navigation preserves draft/history/scroll, wrong-ID never opens another project, account-switch tests pass.
2. **Shared geometry:** F03 common page frame and spacing ownership across every listed surface. Gate: measured alignment matrix + current screenshots at target widths and themes; no narrow populated content clipping.
3. **Primary discovery journey:** real source and suitability, Saved, details, idea choice, project creation and Home targets. Gate: real-source receipt plus profile-dependent matches; save→reopen→choose idea→project; useful error recovery.
4. **Project work:** readable plan/design and durable approval state, usable preview, import and meaningful status. Gate: user can inspect exactly what is approved and interact with actual generated result; no metadata-only acceptance.
5. **Supporting workflows:** tasks, project memory, search destinations, schedules, account section routing, usage and automated review/submission fixes. Gate: every inventory row has working entry, action, recovery and stable fallback.
6. **Independent final acceptance:** rerun repaired tests; measure cold/warm long-history navigation with documented hardware/runtime; fresh mobile/desktop light/dark review; real nontechnical walkthrough. Agent heuristic review is not human usability evidence.

Do not mark the entire product good to go while any P1 primary journey or required inventory surface remains incomplete. Preserve Flue ownership, server authorisation, approvals, budget enforcement, evidence traceability and all agreed output-stack scope throughout repairs.
