# Caddie — Devpost submission draft (S13)

**This file is a draft the owner pastes from. Nothing here is submitted
automatically, and the owner submits.** It deliberately contains no judge
password — the shared judge name and password go only into the Devpost form's
testing-instructions field.

Anything in angle brackets is an **unconfirmed submission value**. Do not
replace a placeholder with an invented value.

| Placeholder | What the owner must supply |
| :--- | :--- |
| `<REPO-URL>` | The confirmed public GitHub repository URL. A local origin is configured, but its public accessibility and suitability as the submission target are not established here. |
| `<DEMO-URL>` | The hosted demo URL, `https://caddie.jamalibrahim.dev`. Redeployed 2026-10-30 at 15:38 UTC from commit `cbe680e` (Worker version `ddf92e7a-9a68-49cf-8775-6d2e169fc445`) onto a fresh D1 database (`caddie-v2`, 4 migrations). Hosted smoke: 4 of 5 checks pass; the landing check fails on a stale `LOCKED LINE` text assertion in the spec (see §7). The shared judge account exists on production. Sign in as the judge once more before submitting. |
| `<VIDEO-URL>` | The YouTube URL of the uploaded demo video (public or unlisted). **Not recorded yet** — see `docs/submission/video-script.md`. |
| the shared judge name and password | Filled in **only** in the Devpost form's testing-instructions field, never in this repo. The placeholders live solely in the testing-instructions template in §6. |

---

## 1. Project text (for judges)

Caddie is an evidence-backed build assistant for non-technical owners, built
on **Nebius Token Factory** and **NVIDIA Nemotron**. Every model call goes
through Token Factory, and the code Caddie writes is installed, built and
tested in Token Factory's sandbox. The loop is **Find → Plan → Build → Prove →
Ship**:

- **Find** reads live opportunity sources — Devpost's public open-contests API
  plus a **Tavily** multi-platform web sweep — and ranks them, keeping every
  claim it rests on. A failed retrieval shows as a visible gap, not a guess.
- **Plan** turns a contest's rules page into an immutable snapshot with
  verbatim, line-cited claims, then produces a versioned scope, PRD and spec,
  and binds approval to the exact revision. You then pick a look for the app.
- **Build** delegates to restricted specialists (product, designer, tech-lead,
  frontend, backend, mobile, QA) that write code inside an isolated sandbox.
  A first version holds at most 3 parts; the rest are added later with
  **Add this**.
- **Prove** has the **host**, not the model, run the checks: install, run the
  project's tests, build the browser bundle, check that an app's server boots
  on Cloudflare's runtime, and then run each part's own checks in a real
  browser on a brand-new account. Success is a recorded machine receipt.
- **Ship** prepares the hand-in list from the contest's own rules. Caddie
  never submits or publishes for you; it stops and hands you the evidence.

The product is hosted as one Cloudflare Worker (Flue agents on Durable
Objects, D1, a React app under `/app`, and a landing page at `/`).

**What NVIDIA Nemotron does in Caddie.** **Nemotron 3.5 Super VL** holds the
conversation and understands images you attach. **Nemotron 3 Ultra**
brainstorms what to build with you and reviews the architecture of big apps.
**Nemotron 3 Nano** reads contest rules into cited claims, ranks hackathons and
writes their summaries. The AI inside every app Caddie builds runs on
**Nemotron 3.5 Lightning** (fast) or **Nemotron 3.5 Super VL** (the deeper
tier). Writing the plan, the looks and the code goes to other open models on
the same Token Factory account (DeepSeek, GLM, MiniMax), picked from measured
runs.

