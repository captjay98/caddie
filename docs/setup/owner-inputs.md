# Owner inputs — what unblocks live work

Each item below blocks specific live verification. Aside (the owner's
logged-in browser agent) has been delegated to provision them; this document
is the checklist and the record.

| Input | Unblocks | Status |
|---|---|---|
| Google OAuth client (Web application, redirect `http://localhost:5173/api/auth/callback/google`) | P01 live OAuth | PROVISIONED via aside (project caddie-forge-dev, client in `.dev.vars`) |
| GitHub OAuth App (scopes `read:user user:email` only, redirect `http://localhost:5173/api/auth/callback/github`) | P01 live OAuth | PROVISIONED via aside (client `<GITHUB_CLIENT_ID>`, secret in `.dev.vars`) |
| GitHub App (P08: contents read-only + PR write, webhook secret) | P08 live | deferred until P08 merge |
| Nebius API key (`NEBIUS_API_KEY`) | P05 live round-trips, P09 journey | PROVISIONED via aside (in `.dev.vars`) |
| TF Sandboxes credentials (`CONTREE_BASE_URL`, `CONTREE_API_TOKEN`, `CONTREE_PROJECT_ID`) | P04 live probes, P09 sandbox phases | PROVISIONED via aside (in `.dev.vars`; whoami verified) |
| Real contact address for landing mailto | P16 public deployment | RESOLVED: captjay98@gmail.com (owner's address, set directly) |
| Live-test authorization (`CADDIE_LIVE_AUTHORIZED=1` + budget) | all live runs | owner decision per run |
| App keys keyring (`APP_SECRETS_KEYS` = `kid:base64-32-bytes[,kid:...]`, e.g. `k1:$(openssl rand -base64 32)`; first entry seals; keep older entries until `rotateAppSecrets` has re-sealed) | saving app keys, keys in previews and published apps | not provided — locally the Keys card says saving keys isn't set up |
| Publishing: Cloudflare Workers Paid + Workers for Platforms; `CLOUDFLARE_API_TOKEN` (WfP scripts, D1, KV, custom hostnames, URL Scanner), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DISPATCH_NAMESPACE`, `CLOUDFLARE_ROUTES_KV_ID`, `CLOUDFLARE_APPS_ZONE_ID` | Publish (stage 4), the dispatch Worker in `workers/dispatch/` | BLOCKED — needs the account and a go-ahead with a budget |
| Apps domain (`APPS_DOMAIN`, separate from Caddie's own domain, registered for 2+ years, on the Public Suffix List) | app addresses `<slug>.<APPS_DOMAIN>` | BLOCKED |
| Optional `EGRESS_DENY_HOSTS` (comma-separated hosts apps' servers may never call; Caddie's own host and the apps domain are always denied) | tighter egress for previews and published apps | optional |
| Monitored abuse inbox (replies within 24 hours) | going live with Publish | BLOCKED |

Secrets go directly into `.dev.vars` (gitignored). Never in chat, never in
artifacts.
