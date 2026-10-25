# Production deployment — 2026-10-25

**LIVE VERIFIED deployment and public hosted smoke.** This is not authenticated build/provider acceptance.

- URL: https://caddie.jamalibrahim.dev
- Deployed source: `f76db95068c72b08c9b29e0922806cdff7da534e` (`9bb337c` checkpoint plus a three-line SDK type-resolution portability fix).
- Cloudflare Worker: `caddie-app`.
- Version: `e82cf163-14e7-4bab-9ad9-0efb268722e4`.
- Previous live version / rollback handle: `5fd61664-1188-4e7c-afdd-505c22be4349`.
- Hosted P17 receipt: `lr_e0f016f68cc3019c`; recorded `2026-10-25T19:56:03.043Z` (20:56 Africa/Lagos); 5 passed.
- Production served asset `index-DmBnBDH3.js` matched the isolated production build.

## Execution and gates

Used a separate clean release checkout, pinned to the deployed SHA on its own local `main`, with no named remotes. Only local source history was fetched into it. The other agent's checkout and build directory were not used for release compilation. Locked dependencies were installed fresh. Existing production secrets were retained; no `--with-secrets` or secret rotation ran. No source push was performed.

Executed the existing deployment pipeline with owner authorization:

```sh
CLOUDFLARE_ACCOUNT_ID=<account from env.production> \
PATH=/opt/homebrew/bin:"$PATH" bun run deploy --yes
```

The explicit supported Node path avoids the isolated shell's older Node 22.15. The explicit account selects the authored production account when Wrangler is signed in to several accounts. Neither is a release-gate bypass.

- Release-check: 51 PASS, 0 FAIL; its expected manual authorization line remains BLOCKED by design. Four unrelated live provider/OAuth/retrieval gates remain PROVISIONED, not PASS.
- Production build: passed with `CLOUDFLARE_ENV=production`; built D1 binding matched the production configuration.
- Preflight and Wrangler dry run: passed. Existing warning that some production provider keys match local keys was retained; credentials were not changed.
- Migrations applied successfully **before code**: `0044_looks_phase.sql`, `0045_notification_prefs.sql`, `0046_model_call_usage.sql`.
- Post-migration read-only check: workflow row count remained 3; migration count increased from 43 to 46. Equal counts are an aggregate check, not a full record-content equivalence proof.
- No new Durable Object migration tags relative to the recorded release baseline; tags remain v1–v4.
- Deploy, P17 hosted smoke, served-asset match and read-only switch report: passed.
- Effective switches reported: team_mode off, big_apps off, app_features off, spend_enforcement on, publish_safety on. No switch writes performed.

Two prior attempts stopped before production writes: first on fresh-install type resolution / unsupported shell Node; second on ambiguous Cloudflare account selection. The SDK mapping fix was reproduced locally, committed and included in this release. The full gate then passed with explicit runtime/account selection.

## Evidence and limits

Canonical receipt and pipeline evidence are appended to `docs/live-receipts.json` and `docs/release-evidence.md`. Per-step outputs remain under the isolated release checkout at `/private/tmp/caddie-release-9bb337c-lv2gbt3x/.deploy-logs/2026-10-25T19-52-39-002Z/`; console summary is `/tmp/caddie-release-deploy-account.log`.

No authenticated user journey, new model inference or full autonomous build was run as part of this deployment. The new reliability implementation remains the next agent's work; deployment does not establish those planned features as implemented.

Rollback changes code, not the applied database migrations. Retain the rollback handle and verify compatibility before reverting. The deployed application source SHA remains the value above even when this documentation is committed afterward.
