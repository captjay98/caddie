# Model role comparison — 27 October 2026

**LIVE VERIFIED:** bounded synthetic Nebius calls on the configured account, not a fresh end-to-end Caddie/Farmhand run. The user authorized model testing. No product route, user data, approval, app build, or deployment was changed. Exact raw answers, checks, token receipts, timestamps and hashes are in `results.json`; image files and hashes are in `screenshots.json`; production-shaped `json_object` probes are in `production-format-probes.json`. Prior independent probe: `../2026-10-25-model-validation/results.json`.

**Cost and scope:** 32 physical requests total (30 main, 2 supplemental), no automatic retries; main conservative reservation ceiling $0.766832, supplemental maximum 2 × 8,192 output tokens plus small inputs, total under the $3 stated ceiling. Estimated catalog cost from known responses, including pi adapter tool-round-trip receipts, is about $0.0438 before any cache-rate adjustment; two failed/timed-out calls returned no usage, so this is not a final invoice or a complete spend figure. Any screenshots and prompts sent were synthetic. Capture/quality/D1 gates, live generated-app journeys and complete build were not exercised.

## Results

| Case | DeepSeek V4.1 Flash 1017 | MiniMax M3.1 Flash | GLM-5.3-Flash |
|---|---|---|---|
| pi-ai tool call + host receipt + follow-up | PASS 2.5s | PASS 1.7s | PASS 6.7s |
| deadline / timezone / strict JSON | PASS 2.7s | PASS 1.6s | PASS 6.9s |
| small kobo/dedup/offline repair, executed in host checks | PASS 31.5s | PASS 2.9s | PASS 116.5s |
| user-plan authoring, semantic review | PASS with caveat | FAIL: uses exported backup/send instead of requested sync | PASS with caveat; raw grader falsely failed |
| identify bad-plan blockers | PASS | PASS | UNAVAILABLE: timeout |
| accept sound plan control | PASS | UNAVAILABLE: connection closed | PASS |
| compare good / bad / blank screenshots | 3/3 PASS | 3/3 PASS | 3/3 PASS |
| supplemental broken screenshots using production `json_object` shape and structured blocking findings | PASS | PASS | not tested in supplemental |

The times are single measured calls, not latency distributions; 180-second `AbortSignal.timeout` surfaced as a timeout after a recorded 349.8s by the script's wall clock on one call. Investigate with a monotonic clock and underlying adapter before claiming a reliable deadline; keep host-side deadline and late-result fencing. MiniMax's negative-control connection failure is an unknown provider/network failure, not a proven quality failure. Raw response `estimatedUsd` omits timed-out calls and several pi-round-trip costs; the accounting above includes the successful pi receipt costs but cannot infer missing usage.

**Important correction to automated scoring:** the plan checker searches for certain literal terms only in individual JSON arrays. GLM's answer says `mortalities`, `works with no internet`, and `Turn internet back on` and explicitly describes automatic sync and no duplicates; the checker incorrectly marks `includesRecords`, `includesOffline`, and `checksReconnect` false. Human inspection finds these requirements present, so don't characterize this as a failed GLM plan. MiniMax's response says offline in its summary/limitations, so its `includesOffline` flag is also a false negative, but its proposed reconnect behavior is genuinely an exported backup file sent by email/WhatsApp, not the requested app sync. DeepSeek passes the literal check but proposes a manual `Send saved records` tap and optional extra functions; it should explicitly label these as assumptions and not be called proof of autonomous sync or a universally better first plan. One synthetic prompt per author cannot establish which produces the strongest first version across users.

Supplemental request-shape probes use `response_format: json_object` and structured `severity/criterion/detail` findings matching the production transport shape, but a shortened system prompt and no production D1 reservation/fencing. They establish compatibility with that request shape on synthetic screenshots only—not a LIVE VERIFIED end-to-end quality gate. In an earlier suite, DeepSeek and full GLM-5.3 passed bad-plan and sound-plan controls; DeepSeek and Super VL passed good/broken/blank screenshot cases, while Super VL missed one approval issue in a bad plan. Current one-call results do not prove reliability under load, specific same-image grounding in all app designs, actual screenshot capture/coverage, role fallback, sandbox/adapter behavior, or complete application quality.

