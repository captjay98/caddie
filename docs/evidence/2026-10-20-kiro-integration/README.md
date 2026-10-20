# Kiro completion and main integration — 2026-10-20

## Scope and provenance

Owner request: finish Kiro's work, integrate on main, test properly, then push.
No deployment was requested or performed. Track 4 monetization is outside scope.

The complete visible exchanges from today's Kiro session were read, not merely
its closing message. Session: `dashboard_chat-38-1792152365`; source log:
`/Users/captjay98/.kiro/crew/sessions/dashboard_chat-38-1792152365.jsonl`.
Kiro stopped after memory-offer work at `e70e5347ddbf984e1011fddb285bc2ae3893a9cb`,
then attempted the phase 7.1 gate before repeated model-overage failures.

The earlier scheduled test covered main at `fcb3dec` and its own fix `14aa1a7`.
It **did not cover Kiro's later branch**. Its report remains historical at
`docs/evidence/2026-10-20-caddie-end-to-end/README.md`.

Integration:

- Live fixes: `fix/live-test-findings` through `e70e534`; merged into main in
  `afeebad`, preserving the earlier quota and idle-project fixes.
- Flutter foundation: `feat/track3-flutter` through `2d176fa`; merged with
  proposal fields, AI rules, both preview policies, and both preview-size tests
  preserved. Never-landed Flutter migrations were renumbered to 0038 and 0039;
  existing 0036/0037 retain their meanings.
- Completed phase 8 native packaging, APK delivery, and Flutter publishing.
- Preserved the two preexisting untracked planning/review documents, sibling
  worktrees, unrelated branches, and secret files.

Authoritative requirements: `docs/plans/2026-10-03-fresh-build/`,
`docs/plans/2026-10-20-live-test-fixes.md`, and the owner's Track 3 plan.
`docs/flue-contracts.md` was read before changing agent behavior.

## Fix catalogue inherited from Kiro

The checked steps in the live-test plan contain detailed implementation and
per-step verification history. This catalogue records their reproduction and
cause without treating those historical claims as fresh live proof.

