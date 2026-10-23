# Discovery deadline presentation — 23 October 2026

The eligibility badge previously said “Can enter” even though its verdict only checked profile requirements. Calendar-only listing deadlines displayed as an ordinary month/day on the deadline date. Detail rendering retained the original source time but did not show the viewer’s preferred local time.

## Changes

- Shared chat/Discover eligibility presentation now says “Eligible” in compact chips and “Your profile meets the checked entry rules” for the generic full label. Country/age evidence and engine verdicts are unchanged.
- Shared deadline formatting shows Today on the relevant calendar date. A timestamp with a confirmed offset that has passed produces Closed; a date-only value never invents a closing hour.
- Detail uses the profile timezone, falling back to browser timezone. When an exact zoned time is parseable it shows the converted date, time and offset plus the original listed wording. Without one it explicitly says closing time/timezone are unconfirmed.
- Both Discover and chat pass the raw deadline into the detail pane.

```ts
const instant = deadlineInstant(value); // requires a clock time and explicit supported zone/offset
const closed = instant !== null && instant <= now.getTime();
```

Changed: `discovery/deadline-time.ts`, `discovery/ContestDetailPane.tsx`, `discovery/Results.tsx`, `conversation/hackathon-format.ts`, `conversation/HackathonResultsCard.tsx`, `conversation/Channel.tsx`, shared workspace CSS; tests `deadline-time.test.ts`, `hackathon-card-builder.test.ts`.

## Evidence

- LOCAL VERIFIED — 27 focused tests passed, 78 assertions: deadline conversion/precision/local-date boundary, detail facts, actual shared card server-side rendering. Source example Oct 23 2026 12:00pm PDT converts to 20:00 Africa/Lagos and becomes closed at 19:00 UTC.
- LOCAL VERIFIED — `bun --cwd=apps/app run check:types`: exit 0 before the final raw-deadline prop wiring.
- LOCAL VERIFIED — actual local Discover rendered Amazon as Eligible / Due Today; shared chat rendered Today and the more precise eligibility wording. Detail showed honest unconfirmed wording while its digest was loading.
- BLOCKED — final full detail conversion screenshot was interrupted by browser navigation and concurrent hot updates. The conversion has deterministic test evidence, not a completed real-provider browser proof.
- BLOCKED — root `bun run typecheck` fails in another agent’s `tests/browser/zz-capture.spec.ts:71` (readonly array assigned to mutable unknown[]). That file was left untouched.

Limitations: listing date-only data cannot establish the exact closing instant. This change does not assess whether a person can finish and submit a worthwhile project in the available hours. That requires a separate discovery fit judgment. Existing model-generated digest times remain summaries of the source; official event rules remain authoritative.
