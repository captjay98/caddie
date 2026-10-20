# Caddie UI foundation implementation plan

> Execute inline with the existing shared workspace; preserve unrelated WIP.

**Goal:** make the approved compact card direction reliable across Brief/chat before designing the remaining screens.

**Architecture:** shared actor/project workflow cache and shared card navigation; historical transcript entries are passive until opened. Derive completed approval cards from durable records and open exact read-only approval/revision history. Preserve full-screen mobile chat, persistent desktop chat and Plan → Build → Check → Submit/Share.

**Stack:** React, TanStack Query/Router, existing D1 approval records and typed DecisionCard contract. No new dependencies, schema changes, provider calls or deployments.

## Packet 1 — behavior and approved card foundations

1. Add a SQLite-backed approval lifecycle regression in `tests/brief.test.ts`: pending → approved/rejected/expired remains the same card identity, handled after resolution; foreign actors remain excluded. Run failing regression before changing `apps/app/src/server/brief.ts`.
2. Use the same `briefActionRoute` from generic chat cards and Brief. Historical accepted proposals render passive links rather than mounting `ProjectWorkflow` and live coordinator transports. Verify in `tests/browser/project-proposal.spec.ts` with a real workflow conversation present and a counted transport boundary.
3. Add `apps/app/src/client/workflow-query.ts` to share the full workflow query key/options between workflow cards, phase/brief hooks and project cards. Active work refreshes frequently; settled work refreshes less frequently. Keep actor/project cache isolation and mutation invalidation. Verify one-query deduplication and idle/active policy in targeted tests.
4. Retain recently resolved approvals in the Brief projection, render actionable Earlier cards and preserve all open cards instead of silently slicing the first three. Add exact read-only approval history to the Plan route, matching resource ID and revision hash, with explicit unavailable-content states.
5. Apply compact 13px card shells, clear context/status, consistent primary/secondary actions and subdued Earlier styling to the shared DecisionCard family. Do not invent plan features, countdowns, verification results or progress from summary prose. Rich workflow/opportunity-specific designs follow their real data.
6. Run relevant Bun suites, typecheck, composed build and fixture-backed browser regressions. Inspect desktop/mobile rendered output and record measurements, failures and fixes in `docs/evidence/2026-10-20-ui-foundation.md`. Keep simulated API/model boundaries distinct from real local proof.

## Subsequent review packets

- Mobile shell/chat variants: preserve draft/context/scroll through resizing, keyboard and panel changes; profile active streaming/navigation before claiming a latency fix.
- Discover cards and hackathon detail: show options and obtain approval before changing their layouts.
- Projects cards and project workspace: keep the four steps; propose a focused current-step workspace and concise overview.
- Preview/repair/delivery and notifications: full-window preview access, exact destinations, durable outcomes and clear read-versus-resolved semantics.

Earlier approval covers seven card designs; these later surface designs still require collaborative review. Packet completion does not claim the whole-app redesign or active-build performance audit is complete.
