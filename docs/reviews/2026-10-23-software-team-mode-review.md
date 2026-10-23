# Software-team mode implementation review — 2026-10-23

Verdict: **REQUEST CHANGES**. Reviewed revision `c8d393cb5ad85efea7ccacfd68d2b48b1410bf3c` against the software-team-mode plan, revision 5. This is an implementation review, not live campaign acceptance. No application code, existing tests, database, switches, running build, or deployment was changed. This report is the only repository addition.

The earlier plan concerns have received substantial implementation work. However, the cases below break completion, isolation evidence, and spending guarantees. Fix findings 1–7 before relying on a paid comparison campaign; keep uploads and published jobs unavailable until their respective findings are resolved.

## Findings

### 1. P1 — Parallel joins can start from a stale app and lose a joined sibling

Location: `apps/app/src/server/module-join.ts:221–230`; integration lock acquired later in `server/integration.ts:515`.

The foundation image is read **before** the integration lock, then captured by the join-copy closure:

```ts
const newestAtStart = (await getModule(db, projectId, buildSeq, foundation))?.checkpointRef;
let copyImage = newestAtStart;
```

Reproduction: pause Tasks just after it reads the foundation; let Feed complete its entire join; resume Tasks. Tasks acquires the now-free lock but opens the old foundation. In the deterministic image-store probe both parts finish with `status: "merged"`, yet the final image contains Tasks and no Feed files. Real comprehensive checks may instead reject Tasks for the missing Feed routes, still causing a valid part to fail spuriously.

Evidence: **SIMULATED** committed-image store and check runner, real migrated SQLite storage. `bun test /tmp/caddie-review-join-race.test.ts`: expected Feed file present; received false. Existing join/boundary/big-build tests all pass.

Fix: initialize/rebase the integration copy from the latest foundation image **after acquiring the lock**, on every acquisition. Verify ownership before committing; add this exact interleaving to the join suite.

### 2. P1 — Privacy checks miss an unauthorized update

Location: `apps/app/src/server/contract-files.ts:1095–1103`, also `:1182–1186` for a second team's update.

B submits the same payload that A already successfully saved:

```ts
body: JSON.stringify(bodyFor(s, s.updateBody, h))
// Then only compares the record before and after B's call.
```

An unscoped UPDATE writes the same value, so the privacy assertion passes. Removed only the `ownerId` predicate from the otherwise-correct Notes UPDATE handler; all four protected phases still passed (10 tests, zero failures). This permits a real authorization defect to receive privacy receipts used by publish safety.

Evidence: **LOCAL VERIFIED**, generated contract checks against the materialized starter and real SQLite. `bun /tmp/caddie-contract-review.ts`; root repeat output `/tmp/caddie-team-review-privacy.log`.

Fix: give B a distinct adversarial value and require an authorization refusal plus preservation of A's full record. Repeat for B acting through B's own team. Keep the single-route mutation as a regression fixture.

### 3. P1 — Module route registration shadows later modules with 501 handlers

Location: `apps/app/src/server/contract-files.ts:384–389`.

Every `implement(app, handlers)` call registers every architecture route, including missing handlers:

```ts
for (const route of ROUTES) {
  const handler = handlers[route.id];
  // Registers this route even when absent from this module's handlers.
  if (!handler) return c.json({ error: "This route is not built yet." }, 501);
}
```

When separate module mounts each call `implement` with their own handlers, the first mount's 501 shadows later modules. Actual generated runtime and Hono: Notes mounted first returns 200; Tasks mounted second returns 501 despite having a handler.

Evidence: **LOCAL VERIFIED**. `bun /tmp/caddie-mount-review.ts`.

Fix: collect module handlers and register the full route table once, or explicitly scope registration to each module. Preserve a separate check for missing implementations. Test two independently mounted modules.

### 4. P1 — File-backed contract DB.batch never executes its statements

Location: `apps/app/src/server/contract-files.ts:143`; compare the correct starter wrapper in `stacks/react-hono/server-files.ts:350–352`.

```ts
statements.map(s => s as unknown as Statement) // Returns objects; executes nothing.
```

The generated file-backed wrapper returns statement objects from its transaction. A batch INSERT followed by SELECT yields no rows. Valid generated apps using D1 transactional batches therefore fail protected persistence checks even though production executes those writes.

Evidence: **LOCAL VERIFIED**, actual generated SQLite wrapper. `bun /private/tmp/caddie-review-contract-99PnHA/batch-probe.ts` returned `Statement[]`, then `results: []`.

Fix: share the shipped wrapper with a configurable database filename, or execute the statements synchronously inside the SQLite transaction. Verify results, rollback and error parity, not just independent `.run()` calls.

### 5. P1 — Billable failed/aborted model turns are refunded

Location: `apps/app/src/server/spend-instrument.ts:260–264`.

```ts
if (event.isError) void release(db, turnId);
else void settle(db, turnId, settleMicrosFromCost(event.response.usage?.cost.total));
```

Flue's installed event documentation defines `isError` for aborted/error responses, not proof that no paid work occurred. A synthetic error turn with known cost 0.05 releases its 100,000-micro reservation and records no settled charge. Repeated paid errors can evade the build limit.

