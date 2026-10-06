# Owner inputs — what unblocks live work

Each item below blocks specific live verification. Aside (the owner's
logged-in browser agent) has been delegated to provision them; this document
is the checklist and the record.

| Input | Unblocks | Status |
|---|---|---|
| Google OAuth client (Web application, redirect `BETTER_AUTH_URL/api/auth/callback/google`) | P01 live OAuth | pending |
| GitHub OAuth App (scopes `read:user user:email` only, redirect `.../api/auth/callback/github`) | P01 live OAuth | pending |
| GitHub App (P08: contents read-only + PR write, webhook secret) | P08 live | deferred until P08 merge |
| Nebius API key (`NEBIUS_API_KEY`) | P05 live round-trips, P09 journey | pending |
| TF Sandboxes credentials (`CONTREE_BASE_URL`, `CONTREE_API_TOKEN`, `CONTREE_PROJECT_ID`) | P04 live probes, P09 sandbox phases | pending |
| Real contact address for landing mailto | P16 public deployment | pending |
| Live-test authorization (`CADDIE_LIVE_AUTHORIZED=1` + budget) | all live runs | owner decision per run |

Secrets go directly into `.dev.vars` (gitignored). Never in chat, never in
artifacts.
