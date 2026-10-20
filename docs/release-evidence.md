# Release evidence (P17)

The single evidence table behind a release decision. Classifications are
exact and binding (AGENTS.md): LOCAL VERIFIED, LIVE VERIFIED, SIMULATED,
DOCUMENTATION ONLY, BLOCKED, FAILED — a mocked or local-only pass is never
LIVE VERIFIED, and agent/model self-reports are never success evidence.
Per-packet command receipts live in
`docs/plans/2026-10-03-fresh-build/execution-ledger.md`; this page is the
roll-up a release reviewer reads.

## How to reproduce

```sh
bun run typecheck                 # root + apps/app projects
bun run build                     # Astro + Vite + composition (no deploy)
bun run verify:packet Pxx         # per-packet mapped tests (never vacuous)
bun run test:browser -- Pxx       # browser specs against the composed build
bun run test:live -- Pxx          # live specs — BLOCKED without CADDIE_LIVE_AUTHORIZED=1
bun scripts/release-check.ts      # the full local gate before any release request
```

## Current local gate

Recorded 2026-10-06 on branch `p15-p17-completion`, with the owner's
`.dev.vars` provisioned (OAuth clients, `NEBIUS_API_KEY`, `CONTREE_*`,
`CADDIE_LIVE_AUTHORIZED=1`). Nothing deploys and nothing spends.

| Check | Classification | Receipt |
|---|---|---|
| `bun run typecheck` | LOCAL VERIFIED | exit 0 |
| `bun run build` | LOCAL VERIFIED | exit 0 — one composed Workers assets tree |
| `bun scripts/release-check.ts` | LOCAL VERIFIED | exit 0 — **27 PASS, 0 FAIL, 1 BLOCKED** (the BLOCKED is "deployment authorization", permanently owner-gated by design) |
| `bun run verify:packet P00…P17` | LOCAL VERIFIED | 21/21 packets pass; categories a packet does not carry report NOT APPLICABLE — named, never faked |
| browser suites (`test:browser`) | LOCAL VERIFIED | 13 landing (P16), 2 auth (P01), 3 workspace + conversation (P06), plus per-packet specs — all green against the composed build |
| `tests/browser/release.spec.ts` (P17 local half) | LOCAL VERIFIED | landing 200 + content, /app/ SPA shell, auth status fail-closed, JSON 404 fallback, zero console/page errors on load |

## Live receipts (owner-authorized runs; ledger entries hold the commands)

| Packet | Capability | Classification | Receipt |
|---|---|---|---|
| P05 | Model route round-trip (Nebius) | LIVE VERIFIED | real coordinator model call, ledger `P05-live` |
| P09 | React+Hono journey end-to-end | LIVE VERIFIED | run-journey PASS on every manifest phase (seed → install → seeded tests → build → deliberate red → repair → server-start → browser-check → artifact); `bun run test:live -- P09` 2 passed |
| P04 | contree sandbox session + remote exec | LIVE VERIFIED | `tests/live/sandbox.spec.ts` against the real Contree service — 2 tests passed, receipt `lr_31a967c50ad3de16` at `702c97cab57b` (2026-10-20); earlier contree CLI probe in ledger `P04-live` |
| P12 | Real outbound email (Resend) | LIVE VERIFIED | exactly one send to the owner's own address; provider receipt id `01a11346-68df-7538-8dc7-ee1b593ad5ef` |
| P01 | OAuth sign-in round trips | LIVE VERIFIED (user-performed) | owner executed real Google + GitHub sign-in against the dev origin; the machine-rerunnable probes stay gated (release-check live gates) |
| P15a | TanStack Start template flow | LIVE VERIFIED | `tests/live/stacks/tanstack-start.spec.ts` — real `bun install` / `bun test src/` / `bun run build` in a temp dir, production server answers 200 with the SSR markers |
| P15b | Laravel + Inertia journey | BLOCKED | `tests/live/stacks/laravel-inertia.spec.ts` gates honestly: needs `CADDIE_LIVE_AUTHORIZED=1` (composer install is a network effect) + composer/php/npm present |
| P15c | FastAPI + React journey | BLOCKED | `tests/live/stacks/fastapi-react.spec.ts`: needs `CADDIE_LIVE_AUTHORIZED=1` + uv/python/bun present |
| P15d | Flutter journey (APK + emulator) | LIVE VERIFIED | `tests/live/stacks/flutter.spec.ts` — real `dart caddie/setup.dart` + locked `flutter pub get` + `flutter test test/examples` + `flutter build apk --debug`, then install, launch and capture on an arm64 emulator; receipt `lr_602f8532232b3019` at `9af594f396d3` (2026-10-20), 2 tests passed. Requires `CADDIE_LIVE_AUTHORIZED=1` + flutter + adb + a booted emulator, and clears a stale differently signed install of the same app id first |
| P17 | Hosted acceptance smoke | LIVE VERIFIED | `tests/live/release.spec.ts` against `https://caddie.jamalibrahim.dev` — 5/5 PASS, receipt `lr_f01e5b354852f7bc` at `702c97cab57b`, 2026-10-20 (previous deploy: `lr_1445a409fddf0a19` at `a58adabd406a`) |

