# Verified handover checkpoint — 2026-10-25

**Decision:** LOCAL VERIFIED checkpoint suitable for the next implementation agent. No deployment or push performed. The new build-reliability execution packets are still planned; these commits preserve the earlier UI, model-accounting and design work plus its verification.

Baseline before checkpointing: `95fb269d1cf2ab328b78de448c3b852a9cb5bd81` on `main`. The existing checkout was preserved. Related changes were staged by explicit filenames; no reset/stash or blanket staging was used.

## Implementation and test commits

| Commit | Title | Files |
|---|---|---:|
| `3e75c71` | feat(models): record per-call usage and task routing | 18 |
| `06cee26` | feat(design): validate previews and preserve build checkpoints | 21 |
| `38cb469` | feat(app): stabilize chat history and refine project reviews | 70 |
| `cf4fbe1` | test: register UX and notification verification gates | 2 |

The final documentation commit also contains this report, the reliability plan/handover, supporting research, catalog snapshot, the previously authorized model-validation evidence and its probe script. Obtain its hash with `git log -1` after handover; a commit cannot embed its own final hash.

## Fresh verification

| Command / gate | Result | Classification |
|---|---|---|
| `bun run typecheck` | Root and app typechecks: exit 0 | LOCAL VERIFIED |
| `bun run build` | Composed Astro/Vite/Worker assets: exit 0; no asset collisions; build stamp `390008125626` | LOCAL VERIFIED |
| `bun run test` | 2,651 passed, 0 failed across 219 files; exit 0 | LOCAL VERIFIED; external/provider fixture boundaries remain SIMULATED |
| `bun run verify:packet UX24` | All 27 checks passed; exit 0 | LOCAL VERIFIED |
| Affected Playwright suite, fresh isolated preview on port 4192 | 234 passed, 1 optional screenshot-export test skipped; exit 0 | LOCAL VERIFIED browser/runtime; stubbed authenticated API states are SIMULATED |
| `bun scripts/probe-reliability-models.ts --self-test` | Five local probe assertions true; no inference | LOCAL VERIFIED |
| `git diff --check` / staged whitespace checks | Exit 0 | LOCAL VERIFIED |

The skipped test is `looks-picker.spec.ts`'s optional `captures evidence screenshots`, which requires `KIROCREW_SCRATCH`. It is not a skipped functional acceptance test. Separate phone/desktop visual-fidelity captures and overflow tests passed.

The affected browser suite comprised `brief`, `conversation`, `focused-project-chat`, `looks-picker`, `project-settings`, `project-v2`, `project-workflow`, `projects-v2`, `workspace`, `chat-responsiveness` and `visual-fidelity` specs under `tests/browser/`. Both `CADDIE_BROWSER_BASE` and `CADDIE_TEST_BASE_URL` pointed at `http://127.0.0.1:4192`. The temporary Playwright config extended the repository config with a non-reused preview on that port and two workers. The repository browser fixtures now honor the same override instead of competing for a hardcoded port.

Full local outputs for this session (not portable release evidence): `/tmp/caddie-checkpoint-tests-final.log`, `/tmp/caddie-checkpoint-browser-final.log`, `/tmp/caddie-checkpoint-build.log`, `/tmp/caddie-checkpoint-ux24.log`, `/tmp/caddie-checkpoint-dialog.log`.

## Issues corrected during checkpoint verification

- Real regression: the custom change-request overlay was outside the native Build records modal and lost input to its focus trap. Reused `ProjectDialog` for the change request; the browser test now asserts entered text is retained and the action becomes enabled before navigating to chat. Both previously failing dialog/layout cases passed, followed by the full affected browser suite.
- Updated the saved-design theme source guard to follow the selected historical/current design revision, preserving the theme assertion rather than deleting it.
- Corrected the generated-app AI test to respect its service output ceiling even when the underlying model route allows a larger completion. Runtime service limits were not raised to make the test pass.
- Removed duplicate UX packet test registrations and kept manifest formatting consistent.

## Limits and next action

The composed build emitted the existing large-client-chunk warning; successful compilation is not proof of whole-app performance. Current UI-state tests do not establish live production OAuth, provider, notification or generated-app behavior. No new paid calls, production migration, remote publishing or deployment ran during checkpointing.

The prior model preflight remains separately documented as LIVE VERIFIED limited provider calibration: 23 requests, 19/20 scored cases passed, including a recorded Super VL plan-review miss. It is not a full durable-build benchmark.

Start the next agent at `docs/plans/2026-10-25-build-reliability-handover.md`, then B00/B01. Recheck HEAD/status and do not assume another session has left the checkout unchanged. Deploy only after a separate release decision with the required evidence and authorization.
