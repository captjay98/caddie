# Caddie — golden-path demo video shooting script (S12)

**Status: NOT RECORDED.** This is a shooting script for a video that does not
exist yet. Every submission URL it refers to (demo, repo, video, the judge code)
is a marked placeholder; the only real URLs quoted are source facts from this
repo.

**Target length: at most 2:45. This cut is 2:40.** The hackathon's video limit
is under 3:00 with audio that names Nebius Token Factory and NVIDIA Nemotron;
the submission plan (S12) asks for at most 2:45 and this cut leaves a ~5 second
margin below even that.

**Where to record.** On the hosted production deployment **when it exists**
(S10/G4). Production is currently **owner-gated and not deployed**
(`README.md`, "Hosted demo (the judge URL)" = *NOT BUILT / not deployed*;
`docs/release-evidence.md`). If production is not ready, record on a **local
build with live models and the live sandbox** — and say so on screen. A local
recording is **not** evidence of the hosted deployment and must not be
presented as the hosted demo. If the recording is made locally, include the
lower-third described in "Local-recording banner" below.

**What the recording may and may not claim.** The full-fact labels are in the
final section. Short version: model round-trips, the sandbox and Tavily are
**LIVE VERIFIED** as recorded runs (see the final section); the **hosted demo,
Publish/Worker-Loader-on-a-deployed-Worker, Cloudflare Artifacts and custom
domains are not live-verified**. Do not say "live on the internet" about
Publish unless production is actually deployed and the publish ran there.

---

## 1. Pre-recording checklist

Run this before you press record. Everything here is checkable in the repo.

### What must be running

- [ ] The build to record against, running, and reached at its base URL.
      - Production (preferred): the deployed Worker, URL recorded in
        `docs/release-evidence.md` (P17 hosted row) — **does not exist yet**.
      - Local fallback: `bun run dev` (dev server pinned to
        `http://localhost:5176`; SPA under `/app`), per `README.md` → "Run it
        locally".
- [ ] Local D1 migrated: `bun run db:migrate:local`.
- [ ] Credentials present in `.dev.vars` (gitignored — never shown on camera):
      `NEBIUS_API_KEY`, `TAVILY_API_KEY`, `CONTREE_BASE_URL`,
      `CONTREE_API_TOKEN`, `CONTREE_PROJECT_ID` (`docs/setup/sandbox.md`).
- [ ] A clean browser profile at **desktop (e.g. 1440×900)**; a second take at
      **390px** if you want a phone-width shot (the plan's S11 rehearsal uses
      those two widths).
- [ ] Signed in already, or the judge access code ready (the access code is an
      owner input; **never show it on camera** and never write it in this
      repo).

### What each beat needs to be LIVE (not a stub)

| Beat | Live requirement | If not available |
| :--- | :--- | :--- |
| 1 Find | `TAVILY_API_KEY` + `NEBIUS_API_KEY` (a real Tavily search/extract and a real model turn) | Record the local build; the Find feed shows a **visible feed gap** instead of inventing results, and say so — do not fake a result list. |
| 2 Brainstorm | `NEBIUS_API_KEY` (Nemotron 3 Ultra turn) | Same: local build with live key. A missing key is a visible configuration gap. |
| 3 Plan & design | `NEBIUS_API_KEY` (GLM-5.3-Flash planning turn) | Local build with live key. |
| 4 Sandbox loop | `CONTREE_BASE_URL` + token + project, and the base image `tag:tt-base:1` (`docs/setup/sandbox.md`) | **Blocked.** Without the sandbox the build fails closed; there is no honest way to show this beat. Prefer to defer the take. |
| 5 Preview + app AI | The app server preview (Worker Loader) for a server app; `NEBIUS_API_KEY` for in-app AI; Keys needs `APP_SECRETS_KEYS` | In-app AI still works in the preview with the key. **Keys** card says saving keys isn't set up without `APP_SECRETS_KEYS`; **Publish** is not deployed — use the Publish fallback below. |

### Latency / figure hygiene

- Model tiers: fast = Nemotron 3.5 Lightning; deep = Nemotron 3.5 Super VL
  (`apps/app/src/agents/providers.ts`, `MODEL_ROLES`). Do the deep-tier call
  first in the take; if it is slow, cut to the sped-up capture.
- Pre-warm the Find feed and one conversation turn before recording so the
  first on-camera request is not a cold start.

---

## 2. The beats (2:40 total)

Durations sum to 160 s. The plan's ordered beats are kept exactly.

