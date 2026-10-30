# Clean-slate walkthrough — issue log (2026-10-28, live UI pass)

Fresh local database (owner-intentional), walked as a non-technical lazy user in the
in-app browser. Screenshots in the session transcript. Owner corrections are marked
**[FIXED]** when implemented this pass; **[OPEN]** when recorded for the plan.

## Findings

1. **[FIXED] Deadline year fabrication (Nebius pane)** — the contest detail pane showed
   "Oct 30, **2001**, 6:00 PM GMT+1 · Your time" from a year-less listed value
   ("October 30, 1:00pm EDT"); `Date.parse` guesses 2001. `deadlineInstant` now requires
   an explicit 4-digit year; a time+zone without a year renders as "Exact closing time
   and time zone not confirmed." Regression-pinned in `tests/deadline-time.test.ts`.

2. **[OPEN] Model extraction inconsistency (answers the owner's model question)** —
   hackathon detail parsing is TWO pipelines: (a) deterministic regex over the listing
   summary (`parseEventDates`), and (b) rules reading by the **Nemotron-3-Nano**
   extraction model (`helperRules` role) writing verbatim claims. The claims store holds
   THREE conflicting Nano-extracted times for the same Nebius page —
   "October 30, 2026 (11:45 pm Eastern Time)", "October 28, 2026 (1:00 pm Pacific
   Time)", "October 30, 2026 (10:00 am Pacific Time)" — because the page carries
   several times (round dates, FAQ) and each read quoted a different section. The
   strict, claims-gated exact time (`contest-source-deadline.ts`) is wired to the
   project header/Brief; the **Discover detail pane** renders the digest fact instead,
   ungated. Recommendation: the pane should show the claims-gated instant when one
   passes and otherwise say "not confirmed — check the source"; conflicting claims
   should surface as "Caddie read different times in different places" rather than
   silently picking one.

3. **[FIXED] Landing surfaces (owner direction)** — web lands on Brief (with the
   Caddie panel); mobile already lands in chat. Onboarding's "Find a hackathon"
   destination changed from `/app/discover` to `/app/` (chat-first).

4. **[FIXED] Chat-first discovery (owner direction)** — Discover's empty state now
   hands off to the conversation ("Ask Caddie in chat", pre-filled ask) with the quiet
   in-page sweep as a secondary; onboarding no longer routes hackathon-seekers to
   Discover.

5. **[FIXED] Brief empty state (owner direction)** — no longer repeats the greeting;
   explains what will land here and offers one "Start in chat" action.

