# Isolated preview storage implementation plan

**Goal:** generated apps can save records in real browser storage without access
to Caddie's session, and browser failures cannot silently pass final checks.

**Architecture:** serve each actor/project on a stable, separate preview origin.
Authenticated launch mints a short-lived signed document capability; every load
rechecks membership and output identity. Preview hosts serve only preview
documents, never Caddie APIs/assets. Keep the scoped parent API relay. Use native
IndexedDB/localStorage on isolated origins; retain opaque previews for legacy
import surfaces until they have an equivalent launch authority.

**Tech stack:** Hono/Worker, existing D1 artifact storage, HMAC capability,
React iframe, existing private Chromium check service.

## Approved design and constraints

The user chose isolated origins as the long-term solution and authorized this
implementation. Local development uses actor/project subdomains of `.localhost`
on the existing server. Hosted use requires an explicitly configured separate
preview base URL/domain routed to this Worker; never infer it in production.
No deploy, database reset or destructive generated-app changes are included.
Preserve Flutter WIP and active build checkpoints. Code changes may reload the
Worker; minimize integration changes and do not repeatedly restart the server.

## Packet 1: scoped preview host and launch

- Add `server/isolated-preview.ts`: derive stable actor/project origin; sign and
  verify bounded, expiring claims; reject same-origin configuration, host/token
  mismatch, changed membership and cross-project outputs.
- Register a preview-host firewall before product APIs in `src/app.ts`.
- Add authenticated launch to `routes/build-workflow.ts`, using existing
  `requireProjectScope` and `readBuildOutput` authority.
- Serve the exact output through `shared/preview-frame.ts` with native storage;
  keep CSP network restrictions and the app-only parent relay.
- Tests: tampering, expiry, origin isolation, API refusal, output ownership.

## Packet 2: user preview

- `InteractivePreview.tsx`: use launch descriptors for workflow web outputs;
  permit `allow-same-origin` only for the validated separate origin. Match the
  exact message source, origin and nonce. Keep Flutter/import fallback isolated.
- Native records persist across iframe/page reloads, separated by actor/project.
- Test reset must clear this preview origin's storage, never Caddie's origin.

## Packet 3: runtime verification

- Run native-storage and startup/error checks in real Chromium before publishing
  a ready output; bind receipts to the checked image. Reuse the private runner.
- Update acceptance browser frames to match real isolated-origin semantics.
- Check actual IndexedDB read/write/reload, browser errors, and caught fatal
  records/loading errors; failed checks return to repair and unavailable checks
  are reported honestly. Unit tests remain separate evidence.

## Packet 4: verify and document

- `bun run typecheck`; affected unit/router/browser tests; `bun run build`.
- Open the existing Livestock output: records load; create a batch/day; reload
  and confirm persistence; verify project/actor isolation and denied API access.
- Recheck Farmhand's state; do not rerun paid builds or reset records to fabricate
  a successful result. Document hosted DNS/config prerequisites separately from
  locally verified behavior.

## Hosted prerequisites (not yet live)

Locally, preview origins are `p-<hash>.preview.localhost` on the dev server, so
no setup is needed. Hosted use is a separate, unverified step:

- `PREVIEW_BASE_URL` must be an https origin on a domain of its own — never
  Caddie's host and never a subdomain of it, so Caddie's session cookies can
  never reach a preview. The app refuses an overlapping address at runtime and
  `scripts/deploy-preflight.ts` fails it before deploy.
  `p-<hash>.<preview host>` must reach the same Worker through a wildcard
  route (`*.previews.example.net/*` with `zone_name`; `custom_domain` takes no
  wildcard) with a certificate covering that wildcard. Universal SSL covers
  only a first-level wildcard, so a dedicated preview zone is the simplest
  choice; a subdomain of another zone needs Advanced Certificate Manager.
- `PREVIEW_SIGNING_SECRET` (32+ characters, its own value) is required outside
  localhost; the local fallback derives a key from `BETTER_AUTH_SECRET`.
  Without both values every web build pauses at "Caddie could not prepare the
  isolated preview" instead of being checked or marked ready.
- Procedure: `docs/runbooks/production-deploy.md`, "Once", step 5; values
  documented in `docs/setup/owner-inputs.md` and `apps/app/.prod.vars.example`.

## Local verification (2026-10-27)

- `bun run typecheck`: pass.
- `bun test tests/isolated-preview.test.ts`: pass (native storage per
  actor/project, expiry and tamper refusal, host firewall, hosted-key
  requirement, reset scope).
- Preview browser checks (`tests/browser/interactive-preview.spec.ts`): pass,
  including the reset flow.
- The full suite: **2,797 pass, 0 fail across 245 files** on the final tree.
  The earlier 7 failures were one budget bug in this file — the live smoke runs
  six probes, five of which wait out the 6s startup window, but the test kept
  a 25s timeout. It timed out under machine load and the closed browser took
  the rest of the file down with it. The timeout is now 60s with the probe
  count written beside it; the file passes end to end in 84s.
- `bun run build`: pass (dev-shaped bundle; nothing deployed).
- Livestock's existing output was opened on its isolated origin in Chromium: a
  batch and a daily observation were saved (one while offline), the preview
  reloaded, and the count, feed, deaths and cost persisted.
- Hosted DNS/routes above remain DOCUMENTATION ONLY; nothing was deployed.
