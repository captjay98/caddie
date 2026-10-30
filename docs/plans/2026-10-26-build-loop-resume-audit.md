# Build-loop resume audit — read-only state for the next round

**Date:** 2026-10-26, Africa/Lagos. **Author:** Kiro (kirocrew-worker, read-only investigation).
**Repo:** `/Users/captjay98/projects/caddie-forge`, branch `main`, **320 commits ahead of
`origin/main`, working tree clean** (only untracked file: `docs/plans/2026-10-26-judge-walkthrough-fixes.md`,
plus this report). No code was changed; no paid call or deploy was made.

**Evidence classification** per root `AGENTS.md`: LOCAL VERIFIED / LIVE VERIFIED / SIMULATED /
DOCUMENTATION ONLY / BLOCKED / FAILED. A mocked or local-only pass is never LIVE VERIFIED.

---

## 0. Headline for the conductor

- The repo **builds and typechecks clean locally** — LOCAL VERIFIED (§1).
- There is **no single "demo app" inside this repo**; the demo apps are rows in the local D1
  database (generated projects). **Two of them are `blocked` mid-build** — the judge-walkthrough
  "Livestock Risk Tracker" and the older "Farmhand" (§1).
- The A→Z build→preview→checklist→**publish** pipeline **exists and is wired** in code (routes
  registered, services present); publish is correctly **OWNER-GATED** behind a recorded approval (§2).
- SPA routing is wired (TanStack Router, basepath `/app` in the composed build, root in dev). The
  "server crashed at `http://localhost:5176/app/`" note is a **dev-server-not-running / wrong-base**
  condition, not a routing-code defect: 5176 is the pinned Vite dev port (§3).
- The Codex-thread work is **already committed to `main`** (build-reliability R1–R3 + judge-door and
  onboarding UI). What remains open toward the goal is captured in two handover docs and the
  untracked judge-walkthrough spec (§4).
- The Flutter stack is still the **minimal http-only scaffold**; the Clean-Architecture rewrite is
  net-new work touching 4 named files + the lock-refresh script (§5).

---

## 1. Demo-app state  — which app was the build loop finishing?

**There is no demo app committed in the repo tree.** Caddie *generates* apps; the generated apps live
as rows in the local D1 at
`apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c204843922…6b331b.sqlite`
(read-only). Two generated projects have an in-flight build; both are **BLOCKED**:

| Project | id | kind | workflow phase | repairPolicyVersion | features |
|---|---|---|---|---|---|
| **Livestock Risk Tracker** (judge walkthrough) | `proj_8f9cb1aeea005c54dd52af005dc92627` | standard | **blocked** (updated 2026-10-26T09:21) | *(empty — ran before the repair-ladder fix)* | — |
| **Farmhand** | `proj_506d61ece6d7ca3a12fdd9a41a281960` | standard | **blocked** (updated 2026-10-26T10:49) | `repair-v1` | 2 of 8 passed, feature 3 `building` |

Farmhand feature detail (from `build_features`):

```
1 shared-backbone-crud        passed   (3 tests)
2 offline-sync-queue          passed   (6 tests)
3 mortality-medication-logs   building (3 attempts) ← blocked: client behavior tests don't match App.tsx DOM
4 mid-cycle-import            pending
5 voice-farmhand              pending
6 feed-runway-predictor       pending
7 disease-triage              pending
8 roles-visit-map             pending
```

The Farmhand block (recorded in `build_workflows.detail`) is a **test-authoring mismatch** on feature 3:
3 client behavior tests in `src/mortality-medication.test.tsx` assert DOM text/tabs that don't match the
generated `src/App.tsx`; server tests pass 3/3. Prior handover (`2026-10-26-build-reliability-continuation-handover.md` §4)
recorded Farmhand as "paused / Needs attention, 2 of 8 checked" — consistent with current D1.

**Stack:** both are `standard` kind → the **react-hono** output stack (React SPA + Hono/Workers + D1),
not Flutter. (Flutter is a separate `app_kind` gated by `FLUTTER_APPS_ENABLED`.)