| Step | Reproduction / cause | Resulting change and principal files |
|---|---|---|
| 1.1 | A large sql.js installation had failed writing a temporary archive; the exact original EBADF cause remains unexplained. | Verified installer unpacks checked bytes through stdin, limits concurrency to four and retries extraction once (`verified-install.ts`). |
| 1.2–1.3 | Builder probes appeared in snapshots and files-written lists; instructions allowed infrastructure debugging inside app work. | Exclude only `.caddie-scratch/` from imports/exports/checkpoints and explain its use and infrastructure failure handling (`source-export.ts`, specialist instructions). User-owned `scratch/` stays included. |
| 1.4 | A valid browser bundle exceeding 500 KB could not get a preview although storage permits larger values. | Use the actual 2 MB value bound and plain size errors (`build-workflow.ts`). Flutter pages use the chunked store. |
| 1.5 | WebAssembly instantiation failed under preview and published CSP. | Add `wasm-unsafe-eval` while JavaScript eval remains denied (preview component, dispatch policy). Browser test executes WASM and rejects eval. |
| 1.6 | A library fetching a separate `.wasm` asset loses it in the single-file offline preview. | Scaffold build-time embed macro and recipe instructions carry binary bytes inside JS (`stacks/react-hono/`). Existing test uses a small WASM fixture, not actual sql.js in the browser. |
| 2.1–2.2 | In-flight messages appeared failed or twice. | Distinguish sending/failed states and reconcile optimistic sends with Flue messages (conversation UI). |
| 2.3 | Text around thinking/tool parts rendered as disconnected paragraphs. | Join adjacent text parts for readable replies (reply presentation). |
| 2.4 | Model-written proposal JSON appeared as chat rather than a mounted tool result. | Hide matching raw tool input, explain that the proposal did not run, offer retry, and instruct proper tool use. No claim that hidden JSON executed. |
| 2.5 | Reported concern that “start it” skipped confirmation. | Investigation found only the authenticated proposal acceptance route creates the new project; guard tests pin this. No bypass was reproduced. |
| 3.1 | Brief said a build was paused when it was not currently Caddie-paused. | Derive the brief from the active blocked workflow/run (`brief.ts`). |
| 3.2 | Stop paths disagreed and features could remain “Building now”. | One workflow stop path also aborts the turn; feature status follows actual workflow phase. |
| 3.3 | Check history showed raw JSON. | Store/read concise human sentences, including old records (`round-detail.ts`, host and timeline UI). |
| 3.4 | Test counts mixed attempts or omitted behavior-test results. | Group checks by attempt and derive app-test counts from their actual check output (`build-timeline.ts`). |
| 3.5–3.6 | Build tab and chat disagreed or nested multiple status cards. | Shared project Now state, single stage checklist, developer-only record ids. |
| 3.7 | Home could not truthfully report another project's current state. | Scoped read-only `project_status` tool; cross-account projects fail closed. |
| 4.1 | Plans could request local models or extra AI keys. | Shared platform-AI instruction names `c.env.CADDIE.ai`, carried into coordinator/planner instructions. |
| 4.2–4.3 | Hackathon tech rules and the user's audience/problem were lost between proposal and brief. | Persist `requiredTech`, `audience`, `problem`; show original words and carry them into planning (migrations 0036/0037, proposals, coordinator, card). |
| 4.4 | Idea labels were filled with framework/platform details. | Keep readable idea text and move implementation details to the brief; reject stack-filled proposal labels. |
| 4.5 | Design HTML could print directly in a reply. | Extract supported mockup blocks/pages into the existing locked preview frame while preserving other code. |
| 5.1–5.2 | Workspace setup looked unstyled and sign-in surfaces differed. | Styled workspace gate and one shared split sign-in. |
| 5.3 | Plan width/folding/navigation disagreed with actual build progression. | Full-width plan, approved-plan folding, one approval sentence, step derived from project state. |
| 5.4 | A paused build's owner had no durable notification. | One notification per run and a scoped bell linking to that project's build. |
| 5.5 | Decision details exposed audit jargon and ids. | Plain “Details” explanation with ids in a developer fold. |
| 5.6 | Loading states lacked page context. | Page-shaped skeletons for Home, Projects, Plan and Build, respecting reduced motion. |
| 5.7 | Project cards lacked contest/deadline and clear progression. | Shared app tile, four steps, contest and deadline from scoped project data. |
| 6.1 | GitHub installation required manual id entry; callback outcome was not handled. | Signed state, same-tab install link, scoped callback, plain one-time outcome, manual fallback. Additional ownership fix below closes an unsafe claim path. |
| 6.2 | Project facts leaked into personal memory scope; explicit lasting preferences were not offered for confirmation. | Project-scoped memory plus bounded preference proposals; explicit Remember it / No thanks. Additional settlement refresh below fixes delayed model offers. |

## Additional defects found and fixed during integration

### Verification gates

1. **Unmapped tests:** Kiro's full gate failed because four new test files were
   absent from `scripts/packet-list.ts`. Mapped GitHub connect/return to P08,
   memory learns/stated-preference to P14, and the Android tests to FLUTTER.
   Packet completeness asserts every candidate is mapped and actually runs.
2. **Stop race:** the cancellation test aborted immediately after the stub saw
   a POST, before the durable remote id existed. That legitimately exercises
   uncertain dispatch rather than confirmed cancellation. It now waits for the
   persisted `sandbox_bindings` operation to be dispatched with a remote id,
   then aborts. The unknown-dispatch behavior remains covered separately.
3. **Missing fixture dependencies:** Kiro's test log could not resolve Hono in
   the task-tracker fixture. Verification uses the existing frozen fixture
   setup/build, not an invented provider-success response.
4. **Migration collision:** merging both branches reused 0036/0037 for different
   purposes. Renamed the never-landed Flutter additions to 0038/0039 and updated
   test references. Fresh local D1 applies all 39 migrations in numeric order.
5. **Preflight drift:** adding the documented `CONTREE_FLUTTER_IMAGE` override
   made the strict example/known-keys test fail. Added it to preflight's optional
   keys; the existing 29-case preflight suite then passes.