**How it uses Nebius Token Factory.** Every model call goes to Token Factory's
OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1`),
registered as the `nebius` provider in `apps/app/src/agents/providers.ts` and
installed once per isolate by `registerNebiusProvider()`
(`apps/app/src/app.ts`). Caddie routes each job to a model by role
(`MODEL_ROLES`, `MODEL_ROUTES`):

| Role | Route id | Nebius model id | Runtime call site |
| :--- | :--- | :--- | :--- |
| `chat` (Caddie's conversation) | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `apps/app/src/agents/coordinator.ts` |
| `ideation` (brainstorm) | `nemotron-3-ultra` | `nvidia/Nemotron-3-Ultra-550b-a55b` | `apps/app/src/agents/coordinator.ts` (Home) |
| `architect` (team mode: architecture review) | `nemotron-3-ultra` | `nvidia/Nemotron-3-Ultra-550b-a55b` | `apps/app/src/agents/specialists.ts` (architect delegate) |
| `vision` | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `apps/app/src/server/attachments.ts` |
| `helperRules` (rules reading) | `nemotron-3-nano` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | `apps/app/src/server/rules-reading.ts` |
| `helperRanking` (hackathon ranking) | `nemotron-3-nano` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | `apps/app/src/server/candidate-inspection.ts` |
| `helperSummary` (hackathon summaries) | `nemotron-3-nano` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | `apps/app/src/server/candidate-inspection.ts` |
| `helper` (other small calls) | `nemotron-3-nano` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | `apps/app/src/agents/hello.ts` |
| `app` (in-app AI, fast) | `nemotron-3.5-lightning` | `nvidia/Nemotron-3_5-Lightning` | `apps/app/src/server/app-ai.ts` |
| `appSuper` (in-app AI, deeper) | `nemotron-3.5-super-vl` | `nvidia/Nemotron-3.5-Super-VL` | `apps/app/src/server/app-ai.ts` |
| `planAuthor` (product and tech-lead: the plan) | `deepseek-v4.1-flash-1017` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | `apps/app/src/agents/specialists.ts` (`specialistModelRole`) |
| `planReviewer` (independent plan review) | `glm-5.3` | `zai-org/GLM-5.3` | `apps/app/src/server/artifact-quality.ts` |
| `designAuthor` (designer: looks and screens) | `minimax-m3.1-flash` | `MiniMaxAI/MiniMax-M3.1-Flash` | `apps/app/src/agents/specialists.ts` (`specialistModelRole`) |
| `build` (coding + QA) | `minimax-m3.1-flash` | `MiniMaxAI/MiniMax-M3.1-Flash` | `apps/app/src/agents/specialists.ts`; the first rung of the repair ladder below |
| `plan` (older planning route, kept so earlier runs resolve) | `glm-5.3-flash` | `zai-org/GLM-5.3-Flash` | `apps/app/src/agents/specialists.ts` (fallback only) |

**Repairs** (`apps/app/src/server/repair-escalation.ts`): two failed checks on
the same issue move it one rung. `REPAIR_ROUTES` = `minimax-m3.1-flash` →
`deepseek-v4.1-flash-1017` → `deepseek-v4.1-flash-1017`; an issue that needs
to see an image uses `VISION_REPAIR_ROUTES` = `nemotron-3.5-super-vl` →
`deepseek-v4.1-flash-1017`. When the ladder runs out, the build pauses and asks
the owner.

So Caddie uses four NVIDIA Nemotron models — **Nemotron 3 Ultra**,
**Nemotron 3.5 Super VL**, **Nemotron 3.5 Lightning** and **Nemotron 3 Nano** —
for the conversation, brainstorming, architecture review, image understanding,
rules reading, ranking, summaries and the AI inside every generated app, all
through Token Factory. The model ids are the exact case-sensitive listing
spellings (`Nemotron-3.5-…` with a dot, `Nemotron-3_5-Lightning` with an
underscore).

**The sandbox.** Generated code runs in an isolated sandbox reached over Token
Factory's sandbox API, `https://api.tokenfactory.nebius.com/sandboxes`
(`apps/app/src/server/build-sandbox.ts`,
`apps/app/src/server/adapters/sandbox.ts`, REST client in
`apps/app/src/server/adapters/contree.ts`; `CONTREE_BASE_URL`,
`CONTREE_API_TOKEN`, `CONTREE_PROJECT_ID`; sessions boot from `tag:tt-base:1`,
`docs/setup/sandbox.md`). The host enforces the build loop so a model's own
claims never count: `build_next_feature` → `run_checks` → `finish_feature`
(new passing tests, then the part's browser checks) → `verify_build`.

**Caddie's own checks.** Each part's "done when" checks run in a real Chromium
on a brand-new account, outside the builder's reach
(`apps/app/src/server/independent-acceptance.ts`,
`scripts/acceptance-browser.ts`). Checks that can never pass on an empty app
are refused at plan time (`journeyLintIssues`,
`packages/contracts/src/acceptance-journeys.ts`). At the look step every screen
is measured at phone and desktop size for contrast, 44×44 px tap targets and
sideways scrolling (`scripts/local-design-audit.ts`); looks and screens are
judged by these machine checks, not by a second AI. The pixel comparison with
the approved look is advisory (`scripts/local-visual-fidelity.ts`). The browser
runs in a separate private service (`scripts/serve-design-capture.ts`) that
Caddie calls over HTTPS with a bearer token
(`apps/app/src/server/browser-check-service.ts`).

**Code runs in Token Factory.** The Coding track asks for "agents that write,
run, and test code in Token Factory". The full **EggOps Nigeria** build (plan →
looks → 4 parts → browser checks → ready preview) ran this way on 2026-10-30:
**LOCAL VERIFIED** — Caddie ran on the owner's machine, and its models and
sandbox were the real Token Factory services. A full build on the deployed
Worker is not verified yet.

