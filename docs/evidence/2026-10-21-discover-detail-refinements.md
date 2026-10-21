# Discover/detail owner refinements — 2026-10-21

Follow-up to the compact hybrid. Owner reported folded challenge facts, metadata duplication, repeated entry quotes, inconsistent action sizing, incomplete prizes, generic entry styling, and unstyled filters. Additional feedback requested Online inline beside prize, prize overflow repairs, improved Back/Entry rules, and three chat-card design alternatives.

## UI fixes

- `discovery/Results.tsx`: organiser opposite the entry verdict, quiet icon/text entry treatment, bookmark Save with an accessible name/pressed state, no list Find an idea. Full title/card opens the same detail. Online sits inline with deadline/prize. Filters use styled native checkbox choices and a clear apply action. Existing save, reveal/filter and project handoff behavior remain.
- `icons.tsx`: bookmark added to the existing local icon set.
- `discovery/ContestDetailPane.tsx`: Back first in a dedicated top bar, title then actual organiser/format, 48px footer actions with one primary action and equal secondary cells. Challenge facts are visible labelled rows; event facts are a readable definition list. Removed repeated generated metadata strips while retaining narrative source text and all themes. Fit headings/descriptions have separate readable lines.
- Entry rules uses one canonical copy of an exact quote and keeps its official-rules URL. Fallback quotes remain when canonical evidence is absent or failed. Coverage is explicit: one checked category is one recorded category, not a claim that the whole rules document was summarized. Categories open by default; technical check reasoning is optional. Raw absent rule sections are never invented.
- Prize benefits wrap and are split only at the source's literal Markdown bullet separators. Award title, benefits, number of awards and conditions are separate. Unmatched model awards remain in a clearly labelled verify-on-source disclosure rather than silently disappearing or competing with sourced awards.

```tsx
const canonicalCoversEntry = Boolean(entryQuote && groups.some(group =>
  group.kind !== 'fit' && group.claims.some(claim => quoteKey(claim.quote) === quoteKey(entryQuote))
));
// Only suppress the fallback when this exact quotation is already represented.
```

## Missing prize amounts: root cause and repair

Read-only inspection of local evidence found Nebius's overview snapshot had 4,811 characters and omitted cash amounts. Its stored binding-rules snapshot had 38,314 characters, with the complete prize table around character 21,151. The cached digest had blank cash amounts and assigned hardware to 2nd/3rd place. The model had received overview prose plus six eligibility quotes, never that prize table. This was source selection and cached summarization, not frontend truncation or the 12k overview cap.

- New `server/discovery-prizes.ts` parses only explicitly labelled Markdown prize tables. It keeps exact labels, rewards, quantities and eligibility. Explicit aliases Qty and Eligible Submissions support the stored Amazon table. Ambiguous/duplicate labels or columns fail closed. No currency conversions or quantity multiplication.
- `server/discovery.ts` reads the existing actor/project-scoped binding-rules snapshot. Official rows are returned independently of an AI summary; exact-label matches correct blank AND incorrect cached amounts at read time. No cache deletion, invalidation, model rerun or data migration.
- The stored Amazon table now yields all 12 awards, including quantities/conditions. Nebius yields all 10, including cash, hardware and feedback rewards. Stored-source evidence is not a fresh/live verification of the external websites.

```ts
const officialPrizes = parseOfficialPrizes(snapshot.content);
digest = overlayOfficialPrizeAmounts(digest, officialPrizes);
// Cache hits remain cache hits; the model-call counter does not increase.
```

## Verification

- LOCAL VERIFIED: `bun run typecheck`, exit 0, `/tmp/caddie-polish-types.log`.
- LOCAL VERIFIED: `bun run build`, exit 0; composition `4bb5ae58b42a`, `/tmp/caddie-polish-build.log`.
- LOCAL VERIFIED: `git diff --check`, exit 0.
- LOCAL VERIFIED: `bun test tests/discovery-prizes.test.ts tests/discovery.test.ts`, 46 passed / 0 failed /142 assertions, `/tmp/caddie-polish-server.log`. Includes table parsing beyond12k, exact cache corrections with no additional model call, scope denial, combined hardware/cash, optional-column aliases, ambiguity and unchanged unknown layouts. Synthetic fetch restored in finally.
- SIMULATED: composed-app browser suite `tests/browser/discovery.spec.ts`, 14 passed / 0 failed, `/tmp/caddie-polish-browser-final.log`. 320–1440px containment, styled header alignment, bookmark isolation, opening detail before Find an idea, visible challenge facts, Back-before-title, equal48px footer actions, rules de-duplication/source link, full long prize benefits, unmatched-award retention, keyboard tabs and evidence retention on failure.
- Review caught partial official tables hiding unmatched digest prizes and a leaking test fetch stub; both fixed before final checks. Earlier browser checks exposed a 44px primary-action specificity override and non-atomic resize measurements; final checks confirm the corrected geometry and all assertions pass.
- DOCUMENTATION ONLY: three chat alternatives are inline review mockups: Compact highlight, One shortlist, Recommendation note. Titles, bookmarks, local detail tabs and carousel interactions inspected. No chat-card redesign applied pending owner selection.

All implementation changes remain local/uncommitted. No deployment, push, paid call, new remote or profile/database reset. Unrelated WIP preserved. Settings remains a separate review task.