6. **Legitimate GitHub fixture drift:** the first full run's repository-creation
   fixture had only a Google identity and omitted immutable installation account
   metadata. Seeded its intended linked GitHub identity through test-only D1 and
   matching provider metadata. The ownership check remains unchanged; unsafe
   claims remain negative tests.

Cancellation regression's synchronization:

```ts
const record = JSON.parse(row.value);
if (record.state === 'dispatched' && record.remoteId) dispatched = true;
expect(dispatched).toBe(true);
abort.abort();
```

### GitHub installation ownership

Reproduction: authenticate as Alice, request correctly signed connection state,
then supply Bob's unbound installation id to either the callback or manual form.
Signed state proved Alice requested a connection; it did not prove she owned the
separately supplied installation. The shared binder now checks immutable GitHub
identity, protecting both routes. Google-only accounts receive an actionable
GitHub sign-in requirement; unsupported organization installations fail closed.

```ts
const identities = await queryAll(db,
  'select "accountId" from "account" where "userId" = ? and "providerId" = ?',
  verified.actorId, GITHUB_PROVIDER);
if (info.accountType !== 'User' || !info.accountId ||
    !identities.some(identity => identity.accountId === info.accountId)) {
  throw new ScopeError(403, 'installation_ownership_unverified', ...);
}
```

Changed adapter metadata, `repositories.ts`, callback result types/copy, setup
documentation and legitimate linked-identity fixtures. Unit exploit cases were
seen failing before the fix; 31 focused tests pass afterward. All 45 real local
worker tests pass, including both HTTP exploit paths. **LOCAL VERIFIED** for
scope, D1, auth/session and signatures; GitHub/OAuth provider behavior is
**SIMULATED** by local HTTP providers. Independent review found no remaining
ownership issue. No real GitHub installation was changed.

### Memory prompts after a model turn

Reproduction: model calls `remember` after the user's message has already been
admitted. The offers query refreshed only on user admission, so the confirmation
appeared after a later message. The query now changes when the turn settles.
Separate tuple components avoid refresh-key collisions after history replacement.

```tsx
<MemoryOffers projectId={projectId}
  refreshKey={`${admittedUserMessages}:${source.settlements.length}`} />
```

Changed `Channel.tsx`, `MemoryOffers.tsx` and conversation browser tests. The
regression uses the actual Channel/Flue hook with a controlled settlement stream:
one admitted user message, empty offers first, then a new offer at settlement,
without any second user POST. Transport/provider events are **SIMULATED**.

### Memory offers could be shown in the wrong order

