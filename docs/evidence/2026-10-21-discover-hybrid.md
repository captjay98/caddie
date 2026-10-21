# Compact Discover + hybrid detail — 2026-10-21

Owner accepted compact clickable cards with visible entry status, Save and a small Find an idea action, plus a reading-style detail header and Overview / Build / Entry rules / Prizes tabs. No View opportunity / Join opportunity action on the list.

## Defect and fix

The first Fit first implementation was too tall: title, summary, labelled facts, entry status, quote disclosure, full-width View opportunity and secondary actions each occupied separate rows. The previous mobile Amazon card was roughly 430px tall. Compact browsing should not require all that height.

`apps/app/src/client/discovery/Results.tsx` now presents organiser, full title, inline deadline/prize and a combined entry-status/action row. Removed the redundant View opportunity button, summary strip and inline evidence disclosures. Fit evidence and source summaries moved into Overview; quoted entry evidence moved into Entry rules. Card whitespace and title open details; Save, Find an idea, eligibility checking, links and text selection retain their independent behavior. No project is created by opening detail or saving.

```tsx
if ((event.target as Element).closest('button, a, input, summary, details')
    || window.getSelection()?.toString()) return;
setDetailId(row.id);
```

`apps/app/src/client/discovery/ContestDetailPane.tsx` retains the reading header, visible eligibility, source link, Save and main Find an idea action. Labelled tabs have associated panels, roving keyboard focus, ArrowLeft/ArrowRight/Home/End handling and reset to Overview when reopened. Panels stay mounted so expanded rule disclosures are preserved while switching tabs. Watch-outs remain visible across all tabs.

- Overview: AI summary with caveat, original source summary, event facts, supported fit claims and unresolved assumptions, suggested fit tracks.
- Build: all tracks and judging criteria, including existing track-fit highlights.
- Entry rules: original quoted rule evidence, conservative verdicts, exact grouped rule quotes/reasons, and check action.
- Prizes: award names/amounts and all credits/perks.

`apps/app/src/client/workspace.css` makes card facts compact inline text, uses consistent 13px corners and 44px actions, retains responsive grid behavior, and styles the tab strip without adding nested frames.

## Review findings fixed

Independent read-only review identified three retention defects in the first hybrid draft. All were fixed and re-reviewed without further findings:

1. Build's fit highlight was derived from the Overview-only filtered fit list. The full digest now owns that lookup:

```tsx
const fitNames = new Set(
  (digest.fitTracks ?? []).map(f => f.name.toLowerCase()),
);
```

2. Moving stored evidence under the successful detail-response gate hid already-loaded evidence when detail loading failed. Tab panels and supplied fit/rule evidence now exist independently of that response. A failed detail request leaves the source summary and fit claims readable alongside Retry.
3. Removing the card summary dropped the original source summary when no digest existed. Overview now keeps `data.candidate.summary || props.sourceSummary` under From the event listing, including loading and failure states.

## Verification

- LOCAL VERIFIED: `bun run typecheck`, exit 0. `/tmp/caddie-hybrid-types.log`.
- LOCAL VERIFIED: `bun run build`, exit 0; composed service-worker build `bea60ca12a2f`. `/tmp/caddie-hybrid-build.log`.
- LOCAL VERIFIED: `git diff --check`, exit 0.
- SIMULATED: `bunx playwright test tests/browser/discovery.spec.ts --workers=1 --reporter=line --max-failures=3`, 14 passed, exit 0. `/tmp/caddie-hybrid-browser-final.log`. Composed app with explicitly stubbed API/provider data. Checks source failures, strict eligibility, filtering, save/unsave without creating a project, project continuation/confirmation/failure, nested action isolation, title and card-whitespace opening, reset on reopen, keyboard tab navigation, exact quoted rules, source summaries, track-fit highlighting and evidence after a 503 detail response. Long-title card containment/height measured at 320/390/412/768/1440px; detail containment at 320/390/768/1440px.
- LOCAL VERIFIED: running local owner session list read without starting a feed, build or model request. First three desktop cards measured 141px each with chat open; mobile at 390px measured 163/141/141px, without horizontal overflow. Four bottom tabs/composer remain. Screenshot: `/Users/captjay98/.codex/visualizations/2026/10/20/01a156e1-6c71-7120-8b86-2f4f02367ff6/caddie-hybrid-mobile-verified.png`.

Local UI and deterministic browser evidence are not LIVE VERIFIED provider/build proof. Settings redesign is not part of this implementation. No deployment, push, remote publication, paid request or new remote. All changes remain local/uncommitted with unrelated WIP preserved.
