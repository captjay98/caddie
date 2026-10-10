# Caddie v2 redesign — implementation handoff

Status: DESIGN REFERENCE · owner-reviewed prototype, not code. Date: 2026-10-10.
Proposed repo location: `docs/design/2026-10-10-v2/` (this file + the prototype folder).
Packets: `PACKETS.md` next to this file.

## 0. Read this first

- The HTML in this folder is a **visual and behavioural reference only**. Rebuild every
  surface in the existing React SPA (`apps/app/src/client/`) and Astro site
  (`apps/site/`) using `packages/ui/src/tokens.css`. Do not copy prototype markup,
  `assets/caddie.js`, `assets/caddie.css`, or demo data into the app.
- Read `AGENTS.md`, `docs/flue-contracts.md` and
  `docs/reviews/2026-10-09-navigation-brief-default.md` before starting. v2 refines that
  approved navigation; it does not replace it.
- Route registration (`routes.tsx`), shared contracts, migrations, manifests and ledgers
  are integration-lead owned. Every route/contract change below is a **proposal**.
- Evidence classes per `AGENTS.md`. A prototype screenshot match is LOCAL VERIFIED at
  best; nothing in this redesign is LIVE VERIFIED until P17-style hosted checks run.
- Open `index.html` in this folder for the review page: every screen, every modal link,
  the route table and the word list. Most screens accept `?open=<modal-id>` and
  `?state=loading|error` so you can see each state without clicking through.

## 1. What the redesign is

One idea per screen, plain words, Caddie always one step away.

1. **Caddie is always present.** Desktop: content on the left, the Caddie chat on the
   right of every page. Mobile: four tabs, Caddie first, and an "Ask Caddie…" input
   above the tab bar on every other tab.
2. **Less on each screen.** Each screen leads with a single decision and one primary
   button. Secondary detail (prizes, sources, older versions, logs, code) folds away or
   sits under "For developers".
3. **Beginner-friendly words** everywhere, including Caddie's own replies (§6).
4. **A character** whose face shows what Caddie is doing (§7).

## 2. Route map (proposal for the integration lead)

Keep every existing path working. Paths that lose their own page become redirects with
explicit search params, so links, history and browser tests don't silently break.

| Route today | Component today | v2 home | Prototype file | Proposal |
|---|---|---|---|---|
| `/` | `Shell` | Desktop: Brief + chat. Mobile: Caddie tab (`?pane=brief` = Brief tab) | `brief.html`, `caddie.html` | Keep. Rename Chat → Caddie. |
| — | — | Full-screen chat (desktop "expand", mobile tab 1) | `caddie.html` | Keep `?pane=channel`; optional `/caddie` alias |
| `/onboarding` | `Start` / `IdeaForm` | Welcome with Caddie's introduction, then 3 steps | `welcome.html` | Keep |
| `/discover` | `DiscoverPage` | Discover | `discover.html` | Keep |
| `/discovery` | redirect | Hackathon detail ("Can you enter?") | `opportunity.html` | Keep current redirect target |
| `/projects` | `ProjectsPage` | Projects + New project + Bring your code | `projects.html` | Keep |
| `/project` | `ProjectOverviewPage` | Overview (next step, app so far, to-dos, recent) | `project-overview.html` | Keep |
| `/tasks` | `TasksPage` | To-do list on Overview | `project-overview.html#todo` | Redirect → `/project?project=…#todo` |
| `/design-review` | `DesignReviewPage` | Plan (step 1) | `project-plan.html` | Keep path, label "Plan" |
| `/runs` | `RunsPage` | Build (step 2), opens on the running app | `project-build.html` | Keep path, label "Build" |
| `/artifacts` | `ArtifactsPage` | Build › Files ("for developers") | `project-build.html` (Files tab) | Redirect → `/runs?tab=files` |
| `/evidence` | `EvidencePage` | Check (step 3) + proof drawer | `project-check.html` | Keep path, label "Check" |
| `/judge` | `JudgePage` | Check › Score it yourself (drawer) | `project-check.html?open=score` | Redirect → `/evidence?open=score` |
| `/submission` | `SubmissionPage` | Submit (hackathon) / Share (personal) | `project-submit.html` | Keep path |
| `/schedules` | `SchedulesPage` | Project settings › Routines | `project-settings.html#routines` | Redirect → new project-settings route |
| `/repositories` | `RepositoriesPage` | Project settings › Code | `project-settings.html#code` | Redirect → new project-settings route |
| `/automations` | `AutomationsPage` | Settings › Routines | `settings.html#routines` | Redirect → `/settings?tab=routines` |
| `/usage` | `UsagePage` | Settings › Spending | `settings.html#spending` | Redirect → `/settings?tab=spending` |
| `/settings` | `Settings` | Settings, 8 tabs | `settings.html` | Add `?tab=` |
| `/search` | `SearchPage` | Search results (from ⌘K "See all results") | `search.html` | Keep |
| `*` | not-found state | Not found / missing project | `not-found.html` | Keep |
| — | none | **Project settings** (new) | `project-settings.html` | **New route**, e.g. `/project/settings` |
| signed-out | `states.tsx` sign-in | Sign in | `sign-in.html` | Keep |
| site `/` | `apps/site` | Landing (refined, not rewritten) | `landing.html` | Keep |

