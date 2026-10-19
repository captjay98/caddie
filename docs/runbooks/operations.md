# Operations runbook (P17)

## Local verification loop

```sh
bun run build            # Astro + Vite + composition into one Workers assets tree
bun run typecheck        # root + apps/app projects
bun run verify:packet Pxx  # per-packet mapped tests (fails honestly on missing/empty)
bun run test:live -- Pxx   # live harness — requires CADDIE_LIVE_AUTHORIZED=1 + credentials
bun run test:browser -- Pxx  # browser specs against the composed build
bun scripts/release-check.ts  # the full local gate before any release request
```

## Evidence rules (binding)

- Classify exactly: LOCAL VERIFIED, LIVE VERIFIED, SIMULATED, DOCUMENTATION
  ONLY, BLOCKED, FAILED. A mocked or local-only pass is never LIVE VERIFIED.
- Record command, exit code, SHA, environment, artifact hash per packet in
  `docs/plans/2026-10-03-fresh-build/execution-ledger.md`.
- Agent/model self-reports are never success evidence; only machine-checked
  acceptance (command exits + browser assertions) counts.

## Recovery

- Never `git add -A` blindly (worktrees are embedded repos if unignored) or
  `git reset`/`stash`/force-push. Resume from the execution ledger plus
  `git diff`, not from memory.
- Keep WIP; a failed task is repaired or isolated — never integrated broken.

## Deployment gates (ALL required, in order)

The production procedure is `docs/runbooks/production-deploy.md`; its
preflight is `bun scripts/deploy-preflight.ts`.

1. `bun scripts/release-check.ts` exits 0 (all local checks PASS).
2. Every live gate either BLOCKED-and-accepted or LIVE VERIFIED with receipts.
3. Concrete owner approval against the specific release SHA.
4. Post-deploy smoke tied to that SHA (P17 live spec).
5. Rollback package exists: previous SHA, migration compatibility confirmed
   (D1 migrations are append-only; never delete user data to undo).