6. **[OPEN — URGENT, affects the other agent's work] Off-topic message accepted into a
   project conversation** — the Farmhand brief, sent from what presented as the
   Everything conversation, landed in the Street Food Share project conversation and
   was folded into that project's brief ("my street group shares spare food… " + the
   Farmhand requirements). Caddie raised no objection to a "start a new project"
   request inside an existing project's chat. Two required behaviors: (a) a project
   conversation must refuse or explicitly redirect a request to start a DIFFERENT
   project ("this is the Street Food Share conversation — start new projects from
   Home"), and (b) the StreetShare brief needs a supported correction before its plan
   is approved. NOT fixed by DB edit (another agent owns that flow).

7. **[OPEN] No undo / delete / edit for sent messages** — the owner hit this directly.
   Chat needs at minimum: edit-before-acknowledgment or delete-with-notice, per the
   Flue transport contract (`docs/flue-contracts.md` governs what is possible). Until
   then a mistaken send is permanent and can silently reshape a project's brief
   (finding 6).

8. **[FIXED] Preview routing (earlier this pass)** — built outputs no longer 404 on the
   Preview page; all 13 preview specs + 2 "beyond chat" specs pass.

9. **[FIXED] Tab rhythm + Build/Submit rework (earlier this pass)** — one content
   inset on every tab (measured 263px on Plan/Build/Submit); Build's change strip
   folds; ready app shows an "Open your app" entry instead of a second preview; Submit
   reduced from 864px of stacked sections to 529px with the technical detail folded.

10. **[OPEN, minor] Onboarding** — Continue was enabled with an empty country (the one
    field that powers eligibility); error copy "how you'd like to take part" is
    vague; the country combobox accepted free text without a visible pick.

11. **[OPEN, minor] Empty-state duplication resolved on Brief; Discover still says
    "Nothing here starts a build until you say so" in two places (page + chat panel
    copy).**

12. **[OPEN — owner direction] Chat must do everything on mobile.** Some steps still
    require navigating to the Projects page; on mobile that means constant switching
    between Caddie and project pages. Required capability: every gate (approve plan,
    approve design, try preview, ask-for-change, see checks) is actionable inline in
    the chat proposal/status cards, so a mobile user can take a project from idea to
    ready without leaving the conversation. (Implementation deferred: the chat-summary
    surface is the other agent's active file.)

13. **[Answered] Caddie's memory proposal** — Caddie proposed one memory fact: a
    faithful summary of the Farmhand requirements (verified accurate in
    `memory_facts`, status `proposed`). Approving keeps the constraints across
    conversations; nothing is stored until the owner decides.

14. **[FIXED — code] Quality-admission expiry deadlocked the planning phase.** The
    admission id derives from the dependency state, so after its 15-minute window
    expired, every save regenerated the same expired row and threw
    QUALITY_TIME_LIMIT forever (`qualityAdmission`). Fixed: an expired admission is
    replaced with a fresh window (bounded spend preserved). Pinned in
    `tests/artifact-quality.test.ts`.
15. **[OPEN — reliability] Stuck planning submissions hold the conversation lock.**
    Two failed submissions on Farmhand's first conversation kept re-deferring with
    the same failure, and no Stop exists for a planning-phase turn (Stop covers
    `building` only). Practical workaround used: create the project fresh (new
    conversation DO). The supported fix belongs to the reliability workstream
    (terminal-coordinator recovery, Oct-26 doc).

16. **[FIXED] Design-author routing was never exercised** — the looks prompt said
    "delegate the designer (or write it yourself)" and the LOOKS_BLOCK_GUIDE's own
    canonical example mock used self-closing `<i/>` tags, so the coordinator wrote
    looks inline on Super VL and the mocks rendered with overlapping-text blobs
    (three review rounds blocked on it — the deepseek screenshot reviewer was
    correct every time). Fixed: delegation-only prompt, HTML rule in both prompts,
    canonical example repaired. First MiniMax design-author call landed 18:06:58.
17. **[OPEN, minor] author-route labeling** — the design delegate's write_plan_note
    records the coordinator's chat route as authorRouteId instead of the
    specialist's own route; usage rows are correct, the candidate label is not.
18. **[Answered] "Check status" is a manual refresh (misleading label — rename to
    Refresh); "Discuss with Caddie" opens the conversation pane.**

19. **[FIXED] Reviewer downgrade on transient errors** — a single failed reviewer
    call moved the ladder straight to the weaker fallback (the owner saw Super VL
    scoring a design after one deepseek blip). The primary route now retries once
    before the ladder moves. NVIDIA-model inventory recorded for the owner: chat,
    build, helpers, generated-app AI (the hackathon REQUIRES NVIDIA models for the
    app's own AI), and reviewer fallbacks.

## Certification on this pass

- typecheck ✓ · build ✓ · full unit suite **2,838 pass / 0 fail** (before the owner's
  latest corrections; the deadline/landing/chat-first fixes re-ran their focused
  suites green after).
- 123 focused browser tests pass, including all preview navigation.
- Judge accounts: local fresh DB has none (will be created fresh in the judge
  walkthrough); production judge accounts are untouched.

## Migration fold (other agent's takeover, verified this session)

The 59-file migration history was folded to 4 files. Verified equivalent by replay:
every table column-identical, 129 indexes and 5 triggers matching, no missing or extra
objects. The dev DB registry was reconciled to the folded names. **Deploy note:** a
production D1 with the old history must have its registry reconciled before wrangler
applies the folded files.