Do **not** implement `landing-discovery-draft.html`; it was rejected.

## 3. Shared shell

Reference: any app page (best: `brief.html`, `project-plan.html`, `caddie.html`).
Components today: `workspace/Chrome.tsx` (`WorkspaceChrome`), `workspace/Shell.tsx`,
`workspace/ProjectTabs.tsx`, `conversation/*`, `workspace.css`.

### 3.1 Breakpoints

| Width | Layout |
|---|---|
| ≤ 760px | Mobile: one panel, floating bottom tab bar, "Ask Caddie…" above it |
| 761–1080px | Content full width; Caddie opens as a right overlay `min(420px, 100vw)` with a scrim, from a "Caddie" button in the top bar |
| ≥ 1081px | Two panels: content left, Caddie right |

Decision for the owner: the app's two-panel shell starts at 768px today. v2 moves the
two-panel threshold to 1081px so the content column never drops under 520px. If the
owner keeps 768px, apply §3.2's limits from 768px instead.

### 3.2 Caddie panel width (desktop)

- Default **40% of the window**. Minimum **340px**. Maximum
  `min(60% of window, window − 520px)` (the page always keeps 520px), never below 340px.
- Resize by dragging the panel's left edge. The handle is `role="separator"`,
  `aria-orientation="vertical"`, focusable, with `aria-valuenow/min/max` in percent and
  `aria-valuetext="Caddie takes N% of the window"`.
- Keyboard on the handle: ←/→ ±2% (Shift ±10%), Home = minimum, End = maximum,
  Enter = reset to 40%. Double-click = reset. While dragging, show a small "N%" tip
  ("· default" at 40%).
- Persist the fraction (not pixels) per browser; re-clamp on window resize.
- Settings › Appearance has "Reset Caddie width" doing the same reset.
- Messages inside a wide panel keep a reading column of about 720px, centred.
- States: open, **closed** (a 64px rail showing only the character; click to reopen),
  **full screen** (`?pane=channel`, the same chat at page size). Remember open/closed.

### 3.3 Top bar / capsule (desktop)

Left panel only: wordmark, tabs **Brief · Discover · Projects**, quick search button
(⌘K and `/`), account avatar. The Brief tab keeps its unseen badge
(`GET /api/brief` read state, already built). No full-width header.

### 3.4 Mobile tabs

- Tabs: **Caddie · Brief · Discover · Projects**. Caddie is the default on first open.
- On every tab except Caddie, an "Ask Caddie…" input sits directly above the tab bar,
  showing the character's current mood. Tapping it opens the Caddie tab already
  "talking about" the thing on screen (the current project, or Everything).
- Touch targets ≥ 44px. No horizontal scroll at 390px.

### 3.5 "Talking about" (chat scope)

- A switch at the top of the chat: **Everything** plus one entry per active project.
- Each scope has its own thread and its own unsent draft. Opening a project page
  switches the chat to that project; it does not wipe the other thread.
- `channel-store.ts` already keys drafts by `sessionKey + projectId`. Whether the
  coordinator keeps a separate *thread* per project is UNVERIFIED — see §8.

### 3.6 Chat message types

Reference: `caddie.html`.

- Caddie's working steps are folded by default ("Thought for 6s"). Never show raw
  reasoning; reuse the existing typed tool/file parts.
- Result cards (plan, build, check, file) open the matching screen.
- **"OK to spend?" card** inside the chat: what, the cap, Allow / Not now. Must call the
  existing approvals API; the card's state comes from the server, not the chat text.
