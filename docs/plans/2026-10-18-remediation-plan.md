# Caddie Forge — Remediation Plan (waves R01–R07)

**Authored:** 2026-10-18, from an independent review of the codebase, plan docs,
and evidence discipline.
**Baseline:** commit `4f4e1c65` (docs(publish): app logins and Start from my
GitHub repo), clean working tree.
**Purpose:** address every issue the review found, in dependency order, under
the repository's existing execution discipline.

This plan is subordinate to `docs/plans/2026-10-03-fresh-build/README.md`
(authority) and `AGENTS.md` (rules). Where they conflict, they win.

---

## Ground rules (inherited — do not re-litigate)

- TDD slice procedure per `docs/plans/2026-10-03-fresh-build/packets.md`:
  one failing behavior test → run and inspect the failure → smallest
  contract-preserving increment → focused test + typecheck + inspect diff →
  receipt + commit of owned files only.
- Evidence classifications exact: LOCAL VERIFIED / LIVE VERIFIED / SIMULATED /
  DOCUMENTATION ONLY / BLOCKED / FAILED. Refactors are LOCAL VERIFIED with
  before/after behavior equivalence. A mocked pass is never LIVE VERIFIED.
- Integration-lead-owned files (route registration, `package.json`/`bun.lock`,
  shared contracts, `scripts/verify-packet.ts`, wrangler/vite/astro config,
  ledgers, migration numbering): one actor applies changes serially; other
  agents propose. No races on shared files.
- No deploys, no paid API calls, no secret printing, no new git remotes.
- D1/DO migrations are append-only. **This plan should need zero new
  migrations.** If a slice appears to need one, stop and flag — that is a
  plan defect, not a judgment call.
- After every wave: `bun run build`, `bun run typecheck`, full
  `bun test tests/`, and the wave's mapped `verify:packet` runs. Record
  receipts as JSON in
  `docs/plans/2026-10-03-fresh-build/execution-ledger.md` (command, exitCode,
  SHA, artifacts, limitations) with status LOCAL VERIFIED.

### What the review found (scope summary)

The build is above-average production code with unusually strong
authorization/security architecture and a genuine, mechanically-enforced
evidence discipline. Its problems are concentrated in **staleness and physical
organization**, not correctness:

1. The automated verification net (CI + release-check) only loops P00–P17;
   every wave after that — U/B packets and the entire newest third of the test
   suite — runs nowhere automated.
2. Copy-pasted micro-helpers across ~57k lines with no shared util module.
3. Three-plus god-files (`discovery.ts`, `repositories.ts`, `surface.tsx`,
   `Chrome.tsx`).
4. A wide agent↔host boundary (`CoordinatorHostContext`) that inverts the
   narrow-tool philosophy the tool layer follows.
5. A family of grep-as-test UI tests; a standing live-auth flag; cred-presence
   counted as PASS; a phantom mapped spec; a README migration count off by 9.

The drift observed during review (three feature waves shipped while the plan
was being written, all outside the automated net) is itself the argument for
executing R01 first and treating the completeness check — not a hardcoded file
list — as R01's acceptance artifact.

---

## Wave R01 — Repair the verification net

**Highest priority. Everything else depends on this being the safety net.**

### R01.1 — Single source of truth for the packet list

- **Problem:** `PACKET_MAP` keys in `scripts/verify-packet.ts` (lines ~41–188;
  currently 37 keys: P00–P17, U01–U10, B01–B06) are the truth, but
  `.github/workflows/ci.yml:21` hardcodes only `P00…P17`, and
  `scripts/release-check.ts:53` hardcodes the same stale array.
- **Fix:** export the packet key list from `verify-packet.ts` (or a new
  `scripts/packet-list.ts` imported by both). CI's loop and release-check's
  array must both consume `Object.keys(PACKET_MAP)`. No second hardcoded
  packet list may exist anywhere.
- **Acceptance:** adding a PACKET_MAP entry automatically runs in CI and in
  release-check; `grep -rn "P16 P17\|'P17'" .github scripts` shows the derived
  list only, no literal array.

### R01.2 — Map the orphaned tests + completeness check

- **Problem:** large numbers of `tests/*.test.ts` files are absent from
  PACKET_MAP, so they run only when someone remembers to run the full suite.
  Known-unmapped as of baseline (verify before acting — the set grows every
  wave): `publish.test.ts`, `web-risk.test.ts`, `secret-box.test.ts`,
  `app-keys-routes.test.ts`, `app-secrets.test.ts`, `code-versions.test.ts`,
  `report-page.test.ts`, `operator.test.ts`, `tavily.test.ts`,
  `tavily-discovery-adapter.test.ts`, `image-attachments.test.ts`,
  `voice-input.test.ts`, `versions.test.ts`, `app-ai.test.ts`,
  `app-sign-in.test.ts`, `repo-start.test.ts`, `build-timeline.test.ts`,
  `dispatch-worker.test.ts`, `published-entry.test.ts`.
