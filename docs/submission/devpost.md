# Caddie — Devpost submission draft (S13)

**This file is a draft the owner pastes from. Nothing here is submitted
automatically, and the owner submits.** It deliberately contains no access
code — the code goes only into the Devpost form's testing-instructions field.

Anything in angle brackets is a **placeholder that does not exist yet**. Do not
replace a placeholder with an invented value.

| Placeholder | What the owner must supply |
| :--- | :--- |
| `<REPO-URL>` | The public GitHub repository URL. **The repo does not exist yet** (D5/G3; no remote is configured). |
| `<DEMO-URL>` | The hosted demo URL. **Deployed and live-verified:** production runs at `https://caddie.jamalibrahim.dev` (owner-gated deploy, S10/G4), and the P17 hosted acceptance smoke is **LIVE VERIFIED** there — `tests/live/release.spec.ts` 5/5 PASS, `docs/live-receipts.json` receipt `lr_5bf0b08f5db1bbcb` (deploy 2026-10-22, commit `5f3574a`). The owner still confirms the exact URL to paste into the Devpost form. |
| `<VIDEO-URL>` | The YouTube URL of the uploaded demo video (public or unlisted). **Not recorded yet** — see `docs/submission/video-script.md`. |
| the judge access code | Filled in **only** in the Devpost form's testing-instructions field, never in this repo. The placeholder for it lives solely in the testing-instructions template in §6. |

---

## 1. Project text (for judges)

Caddie is an evidence-backed build assistant for hackathons and small projects.
It runs as a single Cloudflare Worker built on Flue agents (Durable Objects), a
D1 database, a React SPA under `/app`, and a static landing page at `/`. The
loop is **Find → Plan → Build → Prove → Ship**:

- **Find** reads live opportunity sources — Devpost's public open-contests API
  plus a **Tavily** multi-platform web sweep — and ranks them, keeping every
  claim it rests on. A failed retrieval shows as a visible gap, not a guess.
- **Plan** turns a contest's rules page into an immutable snapshot with
  verbatim, line-cited claims, then produces a versioned scope, PRD and spec,
  and binds approval to the exact revision.
- **Build** delegates to restricted specialists (product, designer, tech-lead,
  frontend, backend, mobile, QA) that write code inside an isolated sandbox.
- **Prove** has the **host**, not the model, run the checks: install, run the
  project's tests, build the browser bundle, and — for apps with a server — a
  check that the server actually boots on Cloudflare's runtime. Success is a
  recorded machine receipt.
- **Ship** prepares a submission checklist and a one-click Cloudflare publish
  path. Caddie never submits or publishes for you; it stops and hands you the
  evidence.

**How it uses Nebius Token Factory and NVIDIA Nemotron.** Every model call goes
to Nebius Token Factory's OpenAI-compatible endpoint
(`https://api.tokenfactory.nebius.com/v1`), registered as the `nebius` provider
in `apps/app/src/agents/providers.ts` and installed once per isolate by
`registerNebiusProvider()` (`apps/app/src/app.ts`). Caddie routes each job to a
model by role:

| Role | Route id | Nebius model id | Runtime call site |
| :--- | :--- | :--- | :--- |
| `chat` / coordinator | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `apps/app/src/agents/coordinator.ts` |
| `ideation` (brainstorm) | `nemotron-3-ultra` | `nvidia/Nemotron-3-Ultra-550b-a55b` | `apps/app/src/agents/coordinator.ts` (Home) |
| `plan` (PRD, design) | `glm-5.3-flash` | `zai-org/GLM-5.3-Flash` | `apps/app/src/agents/specialists.ts` (planning specialists) |
| `build` (coding + QA) | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `apps/app/src/agents/specialists.ts`, `apps/app/src/server/build-workflow.ts` |
| `helper` | `nemotron-3-nano` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | `apps/app/src/server/rules-reading.ts`, `candidate-inspection.ts` |
| `app` (in-app AI, fast) | `nemotron-3.5-lightning` | `nvidia/Nemotron-3_5-Lightning` | `apps/app/src/server/app-ai.ts` |
| `appSuper` (in-app AI, super) | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `apps/app/src/server/app-ai.ts` |
| `vision` | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `apps/app/src/agents/coordinator.ts`, `attachments.ts` |
| `architect` (team mode: architecture review) | `nemotron-3-ultra` | `nvidia/Nemotron-3-Ultra-550b-a55b` | `apps/app/src/agents/specialists.ts` (architect delegate), `apps/app/src/server/architecture-review.ts` |