**No publications and no publish runs exist yet:** `app_publications` = 0 rows, `app_publish_runs` = 0.
So neither demo reached the PUBLISH step; both are stuck earlier, in the build/repair loop.

### Local build verification (free, allowed)

bun is resolved via mise (`$HOME/.local/share/mise/installs/bun/1.4.0/bin`; no repo pin, shim errored
without a version).

- **`bun run typecheck`** → `tsc --noEmit && bun --cwd=apps/app run check:types` → **exit 0 — LOCAL VERIFIED.**
- **`bun run build`** → Astro + Vite + `scripts/compose-assets.ts` → **exit 0 — LOCAL VERIFIED.**
  Output: `✓ built in 350ms`; composed 1 relocated SPA + 104 SPA assets + 99 landing files; collisions 0;
  build named `caddie-app-dev` (non-production, **undeployable to production** — expected for a local build).
  (Rolldown warned one chunk >500 kB — advisory only, not a failure.)

> This verifies the **Caddie platform** builds, not any generated demo app. A generated app's own
> build runs inside the sandbox image during the build loop and is what is currently blocked (above).

---

## 2. The A→Z build / preview / checklist / publish flow — each step + state

The pipeline is implemented across `apps/app/src/server/` with routes registered in `apps/app/src/app.ts`.

| Step | Where | State |
|---|---|---|
| **Intake / brief** | `server/brief.ts`, `build_workflows.brief` | WIRED — brief captured per project (seen populated in D1). |
| **Plan / PRD** | agents `coordinator.ts` + `specialists.ts` (`product`), `build_features` | WIRED — plan + per-feature `doneWhen` acceptance rows created. |
| **Design / looks** | `LooksPicker.tsx`, `DesignMockPreview.tsx`, `server/design-review-capture.ts` | WIRED — but judge-walkthrough §B flags the coordinator **under-delegating** design to the `designer` specialist (now addressed by commit `a648adc`). |
| **Build loop (feature-by-feature)** | `coordinator-host.ts`, `build-workflow.ts`, `build-features.ts`, repair ladder `repair-escalation.ts` | WIRED; **this is where both demos are BLOCKED.** Repair ladder now default-and-only (`9bbc375`, `repair-v1`). |
| **Preview** | `server/routes/previews.ts` → `preview-runtime.ts`, `built-app.ts`; tokens in `preview_tokens` | WIRED — routes: `POST/GET /projects/:id/previews`, `:previewId/revoke`, `/extend`, `GET /previews/resolve/:token`. Signed, time-boxed preview links. |
| **Delivery checklist** | skill `agents/skills/delivery-checklist/SKILL.md`; `server/submission.ts`; client `submission/Package.tsx`, `project/FeatureChecklist.tsx` | WIRED — checklist derived from the project's real requirements + receipts; "The human presses Submit. Prepare; never submit." |
| **Publish** | `server/routes/publish.ts` → `publish.ts`, `publish-safety.ts`, `publish-env.ts`, `published-page.ts` | WIRED — **OWNER-GATED (do NOT run as an agent).** |

### Publish = OWNER-GATED

`POST /projects/:projectId/publish` requires the recorded **`deploy-production` approval** bound to the
build's bundle-manifest hash and re-checked at publish time (`publish.ts` header + `routes/publish.ts`
L13–20). Routes `publish` / `publish/unpublish` / `publish/rollback` are all **owner**-scoped. Without the
owner's Cloudflare account inputs + `APPS_DOMAIN`, publishing reports "not set up". Publish deploys to
Caddie's own Cloudflare account, creates a live DB, applies migrations, uploads a Worker — **irreversible,
live, credit-spending.** Per repo rules and standing owner policy this step is **not for an agent to run**;
it waits on the owner's explicit confirm.

---

## 3. Routing — "confirm the routing works" + the `localhost:5176/app/` crash

**Routing code is present and wired** — `apps/app/src/client/routes.tsx` (TanStack Router, SPA mode):

- **Basepath differs by build:** composed Worker build serves the SPA under **`/app`** with a
  client-routing fallback (asserted by `tests/routing.test.ts`, present); **`bun run dev` serves at the
  root `/`**. So in dev the app is at `http://localhost:5176/` and the SPA routes are `/app/...` only in
  the composed build. Hitting `/app/` against the **dev** server (root-based) is a likely source of a
  blank/"crashed" page.
