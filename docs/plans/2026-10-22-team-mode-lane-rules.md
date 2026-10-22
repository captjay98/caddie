# Software-team mode: rules for every lane

The plan is `docs/plans/2026-10-22-software-team-mode.md` (rev 5, commit
`f4bdc8e`). These rules apply to every lane worker, on top of `AGENTS.md`.

## Where you work

- Read `AGENTS.md` first, and `docs/flue-contracts.md` before any agent code.
- Work only in your own worktree, and always pass it as the shell's
  `working_dir`. Never touch `/Users/captjay98/projects/caddie-forge`, the main
  checkout where another agent works, or any other worktree.
  `/Users/captjay98/projects/farmhand/v0-farmops` is read-only reference.
- If the real code makes the plan's design unworkable, stop and report. Don't
  guess.

## Setup

- `export PATH=$HOME/.bun/bin:$PATH`, because the mise shim has no bun.
- Run `bun install --frozen-lockfile` in the worktree root.
- If root `bun run typecheck` can't resolve `@flue/sdk`, add the gitignored
  symlink `node_modules/@flue/sdk -> ../../apps/app/node_modules/@flue/sdk`
  (check the target exists first).
- Flue 2.2.2 docs: `apps/app/node_modules/@flue/sdk/docs/reference/`.
- Typecheck only with `bun run typecheck`, which uses the repo's TypeScript
  7.0.2. A bare `tsc` runs a global TypeScript 5.8.3 that reports a false
  error in `secret-box.ts`.

## Testing

- Test first: write the test and see it fail on the current code, then
  implement.
- Prove each test bites:
  1. Copy the file to `$KIROCREW_SCRATCH`.
  2. Revert the key line and see the test fail.
  3. Restore the file byte-identically and confirm with `cmp`.
- Never use `git stash`; stashes are shared by every worktree.
- Make edits in one tool call and run the tests in a later one. Check that the
  run's count includes your new tests.
- A check that tests nothing must fail, never pass. No early `return` inside
  a test, no `test.skip` standing in for a required check, and every test
  asserts what its name says.
- Browser tests use the repo's own `@playwright/test` Chromium, never
  `playwright-cli`, and every launch is time-bounded.

## Git and safety

- Commit small, verified steps on your own branch:
  1. `git add <specific files>`;
  2. commit in a separate tool call;
  3. check the result with `git show --stat`.
- Never merge, rebase or push.
- No deploys, no paid model or sandbox calls, and no new remotes. Never set
  `CADDIE_LIVE_AUTHORIZED`.
- Never read or print `.dev.vars` or `.env` values.
- Edit only the files your task lists. A file your task marks as cleared is
  yours to edit for exactly that purpose: make the change, don't hand it back.
  For any other file, put the exact patch in your report; the lead applies it.
- Scratch files go in `$KIROCREW_SCRATCH`. Don't create subdirectories there;
  use `mktemp -d` instead. Delete with `rm -f`, then `rmdir`, never `rm -rf`.

## Report

Before reporting, run `bun run typecheck` (exit 0) and every test file you
touched, with pass and fail counts. Then report:

- the branch;
- each commit, as its sha and one line;
- the commands you ran, with counts;
- each mutation proof;
- a classification for each claim: LOCAL VERIFIED, SIMULATED, DOCUMENTATION
  ONLY, BLOCKED or FAILED;
- patches for files you don't own;
- what you couldn't verify.

Your own claims aren't evidence; the commands are.
