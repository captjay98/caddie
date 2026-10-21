# HerdVoice judge demo — attempt 1 (2026-10-20/21)

## Outcome

**FAILED — the preview renders blank.** The build itself is green; the app
does not show up.

## What is proven

- **LIVE VERIFIED** — the build finished: `build_workflows.phase = 'ready'`
  for `proj_679f326dd7d87d114e328fd143562f55`, with all six features
  `passed` (animal-registry, case-capture, ai-analysis, herd-timeline,
  offline-sync, disease-guide). The host checks (dependencies,
  behaviour tests, browser build, server starts on Cloudflare) all
  returned green receipts.
- **LIVE VERIFIED** — the stored preview output is the generated app, not
  Caddie's shell. `GET /api/projects/proj_679f…/workflow/preview/out_b9ec4ae6…`
  returns `200`, `content-type: text/html`, and the body is
  `previewDocument(...)`: `<title>Your app</title>` with HerdVoice's own
  `src/styles.css` and `src/main.tsx` bundle inlined. It does NOT contain
  Caddie's workspace entry.
- **LIVE VERIFIED** — the app's JavaScript runs in the browser without a
  single console or `pageerror` entry, and mounts nothing: `#root` has 0
  children, `document.body.innerText` is empty, and 0 elements match
  `main, header, nav, section, article, button, input, textarea`.
- **LIVE VERIFIED** — `app_ai_usage` for this project holds 0 settled rows:
  no judge-facing AI call has been made yet (the demo path never ran).

## The defect

The host's `browser-bundle` check proves the bundle **builds**; it never
proves the app **renders**. A build can be green and produce a blank page
for the person the demo is for.

## Evidence files

- `01-initial-load.png` — the first attempt at the preview URL, which
  returned `{"error":"not_found"}` (that URL carried the `/app` suffix,
  which is the POST relay for the app's own fetches, not the document
  route). Kept so the sequence of attempts is not rewritten.

## Next step

Read the generated app's `src/main.tsx` (it is in the code store under
`local_code_commits` for repo `p-proj_679f326dd7d87d114e328fd143562f55`)
and find why the mount is skipped without throwing — most likely an
environment guard that assumes Caddie's preview relay is present, which a
direct page load is not.

Separately: add a host check that loads the built document and asserts the
app mounted (a root element with children), so a green build can never
mean a blank app again.
