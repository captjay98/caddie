# HerdVoice judge demo — attempt 1 (2026-10-20/21)

## Outcome

**PARTIAL.** The build is green and the app renders. What does NOT work is the
app's ability to reach its own server inside the preview, and the failure
appears only in one browser profile. Every step below is a receipt, not a
claim.

## What is proven

- **LIVE VERIFIED** — the build finished: `build_workflows.phase = 'ready'`
  for `proj_679f326dd7d87d114e328fd143562f55`, with all six features
  `passed` (animal-registry, case-capture, ai-analysis, herd-timeline,
  offline-sync, disease-guide) and green receipts for dependencies, behaviour
  tests, the browser build and the server starting on Cloudflare.
- **LIVE VERIFIED** — the stored preview output IS the generated app:
  `GET /api/projects/proj_679f…/workflow/preview/out_b9ec4ae6…` returns `200`
  with `previewDocument(...)` — `<title>Your app</title>`, HerdVoice's own
  `src/styles.css` inlined, and the app's bundle. It does not contain
  Caddie's workspace entry.
- **LIVE VERIFIED** — the app RENDERS in the preview frame, through the real
  user path ("Try the app"): the herd timeline screen with "Record a case",
  "Disease guide" and "Add your first animal", and the empty-state text. The
  same for the other two built apps (Acceptance Check shows its habit-tracker
  UI; FarmLog AI has its own preview id).
- **LIVE VERIFIED** — Caddie's preview relay works. Called directly from the
  signed-in browser: `GET /api/animals` → `200 {"animals":[]}`,
  `GET /api/herd/timeline` → `200 {"cases":[]}`,
  `GET /api/disease-guide` → `200` with the real vet guide, and
  `GET …/preview/out_b9ec…/metadata` → `{"kind":"web","hasServer":true}`.
- **LIVE VERIFIED** — the app's own code is sound: `src/main.tsx` is
  `createRoot(document.getElementById("root")!).render(<App />)`, `App.tsx`
  renders real screens, and the whole source set is in the code store.
- **LIVE VERIFIED** — `app_ai_usage` for this project holds 0 settled rows: no
  judge-facing AI call has been made yet, because the demo path never ran
  end-to-end (the case could not be analysed without the server).

## The defect that is real

Inside the preview frame the app cannot reach its server:

- the app shows its own honest fallback — "You're offline — showing saved
  cases" and "Couldn't sync the herd timeline. Check your connection and
  retry.";
- a parent-side hook (a `message` listener plus a `fetch` wrapper on the
  Caddie page) records **no** postMessage from the frame and **no** relay
  call — so the frame's `fetch('/api/…')` never reaches the relay;
- the frame's fetch-bridge shim (the inline script that replaces
  `window.fetch` and forwards to the parent) is present in the document and
  parses, and evaluating it by hand inside the frame installs it perfectly.

## Where it does and does not reproduce

| Environment | Result |
|---|---|
| Local Chromium 153 (Playwright), the byte-identical composed document | shim installs, app mounts, relay path exercised by `tests/browser/interactive-preview.spec.ts` — 10/10 pass |
| The owner's Aside browser profile (Chrome 153) | shim does not take effect: the app renders but every `/api` call fails |

The repository's own browser spec proves the design is sound (it exercises the
relay, the storage bridge, the cookie jar and the egress refusal in a real
browser). The difference is not the engine version — the local run is the same
Chrome 153 — so the remaining difference is that browser profile.

**The shims must stay classic scripts.** Converting them to module scripts
(defers them past the app's own first statements) breaks the ordering a
generated app needs: an app may read `localStorage` or call `fetch` at parse
time. That change was tried on 2026-10-21 and broke 3 of the 10 browser specs
before it was reverted; the reason is now written down in the source.

## Next step

1. Open the HerdVoice preview in a browser outside the Aside profile and add
   an animal. If the app can reach its server there, the defect is confined to
   that profile and the judge path is unaffected. If it fails everywhere, the
   preview needs a different interception strategy (an isolated preview origin
   is already designed for in `docs/setup/previews.md`).
2. Then run the 3-minute judge path and prove the AI call: `app_ai_usage` must
   show a settled row for the project.

## Evidence files

- `01-initial-load.png` — the first attempt, which used the wrong URL shape
  (`…/preview/<id>/app` is the POST relay for the app's own fetches, not the
  document route) and returned `{"error":"not_found"}`. Kept so the sequence of
  attempts is not rewritten.