- Global destinations: Brief · Discover · Projects, plus account surfaces and project-local surfaces;
  every route renders inside `WorkspaceChrome` (no chrome-less dead ends). Selected project carried in
  `?project=` so refresh/deep-links retain it.

**The `http://localhost:5176/app/` "server crashed":** port **5176 is the pinned Vite dev port**
(`apps/app/vite.config.ts` L31–35: `server: { port: 5176, host: "localhost", strictPort: true }` — pinned
because 5173–5175 belong to other local projects and the OAuth redirect URIs are registered for 5176).
`strictPort: true` means Vite **fails loudly** if 5176 is taken rather than drifting to another port — so a
"crash" there is most plausibly **the dev server not running / exited / port already in use**, not a defect
in the routing code.

**Finding:** no evidence of a routing-code defect; typecheck is clean and `tests/routing.test.ts` exists.
The next round should **start the dev server (`bun run dev`, port 5176) and confirm it stays up**, and use
the **root** URL in dev (not `/app/`). This was **not run** here (starting a long-lived dev server is outside
a read-only audit) — classified **BLOCKED (not attempted; read-only scope)**.

---

## 4. Codex-thread leftovers — recent work vs. still-open

The "mostly done" Codex work is **already committed to `main`** (tree is clean; nothing dangling). Last 30
commits cluster into two streams:

**(a) Build reliability (R1–R3):** `6207f97` persist repair escalation + bound provider work →
`d81dd87` bound helper retries → `7e581d4` verify candidates in isolated browser runtimes →
`6207f97`/`9bbc375` repair ladder default-and-only (`repair-v1`) → `10c4ed5` carry repair-escalation
migration in fixtures → `a648adc` design step delegates to the designer → `5824450` product specialist
weighs a landing/intro surface.

**(b) Judge-door + onboarding + landing UI:** `a898fbd`/`53bf384` redo landing for non-technical builders,
`5e77fdf` one calm sign-in screen, `29197b6` judge sign-in its own titled form, `1ade6ef` judge form in a
real card, `8d23c7b` calmer judge-door link, `9af01e7` idea onboarding lands on the split.

**Handover docs (DOCUMENTATION ONLY — claims not re-verified here):**

- `docs/plans/2026-10-26-build-reliability-continuation-handover.md` — states R1–R3 implemented + locally
  verified (full suite **2,783 passing**; affected browser suite **117 passing, 1 pre-existing skip**).
  **Open per its own text:** R4 (final whole-tree clean rerun + controlled Farmhand resume) and caveats
  that the strict **quality policy must stay opt-in** until the independent-acceptance executor and
  state-navigator are proven end-to-end. Local migrations applied through **0053**; migrations 0049–0053
  **untracked** — preserve numbering. Backup of 16 SQLite files at `/private/tmp/caddie-before-reliability-shixm28d`.
- `docs/plans/2026-10-26-judge-walkthrough-fixes.md` (untracked) — an **apply-ready spec, not a diff**, from
  a judge-persona walkthrough of the Livestock demo. Open items: strengthen design/planning skills (§D),
  the "Choose a look" preview defacement (§E.1, **cause not yet pinned — reproduce before editing**), and
  ~8 UI/UX copy fixes (engineer-speak/IDs leaking to users, dense plan summary, "PRD rejected" wording,
  step-tracker lag, 3-questions-in-one-message). Its §A–C fixes appear **already landed** as commits
  `9bbc375`/`a648adc`/`5824450` — the conductor should diff the spec against those commits to see what's
  left.

**Toward the user's stated goal (finish a demo A→Z to publish; make Flutter build like onesecos/projavi):**
still OPEN — (1) **unblock a demo build** (Farmhand feature 3 test mismatch, or re-run the Livestock demo on
the now-default repair ladder) → preview → checklist → **owner publish**; (2) the Flutter rewrite (§5);
(3) the judge-walkthrough UI polish; (4) R4 whole-tree verification + controlled resume.

---

## 5. Flutter stack readiness

