# Production deploy (S10)

The owner runs this (gate G4), or authorizes each step marked **[remote]**.
Nothing else leaves the Mac. Run commands from the repo root unless a step
says `apps/app`.

The procedure was rehearsed locally on 2026-10-19 with a dummy D1 id and
domain. The rehearsal covered the production build, preflight, the dry run
with the repo's wrangler, and the migrations against a fresh local D1.
Nothing was uploaded (execution ledger, S10 record).

## Once, before the first deploy

1. **Cloudflare:** the account must be on Workers Paid. Worker Loader (app
   previews with a server) needs it. Turn on billing notifications.
2. **[remote] Sign in:** `cd apps/app && bunx wrangler login`.
3. **[remote] Database:** `bunx wrangler d1 create caddie`. Put the id it
   prints in `apps/app/wrangler.jsonc`, `env.production` →
   `d1_databases` → `database_id`, in place of `<PRODUCTION_D1_DATABASE_ID>`.
4. **Address:** put the hostname (for example `caddie.example.com`) in
   `env.production` → `routes`, in place of `<CADDIE_DOMAIN>`. Its zone must
   be on the same account; the deploy creates the DNS record and certificate.
   Without a domain, delete the `routes` line and set `"workers_dev": true`.
   The address is then `https://caddie-app.<your-subdomain>.workers.dev`.
   Commit the config change.
5. **Sign-in apps for production.** Judges need neither; you need one.
   - **Google:** a new OAuth client (Web application).
     - JavaScript origin: `https://<host>`.
     - Redirect URI: `https://<host>/api/auth/callback/google`.
     - Set the consent screen's publishing status to "In production"; in
       "Testing" only listed test users get in.
   - **GitHub:** a new OAuth App with homepage `https://<host>` and callback
     `https://<host>/api/auth/callback/github`. A GitHub OAuth App has one
     callback URL, so the local app can't be reused.
6. **Values:** `cp apps/app/.prod.vars.example apps/app/.prod.vars`, then fill
   it in. The file is gitignored and says how to generate each secret.
   `BETTER_AUTH_SECRET` and the judge code must be new; separate Nebius,
   Tavily and sandbox keys are better.
7. **Spend alerts outside Caddie:** a Nebius alert or limit, a Tavily credit
   alert, sandbox usage, and Cloudflare billing. Judge limits count actions,
   not dollars, and Caddie's own AI use has no dollar cap.
8. **Sandbox:** confirm it stays available through 2026-12-15.

## Judge access: deploy without it first

The pre-final review (`docs/reviews/2026-10-19-pre-final-testing-review.md`)
found two holes in the judge limits:

- **F02:** paid work judges could trigger outside the limits (chat discovery,
  research, AI digests, change requests, the scaffold `/agents/hello` agent).
- **F03:** projects created at the same moment could exceed the project limit.

Both were fixed on 2026-10-19 (`0811b8a`, LOCAL VERIFIED). Still deploy without
judge access first: leave `JUDGE_ACCESS_CODE` and `JUDGE_ACCESS_UNTIL` out of
`.prod.vars` and add `--owner-only` to the preflight. Run the smoke and your own
sign-in, then turn judge access on without a rebuild (see "Changing settings")
and start one judge account yourself before sharing the code.

## Every deploy

On `main` with a clean tree:

1. `bun scripts/release-check.ts`: 0 FAIL.
2. `CLOUDFLARE_ENV=production bun run build`.
3. `bun scripts/deploy-preflight.ts`, with `--owner-only` while judge access
   is off: 0 FAIL. Read every WARN.
4. `cd apps/app && bunx wrangler deploy --dry-run`. It lists DB, LOADER,
   PREVIEW_DB and the two Flue agents, and uploads nothing.
5. **[remote] Migrations, before the code** (in `apps/app`):
   `bunx wrangler d1 migrations apply caddie --remote --config wrangler.jsonc --env production`.
   The first run applies 0001-0035; later runs apply only new ones. Never edit
   a migration once it has been applied.
6. **[remote] Deploy** (in `apps/app`): `bunx wrangler deploy --secrets-file .prod.vars`.
   Secrets persist, so later deploys can leave the flag off. A line removed
   from the file does not delete its secret; use `bunx wrangler secret delete`.