Intentionally-absent live specs stay honest holes, not fake passes:
`tests/live/github.spec.ts` (P08) is authored only against a real registered
GitHub App (owner-gated; docs/setup/github-app.md), so it stays out of the P08
live map rather than promising a spec that cannot run. The two earlier holes
are closed: `tests/live/sandbox.spec.ts` (P04) and
`tests/live/preview.spec.ts` (P07) now exist and are mapped.

## Production deploy (G4, 2026-10-19)

| Item | Value |
|---|---|
| URL | https://caddie.jamalibrahim.dev (custom domain, DNS + cert created by the deploy) |
| Version id | `b80283db-0d80-4253-aa75-1f14aaebc24d` |
| Commit | `7e2e64f` (tree carried three pre-existing untracked docs/scripts files) |
| Preflight | `bun scripts/deploy-preflight.ts --owner-only` — 18 PASS, 2 WARN (reused-local Nebius/Tavily/Contree keys, flagged for rotation; untracked files), 0 FAIL |
| D1 | `caddie` → `f6315eae-99da-4afc-93d0-356afcd511a0`, migrations 0001–0035 applied remotely before the deploy |
| Smoke | P17 live 5/5 PASS (receipt above); landing, /app shell, sign-in status, JSON 404 |
| Sign-in round trip | LIVE VERIFIED (user-performed, 2026-10-19/20): owner signed in via GitHub and via Google against the production origin; D1 shows 1 user with two `account` rows (github ×1, google ×1 — same-email linking). GitHub's new-app trust gate blocked the consent button earlier in the day; it lifted within hours. Google client: project `airy-cortex-512223-k2`, consent screen in **Testing** with the owner as test user (publishing to In production waits on Google's branding-page completion — cosmetic while only the owner signs in). |
| Judge access | LIVE VERIFIED: `JUDGE_ACCESS_CODE` + `JUDGE_ACCESS_UNTIL=2026-12-16` uploaded as secrets (no rebuild); `GET /api/judge/access` → `{"open":true,"canStart":true}`. Remaining: owner starts one judge account in a private window before the code is shared. |

## Production deploy (2026-10-20): live fixes + Track 3

Owner-authorized deploy of `main` at `702c97c`, carrying Kiro's live fixes
(`e70e534`) and Track 3 Flutter/Android apps (`2d176fa`) on top of the
2026-10-19 production build.