- Messages from routines are labelled with the routine name.
- **Unsent state:** when the connection drops, a strip says Caddie can't be reached and
  is retrying; your messages stay in place marked "Not sent" with Send again · Edit ·
  Discard. Retry must reuse the original idempotency key (P06 acceptance). Leftover
  typing is labelled "Draft from earlier · not sent yet".

### 3.7 Project header and steps

Reference: `project-plan.html` header. Replaces `ProjectTabs` + `ProjectSubTabs`.

- Project name (links to Overview), what it's for, deadline chip, gear → Project settings.
- A four-step bar **Plan · Build · Check · Submit** (or **Share** for personal
  projects). Each step shows its own status in words ("Needs your OK", "4 of 6 ready",
  "Not started") and a colour. Never colour a step green unless it is done.
- Build's Files and Check's scoring are tabs or drawers inside their step, not sub-tab
  strips.

### 3.8 Page states (every page)

- **Loading:** the title and project steps stay real; only the content below is replaced
  by shaped placeholders, the "thinking" character and a specific line
  ("Loading your projects…"). See any page with `?state=loading`.
- **Couldn't load:** "stuck" character, "Couldn't load X", "Your work is safe — this is
  only the connection", Try again now, Ask Caddie what happened. `?state=error`.
- Extend `states.tsx` (`StatePanel`) rather than adding a second state system. Keep its
  existing kinds (denied, offline, stale, limit, cancelled).

### 3.9 Theme

