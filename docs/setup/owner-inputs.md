# Owner inputs — what unblocks live work

Each item below blocks specific live verification. Aside (the owner's
logged-in browser agent) has been delegated to provision them; this document
is the checklist and the record.

| Input | Unblocks | Status |
|---|---|---|
| Google OAuth client (Web application, redirect `http://localhost:5173/api/auth/callback/google`) | P01 live OAuth | PROVISIONED via aside (project caddie-forge-dev, client in `.dev.vars`) |
| GitHub OAuth App (scopes `read:user user:email` only, redirect `http://localhost:5173/api/auth/callback/github`) | P01 live OAuth | PROVISIONED via aside (client id and secret in `.dev.vars`) |
| GitHub App (P08: contents read-only + PR write, webhook secret) | P08 live | deferred until P08 merge |
| Nebius API key (`NEBIUS_API_KEY`) | P05 live round-trips, P09 journey | PROVISIONED via aside (in `.dev.vars`) |
| TF Sandboxes credentials (`CONTREE_BASE_URL`, `CONTREE_API_TOKEN`, `CONTREE_PROJECT_ID`) | P04 live probes, P09 sandbox phases | PROVISIONED via aside (in `.dev.vars`; whoami verified) |
| Real contact address for landing mailto | P16 public deployment | RESOLVED: captjay98@gmail.com (owner's address, set directly) |
| Live-test authorization (`CADDIE_LIVE_AUTHORIZED=1` + budget) | all live runs | owner decision per run |
| App keys keyring (`APP_SECRETS_KEYS` = `kid:base64-32-bytes[,kid:...]`, e.g. `k1:$(openssl rand -base64 32)`; first entry seals; keep older entries until `rotateAppSecrets` has re-sealed) | saving app keys, keys in previews and published apps | not provided — locally the Keys card says saving keys isn't set up |
| Publishing: Cloudflare Workers Paid + Workers for Platforms; `CLOUDFLARE_API_TOKEN` (WfP scripts, D1, KV, custom hostnames, URL Scanner), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DISPATCH_NAMESPACE`, `CLOUDFLARE_ROUTES_KV_ID`, `CLOUDFLARE_APPS_ZONE_ID` | Publish (stage 4), the dispatch Worker in `workers/dispatch/` | BLOCKED — needs the account and a go-ahead with a budget |
| Apps domain (`APPS_DOMAIN`, separate from Caddie's own domain, registered for 2+ years, on the Public Suffix List) | app addresses `<slug>.<APPS_DOMAIN>` | BLOCKED |
| Optional `EGRESS_DENY_HOSTS` (comma-separated hosts apps' servers may never call; Caddie's own host and the apps domain are always denied) | tighter egress for previews and published apps | optional |
| Monitored abuse inbox (`ABUSE_INBOX`, replies within 24 hours; needs `RESEND_API_KEY` + `RESEND_FROM` to send) | going live with Publish: new reports and automatic takedowns are emailed here | BLOCKED — reports are still stored and listed at `/operator/reports` without it |
| Operators (`OPERATOR_EMAILS`, comma-separated sign-in emails) | `/operator/reports`: review reports, take apps down, restore them | not set — nobody can open the page |
| Google Web Risk key (`WEB_RISK_API_KEY`, Lookup API; free up to 100,000 lookups a month, then paid — see Google's pricing page) | the daily recheck of live apps | optional — without it only the publish-time scan runs |
| Cloudflare Artifacts binding (`ARTIFACTS`, Workers Paid, open beta) | app versions in a git repo per project | optional — without it versions live in Caddie's D1 |
| AI inside apps: `NEBIUS_API_KEY` (already set for Caddie) plus the monthly allowance per app, `APP_AI_MONTHLY_LIMIT_CENTS` (US cents, default 100; Caddie pays — the provider bills per token, see Nebius's price page) | `env.CADDIE.ai()` in previews and published apps | allowance: owner decision; without the key apps' AI answers "not available" |
| Dispatch Worker's `CADDIE_PLATFORM` service binding to Caddie's `PublishedAppPlatform` entrypoint (`workers/dispatch/wrangler.jsonc`, PROPOSED) | AI in published apps | BLOCKED with the rest of Publish |
| Sign-in emails for apps' own users: `RESEND_API_KEY` + `RESEND_FROM` (Caddie's mailer; the text is fixed and names the app's address) | codes for published apps' users (previews use the test inbox and send nothing) | without them published apps' sign-in says emails "aren't set up" |
| `BETTER_AUTH_SECRET` (already Caddie's own) | each app's sign-in cookie secret is derived from it per project and mode (HMAC), never stored | required for sign-in in previews and published apps |
| `JUDGE_ACCESS_CODE` (random, at least 16 characters — e.g. `openssl rand -base64 24`) | judge sign-in (S06) | S06 default: random, ≥16 chars. Absent or shorter than 16: judge access is off — the sign-in panel shows no judge option and a stale attempt gets `503 judge_unavailable`. NEVER write a real code value here. |
| `JUDGE_ACCESS_UNTIL` (`YYYY-MM-DD`, meaning the END of that day in UTC) | the date judge access closes (D4) | S06 default: `2026-12-16`. Absent or unparseable: judge access is off (same `503`). Past the date: `403 judge_closed`. |
| `JUDGE_ACCESS_MAX_ACCOUNTS` (integer) | how many judge accounts may exist (D4) | S06 default: `40`. Absent or not a number: the built-in default `40` applies. Full: `403 judge_full`. |
| `JUDGE_ACCESS_ENABLED` (the kill switch) | stopping new judge starts immediately (S07) | S06 default: unset means enabled. `0` refuses NEW judge starts (`403 judge_closed`); returning judges can still sign in. |
| `JUDGE_MAX_PROJECTS` (integer) | how many non-home projects one judge account may have (S07/D4) | S07 default: `3`. Absent or not a whole number: the default `3` applies. `0` means **none** (the way to stop a judge who already has an account). Over the limit: `403 JUDGE_LIMIT_PROJECTS`. The lazy Home conversation and the S07b example never count and are never refused. |
| `JUDGE_MAX_BUILDS_PER_DAY` (integer) | how many build starts one judge account may make in a rolling 24 hours (S07/D4); plan approval, design approval and Retry each count once | S07 default: `3`. Absent or not a whole number: the default `3` applies. `0` means **none**. Over the limit: `403 JUDGE_LIMIT_BUILDS`. |
| `JUDGE_MAX_MESSAGES_PER_DAY` (integer) | how many Caddie messages one judge account may send in a rolling 24 hours (S07/D4) | S07 default: `300`. Absent or not a whole number: the default `300` applies. `0` means **none**. Over the limit: `403 JUDGE_LIMIT_MESSAGES`. Messages the server itself dispatches never count. |
| `JUDGE_MAX_DISCOVERY_PER_DAY` (integer) | how many discovery lookups (re-checking the sources, checking a contest's eligibility) one judge account may run in a rolling 24 hours (S07) | S07 default: `20`. Absent or not a whole number: the default `20` applies. `0` means **none**. Over the limit: `403 JUDGE_LIMIT_DISCOVERY`. |
| `JUDGE_EXAMPLE_PROJECT_ID` (a project id, `proj_…`) | the finished example every new judge finds in their workspace (S07b) | Unset: no example. Set it to the id of one of YOUR projects with a checked build: at each new judge's first start, its newest checked version is copied into a new project "<name> (example)" in the judge's workspace, ready to try (no build is run, no model is called). Judges who started before it was set get none. |

Secrets go directly into `.dev.vars` (gitignored). Never in chat, never in
artifacts. That includes the judge access code: this document records only the
input name and its default, never a real value. Production values go in
`apps/app/.prod.vars` (gitignored; template `apps/app/.prod.vars.example`),
checked by `bun scripts/deploy-preflight.ts` and deployed per
`docs/runbooks/production-deploy.md`.