| Item | Value |
|---|---|
| URL | https://caddie.jamalibrahim.dev |
| Version id | `e6531a20-21ee-4138-a86e-5ca6ff14469a` |
| Commit | `702c97c` (tree carried one untracked docs-only review file; no code outside a commit) |
| Release gate | the 2026-10-20 integrated gate above — 1,696 unit/service tests, 43/43 applicable packets, 275 browser tests, `release-check` 0 FAIL |
| Preflight | `bun scripts/deploy-preflight.ts` — 18 PASS, 2 WARN (reused-local Nebius/Tavily/Contree keys, still flagged for rotation; untracked docs file), 0 FAIL |
| Dry run | `wrangler deploy --dry-run` — DB, LOADER, PREVIEW_DB and both Flue agents listed; nothing uploaded |
| D1 | `caddie` → `f6315eae-99da-4afc-93d0-356afcd511a0`; migrations `0036_proposal_required_tech`, `0037_proposal_audience_problem`, `0038_flutter_apps`, `0039_large_content` applied remotely **before** the code (`0001–0035` were already applied) |
| Deploy | `wrangler deploy --secrets-file .prod.vars` → Uploaded `caddie-app` (21.58 s), triggers deployed (6.48 s): custom domain + `*/5 * * * *` schedule |
| Build identity | live `/sw.js` reports `BUILD = 'df640ece5c60'`, byte-identical to the production build composed locally |
| Smoke | P17 live 5/5 PASS, receipt `lr_f01e5b354852f7bc` at `702c97cab57b`; landing `200`, `/app/` `200`, `/api/auth/status` → `{"authenticated":false}`, `/api/judge/access` → `{"open":true,"canStart":true}`, unknown `/api/*` → JSON `404` |
| Judge access | unchanged (`open:true`, `canStart:true`); the same secrets were re-uploaded, no setting changed |

### Live gates after the deploy

| Gate | Status | What ran |
|---|---|---|
| P04 sandbox | **LIVE VERIFIED** | `bun run test:live -- P04` against the real Contree service — 2 tests passed, receipt `lr_31a967c50ad3de16` at `702c97cab57b` |
| P05 model route | **LIVE VERIFIED in part** | `tests/live/hackathon-followup-routing.spec.ts` on the real Nebius model — 3/3 trials called `hackathon_details` for the card's event, no `research` call. The full coordinator round-trip (`flue-lifecycle.spec.ts`) was **not** run: it needs a signed-in session cookie, which only the owner's browser can produce. No P05 receipt was written. |
| P01 OAuth | **LIVE VERIFIED in part** | both provider handoffs answer `200` from the production origin and redirect with the production callback — GitHub → `github.com`, `redirect_uri=https://caddie.jamalibrahim.dev/api/auth/callback/github`, scopes `read:user user:email`; Google → `accounts.google.com`, `redirect_uri=…/api/auth/callback/google`, scopes `email profile openid`. The consent + callback leg remains owner-performed. |
| P10 retrieval | **LIVE VERIFIED in part** | `fetchWithPolicy('https://example.com/')` with the Worker's own policy and `CADDIE_LIVE_AUTHORIZED=1` → `200 text/html`; `tavilySearch` with the production key → 2 ranked results. The route-level capture needs a signed-in project scope, so no P10 receipt exists. |

`release-check` still reports P01/P05/P10 PROVISIONED: the machine gate only
counts a recorded receipt for a packet with mapped live specs, and P01, P05
(the full round-trip) and P10 need an interactive owner sign-in. P04 is now
PASS from its receipt.

## Verification net (S01, 2026-10-18)

The 2026-10-06 gate above is kept as a dated receipt; this is the net that
keeps it honest. Recorded on `feat/publish-on-cloudflare` at `511f35f3` + S01,
no deploy and no paid call.

| Check | Classification | Receipt |
|---|---|---|
| `bun run verify:packet --all` | LOCAL VERIFIED | 43 packets — 37 PASS, 0 FAIL, 6 NOT APPLICABLE (named, not faked) in 67s |
| `tests/packet-completeness.test.ts` (packet NET) | LOCAL VERIFIED | 6/6 pass; proved to fail when one file is unmapped and when a mapping names a file that does not exist |
| `bun run test` | LOCAL VERIFIED | 1,339 pass, 0 fail, 104 files |
| `bun run typecheck`, `bun run build` | LOCAL VERIFIED | exit 0 both |
| `bun scripts/refresh-scaffold-lock.ts --check` | LOCAL VERIFIED | exit 0 — lockfile current |
| `bun scripts/release-check.ts` | LOCAL VERIFIED | 45 PASS, 0 FAIL, 1 BLOCKED (deployment authorization, by design), 4 PROVISIONED — credentials present but no live run recorded, so never counted as PASS |
| `tests/browser/project-workflow.spec.ts` (P16/BUILD) | LOCAL VERIFIED | 28 passed against the composed build |

