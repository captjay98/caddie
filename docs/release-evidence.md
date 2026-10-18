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
| P04 | contree sandbox session + remote exec | LIVE VERIFIED | contree CLI probe with real credentials (ledger `P04-live`); the REST adapter's assumed spellings are a tracked correction |
| P12 | Real outbound email (Resend) | LIVE VERIFIED | exactly one send to the owner's own address; provider receipt id `01a11346-68df-7538-8dc7-ee1b593ad5ef` |
| P01 | OAuth sign-in round trips | LIVE VERIFIED (user-performed) | owner executed real Google + GitHub sign-in against the dev origin; the machine-rerunnable probes stay gated (release-check live gates) |
| P15a | TanStack Start template flow | LIVE VERIFIED | `tests/live/stacks/tanstack-start.spec.ts` — real `bun install` / `bun test src/` / `bun run build` in a temp dir, production server answers 200 with the SSR markers |
| P15b | Laravel + Inertia journey | BLOCKED | `tests/live/stacks/laravel-inertia.spec.ts` gates honestly: needs `CADDIE_LIVE_AUTHORIZED=1` (composer install is a network effect) + composer/php/npm present |
| P15c | FastAPI + React journey | BLOCKED | `tests/live/stacks/fastapi-react.spec.ts`: needs `CADDIE_LIVE_AUTHORIZED=1` + uv/python/bun present |
| P15d | Flutter journey (APK + emulator) | BLOCKED | `tests/live/stacks/flutter.spec.ts`: needs `CADDIE_LIVE_AUTHORIZED=1` + flutter + adb + a booted emulator; acceptance bar is a real APK launch + interaction capture, never a web screenshot |
| P17 | Hosted acceptance smoke | BLOCKED | `tests/live/release.spec.ts`: needs `CADDIE_LIVE_AUTHORIZED=1` + `CADDIE_RELEASE_URL` (a deployed base URL). The LOCAL half runs green above |

Intentionally-absent live specs stay honest holes, not fake passes:
`tests/live/github.spec.ts` (P08) is authored only against a real registered
GitHub App (owner-gated; docs/setup/github-app.md), so it stays out of the P08
live map rather than promising a spec that cannot run. The two earlier holes
are closed: `tests/live/sandbox.spec.ts` (P04) and
`tests/live/preview.spec.ts` (P07) now exist and are mapped.

## Verification net (S01, 2026-10-18)

The 2026-10-06 gate above is kept as a dated receipt; this is the net that
keeps it honest. Recorded on `feat/publish-on-cloudflare` at `8333c185` + S01,
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
