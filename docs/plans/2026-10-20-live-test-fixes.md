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
- [x] 3.4 Check counts per attempt ("Attempt 3: 1 of 2 passed"); "Run its own
  tests" shows the behaviour-tests count. Unit (`build-timeline`). Done: host
  checks are grouped into attempts (never mixed), the stage names the attempt
  once there is more than one, and the app's own test count also comes from
  Caddie's behaviour-tests check (shell test runs are refused, so most builds
  only run them there).
- [x] 3.5 The Build tab shows the same status as the chat card; record ids only
  under "For developers". Browser. Done: the Build tab opens with the Now
  panel (the same project record the chat card and project home read; it
  used to follow this browser's chat connection), and the plan's record id
  joined the other ids in the developer fold.
- [x] 3.6 One build card, no card inside a card (chat and the project's Now),
  with a clearer hierarchy. Browser + a screenshot for the owner. Done: the
  five stage tiles are one checklist (full labels, what happened on the
  right), feature rows and the files/commands panels are plain rows and
  sections under hairlines. Before/after screenshots sent to the owner.
- [x] 3.7 Home Caddie can say how a project's build is going (read-only, own
  projects only). Unit. Done: a `project_status` tool (every chat, Home
  included) returns the stage, the project page's own message, features done
  and the build's latest line, without ids; another account's project or Home
  itself is "not found"; Home's overview says to call it before answering.

## 4. Plans use the platform, the hackathon's rules and the user's words

- [x] 4.1 Coordinator and planners know a built app's AI is
  `c.env.CADDIE.ai(...)`, NVIDIA Nemotron on Nebius Token Factory, and never
  plan Ollama, local models or third-party AI keys. Source-guard tests. Done:
  one `PLATFORM_AI_RULE` (specialists.ts), carried by the product and
  tech-lead roles and given to the coordinator in the instructions every
  conversation gets (Home proposals and project PRDs).
- [x] 4.2 The hackathon's required tech (its quoted rule) travels from the
  proposal to the brief and the plan. Unit tests. Done: `requiredTech` on the
  proposal (migration 0036), asked for by propose_project; accepting adds
  "Required by the hackathon (<title>): “<rule>”" to the brief; the PRD
  instruction copies it word for word under "Hackathon requirements".
- [x] 4.3 "Who it's for" and "the problem" are kept in the user's own words on
  the proposal and shown on its card. Unit + browser. Done: `audience` and
  `problem` (migration 0037), asked for "in the person's own words" by
  propose_project; the card shows them quoted; accepting carries them into
  the brief and the PRD opens its overview with them as written.
- [x] 4.4 The idea stays plain language; the stack lives only in the brief.
  Done: propose_project says so, and the server refuses an idea that names a
  framework, language, database, hosting or API with one plain line telling
  the model to put the stack in the brief (ordinary English such as "react
  fast" or "farm workers" passes).
- [x] 4.5 Design mocks render only in the styled preview frame; one that lands
  in chat is shown there, never as raw HTML. Unit + browser. Done:
  `splitChatMocks` (contracts) takes ```html-mock and ```html blocks and
  screens written straight into a reply (a page, `<body>` or `<main>`) out of
  the prose, in order; chat replies and the build card's latest update render
  through `ReplyText`, which draws them in the same locked-down preview frame
  and says "Drawing a mockup…" while one is still being written. Code in other
  languages stays code. The design step tells Caddie never to paste HTML into
  a reply.

## 5. Polish

- [x] 5.1 A styled "Getting your workspace ready" screen (`Gate.tsx`, `routes.tsx`).
  Done: the gate's loading and error states are the shared state panel on a
  chrome-free themed page (`.gate-view`, the route error page's canvas); the
  error offers Try again and no "Ask Caddie" (the chat is not open yet); a
  finished welcome shows the same panel while it opens the workspace.
- [x] 5.2 The split sign-in is the sign-in everywhere (one shared component).
  Done: `SignInScreen` (`client/sign-in.tsx`) is the only sign-in; the
  workspace chrome, every page body and the onboarding page render it (the
  plain column and the wall are gone). It runs edge to edge under the header,
  fills a chrome-free page on onboarding, and is the form alone on a phone.
- [x] 5.3 Plan tab: same width as the other tabs; the plan folds once approved;
  badge and button follow the build ("See build progress" while building); one
  plain sentence on what approving means. Done: the 820px cap is gone; the
  plan is a fold, open until approved; once approved the badge and button
  read the build's own phase (Building now / See build progress, Build paused
  / See what's needed, App built / See your app, all to the Build tab); the
  bar says "Approving lets Caddie build exactly this plan in a private
  workspace; putting it online or changing real data always asks you first."
  in place of the two-box fold. Button-styled links lose their underline.
- [x] 5.4 A brief that needs the owner also arrives as a notification, once per
  run, raised where the failure is recorded.
  Done: every pause Caddie records (`setWorkflowBlocker`, the stall
  watchdog) raises one `build_paused` notification per run for the build's
  owner (`brief:<runId>:blocked`); the person's own Stop never does; a
  notification that cannot be saved never undoes the pause. The app had no
  screen for notifications, so a bell now sits in the top bar (and the phone
  header): an unread count, the list in Caddie's words, and "Open the build"
  marks it read and goes to that project's Build tab.
- [x] 5.5 Audit trail becomes "Details" in words; ids under "For developers".
  Done: the toggle reads "Details"; it says what the card rests on ("No
  evidence is attached yet." / "It rests on N pieces of evidence.") and what
  its button does ("“Review the design” opens it for you to review; nothing
  changes until you decide."); the run, evidence, card, project and action ids
  sit in a closed "For developers — record ids" fold.
- [x] 5.6 Page-shaped loading skeletons for Home, Projects, Plan and Build.
  Done: `PageSkeleton` (states.tsx): the thinking character and one line
  ("Reading your brief…", "Loading your projects…", "Reading your plan…",
  "Reading your builds…") over blocks laid out like the page (Brief cards,
  project rows, the decision bar and plan, the build status and its stages);
  Plan and Build use it while the project list loads too. Still under
  reduced motion.
- [x] 5.7 Project card = variants B + C: the app's picture (its letter tile
  until real screenshots exist), the 4 steps, the hackathon and its deadline
  (added to the project list). Unit + browser + a screenshot for the owner.
  Done: `GET /api/project-hackathons` gives every one of the person's
  projects its hackathon and deadline in one request
  (`projectHackathonsForActor`, the same matching as the project page); the
  letter-and-colour rule moved to `@caddie/contracts` (app-icon.ts) so the
  card's tile matches the app's home-screen icon. The card: the tile beside
  the name and badge, "🏆 <hackathon> · Due in N days", the purpose, the four
  steps from the real stage (`journeyFromExperience`: done ✓, now, stopped ✕;
  Share as the last step of a personal project), then the detail, Updated
  and the action. Screenshots: `$KIROCREW_SCRATCH/card-shots/`.

## 6. GitHub and memory

- [x] 6.1 GitHub connects in one click: handle GitHub's return after install
  (`installation_id`, `setup_action`) and bind; the id form becomes a fallback.
  Unit + browser. Owner: set `GITHUB_APP_SLUG` and the App's Setup URL.
  Done: `GET /api/github/app?workspaceId&returnTo` gives members an install
  link carrying a signed state (`github-connect.ts`, 30 minutes, no table);
  `GET /api/github/setup` is the Setup URL. GitHub warns its
  `installation_id` can be spoofed, so the return binds only with a state
  Caddie signed for the same signed-in person, then checks the installation
  as the by-id form does and goes back to that person's page with
  `?github=<outcome>`. The picker's "Connect GitHub" opens GitHub in the same
  tab with that state (project settings come back to the Code section); the
  outcome leaves the address before the router reads it and the page says it
  once in plain words (`github-return.ts`, `GithubReturnNotice`); "Connect by
  installation number instead" is the folded fallback.
  `docs/setup/github-app.md` names the Setup URL. Known, unchanged: the by-id
  form can claim any unbound installation of the App; proving the installer
  would need GitHub App user sign-in.
- [x] 6.2 Memory learns: facts carry the project in a project chat; a stated
  lasting preference is proposed after the turn (still needs Confirm). Unit.
  Part 1 done: in a project's chat, `remember` keeps what is about the
  project (`about: 'project'`, or a fact given no owner) with that project:
  it lists under the project's "What Caddie knows" and, once confirmed, only
  that project's chats are given it. What is about the person (`about:
  'you'`, or a preference) stays with their account; Home has no project of
  its own. Caddie is told to call remember with about 'project' for lasting
  things said about a project. Part 2a done: the conversation guard reads the
  person's own message (never Caddie's own dispatches) for a lasting
  preference (`stated-preference.ts`: an instruction that starts with
  always/never, "from now on" / "going forward", "I prefer" / "I'd rather";
  questions, "never mind", money, effects, permission, links, email addresses
  and long numbers are passed over; two at most) and proposes each once as a
  preference about the person (`stated:<runId>`). It does so when the message
  is admitted rather than after the turn, so the chat can show it under the
  message; a failure never blocks the message. Part 2b done: the chat shows
  what is waiting for the person's OK from that project's chats (what they
  stated, and what Caddie proposed with remember): "Caddie can remember this
  for next time: “…”" with Remember it and No thanks (declined, it is never
  offered again), read again each time another of their messages is admitted
  (`GET /api/memory/offers`, `MemoryOffers.tsx`). The remember tool's line in
  the chat now reads "Noted for you to confirm".

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
  Main now has 0036 and 0037 (plans 4.2, 4.3): renumber Track 3's 0036/0037
  after main's last migration before merging, and add the 1.3 sentences to
  `FLUTTER_RECIPE_INSTRUCTION`.

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