The 82 files that ran in no packet now run: 76 `tests/*.test.ts` and 6 specs,
regrouped into PUBLISH, KEYS, VERSIONS, APPS, BUILD and existing packets. Live
gates turn PASS only via a receipt in `docs/live-receipts.json`, which
`bun run test:live -- Pxx` writes after every mapped live spec of that packet
passes (the round-trip was proven directly; no live run has been made yet).

## Browser acceptance suite: known failures (2026-10-19)

The two gates above record the browser specs as green. They were green when
written; they are **not green now**. Recorded on 2026-10-19 against the composed
build (`bun run build` first), no deploy and no paid call.

| Check | Classification | Receipt |
|---|---|---|
| `bun run test:browser --all` | FAILED (partial) | 45 packets — 19 PASS, 4 FAIL (P11, U01, U04, U05), 22 NOT APPLICABLE |
| the four failing packets' specs, re-run alone | FAILED (partial) | **6 failed, 26 passed, exit 1** — twice, with identical results, so not flakiness |

Six cases across four spec files, all **pre-existing and none caused by the
S06/S07 review work**: the client sources and the spec files are byte-identical
to the tree without those changes (0 bytes of diff across `tests/browser`,
`apps/app/src/client` and `apps/site`), and these specs stub `/api`, so no
server change can reach them.

- `discovery.spec.ts:409` — asserts `You can enter`; the v2 row renders `Can enter` (`hackathon-format.ts` calls that the dense-row "short chip").
- `discovery.spec.ts:467` and `:527` — assert `source local-seed · saved`; the row renders a `Saved` button instead.
- `discovery-journey.spec.ts:231` — asserts `· saved` inside `discovery-results`; the panel renders `Saved 1` in the segment count and a `Saved` button on the row.
- `theme-picker.spec.ts:166` — after four `ArrowRight` presses it expects focus to wrap to the first swatch, but `PALETTES` in `apps/app/src/client/theme.ts` has shipped **five** entries (`caddie`, `clearcut`, `onesecos`, `farmhand`, `kirocrew`) since the same commit that wrote the test, so the fifth press lands on `kirocrew`.
- `brief.spec.ts:265` — expects exactly one run POST from the mobile welcome panel's discovery action and observes none. Not yet root-caused.