Evidence: **SIMULATED** provider completion event, real local reservation storage. No provider call was made.

Fix: settle known usage regardless of success. Release only when proven not sent/not billed; retain liability for an issued request with uncertain usage.

```ts
if (knownUsage) await settle(db, turnId, actualMicros);
else if (definitelyNotSent) await release(db, turnId);
// Issued call with uncertain usage retains its reservation.
```

### 6. P1 — Campaign reporting counts both estimate and actual for completed calls

Location: `scripts/brief-run/d1-reader.ts:221–225`, `:264–268`.

Settlement preserves the original `reservedMicros` for audit. The reader adds both columns across settled and reserved rows. A completed call costing 2,000 micros with an original 100,000-micro estimate is reported as 102,000. Campaign limits stop valid remaining tests prematurely, and completion-cost comparisons are wrong. Existing reader fixtures conceal this by giving settled rows a zero reservation.

Evidence: **LOCAL VERIFIED**, reservation settlement plus the real campaign-reader query over SQLite.

Fix both per-build and campaign queries:

```sql
sum(case when status = 'settled' then settledMicros
         when status = 'reserved' then reservedMicros else 0 end)
```

### 7. P1 — Campaign admission ignores remaining liability of timed-out builds

Location: `scripts/brief-run/driver.ts:295–307`; `scripts/brief-run.ts:567–579`.

The driver returns `timeout` without stopping the actual build. The next campaign admission considers only current spend and individual in-flight-call reservations, not the unfinished build's remaining allowance. On a $50 campaign, a $40 build A timing out after $1 permits a second $40 build B, while A remains able to spend another $39. The same problem exists when a runner restarts with active builds.

Evidence: **DOCUMENTATION ONLY** static control-flow finding and arithmetic counterexample; no paid overrun attempted. Fix independently of the overcount in finding 6, which can mask this issue.

Fix: reserve the full remaining allowance of each active campaign build durably, or stop and confirm a timed-out build has terminated before releasing its campaign allocation and advancing. Test runner restart and timeout while a provider request is active.

### 8. P1 — Uploads bypass the 100 MiB application quota

Location: `stacks/react-hono/files-files.ts:217–229`, `:273–274`.

Only `status = 'ready'` files count against quota at upload start; in-progress files reserve nothing, and finish never rechecks the quota. Start multiple uploads before finishing any and each is admitted against the same free space. Unfinished uploads can also keep storing parts outside the quota calculation.

Evidence: **LOCAL VERIFIED**, real generated starter and SQLite: with existing usage cap minus one byte, start two one-byte uploads, upload and finish both. Every request returns 200; total ready bytes become **104,857,601** against a **104,857,600** cap. `bun /tmp/caddie-feature-review.ts`.

Fix: atomically reserve declared file bytes across uploading and ready files. Release abandoned uploads with bounded cleanup. A count-then-insert check alone still races.

### 9. P1 — Published Run now is deliberately unimplemented

Location: `apps/app/src/server/routes/build-workflow.ts:574–580`; `server/publish.ts:568`; `client/project/AppJobs.tsx:49`.

Every `mode: "live"` job call returns 503, published app bindings lack the job signing secret, and the UI only offers preview runs:

```ts
if (mode === "live") return c.json({ ok: false, ... }, 503);
```

Evidence: **DOCUMENTATION ONLY**, direct code-path inspection. Preview jobs are implemented; this finding concerns the published path promised by part N.

Fix: wire dispatch, the mode-specific secret and the published UI action, with signed/unsigned isolation checks; otherwise explicitly label jobs preview-only and exclude them from published completion claims.

## Additional P2 findings

- `server/app-email.ts:100–109`: hourly email admission is count-then-insert. **LOCAL VERIFIED** via `bun /tmp/caddie-email-review.ts`: 30 concurrent local calls all accepted against 20/hour. Use atomic admission. Impact is confined to the test inbox; no outgoing email was sent.
- `server/schema-gen.ts:69–77` and `architecture-gate.ts`: the gate accepts declared reserved columns such as `createdAt`, then generated SQL adds the same column again. **LOCAL VERIFIED**: zero architecture issues, then SQLite `duplicate column name: createdAt`. Validate reserved/duplicate field names before design approval.

## Verification and limits

- Existing root checks: `bun test tests/module-join.test.ts tests/big-build.test.ts tests/part-boundaries.test.ts` — **43 passed, 0 failed**, 211 assertions. Log `/tmp/caddie-team-review-regression.log`. Sandbox images/check outcomes in these suites are **SIMULATED**.
- Independent spending checks: `build-spend`, `spend-instrument`, `brief-run-d1-reader` — **42 passed, 0 failed**; the counterexamples above remain uncovered by them.
- Root independently repeated generated module-mount, batch, upload-quota and privacy probes. The merge-race probe fails the expected preservation assertion.
- No live models, paid sandbox calls, deployments, production writes or campaign runs were performed. This report provides no **LIVE VERIFIED** claim. Provider compatibility, hosted behavior and actual cost still belong to the other agent's authorized live testing.
- Temporary repro scripts live under `/tmp` and may disappear on cleanup. All core triggers, observed results and suggested regression cases are recorded above.
