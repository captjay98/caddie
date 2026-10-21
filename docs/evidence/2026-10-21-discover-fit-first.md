# Discover Fit first — 2026-10-21

The owner accepted the Fit first mobile Discover + hackathon detail direction in the design review. Existing mobile navigation and persistent chat remain. Desktop docking is a separate review concept; the local application retains its existing detail drawer.

## Changes

- `apps/app/src/client/discovery/Results.tsx`: separates Best for you / Saved from country context and an expandable filter section; Check again is a quiet action. Cards lead with organiser, title, an evidenced fit statement or source summary, submission deadline and prize. Structured themes replace prejoined metadata strips when the stored summary is only a dense strip. Eligibility, recorded fit evidence, assumptions and rule quotes remain inspectable. View opportunity is the primary list action; Save and the existing Find an idea shortcut remain.
- `apps/app/src/client/discovery/ContestDetailPane.tsx`: the header promotes deadline/prize; supporting event facts, tracks, awards, perks and judging remain behind named disclosures. Profile fit, summary caveats, watch-outs, eligibility verdicts and exact rules remain. Official event link is no longer incorrectly labelled Devpost for every source. Existing save, project handoff and eligibility/digest fetching behavior are unchanged.
- `apps/app/src/client/workspace.css`: consistent 13px card corners, flat internal dividers, 44px actions; container queries use two list columns only when the actual Discover content has 680px available, so opening/resizing chat also reflows cards.
- `tests/browser/discovery.spec.ts`: updates filter/country assertions; checks mobile controls, two primary facts, content bounds at 320/390/412/768/1440 and retained expandable prizes and verbatim entry quotes in detail.

```tsx
const primaryFacts = [
  ...(end ? [{ key: 'deadline', label: 'Submission deadline', value: end }] : []),
  ...facts.filter(part => part.key === 'prize'),
];
```

```css
.discovery-panel { container-type: inline-size; }
@container (min-width: 680px) {
  .discovery-panel .disc-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

## Verification

- LOCAL VERIFIED: `bun run typecheck`, exit 0; `/tmp/caddie-fit-types.log`.
- LOCAL VERIFIED: `bun run build`, exit 0; `/tmp/caddie-fit-build.log`.
- SIMULATED: composed-build browser suite with stubbed API responses, 13 passed. Exercises Save without creating a project, existing-project continuation, filters, source failures, conservative eligibility, responsive bounds, retained exact rule quotes, prize disclosure and closing detail back to the list. Final receipt `/tmp/caddie-fit-browser-final.log`.
- Initial sandbox launch FAILED before app assertions: macOS denied Chromium Mach bootstrap registration. The same suite passed when local Chromium could launch outside the sandbox. No application failure was hidden by this retry.
- DOCUMENTATION ONLY: desktop inline mockup is a review concept, with illustrative content, not live contest proof. Its detail/chat switch is local to that mockup.
- No deployment, publication, paid provider request, real import or build was triggered for this verification. Existing unrelated WIP was retained. Changes remain uncommitted.

## Settings inspection requested during this packet

LOCAL VERIFIED by reading the real local Profile and Interests screens and their code: Settings uses the shared `InterestPicker` with `compact=false`; onboarding uses its compact form. The fuller Settings picker is still present. Profile has country/timezone, experience, format and weekly hours. No profile values were edited or saved.

Design follow-up: mobile Settings hides later sections in a horizontal rail, uses small text inputs and a small Save changes action that differs from the accepted onboarding controls. Review section navigation, field/tap sizing, save feedback and the Interests/Skills grouping before changing the shared picker again. This is an inspection, not a completed Settings redesign or an audit of every settings action.