## Routing decision for implementation — owner direction

The initial recommendation was to retain GLM-5.3-Flash as both plan/design author and DeepSeek as reviewer. After seeing the latency samples, the owner selected a different target. **This is a planned change, not current runtime configuration:**

- **Plan author:** DeepSeek V4.1 Flash 1017. **Plan reviewer:** full GLM-5.3 (text only), with a separately verified different-family fallback and no self-review.
- **Design/look author:** MiniMax M3.1 Flash. **Visual reviewer:** DeepSeek V4.1 Flash 1017 with actual screenshots; Super VL is the independently eligible fallback. GLM-5.3-Flash is left out of this flow for now; full GLM-5.3 is not vision-capable in the checked Nebius listing. DeepSeek can author the plan and review MiniMax-authored design because independence applies to each artifact. If DeepSeek authors a fallback design, it cannot review that design.
- **Build/repair:** retain Super VL → DeepSeek 1017 → GLM-5.3. Other helper and generated-app defaults remain unchanged.

This honors the owner's intended division while keeping the evidence boundaries visible: MiniMax was **not** tested as a real multi-screen design author, and DeepSeek visual review was not tested through the production D1/capture/publish gate. GLM-5.3-Flash had a severe one-off timeout in a text review and is not selected for this flow; design-review latency, cancellation and fallback are still release gates for the selected routes. GLM-5.3's earlier plan-review controls were synthetic; validate it with current provider request shape and real workflow. Freeze per-run route/pricing, preserve existing historical bindings, enforce no-self-review, and test actual specialist-to-model routing. Further task-level evaluation remains necessary before claiming reliability or speed; preserve NVIDIA use where contest rules require it.

## Farmhand source trace on the exact local preview

Read-only inspection of version `08b683cdf6c93fbd8541d88a39e6ed2aaf79fee1`, associated with `out_02c537b50b9e95f636b28c27b10b73d9`:

- `src/App.tsx:811` explicitly renders `<InventoryScreen ... onAddItem={() => setTab("home")} />`, consistent with the two UI failures. Medication's no-stock branch at `src/App.tsx:271` uses `openForm`, not an explicit inventory navigation; verify that route and create-stock flow on a repaired version. An acceptance test must click the control and verify stock persists and medication deducts it; passing generator tests alone missed it.
- `src/server.ts:976–986` uses a breed/age anchor when no feed is recorded and sets `basis = "estimated"`; `src/feed-runway.tsx:175–183` presents the number as actual feed consumed without displaying that basis. The observed 13 g can therefore be an estimate; don't label it a fabricated random value or a recorded measurement. Require source/assumption to be visible and test zero-input conditions.
- `src/triage.tsx:53–56, 488, 523–531` hard-codes clinic names, distances, phone numbers and `Pen 2` and labels the contact `Nearest vet`. `src/server.ts:461–475` sends `JSON.stringify({ photo_url, symptoms })` as text to `CADDIE.ai`, not image content. Require explicit sample-contact labeling and no unsupported location/vision claim; verify actual image-byte path before enabling image analysis.
- No code or live farm data was changed during this source trace. Findings are LOCAL VERIFIED for the exact version and previous synthetic UI interaction, not a claim about another version or deployed production.

**Local verification:** the probe's synthetic repair checker self-test passed all five checks. `bun test tests/artifact-quality.test.ts tests/artifact-quality-workflow.test.ts tests/project-status.test.ts tests/deadline-time.test.ts tests/preview-runtime.test.ts` passed 40 tests; those local tests prove their covered boundaries, not live quality or a complete Farmhand journey. The earlier real app observations and this read-only source trace are separate from the synthetic model-provider calibration.