Root cause of the Discover four: `eca3f5e9` (2026-10-15, "hackathon results card
and detail pane") rewrote `Results.tsx` (643 lines) and dropped the `· saved`
wording that `72b3753a` (2026-10-10) introduced together with the spec
expectations; the specs were not updated. The theme case was wrong from its own
commit (`0196f4fa`, 2026-10-15).

Why it went unnoticed: **CI does not run the browser suite.**
`.github/workflows/ci.yml` runs `bun install --frozen-lockfile`, `bun run build`,
`bun run typecheck`, `bun run verify:packet --all` and
`bun scripts/release-check.ts`. `test:browser` is not among them, and
`scripts/release-check.ts` has no browser check at all, so neither CI nor the
release gate can see this.

Status: **FAILED, recorded rather than fixed.** Fixing means deciding product
copy — whether the v2 list should show the long verdict (`You can enter`, as the
2026-10-10 design's `docs/design/2026-10-10-v2/assets/events.js` has it) or the
short chip — and whether the theme keyboard test should follow the palette
count. Both are owner calls, so they are surfaced here rather than silently
rewritten. Any fix must come with a CI step that runs `test:browser`, or the
next regression will hide in the same place.

### Resolved (2026-10-19, later the same day)

| Check | Classification | Receipt |
|---|---|---|
| `bun run test:browser -- --all` | LOCAL VERIFIED | 45 packets — **23 PASS, 0 FAIL**, 22 NOT APPLICABLE, against a fresh `bun run build` |

Every one of the six was a spec that no longer matched the shipped client; no
client code changed. The specs now assert what ships:

- **Discover (four cases).** The dense row's chip reads `Can enter` with the full verdict `You can enter` as its title; a saved row shows its `Saved` button; the fit reason sits in the row's collapsed "Why it fits" fold and cites `evidence: cl-team-1`; feed gaps read "Some sources failed"; the country line reads "Entry checked for United States"; a projects row is opened by its title button (it now also has "Continue with Caddie"). "No invented links" is now checked as: every outbound link on the page is a recorded candidate URL.
- **Theme keyboard case.** It walks `PALETTES` imported from `theme.ts` instead of a hand-copied list of four, so a new palette cannot leave it stale again.
- **`brief.spec.ts:265`, root-caused.** A spec bug, not a product bug. The catch-all stub `**/api/projects/**` was registered after the `**/api/projects/**/runs` stub, and Playwright runs the last-registered matching route first, so the run POST got `{}` from the catch-all and never reached the counter (the welcome action did send it; the draft showed "Not sent" because `{}` carries no run). The runs stub is now registered last and answers the POST with a real run. Side effect: the "opening tabs never POSTs a run" case in the same file now actually observes run POSTs; before, it could never see one.

**Product question, decided by the owner (2026-10-19): show them again.** Since
the 2026-10-15 card, the Discover row's "Why it fits" fold had listed
**supported** claims only, so an *unknown* fit claim's recorded assumption was
shown nowhere in the list (the 2026-10-10 card showed every claim). The fold now
lists the reasons it fits, then "Not confirmed yet": each unconfirmed
requirement in plain words ("no rule on record yet", "the sources disagree",
"not met") with the assumption Caddie recorded. When nothing is confirmed, the
fold is titled "Not confirmed yet" instead of "Why it fits".
`discovery.spec.ts` asserts the fixture's "Open to international entrants · no
rule on record yet" and its assumption.

**CI now runs the browser suite.** `.github/workflows/ci.yml` gained
`bunx playwright install --with-deps chromium` and `bun run test:browser -- --all`
after `verify:packet --all`. The file was also re-indented with spaces: it was
tab-indented, which YAML does not allow, so as committed GitHub could not have
parsed it at all. That fix has not run on GitHub (there is no remote yet).

## Integrated gate (2026-10-20): live fixes + Track 3

Recorded on `main` after merging `fix/live-test-findings` (`e70e534`) and
`feat/track3-flutter` (`2d176fa`), keeping the two earlier chat-limit and
idle-project fixes. This gate ran before any deploy; the owner then authorized
the production deploy recorded above. The only paid run in the gate itself is
the phase 9.2 sandbox probe the owner approved. Per-defect reproductions live in
`docs/evidence/2026-10-20-kiro-integration/README.md`.

| Check | Classification | Receipt |
|---|---|---|
| `bun run typecheck`, `bun run build` | LOCAL VERIFIED | exit 0 both; composition 0 collisions |
| `bun run test` | LOCAL VERIFIED | **1,696 pass, 0 fail, 127 files** |
| `bun run verify:packet --all` | LOCAL VERIFIED | 47 packets — **43 PASS, 0 FAIL**, 4 NOT APPLICABLE |
| `bun run test:browser -- --all` | LOCAL VERIFIED | 47 packets — **25 PASS, 0 FAIL**, 22 NOT APPLICABLE |
| whole browser suite (`bunx playwright test`) | LOCAL VERIFIED | **275 passed, 1 skipped** (evidence-only screenshot spec) |
| `bun scripts/license-audit.ts` | LOCAL VERIFIED | 25 production dependencies, 0 flagged, 0 unresolved, CLEAN |
| React + Flutter scaffold lock checks | LOCAL VERIFIED | exit 0 both (Flutter lockfiles sha256 `9e47e703…97bc818`) |
| `bun scripts/release-check.ts` | LOCAL VERIFIED | **49 PASS, 0 FAIL, 1 BLOCKED, 4 PROVISIONED** |
| fresh local D1 | LOCAL VERIFIED | all 39 migrations applied in numeric order |
| phase 9.2 Flutter sandbox probe | LIVE VERIFIED | real release APK, 14,884,096 bytes, sha256 `5631cde4441037cb8bffd194ed0e78895b9139d87fbf7bb0373b7754010c53f4`, read back and disposed |
| P15d live Flutter journey (debug APK → emulator) | LIVE VERIFIED | real `flutter build apk --debug` in a temp scaffold, installed, launched and captured on an arm64 emulator; receipt `lr_602f8532232b3019` at `9af594f396d3`, 2 tests passed |

Two defects were found by this gate and fixed rather than recorded: memory
offers were ordered by a random id after `createdAt`, so two offers written in
the same millisecond came back in either order (now `rowid`, with a
deterministic regression), and the P00 routing spec's preview-port handling
used an `lsof` spelling that is a usage error on macOS lsof 4.91 — so its
"reap a stale listener" step never reaped anything and SIGKILL'd whatever it
found (now it walks to the first free port and never kills a listener it does
not own). A third, in the live Flutter journey, is recorded with the P15d
receipt above: a debug build could not install over the differently signed
release APK already on the emulator.

## Stack availability (frozen scope, feature-ledger)

| Stack | ID | Status |
|---|---|---|
| React/Vite/TanStack Router+Query + Bun/Hono | `react-hono` | verified (P09 live gate) |
| TanStack Start | `tanstack-start` | template + live journey green; stack flips to verified at the sandbox preview-auth gate |
| Laravel + React/Inertia | `laravel-inertia` | template real; live journey BLOCKED (authorization) |
| FastAPI + React | `fastapi-react` | template real; live journey BLOCKED (authorization) |
| Flutter + supported backend | `flutter` | template real; live journey BLOCKED (authorization + emulator) |

No stack claims ready beyond its own gate; every recipe stays
`availability: "unverified"` until its live run.

## Remaining owner-gated checklist (exact)

In dependency order; provider-side steps in
`docs/setup/provider-checklist.md`:

1. **Deployment authorization** — concrete owner approval against a specific
   release SHA. Unblocks the deploy; nothing else does. (release-check
   reports this BLOCKED forever until a human decides.)
2. **Production auth inputs** — `BETTER_AUTH_URL` (canonical origin),
   production OAuth redirect URIs on both providers, `INVITE_ALLOWLIST`
   (docs/setup/auth.md). Unblocks hosted sign-in and the P01 live row above
   moving to machine-rerunnable.
3. **`CADDIE_RELEASE_URL`** — set only after (1); runs the P17 hosted smoke
   (landing 200, SPA shell, auth probe, API surface) against the deployed
   origin, tied to the release SHA.
4. **Stack live runs (P15b/c/d)** — with `CADDIE_LIVE_AUTHORIZED=1`:
   laravel needs composer/php/npm, fastapi needs uv/python, flutter needs the
   Android SDK plus a booted emulator (or the contree sandbox image frozen
   with the same capabilities; each recipe's `imageDigest` names the frozen
   image when the sandbox path is taken).
5. **P04 live spec + probes** — author `tests/live/sandbox.spec.ts` during
   the authorized probe and reconcile the adapter's REST spellings
   (docs/setup/sandbox.md BLOCKED list).
6. **GitHub App** — provisioning deferred (owner-inputs.md) until the P08
   live window; docs/setup/github-app.md holds the exact settings.
7. **Resend production domain + sender** — dev sending is LIVE VERIFIED to
   the owner's address; production sends need the verified domain
   (owner-inputs.md, P12).
8. **R2 artifact store + isolated preview origin** — proposed production
   wiring, not implemented (docs/setup/previews.md); P07 live spec waits on
   the hostname.
9. **Rollback package** — previous release SHA + append-only D1/DO migration
   compatibility rehearsed on staging; never delete user data to undo.
10. **Contest entry (if entering)** — check the current official contest
    rules and prior-work disclosure; a fresh repo establishes nothing by
    itself.