So Caddie uses four NVIDIA Nemotron tiers — **Nemotron 3 Ultra** for
brainstorming, **Nemotron 3.5 Super VL** for the coordinator conversation, the
coding-and-QA build loop and vision, **Nemotron 3.5 Lightning** for in-app AI,
and **Nemotron 3 Nano** for the fast rules-reading helper — plus GLM-5.3-Flash
for the PRD and design planning step, all through Token Factory. Building and QA
moved to Super VL on 2026-10-20 (the cheap Flash route produced small,
fixture-shaped apps); planning keeps GLM. The model ids are the exact
case-sensitive listing spellings (`Nemotron-3.5-…` with a dot,
`Nemotron-3_5-Lightning` with an underscore).

**The sandbox.** Generated code runs in an isolated sandbox reached over an HTTP
sandbox API (`apps/app/src/server/build-sandbox.ts`,
`apps/app/src/server/adapters/sandbox.ts`, REST client in
`apps/app/src/server/adapters/contree.ts`). The base URL, token and project
come from the deployment's environment (`CONTREE_BASE_URL`,
`CONTREE_API_TOKEN`, `CONTREE_PROJECT_ID`); sessions boot from the
`tag:tt-base:1` image (`docs/setup/sandbox.md`). The host enforces the build
loop so a model's own claims never count: `build_next_feature` → `run_checks`
→ `finish_feature` (which requires the feature to have added new *passing*
tests over its baseline) → `verify_build`.

**Code runs in Token Factory.** The Coding track asks for "agents that write,
run, and test code in Token Factory". Caddie's sandbox API is
`https://api.tokenfactory.nebius.com/sandboxes`, on the same Token Factory
account that serves its models, and builds install, build and test the
generated code there. The starting template did that live on 2026-10-19; a full
build driven by Caddie's agents has not been run live yet.

**Honest status.** The app is a working build that makes real runtime calls to
Token Factory and runs the pipeline locally and in recorded live runs. The
**hosted demo is deployed at `https://caddie.jamalibrahim.dev`** and its P17
hosted acceptance smoke is **LIVE VERIFIED** (5/5 PASS, receipt
`lr_5bf0b08f5db1bbcb`, deploy 2026-10-22). Publish (Workers for Platforms) is
still **not** live-verified. The README's status table records each surface at
its real status rather than implying otherwise. Full labels are in §7.

<!--
  SOFTWARE-TEAM MODE: not shipped. The team-mode build programme
  (docs/plans/2026-10-22-software-team-mode.md) is decided on Tuesday
  2026-10-27 against section 10's go/no-go marks. Its description goes here
  ONLY after that decision, and only for what actually passed. Describe
  nothing that isn't built. Leave this comment until then.
-->

---

## 1a. Feedback on Nebius Token Factory and NVIDIA models

The hackathon asks entrants for feedback on Token Factory and the NVIDIA
models. Every point below is drawn from this repo's own recorded runs, with
the date it was observed; nothing here is a general impression.

**What worked**

- **Super VL's tool calls in the build loop (2026-10-18, 2026-10-20).** The
  2026-10-18 listing probe (`GET /v1/models?verbose=true` plus a chat probe)
  had `nvidia/Nemotron-3.5-Super-VL` return a clean tool call, and on
  2026-10-20 the coding and QA roles were moved onto it for exactly that
  reason — it drives the host's `build_next_feature → run_checks →
  finish_feature → verify_build` loop reliably where the cheaper route did
  not.
- **Super VL reads images (2026-10-18).** The same probe sent a split
  red/blue PNG with a `remember` tool: HTTP 200, both colours named, and the
  tool call returned (711 in / 260 out, 1267 ms). That is what moved the
  `vision` role onto it (`providers.ts` Super-VL entry).
- **GLM-5.3-Flash as a vision model for planning (2026-10-15).** GLM-5.3-Flash
  read both halves of the split PNG and emitted a tool call (~7 s), which is
  why it stayed the planning route and is listed in `VISION_ROUTE_IDS`.
- **Token Factory's OpenAI-compatible endpoint (recorded 2026-10-06).** One
  base URL (`https://api.tokenfactory.nebius.com/v1`) serves every role through
  the standard OpenAI completions shape, so routing eight roles across five
  models is a one-line change in `MODEL_ROLES` with no per-model client code
  (live model round-trip recorded, ledger `P05-live`).
