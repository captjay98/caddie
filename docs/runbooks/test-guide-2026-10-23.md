# How to test what shipped — 2026-10-23

Everything below is **live on `caddie.jamalibrahim.dev`** (version `eda7884c`). The
new software-team-mode switches ship **off**, so nothing here changes for users
until you turn a switch on. Two kinds of test: **free** (click around the live
app or a local server) and **paid** (real Nebius/sandbox spend — the three runs
you authorised).

---

## Part 1 — Free: try each part on the live app

Open [caddie.jamalibrahim.dev](https://caddie.jamalibrahim.dev) and sign in.

### The Brief cards (redesigned)
- Go to **Brief**. Cards now stand on the page (no box-in-a-box container).
- **One standard-width card per row, centred.** Drag the chat's left edge: the
  Brief stays wide enough for a card; push it too far and the chat snaps to
  **full screen** instead of crushing the card.
- A long card title truncates to **two lines** with an ellipsis.
- Chat opens at a **50/50** split by default.

### The project Overview (Option B)
- Open any project. Above the four steps you now see a **one-line summary** of
  where it stands ("Building. Caddie is building your app…"), and the four
  steps **Plan · Build · Check · Submit** are one tap each.

### What you can't see yet (switched off)
Team mode, big apps, app-features (payments/uploads/emails/jobs/AI-on-photos)
are deployed but **off**. To exercise them you turn the switch on for your own
account (operator action), or run the paid smoke build below.

---

## Part 2 — Paid: the three runs you authorised

All three need a **local dev server** and your **sign-in** (they drive your own
Caddie session in a browser you watch). They are the only steps that spend real
money. Run them from the repo root.

### One-time setup (per machine)

```bash
cd /Users/captjay98/projects/caddie-forge
bun run dev           # starts the local app; note the port it prints (e.g. 5176)
```

In a second terminal, point the runner at that port and authorise it:

```bash
export CADDIE_DEV_BASE_URL=http://localhost:5176   # the port `bun run dev` printed
export CADDIE_LIVE_AUTHORIZED=1                     # your explicit go — never read from .dev.vars
bun scripts/brief-run.ts --sign-in                  # opens a visible browser; sign in as yourself
```

`--sign-in` saves your session; the runs below reuse it. (Your keys come from
`apps/app/.dev.vars`, which is never printed or committed.)

### (a) Smoke build — proves the spending limit stops a build (~$0.75)

A small team-mode app with a low cap. It must stop partway with
"This build reached its spending limit of $0.75." and spend ≈ $0.80 at most.

```bash
export TEAM_MODE=on
export CADDIE_CAMPAIGN_CAP_MICROS=750000          # $0.75 hard stop
export SPEND_LIMIT_CAP_USD=0.75                   # per-build cap so it stops early
export CADDIE_ONLY_BRIEF=<one small brief id from tests/briefs>
bun scripts/brief-run.ts --team
```

Watch it in the dashboard **Browser** panel. What it proves live: the architect
review runs, builders stay in their own files, the save/restart/privacy checks
run in the real sandbox, and **the cap stops the build**.

### (b) The 5 MB publish test (~a few cents)

Publishes one throwaway app to find the real size limit. Run it whenever you
like (no hardcoded date):

```bash
export CADDIE_LIVE_AUTHORIZED=1
bun run test:live -- PUBLISH            # or the publish smoke the runbook names
```

### (c) The comparison campaign — ~19 builds, hard-stopped

The `$150` you asked about is a **kill-switch ceiling** (≈19 × the per-build
cap), not a target — real spend is far lower (~$40–75 expected). I recommend a
lower ceiling; set it explicitly:

```bash
export TEAM_MODE=on
export CADDIE_CAMPAIGN_CAP_MICROS=75000000        # $75 ceiling (recommended) — lower if you like
bun scripts/brief-run.ts --team
```

The runner stops the whole campaign the moment cumulative **real** spend hits
the ceiling (now counted correctly — finding #6/#7 fixes), drives each build in
a real browser you watch, and checks two-user privacy on each built app.

---

## What was fixed in this release (for your reference)

- **9 review findings** (`docs/reviews/2026-10-23-software-team-mode-review.md`):
  spend refund hole (#5), spend double-count (#6), campaign over-spend (#7),
  parallel-join stale base (#1), privacy-check unauthorized UPDATE (#2), route
  501 shadowing (#3), DB.batch no-op (#4), upload quota race (#8), published
  Run-now now honestly preview-only (#9).
- **2 P2s**: email admission race, reserved/duplicate field names.
- **Card redesign** and the **project Overview**.

Rollback handle for this release: `ad8b8c12-ab83-4895-92d1-a5e02381a8fe`
(`cd apps/app && bunx wrangler rollback ad8b8c12-ab83-4895-92d1-a5e02381a8fe`).