The current `stacks/flutter/` ships a **minimal, http-only scaffold**: a generic Flutter app (package
`caddie_app`) over the same Hono + D1 react-hono backend, proven in the Flutter sandbox image
(`scripts/build-flutter-image.ts`). The only non-SDK **direct main** Dart dependency in
`FLUTTER_PUBSPEC_LOCK` is **`http`** (plus `flutter`); everything else is transitive or dev. There is **no
Clean-Architecture layering** (no domain/data/presentation split, no DI, no repositories/use-cases). The
target is full Clean Architecture per the reference checkouts — **both present and readable**:
`/Users/captjay98/projects/onesecos/mobile` (FOUND) and
`/Users/captjay98/projects/onesecos/.opencode/skills/flutter-architecture/SKILL.md` (FOUND). The scaffold
rewrite will touch the four named files — **`stacks/flutter/scaffold.ts`** (the file manifest/app source),
**`recipe.ts`** (install/test/build commands + `imageDigest`), **`scaffold-lock.ts`** (GENERATED bun.lock +
pubspec.lock + `FLUTTER_SCAFFOLD_DIGEST`, regenerated via `scripts/refresh-flutter-scaffold-lock.ts`), and
**`digest.ts`** (sha256 over sorted scaffold files) — and any added Dart packages must land in the
refreshed pubspec.lock, keeping `tests/flutter-scaffold.test.ts` (digest guard) green.

---

## 6. Evidence ledger (classification)

| Claim | Class | Evidence |
|---|---|---|
| Repo clean, main, 320 ahead | LOCAL VERIFIED | `git status` / `git log` |
| `bun run typecheck` passes | LOCAL VERIFIED | exit 0 |
| `bun run build` passes | LOCAL VERIFIED | exit 0, `✓ built in 350ms`, caddie-app-dev |
| Both demo builds BLOCKED | LOCAL VERIFIED | D1 `build_workflows` / `build_features` read-only |
| No publications / publish runs | LOCAL VERIFIED | D1 `app_publications`=0, `app_publish_runs`=0 |
| Publish is owner-gated | LOCAL VERIFIED | `routes/publish.ts` + `publish.ts` header (code read) |
| Preview/checklist flow wired | LOCAL VERIFIED | route grep + skill/service files read |
| Dev port 5176 pinned, strictPort | LOCAL VERIFIED | `apps/app/vite.config.ts` L31–35 |
| Routing basepath /app vs root | LOCAL VERIFIED | `routes.tsx` header + `tests/routing.test.ts` exists |
| `/app/` crash = dev-server/base issue | DOCUMENTATION ONLY | inferred from pinned-port config; dev server NOT started (read-only) |
| Flutter scaffold is http-only | LOCAL VERIFIED | `scaffold-lock.ts` pubspec.lock direct deps |
| onesecos Flutter reference present | LOCAL VERIFIED | paths exist on disk |
| Handover suite counts (2783 / 117) | DOCUMENTATION ONLY | handover doc text; not re-run here |
| Full test suite status now | BLOCKED | not run (read-only scope; heavy) |

---

## 7. Recommended next round (for the conductor to plan — not executed here)

1. **Unblock one demo to PUBLISH-ready.** Pick Farmhand (feature 3 DOM-match test rewrite) or re-run the
   Livestock demo on the now-default repair ladder; then preview → delivery checklist → stop at publish.
2. **Confirm routing on a running app.** Start `bun run dev` (5176), load the **root** URL in dev,
   click through Brief/Discover/Projects + a project's Overview/Plan/Build/Submission.
3. **Publish = owner decision.** Prepare everything; surface the owner-confirm; do not run it.
4. **Flutter Clean-Architecture rewrite** (separate stream): port `../onesecos/mobile` structure + the
   flutter-architecture SKILL into `scaffold.ts`/`recipe.ts`, refresh `scaffold-lock.ts`/`digest.ts`, keep
   `tests/flutter-scaffold.test.ts` green.
5. **R4 closeout** (from the reliability handover): one clean whole-tree rerun + controlled Farmhand resume;
   keep the strict quality policy opt-in until the independent executor/navigator are proven.