- **Fix, in two parts:**
  1. **The real deliverable:** a new mapped test (itself in PACKET_MAP) that
     fails if any `tests/*.test.ts` file is absent from PACKET_MAP. This is
     what prevents recurrence; the list below is only today's repair.
  2. Map every currently-orphaned file to exactly one packet. New wave groups
     may get their own keys (e.g. `KEYS`, `PUBLISH`, `SAFETY`, `APPAI`) —
     choose coherent groupings, but every test file maps to exactly one key.
- **Acceptance:** the completeness test passes; deliberately removing one
  PACKET_MAP entry makes it fail (demonstrate RED, then restore).

### R01.3 — Kill the phantom spec

- **Problem:** `tests/live/github.spec.ts` is mapped for P08 live
  (`verify-packet.ts` P08 `live` array) but has never existed. `test:live --
  P08` fails loudly (correct), but the mapping promises a spec that isn't
  there, and `docs/release-evidence.md`'s honest-holes list doesn't name it.
- **Fix (pick one, document which):** create a real fail-closed live spec
  mirroring `tests/live/sandbox.spec.ts` (missing creds → throw BLOCKED), or
  unmap it and add its absence to `docs/release-evidence.md`'s
  intentionally-absent list. Do not leave the current state.

### R01.4 — Stop cred-presence counting as PASS

- **Problem:** `scripts/release-check.ts:67–81` reports live gates as PASS
  when env vars merely exist; PROVISIONED counts toward the "27 PASS" roll-up.
- **Fix:** introduce a distinct `PROVISIONED` status that never counts as
  PASS; keep `BLOCKED` when absent; only a real authorized `bun run test:live`
  receipt may produce PASS.
- **Acceptance:** with credentials present and no live run performed,
  release-check reports PROVISIONED, and the roll-up total excludes it.

### R01.5 — Reconcile doc drift

