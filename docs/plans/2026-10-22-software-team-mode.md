# Software-team mode: build plan (2026-10-22, rev 5)

Status: APPROVED for building (owner, 2026-10-22 17:10). The owner left D13
and D14 to me, so both take their defaults, and they land last. There's no
mockup approval gate (section 7). If the campaign passes, Caddie then builds
FarmOps as a second entry (section 9).
Rev 4 took in the independent review of rev 2 (six changes) and the owner's
decision to build big apps, with several builders working in parallel, this
week rather than after the hackathon. Rev 5 makes the plan self-contained.
Rev 4 said "as in rev 3" in ten places, and rev 3 no longer exists because
the file was never committed. So parts H and J-O, part C's wording, part B's
shapes and part E's step 8 are now written out in full. Checking them against
the code also found four promises the preview can't keep today (uploads,
maps, location, roles). Those are now fixed in the parts or turned into
decisions (D13, D14). Every "today" fact was read in the code or the
installed Flue 2.2.2 docs on 2026-10-22. Anything not verified is marked
UNVERIFIED.

## The plan in plain words

**What goes wrong today when someone asks Caddie for an app:**

1. The plan aims at a 3-minute demo, not a complete app.
2. Caddie checks that tests pass, but not that data is really saved, that
   people can't see each other's data, or that the screens show what the
   server saved. That's how HerdVoice kept animals in memory, so they
   vanished.
3. A big app can't be built at all: one builder works through at most 12
   features, one at a time.
4. Nothing enforces the spending limit, and the "OK to spend?" card shows a
   number the model made up.
5. Apps can't take payments, send emails, store photos or look at pictures.

**What changes this week:**

1. Plans aim at complete apps.
2. **Big apps are split into parts** ("modules"), such as Farms, Feed, Money
   and Tasks. Several builders build them at the same time, each on its own
   copy of the app. Caddie joins each finished part into the app and checks
   everything again.
3. **"How your app works"** in plain words before building. Serious problems
   (sign-in, private data, keys) must be fixed before the build starts; they
   are never waved through.
4. **Real checks after every feature.** For each kind of record, Caddie
   checks that:
   - it can be saved;
   - after the app restarts, it's still there;
   - it can be changed and deleted;
   - a second person can't see, change or delete it;
   - on an app with teams (a farm and its workers), a teammate can see the
     team's records and someone from another team can't;
   - the screen shows what the server saved.
5. **Each builder can change only its own part.** Caddie compares the saved
   files before and after each part and refuses anything outside it. When
   builders work in parallel, only each builder's own folders are copied into
   the app.
6. **A spending limit checked before every AI call,** not after.
7. **A publish safety check.** Publish refuses an app with a key in its
   browser code or private data left open. The check uses the exact version
   being published.
8. **New app features.** Photo and file uploads, and AI that can look at
   photos. Payments, subscriptions and emails work in a clearly labelled test
   mode.
9. **Try again.** If a feature fails 3 times, there's a "Try again from the
   last save point" button. Automatic retries wait until after the hackathon,
   because they're riskier.

**Keeping the submission safe:**

- There are three switches: team mode, big apps and app features. Each can
  be flipped without redeploying.
- On Monday, a test campaign with a fixed budget runs real hackathon ideas
  plus one v0-farmops-sized app.
- On Tuesday at 18:00 we decide each switch against fixed pass marks.

**Honest status:** the machinery for big apps can be built this week. Whether
it reliably builds a v0-farmops-sized app by Tuesday is exactly what
Monday's test shows. The Devpost text will claim only what the test proves.

## What apps built by Caddie can do

### For real, after this week

- **Sign-in, teams and roles.** Sign-in with emailed codes. New: teams (a
  farm and the people on it) with roles such as owner and worker, plus admin
  pages for the app's owner. The starter has no roles today. Part B declares
  them, Caddie's generated code checks access before a route runs, and part
  E proves it with a second person, a teammate and an outsider.
- **Saved data in the app's own database.** Each published app already gets
  its own (`server/publish.ts:459`).
- **Small apps:** up to 12 features and 25 tables.
- **Big apps** (with the big-apps switch on): up to 12 parts, 80 features,
  60 tables and 80 screens, built in parallel.
- **AI** on Nemotron, plus AI that can look at photos (part M).
- **Photo and file uploads,** up to 5 MB each (part L). They're sent in
  parts, because the preview takes at most 1 MB per request
  (`preview-runtime.ts:538`) and returns at most 2 MB per reply (`:564`).
  Photos are shrunk in the browser first.
- **Search inside the app.** SQLite full-text search (FTS5), falling back to
  plain matching. UNVERIFIED in the sandbox's test database and the preview
  database; part O's test decides.
- **Common screens:** dashboards and charts (drawn by Caddie's own chart
  parts, no new library); several languages; screens that work on phones;
  admin pages.
- **Maps and location.** These work in published apps. In Caddie's preview,
  where judges try apps, map tiles are blocked today, because the frame
  allows only `data:` and `blob:` images (`shared/preview-frame.ts:30`), and
  the frame can't ask for location (no `allow` attribute,
  `InteractivePreview.tsx:308`). D13 and D14 decide whether to open them.
