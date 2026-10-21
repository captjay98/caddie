# Discover compact card + hybrid detail

Owner approved on 2026-10-21 after reviewing Reading page and Tabbed brief.

## Accepted scope

Cards show organiser, full clickable title, inline deadline/prize, format and conservative eligibility. Keep Save and a small Find an idea shortcut. Remove the redundant View opportunity button and the repeated large fact blocks. Card whitespace opens details; nested actions remain independent; the title remains the keyboard target. Keep all four mobile destinations and the persistent composer.

Detail keeps the reading-style title/header and Find an idea as its main action. Overview, Build, Entry rules and Prizes tabs group existing content. Overview retains summary, source text, fit evidence and unknown assumptions; Build retains tracks and judging; Entry rules retains verdicts, exact quotes and check action; Prizes retains awards and credits/perks. Watch-outs stay visible across tabs. No new provider behavior, backend contract or project-creation trigger.

## Implementation and verification

1. Narrow changes in `discovery/Results.tsx`, `discovery/ContestDetailPane.tsx` and discovery/detail rules in `workspace.css`. Preserve unrelated WIP.
2. Independent review of click isolation, evidence retention, tabs and responsive behavior.
3. Browser proofs: actions do not open details accidentally, card/title opens detail without creating a project, all tabs and source information work, already-loaded evidence survives a failed detail fetch, existing track-fit highlights survive grouping, keyboard arrows work, 320–1440px bounds/card-height checks. Typecheck/build/diff checks.
4. Local owner testing. No deployment or paid calls.

```tsx
const tabs = ['Overview', 'Build', 'Entry rules', 'Prizes'];
// Each tab controls an existing, labelled panel; inactive panels stay mounted.
```