**Honest status.** The hosted demo is `https://caddie.jamalibrahim.dev`,
redeployed on 2026-10-30 onto a fresh production database. 4 of 5 hosted smoke
checks pass (**LIVE VERIFIED**: `/app/`, the session probe and the API; the
landing check fails on a stale text assertion in the spec), and the shared
judge account was created on production (**LIVE VERIFIED**). A full build,
isolated previews and Caddie's browser checks are **not** yet verified on
production; the browser-check service runs on the owner's machine behind a
Cloudflare tunnel. Publishing apps
(Workers for Platforms) is **not** deployed, built apps' sign-in codes go to a
test inbox rather than real email, and Flutter/Android builds are locally
tested but not run on production. The README's status table records each
surface at its real status. Full labels are in §7.

**Big apps (team mode).** For larger apps an architect (Nemotron 3 Ultra)
reviews the design's architecture, and several parts are built in parallel and
joined. Implemented and covered by the `TEAM_MODE` tests (LOCAL VERIFIED); not
exercised on production.

---

## 1a. Feedback on Nebius Token Factory and NVIDIA models

The hackathon asks entrants for feedback on Token Factory and the NVIDIA
models. Every point below is drawn from this repo's own recorded runs, with
the date it was observed; nothing here is a general impression.

**What worked**

- **Super VL reads images (2026-10-18).** The listing probe sent a split
  red/blue PNG with a `remember` tool: HTTP 200, both colours named, and the
  tool call returned (711 in / 260 out, 1267 ms). That is what moved the
  `vision` role onto it (`providers.ts` Super-VL entry).
- **Super VL's tool calls (2026-10-18, 2026-10-20).** The same probe had
  `nvidia/Nemotron-3.5-Super-VL` return a clean tool call; it has driven
  Caddie's conversation since, and it was the coding route from 2026-10-20
  until the 2026-10-29 re-route below.
- **GLM-5.3-Flash as a vision model for planning (2026-10-15).** GLM-5.3-Flash
  read both halves of the split PNG and emitted a tool call (~7 s), which is
  why it is listed in `VISION_ROUTE_IDS`.
- **Token Factory's OpenAI-compatible endpoint (recorded 2026-10-06).** One
  base URL (`https://api.tokenfactory.nebius.com/v1`) serves every role through
  the standard OpenAI completions shape, so routing fifteen roles across eight
  models is a one-line change per role in `MODEL_ROLES`, with no per-model
  client code (live model round-trip recorded, ledger `P05-live`).
- **One account for models and sandboxes (recorded 2026-10-06, 2026-10-19,
  2026-10-30).** The sandbox API (`https://api.tokenfactory.nebius.com/sandboxes`)
  is on the same Token Factory account as the models; a real session + remote
  exec was recorded 2026-10-06 (release-evidence P04), the app template
  installed, built and tested there on 2026-10-19, and the EggOps Nigeria build
  ran all four parts there on 2026-10-30 (from a local Caddie).

**What didn't, and what we worked around**

- **Token Factory rejects the OpenAI `developer` role (observed 2026-10-06).**
  It 422s without a compatibility block, so the `nebius` provider is
  registered with `supportsDeveloperRole: false` / `supportsStore: false` /
  `maxTokensField: 'max_tokens'` (`providers.ts`).
- **Reasoning models need a generous output cap (2026-10-19, 2026-10-25).**
  Nemotron 3 Nano spends tokens thinking before any output; at a 2,048-token
  cap the rules-reading probe hit the cap mid-reasoning and returned empty
  content (9,270 chars of `reasoning_content`, no answer). Raising the cap to
  8,192 fixed it. Super VL and Ultra showed the same at 8,192 under maximum
  reasoning effort, so their caps are now 32,768 (`providers.ts`).
