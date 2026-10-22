# HerdVoice judge demo — attempt 1 (2026-10-20/21) and the fix (2026-10-22)

## Outcome

**FIXED and verified live.** The build was green and the app is now usable
in the preview: it reaches its own server, it saves data, and that data
survives a reload.

## The defect (found 2026-10-22, not in the browser)

The app showed its own honest fallback — "You're offline — showing saved
cases" and "Couldn't sync the herd timeline. Check your connection and
retry." — while the relay answered every request when called directly.

The cause was in the app's own data layer, not in Caddie's relay and not in
the browser:

```js
function canReachApi() {
  return window.location.protocol === "https:" || window.location.protocol === "http:";
}
```

The preview frame was set as the iframe's `srcdoc`, and a `srcdoc` frame
reports the protocol `about:`. The app therefore decided it was offline and
**never called its server at all** — no request, no relay, nothing to fail.
An app that checks its own origin breaks in the preview and works when
published, which is why the build's own tests (running in happy-dom, where
the protocol is `http:`) never saw it.

Proof before the fix (reproduced locally with the real app document):
the frame's fetch bridge was installed, the app rendered, and the relay was
called **0** times; calling `fetch('/api/herd/timeline')` by hand inside the
same frame did reach the relay and returned `200 {"cases":[]}`. Removing the
protocol guard from the app's document made the app reach the relay on its
own — the offline banner disappeared.

## The fix

The frame is now loaded from Caddie's own URL: the server composes the frame
document (the app's page plus the preview's storage and fetch shims) and
serves it over https, so the app sees the protocol it sees in production.
The frame stays sandboxed **without** `allow-same-origin`, so its origin is
still opaque — the app can neither read the workspace's origin nor script
the page around it, and the network stays closed (`connect-src 'none'`).

The app's saved data travels up as a content-addressed seed and comes back
inside the served document, so the frame still starts with the app's own
storage. Builders are told the truth as well: the preview frame's origin is
opaque, so never gate a request on `location.protocol`/`origin`/`hostname` —
call `fetch` and handle the failure.

## What is proven (live, production)

- **LIVE VERIFIED** — the build finished with all six features `passed`
  (`build_workflows.phase = 'ready'`).
- **LIVE VERIFIED** — the preview no longer shows the offline state: it
  shows "No cases yet. Add your first animal or record a case." and the
  sync bar reads 0 pending / 0 synced / 0 failed.
- **LIVE VERIFIED** — adding an animal works: "Nurse Amina · Cattle ·
  Cases: 0" appears in the herd list.
- **LIVE VERIFIED** — the animal **survives a reload** (the screenshot
  below was taken after a reload), so the preview's storage round trip
  works: the parent's preview key holds the app's data, the seed travels
  up, and the served frame document carries it back.
- **LIVE VERIFIED** — the relay answers the app's calls with real data:
  `GET /api/animals` → `200 {"animals":[]}`, `GET /api/herd/timeline` →
  `200 {"cases":[]}`, `GET /api/disease-guide` → `200` with the real vet
  guide, and the preview metadata says `hasServer: true`.
- **LOCAL VERIFIED** — a new browser spec pins it: an app that checks its
  own origin still reaches its server through the relay, and the frame's
  origin stays opaque (`parent.document` → SecurityError).

## Still open

- `app_ai_usage` for this project holds **0 settled rows**: the judge's AI
  call has not been made yet (the demo path — type a case, get ranked causes
  and a next action, reload, see it in the timeline — has not been run end to
  end). That is the next step, and it is the proof the generated app's AI is
  real.
- The preview frame for an **imported** app (a GitHub repo) still uses
  `srcdoc`, so an imported app that checks its own origin has the same
  problem. The workflow preview (the one Caddie builds) is fixed.

## Evidence files

- `01-initial-load.png` — the first attempt, which used the wrong URL shape
  (`…/preview/<id>/app` is the POST relay for the app's own fetches, not the
  document route) and returned `{"error":"not_found"}`. Kept so the sequence
  of attempts is not rewritten.
- `02-herdvoice-after-the-fix.png` — the app in the preview after the fix:
  the sync bar, the herd list and **Nurse Amina** (saved before the reload).
