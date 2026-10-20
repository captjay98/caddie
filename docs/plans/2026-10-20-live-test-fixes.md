# Live-test fixes: auto-run plan (2026-10-20)

The owner's walkthrough of caddie.jamalibrahim.dev (2026-10-19/20) found 15
problems. Seven read-only investigations traced their causes; their reports are
`~/.kiro/crew/subagents/<id>/result.txt` with ids 048bc604 (chat), 212f8d36
(build status), 7582480a (installer), c830a8a5 (planning), 6606e4fd (polish),
da90892c (GitHub, memory) and 7a18aab3 (project cards). This plan fixes all of
it, then finishes Track 3. It runs itself, one step per cycle.

## Rules for every step

- Live fixes: worktree `/Users/captjay98/projects/caddie-forge-livefix`, branch
  `fix/live-test-findings`. Track 3: `/Users/captjay98/projects/caddie-forge-track3`,
  branch `feat/track3-flutter`.
- Tests first and seen failing; then the code; then that test file plus
  `bun run typecheck`; then a mutation (back up, break, run, restore, `cmp`)
  proving the test bites. Browser tests need `bun run build` first.
- Commit only named paths, with this file's tick in the same commit. Never
  `git add .`, never push, never edit in main's checkout (another agent works
  there) except the merges in 7.2 and 8.4.
- Never read `.prod.vars`/`.dev.vars` values. No paid sandbox or model runs and
  no production calls: those wait in phase 9 for the owner.
- Before a build or browser run: at least 2 GB disk free and memory not
  critical; one heavy command at a time.
- A step too big for one cycle: do a bounded part, write `next` in the session
  ledger, don't tick. A step that fails twice: mark it BLOCKED with the reason
  and move on.
- UI copy is plain language for non-technical users; internal ids appear only
  under "For developers".

## 1. Builds survive large packages

- [x] 1.1 Installer: no temporary archive (pipe the checked tarball to
  `tar -xzf -`), at most 4 downloads at once, one retry on a failed extract, a
  plain error naming the package. `tests/verified-install.test.ts`: nothing left
  in tmpdir, a first failure is retried, existing cases green.
- [x] 1.2 Caddie's `.caddie-scratch/` folder at the app root is never saved
  (GitHub, versions, checkpoints) and never listed under "Files written". A
  dot-name only Caddie uses, so a user's own `scratch/` folder is still saved
  and imported.
- [x] 1.3 Builder instruction: probes go in `.caddie-scratch/`; a failure inside
  Caddie's own installer or checks is reported as Caddie's problem, not
  debugged. Source-guard test.
- [x] 1.4 A preview can be as large as storage allows: `prepareOutput` caps the
  preview page at 500 KB though stored files may be 2 MB (`D1_MAX_VALUE_BYTES`),
  and the page carries the whole app, so FarmLog (sql.js) never got one. Use the
  real limit and say the size in plain words. Test in `build-workflow.test.ts`.
- [x] 1.5 WebAssembly runs where the app runs: the preview frame's policy
  (`script-src 'unsafe-inline'`) and published apps' (`script-src 'self'`) block
  it, so sql.js cannot start even with a preview. Add `'wasm-unsafe-eval'`
  (WebAssembly only, not JavaScript eval). Owner: OK this security-policy
  change first. Done (owner OK 2026-10-20 01:58): both policies carry it; a
  real browser runs a WebAssembly module and still refuses eval, in the
  preview frame and on a published page.
