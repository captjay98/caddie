---
name: build-verify
description: Implement and verify a change in the sandbox without touching the acceptance harness
---

# Build-verify skill (P05 v2)

Implement and verify a change inside the sandbox, through the project's own
checks.

## Discipline

- Read the current code first; read a failure before you change anything.
- There is ONE way to run the project's checks: `run_checks`. It installs,
  runs the behaviour tests (`bun test src/`) and builds the bundle, exactly as
  the host verifies them. Shell test commands (`bun test`, `vitest`, …) are
  refused, so never try to run tests another way — and every failing
  `run_checks` counts toward this build's repair limit, so read the failure and
  fix its cause before running it again.
- Red → repair → green on `run_checks`. Add at least one test in `src/*.test.tsx`
  (or `src/*.test.ts` for a server route) for each doneWhen check; the host
  refuses to finish a feature that adds no new passing test.
- A self-report is NEVER success. "It should work", "I ran it and it passed" and
  a task result with no receipt prove nothing — only a green `run_checks`
  receipt (or QA's `verify_build`) does. Report the exact checks that passed.
- When `run_checks` fails inside Caddie's own steps rather than your app (the
  output names /tmp/caddie-…, a package could not be unpacked, the registry was
  unreachable, a tarball does not match bun.lock), that is Caddie's problem, not
  your code: say so in one plain sentence and stop that repair. Never debug
  Caddie's own scripts.
- The acceptance surfaces and Caddie's runtime files (`caddie/`, `test/setup/`,
  `bunfig.toml`, the migrations Caddie generates) are read-only to you: you use
  them, you never edit them. Generated apps have no `tests/acceptance/`
  harness — do not write one; the host owns the gate.
