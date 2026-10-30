# Farmhand ready-state evidence freeze — 27 October 2026

**Purpose:** plan `docs/plans/2026-10-27-design-quality-and-farmhand-readiness.md` step 1
(P0 "freeze evidence and source truth"). Everything below was captured read-only
(`sqlite3 file:…?mode=ro`) from the running local dev state before any edit of this
plan was applied. Local verification only; nothing was deployed, published, or paid.

## Git / process state at freeze

| Fact | Value |
|---|---|
| Freeze time (local) | 2026-10-27 ~11:50 WAT (Africa/Lagos) |
| HEAD | `5824450cf065dba85185a3e9697cf9871f4927a1` (main) |
| Dirty tree | 53 changed/untracked paths; `git diff HEAD` sha256 prefix `c53db8eadba203a6` |
| Dev server | vite dev pid 46006, `apps/app`, started 2026-10-26 ~22:02 WAT, `localhost:5176` |
| D1 snapshot copy | `/tmp/caddie-d1-readonly/c2048439….sqlite` (+wal) copied 11:47 WAT |

**Concurrent-session note:** a second agent (Qoder daemon + recent writes to
`apps/app/src/client/workspace/*`, `conversation/Channel.tsx`, `test-support/*shift*`,
`*trail*`) was actively editing this same checkout while this freeze was taken. Client
shell files are excluded from this plan's first edits for that reason.

## Farmhand (proj_506d61ece6d7ca3a12fdd9a41a281960)

| Fact | Value |
|---|---|
| Workflow phase | `blocked` (updatedAt 2026-10-27T09:35:12.764Z) |
| Blocker detail | Rejected post-ready change request: rename home empty-state heading "No cycles yet" → "Your farm starts here"; `build_next_feature`/`verify_build` returned "Show the plan and wait" (gate closed); host then moved the workflow to blocked |
| Plan | `pdr_5a801826-c745-4940-b035-99f77670c2fa` |
| Approved design revision | `pdr_27718a42-8745-432d-97e6-da59deb5838c` |
| Spend payer (last admission) | `build:run_506d61ece6d7ca3a12fdd9a41a281960:1793091605716` |
| Head commit (immutable) | `08b683cdf6c93fbd8541d88a39e6ed2aaf79fee1`, created 2026-10-27T09:01:31.569Z |
| Output / preview | `out_02c537b50b9e95f636b28c27b10b73d9`, image `2d73015d-5f28-44a8-81c4-471ced71c8f0`, sha256 `e08d3f039451659888f384b334de425c7558a85955ab040fde752dde2b8978f6`, manifest `713458ba3aa05fafa3db5c7352ddc1b3d0ea1467dfc2461badf345f658de89fa`, created 2026-10-27T09:01:31.440Z |
| Independent quality gate | `quality_projects`: **0 rows**; `artifact_candidates`: **0 rows** → the quality gate never ran for this output |
| Publications | untouched by this freeze (no publish attempted) |

**Baseline preservation rule:** commit `08b683cd…` and output `out_02c537…` are the
immutable ready-state baseline. The old preview must stay reachable while any change
request is pending/failed/blocked. No DB surgery, no reset, no regeneration without
the owner's paid-call authorization.

**Anomaly found during freeze:** the head commit's tree contains two repair-scratch
files that do not belong in the app — `. caddie-scratch/patch_server.js` (6,140 B,
sha256 `0b74bcef1a1592180edbe8b2c4106dd0b12ba557b9aa9606c1d2d6ad09cdbd40`) and
`. caddie-scratch/patch_server.py` (5,822 B, sha256
`b6f30a2e175ebc08f21326e613eb8bfaaefddd7cffd91a64d234a79b37395cbc`) — paths literal
`". caddie-scratch/…"`
with a leading dot-space. A build/repair step leaked its scratch into the immutable
commit tree. Recorded here; do not mutate the baseline to remove them; fix the leak
for future versions (harness hygiene).

## Urgent deadline discrepancy — traced

- Stored listing: discovery candidate `cand_690412b2b3db24fc85edc7c54f65afd32e537deab9ceb10fe52e490bd54`
  ("Nebius x NVIDIA Global AI Hackathon", `https://nebiusglobalaihackathon.devpost.com/`),
  summary "Aug 26 - Oct 30, 2026" — **date-only; no closing hour or timezone exists anywhere
  in the stored source**.
- Official rules page: **Oct 30, 10:00 AM PDT = 6:00 PM Lagos (17:00 UTC)**.
- Root cause: not a timezone-conversion bug. `apps/app/src/server/brief.ts`
  (`hackathonDeadlineCard`, `deadlineIso = `${hackathon.deadline}T23:59:59Z``) and
  `apps/app/src/server/project-hackathon.ts` (`daysUntil`, `Date.parse(`${deadline}T23:59:59Z`)`)
  **invent an end-of-day instant** from the date-only value, then render it as "Your time →".
  The observed "Oct 30 at 11:59 PM local" is that invented `23:59:59` presented as if sourced.
  It overstates the real deadline by ~6 hours and could cause a missed submission.
- The client-side helper `apps/app/src/client/discovery/deadline-time.ts` already refuses
  date-only values (fixed 2026-10-23, `tests/deadline-time.test.ts`); the server producers
  above were not given the same treatment.
- Fix direction (this plan step 1): present the date-only source honestly — date, source
  citation, visible "source lists a date only — confirm the exact hour on the contest site"
  warning, calendar-day countdown only; never render an invented clock time. Regression
  coverage: correct-zone conversion when a real instant exists, unknown time, date-only,
  stale source.

## What this freeze does NOT establish

- Any production/hosted behavior (local D1 only).
- That the 56 passing generated tests + passing preview-runtime check prove user journeys,
  offline behavior, outside services, AI, accessibility, or judge access (plan step: they do not;
  `visual-fidelity` was `not-checked` on the last recorded checks).
- Any model-authorship claim for the PRD/design (see
  `docs/evidence/2026-10-27-model-role-comparison/ASSESSMENT.md` for what the calibration did establish).