- **Too much thinking on long build calls (2026-10-29).** At `medium`
  reasoning effort Super VL thought for 437 s and 306 s in single build calls,
  and MiniMax-M3.1-Flash spent its whole 32,768-token output on reasoning
  twice on the looks task; both roles now run at `low` (`ROLE_THINKING` in
  `providers.ts`).
- **Super VL as the last code-repair rung (2026-10-30).** In the EggOps run it
  took 10–35 s per call and wrote no file in six minutes, while DeepSeek took
  the same part from 0 to 3 of 4 host checks in five minutes, so the ladder's
  last rung is DeepSeek and Super VL repairs only issues that need image input
  (`repair-escalation.ts`).
- **Nemotron 3.5 Lightning couldn't do the structured rules-reading job
  (2026-10-20).** Tried as the `helper` model, on the real rules prompt it
  returned `finish_reason: length` with no parseable JSON even at the route's
  4,096-token output cap, and its narration came back inside `content` rather
  than `reasoning_content` (1,482 in / 4,096 out, execution ledger
  `probe-lightning` run). `helper` went back to Nemotron 3 Nano the same day;
  both cost the same ($0.06/$0.24 per Mtok).
- **The 3.x Nemotron ids don't accept image input (2026-10-15).** Every 3.x
  Nemotron route 400s an image ("This model does not support image input");
  only the 3.5 Super VL id does. The id spellings are also inconsistent and
  case-sensitive, which had to be read from the live listing rather than
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
(765 commits as of 2026-10-30; first commit **2026-10-03**):