- **One account for models and sandboxes (recorded 2026-10-06, 2026-10-19).**
  The sandbox API (`https://api.tokenfactory.nebius.com/sandboxes`) is on the
  same Token Factory account as the models; a real session + remote exec was
  recorded 2026-10-06 (release-evidence P04), and the app template installed,
  built and tested there on 2026-10-19.

**What didn't, and what we worked around**

- **Token Factory rejects the OpenAI `developer` role (observed 2026-10-06).**
  It 422s without a compatibility block, so the `nebius` provider is
  registered with `supportsDeveloperRole: false` /`supportsStore: false` /
  `maxTokensField: 'max_tokens'` (`providers.ts`).
- **Reasoning models need a generous output cap (2026-10-19).** Nemotron 3
  Nano spends tokens thinking before any output; at a 2,048-token cap the
  rules-reading probe hit the cap mid-reasoning and returned empty content
  (9,270 chars of `reasoning_content`, no answer). Raising the cap to 8,192
  fixed it. The same failure mode showed on Nemotron 3.5 Lightning at 512
  (2026-10-18).
- **Nemotron 3.5 Lightning couldn't do the structured rules-reading job
  (2026-10-20).** Tried as the `helper` model, on the real rules prompt it
  returned `finish_reason: length` with no parseable JSON even at the route's
  4,096-token output cap, and its narration came back inside `content` rather
  than `reasoning_content` (so the claim parser read null) — recorded in the
  execution ledger's 2026-10-20 `probe-lightning` run (1,482 in / 4,096 out).
  `helper` was reverted to Nemotron 3 Nano the same day. Both cost the same
  ($0.06/$0.24 per Mtok), so nothing was lost.
- **The 3.x Nemotron ids don't accept image input (2026-10-15).** Every 3.x
  Nemotron route 400s an image ("This model does not support image input");
  only the 3.5 Super VL id does. The id spellings are also inconsistent and
  case-sensitive (`Nemotron-3.5-…` with a dot, `Nemotron-3_5-Lightning` with
  an underscore), which had to be read from the live listing rather than
  guessed.
- **The sandbox base image's Bun can't unpack some tarballs (2026-10-19).**
  On `tag:tt-base:1` (Bun 1.4.2), `bun install` failed to extract react-dom.
  The fix downloads each `bun.lock`-pinned tarball, checks its sha512, and
  unpacks it with GNU `tar` before the unchanged `bun install
  --frozen-lockfile` runs (`verified-install.ts`, LIVE VERIFIED for the
  template, 2026-10-19).

---

## 2. Track selection

**Intended tracks** (from the hackathon plan, which is a draft, not authority):

- **Coding & Agentic Engineering** — agents that write, run and test code.
- **Best Apps & Agents** — an app or agent someone would use.
- **Tavily $3,000 Bonus Award** — the bonus for functional runtime Tavily use
  (§3).

> **Owner to confirm on Devpost (required).** This repo cannot establish the
> current Devpost rules, so it cannot say whether a submission may be entered
> into **more than one track**. The owner must check the current rules on
> Devpost and select the track(s) accordingly. If only one may be chosen, the
> Coding & Agentic Engineering track is the primary fit (the product's value is
> an agent that plans, builds, tests and iterates on a real project); Best Apps
> & Agents is the secondary fit. The Tavily bonus is separate.

---

## 3. Tavily bonus paragraph

Tavily is Caddie's search provider and is used as an integral part of the
workflow, through a single client — `apps/app/src/server/tavily.ts` — with one
typed wrapper per endpoint:

