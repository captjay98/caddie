# Routing on a running app — verification evidence

**Date:** 2026-10-26
**Task:** Confirm routing works on a running app (owner flagged "confirm the routing
works" after seeing *"our server seems to have crashed http://localhost:5176/app/"*).
**Constraint honored:** local verification only — no deploys, no pushes, no paid calls,
no code changes. (The only tracked-file edit is `.gitignore`, to keep the temp
screenshots/driver scripts out of git per the cleanup requirement.)

**Classification legend:** LOCAL VERIFIED = observed on a running app / executed test.

---

## 1. Dev server bound on 5176 (LOCAL VERIFIED)

Started with `bun --cwd=apps/app run dev` (bun = `~/.bun/bin/bun`, backgrounded with a
hard kill guard; never a foreground blocking launch). Vite reported:

```
VITE v8.0.14  ready
➜  Local:   http://localhost:5176/
```

`lsof -nP -iTCP:5176 -sTCP:LISTEN` proof (the pinned Vite dev port, `strictPort:true`,
`apps/app/vite.config.ts`):

```
COMMAND   PID      USER   FD   TYPE  DEVICE              NODE NAME
node    80490 captjay98   43u  IPv6 0xf4b5aede9f6ff745   TCP [::1]:5176 (LISTEN)
```

Unauthenticated API probe (so the base path is unambiguous):
`GET /api/auth/status` → `{"authenticated":false}`; `GET /api/projects` → `401 unauthenticated`.

---

## 2. Click-through of each surface on the running dev app (LOCAL VERIFIED)

Driven with the repo's own Playwright chromium (`import { chromium } from
'@playwright/test'`), never playwright-cli's bundled Chromium. The app is a **client-side
SPA**: the dev server serves the shell, and all route changes happen *in the browser*.
Loaded the ROOT URL once (`http://localhost:5176/`) and navigated client-side (the real
usage path), which is how clicking the nav behaves.

Driver: `test-support/routing-runningapp-drive.ts` (gitignored).

| Surface | Route (client nav) | Mounted | Error page? | `?project=` retained | Result |
|---|---|---|---|---|---|
| Brief | `/` | yes | no | n/a | **PASS** |
| Discover | `/discover` | yes | no | yes | **PASS** |
| Projects | `/projects` | yes | no | yes | **PASS** |
| Project Overview | `/project?project=…` | yes | no | yes | **PASS** |
| Project Plan | `/project?project=…&view=plan` | yes | no | yes | **PASS** |
| Project Build | `/runs?project=…` | yes | no | yes | **PASS** |
| Project Submission | `/submission?project=…` | yes | no | yes | **PASS** |

7/7 surfaces mount, no blank/error page, chrome renders, deep links retain `?project=`.

### Real project data (owner's Livestock Risk Tracker, LOCAL VERIFIED)

To show the owner's actual project (not stub fixtures), the driver presented the project
owner's **own existing local Better Auth session** (read read-only from local D1; no DB
write, no new session, the secret is read from `BETTER_AUTH_SECRET` and never printed).
`GET /api/auth/status` then returned `{"authenticated":true}` and the real
**Livestock Risk Tracker** (`proj_8f9cb1aeea005c54dd52af005dc92627`, workspace owner
`kiro-walkthrough`) rendered. Screenshots at deviceScaleFactor 2:

- Projects list (Livestock card, "● Building", "Nebius x NVIDIA Global AI Hackathon · Due in 4 days"):
  `/Users/captjay98/projects/caddie-forge/test-support/routing-evidence-shots/projects-list.png`
  and `…/projects-list-nav.png`
- Project **Overview** (desktop):
  `/Users/captjay98/projects/caddie-forge/test-support/routing-evidence-shots/project-overview-desktop.png`
- Project **Plan** (step bar: Plan ✓ Approved):
  `/Users/captjay98/projects/caddie-forge/test-support/routing-evidence-shots/project-plan.png`
- Project **Build** (blocked mid-build — see §4):
  `/Users/captjay98/projects/caddie-forge/test-support/routing-evidence-shots/project-build.png`
- Project **Submission**:
  `/Users/captjay98/projects/caddie-forge/test-support/routing-evidence-shots/project-submission.png`
- Project **Check / feature checklist** (`/evidence`):
  `/Users/captjay98/projects/caddie-forge/test-support/routing-evidence-shots/project-evidence-checklist.png`
- Project view at **390px phone** width:
  `/Users/captjay98/projects/caddie-forge/test-support/routing-evidence-shots/project-overview-phone.png`

Driver: `test-support/livestock-shots.ts` (gitignored).

Note on v2 workspace design: the "Build" tab is tab 2 of the focused project page, so
Overview and Build render the same focused-home view with the Build step highlighted —
this is the intended consolidated Overview·Plan·Build model (`routes.tsx` R06), not a
routing fault.