| # | Beat | Time | Duration |
| :-- | :--- | :--- | :--- |
| 1 | Find with Tavily (and the coordinator model) | 0:00 – 0:24 | 24 s |
| 2 | Brainstorm with Nemotron 3 Ultra | 0:24 – 0:52 | 28 s |
| 3 | Plan and design | 0:52 – 1:24 | 32 s |
| 4 | The sandbox feature loop (sped up, labelled) | 1:24 – 2:02 | 38 s |
| 5 | Preview, in-app AI (fast + super), Versions / Keys / Publish | 2:02 – 2:40 | 38 s |

---

### Beat 1 — Find (0:00 – 0:24, 24 s)

**On-screen action.** Home workspace: the `Brief · Discover · Projects` nav and
the Caddie conversation. Type: *"Find me open AI hackathons that close in the
next month."* Let the live `HackathonResultsCard` render, then open one contest
and show the **cited eligibility claims** in its rules pane (each claim carries
the line it was quoted from).

**Exact words (English):**

> "This is Caddie — a build assistant that runs on **Nebius Token Factory**.
> This conversation is answered by **NVIDIA Nemotron 3.5 Super VL**. First,
> Find: Caddie sweeps live hackathon sources with **Tavily** — its search
> endpoint to build the candidate list, then its extract endpoint to pull the
> rules page. **NVIDIA Nemotron 3 Nano**, the fast helper model, reads that
> page and quotes the eligibility lines **verbatim**. Every claim shows where it
> came from, and if a source fails, Caddie shows the gap instead of guessing."

**Notes.** The Find feed is Devpost's public open-contests API *plus* a Tavily
multi-platform sweep, de-duplicated and filtered to real event pages
(`apps/app/src/server/discovery.ts`, `apps/app/src/server/tavily.ts`). The rules
reader is the `helper` role, `nemotron-3-nano` (`MODEL_ROLES` in
`apps/app/src/agents/providers.ts`). With Beat 2 (Ultra) and Beat 5 (Lightning
and Super VL), the audio names all four Nemotron models Caddie uses. Say
"the rules pane" only if the verbatim claims are actually visible on screen.

---

### Beat 2 — Brainstorm (0:24 – 0:52, 28 s)

**On-screen action.** Continue the conversation; answer Caddie's focused
questions in one line each; let it propose a project (`ProjectProposalCard`),
then click **"Start this project"**.

**Exact words:**

> "Now brainstorm. For this step Caddie routes to **NVIDIA Nemotron 3 Ultra**
> — the 550-billion-parameter model — because deciding *what* to build needs
> judgment, not speed. It asks one focused round of questions, proposes a
> project against the contest's real rules and the time I actually have, and
> stops for me to choose. That routing is one line in the model registry:
> Nemotron 3 Ultra for ideation, the fast models everywhere else."

**Notes.** Ideation is `MODEL_ROLES.ideation → nemotron-3-ultra →
nvidia/Nemotron-3-Ultra-550b-a55b`, and it only applies in the Home
conversation for a bounded window (`coordinatorModelRole`,
`IDEATION_TURN_WINDOW`, `apps/app/src/agents/providers.ts`). Do not claim it
runs the whole product.

---

### Beat 3 — Plan and design (0:52 – 1:24, 32 s)

**On-screen action.** Open the generated **scope / PRD** (data model, `/api/*`
routes, a `caddie-features` list) and the **interactive HTML design mocks**
(`DesignMockPreview`, phone and desktop widths). Approve the plan, then approve
the design. Approval is the gate that starts the build.

**Exact words:**

> "I approve the idea. The planning specialists write a real scope, a PRD with
> a data model and API routes, and interactive screen mocks. This runs on
> **GLM-5.3-Flash**, served through the same **Nebius Token Factory** endpoint
> — Caddie uses the right model for the job. I review the design and approve
> it, and *that* starts the build."

**Notes.** Planning and build share `glm-5.3-flash` today (`MODEL_ROLES.plan`,
`MODEL_ROLES.build`). Planning is `apps/app/src/server/planning.ts` +
`build-workflow.ts`; the design review is `DesignReview.tsx`. Do not show or
claim a mock as the finished app.

---

### Beat 4 — The sandbox feature loop (1:24 – 2:02, 38 s) — SPED UP, LABELLED

**On-screen action.** Show the `FeatureChecklist` and `BuildProgress`. Let the
loop run (sped up — see the label rule), showing: a feature is selected, code
and a test are written, the check count grows, and a feature is marked
finished. Trigger the `server-starts` check for an app with a server.