- [x] 1.6 A WebAssembly library finds its `.wasm` file. Caddie keeps only
  `dist/main.js` and `dist/main.css` (`readBuiltApp`), the preview frame has
  no network (`connect-src 'none'`), and publishing uploads only those files,
  so a `.wasm` fetched by URL (sql.js's default `locateFile`) never arrives.
  The bytes must travel inside the bundle (sql.js: `wasmBinary`). Read the
  template's build first; then fix the template, the builder's recipe, or
  both. Test: a bundle using sql.js runs a query in the preview frame. Done:
  the scaffold ships `caddie/embed.ts` (a Bun macro: the bytes go into
  main.js at build time, and the app's tests see the same value), and the
  builder's recipe says when and how. Bun's own `.wasm` base64 loader gave
  an empty string, so it is not used. A tiny app built with the template's
  own command runs its WebAssembly in the preview frame; sql.js itself is not
  installed here, so a 39-byte module stands in for it.

## 2. Chat

- [x] 2.1 A message shows "Sending…" while in flight (no buttons), and "Not
  sent" with Send again / Edit / Discard only after a failure; no key jargon; a
  reload restores an in-flight draft as not sent. Browser cases in
  `tests/browser/conversation.spec.ts`: slow admission, failure, resend.
- [x] 2.2 No double copy of a message while it sends (Flue shows its own).
- [x] 2.3 One paragraph per reply: join neighbouring text parts before
  rendering. Unit test with parts `"The"`, reasoning, `" Nebius…"`.
- [x] 2.4 Tool calls written as text: find the hook in `docs/flue-contracts.md`;
  never show a JSON object matching a mounted tool's input; for
  `propose_project`, run it (the card still needs the button) or tell the model
  it did not run. Unit tests, including the exact FarmLog JSON. Done as:
  hygiene hides it, the turn says so with "Ask Caddie to try again", and the
  coordinator is told never to do it. Flue 2.2.2 has no hook that can read or
  rewrite a reply's text, so the server cannot run the tool from it.
- [x] 2.5 Find how "start it" started a build without the button; if it skips
  the user's confirmation, close it. Test. Found: nothing skips it. A new
  project starts only through `acceptProposal`, called only by its
  authenticated route, which only the card's two Start buttons call; no chat
  tool can start one, and Home routes only "continue/resume/… <name>" to an
  existing project. So the build began from a click on a real card that
  rendered (an accepted card shows as the build card). Guard tests pin this.

## 3. Build status from one record

- [x] 3.1 The "paused this build" brief appears only when the build is really
  stopped (`build_workflows.phase = 'blocked'`). Unit test. Done: only while
  Caddie has the build paused (not the person's own stop), and only for that
  build's run; projects without a build keep the old rule. Both brief tests
  now build the full schema (every migration).
- [x] 3.2 Both Stop buttons stop the running turn and the workflow, with one
  label; stopping settles any feature still "Building now". Unit + browser.
  Done: one path for both, `POST /workflow/stop` → `stopBuild` (the workflow
  first, then the running turn, by the same abort request the browser made);
  both say "Stop build"; a feature reads "Building now" only while the build
  is building (stopped, paused or re-planned: "Up next").
- [x] 3.3 Check history in words, never raw JSON (new rows store a sentence, old
  rows are formatted). Unit + browser. Done: `round-detail.ts` words a check
  result ("The app's own tests: 7 of 9 passed.", "Building the app failed.");
  the host stores that sentence, the build view and the judge's friction log
  word old rows when read, and the page never shows a detail that is raw data.
- [ ] 3.4 Check counts per attempt ("Attempt 3: 1 of 2 passed"); "Run its own
  tests" shows the behaviour-tests count. Unit (`build-timeline`).
- [ ] 3.5 The Build tab shows the same status as the chat card; record ids only
  under "For developers". Browser.
- [ ] 3.6 One build card, no card inside a card (chat and the project's Now),
  with a clearer hierarchy. Browser + a screenshot for the owner.
- [ ] 3.7 Home Caddie can say how a project's build is going (read-only, own
  projects only). Unit.

## 4. Plans use the platform, the hackathon's rules and the user's words

- [ ] 4.1 Coordinator and planners know a built app's AI is
  `c.env.CADDIE.ai(...)`, NVIDIA Nemotron on Nebius Token Factory, and never
  plan Ollama, local models or third-party AI keys. Source-guard tests.
- [ ] 4.2 The hackathon's required tech (its quoted rule) travels from the
  proposal to the brief and the plan. Unit tests.
- [ ] 4.3 "Who it's for" and "the problem" are kept in the user's own words on
  the proposal and shown on its card. Unit + browser.
- [ ] 4.4 The idea stays plain language; the stack lives only in the brief.
- [ ] 4.5 Design mocks render only in the styled preview frame; one that lands
  in chat is shown there, never as raw HTML. Unit + browser.

## 5. Polish

- [ ] 5.1 A styled "Getting your workspace ready" screen (`Gate.tsx`, `routes.tsx`).
- [ ] 5.2 The split sign-in is the sign-in everywhere (one shared component).
- [ ] 5.3 Plan tab: same width as the other tabs; the plan folds once approved;
  badge and button follow the build ("See build progress" while building); one
  plain sentence on what approving means.
- [ ] 5.4 A brief that needs the owner also arrives as a notification, once per
  run, raised where the failure is recorded.
- [ ] 5.5 Audit trail becomes "Details" in words; ids under "For developers".
- [ ] 5.6 Page-shaped loading skeletons for Home, Projects, Plan and Build.
- [ ] 5.7 Project card = variants B + C: the app's picture (its letter tile
  until real screenshots exist), the 4 steps, the hackathon and its deadline
  (added to the project list). Unit + browser + a screenshot for the owner.

## 6. GitHub and memory

- [ ] 6.1 GitHub connects in one click: handle GitHub's return after install
  (`installation_id`, `setup_action`) and bind; the id form becomes a fallback.
  Unit + browser. Owner: set `GITHUB_APP_SLUG` and the App's Setup URL.
- [ ] 6.2 Memory learns: facts carry the project in a project chat; a stated
  lasting preference is proposed after the turn (still needs Confirm). Unit.

## 7. Land the live fixes

- [ ] 7.1 Full gate: license audit, scaffold lock check, typecheck, build, test,
  `verify:packet --all`, `test:browser -- --all`, release-check; execution
  ledger and README counts.
- [ ] 7.2 Merge into main locally, only if main's checkout has no uncommitted
  tracked changes (else ask the owner). No push. Owner: push and deploy.

## 8. Track 3 (Android apps), in its worktree

- [ ] 8.1 E3: the final checks build the APK (a non-blocking "Android app"
  check) and keep it with the build.
- [ ] 8.2 E4: publishing an Android app publishes its server plus a simple
  download page (APK link and QR).
- [ ] 8.3 F: "Download Android app (X MB)" / "Install on this phone" and a QR
  code (SVG, signed 30-minute link). Browser tests.
- [ ] 8.4 Rebase on main, full gate with Flutter on PATH, docs (`sandbox.md`,
  `owner-inputs.md`, `.prod.vars.example`, ledger), merge locally as in 7.2.

## 9. Live checks: paid, OK'd by the owner on 2026-10-20 (run each when ready)

- [x] 9.1 Installer proof: one sandbox run of about a minute (scaffold + sql.js
  + fake-indexeddb). LIVE VERIFIED 2026-10-20 with
  `scripts/probe-sandbox-large-package.ts` on tag:tt-base:1 (Bun 1.4.2): 65
  pinned packages downloaded, checked and unpacked in 9.3 s, the frozen install
  found no changes, sql.js loaded its wasm and answered a query. The old code
  was not re-run, so the EBADF itself is still unexplained.
- [ ] 9.2 Track 3: scaffold, a probe test and the APK build in the Flutter image.
- [ ] 9.3 After deploy: one chat-to-plan-to-build journey through Caddie.

## Owner actions

- Given: OK for phase 9 (2026-10-20 00:50); OK for 1.5, WebAssembly in
  previews and published apps (2026-10-20 01:58).
- Still to do: GitHub settings (6.1); push and deploy after 7.2 and 8.4;
  re-plan FarmLog AI once phase 4 is live; optional: clear `~/.gradle/caches`.
- Known limit: judges can't publish, so a judge's APK has no live server; they
  get the browser preview.
