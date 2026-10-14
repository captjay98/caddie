# Chat-to-build remediation — 2026-10-11

Status: implementation and local verification completed; paid end-to-end acceptance is authorized but remains BLOCKED pending normal browser sign-in. This is not a declaration that a real generated todo app has passed live acceptance.

## User-visible changes

Home chat can create a project with the full original request, render its plan as Markdown inside the conversation, collect authenticated approval or concrete changes, and admit the continuation to that project's existing coordinator. No manual navigation or repeating the brief is required for this path. Approval is for the exact latest PRD; revisions require fresh review. Projects use evidence-backed status and explicit next actions, preserving the established desktop split and mobile navigation.

Build progress and blockers remain visible in chat. A failed admission preserves its durable dispatch key for retry. Existing projects reuse their run and conversation. Explicit retry retains files and failure history while starting a fresh bounded repair window. An interactive generated HTML preview runs inside an opaque sandbox with actor/project-scoped browser storage and explicit download.

## Software corrections

- Coordinator authority is resolved inside its own Durable Object from environment and immutable conversation/run ownership, including recovery callbacks. Serializable snapshots hold presentation data only. Profile, confirmed current memory and plan feedback come from scoped persisted services.
- Intake writes project/run/workflow atomically and rejects key reuse with a changed brief. Durable delivery keys and Flue idempotency prevent duplicate admission on reload or repeated clicks.
- New plan revisions clear old readiness. Host effects re-check current approval, actor and membership. Atomic publication refuses revoked or changed approvals and plans, including races immediately before the write.
- Sandbox session/image chains and machine receipts persist through D1 with atomic claims and compare-and-swap. Ambiguous remote outcomes block continuation instead of resetting or blindly repeating work.
- QA cannot mutate files or run arbitrary inherited shell tools. Host verification executes dependency installation, actual behavioral tests and browser bundling. Caller pass flags and model acceptance claims cannot publish readiness.
- Model tools record repair proposals honestly; specialist execution remains an actual delegation. Build verification requires at least one passing behavior test, successful command receipts, and the same committed image when reading output.
- Live Flue smoke verification now performs a real authenticated SDK round-trip when explicitly authorized. A lone environment authorization flag can no longer count as a successful provider test. Restart/full-build acceptance require separate evidence.

## Verification

LOCAL VERIFIED: root and application TypeScript checks; production Astro/Vite build and composition; 129 local tests across workflow, coordinator context, sandbox durability/contracts, agent permissions, project summaries and authenticated controls.

LOCAL VERIFIED browser execution with SIMULATED API/model/artifact boundaries: 29 Playwright tests covering in-chat plan and approval delivery, feedback/revision/reload, admission retry, mobile workflow, interactive preview isolation and storage, Projects, Plan, Build and artifacts. These tests use real React, Flue SDK HTTP admission and Chromium but do not prove a real model generated the fixture app or that Contree executed it.

SQLite/D1 service tests prove fresh context resolution and saved binding ownership across new host objects. They do not yet prove a real provider submission survives a killed Durable Object. Sandbox tests use simulated Contree HTTP responses and real local persistence.

Applied migration 0018 to the local development database without deleting data. Repaired a Wrangler/workerd internal alarm metadata version mismatch after backing up metadata to /tmp/caddie-d1-runtime-metadata-20261011.sqlite. Browser verification uses isolated local storage via CADDIE_TEST_STATE, separate from the review database.

The shell defaults to Node 22.15; installed Node 26.3 successfully builds Flue. Build commands used the explicit /opt/homebrew/bin/node with installed package CLI entry points. The local review app runs on http://localhost:5176/app/.

## Remaining acceptance and limits

1. Authorize and execute a real minimal todo request through Home chat: plan, feedback if needed, approve, specialist implementation, successful host checks, real preview add/complete/delete/filter/reload. Then verify admission replay and runtime reconnect/recovery against actual provider/sandbox results. No paid calls were initiated for local verification.
2. Discovery currently queries the stored catalog and source-backed rules. It honestly reports gaps and unknown eligibility; fresh live web ingestion is not implemented by this patch.
3. Preview packaging currently supports the proving React/Bun/Hono recipe's inline frontend bundle and CSS. A live Hono API, external assets, the other planned stacks, deployment and submission are not proven by this path.
4. A ready preview means host build checks passed. It does not prove every product requirement, accessibility claim, performance target or browser behavior. The todo acceptance case remains necessary.
5. Budget preferences are context, not spending authorization. Comprehensive model/sandbox billing caps are not established by these changes. Plan approval does not authorize deployment, purchases, merges or destructive database changes.
6. Durable queued continuation starts when the relevant workflow card is mounted. Closing the browser before admission leaves it queued for a later visit; an admitted Flue submission runs independently.

## Core gate

```ts
const { workflow, plan } = await requireBuildApproval(db, scope);
// Publish only while this exact plan, approval and membership remain current.
await storeBuildOutput(db, scope, {
  html,
  image: verifiedImage,
  planId: plan.id,
  runId: workflow.runId,
});
```

No changes were committed; existing user work was preserved.


## Authorized live acceptance preflight

The owner explicitly authorized one full todo-app acceptance build using configured Nebius and Contree accounts. Live read-only provider preflight succeeded: Nebius authentication, availability of nvidia/nemotron-3-super-120b-a12b, Contree authentication and base-image resolution, and Bun at /root/.bun/bin/bun. No model completion or sandbox command was executed in this preflight.

The in-app acceptance browser has no authenticated Caddie session. Its normal GitHub OAuth sign-in is open for owner handoff. Automatic approval review rejected a proposed API authentication method that would have extracted local session material and signed a cookie; that command did not execute, and the method was abandoned. Normal browser sign-in is the remaining prerequisite. Full todo plan/build/behavior acceptance is still unverified.
