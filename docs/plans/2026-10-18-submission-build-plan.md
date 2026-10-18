# Caddie Forge — Hackathon Submission Build Plan (S01–S13)

**Written:** 2026-10-18, against `feat/publish-on-cloudflare` at `8333c185`
**Contest:** Nebius × NVIDIA Global AI Hackathon (Devpost)
**Deadline:** 2026-10-30, 10:00 PDT = 18:00 WAT. Target: everything ready by
2026-10-29, 18:00 WAT (24-hour buffer). The owner submits.
**Judging:** 2026-12-01 to 12-15. The demo must stay up, free and open to
judges until then.

This plan consolidates, for execution through the deadline,
`docs/plans/2026-10-18-hackathon-win-and-nemotron-3.5-plan.md` (the
"hackathon draft") and `docs/plans/2026-10-18-remediation-plan.md` (the
"remediation draft"). It keeps their goals, corrects facts that changed, adds
what they missed, and defers the large refactors (§9). Do not edit the two
drafts. Authority: `AGENTS.md` > `docs/plans/2026-10-03-fresh-build/README.md`
> this plan.

> **Audit note (2026-10-18, before S01 started).** Every §1 claim was
> re-verified against `8333c185` from the repo, not from the plan. They hold,
> including every line citation, the 1,330-green suite and 28/28
> `tests/browser/project-workflow.spec.ts` (which is the "project-card spec"
> and already contains "Stop build"). Four corrections are applied in place
> below: 76 (not 80) unmapped test files; the repair cap is 3 failures on the
> same *issue*; the S01 acceptance grep also matches a comment in
> `scripts/capture-android.ts`; and completeness is "at least one packet",
> because 10 files are legitimately the evidence for two packets each. Two
> notes for later packets: an existing 2026-10-15 LIVE VERIFIED note in
> `providers.ts` records that Nebius 400s image input on every Nemotron route
> (so G1's Super-VL image probe re-tests a recorded negative), and
> `docs/release-evidence.md`'s intentionally-absent list named two specs that
> now exist.

---

## 0. Read first (implementing agent)

**Rules that gate every step** (from `AGENTS.md`):

- Evidence labels, exactly: LOCAL VERIFIED, LIVE VERIFIED, SIMULATED,
  DOCUMENTATION ONLY, BLOCKED, FAILED. A mocked or local pass is never LIVE
  VERIFIED. A model's own report is never evidence.
- No deploys, paid API calls, new git remotes, pushes or printed secrets,
  except where a step says **OWNER GATE** and the owner has said yes in the
  current session. Record each yes (date, scope, cost bound) in
  `docs/plans/2026-10-03-fresh-build/execution-ledger.md`.
- Integration-lead files are edited by one actor, serially: route
  registration, `package.json`/`bun.lock`, shared contracts,
  `scripts/verify-packet.ts`, wrangler/vite/astro config, ledgers, migration
  numbers. This plan reserves migration **0033** (judge accounts, S06) and no
  other. If a step seems to need another, stop and say so.
- Slice procedure (`docs/plans/2026-10-03-fresh-build/packets.md`): failing
  behaviour test → watch it fail → smallest change → focused tests +
  typecheck + read the diff → commit only the files you own (never
  `git add .`). Commit messages state real test counts.
- Read `docs/flue-contracts.md` before touching agent code.

**Environment facts that cost earlier sessions hours:**

- Use Bun 1.4.0 at `~/.bun/bin/bun`; it wrote `bun.lock`. The mise `bun`
  shim has no default version. Start every shell with
  `export PATH="$HOME/.bun/bin:$PATH" TMPDIR=$(mktemp -d)`. Never change
  dependencies with another Bun: 1.3.14 silently rewrites hundreds of
  lockfile entries.
- Browser specs run against the composed build. Run `bun run build` first,
  then `bun x playwright test <spec> --reporter=line --global-timeout=420000`.
  Use the repo's `@playwright/test` Chromium, never `playwright-cli`.
- Some test harnesses keep hand-written migration lists. When 0033 lands,
  prefer `allMigrationPaths()` from `tests/fixtures/migrations.ts`, or add
  0033 to each list a failing test points at.
- Bun tests can't import `cloudflare:workers`; a preload stand-in exists
  (`bunfig.toml` → `tests/setup/cloudflare-workers.ts`).
- Don't use `git stash` (shared by every worktree), `sed -i` or heredoc
  scripts on source files; use the editor.
- When pushing is allowed, run `git push origin <branch>` as its own command.
  The agent runtime blocks pushes to `main`; the owner pushes `main`.

**Gates:**

- Per slice: `bun run typecheck` plus the touched test files.
- Per packet: `bun run test` (0 fail), `bun run build`, the browser specs for
  any UI touched (screenshots at desktop and 390px, looked at).
- Template changes: `bun scripts/refresh-scaffold-lock.ts --check` exits 0.
- From S01 on: `bun scripts/verify-packet.ts --all` and
  `bun scripts/release-check.ts`.

---

## 1. Verified state (2026-10-18, `8333c185`)

| Area | Fact | Where |
| :--- | :--- | :--- |
| Tests | `bun run test`: 1,330 pass, 0 fail, 103 files. Project-card browser spec 28/28, including "Stop build" (the hackathon draft's H03.1 is already fixed). | — |
| Migrations | 0001–0032 (0032 = the copied app's preview after "Start from my GitHub repo"). | `apps/app/migrations/` |
| Models | chat `nemotron-3-super` (`COORDINATOR_MODEL_ROUTE` matches), ideation `nemotron-3-ultra`, plan/build/vision `glm-5.3-flash`, helper `nemotron-3-nano`, app `nemotron-3-super`. | `apps/app/src/agents/providers.ts:149`, `apps/app/src/client/coordinator.ts:31` |
| Sign-in | Google and GitHub only; email/password disabled; the invite list is enforced in `databaseHooks.user.create.before`. Better Auth 1.7.10. | `apps/app/src/server/auth.ts` |
| Spend | **No model call is metered or capped per account.** The budget module exists but `reserveBudget` has no callers (no budget route is registered at all), and Settings › Spending says spending isn't tracked. The only caps: 150 build steps per build window (`BUILD_ACTION_BUDGET`, `apps/app/src/agents/permissions.ts:156`), 3 failed repair attempts on the same issue (`REPAIR_PAUSE_THRESHOLD`, `:132`), the same action repeated 3× in a row (`REPEATED_ACTION_LIMIT`), and the per-project app-AI allowance (`APP_AI_MONTHLY_LIMIT_CENTS`, default 100). | `apps/app/src/server/budgets.ts` |
| Verification net | CI runs only P00–P17 (`.github/workflows/ci.yml:21`). The release check hardcodes the same list (`scripts/release-check.ts:53`) and reports live gates as PASS when credentials merely exist (`:66–81`). **76 of the 102 `tests/*.test.ts` files and 6 specs belong to no packet (82 files).** `tests/live/github.spec.ts` is mapped (P08 live) but doesn't exist. | `scripts/verify-packet.ts:41` |
| Repo | No git remote, no root `LICENSE`, no root `README.md`. First commit 2026-10-03. `main` is 58 commits behind this branch. | — |
| Not live-verified | Publishing through Workers for Platforms, Worker Loader on a deployed Worker, Cloudflare Artifacts, the build sandbox at demo volume, real email, custom domains (not built). | `docs/plans/2026-10-17-publish/README.md` |

---

## 2. Owner decisions and gates

The defaults let work proceed. The owner can override any of them before the
step runs.

| ID | Decision | Default |
| :--- | :--- | :--- |
| D1 | How judges get in | A judge access code, then a judge name and password (S06). Judges need no Google or GitHub account and no email delivery. Google and GitHub stay for the owner and invited users. |
| D2 | Can judges publish apps? | No. Judge accounts see "Publishing is turned off for judge accounts. Everything else works the same." |
| D3 | Build model | Decide from evidence: the G2 screen plus one live build on Nemotron 3.5 Super (S03, S11). Switch only if it meets the bar in S11. GLM-5.3-Flash stays the fallback. |
| D4 | Judge limits | Per judge account: 3 projects, 3 builds started per 24 hours, 300 Caddie messages per 24 hours. At most 40 judge accounts. Judge access closes 2026-12-16. Retune after S11 measures a real build's cost. |
| D5 | Public repo | The owner creates the GitHub repo (account, name), makes it public, and gives the MIT copyright name. |
| D6 | Production | The owner provides: the Cloudflare account on the paid Workers plan, the domain, the secrets, and a spend ceiling for 10-26 to 12-16. The owner also confirms the sandbox stays available through 12-15 (the compliance matrix in `nebius-forge-eval` marks the beta end date UNKNOWN). |

| Gate | What | Cost bound |
| :--- | :--- | :--- |
| G1 | Model probe: `GET /v1/models?verbose=true` (free) plus 3 chat requests (already authorized in the hackathon draft). | < $0.01 |
| G2 | Build-model screen: one builder turn sent to Nemotron 3.5 Super and to GLM-5.3-Flash, twice each. | < $0.10 |
| G3 | The owner pushes `main` to the new public repo. | — |
| G4 | Production deploy, remote D1 migrations, production secrets. | per D6 |
| G5 | Live runs on production: smoke suite, judge rehearsal, golden-path builds, video takes. | per D6 |

---

## 3. Schedule

| Dates (WAT) | Packets | Exit |
| :--- | :--- | :--- |
| 10-19 → 10-20 | S01, S02, S03 (G1, G2), S04, S05 | `main` holds everything; full gate green |
| 10-21 → 10-23 | S06, S07, S08, S09 (G3) | judges can get in locally; repo public |
| 10-24 → 10-26 | S10 (G4), S11 (G5) | production smoke and judge rehearsal LIVE VERIFIED |
| 10-27 → 10-29 | S12, S13 | video uploaded; Devpost draft complete by 10-29 18:00 |
| 10-30 | the owner submits before 18:00 WAT | — |

The critical path is D6. If the production inputs aren't in by 10-24, S10 and
S11 slip. The video can then be recorded on a local build with live models
and the live sandbox (S12), but the hosted demo URL is still mandatory.

---

## 4. Phase A — safety net, models, merge

### S01 Verification net (remediation draft R01)

Goal: every test runs in CI and in the release check, and no test file can be
left out again.

1. Move the packet table into `scripts/packet-list.ts`, exporting
   `PACKET_MAP` and `PACKET_KEYS`. `verify-packet.ts`, `release-check.ts` and
   CI all read it. Add `bun scripts/verify-packet.ts --all`: it runs every
   packet and prints a summary. CI calls `--all`. No literal packet list may
   remain: `grep -rn "P15d" .github scripts` finds only `packet-list.ts` (plus
   the vestigial `(P15d)` tag in a comment in `scripts/capture-android.ts`,
   which is not a packet list — strip it if the grep must be exact).
2. Add a completeness test, `tests/packet-completeness.test.ts`, in its own
   packet (`NET`). Every `tests/*.test.ts`, `tests/browser/*.spec.ts` and
   `tests/live/**/*.spec.ts` must appear in at least one packet, and every
   mapped path must exist. "At least one" not "exactly one": 10 files are
   currently the evidence for two packets each (for example
   `tests/browser/workspace.spec.ts` for P06 and U01); deduplicating them
   would silently drop coverage. Also assert that a mapping's category
   matches the file's directory (a `.spec.ts` run by `bun test` is a bug).
   Prove it: unmap one file, watch it fail, restore; and map a file that does
   not exist (`tests/live/github.spec.ts`), watch it fail, restore.
3. Map every unmapped file (76 tests and 6 specs at writing). Regenerate the
   list at execution time:
   ```sh
   for f in tests/*.test.ts tests/browser/*.spec.ts tests/live/*.spec.ts tests/live/stacks/*.spec.ts; do
     grep -qxF "$f" scripts/packet-list.ts || echo "$f"; done
   ```
   (`-x` and `-F`, or `tests/x.test.ts` matches `tests/xx.test.ts`. The glob
   list must include `tests/live/stacks/*.spec.ts`, which the original one-file
   glob missed.)
   Suggested new packets:
   - PUBLISH: publish, dispatch-worker, published-entry,
     cloudflare-app-host.contract, outbound-policy, web-risk, report-page,
     operator.
   - KEYS: secret-box, app-secrets, app-keys-routes.
   - VERSIONS: code-versions, code-store-artifacts, versions, repo-start,
     import-preview, github-source, source-export.
   - APPS: app-ai, app-sign-in, preview-runtime,
     preview-runtime.integration, interactive-preview.spec.
   - BUILD: build-workflow, build-activity, build-timeline,
     sandbox-durability, single-recipe, plan-features, workflow-dispatch,
     stopped-turn, project-workflow.spec.

   Map the rest to the existing U/B packets, using each file's header
   comment to decide which.
4. Unmap `tests/live/github.spec.ts` from P08. Add it to the
   intentionally-absent list in `docs/release-evidence.md`: a real one needs a
   registered GitHub App, which is owner-gated.
5. In the release check, add a `PROVISIONED` status: credentials are present
   but no live run was recorded. It never counts toward PASS. Only a recorded
   `bun run test:live` receipt may produce PASS — `verify-packet --live` writes
   one to `docs/live-receipts.json` after every mapped live spec of a packet
   passes, and the release check reads that file.
6. Fix the doc counts. `docs/plans/2026-10-03-fresh-build/README.md` says 22
   migrations; read the real number off the directory. Re-verify the
   feature-ledger counts the remediation draft flags (shell-v2, discovery).
   Delete the gitignored debris: `full-test.log`, `single-int.log`,
   `test-results/`.

Acceptance: `verify-packet --all` passes; the completeness test fails when a
file is unmapped; the release check reports PROVISIONED, not PASS, for gates
that only have credentials. LOCAL VERIFIED.

### S02 Report rate-limit key (one slice of remediation draft R06)

`apps/app/src/server/routes/report.ts:140` keys the reporter-IP HMAC with
`BETTER_AUTH_SECRET`, falling back to the literal `'caddie-report'` when the
secret is missing (`:183` passes the raw secret).

- Derive a purpose-specific key the way `appAuthSecret` does
  (`apps/app/src/server/app-sign-in.ts:168`): HMAC(`BETTER_AUTH_SECRET`,
  `caddie-report-ratelimit:v1`). Don't add a new secret for the owner to set.
- Remove the literal fallback. With a missing or short secret, the report
  endpoint answers 503 in plain words.
- Extend `tests/report-page.test.ts`: the same IP gives the same hash; a
  different purpose label gives a different key; a missing secret gives 503.

### S03 Models: probe first, then the registry (hackathon draft H01)

1. **G1 probe**, in a new `scripts/probe-models.ts`. It reads
   `NEBIUS_API_KEY` from `.dev.vars` without printing it and refuses to run
   unless `CADDIE_LIVE_AUTHORIZED=1`. It prints only status, latency, token
   usage and whether tool calls came back, never the key and never full
   outputs.
   - `GET /v1/models?verbose=true`: record the exact model ids, prices and
     context windows. The draft writes `nvidia/Nemotron-3.5-Super-VL` but
     `nvidia/Nemotron-3_5-Lightning`; the code uses only ids the listing
     returns.
   - Super-VL, text plus the `remember` tool, `tool_choice: auto`: expect
     HTTP 200 and a tool call.
   - Super-VL, the split red/blue PNG plus the tool: expect both colours
     named and a tool call.
   - Lightning, the `rules-reading.ts` system prompt on a short rules excerpt
     (temperature 0): expect valid `{"claims":[...]}`.
2. **G2 screen** (needs the owner's OK). Send one builder turn to Super and
   to GLM, twice each: the template's file list, one feature spec, and the
   builder's real tool schemas. Record valid tool calls, files written and
   obvious errors. This only screens; S11's live build decides D3.
3. **Registry**, in `apps/app/src/agents/providers.ts`:
   - Add routes `nemotron-3.5-super-vl` and `nemotron-3.5-lightning`, shaped
     like the existing `nemotron-3-super` entry (line 84), with prices from
     the listing.
   - Update `nemotron-3-ultra`'s context window and max tokens per the
     listing.
   - Keep the `nemotron-3-super` and `nemotron-3-nano` routes; stored run
     bindings refer to them.
   - Roles: `chat` → super-vl, `ideation` → ultra, `helper` → lightning,
     `app` → lightning, and a new `appSuper` → super-vl.
   - `vision` → super-vl only if the image probe passed; otherwise keep
     `glm-5.3-flash`. Set `VISION_ROUTE_IDS` to match.
   - `plan` and `build` stay on `glm-5.3-flash` until D3 says otherwise.
   - `COORDINATOR_MODEL_ROUTE` (`apps/app/src/client/coordinator.ts:31`)
     equals `MODEL_ROLES.chat`.
4. Tests: `tests/providers.test.ts` (routes present, the role table, the stale
   description at line 54), `tests/attachments.test.ts` (expected route ids),
   and anything else that pins the chat route.
5. Record the G1 and G2 receipts in the execution ledger, with no secrets.
   Label LIVE VERIFIED only what the probes actually exercised.

No benchmark numbers enter code or docs in this packet. The README may quote
only numbers with a public source link.

### S04 Fast and deep AI for apps (hackathon draft H01.3)

1. In `apps/app/src/server/app-ai.ts`:
   - `readRequest` (line 65) accepts `tier?: 'fast' | 'super'`. Anything else
     returns `invalid_request` with "Choose tier "fast" or "super"."
   - `runAppAi` (121) picks
     `findModelRouteForRole(tier === 'super' ? 'appSuper' : 'app')`.
   - `reservationFor` (89) reserves against that route, with output capped at
     4,096 tokens.
   - The request's `max_tokens` (line 170) becomes
     `Math.min(route.maxTokens, 4096)`.
   - Usage rows record the route actually used.
2. In the template, `CaddieAiRequest` (`stacks/react-hono/server-files.ts`,
   around line 115) gets `tier?: "fast" | "super"` with a one-line comment.
   Then run `bun scripts/refresh-scaffold-lock.ts` and `--check`.
3. Builder guidance, in the `c.env.CADDIE.ai` line of
   `apps/app/src/agents/specialists.ts` (around line 100): leave `tier` out
   for everyday replies; use `tier: "super"` when a feature needs deeper
   reasoning.
4. Tests, in `tests/app-ai.test.ts`:
   - The default and `fast` call Lightning.
   - `super` calls Super-VL with `max_tokens` 4096 and records
     `nemotron-3.5-super-vl`.
   - A bad tier is refused.
   - A `super` call reserves at Super's price, so the allowance runs out about
     3.75× sooner.

### S05 Merge to `main` (hackathon draft H02)

After S01–S04 are green:

1. Run the full gate: `refresh-scaffold-lock --check`, typecheck, build,
   test, `verify-packet --all`, `release-check`.
2. Merge locally: `git checkout main && git merge --no-ff feat/publish-on-cloudflare`.
3. Custom domains (publish stage 6) were never started. Mark it "not built;
   after the hackathon" in `docs/plans/2026-10-17-publish/README.md`.

No push: G3 belongs to the owner.

---

## 5. Phase B — judges can get in; the repo can go public

### S06 Judge sign-in without Google or GitHub (D1)

Judges shouldn't need a Google or GitHub account. Also, a Google sign-in app
left in "Testing" mode admits only the test users listed for it.

**Owner inputs** (secrets/vars; never in the repo, README or Devpost text
outside the testing-instructions field):

- `JUDGE_ACCESS_CODE`: random, at least 16 characters.
- `JUDGE_ACCESS_UNTIL`: `2026-12-16`.
- `JUDGE_ACCESS_MAX_ACCOUNTS`: `40`.

With no code set, judge access is off and the sign-in panel shows no judge
option.

**What judges see:**

- The sign-in panel keeps Google and GitHub and adds a quiet link:
  "Judging the hackathon? Use your access code".
- First visit: access code, a judge name (letters, numbers, dashes) and a
  password (at least 10 characters), then "Start judging". They arrive signed
  in.
- First run: at most one onboarding screen. Prefill what Caddie can (for
  example, the time zone from the browser).
- Returning, on any device: "Sign in as a judge" with judge name and
  password.
- Plain errors: wrong code, code expired, all judge places taken, name taken,
  wrong name or password.

**Server:**

1. Migration **0033**, `judge_accounts`: `userId`, `judgeName` (unique),
   `createdAt`, `lastSignInAt`.
2. Turn on Better Auth email/password for judge accounts only.
   - Each judge account gets a synthetic email,
     `<judge-name>@judges.caddie.invalid`. The client maps a judge name to
     that address.
   - `.invalid` can never be a real Google or GitHub email, so OAuth account
     linking can never attach to a judge account, and no email is ever sent.
   - Passwords live in Better Auth's existing `account.password` column. The
     identity tables don't change; the "installed Better Auth needs no new
     identity tables or columns" test confirms it.
3. Judge accounts are created only through Caddie's own route, for example
   `POST /api/judge/start`.
   - It checks the code (constant-time comparison), the date, the account
     count and the name rules.
   - It then creates the user through Better Auth's own sign-up and returns
     its session cookie.
   - Direct `/api/auth/sign-up/email` stays refused for everyone. Use a
     `hooks.before` guard, or `disableSignUp` with server-side creation.
     Verify which works on 1.7.10 using the in-process probe pattern in
     `tests/auth.integration.test.ts`.
4. The invite gate in `databaseHooks.user.create.before` admits a
   `@judges.caddie.invalid` email only while a judge start for that exact name
   is in progress (a row the route writes just before sign-up). Everything
   else is unchanged.
5. Email/password sign-in accepts only judge emails.
6. Rate-limit judge start and judge sign-in by IP. Reuse S02's key
   derivation with its own label.
7. The publish routes refuse judge accounts (D2) with "Publishing is turned
   off for judge accounts. Everything else works the same." Today the
   confirmed-email rule would refuse them anyway, but with a message judges
   can't act on.

**Tests** (each one fails first):

- On the real migrations, with Better Auth in-process:
  - The right code creates an account and a session.
  - A wrong, expired or used-up code is refused, and so is a taken name.
  - Direct sign-up is refused.
  - Password sign-in is refused for a non-judge email.
  - A Google/GitHub sign-in with an uninvited email is still refused
    (regression).
  - A judge account can't publish.
- If cookies can't be exercised in-process, add the cases to the workerd auth
  fixture.
- A new browser spec, mapped in S01's table, at desktop and 390px: the judge
  link, first visit, sign-out, then signing back in with name and password.

**Docs:** add the owner inputs to `docs/setup/owner-inputs.md`, and a "Judge
access" section to `docs/setup/auth.md`.

### S07 Judge limits (D4)

Per §1, nothing is metered, so these are count-based, apply to judge accounts
only, are checked on the server and are explained in plain words.

- **Projects:** creating a 4th project is refused.
- **Builds:** starting a 4th build within 24 hours is refused. Count the build
  starts across the account's projects. Check every path that starts a build
  (plan approval, design approval, Retry) and refuse before any sandbox or
  model work.
- **Messages:** the 301st Caddie message within 24 hours is refused. Check at
  the route that admits a user message to a coordinator conversation, before
  the Flue turn starts.
- **Settings and kill switch:** values come from env, with the D4 defaults.
  `JUDGE_ACCESS_ENABLED=0` stops new judge starts immediately.
- **Tests:** one per limit, plus "the owner and invited users are never
  limited".
- **README:** the "For judges" section states the limits (never the code).

### S07b (optional, only if S06–S07 land by 10-22) A finished example in every judge workspace

Judges get a working app in their first minute, before they start their own.

- At judge start, copy the owner's chosen demo project's newest checked
  version into a new project in the judge's workspace. Reuse
  `recordCodeVersion`, and `storeImportedOutput` (from
  `apps/app/src/server/build-workflow.ts`) or the copied-app preview path.
- The project card then shows it ready to try.
- The owner picks the demo project (an env var with its project id).
- No new migration.

### S08 LICENSE, README, licence audit (hackathon draft H05)

1. `LICENSE`: MIT, "Copyright (c) 2026 <owner's name, from D5>".
2. Licence audit. A new script, `scripts/license-audit.ts`, lists the licence
   of every production dependency (apps/app, packages/*, the react-hono
   template, workers/*) from `node_modules/*/package.json`. It flags anything
   not MIT, Apache-2.0, BSD, ISC or 0BSD and writes `docs/licenses.md`. The
   rules have an IP section, and the compliance matrix marks this UNKNOWN.
3. `README.md`, written for judges. Every claim that isn't LIVE VERIFIED gets
   its label. Sections:
   - **What Caddie is:** Find → Plan → Build → Prove → Ship, with screenshots
     from real runs.
   - **For judges:** the demo URL; "use the access code in the Devpost testing
     instructions"; the limits; a two-minute path to try.
   - **Nebius Token Factory and NVIDIA Nemotron:** the role table as built
     after S03/D3, with model ids from the listing, and the file paths of the
     runtime call sites.
   - **The sandbox and Caddie's checks:** build_next_feature → run_checks →
     finish_feature → verify_build plus the runs-on-Cloudflare check; a
     model's own claims never count.
     - Name the sandbox the way the rules do only after confirming (Nebius
       docs or the rules FAQ) that the sandbox Caddie uses
       (`CONTREE_BASE_URL`) is what the rules call Token Factory Sandboxes.
     - If it isn't, tell the owner before submission. The Coding track text
       says "write, run, and test code in Token Factory Sandboxes".
   - **Tavily (bonus award):** the `/search` and `/extract` call sites and
     what they feed.
   - **What changed during the submission period:** caddie-forge's first
     commit is 2026-10-03, a ground-up rebuild of the earlier caddie concept.
     List the big parts with dates from `git log`.
   - **Status table:** LIVE VERIFIED, LOCAL VERIFIED, SIMULATED and not built
     (publishing unless S10 turns it on, custom domains, …).
   - **Run it locally:** test commands. Read numbers (migrations, tests) off
     the repo at writing time, never from plans.
4. Never put the judge code, secrets or a personal email address in the repo.

### S09 Make the repo safe to publish (then G3)

1. **History scan:** no secret was ever committed.
   - Use `gitleaks detect --log-opts=--all` if it's installed. Otherwise grep
     `git log --all -p` for `sk-`, `ghp_`, `github_pat_`, `AKIA`,
     `PRIVATE KEY`, `NEBIUS`, `TAVILY`, `CONTREE_API_TOKEN=`, `RESEND`,
     `BETTER_AUTH_SECRET=`.
   - Confirm `.dev.vars` and `.env` never appear in
     `git log --all --name-only`.
   - If any secret ever landed, **stop**. The owner rotates it and decides on
     rewriting history, which is destructive and the owner's call alone.
2. Check that nothing was copied from `/Users/captjay98/projects/caddie` or
   `/Users/captjay98/projects/nebius-forge-eval` beyond what `AGENTS.md`
   allows.
3. **G3:** the owner creates the public repo, adds the remote and pushes
   `main`. From then on the agent may push feature branches only.
4. CI now runs on GitHub. Confirm the first run on `main` is green
   (`gh run list --branch main`) and fix anything environment-specific.

---

## 6. Phase C — production

### S10 Production deploy (G4; the owner runs it or authorizes each step)

**Owner prerequisites (D6):**

- Cloudflare paid Workers plan (Worker Loader runs the previews of apps with
  a server).
- The D1 database created, with its id in `apps/app/wrangler.jsonc` (an
  integration-lead file).
- The domain or route.
- Google sign-in: consent screen set to "In production", with the production
  callback URL. GitHub sign-in: the production callback URL.
- Secrets set with `wrangler secret put`, per `docs/setup/owner-inputs.md`:
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_*`, `GITHUB_*`,
  `NEBIUS_API_KEY`, `TAVILY_API_KEY`, `CONTREE_BASE_URL`,
  `CONTREE_API_TOKEN`, `CONTREE_PROJECT_ID`, `APP_SECRETS_KEYS`,
  `INVITE_ALLOWLIST` (the owner's email), `OPERATOR_EMAILS` and
  `JUDGE_ACCESS_*`. Optional: `RESEND_*`, `WEB_RISK_API_KEY`, the publishing
  config.
- A Nebius spend alert.
- Confirmation that the sandbox stays available through 12-15.

**Steps:**

1. `bun run build`.
2. `wrangler d1 migrations apply <db> --remote`.
3. `wrangler deploy` (from `apps/app`).

Publishing through Workers for Platforms goes live only if the owner wants it
for judging. Otherwise the Publish card says publishing isn't set up, and the
README says the same.

**Evidence:** the deployment URL and version id in
`docs/release-evidence.md`.

### S11 Live verification on production (G5)

1. **Smoke suite:**
   `CADDIE_LIVE_AUTHORIZED=1 CADDIE_RELEASE_URL=<url> bun run test:live -- P17`,
   with receipts.
2. **Judge rehearsal**, in a clean browser profile, at desktop and 390px:
   1. Judge start.
   2. Find (Tavily).
   3. Brainstorm (Ultra).
   4. Plan and design (GLM).
   5. Approve.
   6. Build in the sandbox.
   7. Preview with a server (relay).
   8. App AI, fast and super.
   9. Sign-in through the test inbox.

   Record each step's outcome, time, and model/token use.
3. **Cost of one full build:** tokens × listing prices. Set the D4 limits so
   40 judges at full daily use stay under the D6 ceiling, and write the
   arithmetic into the ledger.
4. **D3:** run the same build with `build` → `nemotron-3.5-super-vl`, on a
   branch, not `main`.
   - Switch on `main` only if it finishes every feature with checks passing
     inside the 150-step budget, at no worse than about 1.5× GLM's time and
     cost.
   - Record both runs. The README's model table follows the result.
5. **Uptime:** an hourly check of the demo URL through 12-16 that alerts the
   owner (a Kiro Crew cron or an external monitor; the owner chooses).

---

## 7. Phase D — demo and submission

### S12 Golden-path video (at most 2:45; hackathon draft H06)

- Follow the hackathon draft's H06 script, cut to what S11 proved live:
  1. Find with Tavily and Lightning.
  2. Brainstorm with Ultra.
  3. Plan and design.
  4. The sandbox feature loop.
  5. The full-stack preview, in-app AI (fast and super), and
     Versions/Keys/Publish.
- **Narration** names Nebius Token Factory, NVIDIA Nemotron (3.5 Super VL,
  3.5 Lightning, 3 Ultra), the sandbox and Tavily, in English.
- **Speed:** speed up the build segment and label it.
- **Where to record:** on production. If production isn't ready by 10-27,
  record on a local build with live models and the live sandbox, and don't
  present that recording as the hosted demo.
- **Upload** to YouTube as public or unlisted.

### S13 Devpost submission draft (the owner submits)

Write `docs/submission/devpost.md`. It never contains the code.

- Project text.
- Track selection (check whether the rules allow more than one track).
- The Tavily bonus paragraph.
- What changed during the submission period.
- The repo, demo and video URLs.
- A testing-instructions template with an `<ACCESS CODE>` placeholder. The
  owner fills it in only inside the Devpost form.
- A final checklist of the Stage One requirements (runtime Token Factory
  calls, an NVIDIA open model), each with a link to its evidence.

---

## 8. Definition of done (by 10-29, 18:00 WAT)

- **Code and CI:** `main` is what's deployed. CI is green on GitHub.
  `verify-packet --all`, the full suite and the build are green. The
  completeness test is mapped and passing.
- **Production:** the smoke suite is LIVE VERIFIED. The judge rehearsal is
  LIVE VERIFIED at desktop and 390px. The judge limits are active.
- **Repo:** public, with `LICENSE` and `README.md`. The licence audit is clean,
  or every flagged item is resolved.
- **Submission:** the video is uploaded. The Devpost draft is ready, and the
  owner has put the access code in the testing instructions.

---

## 9. Deferred until after submission

From the remediation draft (wide refactors that judges never see, landing just
when the demo must be stable):

- R02: shared helpers.
- R03: split `discovery.ts`, `repositories.ts`, `surface.tsx` and
  `Chrome.tsx`.
- R04: narrow `CoordinatorHostContext`.
- R05.1: render claims proven by browser specs.
- R05.2: 24-hour live authorization.
- The rest of R06: row mappers and the `resolveAppSecrets` naming.
- R07: full documentation reconciliation.

From the publish programme:

- Custom domains (stage 6).
- Other stacks for "Start from my GitHub repo".
- GitHub save from the code store.
- Feature-level versions.

Also deferred: email sign-in for everyone, not just judges.