| Date(s) | What landed |
| :--- | :--- |
| **2026-10-03** | First commit: the fresh-build plan, then bootstrap and frozen shared contracts (P00). |
| **2026-10-04 – 10-06** | Packets P00–P17: sign-in, projects and approvals, the sandbox driver, specialists and the coordinator, previews, GitHub, discovery, judge/submission, tasks, and the extra stacks. |
| **2026-10-07 – 10-10** | Home (the project-less conversation with Caddie), five waves of UI redesign, saved hackathons, search, per-scope chat threads. |
| **2026-10-15 – 10-16** | Project-page redesign, the host-driven feature build loop, the PRD + design review step, saving source to GitHub as a PR, and model re-routing. |
| **2026-10-17 – 10-18** | Publishing to Cloudflare (adapter, safety scan, takedowns), keys for outside services, AI inside generated apps with a per-project allowance, app sign-in, versions/restore, "Start from my GitHub repo", model routing re-read from the live Nebius listing. |
| **2026-10-19** | Judge sign-in and judge limits, the MIT `LICENSE` and licence audit, checked installs in the sandbox (every package's sha512 checked before unpacking), Caddie installable on a phone's home screen, a checked production deploy procedure. |
| **2026-10-20** | A plan must name what judges will see before it is saved; whether an app's AI is fast or deeper is decided at plan time. |
| **2026-10-21** | One card family across chat and the Brief; Discover shows official prize tables; a production deploy with its hosted smoke receipt. |
| **2026-10-22** | Brief cards redone to seven approved mockups; a focused project workspace with four steps; **team mode for big apps** (an Ultra architecture review, a spending limit checked before every model call, contract checks, parts built in parallel and joined). |
| **2026-10-23** | A one-command deploy with per-step logs; generated apps can take payments (test mode), photo uploads, emails to a test inbox and scheduled jobs; every app gets its own theme and icon kit; nine review findings fixed. |
| **2026-10-24** | **The look picker** between plan approval and design; 44 px touch targets; email and phone notifications with per-kind settings. |
| **2026-10-25** | Build reliability: per-call model usage, deadlines, guards against empty or repeated work, "Ready" only with a real preview; a new landing page for first-time builders. |
| **2026-10-26** | A calm sign-in screen with its own judge form; the repair ladder saved and always on; each candidate checked in its own **isolated browser runtime**. |
| **2026-10-30** | (Work from 10-27 to 10-29 landed in this day's commits.) **Machine checks instead of an AI design reviewer**; first versions capped at 3 parts × 3 checks, with later parts built through **Add this**; checks that can never pass refused at plan time; Build activity views grouped by part; **app previews on their own origin**; the judge door opens on the **one shared judge account**; plain wording on the Submit tab; a **fresh production database**. The full **EggOps Nigeria** build ran end to end the same day (LOCAL VERIFIED). |

(The dates and counts come from `git log` in this repo. The README's "What
changed during the submission period" section is the judge-facing version of the
same table.)

---

## 5. Repo, demo and video URLs

- **Repository:** `<REPO-URL>` — confirm the intended public repository and
  its contents before submitting; a configured local remote alone is not proof.
- **Live demo:** `<DEMO-URL>` — `https://caddie.jamalibrahim.dev`, redeployed
  2026-10-30 at 15:38 UTC (commit `cbe680e`) onto a fresh database; 4 of 5
  hosted smoke checks pass (§7). Sign in as the judge and open the demo project
  before submitting.
- **Video:** `<VIDEO-URL>` — **not recorded yet.** Upload to YouTube as public
  or unlisted. See `docs/submission/video-script.md`. If production is not
  ready, the video is recorded on a local build with live models and the live
  sandbox, and it is then **not** evidence of a hosted deployment — say so on
  screen.

Do not fill a placeholder with a guess. A wrong URL is worse than a missing one.

---

## 6. Testing instructions (template for the Devpost form)

Paste the following into Devpost's testing-instructions field and replace the
judge name and password placeholders with the real ones **inside the form
only**. Never put the password in the repository, the README, this file's body,
a screenshot, or the video. (Owner 2026-10-30: one shared judge account, the
same one the demo video was recorded with.)

> **How to try Caddie**
>
> 1. Open the demo: `<DEMO-URL>`.
> 2. On the sign-in page, click **"Judging the hackathon? Sign in here"**.
> 3. Enter the judge name `<JUDGE NAME>` and the password `<JUDGE PASSWORD>`.
>    No Google or GitHub account and no email are needed.
> 4. **Projects** already holds the app built in the demo video,
>    **"<Name>"**. Open it to try the preview, or ask Caddie for a change. The
>    app signs in with an emailed code; the code arrives in the **test inbox**
>    on the Build tab (built apps don't send real email yet).
> 5. Try the loop yourself: ask Caddie for a project idea, open **Discover** to
>    see live hackathons and a contest's cited rules, then ask Caddie to plan a
>    small app (at most 3 parts), approve the plan, pick a look, and the build
>    starts. A build takes about an hour.
>
> **Shared account:** every judge uses this one account, so you may see other
> judges' projects. The account cannot publish apps.

**Notes on these limits (not for the form, for the owner):** the production
config sets, per rolling 24 hours, 30 build starts, 1,000 Caddie messages and
60 live hackathon searches, at most 20 projects (`JUDGE_MAX_*`, enforced in
`apps/app/src/server/judge-limits.ts`; the code defaults are 3 / 3 / 300 / 20),
and model spending caps of $30 a day and $15 per project
(`MODEL_SPEND_DAILY_CAP_USD`, `MODEL_SPEND_PROJECT_CAP_USD`,
`apps/app/src/server/model-spend-guard.ts`). The closing date is the
deployment's `JUDGE_ACCESS_UNTIL` (`docs/setup/owner-inputs.md` records
`2026-12-16` as the default). The README's "Limits on the shared account"
section says the same in plain words. If the deployment's environment changes
any of these, update the form to the deployed numbers.

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
  `apps/app/src/agents/specialists.ts`, `apps/app/src/server/app-ai.ts`,
  `apps/app/src/server/rules-reading.ts`,
  `apps/app/src/server/candidate-inspection.ts`,
  `apps/app/src/server/artifact-quality.ts`.
- **Recorded run:** `docs/release-evidence.md` row **P05** — "Model route
  round-trip (Nebius) — LIVE VERIFIED — real coordinator model call, ledger
  `P05-live`"; and the P09 React+Hono journey. Re-probed live on 2026-10-18
  (G1 listing probe) and 2026-10-19 (`scripts/probe-lightning.ts`). The
  2026-10-30 EggOps Nigeria build made its model calls to Token Factory from a
  local Caddie (LOCAL VERIFIED as a whole build).
- **Caveat:** these live model calls were made from a local/dev origin under
  owner authorization. A model round-trip through the hosted origin has no
  receipt yet; the release check of 2026-10-30 lists the P05 live gate as
  PROVISIONED (key present, no current receipt).

### (b) At least one NVIDIA open-source model — **LIVE VERIFIED** (recorded 2026-10-18)

- **Code (checkable):** `apps/app/src/agents/providers.ts` (`MODEL_ROLES`,
  `MODEL_ROUTES`) uses NVIDIA Nemotron models by role —
  `nvidia/Nemotron-3-Ultra-550b-a55b` (ideation, architect),
  `nvidia/Nemotron-3.5-Super-VL` (chat, vision, appSuper, image repairs),
  `nvidia/Nemotron-3_5-Lightning` (app),
  `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (helper, helperRules, helperRanking,
  helperSummary).
- **Recorded run:** the 2026-10-18 G1 probe (`GET /v1/models?verbose=true` plus
  chat probes) confirmed the listing serves both
  `nvidia/Nemotron-3.5-Super-VL` and `nvidia/Nemotron-3_5-Lightning`, and that
  Super VL returned a tool call and read a split red/blue PNG (image input);
  recorded in `docs/plans/2026-10-03-fresh-build/execution-ledger.md` and noted
  in the `providers.ts` route entries.
- **Tavily bonus (separate, not Stage One):** **LIVE VERIFIED** (2026-10-12,
  ledger P11) — see §3.

### Honest gaps (state these rather than overclaim)

- **Hosted demo URL:** redeployed 2026-10-30 at 15:38 UTC (commit `cbe680e`,
  version `ddf92e7a-9a68-49cf-8775-6d2e169fc445`). Before the upload the deploy
  logs show the release check (52 PASS, 0 FAIL, 1 BLOCKED by design, 4
  PROVISIONED), the preflight (20 PASS, 2 WARN, 0 FAIL) and the fresh
  production database with exactly the 4 migrations
  (`0001_foundation.sql` … `0004_quality.sql`). Hosted smoke
  (`tests/live/release.spec.ts`): 4 of 5 **LIVE VERIFIED** (`/app/`, session
  probe, API); the landing check **FAILED** on a stale `LOCKED LINE` text
  assertion. The upload and smoke were run by hand and are not yet in
  `.deploy-logs/` or `docs/live-receipts.json`.
- **Shared judge account:** created on production through `/api/judge/start`
  (200), **LIVE VERIFIED**.
- **Caddie's browser checks on production:** not verified. The service runs on
  the owner's machine behind a Cloudflare tunnel.
- **A full build on the deployed Worker:** not verified. The full EggOps
  Nigeria build is LOCAL VERIFIED (2026-10-30).
- **Isolated app previews (`p-<hash>.preview.jamalibrahim.dev`):** the route is
  deployed; no preview has been opened on that origin yet, so not
  live-verified.
- **Email from built apps:** sign-in codes go to a test inbox on the Build
  tab, not to real email.
- **Publish / Cloudflare Artifacts / Web Risk on a deployed Worker:**
  implemented and locally tested, **not** deployed or live-verified
  (`README.md`; `docs/release-evidence.md`).
- **Flutter / Android builds:** implemented and locally tested, not run on
  production.
- **Custom domains:** NOT BUILT.
- **Licence audit:** LOCAL VERIFIED and **clean** (2026-10-19) — 24 production
  dependencies, 24 allowed, 0 flagged, 0 unresolved. The two `@fontsource/*`
  webfont packages are OFL-1.1, accepted for that package family only
  (`docs/licenses.md`).
- **The sandbox wording:** the rules say "in Token Factory", not "Token Factory
  Sandboxes" (the earlier quote was wrong; `nebius-forge-eval`'s compliance
  correction, rules re-read 2026-10-03). The sandbox API is on
  `api.tokenfactory.nebius.com`. Its availability through 2026-12-15 is not
  confirmed.

---

## 8. Before the owner submits (checklist)

- [ ] `<REPO-URL>` is public, with `LICENSE` (MIT) and `README.md` at the root.
- [ ] `<DEMO-URL>` is deployed, free, and reachable without a paywall or
      invite dead-end through the judging window; the judge account signs in
      and opens the demo project.
- [ ] `<VIDEO-URL>` is uploaded, public or unlisted, under 3:00, and its audio
      names Nebius Token Factory and NVIDIA Nemotron.
- [ ] The shared judge name and password are entered **only** in the Devpost
      form, and they are not in the repo, README, screenshots or video.
- [ ] Track(s) selected after checking the current Devpost rules (§2).
- [ ] Re-read the live rules page: the Coding track still says code runs "in
      Token Factory" (last read 2026-10-03), and nothing new conflicts (§1).
- [ ] Nebius confirms the sandbox stays available through 2026-12-15.
- [x] The licence flags are resolved: OFL-1.1 accepted for the `@fontsource/*`
      webfont packages, audit clean (2026-10-19).