- **Shared data that refreshes** every few seconds. Updates aren't instant.
- **Outside services** with the owner's key, one-click Publish, and Android
  apps (Flutter apps use today's pipeline).

### Test mode: realistic, always labelled, and nothing real happens

- **Payments and subscriptions** (part J), with the banner "Test mode — no
  money moves".
- **Emails and invitations** (part K). They land in the app's test inbox,
  marked "not sent".
- **Scheduled jobs** (part N), run with a "Run now" button.

An app calls the same functions the real versions will keep, so going real
later changes only Caddie's side. Caddie's draft Devpost text for each app
lists its test-mode features as test mode.

### After the hackathon

- Real payments, email, SMS and push notifications.
- Jobs on a timer and background queues.
- Instant updates.
- Video and large files.
- Search by meaning.
- Voice conversations with AI.
- Automatic second attempts.
- Schema changes in the middle of a big build.
- Team mode for Flutter, custom domains and iOS.

## How rev 5 completes rev 4

| Gap in rev 4 | Change in rev 5 |
| :--- | :--- |
| Ten "as in rev 3" pointers to text that no longer exists | Parts C, H and J-O, part B's shapes and part E's step 8 are written out in full |
| Uploads up to 5 MB, while the preview takes 1 MB per request | Part L uploads and downloads in parts of at most 700 KB and shrinks photos first |
| Maps and location listed as working, while the preview frame blocks both | Marked as published-only until D13 (one tile host) and D14 (location) are decided |
| Roles listed, while the starter has none and no check covers them | Part B adds teams, roles and per-route access; part E adds teammate, outsider and role checks |
| Tier 3 had no tables, no owner for `server/app-platform.ts`, and no live photo check | Migration 0040 gains the email and job tables, lane 10 owns `app-platform.ts`, and S6 is the live photo check |

## How rev 4 answers the independent review

| Review point | Change in rev 4 |
| :--- | :--- |
| 1. The spending limit must be enforceable before calls | A reservation is made before every model call through Flue's `instrument()` model interceptor (verified: a throwing interceptor fails the call). Each reservation is settled from that call's own usage (`Math.ceil(usage.cost.total * 1_000_000)` micros). Response totals are never added, so nothing is double-counted. S1 proves the accounting. |
| 2. Persistence and privacy tests are too weak | The check now does create → restart → read the same record; update → restart → read; delete → restart → gone. A second person can't read, change or delete the record. The screen must show the record the server saved. The restart runs in a separate process on a file-backed database (part E). |
| 3. Don't accept serious architecture failures after two reviews | Deterministic rules and security-severity review issues always block, with no round limit. Advisory issues stay visible. The build, its checks and Publish bind to the exact approved revision and the exact output (parts B, E and G). |
| 4. Defer automatic checkpoint recovery | Deferred. It's replaced by a "Try again from the last save point" button built on the existing rollback, which only works when the build is stopped (part F). |
| 5. Role boundaries need real enforcement | Enforcement now compares the files in the committed snapshot, read through Contree's inspect API, so it covers Node, Python and package scripts. In parallel builds, only each builder's own folders are ever copied (parts D and Q). |
| 6. Fix the experiment and release gates | The run count and budget are explicit, and a campaign-wide cap is enforced by the runner. Absolute pass marks are added (a tie at zero fails). Each always-on change has a rollback plan (sections 10 and 11). |

## 1. Fixed constraints

- **Hackathon and track.** Nebius x NVIDIA Global AI Hackathon, Coding and
  Agentic Engineering track: "agents that write, run, and test code in Token
  Factory". Builds stay in Token Factory Sandboxes (Contree). Model calls go
  to Token Factory, with Nemotron where judgment matters.
- **Deadline.** Fri Oct 30, 10:00 PDT, which is 18:00 in Lagos. The entry
  can't change afterwards, and judges may score from the text, images and
  video alone. The hosted app must stay free and available until Dec 15.
- **Stack.** Flue 2.2.2 on Cloudflare Durable Objects, D1, the Contree REST
  driver, and Workers for Platforms.
- **Production is live** at https://caddie.jamalibrahim.dev.
- **AGENTS.md rules apply.**
  - Local verification by default.
  - Paid runs, pushes and deploys need the owner's go.
  - Shared files are changed by the lead, one at a time.
  - Migrations only add; Durable Object migrations only add.

## 2. What exists today (verified)

| Area | Today | Where |
| :--- | :--- | :--- |
| Models | Brainstorming: Ultra. Plan, design and tech-lead: GLM-5.3-Flash. Coordinator, building and QA: Nemotron 3.5 Super VL. Helpers: Nano. In-app AI: Lightning, or Super VL for deeper calls. | `agents/providers.ts` MODEL_ROLES |
| Planning | PRD with a demo contract and at most 12 features (flat, no dependencies), then the design. Approval binds to the revision hash. `decideDesign` and `retryWorkflow` start builds; `ensureWorkflow` creates a project's workflow. | `packages/contracts/src/features.ts:20`; `server/build-workflow.ts:200, 409, 1096` |
| Build loop | One feature at a time; green checks and more tests then a save point; the 3rd failure blocks the build. | `server/coordinator-host.ts:450-534` |
| Who writes | tech-lead has write and exec tools. The "frontend, then backend" rule is only prompt text. | `agents/permissions.ts:27-51`; `agents/delegation.ts` |
| Checks | install, tests, bundle, `/api/health`; AI-tier validation (19f9d1a). Nothing checks persistence, privacy or screens. The test database is in-memory bun:sqlite. | `server/host-checks.ts:24-37`; `stacks/react-hono/server-files.ts:311` |
| App platform | `env.CADDIE` gives AI (text only, `app-ai.ts:87`) and sign-in codes: in the preview they go to the test inbox; published apps email them, with fixed wording and limits. | `stacks/react-hono/auth-files.ts:31-60`; `server/app-sign-in.ts` |
| Platform entry points | `AppPlatform` (preview) and `PublishedAppPlatform` (published) expose `ai` and `signInCode` to apps. The test inbox table `app_test_inbox` (0031) holds sign-in codes only. | `server/app-platform.ts:44, 54`; `migrations/0031_app_sign_in.sql` |
| Preview limits | Requests up to 1 MB, replies up to 2 MB. The frame's policy allows only `data:` and `blob:` images and no network. The frame is `sandbox="allow-scripts allow-forms"` with no `allow` attribute, so it has no location. `x-caddie-*` headers from the frame are dropped. Published apps allow `https:` images. | `server/preview-runtime.ts:527, 538, 564`; `shared/preview-frame.ts:30`; `client/artifacts/InteractivePreview.tsx:308`; `workers/dispatch/src/csp.ts` |
| Starter | Hono, React and Better Auth; sign-in tables in the protected `migrations/0000_caddie_auth.sql`. No roles, teams, files, payments or charts. | `stacks/react-hono/scaffold.ts:58-64`; `auth-files.ts:57` |
| Planner wording | "Aim at a demo that wins, not a complete CRUD app" and the three-minute judge test. | `agents/specialists.ts:149, 157` |
| Submission texts | The model table says plan and build both run on GLM-5.3-Flash. The texts say the hosted deployment and a full agent-driven build aren't live. No written feedback on Token Factory and the NVIDIA models yet. | `docs/submission/devpost.md:53, 247`; `docs/submission/video-script.md:26, 154, 298` |
| Publishing | One D1 database per published app; a 5-minute safety sweep. | `server/publish.ts:459, 742` |
| Sandbox | Every run commits a snapshot. A save point can be restored into a new session (a copy). The `build_sandbox_sessions` override points a build at another session. Files can be read from any snapshot without running anything (`inspect` list, download and archive). | `server/adapters/sandbox.ts:572-636`; `adapters/contree.ts`; `working-copy.ts`; `build-features.ts:236` |
| Spending | `budgets.ts` and its tables are unused; `request_approval` shows the model's own number. | `server/budgets.ts`; `agents/coordinator.ts:363-394` |
| Flue: parallel and dispatch | Delegations issued together run in parallel (`subagents.md:51`). `dispatch(agent, { id, message, initialData })` lets code start or continue another agent instance; on Cloudflare each instance is its own Durable Object, and delivery is at-least-once. Tools may dispatch to other instances. | `node_modules/@flue/sdk/docs/reference/agent-api.md:151-190, 251` |
| Flue: interception | `instrument({ observe, interceptor })`: the interceptor wraps each `model` provider call (keyed by `turnId`), and a throw fails that call. The paired observer sees `turn_request` (the full request) and `turn` (that call's usage and cost). | `reference/events.md:293-412, 601-659` |
| Settings | There's no settings store; switches are environment variables only. | |

## 3. Decisions taken (defaults; say if you want any changed)

- **D1.** Models stay as today, plus three new jobs:
  - Nano for helpers, Ultra for brainstorming, GLM-5.3-Flash for drafting
    the plan and design, Super VL for chat, building and QA, and Lightning or
    Super VL for AI inside apps;
  - new: Ultra reviews the architecture (D2);
  - new: module builders run on Super VL;
  - new: photo AI inside apps runs on Super VL, the vision model.
- **D2.** Ultra reviews the architecture. Security issues block until fixed;
  advisory issues are shown.
- **D3.** No automatic second attempt this week; the manual button instead.
- **D4.** Build limits:
  - small app: $5.00 for you and invited users, $2.00 for judges;
  - big app (owner and invited only): $40.00.

  UNVERIFIED: no build's cost has ever been recorded. Friday's smoke run
  calibrates these.
- **D5.** Campaign cap: $150 in total, including smoke runs and retries,
  enforced by the runner.
- **D6.** A failed publish check blocks publishing.
- **D7.** Caps:
  - small apps: 12 features and 25 tables;
  - big apps: 12 modules, 80 features (at most 12 per module), 60 tables,
    200 routes and 80 screens.
- **D8.** Lanes go to my workers. Any lane can move to Codex or Claude under
  the same rules.
- **D9.** Judges' switches are decided Tuesday against section 10.
- **D10.** Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002`
  is declined, and anything else is refused.
- **D11.** App emails go only to the test inbox this week.
- **D12.** Parallel builders: at most 4 at once per build, and 8 across all of
  Caddie.
- **D13.** Map tiles in the preview. Add `https://tile.openstreetmap.org` to
  the preview frame's `img-src`. It's images only; `connect-src` stays
  `'none'`, so the page still can't send anything out. OpenStreetMap's tile
  policy asks for attribution and light use: fine for demos and judging, not
  for a busy published app. Default: yes. If no, maps work only in published
  apps.
- **D14.** Location in the preview. Add `allow="geolocation"` to the preview
  frame, and the browser still asks the person each time. Default: yes.
  UNVERIFIED that an opaque-origin frame can then read a position; part O's
  browser test decides.

## 4. Foundations (lane 1, today, first)

- **Switches without redeploying.** A `platform_switches` table plus an
  owner-only operator route. Keys:
  - `team_mode` (off | owner | on);
  - `big_apps` (off | owner | on; needs team mode);
  - `app_features` (off | owner | on; needs team mode);
  - `spend_enforcement` (on | off);
  - `publish_safety` (on | off).

  Environment variables give the defaults. The first three are stamped on a
  project's workflow when it's created, so a project never changes mode. The
  last two are read when they're used. Every flip is recorded with who
  flipped it and when. `owner` means every account except judge accounts.
  Flutter projects stay on today's pipeline.
- **Migration `apps/app/migrations/0040_team_mode.sql`:**
  - workflow columns `teamMode`, `bigApps`, `appFeatures`, `spendPayerId`,
    `approvedDesignRevisionId`;
  - `build_spend_limits` (payerId, limitMicros);
  - `build_spend_reservations` (payerId, turnId unique, conversationId,
    reservedMicros, settledMicros, status reserved | settled | released,
    timestamps);
  - `architecture_reviews` (projectId, blockHash, round, issues with
    severity);
  - `build_modules` (projectId, buildSeq, moduleId, status pending |
    building | stopped | passed | merged | not-merged, sessionKey,
    checkpointRef, builderId, timestamps);
  - `integration_locks` (projectId, holder, expiresAt);
  - `part_manifests` (projectId, partKey, manifest JSON, createdAt);
  - `app_test_emails` (id, projectId, mode preview | live, toEmail, subject,
    textBody, template, createdAt), for part K;
  - `app_job_runs` (id, projectId, mode, jobId, status running | done |
    failed, summary, startedAt, finishedAt), for part N;
  - `platform_switches` and `platform_switch_log`.
- **New agent class.** The ModuleBuilder agent (part P) needs its own Durable
  Object class and an added wrangler migration entry. Lane 12 proposes the
  entry with its agent code in wave 3, and lane 1 applies it; it isn't part
  of the foundations, because the class must exist before the entry can.
- **Starter smoke check.** The empty team-mode starter app installs, passes
  its tests and builds. It runs after every merge that touches the starter
  app.
- **Published first.** All table and function names in this plan are
  published before the workers start.

## 5. Parts, by priority

Tier 1 protects quality and money, Tier 2 is big apps, Tier 3 is app
features.

### Tier 1

#### A. Spending limit checked before every model call (lane 3; always on; never cut)

- **User sees.**
  - The build card shows the limit.
  - At the limit, the build stops with: "This build reached its spending
    limit of $5.00. Your plan and files are saved." Retry starts a new build
    with a new limit.
  - The "OK to spend?" card no longer shows a model-chosen number.
- **Behavior.**
  1. When a build starts (`decideDesign`, `retryWorkflow`), the host creates
     a payer `build:<runId>:<time>` with its limit (D4) and stores it on the
     workflow.
  2. `instrument()` is installed once per isolate in `app.ts`. Its
     interceptor handles `model` operations:
     - It finds the payer from `ctx.conversationId`: the coordinator's
       conversation or a module builder's instance, cached per isolate.
     - With no payer (ordinary chat, which judge message quotas already
       limit), the call passes straight through.
     - With a payer, it reserves before `next()` with **one** conditional
       insert: settled + reserved + this estimate ≤ limit. The estimate is
       the worst case for this call:
       - input: the size of this call's `turn_request`, seen by the paired
         observer, at 1 token per 2 characters; if that hasn't arrived, the
         route's context window capped at 200,000 tokens;
       - output: the route's `maxTokens`;
       - each priced at the route's rates.
     - If the reservation is refused, it sets the blocker and throws, and the
       call never reaches Token Factory.
  3. After the call, the reservation is settled with that call's own usage
     (`turn.usage.cost.total`, as micros, rounded up). A failed call releases
     it. Only per-call usage is recorded; response and operation totals are
     never added.
  4. Every builder on a build, including parallel module builders, shares
     one payer. The single conditional insert keeps simultaneous
     reservations within the limit, so the limit is hard.
     The new tables are needed because migration 0002's budget tables don't
     fit (`0002_controls.sql:83-129`). They count whole cents, with each
     reservation at least 1, while one model call costs a fraction of a cent.
     Their trigger also counts only open reservations, not money already
     settled.
  5. A reservation never settled (a crash mid-call) stays counted as spent.
     That's the safe direction.
  6. `request_approval` drops `capMinorUnits` and `currency`.
  7. Kill switch: `spend_enforcement=off` stops refusing but keeps recording.
- **S1 must prove:**
  - the interception covers the coordinator, its delegates and dispatched
    module builders;
  - D1 is reachable inside the interceptor;
  - a throw stops the call cleanly and the build ends blocked;
  - `turn_request` arrives before the model interceptor (or the fallback
    estimate applies);
  - per-call costs add up to Flue's response totals, so there's no double
    counting.
- **Tests,** each with a mutation proof:
  - refusal at the limit;
  - two simultaneous reservations never exceed it;
  - settle and release;
  - pass-through with no payer;
  - the kill switch;
  - payers per build start.

#### B. "How your app works", with modules, and security issues that block (lane 2; prompts in lane 1; screen in lane 6)

- **The block.** A ` ```caddie-architecture ` JSON block in the design (one
  approval, one revision hash), version 2:

  ```json
  {
    "version": 2,
    "signIn": "required | optional | none",
    "team": { "table": "farms", "plain": "A farm and the people on it", "roles": ["owner", "worker"], "creatorRole": "owner" },
    "modules": [{ "id": "core", "plain": "Farms, people and roles", "dependsOn": [] },
                { "id": "feed", "plain": "Feed stock and use", "dependsOn": ["core"] }],
    "tables": [{ "name": "animals", "module": "core", "plain": "Each animal", "owner": "person | team | shared | public",
                 "fields": [{ "name": "name", "type": "text | integer | real | boolean | datetime | json | file", "references": null }] }],
    "routes": [{ "id": "animals.create", "module": "core", "feature": "animal-registry", "op": "create | read | list | update | delete | action",
                 "method": "POST", "path": "/api/teams/:teamId/animals", "table": "animals", "plain": "Add an animal",
                 "access": "public | signed-in | person | team | team-role:owner | admin | job",
                 "request": [{ "name": "name", "type": "text", "example": "Daisy" }], "response": ["id", "name"] }],
    "screens": [{ "id": "animals", "module": "core", "path": "#/animals", "plain": "Your animals", "shows": ["animals"] }],
    "services": [{ "id": "weather", "plain": "Weather for each farm", "keyName": "WEATHER_API_KEY", "keyPage": "https://example.com/keys" }],
    "ai": [{ "id": "feed-insight", "plain": "Explains this week's feed use", "route": "insights.create", "tier": "fast | super", "images": false }],
    "payments": { "currency": "USD", "plans": [{ "id": "pro", "plain": "Pro", "priceMinor": 900, "interval": "month | year" }],
                  "locked": [{ "route": "reports.export", "plans": ["pro"] }] },
    "emails": [{ "id": "invite", "plain": "Invites someone to the farm", "route": "members.invite", "to": "request-field:email | person" }],
    "jobs": [{ "id": "daily-summary", "plain": "Sums up yesterday", "route": "jobs.daily-summary", "every": "hour | day | week" }],
    "screenOnly": ["calculator"]
  }
  ```

  A small app has one module, `app`. `team` is `null` for apps without
  teams. `payments` is `null` without plans. `screenOnly` lists screens that
  show no saved data, such as a calculator; the screen check skips them.
- **Access.** Each route's `access` says who may call it:
  - `public`: anyone;
  - `signed-in`: any signed-in person;
  - `person`: a signed-in person, about their own records;
  - `team`: a member of the team in the path's `:teamId`;
  - `team-role:<role>`: a member with that role;
  - `admin`: one of the app's admins (the first account in an app is its
    admin, and admins can add others);
  - `job`: only Caddie's signed Run-now call (part N).

  Caddie's generated `caddie/contract.ts` checks access before the route's
  code runs: 401 without a session or a valid job signature, and 403 for the
  wrong team, role or admin. So a builder can't forget it. Filtering records
  by person or team stays the builder's job, and part E checks it.
- **Deterministic rules,** which always block:
  - the D7 caps, plus at most 10 services, 10 AI uses, 10 emails and 5 jobs;
  - names, unique ids, and `/api/` paths, with `/api/caddie/*` reserved for
    Caddie's own generated routes (parts J and L);
  - every table, route, screen and feature belongs to one module;
    `dependsOn` has no cycles;
  - a module writes only its own tables; tables of the `core` module can be
    read by anyone and written only by core;
  - each person- or team-owned table has create, read, list, update and
    delete routes (or says which it omits), and none of them is `public` or
    `signed-in`;
  - team-owned tables need a declared `team`, and their routes have
    `:teamId` in the path and `team` or `team-role:<role>` access, with a
    role from `team.roles`; the team table belongs to core;
  - `admin` and `job` access need sign-in in the app; `job` only on a route
    listed in `jobs`;
  - every request field has an example;
  - services: `keyName` matches the app-key name rule (`app-secrets.ts:45`),
    and `keyPage` is an https page;
  - AI: the route exists, and `images: true` needs the super tier;
  - payments: 1-3 plans, a whole `priceMinor` from 1 to 100,000, `month` or
    `year`, a 3-letter currency, and each locked route exists and needs
    sign-in;
  - emails: the route exists and needs sign-in; `request-field:<name>` names
    a text field of that route whose example is an email address;
  - jobs: `every` is shown to the person only; nothing runs on a timer this
    week.
- **Generated schema.** The host generates `migrations/0001_schema.sql`
  from the tables for big apps, and for any app that declares a team or an
  `admin` route. It has:
  - the types, timestamps and declared references;
  - `ownerId` on person-owned tables and `teamId` on team-owned ones;
  - `team_members` (teamId, personId, role, createdAt; one row per person
    per team), with the creator getting `team.creatorRole`;
  - `caddie_admins` (personId, createdAt);
  - indexes on `ownerId`, `teamId` and references.

  The file is protected. With all modules sharing one schema, parallel
  builders never collide on migration numbers. In big apps the schema is
  fixed once approved, and a module that needs a change stops and says so;
  mid-build changes come after the hackathon. Other small apps keep
  builder-written migrations, and part E proves persistence either way.
  Parts J and L add their own protected `migrations/0000_caddie_*.sql` files
  when the block declares payments or a `file` field. These sort before 0001
  and after `0000_caddie_auth.sql`; lane 9 confirms that the migration runner
  applies files in name order.
- **Ultra review** (the `architect` delegate on `nemotron-3-ultra`, read-only,
  with `record_architecture_review`). Each issue has a severity:
  - `security` (sign-in, ownership and privacy, key exposure, data loss)
    blocks until it's fixed. There's no round limit and no waiver. After two
    rounds that still have security issues, the coordinator must change the
    plan, and the change goes back to plan review with a plain sentence such
    as "Caddie couldn't make X safe and suggests removing it."
  - `advisory` issues are shown in Design review.

  In big apps, modules are drafted and reviewed in parallel (delegates in
  one batch), and the validator checks the whole block.
- **Binding.** When building starts, the host stores the approved design
  revision id. The schema, the contract files and every check come from that
  revision only.
- **Tests,** each with a mutation proof:
  - valid small, big, team, payments, emails and jobs blocks pass;
  - each rule refuses with its message;
  - the generated access check answers 401 or 403 for each access kind
    before the route's code runs;
  - a security issue blocks after any number of rounds, while an advisory one
    doesn't;
  - snapshot test of the generated schema;
  - files are generated only from the approved revision.

#### C. Plans aim at complete apps (lane 1)

With team mode on, the product and tech-lead instructions change; with it
off, today's wording stays.

- **Product,** replacing "Aim at a demo that wins, not a complete CRUD app"
  (`specialists.ts:149`): "Plan a complete app. Every table you declare has
  screens that create, show, change and delete its records through the
  server, and the main path works end to end with real saved data. The demo
  contract is the three-minute tour of that complete app, not a substitute
  for it. A mock may stand in only for what the plan marks as test mode:
  payments, emails and jobs."
- **Tech-lead,** replacing the three-minute judge test
  (`specialists.ts:157`): "Before approving, check that every declared table
  is used by a screen, that every person- or team-owned record is private as
  declared, that the main path still works after a restart, and that the
  demo path is the main path of the complete app."
- `write_plan_note` still refuses a PRD without a demo contract.
- For big apps, plan modules that can be built independently, with core
  first.
- Each screen declares what it shows.

Prompt tests check the new wording in team mode and the old wording when
it's off.

#### D. Each builder changes only its own part, checked on the saved files (lane 5)

- **Areas.**
  - Small apps:
    - backend: `src/server.ts`, `src/server/**`, `src/server.test.ts`, and
      `migrations/**` except protected files;
    - frontend: the rest of `src/`;
    - mobile: `lib/` and `test/app/`;
    - other roles: nothing.
  - Big apps, per module:
    - the module's backend: `src/server/<module>/**`;
    - the module's frontend: `src/screens/<module>/**`;
    - core's frontend also owns `src/App.tsx`, `src/main.tsx` and
      `src/styles.css`.
  - Generated and protected: `caddie/**`, `test/setup/**`,
    `migrations/0000_*` and `migrations/0001_schema.sql`.
- **Enforcement.**
  1. `start_part(featureId, part)`, which the coordinator or module builder
     must call before delegating, records a manifest (path and sha256) of
     the app's source folders. The host reads it from the committed snapshot
     through Contree's inspect API, not through any command the model could
     influence. It also marks which role is active.
  2. Write tools refuse other roles and paths outside the area. This is early
     feedback only.
  3. `finish_part` and `finish_feature` compare the current snapshot with the
     manifest. Any change outside the part's area is refused, with the files
     listed. `restore_files(paths)` puts them back from the starting snapshot
     in one call.
  4. In parallel builds, each builder has its own copy, and only its folders
     are merged (part Q).

  Because the check is on the result, a change made by a Node, Python or
  package script is caught the same way.
- **S2:** measure manifest time on a 300-file app, and confirm today's
  build-loop tests still pass with team mode off.
- **Tests,** each with a mutation proof:
  - areas per role, for small and big apps;
  - a file changed by a script outside the area is caught;
  - `restore_files` works;
  - the active-role refusal works.

#### E. Contract checks: saved, restarted, private, on screen (lane 4)

- **Generated files** (from the approved revision; protected):
  - `caddie/contract.ts` (route table, types, `implement()`);
  - `caddie/api.ts`;
  - `caddie/router.tsx` (hash routes for the declared screens, with
    placeholders until each is built);
  - `caddie/modules.ts` (big apps: mounts each module's server routes);
  - `caddie/contract.test.ts`.

  The host writes them when a feature is handed out and before every check
  run.
- **The check,** for the routes of passed features plus the current one.
  Person A and person B are two test accounts signed in with
  `signInForTest`.
  1. **Implemented:** every route is registered through `implement()`.
  2. **Sign-in:** sign-in routes answer 401 without a session.
  3. **Create, restart, read:** A creates a record with the examples. That
     test process ends, and a new process opens the same database file and
     reads the record by id and in the list, with the same values. The
     starter's test database is in-memory today, so the generated test uses
     a file-backed copy of the same wrapper.
  4. **Update and delete:** update, restart, and the read shows the change;
     delete, restart, and the read returns 404 and the record is gone from
     the list.
  5. **Second person:** B can't read A's record (404 or 403, and it's not in
     B's list). B's attempt to change it is refused and A's record is
     unchanged. B's attempt to delete it is refused and the record is still
     there.
  6. **Teams and roles,** when declared. The test seeds `team_members`
     directly: A creates team T1 (role `creatorRole`), C joins T1 with
     another role, and B owns team T2.
     - C can read and list T1's records.
     - B can't read, change or delete them, and they're not in B's lists for
       T2.
     - A `team-role:<role>` route refuses C when C lacks the role, and allows
       A.
     - An `admin` route refuses B, and allows the app's first account.
  7. **Shape:** replies carry the declared fields.
  8. **Screen:** for each screen that shows a table, a record seeded through
     the API as A must appear when the app is rendered at that screen's path
     with `fetch` going to the real server (happy-dom, the same process). It
     must not appear for B.
  9. **Test-mode features,** when declared:
     - a locked route answers 402 with `{ "reason": "plan_required" }` before
       checkout. It answers normally after a checkout with the paying card,
       still answers 402 after the declined card, and answers 402 again after
       the test-mode "End now";
     - an email route stores exactly one message in the test inbox with the
       declared template and sends nothing;
     - a job route answers 401 without Caddie's signature and does its work
       with it;
     - a 5 MB file comes back byte-identical (same sha256) after a restart,
       and B can't read or delete it.
- **Static check:** screens call the server only through `caddie/api.ts`.
- **Test apps that must fail:**
  - keeps data in memory;
  - inserts a dummy row but serves from memory, which fails the read after
    restart;
  - an update that isn't saved;
  - no owner filter, which fails the second-person checks;
  - a team route without the team filter, which fails the outsider check;
  - a locked route left open, which fails the 402 check;
  - a screen reading localStorage, which fails the screen check.

  A correct app must pass.
- **Failure messages** name the record and the step in plain words, for
  example: "An animal you add is gone after the app restarts."
- **Tests:** each test app run for real, and a mutation proof for each check.

#### F. "Try again from the last save point" (lane 5)

- When a build stops after 3 failed tries on a feature, the stopped-build
  card offers "Try this feature again from the last save point".
- The button uses the existing rollback to the previous feature's save point
  (`build-features.ts:236`), which only works when the build is stopped, so
  no builder is still running. It then uses the existing Retry, carrying a
  summary of what failed, taken from the check receipts (the message-carrying
  retry from 3407bb5).
- For the first feature, it starts again from the plan.
- **Tests:** the button appears only on a stopped build; the rollback and the
  retry carry the summary; mutation proofs.

#### G. Publish safety for the exact output (lane 4)

- **The check.** For the output being published, it checks that:
  - that output's bundle contains no saved app key and no key-shaped string;
  - in team mode, that output's own verify receipts show the sign-in,
    second-person and restart checks as green.

  Approval and checks bind to that output's id.
- **Kill switch:** `publish_safety=off`.
- **Tests:**
  - a bundle with a key is refused;
  - a red receipt on this output is refused;
  - a green receipt on another output doesn't count;
  - mutation proofs.

#### H. Submission texts (lane 7)

- **Fix what's wrong today:**
  - `devpost.md:53`: the model table says plan and build both run on
    GLM-5.3-Flash. Building and QA have run on Super VL since Oct 20, and GLM
    drafts plans only. It gets the full D1 table, with each model's job.
  - `devpost.md:247`, `video-script.md:26` and `video-script.md:298` say the
    hosted deployment and a full agent-driven build aren't live. Production
    is live, and FarmLog's live build finished 7 of 7 features (Oct 20). Its
    final check failed on the then 500 KB preview cap, which has since been
    fixed. The texts say exactly that and no more.
  - `video-script.md:154` says planning and building share GLM-5.3-Flash.
    That's fixed the same way.
- **Add what the rules require:** written feedback on Token Factory and the
  NVIDIA models we used. It's drawn from our own records: what worked (for
  example Super VL's tool calls in builds) and what didn't, each with a date.
- **Describe only what passed section 10.** Test-mode features are called
  test mode. Big apps are described exactly as the campaign showed them.
  Every claim either names its receipt or carries its label (LOCAL VERIFIED,
  LIVE VERIFIED, SIMULATED and so on).
- **Video script:** the team-mode flow if `team_mode` goes on, otherwise
  today's flow. The `README.md` status table matches.
- **Tests:** a docs check that the model table matches `MODEL_ROLES` in
  `agents/providers.ts`, plus a grep in the release check for the stale "not
  live" sentences.

#### I. Test campaign (lane 8)

- **Briefs:**
  - 12 small and medium briefs: 9 from real hackathons, plus FarmLog,
    HerdVoice and the v0-farmops farm records core;
  - 1 big brief: a v0-farmops-sized farm platform with about 35-40 tables in
    9 modules. The modules are farms and team; structures and production
    units; farm events; feed; sales, expenses and suppliers; tasks; AI
    insights on photos; notifications (test inbox); and subscriptions (test
    mode). There's an admin area.
- **Runner:** `scripts/brief-run.ts`.
  - It runs only with `CADDIE_LIVE_AUTHORIZED=1`.
  - It uses local `bun run dev` on 127.0.0.1 with live keys from
    `.dev.vars`, falling back to the `owner` switch on production with your
    go.
  - It drives the real API and waits for up to 90 minutes, or 4 hours for the
    big brief.
  - It records results from D1 and runs a **browser check** in the local
    Chromium from `@playwright/test`. As A it creates a record through the
    screen, reloads the page and confirms the record is still there. As B it
    confirms the record isn't visible.
- **"Complete" means:**
  - every feature passed;
  - verify_build is green;
  - every contract check is green;
  - the browser check passes.
- **Runs and budget (cap $150, enforced by the runner).** The runner won't
  start a build unless what's been spent plus that build's limit fits under
  the cap.

  | Run | Builds | Limit each | Maximum |
  | :--- | :--- | :--- | :--- |
  | Smoke (Fri) | 1 | $5 | $5 |
  | Baseline, switch off | 5 | $5 | $25 |
  | Team mode | 12 | $5 | $60 |
  | Big brief | 1 | $40 | $40 |
  | Retries and the AI-photo live check | as the cap allows | | $20 |
  | **Total** | | | **$150** |

### Tier 2: big apps, built in parallel

#### P. Modules built by several builders at once (lane 12)

- **When:** the big-apps switch is on and the plan has more than one module.
- **1. Foundation.**
  - The host writes the generated schema and files (parts B and E) into the
    working copy.
  - The core module is built first, server part then screens: the app shell,
    navigation, sign-in, roles, and core's tables and screens. It uses the
    normal feature loop.
  - This produces save point "foundation".
- **2. Modules in parallel.** For each module whose dependencies are merged,
  the host:
  1. takes a builder slot (D12);
  2. restores the latest merged save point into a new session
     `module:<runId>:<moduleId>`, which becomes that module's own copy;
  3. starts a ModuleBuilder agent with
     `dispatch(ModuleBuilder, { id: "<projectId>:<buildSeq>:<moduleId>", message, initialData })`.

  Each ModuleBuilder is its own Durable Object with its own conversation. It
  runs the normal feature loop for its module's features only. That means:
  backend then frontend; its module's areas (part D); its module's tests and
  contract checks; its own 3-try limit; and the build's shared spending
  limit (part A).
- **3. Finishing.** When a module finishes, `finish_module` records its last
  save point and hands it to part Q. A stopped module doesn't stop the
  others. The build can end "partly built", with a plain list of what's
  missing and the Try-again button for that module.
- **The agent.** The ModuleBuilder is a new `'use agent'` export. Its backend
  and frontend delegates (`buildSpecialistDeclarations` with a context scoped
  to the module) are bound to its module's session, on Super VL. Dispatch is
  at-least-once, so starting a module twice with the same instance id is
  harmless.
- **User sees:** parts side by side, for example "Farms ✓ in your preview ·
  Feed: building feature 3 of 7 · Money: waiting for Farms".
- **S3** (Fri, local, scripted model): two ModuleBuilders each build one
  feature on their own copies at the same time; both merge; the checks run.
- **Tests,** each with a mutation proof:
  - slots;
  - dependency order;
  - dispatching the same module twice is harmless;
  - a module can't take another module's features;
  - one module stopping doesn't stop the rest;
  - the shared limit.

#### Q. Joining the parts into the app (lane 13)

- **Merging.** Each finished module is merged when it lands, one at a time,
  under the D1 integration lock:
  1. The host reads only that module's folders (`src/server/<module>/**`,
     `src/screens/<module>/**` and their tests) from the module's last
     snapshot, through Contree's inspect API.
  2. It writes them into the integration copy in one batch.
  3. Anything the builder changed elsewhere isn't copied, and it's reported.
- **Checks.** Then the full checks run on the integration copy: install, all
  tests, build, the contract check for every merged module, and the server
  starting.
  - Green: a save point (for example "Farms + Feed merged"), and the preview
    updates.
  - Red: the failure is matched to the module that owns the failing file or
    route. That module's builder gets a repair on its own copy (dispatch),
    then the module merges again. After at most 2 rounds the module is marked
    "not merged", and the rest of the app keeps working.
- **verify_build** runs on the final integration copy.
- **Tests,** each with a mutation proof:
  - only module folders are copied;
  - a stray file isn't merged and is reported;
  - the lock lets only one module merge at a time;
  - failures are matched to the right module;
  - the repair dispatch;
  - a partial result keeps the modules that worked.

#### R. Room for big apps (lane 13)

- **Saved versions:** from 300 files and 8 MB up to 2,000 files and 48 MB,
  through the existing chunked storage (`large_content`, 64 MB maximum). The
  code store gets the same.
- **Preview:** a bundle over the 2 MB single-page limit loads as separate
  chunked `main.js` and `main.css`.
- **Server bundle** over 2 MB: chunked storage.
- **S5:** publish a synthetic app with a 5 MB bundle to find the real Workers
  for Platforms limit. UNVERIFIED until then.
- **Tests:** a 1,500-file version round trip; a 5 MB preview; mutation
  proofs.

### Tier 3: app features (switch `app_features`)

#### J. Payments and subscriptions in test mode (lane 9)

- **Generated** only when the block declares `payments`, all protected:
  - `migrations/0000_caddie_payments.sql`:
    - `caddie_subscriptions` (personId, planId, status active | canceled |
      ended, renewsAt, cancelAt, timestamps);
    - `caddie_payments` (id, personId, planId, amountMinor, currency,
      outcome paid | declined, cardLast4, createdAt);
  - `caddie/payments.ts` (server);
  - `caddie/Billing.tsx` (screens).
- **Routes** under `/api/caddie/`:
  - `billing` (GET): the plans, the person's plan and its renewal date;
  - `checkout` (POST): plan, card number, expiry and CVC;
  - `cancel` (POST);
  - `end-now` (POST): test mode only, so a demo can show the locked state
    again.
- **Locked routes.** The generated access check (part B) answers 402
  `{ "reason": "plan_required" }` on every route listed in `payments.locked`,
  so the builder can't leave one open.
- **Cards** follow D10. The card details are checked, then dropped; only the
  last 4 digits and the outcome are kept. A plan renews one month or year
  after checkout. Cancel keeps it until the renewal date; End now ends it at
  once.
- **Screens.** `Billing.tsx` gives the plans, Upgrade, the checkout form,
  the renewal date and Cancel. Each billing screen carries the banner "Test
  mode — no money moves". The file is protected, so the banner can't be
  removed.
- **Going real later:** the same functions call Caddie's platform instead of
  the local tables, so the app's own code doesn't change (after the
  hackathon).
- **Tests,** each with a mutation proof:
  - the paying, declined and other cards;
  - 402, then 200 after paying, then 402 after End now;
  - Cancel keeps access until the renewal date;
  - the banner is on each billing screen;
  - after a checkout, no column in the database holds the full card number.

#### K. Emails and invitations to the test inbox (lane 10; the starter's types in lane 11)

- **The call.** A new method, `env.CADDIE.email({ to, subject, text,
  template })`, on `AppPlatform` and `PublishedAppPlatform`
  (`server/app-platform.ts`), carried out in `server/app-email.ts`.
- **Where emails go.** This week every email, from a preview or a published
  app, is stored in `app_test_emails` and shown in the project's test inbox,
  marked "Not sent — test mode" (D11). Nothing is sent. The reply,
  `{ "ok": true, "delivered": "test-inbox" }`, lets the app say "Saved to the
  test inbox".
- **Limits:**
  - one address per email;
  - a subject of at most 150 characters and text of at most 5,000;
  - 20 emails per app per hour;
  - the inbox keeps the latest 50 per app.
- **Invitations** (the recipe):
  1. An invite route stores a token and emails a link, `#/invite/<token>`.
  2. The invitee signs in with an emailed code and accepts.
  3. In the preview, both the code and the invite are in the test inbox.
- **Screens and routes.** The test-inbox route in `routes/build-workflow.ts`
  returns codes and emails together; lane 1 applies that change.
  `TestInbox.tsx` shows both (lane 6).
- **Tests,** each with a mutation proof:
  - emails are stored and never sent (the mail stub records no sends);
  - the limits;
  - a bad address is refused;
  - one project can't read another's inbox.

#### L. Photo and file uploads (lane 9)

- **Generated** when a table has a `file` field, all protected:
  - `migrations/0000_caddie_files.sql`:
    - `caddie_files` (id, ownerId, teamId, name, mime, bytes, sha256,
      parts, status uploading | ready, createdAt);
    - `caddie_file_parts` (fileId, n, data);
  - `caddie/files.ts`: the server routes and `readFile()` for the app's
    own server code;
  - `caddie/upload.ts`: the screen helpers.
- **Parts.** Each part holds at most 700 KB, stored as base64 text, which is
  about 930 KB per row, under D1's 2 MB value limit. Base64 is used because
  it's UNVERIFIED that the preview database gateway passes binary values.
  Each request stays under the preview's 1 MB limit and each reply under its
  2 MB limit.
- **Routes** under `/api/caddie/files`:
  1. start (name, type, size, sha256), which returns an id;
  2. put part n;
  3. finish, which checks the sha256 and the number of parts;
  4. get part n;
  5. delete.

  Each needs sign-in, and only the file's person or team may use it.
- **Screen helpers:**
  - `uploadFile(file, { onProgress })` returns an id. Photos (JPEG, PNG,
    WebP) are first shrunk to at most 1,600 px on the long side as JPEG,
    which usually makes them a single part.
  - `fileUrl(id)` joins the parts into a `blob:` URL for `<img>`. Both
    security policies allow `blob:` images.
  - `downloadFile(id)`.
- **Limits:**
  - 5 MB per file, after shrinking;
  - 100 MB per app;
  - JPEG, PNG, WebP, GIF, PDF, CSV and plain text only.

  A `file` field (part B) stores the file id.
- **Tests,** each with a mutation proof:
  - a 5 MB file comes back byte-identical after a restart;
  - a wrong sha256 is refused, and so are a file that's too big and a type
    not on the list;
  - the part-size limit;
  - B can't read or delete A's file;
  - a photo is shrunk.

#### M. AI that can look at photos (lane 11)

- **The call.** A message's `content` may be a list of `{ "type": "text",
  "text" }` and `{ "type": "image", "mime", "data" }`, where `data` is
  base64. The app's server reads the photo with `readFile()` (part L) and
  passes it to `CADDIE.ai`.
- **Rules:**
  - images need `tier: "super"`, because Super VL is the vision model;
  - at most 4 images per call;
  - at most 1.5 MB each;
  - JPEG, PNG or WebP only.
- **To Token Factory.** Images are sent as OpenAI-style `image_url` parts
  with data URLs. It's UNVERIFIED that the endpoint accepts them and what an
  image costs; S6 checks both with one paid call. If S6 fails, M stays off.
- **Cost.** The app-AI reservation (`app-ai.ts:152`) counts each image as a
  fixed input estimate until S6 measures the real cost. The app's monthly AI
  cap still applies.
- **Starter.** The starter's types (`server-files.ts`) get the content list.
  The recipe tells builders to send the photo's file id to their own route,
  then call `CADDIE.ai` from the server.
- **Tests,** each with a mutation proof:
  - validation of tier, count, size and type;
  - the outgoing request body, against a recorded fixture;
  - reservations count images.

#### N. Scheduled jobs with "Run now" (lane 10; first to cut)

- **User sees.** Each declared job is on the project page with a Run now
  button and the note "Runs when you press Run now. Automatic schedules come
  after the hackathon." The latest runs and their one-line summaries are
  shown under it (`client/project/AppJobs.tsx`, lane 6).
- **Running a job.** Caddie calls the job's route with the header
  `x-caddie-job: <time>.<signature>`:
  - in the preview, through the preview runtime;
  - in a published app, through the dispatch namespace.

  The signature is an HMAC-SHA256 over the project, mode, job and time,
  keyed per project and mode in the same way as `appAuthSecret`
  (`app-sign-in.ts:168`), and given to the app like `CADDIE_AUTH_SECRET`. The
  generated access check accepts only a signature less than 5 minutes old.
- **No forging.** The preview already drops `x-caddie-*` headers coming from
  the frame (`preview-runtime.ts:527`). It's UNVERIFIED that the dispatch
  Worker strips them from outside requests to published apps; lane 10 checks
  `workers/dispatch/src/` and adds the strip if it's missing.
- **Records.** Each run is stored in `app_job_runs`, with the route's
  `summary` (at most 300 characters). Project members can press Run now on
  the preview, and the owner on the published app.
- **Tests,** each with a mutation proof:
  - unsigned and stale calls are refused;
  - a signed call runs;
  - outside `x-caddie-job` headers are stripped on both paths;
  - runs are recorded.

#### O. Recipes (lane 1 writes the recipes; lane 9 writes the starter files)

Each recipe is a short block in `stacks/react-hono/recipe.ts` giving the one
supported way to do it in this starter. Each has a test that builds a tiny
example in the real starter.

- **Search:** an FTS5 table in a migration and `MATCH`, or plain `LIKE`
  where FTS5 isn't available. S7 decides which.
- **Charts:** a protected `caddie/charts.tsx` with bar, line and donut charts
  drawn as SVG. Their text labels can be read by screen readers, and they
  add no new library.
- **Maps:** a pinned Leaflet release in the starter's lock (lane 1 picks the
  current release on the day), with OpenStreetMap tiles and their
  attribution. Published apps work as is; the preview works only with D13.
- **Location:** `navigator.geolocation`, with a "type a place" fallback.
  The preview works only with D14. A browser test in real Chromium grants
  the permission and reads a position.
- **Refreshing data:** a protected `caddie/poll.ts`, `usePolling(load,
  5000)`, which pauses while the tab is hidden. The starter has no data
  library, so this stays small.
- **Admin pages:** screens behind `admin` routes, plus an "Add admin" action.
- **Teams:** create a team, invite by email (part K), accept and switch
  team.

The D13 and D14 changes (`shared/preview-frame.ts` and
`client/artifacts/InteractivePreview.tsx`) are lane 1's, and only after your
yes.

### Outside the switches: U. The Brief cards (lane 14)

This is the UI work that was under way before this plan. It doesn't depend
on any team-mode part, and it's on for everyone, so it runs alongside the
build.

- **The design.** You accepted seven card mockups on Oct 20: Plan approval,
  Live build, Repairing, Preview ready, Deadline, Opportunity fit and Earlier,
  with Compact spacing and 13px corners (`docs/plans/2026-10-20-caddie-ui-review.md`).
  - The mockups are in
    `/Users/captjay98/.codex/visualizations/2026/10/20/01a156e1-6c71-7120-8b86-2f4f02367ff6/caddie-card-review.html`.
  - The reference is the old Caddie's `src/components/TheCard.tsx` and
    `src/styles/halo.css` (read-only).
  - Already done: one card family (34f673c), plain words on the card face
    (652a76d), and two cards per row when there's room (54f4d54).
- **What's left, in this order:**
  1. The look, the footer, Earlier and the build rail. These need no new
     data.
  2. The deadline countdown.
  3. "What you're approving": the plan's list.
  4. The fit split: "Why it fits" and "Before you commit".
  5. The ready card's preview checks.
- **Data rule.** Steps 2-5 need new optional fields on the card, filled by
  the server in `server/brief.ts` from real records. A card today carries
  only its headline, summary, kind, status, main action and evidence ids.
  Nothing is guessed from the summary; when the server can't supply a field,
  the card shows today's summary.
- **Card rules:**
  - one filled button per card;
  - plain-English labels;
  - no ids on the card face.
- **Two cards per row on a 1440 px screen.** That needs a narrower minimum
  card width, about 300 px. Lane 14 measures it with the richer cards and
  picks the narrowest width that keeps the plan and fit lists readable, with
  screenshots at 2x on desktop and 390 px on a phone.
- **Tests,** each with a mutation proof:
  - each new field comes from a real record or is absent;
  - each step's card is checked in the browser on desktop and phone;
  - the existing Brief browser tests still pass.
- **When.** It starts in wave 2 and lands by Saturday. You review it with the
  new screens on Sunday, and it ships in the Sunday base deploy.

## 6. Spikes (before the parts that depend on them)

| Spike | When | Proves |
| :--- | :--- | :--- |
| S1 | Thu-Fri, local, no cost | Reservations through `instrument()` (part A list) |
| S2 | Thu-Fri, local | Manifest time; build-loop tests with team mode off |
| S3 | Fri, local, scripted model | Two ModuleBuilders in parallel, merge, checks |
| S4 | Fri, local | A file-backed test database with the same wrapper, restart across two `bun test` processes |
| S5 | Sat | The publish size limit with a 5 MB bundle (one small paid deploy, with your go) |
| S6 | Mon, paid, inside the campaign cap | One Super VL call with a photo through Token Factory: the accepted image format and the cost per image (part M) |
| S7 | Thu-Fri, local, no cost | FTS5 in the sandbox's test database, the preview database and local D1 (part O) |

## 7. Screens (lane 6): no mockup gate

The owner chose to build first (2026-10-22). Lane 6 builds these screens
straight into the app, in its existing style, from the parts above:

1. Design review "How your app works", for a small app and for a big app with
   modules (including plans and emails).
2. Build progress: parts side by side (big app), the server and screens parts
   (small app), the spending limit stop, and the Try-again button.
3. The test checkout and the test inbox with an email.

When they're built, the owner reviews them on the running app, with
screenshots at 2x on desktop and 390 px on a phone.

## 8. Lanes and file ownership

| Lane | Who | Parts | Owns |
| :--- | :--- | :--- | :--- |
| 1 Lead | Kiro | Foundations (a worker builds them; I review and merge), C, O's recipes, D13 and D14, prompts, hooks, the wrangler and Durable Object entries, starter file list and lock, merges, the full gate | `packages/contracts/**`, `apps/app/migrations/**`, `app.ts`, `wrangler.jsonc`, `server/coordinator-host.ts`, `server/build-workflow.ts`, `agents/specialists.ts`, `agents/coordinator.ts`, `agents/delegation.ts`, `agents/providers.ts`, `stacks/react-hono/scaffold.ts`, `stacks/react-hono/recipe.ts`, `shared/preview-frame.ts`, `client/artifacts/InteractivePreview.tsx`, the operator route, lockfiles |
| 2 Plan | worker | B | `packages/contracts/src/architecture.ts` (draft; lead applies), `server/architecture-gate.ts`, `server/schema-gen.ts`, the review tool |
| 3 Spending | worker | A, S1 | `server/build-spend.ts`, `server/spend-instrument.ts`, `client/conversation/ApprovalCard.tsx` |
| 4 Checks | worker | E, G, S4 | `server/contract-files.ts` (including the generated access check), `server/host-checks.ts`, `server/publish-safety.ts`, the call site in `server/publish.ts`, `tests/fixtures/contract/**` |
| 5 Boundaries | worker | D, F, S2 | `agents/permissions.ts`, `agents/tools.ts`, `server/part-manifests.ts`, `server/build-steps.ts`, the Try-again route |
| 6 Screens | worker, once B's block has landed | all screen parts | `client/planning/DesignReview.tsx`, `client/project/FeatureChecklist.tsx`, `client/project/ModuleProgress.tsx`, `client/project/TestInbox.tsx`, `client/project/AppJobs.tsx` |
| 7 Submission | worker | H | `docs/submission/**`, `README.md` |
| 8 Campaign | worker | I | `tests/briefs/**`, `scripts/brief-run.ts` |
| 9 Payments, files and starter parts | worker | J, L, O's starter files, S7 | `stacks/react-hono/payments-files.ts`, `stacks/react-hono/files-files.ts`, `stacks/react-hono/kit-files.ts` (charts and polling), their tests |
| 10 Email and jobs | worker | K (host side), N | `server/app-email.ts`, `server/app-platform.ts`, the email and job wiring in `server/preview-runtime.ts` and `server/publish-env.ts`, the `x-caddie-*` strip in `workers/dispatch/src/` |
| 11 AI photos and platform | worker | M, the K types | `server/app-ai.ts`, `stacks/react-hono/server-files.ts`, `stacks/react-hono/auth-files.ts` |
| 12 Parallel builders | worker | P, S3 | `agents/module-builder.ts`, `server/modules.ts`, `server/module-slots.ts` |
| 13 Joining and room | worker | Q, R, S5 | `server/integration.ts`, `server/code-versions.ts`, `server/code-store.ts`, the chunked bundle path in `server/preview-runtime.ts` |
| 14 Brief cards | worker | U | `client/brief/**`, `server/brief.ts`, the Brief and card rules in `client/workspace.css`, their tests; the new card fields in `packages/contracts/src/index.ts` (draft; lead applies) |

`preview-runtime.ts` is shared by lanes 10 and 13, on separate functions, and
the lead merges the two in order.

**Waves.** The machine had 6.6 GB of free memory on Thu 17:10, enough for
about 4 lanes running tests at once, so lanes start in waves. A lane's spike
runs first, and the same worker then continues into its lane.

1. **Now:**
   - foundations;
   - B's pure parts (block types, rules, generated schema);
   - H's first pass;
   - I's briefs and runner;
   - S1, then A;
   - S4, then E.
2. **After foundations merge:** A, B's review tool and gate, D and F (with
   S2), E and G, and U (the Brief cards, lane 14).
3. **Then:**
   - P (with S3), which also proposes its wrangler entry for the ModuleBuilder
     Durable Object class to lane 1;
   - Q and R (with S5);
   - J, L and O's starter files (with S7);
   - M and the K types.
4. **Last:** the screens, K's host side and N.

Rules for every lane:

- Work in its own worktree, on its own branch.
- Edit only its own files, and send shared changes to lane 1.
- Before reporting, run `bun run typecheck`, the affected tests and
  `verify:packet`.
- No pushes, deploys or paid calls.
- The lead merges continuously and runs the full gate plus the starter smoke
  check after each merge.

## 9. Schedule (Lagos time)

| Day | Work | You |
| :--- | :--- | :--- |
| Thu 22 | Wave 1 from 17:30: foundations, B's pure parts, H, I, S1 and S4. | none |
| Fri 23 | Foundations merge; waves 2 and 3. Lane 2's block v2 by 12:00 (lanes 4, 12 and 13 align to it). S2, S3 and S4. Smoke build. | One smoke build (paid, small) |
| Sat 24 | Wave 4. Parts land; the lead merges. Small and big flows end to end with a scripted model. S5. | The S5 deploy go |
| Sun 25 | Full gate. Local acceptance for both flows. Fixes. You review the new screens and the Brief cards on the running app. Base deploy (section 11): migrations, the ModuleBuilder class and the Brief cards, every new switch off. | Screen review; the base deploy go |
| Mon 26 | The campaign (cap $150), including S6. Fixes between runs. | Approve the $150 |
| Tue 27 | 18:00: decide each switch (section 10). Push and deploy with the chosen values. | Decide; give the deploy go |
| Wed 28 | Final small demo app on production. If `big_apps` passed: Caddie builds FarmOps on production (big-app limit, $40). Recording. Final texts. | Record the Caddie video; the FarmOps build go |
| Thu 29 | Submit Caddie. If FarmOps works end to end: submit it as a second entry. | Repo public, Devpost forms, judge test, submit; the FarmOps video |
| Fri 30 | Buffer until 18:00. | none |

**Second entry: FarmOps built by Caddie.** The rules allow more than one
entry, as long as each is "unique and substantially different" from the
others ([rules](https://nebiusglobalaihackathon.devpost.com/rules), checked
2026-10-22). FarmOps, a farm app, is different from Caddie, an app builder.
Its entry needs:

- its own track;
- its own description and video;
- the written feedback on Token Factory and the NVIDIA models;
- a plain note that it's a new app built by Caddie during the hackathon,
  modeled on the owner's existing FarmOps product.

It goes in only if it really works end to end (section 10's big-app marks).
It must stay live and free until Dec 15, like Caddie.

**Insurance, available now:** HerdVoice can be finished on today's pipeline
(paid; needs your go and a production sign-in).

## 10. Go/no-go per switch (Tue 27, 18:00)

- **`team_mode` → on**, only if all of these hold:
  - the full gate is green;
  - at least 8 of the 12 team-mode briefs are complete;
  - at least 4 of the 5 paired briefs are complete in team mode, and team
    mode completes at least as many as the baseline;
  - FarmLog and HerdVoice are complete;
  - there are no limit overruns;
  - there are no "saved" or "done" claims without a host receipt;
  - the campaign stayed within its cap.

  If not, it goes to `owner` (if at least 6 of 12) or `off`.
- **`big_apps` → owner**, if the big brief merges at least 75% of its modules
  with every check green and the browser check passing. It goes **on for
  judges** only if 100% merge (and D9). Otherwise it's `off`.
- **`app_features` → on**, if each feature's briefs complete with the
  test-mode labels visible. Otherwise `owner` or `off`, per feature where
  possible.

A tie at zero fails, because the absolute marks above apply first. Part A,
the key scan in part G and part H ship regardless.

## 11. Rollback plans

Every Caddie deploy follows `docs/runbooks/production-deploy.md` (the steps)
and `docs/runbooks/deployment-explained.md` (why, and the traps): the
release check, a production build, preflight, a dry run, migrations before
code, the deploy, the live smoke check, and the evidence record.

- **Switches** flip without a redeploy through the operator route, and each
  flip is logged. Never flip one with `wrangler secret put`, because that
  deploys a new version at once.
- **Before every deploy,** record the live Worker version id.
  `wrangler rollback` restores it in about a minute, except across a Durable
  Object migration: Cloudflare refuses that rollback. So the new ModuleBuilder
  class and migrations 0040 and later go out first, in a **base deploy** on
  Sunday with every new switch off. Tuesday's deploy is then code only and can
  be rolled back.
- **Migrations 0040 and later only add,** so rolling back the code leaves
  them unused and there's nothing to undo.
- **Spending limit wrongly blocking good builds:** `spend_enforcement=off`.
  Recording continues; fix it, then switch back on.
- **Publish check wrongly blocking good apps:** `publish_safety=off`; the
  findings are still logged.
- **The ModuleBuilder Durable Object class** stays declared even when the
  big-apps switch is off. Durable Object migrations only add.

## 12. Not doing before Oct 30, and the cut order

**Not doing:** everything in "After the hackathon", plus:

- a type check in the sandbox;
- a security reviewer driven by a model on code (the Ultra review is on the
  plan);
- recording the helpers' usage.

**If we fall behind, cut in this order:**

1. N (jobs);
2. K (email);
3. O (recipes);
4. F (the Try-again button);
5. L (uploads);
6. the Ultra review (the deterministic rules still block);
7. J (payments);
8. M (photo AI);
9. teams and roles (B's team access and E's step 6), which turns the two farm
   briefs into single-person versions;
10. R's chunked preview (big apps limited to bundles under 2 MB);
11. Q's merge-as-each-lands (merge at the end only).

**Never cut:** A, B's rules, C, D, E, G, H, I, and the core of P and Q. If P
and Q don't pass on Monday, the big-apps switch stays off. That's the
protection.

## 13. Risks and honest feasibility

- **Big apps (P, Q, R) are the newest and hardest work.** They may not
  reliably build a v0-farmops-sized app by Tuesday. The switch keeps them
  away from judges if not, and the Devpost text claims only what passed.
- **Workload.** 13 lanes; the lead's merging is the bottleneck. Mitigations:
  strict file ownership, new modules with short hooks, continuous merging and
  the cut order.
- **The model writing a block for about 40 tables.** Mitigations: drafted per
  module, deterministic validation with precise errors, and the Ultra
  security review.
- **Flue interception (S1), local full builds (smoke run), and the publish
  size limit (S5)** are unproven until those spikes run.
- **Sandbox concurrency.** Contree allows 50 instances per account, and
  judges build too. The D12 slots apply.
- **Cost.** UNVERIFIED. The limits and the campaign cap hold it.
- **Fixed schema in big apps.** A module that needs a new field stops and
  says so. This week that's a plan revision afterwards.
- **Sandbox availability through Dec 15** is unconfirmed; you ask Nebius.
- **The preview's limits shape every app feature.** It takes 1 MB per
  request and returns 2 MB per reply, has no outside images and no location.
  Judges only see previews. Part L sends files in parts, and maps and
  location depend on D13 and D14. Any app feature that only works when
  published is described that way.