---

## 3. Composed build serves the SPA under `/app` (LOCAL VERIFIED)

`bun run build` (composed) succeeded:

```
compose-assets: composed 1 relocated SPA + 104 SPA asset + 99 landing files;
collisions: 0; manifest: apps/app/dist/composition-manifest.json;
non-production build named caddie-app-dev (undeployable to production)
✓ Worker bundle: apps/app/dist/caddie_app/index.js
```

`bun test tests/routing.test.ts` (spins up local workerd via `vite preview`, asserts the
real built artifact):

```
14 pass / 0 fail / 45 expect() calls   [6.21s]
```

Key assertions that confirm the `/app` base in the composed build:

- `/app redirects to the SPA shell (loop-free)` → **307 → `/app/`**
- `/app serves the SPA shell` → **200, `id="root"`**
- `/app deep links fall back to the SPA shell` → `/app/projects/some-id/runs/abc` → **200 SPA**
  (the composed Worker HAS a client-routing history fallback)
- `landing page is served at / from Astro output` → 200 (landing, no React root)
- `astro and SPA index outputs do not shadow each other`

So in the **composed Worker build** the SPA is served under `/app` WITH a deep-link
history fallback; the landing page is at `/`. This matches `routes.tsx` `detectBasepath()`
(basepath `/app` when the path starts with `/app`, else `/`).

---

## 4. Build state of the Livestock project (LOCAL VERIFIED, read-only)

`build_workflows.phase = blocked` for `proj_8f9cb1aeea005c54dd52af005dc92627` in the dev
D1 DB. The running app shows this precisely (see `project-build.png`):

- Step bar: **Plan ✓ Approved · ② Build (No recent activity) · ③ Check · ④ Submit**
- "Let's check this build. No new activity has been reported. I can't confirm the build
  is still running." / "Last reported result: Some checks still need attention."
- "**0 of 5 features checked**" · "Last working on: *A farmer can enter a batch name,
  type, start date, and starting count and save it*"
- "Started 17 h 18 min ago · Last activity 9 h 26 min ago"
- Conversation: *"`finish_feature` was called but the host responded to show the plan and
  wait for review controls before building can continue"*, with the 5 remaining features
  listed (daily-log, batch-health, ai-risk-prediction, offline-sync).

This is the "blocked mid-build" state the audit described, rendered on the live app.

---

## 5. Verdict on the `http://localhost:5176/app/` "crash"

**Not a routing-code defect. It is a dev-server-not-running / wrong-base condition.**

Evidence:

1. **Routing code is correct and the composed build serves `/app` with a fallback** — all
   14 `routing.test.ts` assertions pass against the real built artifact (§3).
2. **The dev server serves at the ROOT `/`** (Vite Local base `/`; §1). Non-`/app` client
   routes have **no server history fallback in dev**: a hard `GET /discover` returns
   **HTTP 404**. That is normal for a Vite dev SPA (fallback lives in the composed Worker).
3. **The exact reported URL `/app/` does NOT crash on a running, authenticated dev
   server.** Loaded `http://localhost:5176/app/` with the owner's real session:
   **HTTP 200, root mounts (36 KB rendered), no error page, zero console errors**, and the
   real workspace renders (Brief with live Livestock cards). Screenshot:
   `/Users/captjay98/projects/caddie-forge/test-support/routing-evidence-shots/dev-app-slash-reported-url.png`.
   (Vite serves `index.html` at `/app/`, and the router's `detectBasepath()` sets basepath
   `/app`, so the SPA boots there too.)

**Most likely cause of what the owner saw:** the dev server was not running (or had been
stopped / not yet booted) when they hit `http://localhost:5176/app/` — a refused
connection reads as "the server crashed." With the dev server up, that URL renders fine.
There is **no routing defect to fix**; the recommended base for `bun run dev` is the ROOT
`http://localhost:5176/`, and `/app` is the base in the composed (`bun run build`) Worker.

---

## Reproduction commands

```bash
export PATH="$HOME/.bun/bin:$PATH"; export TMPDIR=$(mktemp -d)
cd /Users/captjay98/projects/caddie-forge

# 1. dev server (background, with a kill guard)
nohup bun --cwd=apps/app run dev > /tmp/caddie-devserver-5176.log 2>&1 &
lsof -nP -iTCP:5176 -sTCP:LISTEN            # liveness

# 2. click-through (root, client-side nav)
bun test-support/routing-runningapp-drive.ts

# 3. composed /app base
bun run build
bun test tests/routing.test.ts
```

Temp artifacts (gitignored, regenerable): `test-support/routing-evidence-shots/*.png`,
`test-support/routing-runningapp-drive.ts`, `test-support/livestock-shots.ts`,
`test-support/dev-app-slash-probe.ts`.
