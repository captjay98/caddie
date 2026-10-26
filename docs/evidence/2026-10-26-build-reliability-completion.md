# Build reliability continuation — implementation and local acceptance

Authority: [continuation handover](../plans/2026-10-26-build-reliability-continuation-handover.md), R1–R4; original B00a/B02a/B04–B08. This record supersedes older claims that the service interfaces alone completed independent acceptance or state capture.

## Implementation

- **R1:** persisted Flue specialist deadlines propagate through the real delegate runtime into model/command cancellation. Safe timeouts consume the same admission's bounded repair ladder. Uncertain writes are reconciled by their existing operation keys before another writer; unconfirmed effects remain blocked. Host writes and final publication fence admission, plan, design, approval and workflow phase. Candidate publication requires the exact independently reviewed revision and unchanged dependencies. Preparation/review calls retain their original bounded payer; unknown usage is not free.
- **R2:** `caddie-checks` is a versioned declarative journey manifest, mapped exactly to approved criteria and reviewed with the design before publication. It is stored outside the builder's writable workspace. Chromium drives accessible controls in the same opaque iframe/bridge as the product. The backend runs in the existing Worker Loader with private PreviewDatabase namespaces. Authentication uses two real generated-app users and a private code inbox. Tests can clear browser cache, restart the server isolate, disconnect/reconnect, and inject retry/loading failures. An at-most-once claim prevents concurrent re-execution; receipts bind every criterion to plan/design/admission/image.
- **R3:** approved screen/state titles map to actual navigation steps. Phone (390×844) and desktop (1440×900) captures contain real PNG bytes and hashes; comparisons detect missing navigation, overflow, browser errors and appearance drift. No first-four truncation or relabelled home screenshots. The private browser service implements draft capture, independent checks, state navigation and comparison. Pixel drift is appearance evidence, separate from semantic visual review and functional acceptance.
- **R4:** local gates, checkpoint, preserved-state Farmhand retry and isolated fresh-run preparation are recorded below as they complete. This wave is not deployed.

The protected browser action vocabulary is deliberately small:

```json
[
  {"kind":"actor","user":"a"},
  {"kind":"open","path":"/notes"},
  {"kind":"fill","label":"Note","value":"{{marker}}"},
  {"kind":"click","name":"Save note"},
  {"kind":"restart"},
  {"kind":"expect","text":"{{marker}}","visible":true}
]
```

A restarted check must observe a real app write and a fresh data read after restart. New-policy feature completion requires exact independent criterion coverage; extra builder-written passing tests cannot replace it.

## Real local runtime evidence

`tests/acceptance-browser.integration.test.ts`: **6 passed**, real Chromium + real Workerd/Worker Loader + private SQLite Durable Objects. This is **LOCAL VERIFIED**, not paid-model or production proof.

- Correct saving survives a fresh server isolate and cleared browser cache.
- Fake saving, memory-only persistence, cross-user leakage, omitted behavior and dropped offline queues fail for their actual defects.
- Correct offline/reconnect, real generated-app sign-in, error/retry and loading journeys pass.
- Distinct navigated screens produce distinct PNGs; horizontal overflow is caught.
- The authenticated private service drives the production unpublished runtime route; Stop invalidates the capability immediately. An unapproved callback origin is rejected.

`tests/task-deadlines-runtime.test.ts`: real Flue delegate interception carries the persisted deadline and aborts downstream work. `task-recovery`, `acceptance-candidate`, `independent-acceptance` and existing workflow tests cover recovery, concurrency, stale identity, Stop, revoked approval/membership, expiry and quota boundaries.

During verification, the fresh Worker launch caught an import placed before Flue's mandatory `"use agent"` directive. The directive was restored and a regression test added. A compiled asset build by itself was insufficient; real Worker startup remains part of acceptance.

## Current gates

- Root/app typecheck: LOCAL VERIFIED, exit 0.
- `bun run verify:packet REL26`: LOCAL VERIFIED, all 27 mapped checks passed.
- Actual acceptance executor: LOCAL VERIFIED, 6 passed / 0 failed.
- `bun run test`: LOCAL VERIFIED, **2,783 passed / 0 failed**, 244 files, exit 0 (204.03 seconds).
- Additional final image-fence/runtime/presentation checks: LOCAL VERIFIED, **106 passed / 0 failed**, exit 0.
- `bun run build`: LOCAL VERIFIED, exit 0; composed bundle **8dbd0c25afa9**, 104 SPA assets + 99 landing assets, zero collisions.
- Fresh-bundle desktop/mobile browser regressions: LOCAL VERIFIED, **117 passed / 1 pre-existing skipped / 0 failed**, exit 0 (1.7 minutes). Covers focused chat, looks, workflow, design/build team screens, responsiveness and actual visual capture.
- Local Vite now prebundles the dynamically discovered Worker dependencies before entrypoint inspection; the dev server starts without the missing optimized-chunk loop. Browser fixtures honor the selected base URL and inspect optional design notes through the actual review controls.
- Separate fresh local DB: LOCAL VERIFIED, migrations through **0055**, `pragma integrity_check` = `ok`, zero projects, zero paid calls, existing DB retained. Persistence: `apps/app/.wrangler/reliability-fresh-1793010893`.
- Pre-0054 consistent SQLite backup: `/var/folders/dr/3jwr3dxn0j7g1tjd05h2wjhm0000gn/T/caddie-before-0054-dn7eht_0`.
- Controlled Farmhand retry: pending final results.

Temporary logs: `/tmp/caddie-rel26-final.log`, `/tmp/caddie-acceptance-real.log`, `/tmp/caddie-task-runtime.log`, `/tmp/caddie-reliability-complete-suite.log`, `/tmp/caddie-reliability-complete-browser.log`, `/tmp/caddie-reliability-complete-build.log`.

## Rollout and limits

- Migrations 0049–0055 are append-only. Do not renumber migrations already applied locally. No Durable Object class was added: AcceptancePlatform is a WorkerEntrypoint; existing PreviewDatabase isolation is reused.
- `CADDIE_REPAIR_POLICY=repair-v1` stamps a new admission/explicit Retry. Model switches never reset counters, spending or time.
- `CADDIE_QUALITY_POLICY=quality-v1` applies to newly admitted projects. It does not rewrite historical Farmhand approvals. Enable it only with the private browser service configured.
- The local browser service uses a private ignored JSON config and loopback binding. Its token is never sent into generated HTML or placed in URLs. Callback origins are explicitly allowlisted. Every candidate API request rechecks workflow/admission/design/approval/membership, a 10-minute lease and a 512-request quota. Candidate work is never published as a ready output.
- Browser checks do **not** fake AI responses or email delivery. Those services return unavailable in the independent local runtime. A criterion requiring a real external result cannot receive a pass from canned content; live integration proof requires the appropriately authorized integration environment.
- Draft visual review uses a different vision-capable model from its actual author. Pixel comparison is intentionally conservative and can request repair for intentional layout differences; changed scope/design must return through review.
- Formal paid comparisons remain authorization-gated. The 12-task benchmark and estimator are prepared locally; no comparative completion score is claimed.
- Rollback: disable new policy admission, retain all receipts and append-only migrations, and restore the prior application commit. Never erase approvals, checkpoints or the preserved DB to make a retry pass.