**Speed-up rule (required).** This segment is recorded at normal speed, then
**played back sped up**. The speed-up **must be labelled on screen** the whole
time it runs, e.g. a persistent corner badge: **"Build sped up ~8× — real
time: ~6 min"** (use the real multiplier and real elapsed time from the take;
do not guess them). Never speed up without the badge.

**Exact words:**

> "Caddie builds feature by feature inside an isolated sandbox — a separate
> machine reached over the sandbox API on the **Token Factory** account, never
> my laptop. The *host* owns the loop: it tells the builder which feature is
> current, runs the checks itself, and only finishes a feature when the test
> count actually went up. The model never grades its own work. For an app with
> a server there's a second check: the server has to boot on Cloudflare's
> runtime and answer its health endpoint. Green means a recorded receipt, not a
> model saying *trust me*."

**On-screen label literals to use:**
- `BUILD SPED UP ~8× (real time ~6 min)` — adjust numbers to the take.
- If the app has no server in the take, drop the `server-starts` sentence and
  do **not** claim that check ran.

**Fallback if the sandbox is unavailable.** Do **not** record this beat. The
build fails closed without `CONTREE_BASE_URL`/token/project
(`docs/setup/sandbox.md`), and a stubbed loop would be a fake. Either defer the
take, or cut straight from Beat 3 to Beat 5 on a project that was pre-built —
and if you do, say on screen *"this app was built earlier; the build step is
not shown"*. Never present a pre-built app as if the loop just ran.

---

### Beat 5 — Preview, in-app AI, Versions / Keys / Publish (2:02 – 2:40, 38 s)

**On-screen action.** Open the **live full-stack preview** of the finished app.
Sign in through the preview test inbox; save a row to the app's preview D1.
Trigger an in-app AI reply once on the **fast** tier and once on the **super**
tier. Then scroll to the **Versions**, **Keys** and **Publish** cards.

**Exact words:**

> "Here's the finished app, running in a live preview, with its own database
> and its own sign-in. It has its own AI, too: routine replies run on **NVIDIA
> Nemotron 3.5 Lightning** — fast and cheap — and a feature can ask for deeper
> reasoning on **Nemotron 3.5 Super VL**. Caddie pays for those calls from a
> per-project allowance, and the app never sees a key. **Versions** lists every
> checked build and can restore one. **Keys** holds any outside-service keys
> the app needs. And **Publish** puts it on the web. Caddie never submits or
> ships for me — it hands me the evidence and stops."

**Publish honesty and fallback (required).** If production is **not deployed**,
or Publish is not turned on, do **not** click Publish and do **not** imply it
worked. Instead show the card and say:

> "Publishing runs through Workers for Platforms. On this build it's not turned
> on yet — the card says so, and it would say the same to a judge."

The Publish card renders an honest refusal when publishing is not set up —
its own copy is *"Publishing isn't set up on this Caddie server yet."*
(`apps/app/src/client/project/PublishApp.tsx`). Match whatever the card actually
says in the take.

**On-screen labels for the two tiers.** Keep the fast/super distinction
visible (e.g. a caption `fast: Nemotron 3.5 Lightning` / `super: Nemotron 3.5
Super VL`) so the narration and the screen agree.

---

## 3. On-screen label set (reuse these strings)

- `Recorded on a LOCAL build with live models + live sandbox — not the hosted
  demo` (only when recording locally; see below).
- `BUILD SPED UP ~N× (real time …)` (required on the sped-up segment).
- `fast: Nemotron 3.5 Lightning` / `super: Nemotron 3.5 Super VL`.
- `This build was made earlier; the build step is not shown` (only if Beat 4 is
  cut).
- Never a URL that is not real. If a URL appears, it is the deployed demo URL
  from `docs/release-evidence.md`, not a made-up one.

### Local-recording banner

If production is not deployed and the take is recorded locally, keep a
persistent lower-third on screen or state it aloud at the top:

> "Recorded on a local build with live models and the live sandbox. Production
> is not deployed yet, so this is not the hosted demo."

This is a **required** disclosure. A local recording is **not** LIVE VERIFIED
evidence of the hosted deployment.

---

## 4. If a step fails on camera

- **A model turn errors (429/5xx):** stop the take; the app fails loudly rather
  than silently. Do not narrate a success. Wait, retry, or move the turn out of
  the recorded window.
- **Tavily returns nothing / no key:** the feed shows a **visible gap**. Either
  fix the key and re-take, or record the beat honestly: "the source is
  unavailable right now, so Caddie shows the gap." Do **not** hand-type results.
