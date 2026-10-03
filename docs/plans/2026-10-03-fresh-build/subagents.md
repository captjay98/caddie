# Subagent execution runbook

## Roles and ownership

Coordinator is integration owner. It chooses ready work, freezes interfaces, supplies relevant source context, answers routine implementation questions, integrates patches, reruns affected checks and updates ledger. It does not route routine technical decisions to the human.

Coding subagents: backend/identity, runtime, sandbox/GitHub, frontend/product, Astro design, evidence domain, stack/mobile, independent QA/reviewer. These are assignments, not mandatory permanent processes. Use one fresh implementer for a bounded slice. Product specialists running inside Caddie are separate Flue definitions in P05.

Default skill workflow is one implementation agent at a time, with research/tests/review preparation delegated concurrently. When the execution environment and applicable workflow allow parallel implementation, use isolated task branches/worktrees and disjoint file ownership after contract freeze. Never let two agents mutate shared checkout/index/files. Maximum useful concurrency here is coordinator + two disjoint workers + reviewer; reduce it when tasks share state. The user's desire for subagent-driven work does not mean racing all tasks simultaneously.

Shared files owned only by integration lead: manifests/lockfile, app route registration, root/Cloudflare/Vite/Astro config, shared contracts, migration numbering, feature/execution ledger. Agents propose changes; lead applies them sequentially. DO migrations must be append-only with generated class names verified. No inherited giant agent scaffold.

## Dispatch template

```text
Task: Pxx.slice-N — concrete outcome
Branch/worktree: exact assigned path and baseline SHA
Allowed writes: exact paths; all other files read-only
Dependencies: completed packet IDs and contract versions
Context: paste packet slice + relevant contract + source carryover excerpt
Implement: smallest code that satisfies this behavior; no scope cuts
Validate: exact focused tests; runtime/browser/live classification required
Do not: deploy, spend without configured authorization/budget, disclose secrets,
change protected acceptance, overwrite colleague work or edit shared manifests
Return: changed files, commit/diff, commands and exit codes, artifact paths,
limitations/blockers, needed shared-file changes
```

Supply whole task text; don't make every worker rediscover the plan. Ask focused questions only if a missing requirement would change product behavior. A missing credential blocks the live check, not unrelated implementation. Never obtain or print secrets from another project just because readable.

## Review and integration

1. Implementer runs focused checks and self-review; commits owned files only on task branch.
2. Fresh spec reviewer inspects diff and actual behavior against acceptance, including unchanged agreed scope. It returns PASS or concrete file/line gaps.
3. Implementer fixes; spec reviewer rechecks.
4. Fresh quality reviewer inspects correctness, simplicity, authorization, failure recovery and test quality; reruns targeted checks where useful.
5. Implementer fixes; quality reviewer rechecks.
6. Coordinator integrates serially, runs affected contract/integration/browser checks, records integrated SHA and evidence. No broad repeated suites without new changes/risk.
7. At P09 and P17, separate QA performs end-to-end adverse journeys. These milestone reviews do not replace per-packet reviews.

Role naming does not grant authority: only application authorization grants user-facing agents tool capabilities. A reviewer cannot approve deployment for the human.

## Evidence record

```json
{
  "packet": "P09", "status": "LOCAL VERIFIED", "sha": "actual-sha",
  "commands": [{"command": "actual command", "exitCode": 0}],
  "artifacts": [{"path": "actual path", "sha256": "actual hash"}],
  "environment": "local workerd", "providerCalls": "none",
  "specReview": "PASS", "qualityReview": "PASS", "limitations": []
}
```

Use real values, never this example as receipt. BLOCKED records exact external prerequisite and independent work that can continue. Complete only when all required packet criteria pass; source existence, model claims, or docs-only SDK features are insufficient.

## Coding skills

Start with concise AGENTS.md plus relevant skills: frontend design/accessibility; Workers/DO; sandbox; test/debug/review; Laravel for P15b; Flutter for P15d. Inspect skill instructions and applicability before use; do not copy Onesecos organization-specific rules or entire catalogs. Runtime skills get version/hash manifest, scoped mount, activation receipt and tool permissions. Retain Devpost template discipline, drop forced learner pauses incompatible with approved autonomous mode.

## Recovery and release

Keep WIP; no blanket git add/reset/stash/force-push. Resume from execution ledger plus actual git diff and evidence, not chat recollection. A failed task is repaired or isolated; do not integrate knowingly broken dependencies. Deployment/default-branch/destructive effects remain owner gates after preparation. Repo creation remote, domain grants, OAuth consent and credentials are setup actions with actual required permissions, not implied by writing this plan.