7. **Smoke** (repo root):
   `CADDIE_LIVE_AUTHORIZED=1 CADDIE_RELEASE_URL=https://<host> bun run test:live -- P17`.
   It checks the landing, the `/app` shell, the sign-in status and the API's
   JSON 404. Then by hand:
   - sign in as yourself;
   - if judge access is on, start a judge account in a private window.
8. **Record** (in `apps/app`): `bunx wrangler deployments list` shows the
   version id. Add the URL, version id, commit and smoke result to
   `docs/release-evidence.md`.

## Changing settings without a rebuild

Each `wrangler secret put` deploys a new version at once. `--name caddie-app`
makes it work from any folder.

| To | Put |
| :--- | :--- |
| Stop new judge accounts | `JUDGE_ACCESS_ENABLED` = `0` |
| Stop judges' builds, messages, projects or lookups | `JUDGE_MAX_BUILDS_PER_DAY`, `JUDGE_MAX_MESSAGES_PER_DAY`, `JUDGE_MAX_PROJECTS` or `JUDGE_MAX_DISCOVERY_PER_DAY` = `0` |
| Open judge access (after the smoke) | `JUDGE_ACCESS_CODE` (16+ characters), then `JUDGE_ACCESS_UNTIL` = `2026-12-16` |
| Replace a leaked judge code | a new `JUDGE_ACCESS_CODE`; existing judges still sign in with their name and password |

For example: `bunx wrangler secret put JUDGE_ACCESS_ENABLED --name caddie-app`,
then type `0`. If the wrangler token holds more than one Cloudflare account,
prefix every `secret` command with
`CLOUDFLARE_ACCOUNT_ID=<Caddie's account id>` — `--name` alone reads no
config file, so wrangler cannot pick an account and refuses. To stop all AI
spend at once, revoke the Nebius key in Nebius's console.

## Rollback

`bunx wrangler deployments list`, then `bunx wrangler rollback <version-id>`.

- **Code only:** a rollback changes the code, not the database. Every applied
  migration stays. Some migrations rebuild a table (0024, 0035), so check that
  the older code works with any migrations added since that version.
- **Durable Objects:** Cloudflare refuses a rollback to a version from before
  a Durable Object migration (the `migrations` tags in `wrangler.jsonc`).
- **Window:** only the 100 most recent versions can be rolled back to.
- **The phone-app service worker:** browsers keep `/sw.js` installed. It only
  keeps the app shell and the hashed files under `/assets/`, never `/api` or
  `/agents`, and every build replaces it on the next visit, so a rollback
  needs nothing extra. To remove it from every browser, deploy a build whose
  `apps/app/public/sw.js` only unregisters itself and deletes the caches
  whose names start with `caddie-` (keep the `'__CADDIE_BUILD__'` placeholder
  once, or the build refuses it).

## If something fails

- **`binding LOADER of type worker_loader is invalid [code: 10021]`:** the
  account is not on Workers Paid.
- **`The "legacy_env" field is no longer supported`:** the build is older than
  the compose fix of 2026-10-19. Run step 2 again.
- **The deploy cannot find the D1 database:** the id in `env.production` is
  not on this account. Check with `bunx wrangler d1 list`.
- **Google `redirect_uri_mismatch`, or GitHub "redirect_uri is not
  associated":** the OAuth app's callback is not exactly
  `https://<host>/api/auth/callback/<google|github>`.
- **Sign-in loops, or "invalid origin":** `BETTER_AUTH_URL` is not the address
  in the browser.
- **GitHub's Authorize button is disabled on the consent page** (chips like
  "Created less than a day ago", "Fewer than 10 GitHub users"): GitHub's
  trust gate for brand-new OAuth apps, not a Caddie fault — by then the
  redirect, callback and scopes are already proven. The button is
  server-rendered `disabled`; do not force the form. Check the account's
  primary email is verified, wait for the app to age out of the gate (on the
  order of a day), then click Authorize in any signed-in browser.
- **No judge option on the sign-in page:** expected while judge access is off.
  Otherwise `JUDGE_ACCESS_CODE` is missing or shorter than 16 characters, or
  `JUDGE_ACCESS_UNTIL` has passed.
- **"Publishing isn't set up":** expected. Publishing needs its own values and
  the two Workers in `workers/dispatch/`: see
  `docs/runbooks/publishing-setup.md`.