- **A check fails in the sandbox loop:** that is a real, useful shot — a
  failure is recorded as a failed check with its reason. If it is a genuine
  failure, cut it or show it and say what happened. Never claim a failing check
  passed.
- **The sandbox is down:** see Beat 4's fallback. Do not substitute a stub.
- **Publish not configured:** use the Beat 5 refusal wording. Do not fake a
  publish.
- **Production is down mid-take:** stop; do not make the demo URL claim. Re-take
  when it is back.

---

## 5. Claims on screen must match these labels

Every claim the narration and the on-screen text make must carry the same
status this repo records. If a claim is not below, do not say it.

| Claim in the video | Status | Where it is verifiable |
| :--- | :--- | :--- |
| Runtime calls to the Token Factory inference API on `https://api.tokenfactory.nebius.com/v1` | **LIVE VERIFIED** (recorded 2026-10-06) | `apps/app/src/agents/providers.ts` (`NEBIUS_BASE_URL`, `registerNebiusProvider`); live receipt `docs/release-evidence.md` row P05, ledger `P05-live`. Re-probed 2026-10-18 (G1) and 2026-10-19 (`scripts/probe-lightning.ts`). |
| Nemotron 3.5 Super VL accepts image input | **LIVE VERIFIED** (recorded 2026-10-18) | `providers.ts` Super-VL entry note (split red/blue PNG + tool call returned). |
| Sandbox session + remote exec (`CONTREE_BASE_URL`, image `tag:tt-base:1`) | **LIVE VERIFIED** (recorded 2026-10-06) | `docs/release-evidence.md` row P04; `docs/setup/sandbox.md`; P09 React+Hono journey. |
| Host-enforced feature loop (`build_next_feature → run_checks → finish_feature → verify_build`) | **LOCAL VERIFIED** | `apps/app/src/server/coordinator-host.ts`, `build-features.ts`; tests. |
| Runs-on-Cloudflare check (`server-starts`) | **LOCAL VERIFIED** (never run on a deployed Worker) | `apps/app/src/server/preview-runtime.ts` (`checkServerStarts`). |
| Tavily `/search` and `/extract` runtime calls | **LIVE VERIFIED** (recorded 2026-10-12) | `apps/app/src/server/tavily.ts`; ledger P11 live probe; call sites `discovery.ts`, `rules-reading.ts`, `coordinator-context.ts`. |
| In-app AI dual tier (`env.CADDIE.ai`, fast/super) | **LOCAL VERIFIED** | `apps/app/src/server/app-ai.ts`, `apps/app/src/client/project/AppAi.tsx`; `tests/app-ai.test.ts`. |
| Versions / restore | **LOCAL VERIFIED** | `apps/app/src/client/project/AppVersions.tsx`; `tests/versions.test.ts`. |
| Keys (app secrets) | **LOCAL VERIFIED** | `apps/app/src/client/project/AppKeys.tsx`; saving keys needs `APP_SECRETS_KEYS` (`docs/setup/owner-inputs.md`). |
| Publish (Workers for Platforms) | **NOT DEPLOYED / LOCAL VERIFIED only** | `apps/app/src/client/project/PublishApp.tsx`; `README.md` status table; `docs/release-evidence.md`. |
| Worker Loader preview / Artifacts / Web Risk on a **deployed** Worker | **Not live-verified** | `README.md` status table. |
| Hosted demo URL accessible to judges | **NOT BUILT / not deployed** | `README.md` status table. |
| The template app installs and builds in the sandbox (`verified-install.ts` on `tag:tt-base:1`) | **LIVE VERIFIED** (recorded 2026-10-19) | `README.md` status table; `scripts/probe-sandbox-scaffold.ts`; ledger item 3 receipt. A full build driven by Caddie's agents is **not yet live**: don't present the template run as one. |
| Code is written, run and tested in Token Factory (sandbox API at `https://api.tokenfactory.nebius.com/sandboxes`) | **LIVE VERIFIED** for the sandbox and the template install (2026-10-06, 2026-10-19) | `README.md` "The sandbox and Caddie's checks". Say "in Nebius Token Factory"; don't call it "Token Factory Sandboxes" (the rules don't use that name). |

### Three things never to say on camera

1. That the demo is hosted/live when it is a local recording.
2. That Publish put the app online when production is not deployed.
3. That a full app build by Caddie's agents has run live in the sandbox. Only
   the starting template's install, build and tests have (2026-10-19).