- Key stays the app's existing `localStorage['caddie-theme']` = `'light' | 'dark'`
  (the prototype's `caddie2.theme` is demo-only). The site and app share an origin
  (composed into one Worker), so one key covers landing, sign-in and the app.
- Save only when the user picks a theme. Never write the key just by loading a page.
- No saved choice: landing and sign-in follow `prefers-color-scheme`; the app keeps its
  current dark default (owner may choose to align them).
- Apply before first paint on every entry point (`main.tsx` already does; the site needs
  an inline head script). The toggle is a 44px icon button whose label names the theme
  it switches **to**.
- Light hover on filled amber/blue buttons darkens; never lighten text on hover.

## 4. Screens

Each item: what it shows · states · windows · component(s) to change. Prototype file in
brackets. Content in prototypes (projects, costs, builds, the preview app) is made up;
hackathons are real Devpost listings used as sample content only.

### Brief [`brief.html`] — `Shell` / `brief/DecisionCard.tsx`
- Date, a one-line title, then **at most three cards**. Card: coloured label, one
  headline, 2–3 sentences with key facts bold, **one** button. One card type shows both
  sides of a trade-off.
- Below: deadlines as coloured rows; finished items folded ("Done · 4").
- Data: existing `GET /api/brief` + `POST /api/brief/read`. Choose the top three by
  the server's order; don't re-rank on the client.
- States: empty ("Nothing needs you"), loading, error.

### Caddie (full-screen chat) [`caddie.html`] — `conversation/Channel.tsx`, `Composer.tsx`
- Same as §3.5–3.6 at page size. Greeting uses the user's first name (§4 Welcome).

### Discover [`discover.html`] — `DiscoverPage`, `discovery/Results.tsx`
- One list. Segmented **For you · Saved**, plus two filters. Row: dates, prize, "You can
  enter" / "Can't enter", one reason it fits. No search or sort.
- Hackathons you can't enter are hidden by default with "Show N you can't enter".
- "Saved" needs server work (§8).

### Hackathon detail [`opportunity.html`] — discovery detail
- "Can you enter?" in one sentence; "What you'll hand in" as short lines. Prizes, dates,
  fit, sources folded. One primary button: **Find an idea**.
- Window `explore-ideas` (2 steps): pick or type an idea → confirm → creates the project.
  No project exists until the user confirms.

### Projects [`projects.html`] — `ProjectsPage`
- Card per project: name, what it's for, "Step N of 4 · <step>" in words plus four
  small bars, one line of what Caddie is doing. Archived folded.
- Buttons: **New project** (primary), **Bring your code** (secondary).
- Window `import-repo`: search your repos (GitHub installations API), choose "keep
  improving it" or "enter it in a hackathon", confirm. States that Caddie only reads
  the repo at first.

### Overview [`project-overview.html`] — `ProjectOverviewPage`, `tasks/Tasks.tsx`
- Next step with one button, "Your app so far" (preview), to-do list, folded "What
  happened recently". Window `add-task`. Tasks API already exists.

### Plan [`project-plan.html`] — `DesignReviewPage`, `planning/DesignReview.tsx`
- Order: "Is this OK?" bar → what you're making in one sentence → before/after → what
  the screens will look like → whether it still follows the rules. Folded: things left
  out, earlier versions (anchor `#earlier`), code changes.
- Windows: `approve-plan` ("Looks good — build it", states the spend cap) and
  `request-changes` ("Suggest a change").
- Approval must go through the approvals API. Stored decisions: see §8.

### Build [`project-build.html`] — `RunsPage`, `runs/RunInspector.tsx`, `artifacts/Viewer.tsx`
- Opens on the working app (private preview via existing previews API), "Try it",
  "Building now" status, past builds as sentences ("Build stopped — the PayPal test
  login had expired"). Tabs: Activity · Files ("Code — for developers").
- Drawer `run-drawer` (one build in detail). Window `change-request`.

### Check [`project-check.html`] — `EvidencePage`, `JudgePage`, `evidence/Drawer.tsx`, `judge/Scorecard.tsx`
- "4 of 6 things are ready" → hand-in list (ready / almost / missing, one fix each) →
  what judges look for with Caddie's honest read.
- Drawer `proof` on each ready line. Window `licence` (pick a licence).
- Drawer `score` (**Score it yourself**): 1–5 per criterion, optional note. A blank is
  never saved as 0: name each missing line. Your scores sit beside Caddie's read and
  disagreements are pointed out. Uses existing `judge/rubric`, `assessment`,
  `scorecards`.
- Personal projects: "No judges here" and the step is optional.

### Submit / Share [`project-submit.html`] — `SubmissionPage`, `submission/Package.tsx`
- Hackathon: what's left, then each Devpost field ready to copy. The user submits on
  Devpost; Caddie never submits. Windows `video-link`, `record-submission`
  ("I've submitted").
- Personal (`?p=pantry` in the prototype): Share — send a link, save to GitHub,
  download. No contest rules.

### Project settings [`project-settings.html`] — NEW route
- Sections: General ("What it is" + Edit), Code, Routines, What Caddie knows, Archive or
  delete.
- Windows: `edit-description` (character count, can't save empty, notes that an
  approved plan isn't changed; `PATCH /api/projects/:id`), `connect-repo`,
  `new-routine` (schedules API), `correct-memory` (memory correct/retract),
  `delete-project` (type the project name; archive already exists).

### Settings [`settings.html`] — `settings/Settings.tsx`
- Tabs: **You · Interests · Build tools · What Caddie knows · Connected accounts ·
  Routines · Spending · Appearance** (`?tab=profile|interests|tools|knows|accounts|
  routines|spending|appearance`).
- You: Name field, hint "Caddie greets you by this name." Writes the profile.
- Build tools (was Stacks): from `GET /api/stacks`. `enabled` → "Being proven first"
  (react-hono); `planned` → "Later". Never say "ready"/"verified" until the feature
  ledger does. Each "Later" tool has a **Tell me when it's ready** toggle
  (`aria-pressed`, tool name in the label) — server work, §8. "Start a project" lists
  Later tools greyed out.
- What Caddie knows: each fact says where it came from ("You said this in chat",
  "Caddie guessed this — not confirmed"); window `correct-memory`.
- Spending: existing `GET /api/usage`. Show "No budget set" honestly, never a fake number.
- Appearance: theme, Reset Caddie width.

### Quick search (⌘K) and Search results [`search.html`] — `search/Search.tsx`, `SearchPage`
- ⌘K / `/` palette: screens, projects, hackathons, recent chats; typing adds
  "See all results for…" → `/search?q=`.
- Results page: type label (Project, Plan, To-do, Caddie knows, Hackathon), matching
  words highlighted, filter chips with counts, 5 per page "1–5 of 7" + Previous/Next.
  States: empty query (recent searches), no matches, loading, error.
- Existing `GET /api/search` returns `project | planDoc | task | memory` with
  limit/offset. Map `planDoc` → "Plan", `task` → "To-do", `memory` → "Caddie knows".
  Hide the Hackathon filter until the server supports it (§8). Say plainly that chats
  aren't searched yet.

### Welcome [`welcome.html`] — `onboarding/Start.tsx`
- Opens with Caddie introducing itself, one line at a time, face changing per line.
- Asks "What should I call you?", **prefilled** with the first name from
  `session.user.name` and a line "From your Google/GitHub account. Change it if you
  like." Text pre-selected. Rule: take the first word of the name; if the whole name is
  a single token containing digits or symbols (a GitHub username like `captjay98`),
  leave the box empty. Optional: "Skip — I'll add it later".
- Then shows three faces (Building, Needs you, Done) with captions, then "Let's go" into
  the existing three steps: about you, what you like, how to start (idea / existing code
  / show matches). "Say that again" replays. Reduced motion: all lines at once.
- Saved name is the profile name used by the chat greeting, the brief message and the
  account menu. Escape it everywhere it's rendered.

### Sign in [`sign-in.html`] — `states.tsx` sign-in
- Character, one sentence, five steps in plain words, Continue with GitHub / Google,
  theme toggle top-right. Error state `?state=error`.

### Not found [`not-found.html`]
- "Stuck" character, plain explanation, one way back. Missing-project variant
  (`?missing=1`).

### Landing [`landing.html`] — `apps/site` (P16 files)
- A **refinement** of the existing site, not a rewrite. Keep the structure, tagline
  "It carries the build. You swing.", card style, sticky step rail, promises sections
  and "illustration" labels.
- Changes: steps renamed Find · Read the rules · Plan · Build · Check · Submit; plain
  wording (see the prototype for every replaced phrase); character in the wordmark and
  closing card; hero illustration shows the v2 app, still labelled as an illustration;
  "Your brief" section after the steps; "What it can build" in plain names with statuses
  from the feature ledger; **one primary button per viewport ("Request access")**, "Sign
  in" as outline, mobile bottom bar that hides when the closing card is visible; theme
  toggle (§3.9). Must still work without client JS except the toggle.

## 5. Windows, drawers and menus (complete list)

| id | Where | Purpose |
|---|---|---|
| `explore-ideas` | Hackathon detail | Pick/type an idea, then create the project |
| `import-repo` | Projects | Bring your code |
| `add-task` | Overview | Add a to-do |
| `approve-plan` | Plan | Approve with spend cap |
| `request-changes` | Plan | Suggest a change |
| `change-request` | Build | Ask for a change to the app |
| `run-drawer` (drawer) | Build | One build in detail |
| `licence` | Check | Pick a licence |
| `proof` (drawer) | Check | Proof behind a ready line |
| `score` (drawer) | Check | Score it yourself |
| `video-link` | Submit | Add demo video link |
| `record-submission` | Submit | "I've submitted" |
| `edit-description` | Project settings | Edit "What it is" |
| `connect-repo` | Project settings | Connect a repo |
| `new-routine` | Project settings | New routine |
| `correct-memory` | Project settings, Settings | Correct a fact |
| `delete-project` | Project settings | Typed-name delete |
| `account-menu` (menu) | Avatar | Name, "Signed in with <provider>", Profile & interests, What Caddie knows, Connected accounts, Routines, Spending, theme, Sign out |
| `about-menu` (menu) | Chat header | "Talking about" switch (§3.5) |
| ⌘K palette | Global | Quick search |

All windows: focus trap, Escape closes, focus returns to the opener, one primary button,
destructive actions red and confirmed.

## 6. Plain words (use everywhere, including Caddie's replies and test labels)

| Don't show | Show |
|---|---|
| Home | Brief |
| Chat | Caddie |
| Prove / Evidence / Judge review | Check · Proof · what judges look for |
| Ship / Submission | Submit (hackathon) · Share (personal) |
| Revision 3 / rev_3 | Updated plan · version 3 |
| Approve | Looks good — build it |
| Request changes | Suggest a change |
| Run 14 | A build |
| Tests passed | Everything worked |
| Eligibility | Can you enter? |
| Stack(s) | Tools to build with · Build tools |
| Repository | Your code on GitHub |
| Sandbox | (provider) test account |
| Automations / Schedules | Routines |
| Memory | What Caddie knows |
| Connections | Connected accounts |
| Usage & budget | Spending |
| Conversation scope | Talking about |
| Artifacts | Files |
| Tasks | To-dos |

Technical words are allowed only inside folded "For developers" sections. Change visible
labels, not identifiers: keep route paths, API names and existing `data-testid`s unless a
packet says otherwise, and update browser specs in the same packet.

## 7. The character

Reference: `logo.html` (states, sizes, lockups, do/don't), `characters.html` (two
rejected-for-now alternatives — implement the **flag block** only).

- One SVG drawing; only eyes, mouth and the flag change. Build it as a single React
  component `<Mascot mood size />` in `packages/ui` with CSS animations.
- Moods and when they show — only when Caddie is actually in that state:

| mood | when |
|---|---|
| `ready` | idle, nothing running |
| `listening` | composer focused / waiting for the user's answer |
| `thinking` | request in flight, page loading |
| `building` | a build is running |
| `needs` | something waits for the user's OK |
| `done` | a step just finished (brief, then back to `ready`) |
| `stuck` | error, can't reach Caddie, not found |
| `paused` | routines paused / spending cap reached |

- Appears only where Caddie itself appears: chat header, "Ask Caddie…" bar, closed rail,
  mobile Caddie tab, sign-in, welcome, empty/error states. Not on buttons or headings.
- `prefers-reduced-motion`: static faces, no animation.
- Not ready to ship as-is: the 16px favicon needs a hand-tuned drawing, and the app icon
  needs a safe-area version. Keep the current favicon until those exist.

## 8. Backend: what exists and what's missing

Checked against `apps/app/src/server/routes/` on 2026-10-10. The v2 review page's
"backend still needed" list was written before this check; several items already exist.

**Already built — wire the UI to these, don't rebuild:**
- Account brief + read state: `GET /api/brief`, `POST /api/brief/read`
- Spending: `GET /api/usage` (honest "no budget configured")
- To-dos: `/api/projects/:id/tasks` (create, list, get, patch)
- Routines: `/api/projects/:id/schedules` (+ occurrences, run-now)
- Previews: `/api/projects/:id/previews` (+ revoke, extend)
- Judge: `judge/rubric`, `judge/assessment`, `judge/scorecards`, `judge/coaching`
- Submission: packages, checklist, exports, confirmations
- Memory: `GET /api/memory`, confirm / retract / correct
- Search: `GET /api/search?q&limit&offset` → `project | planDoc | task | memory`
- Projects: `PATCH /api/projects/:id`, `POST …/archive`
- GitHub: installations, repos, imports, deliveries
- Build tools: `GET /api/stacks` (`enabled | planned`)
- Approvals: `POST /api/approvals`, get, revoke

**Missing — each is its own packet; until it lands, hide the control or show an honest
"not yet" state. Never fake it on the client:**
1. Saved hackathons separate from accepting (candidates are `new | accepted | dismissed`).
2. Hackathon results in search, and searching inside chats.
3. "Tell me when it's ready" signal for Build tools.
4. Permanent project delete (only archive exists today) — confirm owner intent; if
   delete stays archive-only, label the window "Archive project".

**Unverified — check before designing the UI around it:**
5. One chat thread per "Talking about" scope (drafts are per project; threads unknown).
6. Plan content as before/after + stored decisions (`planning/plan`, `plan-docs` exist;
   no decision persistence found in `server/planning.ts`).
7. In-chat "OK to spend?" card bound to an approval id via typed tool parts.
8. Caddie scoring the project itself (assessment exists; an automated scored judge run
   does not appear to).

## 9. Do not copy from the prototype

- Demo projects (Ledger Nudge, Founder Hours, Pantry Scale), builds, costs, the preview
  app, the persona "Jay", and quoted Devpost content.
- `localStorage` keys with the `caddie2.` prefix (`account`, `name`, `convDesktop`,
  `convFrac`, `draft.*`, `theme`). Use the app's existing stores and keys; pick real key
  names in the packet.
- `?open=`, `?state=`, `?via=`, `?name=`, `?p=`, `?missing=` URL switches — review tools only.
- The fake sign-in, toasts that claim success without a server response, and any
  client-side derived status.
- `characters.js` (alternatives) and `events.js` (demo data).

## 10. Acceptance for every UI packet

- Matches the prototype screen side by side at 390px, 768px, 1440px, light and dark.
- Keyboard: every control reachable, visible `:focus-visible` ring, windows trap focus.
- Contrast ≥ 4.5:1 text, ≥ 3:1 icons, in hover/focus/selected too. Hover never lightens
  text.
- Label floor 11px, meta 12px, touch targets ≥ 44px on mobile, no horizontal scroll.
- Reduced motion respected. One primary button per viewport.
- Every visible label uses §6 words. Loading and error states present.
- `bun run typecheck`, `bun run build`, `bun run verify:packet <id>` and the mapped
  browser spec pass; evidence classified per `AGENTS.md`.
