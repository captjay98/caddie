# How deployment works (explained)

The companion to `production-deploy.md`. That file is the procedure — the
exact commands in the exact order. This file is the mental model: what a
deploy actually is, why each step exists, the traps, and where the pipeline
simplifies from here. Written so a new agent (or person) can be productive
from one read. Worked example: the 2026-10-22 deploy, version `c7e7cc7a`.

## What actually ships

One Cloudflare Worker, `caddie-app`, carries everything:

- the Hono API (`apps/app/src/app.ts`),
- the Flue agents as Durable Objects,
- the static assets — Astro landing + React SPA — composed into one tree by
  `scripts/compose-assets.ts`.

Public address: the custom domain `caddie.jamalibrahim.dev`. State: one
remote D1 database (`caddie`), schema = 39 append-only migrations.
There is no staging, no containers, no CI. Deploys run from a terminal on
the owner's Mac — whoever deploys *is* the pipeline.

## The one non-obvious rule: production is chosen at build time

Never `wrangler deploy --env production`. Instead:

```sh
CLOUDFLARE_ENV=production bun run build
```

The compose step flattens the `env.production` block of
`apps/app/wrangler.jsonc` (account id, real D1 id, custom domain route,
observability) into the built config, and FAILS the build if the built
config does not carry the environment that was asked for. A plain
`bun run build` silently produces a dev-shaped bundle that still deploys
and then breaks — nothing downstream can rescue a wrong-env build.

## The sequence, and why each step exists

From the repo root, on `main`, with a clean tree:

| Step | Command | Why |
|---|---|---|
| 1. Gate | `bun scripts/release-check.ts` | the whole local gate in one command; bar = 0 FAIL. Its final `[BLOCKED] deployment authorization` line is permanent by design — a human's explicit "deploy" is what satisfies it |
| 2. Build | `CLOUDFLARE_ENV=production bun run build` | see the rule above |
| 3. Preflight | `bun scripts/deploy-preflight.ts` | 12 required `.prod.vars` values present, `dist/` is the production build, every DO class bound. Read every WARN — they don't block |
| 4. Dry run | `cd apps/app && bunx wrangler deploy --dry-run` | uploads nothing; shows what WOULD be bound |
| 5. Migrations | `bunx wrangler d1 migrations apply caddie --remote --config wrangler.jsonc --env production` | **migrations before code, always** — they are additive, so old code ignores them for the seconds before the new code lands; the reverse order is new code hitting missing tables |
| 6. Deploy | `bunx wrangler deploy --secrets-file .prod.vars` | the real deploy; prints the **Version ID**, the rollback handle |
| 7. Smoke | `CADDIE_LIVE_AUTHORIZED=1 CADDIE_RELEASE_URL=https://caddie.jamalibrahim.dev bun run test:live -- P17` | five checks against the live origin; writes a receipt into `docs/live-receipts.json` tied to the commit SHA. Then sign in by hand |
| 8. Record | append to `docs/release-evidence.md`, commit docs | the release decision's single evidence table |

Step 7's receipt is what turns "it worked on my Mac" into LIVE VERIFIED
evidence. Step 8 must name: URL, version id, commit, gate results, smoke
receipt, what changed. One extra proof worth copying every time: diff a
hashed asset name from the live `/app/` HTML against the local `dist/` —
matching hashes prove the domain serves exactly the built bytes.

## The traps (each has bitten)

- **Multiple Cloudflare accounts on the token.** `wrangler secret put
  --name caddie-app` reads no config file, cannot pick an account, and
  fails silently or refuses. Prefix every `secret` command with
  `CLOUDFLARE_ACCOUNT_ID=<caddie's id>`. Plain `deploy` reads the config's
  `account_id`, so it is exempt.
- **Never `wrangler d1 migrations apply --local` for development.** The
  vite dev DB is managed by direct `sqlite3` against the miniflare state
  file (see the dev-server runbook). `--remote` is production-only.
- **`wrangler secret put` deploys a new version immediately.** That is a
  feature: judge access toggles (`JUDGE_ACCESS_ENABLED=0`) without a
  rebuild. It is also a surprise: a "harmless" secret put is a deploy.
- **Removing a line from `.prod.vars` does not delete the secret.** That
  takes `bunx wrangler secret delete`.
- **Rollback is code-only.** `bunx wrangler deployments list`, then
  `bunx wrangler rollback <version-id>`. Migrations stay applied (safe —
  they are additive), Cloudflare refuses rollback across a Durable Object
  migration boundary, and only the last 100 versions are eligible.
- **Evidence classification is binding** (AGENTS.md). A local pass is never
  LIVE VERIFIED; agent self-reports are never success evidence. Do not
  hand-edit `docs/live-receipts.json` — the smoke run owns it.
- **Clean tree on `main`.** The evidence record ties a version to a SHA.
  Anything dirty is either committed first or named honestly in the record.

## Worked example (2026-10-22)

| Item | Value |
|---|---|
| Version id | `c7e7cc7a-1b52-426c-84c1-01eedd3fb7f2` |
| Commit | `5f3574a` |
| Gate | release-check 49 PASS / 0 FAIL; preflight 18 PASS / 2 WARN (shared provider keys, a recorded choice) |
| D1 | no pending migrations (0039 current) |
| Smoke | P17 live 5/5 PASS, receipt `lr_5bf0b08f5db1bbcb`; live SPA hash `index-DcYqzncY.js` == local build |
| Evidence | committed as `a31f631` |

## Simplification roadmap (proposals, not built)

Ordered by value. Nothing here is permission to skip gates — each proposal
makes the existing gates harder to skip by accident.

1. **One-command deploy (`scripts/deploy.ts`).** Runs steps 1–8 in order,
   stops on first failure, prints progress. It should: capture the
   pre-deploy version id (for rollback), require an explicit `--yes` as
   the deployment-authorization acknowledgement, read the version id out
   of the deploy output, append the evidence row itself, and on a failed
   smoke print the exact rollback command. This kills the two worst
   failure modes: steps done out of order (migrations after code) and the
   evidence step being skipped. Highest value; everything else is smaller.
2. **Make the wrong-env build undeployable, not just guarded.** Today a
   dev build still produces a deployable Worker. Make `bun run build`
   without `CLOUDFLARE_ENV` either refuse to write the built worker
   config or name the worker `caddie-app-dev` so `wrangler deploy`
   physically cannot ship it to production by accident.
3. **One Cloudflare account on the token** (or `CLOUDFLARE_ACCOUNT_ID`
   pinned in the shell profile). Owner action, one time; deletes the
   silent-failure trap from every future `secret` command.
4. **Separate production provider keys** (Nebius, Tavily, Contree). Owner
   inputs; deletes the standing preflight WARNs and makes judging spend
   independently revocable.
5. **Tag-driven deploy in GitHub Actions.** The pipeline leaves the Mac;
   clean-tree is true by construction; the evidence attach is automatic.
   **Precondition:** the repo-history rewrite + secret rotation recorded
   in the hygiene notes must happen first — this repo cannot push to a
   remote until then. Keep last for that reason.
6. **Release-check learns about remote migrations.** A check that diffs
   local migration files against the remote `d1_migrations` table, so
   step 5 reporting "surprise pending migrations" can never be the first
   sign of drift. Small; fold into proposal 1 when built.

The destination state: `bun scripts/deploy.ts --yes` does the right thing
in the right order, refuses unsafe inputs, records its own evidence, and
hands back a version id. Until then, the runbook's eight steps are the
contract.