| Tavily endpoint | Wrapper | Call sites | What it feeds |
| :--- | :--- | :--- | :--- |
| `POST https://api.tavily.com/search` | `tavilySearch` | `apps/app/src/server/discovery.ts` (a multi-platform sweep scoped to `devpost.com`, `devfolio.co`, `mlh.io`, `hackerearth.com`, `dorahacks.io`, `ethglobal.com`, `kaggle.com`), `apps/app/src/server/coordinator-context.ts` (`researchForActor`, Caddie's research tool) | The **Find** feed's candidates, de-duplicated and filtered to real, open event pages; and cited research findings for a chat answer. |
| `POST https://api.tavily.com/extract` | `tavilyExtract` | `apps/app/src/server/rules-reading.ts` (contest rules pages), `apps/app/src/server/coordinator-context.ts` (a URL the user names) | Immutable page snapshots that are then read for **verbatim, line-cited claims** — the eligibility verdicts, deadlines and constraints the rest of the product reasons over. |

Failures are visible rather than silent: a missing `TAVILY_API_KEY` raises
`TavilyNotConfiguredError`, discovery records a named feed gap, and the research
tool tells the user research is off instead of inventing an answer. Parallel is
not used.

**Status.** The two endpoints were **LIVE VERIFIED** on 2026-10-12 by a guarded
live probe through the real discovery adapter (15 genuine contests, 0 help/docs
noise after filtering; both endpoints exercised); the call sites and error paths
are additionally covered by `tests/tavily.test.ts` (LOCAL VERIFIED). Evidence:
execution ledger 2026-10-03 fresh-build entry for **P11**
(`docs/plans/2026-10-03-fresh-build/execution-ledger.md`).

---

## 4. What changed during the submission period

Caddie-forge is a ground-up rebuild, not a continuation of the earlier `caddie`
concept; no history was carried over. Read from this repository's own `git log`
(347 commits as of 2026-10-19; first commit **2026-10-03**):

| Date(s) | What landed |
| :--- | :--- |
| **2026-10-03** | First commit: the fresh-build plan, then bootstrap and frozen shared contracts (P00). |
| **2026-10-04 – 10-06** | Packets P00–P17: sign-in, projects and approvals, the sandbox driver, specialists and the coordinator, previews, GitHub, discovery, judge/submission, tasks, and the extra stacks. |
| **2026-10-07 – 10-10** | Home (the project-less conversation with Caddie), five waves of UI redesign, saved hackathons, search, per-scope chat threads. |
| **2026-10-15 – 10-16** | Project-page redesign, the host-driven feature build loop, the PRD + design review step, saving source to GitHub as a PR, and model re-routing. |
| **2026-10-17** | The publish programme: app-host ports and the Cloudflare adapter, an Artifacts-backed code store, and running an app's server in a Worker Loader isolate for previews. |
| **2026-10-18** | Publishing end to end (service, `/api` routes, the Publish card, safety scan + takedowns), keys for outside services, AI inside generated apps with a per-project allowance, app sign-in, versions/restore, "Start from my GitHub repo"; then S01–S04 (one packet table with a completeness net, a purpose-specific report rate-limit key, model routing re-read from the live Nebius listing, and the fast/super app-AI tiers). |
| **2026-10-19** | S06: judges sign in with an access code, a name and a password (no Google or GitHub, no email). S07: judge limits enforced server-side: 3 projects, 3 build starts, 300 Caddie messages and 20 discovery lookups per rolling 24 hours, where `0` means none. S07b: when the deployment names a demo project (`JUDGE_EXAMPLE_PROJECT_ID`), each new judge finds a finished copy, "<Name> (example)", ready to try. Installs in the sandbox now check every package's sha512 from `bun.lock` before unpacking it, which fixed the react-dom unpacking failure on `tag:tt-base:1` (LIVE VERIFIED for the starting template). The browser acceptance suite passes (23 groups, 0 failures) and CI is set up to run it. Discover's "Why it fits" is in plain words. A pre-final review's five findings were fixed: every paid path counts against the judge limits, the project limit holds when creates race, an interrupted handoff to Caddie is re-sent instead of lost, live test receipts are tied to the code they tested, and the project Overview shows the app the build made. Caddie can also be added to a phone's home screen and opens like an app: with no connection it says it is offline, and a link shared to it from another app lands in the chat box, unsent (tested in Chromium, not yet on a phone). S08: the MIT `LICENSE`, this README and a licence audit; S10: a checked production deploy procedure. |

(The dates and counts come from `git log` in this repo. The README's "What
changed during the submission period" section is the judge-facing version of the
same table.)

---

## 5. Repo, demo and video URLs

- **Repository:** `<REPO-URL>` — **does not exist yet.**
- **Live demo:** `<DEMO-URL>` — **deployed and live-verified.** Production runs
  at `https://caddie.jamalibrahim.dev` (owner-gated deploy, S10/G4);
  `docs/release-evidence.md` records the hosted acceptance smoke (P17) as
  **LIVE VERIFIED** (`tests/live/release.spec.ts` 5/5 PASS against that origin),
  and `docs/live-receipts.json` holds the latest receipt `lr_5bf0b08f5db1bbcb`
  (deploy 2026-10-22, commit `5f3574a`). The owner confirms the exact URL for
  the Devpost form.
- **Video:** `<VIDEO-URL>` — **not recorded yet.** Upload to YouTube as public
  or unlisted. See `docs/submission/video-script.md`. If production is not
  ready, the video is recorded on a local build with live models and the live
  sandbox, and it is then **not** evidence of a hosted deployment — say so on
  screen.

Do not fill a placeholder with a guess. A wrong URL is worse than a missing one.

---

## 6. Testing instructions (template for the Devpost form)

Paste the following into Devpost's testing-instructions field and replace the
access-code placeholder (in step 3 below) with the real code **inside the form
only**. Never put the code in the repository, the README, this file's body, a
screenshot, or the video.

> **How to try Caddie**
>
> 1. Open the demo: `<DEMO-URL>`.
> 2. On the sign-in page, click **"Judging the hackathon? Use your access
>    code."**
> 3. Enter the access code: `<ACCESS CODE>`
> 4. Choose a **judge name** (3–24 characters: letters, numbers and dashes) and
>    a **password** of at least 10 characters. No Google or GitHub account and
>    no email are needed. Returning judges sign in with the same name and
>    password.
> 5. Try the loop: ask Caddie for a project idea, open **Find** to see live
>    hackathons ranked against a profile and open a contest's cited rules
>    verdict, then ask Caddie to plan a small project, approve the plan and
>    the design, and the build starts.
> 6. Your **Projects** list already has a finished example app,
>    **"<Name> (example)"**. Open it to try it right away, or ask Caddie to
>    change it.
>
> **Demo limits (so a few dozen judges can't exhaust it):** each judge account
> may have **3 projects**, start **3 builds per 24 hours**, send **300 Caddie
> messages per 24 hours**, and run **20 paid discovery lookups per 24 hours**
> (each search that calls out live, from the Discover page or in chat; browsing
> the feed and a contest's cited rules is free and uncounted). A build starts
> when you approve the design, and retrying a stopped build is another start.
> Asking for changes to a plan or a design counts as a message. There are
> **at most 40 judge accounts** in total, and **judge access closes on
> 2026-12-16**. Judge accounts cannot publish apps.

**Step 6 (for the owner):** keep it only if production sets
`JUDGE_EXAMPLE_PROJECT_ID` to one of your projects with a checked build, and
put that project's name in place of `<Name>`. Without it, delete step 6: judges
would find no example. Judges who started before it was set get none.

**Notes on these limits (not for the form, for the owner):** these are the
defaults in code — `apps/app/src/server/judge-limits.ts` (3 projects / 3 builds /
300 messages / 20 discovery lookups; `judgeLimits`), `apps/app/src/server/judge-access.ts`
(`JUDGE_MAX_ACCOUNTS_DEFAULT = 40`), and the closing date is the deployment's
`JUDGE_ACCESS_UNTIL` (`docs/setup/owner-inputs.md` records `2026-12-16` as the
default). The README's "Judge limits (plain words)" section is the same
sentence-for-sentence version. If the deployment's environment overrides any of
these, update the form to the deployed numbers.

---

## 7. Stage One requirements — evidence checklist

Stage One is pass/fail and requires **(a) runtime calls to the Token Factory
inference API** and **(b) at least one NVIDIA open-source model**. Each item
below links to its evidence in this repo and carries its exact verification
status.

### (a) Runtime calls to the Token Factory inference API — **LIVE VERIFIED** (recorded 2026-10-06)

- **Code (checkable):** `apps/app/src/agents/providers.ts` defines
  `NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1'` and
  `registerNebiusProvider()`, called from `apps/app/src/app.ts`. Call sites that
  make the actual requests: `apps/app/src/agents/coordinator.ts`,
  `apps/app/src/agents/specialists.ts`,
  `apps/app/src/server/app-ai.ts`, `apps/app/src/server/rules-reading.ts`.
- **Recorded run:** `docs/release-evidence.md` row **P05** — "Model route
  round-trip (Nebius) — LIVE VERIFIED — real coordinator model call, ledger
  `P05-live`"; and the P09 React+Hono journey. Re-probed live on 2026-10-18
  (G1 listing probe) and 2026-10-19 (`scripts/probe-lightning.ts`, ledger
  "Owner review follow-ups").
- **Caveat:** these live *model* calls were made from a local/dev origin under
  owner authorization. The hosted deployment itself is live and smoke-verified
  (P17, `https://caddie.jamalibrahim.dev`, receipt `lr_5bf0b08f5db1bbcb`), but a
  model round-trip through the hosted origin needs an interactive owner sign-in,
  so the P05 model-route receipt stays local/dev (`README.md` status table).

### (b) At least one NVIDIA open-source model — **LIVE VERIFIED** (recorded 2026-10-18)

- **Code (checkable):** `apps/app/src/agents/providers.ts` (`MODEL_ROLES`,
  `MODEL_ROUTES`) uses NVIDIA Nemotron models by role —
  `nvidia/Nemotron-3-Ultra-550b-a55b` (ideation),
  `nvidia/Nemotron-3.5-Super-VL` (chat, vision, appSuper),
  `nvidia/Nemotron-3_5-Lightning` (app),
  `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (helper).
- **Recorded run:** the 2026-10-18 G1 probe (`GET /v1/models?verbose=true` plus
  chat probes) confirmed the listing serves both
  `nvidia/Nemotron-3.5-Super-VL` and `nvidia/Nemotron-3_5-Lightning`, and that
  Super VL returned a tool call and read a split red/blue PNG (image input);
  recorded in `docs/plans/2026-10-03-fresh-build/execution-ledger.md` and noted
  in the `providers.ts` route entries.
- **Tavily bonus (separate, not Stage One):** **LIVE VERIFIED** (2026-10-12,
  ledger P11) — see §3.

### Honest gaps (state these rather than overclaim)

- **Hosted demo URL:** LIVE VERIFIED — deployed at
  `https://caddie.jamalibrahim.dev`; the P17 hosted acceptance smoke is 5/5 PASS
  (receipt `lr_5bf0b08f5db1bbcb`, `docs/release-evidence.md`).
- **Publish / Worker Loader / Cloudflare Artifacts / Web Risk on a deployed
  Worker:** implemented and locally tested, **not** live-verified on a deployed
  Worker (`README.md`; `docs/release-evidence.md`).
- **Custom domains:** NOT BUILT.
- **Licence audit:** LOCAL VERIFIED and **clean** — 24 production dependencies,
  24 allowed, 0 flagged, 0 unresolved (exit 0). The two `@fontsource/*` webfont
  packages are OFL-1.1, accepted for that package family only (`docs/licenses.md`,
  owner decision 2026-10-19).
- **The sandbox wording:** the rules say "in Token Factory", not "Token Factory
  Sandboxes" (the earlier quote was wrong; `nebius-forge-eval`'s compliance
  correction, rules re-read 2026-10-03). The sandbox API is on
  `api.tokenfactory.nebius.com`. Its availability through 2026-12-15 is not
  confirmed.

---

## 8. Before the owner submits (checklist)

- [ ] `<REPO-URL>` is public, with `LICENSE` (MIT) and `README.md` at the root.
- [ ] `<DEMO-URL>` is deployed, free, and reachable without a paywall or
      invite dead-end through the judging window.
- [ ] `<VIDEO-URL>` is uploaded, public or unlisted, under 3:00, and its audio
      names Nebius Token Factory and NVIDIA Nemotron.
- [ ] The judge access code is entered **only** in the Devpost form, and the
      code is not in the repo, README, screenshots or video.
- [ ] Track(s) selected after checking the current Devpost rules (§2).
- [ ] Re-read the live rules page: the Coding track still says code runs "in
      Token Factory" (last read 2026-10-03), and nothing new conflicts (§1).
- [ ] Nebius confirms the sandbox stays available through 2026-12-15.
- [x] The licence flags are resolved: OFL-1.1 accepted for the `@fontsource/*`
      webfont packages, audit clean (2026-10-19).
