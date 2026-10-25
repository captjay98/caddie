# B08 — Build-benchmark protocol (DRAFT, unpaid)

Status: **scaffolding only. No model run, no paid call, no live comparison has happened.**
This document is the plan; executing it needs explicit spend authorization.

## Purpose

Measure Caddie's build runtime against other harnesses on a frozen task set,
honestly — so a decision to keep strengthening the current runtime or trial a
replacement is evidence-driven, not assumed.

## Tasks

`tasks.json` — 12 tasks, frozen BEFORE any model run (3 variants each across
authenticated-CRUD, offline, AI-backed, imported-repo; each covers build,
change and recovery work). Evaluator-owned `acceptance` checks are stored
separately from the agent-visible `brief` and are withheld from every runner.
Freeze: set `frozen: true` and record the commit SHA in `tasks.json` before the
first run.

## Two tracks — scored separately, never merged

1. **Controlled harness comparison.** Same model, same budget, same sandbox /
   permission environment where each harness supports it. Isolates the runtime.
2. **Product comparison.** Each tool in its own normal configuration, clearly
   labelled as a different thing. Not comparable to track 1 and never summed
   with it.

## Comparators

Pick TWO from the researched field, by: headless support, compatible models,
and compatible sandbox/permission boundaries. Record WHY each was chosen. Do
not claim a twelve-way execution comparison from source review alone.

## Runs & measures

- Repeat each task **≥3×** per runner for the formal suite.
- Record per run: verified completion, interruption recovery, human
  interventions, duplicate/unsafe effects, regressions, design fidelity,
  elapsed time, measured cost.
- Publish ALL failures, the denominator, and any missing data. A partial run is
  reported as partial.

## Cost & authorization gate

- The local runner (`scripts/benchmark-build.ts`) does a **dry run + cost
  estimate only** and refuses to make any paid/live call unless an explicit
  `--allow-spend` allowance is passed AND a per-run budget ceiling is set.
- Start with a SMALL pilot after the protocol and acceptance checks are proven
  on the dry path; scale only then.
- Benchmark superiority, latency and cost claims require measured results with
  stated sample sizes. None exist yet.

## Release relationship

B08 does not gate B00–B07 (those stand on their own local evidence). B08 informs
the longer-term runtime decision and is itself gated on spend authorization.