- `docs/plans/2026-10-03-fresh-build/README.md:11` says "Twenty-two D1
  migrations exist (`0001`–`0022`)". The repo is at `0031_app_sign_in.sql`
  (31 migrations). Update the count **and** extend the status paragraph to
  name the post-baseline waves: versions/restore, app-ai (env.CADDIE.ai +
  allowance), app-logins (apps' own sign-in + test inbox), Start-from-my-
  GitHub-repo, in addition to the publish/safety/keys waves already listed.
- `docs/feature-ledger.md` test-count drift: shell-v2 claimed "(10)" (actual
  13), discovery.spec claimed "(12)" (actual 11). Re-verify both counts at
  execution time, then correct.
- Delete stale debug clutter: `full-test.log`, `single-int.log`,
  `test-results/` (all gitignored, nothing false is tracked — hygiene only).

**Verify R01:** CI runs the derived packet list; `verify:packet` passes for
every key; completeness test RED-proven; release-check roll-up corrected;
README/ledger counts match the filesystem.

---

## Wave R02 — Extract shared helpers

Mechanical, wide blast radius. Run it under the repaired R01 net.

### R02.1 — `apps/app/src/server/util.ts` and `apps/app/src/server/db.ts`

- Deduplicate: `nowIso()` in ~22 server files, `queryAll()` in ~20,
  `newId()` in ~10, JSON body reader / error-mapper boilerplate across ~13
  route files (`readJson`, `errorJson`-style handlers).
- Pure mechanical move: identical signatures, re-export where callers need
  continuity. **Existing tests must pass unmodified — that is the equivalence
  proof.** If a test must change, stop and justify why.

### R02.2 — Shared helpers for app + dispatch Worker

- `escapeText`/`escapeAttr`/`page()`/`sameOrigin()` are duplicated verbatim
  in `apps/app/src/server/routes/report.ts` (~44–50, 145–150),
  `apps/app/src/server/routes/operator.ts` (~38–44, 100–105), and
  `workers/dispatch/src/pages.ts`.
- The dispatch Worker also consumes app code via relative
  `../../apps/app/...` imports (`workers/dispatch/src/outbound.ts:13–14`) —
  two deployables coupled by directory layout.
- **Fix:** create a small workspace package (e.g. `packages/worker-shared/`)
  holding the HTML/escaping helpers and the outbound-policy surface shared
  across deployables. App and `workers/dispatch` both import the package.
  Manifest/lockfile edits are integration-lead-owned. `packages/contracts`
  stays schemas-only — this package is runtime code, deliberately separate.
- **Acceptance:** no cross-deployable relative imports remain;
  `grep -rn "escapeText" apps workers` shows one definition.

**Verify R02:** full unit suite green (unmodified tests), `verify:packet` for
all touched packets, `bun run build` composes assets without collision (P00
invariant), dispatch Worker typechecks against the package.

---

## Wave R03 — Split the god-files

One file per slice, behind its existing tests. Public service function
signatures stay stable; only file boundaries change. Sizes are at baseline and
growing — re-measure before acting.

### R03.1 — `apps/app/src/server/discovery.ts` (2,167 lines) → `server/discovery/`

- `parse.ts` (pure prize/date/format/fit normalization, ~455–770),
  `devpost.ts` (adapter ~771–1005), `tavily.ts` (adapter ~1178),
  `store.ts` (D1 feed/candidate persistence ~1248+), `index.ts` re-exporting
  the current surface.
- Safety net: `tests/discovery.test.ts`, `tests/devpost-source.test.ts`,
  `tests/tavily-discovery-adapter.test.ts`, `tests/discovery-saved.integration.test.ts`,
  `tests/discovery-sanitize.test.ts`.

### R03.2 — `apps/app/src/server/repositories.ts` (1,985 lines) → `server/repositories/`

- `webhooks.ts` (~153–316), `installations.ts` (~419+),
  `import.ts` (~545–814), `pr-delivery.ts` (~1350+), `merge.ts` (~1799+),
  `index.ts` facade.
- Safety net: `tests/github*.test.ts`, `tests/project-isolation.integration.test.ts`,
  webhook signature tests.

### R03.3 — `apps/app/src/client/surface.tsx` (1,823 lines, 16 page components) → `client/surface/`

- One module per page (Discover, Projects, Overview, Design, Runs, Artifacts,
  Schedules, Tasks, Submission, Evidence, Repos, Search, Automations, Usage…)
  plus a barrel; router imports resolve to unchanged component names.
- Safety net: `tests/browser/*.spec.ts` +
  `tests/project-experience-route.test.ts`. Run the browser harness for all
  affected packets.

### R03.4 — `apps/app/src/client/workspace/Chrome.tsx` (1,412 lines)

- Extract the ~10 local subcomponents into `client/workspace/chrome/`;
  three-band responsive layout logic stays intact.
- Browser-verify at 390/768/1440, light + dark.

**Verify R03:** per slice — focused unit + browser specs, then full suite +
build. Record before/after line counts in the ledger receipt.

---

## Wave R04 — Narrow the agent boundary

- **Problem:** `CoordinatorHostContext`
  (`apps/app/src/agents/coordinator.ts:44`, extends `SpecialistBuildContext`)
  exposes ~53 members; the host implementing it,
  `apps/app/src/server/coordinator-host.ts` (934 lines), imports ~35 service
  modules. The agent depends on the whole product surface — inverting the
  narrow-tool philosophy that `agents/tools.ts` (15-line `SandboxToolDeps`)
  and `agents/permissions.ts` (mounting = permission enforcement) get right.
  A new `apps/app/src/agents/host-context.ts` (117 lines) already factors part
  of the seam — build on it rather than fighting it.
- **Fix:** define role-scoped sub-interfaces — e.g. `DiscoveryHost`,
  `ProfileHost`, `PlanningHost`, `BuildHost`, `AppKeysHost`, `PublishHost`,
  `AppAiHost`, `VersionsHost` — each 5–10 members grouped by the coordinator
  role that uses them. `CoordinatorHostContext` becomes their composition.
- Change agent tools to declare the sub-interface they need; a discovery tool
  cannot access publish methods at the type level (same pattern as
  `SandboxToolDeps`).
- Runtime behavior identical: same calls, same order, same outputs.
- **Safety net:** `tests/agent-permissions.test.ts`,
  `tests/coordinator-context.test.ts`, `tests/home-chat-tools.test.ts`,
  `tests/workflow-dispatch.test.ts`.
- **New acceptance artifact:** a type-level test proving a tool wired to
  `DiscoveryHost` cannot access `PublishHost` members (e.g. `@ts-expect-error`
  on an illegal access).

**Verify R04:** full suite + `verify:packet` for P05, U-packets, B-packets;
the type-level negative test is the proof.

---

## Wave R05 — Test-quality upgrades

### R05.1 — Replace grep-as-test render claims

- **Problem:** `tests/approval-card.test.ts` (~21–71) `readFileSync`s source
  and asserts `toContain(...)` — its "renders the spend cap" test only proves
  a string literal exists in a file. Same family:
  `tests/theme-state.test.ts`, `tests/build-activity.test.ts` (find the full
  set with `grep -l readFileSync tests/*.test.ts`, then classify by eye —
  many uses are legitimate fixtures/migrations).
- **Rule going forward:** rendering claims are proven by browser specs in the
  existing `tests/browser/` harness. Source-string assertions survive **only**
  for registration contracts (e.g. `useDataWriter('approvalCard'`) and are
  relabeled in-file: `// SOURCE-PIN (registration contract)` so nobody
  mistakes them for render proof.
- New browser specs must be mapped into PACKET_MAP (per R01.2's check).

### R05.2 — Live-authorization freshness bound

- **Problem:** `scripts/verify-packet.ts` (~27–37) loads standing
  `CADDIE_LIVE_AUTHORIZED` from gitignored `.dev.vars`, degrading "explicit
  authorization" to a persistent file flag (already acknowledged in the
  execution ledger).
- **Fix:** the flag must carry a timestamp (`CADDIE_LIVE_AUTHORIZED_AT`);
  older than 24h → BLOCKED with a clear message telling the operator to
  re-authorize. Document in `docs/runbooks/`.

**Verify R05:** demonstrate one new browser spec RED against a deliberate
regression, then green; live gate blocks against a stale timestamp.

---

## Wave R06 — Typing and seam hygiene

- **Row casts:** ~36 `as unknown as` / `as never` sites at the D1 persistence
  edge (e.g. `build-workflow.ts` ~61, ~515). Introduce small per-table-cluster
  row-mapper functions (or valibot schemas from `packages/contracts`, which
  already uses `strictObject`). No behavior change; each mapper gets a unit
  test with a representative row **and** a malformed row.
- **`resolveAppSecrets(db, keyring, projectId)`** intentionally bypasses scope
  (`app-secrets.ts` ~212–218) — documented, but a footgun. Make the privilege
  visible in the name or require a branded `ServerInternalContext` parameter
  so a future caller cannot reach it by accident.
- **Report rate-limit key reuse:** `routes/report.ts:140` uses
  `BETTER_AUTH_SECRET` with fallback literal `'caddie-report'` as the HMAC key,
  and `:183` passes `BETTER_AUTH_SECRET` directly. Give it a dedicated
  `REPORT_RATELIMIT_SECRET` with its own fallback so rate-limit forgery can
  never ride on auth-secret rotation semantics.

**Verify R06:** full suite; extend `tests/secret-box.test.ts`,
`tests/app-secrets.test.ts`, `tests/report-page.test.ts`,
`tests/build-workflow.test.ts` for each new mapper/guard.

---

## Wave R07 — Documentation reconciliation and close-out

- Refresh `docs/release-evidence.md` (dated 2026-10-06; ~11 days stale at
  baseline): add the 2026-10-16 security pass, the publish/keys/safety wave,
  the versions/app-ai/app-logins/github-start waves, all R01–R06 waves, and
  the corrected honest-holes list (including the `tests/live/github.spec.ts`
  resolution from R01.3).
- Every R-wave appears in
  `docs/plans/2026-10-03-fresh-build/execution-ledger.md` with JSON receipts
  (command, exitCode, SHA, artifacts, limitations) and, where user-visible
  behavior changed (it shouldn't, beyond R05), in `docs/feature-ledger.md`.
- **Definition of done:**
  - `bun run build` ✅
  - `bun run typecheck` ✅
  - `bun test tests/` green except LIVE-gated suites reporting BLOCKED
  - `bun scripts/release-check.ts`: every packet verified via the derived
    list; live gates PROVISIONED/BLOCKED — never PASS-by-presence
  - No hardcoded packet array remains outside PACKET_MAP
  - Completeness check (R01.2) is mapped and passing

---

## Execution order and dependencies

```
R01 (net) ──► R02 (helpers) ──► R03 (splits) ──► R04 (agent boundary)
   │                                              ▲
   └────────► R05 (test quality) ─────────────────┘
   └────────► R06 (typing/seams)  ────────────────┘
                    R07 (docs) — strictly last
```

- R01 must land first: it is the safety net for everything after it.
- R02 before R03: dedup first makes the splits cheaper.
- R05 browser specs can run parallel to R03/R04 once R02 is in.
- R07 is strictly last — it reconciles everything.

**Freshness rule:** the orphan list in R01.2 and the god-file line counts in
R03 were accurate at baseline `4f4e1c65` and will drift as waves land. Re-run
the inventory commands (`grep -l readFileSync`, `wc -l` on the four files, the
PACKET_MAP completeness check) at execution time; the completeness test from
R01.2 is the durable guard, not this document's list.

## Out of scope (owner-gated — do not attempt)

Real OAuth callbacks on hosted origins, live Laravel/FastAPI/Flutter stack
journeys, real GitHub App registration, production Resend domain, R2/preview
origin, and any deployment. These stay BLOCKED per AGENTS.md. This plan makes
the local net strong enough that when the owner flips them on, the evidence is
trustworthy.