Reproduction: the final `bun run test` gate failed
`tests/stated-preference.test.ts` ("a project's offers are the person's own
proposals from that project's chats, while they wait"): two proposals written
back to back came back in the other order. It reproduced in 2 of 3 runs.

Cause: `memoryOffers` ordered by `createdAt` then the random `mem_<uuid>` id.
Both inserts share a millisecond, so the id decided the order, and a UUID has
no relationship to when the row was written. "Oldest first" was therefore
undefined for same-millisecond rows, and the chat could show offers in a
different order on every read.

```sql
-- before: order by f."createdAt" asc, f."id" asc   (random tiebreak)
order by f."createdAt" asc, f."rowid" asc
```

`rowid` is the write order, so same-millisecond offers stay in the order they
were written. The regression forces the tie directly — both rows get the same
`createdAt`, and ids that sort the opposite way round — so it fails
deterministically against the old ordering and passes against the new one
(verified by temporarily restoring `f."id" asc`: 1 fail; restored: 0 fail).
Changed `apps/app/src/server/stated-preference.ts` and
`tests/stated-preference.test.ts`. **LOCAL VERIFIED**.

### The packet gate's preview port was not owned safely

Recorded while running the gates: `verify:packet --all` and
`release-check` (which re-runs packet checks) at the same time made P00 fail —
12 of 13 `tests/routing.test.ts` cases — while P00 passed alone and passed
again on a serial re-run. `tests/routing.test.ts` starts its own `vite preview`
on `9400 + (pid % 300)`, so two gates can derive the same port.

Investigating that, the port handling turned out not to do what its comment
claimed:

- The "reap any listener left by a crashed run" step ran
  `lsof -ti -sTCP:LISTEN tcp:<port>`. On macOS lsof 4.91 that is a usage error:
  it writes `status error on tcp:<port>` to **stderr** and nothing to stdout, so
  the step never reaped anything — it always looked free, whether it was or not.
  It also SIGKILL'd whatever it found, which is the wrong answer for a port some
  other healthy run is using.
- The same spelling was used to verify the port was freed in `afterAll`.

Fixed by owning the port instead of fighting over it: `portOwners()` uses the
working query (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`), `freePort()` walks
upward to the first port nothing listens on (a leftover or a concurrent run is
walked past, never killed), and the same query now backs the `afterAll` check
that the port really was released. New case: "the preview port picker walks
past a port in use instead of killing its owner" — it binds a dummy listener,
asserts the picker moves on, and asserts the other listener is still serving.

After the fix, two packet gates were run concurrently: both reported 43 PASS /
0 FAIL with P00 clean. The original concurrent failure is **recorded, not
reproduced on demand** (the collision needs two runs to derive the same port),
and it never reproduced serially; no product defect is claimed from it. Changed
`tests/routing.test.ts` only. **LOCAL VERIFIED**.

### The live Flutter journey could not install over a stale, foreign-signed install

Reproduction: `CADDIE_LIVE_AUTHORIZED=1 bun run test:live -- P15d` on the booted
arm64 emulator. Everything before the install passes — the scaffold writes the
real project, `dart caddie/setup.dart` sets up Android, the locked install
holds, `flutter test test/examples` passes and `flutter build apk --debug`
produces a real APK — then:

```
adb: failed to install app-debug.apk: Failure
[INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package dev.caddie.app.caddie_app
 signatures do not match previously installed version; ignoring!]
```

Cause: the emulator already had the **release** APK from the phase 9.2 proof
installed under the same application id (`dev.caddie.app.caddie_app`, also used
by the app's download journey), signed with a Play/release key. Android refuses
to replace a package with a differently signed build, so a debug build of the
same app id can never install over it. Nothing was wrong with the built APK, and
the acceptance bar (a real launch) is unaffected by clearing a stale install.

```ts
let install = run([adb, '-s', serial, 'install', '-r', apk], dir);
if (install.code !== 0 && install.output.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
	// A stale, differently signed install of this app id is a normal device
	// state here (the download journey installs the release APK). Drop it and
	// install the fresh debug build; the acceptance bar is unchanged.
	run([adb, '-s', serial, 'uninstall', APP_ID], dir);
	install = run([adb, '-s', serial, 'install', '-r', apk], dir);
}
expect(install.code, install.output.slice(-1500)).toBe(0);
```

With that, the journey passes end to end: real debug APK built, installed,
launched and captured on the emulator. Changed `tests/live/stacks/flutter.spec.ts`
only. First two attempts recorded as **FAILED** (this cause); the passing run is
**LIVE VERIFIED** — receipt `lr_602f8532232b3019` at `9af594f396d3`, 2 tests
passed.

### Complete native packaging and delivery


The foundation only produced a Flutter browser preview. Final verification now
also runs the curated arm64 release build, after browser/source checkpoint checks.
An HTTPS stable relay base is embedded; the backend works only after publishing.

The first real phase 9.2 probe built a 14.9 MB APK successfully, but the new helper
rejected its successful receipt: `cwd` was normalized by the driver to an absolute
workspace path while the helper compared it to relative `app`. Fixed the expected
path normalization and added a regression. The failed probe is recorded as
**FAILED**, rather than being counted as a passing native-product check.

Independent review additionally identified two correctness gaps:

- Receipt fields alone did not bind bytes read later to the verified image.
  Production passes the checked browser image; the helper compares input image,
  checks the resulting image before and after reading, and rejects mutation or
  replay from another image.
- An APK chunk write failure could abort browser delivery. APK persistence now
  runs once inside optional failure handling. It records a failed native check,
  drops native metadata, and still stores the checked Flutter preview. The
  regression runs the actual coordinator and SandboxDriver with only APK writes
  fault-injected; it asserts ready preview and null APK columns.

```ts
expectedInputImage: final.resultImage
// Receipt identity, command, normalized cwd, exit and timeout checks also apply.
receipt.inputImage === startingImage
(await driver.checkpoint(sessionId)).checkpointRef === receipt.resultImage
```

Publishing previously required a React client bundle, so Flutter could not be
published. Its immutable manifest now includes APK hash, size and API base, along
with server/web-preview data. The approved exact output yields the same backend
plus a download HTML page, CSS and local SVG QR. Changing APK columns invalidates
publication/minting and already-issued download links; a signed output id cannot
silently download replacement bytes. Byte reads verify the chunked content hash.

```ts
android: { sha256: stored.sha256, bytes: stored.bytes, apiBase }
// The published page's link selects its exact approved output.
`${bundle.android.apiBase}/app.apk?v=${encodeURIComponent(input.outputId)}`
```

The browser obtains metadata through a scoped GET and mints a 30-minute,
project/output-bound bearer download only on explicit POST. Responses are
private/no-store. Android shows an install/download action; desktop/iOS also show
a QR. The interface explains unpublished servers and judge limitations. QR uses
`qrcode-generator@2.0.4` locally; tests decode rendered pixels using dev-only
`jsqr@1.4.0`. No bearer link is sent to a QR service. Dependency licence audit is
clean. The browser cannot approve Android's installation prompt for the person.

Principal changed files: `server/android-app.ts`, `android-qr.ts`,
`coordinator-host.ts`, `build-workflow.ts`, `publish.ts`, `published-page.ts`,
`routes/build-workflow.ts`, `client/project/AndroidDownload.tsx`, shared project
surfaces, Android/build/publish/browser tests, and sandbox/setup documentation.

## Verification results

Kiro-era receipts below are kept as recorded. The merged tree's own gate results
follow in "Final aggregate gate on the merged tree"; the push identity is under
"Push". No pending entry is a success claim.

| Command / journey | Result | Classification |
|---|---|---|
| GitHub focused ownership/connect/return/source/import tests | 31 pass, 0 fail | LOCAL VERIFIED; external providers SIMULATED |
| `bun test tests/github.integration.test.ts` | 45 pass, 0 fail | LOCAL VERIFIED; GitHub/OAuth SIMULATED |
| Flutter scaffold `--check` with installed SDK | locked installs unchanged; 2 Flutter/5 server examples; bare gate refuses, probe gate passes; web/server builds; analyze clean | LOCAL VERIFIED |
| React scaffold `--check` | install, examples, gate refusal and build pass | LOCAL VERIFIED |
| `bun scripts/license-audit.ts` | 25 production dependencies allowed, 0 flagged/unresolved | LOCAL VERIFIED |
| Fresh browser D1 migrations | all 39 applied | LOCAL VERIFIED |
| `bun test tests/deploy-preflight.test.ts` after optional-key fix | 29 pass, 0 fail | LOCAL VERIFIED |
| Focused Android/build/publish/page tests | 109 pass, 0 fail | LOCAL VERIFIED; sandbox/hosting providers SIMULATED |
| First paid Flutter sandbox probe | setup/install/probe test/web/server pass; actual APK command exit 0; helper rejected normalized cwd; session disposed | FAILED (then fixed) |
| Corrected paid Flutter sandbox probe | all product checks pass; actual release APK downloaded, 14,884,096 bytes, SHA-256 `5631cde4441037cb8bffd194ed0e78895b9139d87fbf7bb0373b7754010c53f4`; session disposed | LIVE VERIFIED |

## Final aggregate gate on the merged tree

Recorded 2026-10-20 on `main` after both merges and the two integration fixes
below. Commands were run one gate at a time; browser specs ran against the
composed build with a fresh, fully migrated scratch D1 (all 39 migrations).

| Command | Result | Classification |
|---|---|---|
| `bun run typecheck` | exit 0 | LOCAL VERIFIED |
| `bun run build` | exit 0; composition 0 collisions | LOCAL VERIFIED |
| `bun run test` | 1,696 pass, 0 fail, 127 files | LOCAL VERIFIED |
| `bun run verify:packet --all` | 43 PASS, 0 FAIL, 4 NOT APPLICABLE | LOCAL VERIFIED |
| `bun run test:browser -- --all` | 25 PASS, 0 FAIL, 22 NOT APPLICABLE | LOCAL VERIFIED |
| `bunx playwright test` (whole browser suite) | 275 passed, 1 skipped (evidence-only screenshot spec) | LOCAL VERIFIED |
| `bun scripts/license-audit.ts` | 25 production dependencies, 0 flagged, 0 unresolved, CLEAN | LOCAL VERIFIED |
| `bun scripts/refresh-scaffold-lock.ts --check` | exit 0 | LOCAL VERIFIED |
| `bun scripts/refresh-flutter-scaffold-lock.ts --check` | exit 0; lockfiles sha256 `9e47e703…97bc818` | LOCAL VERIFIED |
| `bun scripts/release-check.ts` | 49 PASS, 0 FAIL, 1 BLOCKED (deployment authorization, by design), 4 PROVISIONED | LOCAL VERIFIED; live gates remain PROVISIONED/BLOCKED |
| Fresh local D1 | all 39 migrations applied in numeric order | LOCAL VERIFIED |
| Two packet gates run concurrently (harness robustness check) | both: 43 PASS, 0 FAIL, P00 clean in both | LOCAL VERIFIED |
| `bun run test:live -- P15d` | 2 tests passed; receipt `lr_602f8532232b3019` at `9af594f396d3` | LIVE VERIFIED (local toolchain + emulator) |

Push identity: see "Push" below.

Successful probe: session `session:flutter-probe-1792488440037`, Flutter base
image `1864960e-7449-4d26-ab77-9582989efc2e`, final native image
`cbd09b17-fc77-4976-90e4-9d645137b146`. Setup 2.9 s, verified installation
6.6 s, probe tests 9.5 s, web/server builds 27.0 s. The probe's one arithmetic
test intentionally establishes the host test gate, not useful generated-app
behavior. No request was made to the embedded production API address.

## Push

| Item | Value |
|---|---|
| Remote | `git@github.com-captjay98:captjay98/caddie.git` — the owner's configured SSH host alias for the existing `captjay98/caddie` repository (public) |
| Branch | `main` → `origin/main` |
| Commits | `afeebad` → `9af594f` (the merge) → receipt and docs commits. The remote repository was empty, so this was its first push |
| Verified | `git ls-remote --heads origin` reports the same commit as local `main`; the GitHub API reported the same tip after each push |
| Not pushed | the other local branches (`feat/publish-on-cloudflare`, `feat/chat-ui-polish`, `feat/track3-flutter`, `fix/live-test-findings`) and the pre-existing untracked review document |
| Secrets | none tracked — `.dev.vars`/`.env` are gitignored, and a scan of tracked files for credential-shaped strings found only documentation text about PEM format |
| Deploy | none; deployment authorization stays BLOCKED as an owner decision, and phase 9.3's after-deploy journey with it |

## Remaining proof boundaries

- No deployment took place. Phase 9.3's **after-deploy** real chat → plan → build
  walkthrough remains **BLOCKED** on deploying the integrated SHA and then
  exercising that version. Historical live receipts do not establish this SHA.
- Fixture browser workflows and local HTTP provider stubs prove UI/state/governance
  behavior, not real model planning quality, provider authorization or hosted
  publication. They are explicitly **SIMULATED** at those boundaries.
- APK build/download proof is separate from Android runtime/device proof and
  from a working deployed app backend. The device half is now covered: the live
  P15d journey (real debug APK → install → launch → capture on an arm64
  emulator, receipt in `docs/live-receipts.json`), and the sandbox release APK
  from phase 9.2 installed and launched by hand earlier the same day. A working
  deployed app backend still waits on the publish/deploy owner gates.
- GitHub account ownership is now checked for personal installations. Organization
  installations remain unsupported and fail closed.
- An unpublished APK's server returns a plain unavailable response. Judges can
  try the browser preview but cannot publish a server.
- Flutter packages support arm64 Android and have a 64 MB storage bound. The
  default untagged Flutter sandbox image may expire around 2027-04-17; rebuild
  and override it before relying on it then.
- No deployment, paid model call, purchase, provider publishing or new remote was
  performed. Existing origin was changed only to the owner's configured SSH host
  alias, `github.com-captjay98`, retaining `captjay98/caddie.git`.
