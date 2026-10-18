# Publish on Cloudflare (2026-10-17)

Owner-approved scope: a Publish button for NON-TECHNICAL users, apps with a
backend from the start, Cloudflare Artifacts as the code store, logins for app
users, keys for an app's own outside services, and AI inside apps through
Caddie's Nebius models. Users never see cloud accounts, keys, IDs, git,
machine sizes or regions.

Evidence rule (AGENTS.md): every stage is built against local stand-ins and
is SIMULATED until the live stage. Live Cloudflare work is BLOCKED until the
owner supplies the account, the apps domain and a budget.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Hosting | Caddie's own Cloudflare account, Workers for Platforms (WfP): one user Worker per app in a dispatch namespace, routed by hostname | Every builder for non-technical users hosts apps itself; WfP is built for it; Caddie already runs on Workers |
| Code store | Cloudflare Artifacts, one repo per project. Writes are `git push` from Caddie's server (isomorphic-git); the sandbox never holds a credential. A D1-backed local store implements the same port for local dev | Durable history independent of sandbox image retention; import from GitHub; Cloudflare's own reference builder (vibesdk) does the same |
| App runtime | React in the browser, Hono on the server. Server routes live under `/api/*`; everything else is the client app | One rule for preview and publish routing |
| App data | One D1 database per app (live), created and migrated by Caddie's server over the REST API. Code uses the plain D1 API (`env.DB.prepare(...)`). Tests use a D1 shim over `bun:sqlite`; previews use a D1 shim over Caddie's `PreviewDatabase` Durable Object | Same API in tests, preview and production; no ORM dependency |
| Migrations | `migrations/NNNN_name.sql`, append-only. Publish applies new files in order; a statement that drops or empties data needs the existing `destructive-database-change` approval | Restoring a version restores code, never data |
| Previews | Caddie's own Worker runs the app's server bundle with Worker Loader (dynamic isolate, `globalOutbound` restricted). The browser preview stays an opaque iframe; `fetch('/api/…')` is bridged by `postMessage` to Caddie's API, like the existing storage bridge | Works locally and in production, no extra origin, generated code never touches Caddie's origin. Verified locally 2026-10-17 (wrangler 4.113): dynamic app served `/` and `/api/health`, reached an RPC stand-in database through `env`, outbound `fetch` blocked |
| Runs-on-Cloudflare check | After the sandbox checks pass, Caddie loads the server bundle in Worker Loader and requires `GET /api/health` → 200 before a build counts as verified | Catches Bun-only code without Node in the sandbox |
| Approval | Publish is a plain confirm, recorded as the existing `deploy-production` approval bound to the build's content hash | Caddie can ask; only the user publishes |
| Safety | Ships with Publish: plan/code checks, Cloudflare URL Scanner gate before going live, daily Google Web Risk recheck, strict response headers from the dispatch Worker, an outbound Worker, a per-app off switch (451 page), a Report link on every app, an abuse inbox answered within 24 hours | Builder-hosted apps are a known phishing target (Guardio 2025; live campaigns into 2026); Cloudflare suspends accounts that ignore abuse reports for 24 hours |
| Domains | Free `<slug>.<apps-domain>` at publish. "Connect my domain" via Cloudflare for SaaS custom hostnames: one CNAME for a subdomain, guided per provider, status polled. Buying domains waits for payments | 100 hostnames included, then $0.10/month each |
| App logins | Better Auth with the app's D1 and email sign-in codes. Email goes through Caddie's platform service: in previews it lands in a test inbox inside Caddie; live it uses Caddie's mailer | No email setup for the user |
| App keys | AES-GCM sealing with a Worker-secret keyring (`APP_SECRETS_KEYS`), bound to project + name. Values are never shown again, never reach the model or the sandbox, and are injected only into the preview runtime and the published Worker | Encryption at rest did not exist in Caddie yet |
| AI in apps | Apps call Caddie's platform service (`env.CADDIE`), which uses Caddie's Nebius routes with the project's budget | Users never need an AI key |

## Stages

Each stage lands as its own commit(s) with tests; UI changes come with desktop
and 390px screenshots.

1. **Code store.** Port + Artifacts adapter + local D1 store. Every save point
   (feature passed, build verified, restore, import) becomes a commit; a
   `code_versions` table links commits to images and build outputs.
   "Versions" list with Restore (restoring makes a new version and resets the
   build session from it). Builds seed the sandbox from the store when no
   image is usable. GitHub save reads from the store. "Start from my GitHub
   repo" copies a repo in (public: Artifacts import; private: server-side copy
   with the GitHub App token) after a stack check.
2. **Backend-ready stack.** Template gains `src/server.ts` (Hono, `/api/health`),
   `migrations/0001_init.sql`, a protected D1 test harness, server tests, and a
   build that emits `dist/main.js`, `dist/main.css` and `dist/server.js`
   (Workers target). Builder guidance updated. Front-end-only apps keep working.
3. **Previews.** Preview runtime (Worker Loader + `PreviewDatabase` DO +
   outbound policy), the fetch bridge in the preview iframe, the
   runs-on-Cloudflare check, "Reset test data".
4. **Publish.** Platform port + Cloudflare REST adapter (WfP scripts and
   assets, D1, custom hostnames, URL Scanner) + local stub; dispatch Worker;
   publish service (slug, D1, migrations, upload, route, health check,
   update / unpublish / roll back, operations log); Publish card.
5. **Safety.** As in the table, plus slug rules (reserved words and brand
   lookalikes), verified email to publish, per-app limits.
6. **Domains.** Connect / check / remove, provider detection, Domain Connect
   later (needs provider onboarding).
7. **App logins.** Template auth module (Better Auth + D1 + email codes),
   platform email with a preview test inbox.
8. **App keys.** Keyring + sealed `app_secrets`, "Keys" in project settings,
   the builder can request a key by name, injection into preview and publish.
9. **AI in apps.** Platform AI method on Caddie's Nebius routes with per-project
   budget and usage records; template client.
10. **Live check (BLOCKED).** Publish a small app with a database on the
    owner's account, connect a test domain, scan, test the off switch,
    unpublish.

Reserved migration numbers: 0026 code versions, 0027 app secrets, 0028 app
publishing (publications, databases, domains), 0029 abuse reports, 0030 AI
usage in apps, 0031 apps' sign-in codes and the preview test inbox.

## Status (2026-10-18, branch `feat/publish-on-cloudflare`, not pushed)

| Stage | State | Evidence |
|---|---|---|
| 1. Code store | Port, Artifacts adapter, local D1 store, versions service; every checked build is a version (verify_build); Versions list + Restore in the project card; a build whose sandbox working copy is gone continues from the newest saved version (dependencies reinstalled, lost features re-queued; no version = start again from the plan); "Start from my GitHub repo" for apps made with Caddie (stack check; the copy becomes version 1 and the first build starts from it; the copy never takes dependencies, build output or secrets). Not yet: other stacks (Vite/Lovable exports), feature-level commits (features keep their image save points), GitHub save from the store, a preview before the first build | SIMULATED (Artifacts, GitHub); LOCAL VERIFIED (local store, verify_build and working-copy restarts against the sandbox stand-in, Restore, import); the real sandbox's answer for an expired image is unverified |
| 2. Backend-ready stack | Done | LOCAL VERIFIED (`scripts/refresh-scaffold-lock.ts --check`, local Bun 1.3.14); the sandbox's own Bun is unverified |
| 3. Previews | Done: Worker Loader isolate, preview database, relay + fetch bridge, Reset test data, runs-on-Cloudflare check, egress gate | LOCAL VERIFIED under workerd (`wrangler dev`); live Worker Loader BLOCKED |
| 4. Publish | Done: Cloudflare adapter, dispatch + outbound Worker (PROPOSED configs), publish service (0028), routes, Publish card | SIMULATED (real adapter against the local Cloudflare stub; dispatch handlers under Bun); live BLOCKED |
| 5. Safety | Done: one Worker per deployment and a URL Scanner check on a private address before the public address switches (flagged = taken down + reported), daily Web Risk recheck, takedown/restore, public Report page, operator review page, abuse inbox email, confirmed email to publish, egress policy, CSP/headers/host-only cookies, Report link, 451 page, address rules, destructive-migration approval (0029) | SIMULATED (stubs for Cloudflare and Web Risk); live BLOCKED |
| 8. App keys | Done: keyring, sealed `app_secrets` (0027), routes, Keys card, builder `request_app_key`, injection into previews and published Workers | LOCAL VERIFIED |
| 9. AI in apps | Done: `env.CADDIE.ai({ messages, json? })` on Caddie's Nebius route (role `app`), monthly allowance per project with reserve/settle usage records (0030), per-minute cap, live only while published; preview capability (`AppPlatform`, props-bound), published capability through the dispatch Worker (`props.CADDIE` → `PublishedAppPlatform`, PROPOSED); template types + `createTestAi`; builder guidance; AI-provider keys refused; "AI in your app" in the card | LOCAL VERIFIED (service on real migrations, RPC plumbing under workerd, template via `refresh-scaffold-lock --check`); SIMULATED (model provider, dispatch props); live BLOCKED |
| 6, 10 | Not started (10 is BLOCKED) | — |
| 7. App logins | Done: template `caddie/auth.ts` (Better Auth 1.7.10 on the app's D1, 6-digit email codes, 30-day sessions; `mountSignIn` / `requireUser`), `<SignIn />` / `useUser()`, `migrations/0000_caddie_auth.sql`, test helpers; codes through `env.CADDIE.signInCode` (preview test inbox in the card; live fixed-text email via Caddie's mailer, published apps only; capped per person and per app, 0031); per-app cookie secret derived from Caddie's secret | LOCAL VERIFIED (scaffold check under Bun with 1.7.10; workerd run of the template's sign-in with Caddie's installed copy, also 1.7.10 since Caddie's own login moved to it); live email BLOCKED |

## Owner inputs (BLOCKED until provided)

- Cloudflare account on Workers Paid with Workers for Platforms ($25/month)
  and Artifacts (open beta, Workers Paid only).
- A registrable domain for user apps, kept separate from Caddie's own domain,
  registered for 2+ years (Public Suffix List requirement).
- An API token scoped to WfP scripts, D1, custom hostnames, URL Scanner and
  Artifacts; a Worker secret keyring for app keys.
- A monitored abuse inbox.
- Explicit go-ahead and budget for the live check.

## Research summary (2026-10-17)

- Builders for non-technical users host apps themselves with one-click
  publish: Lovable (`name.lovable.app`, built-in backend and AI, optional
  two-way GitHub sync: "You don't need GitHub to use Lovable"), Bolt, Replit,
  Base44. v0 publishes to Vercel.
- Nebius: no OAuth-style consent for outside apps (service accounts and keys
  only); Serverless AI endpoints are VMs billed per second while running, no
  scale-to-zero found. Unsuitable for per-app hosting.
- [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/):
  $25/month, 20M requests, 60M CPU-ms, 1,000 scripts included, +$0.02/script.
  Static assets, custom limits, outbound Workers, tags. Dispatch namespaces are
  not emulated locally (`remote: true` only).
- [Artifacts](https://developers.cloudflare.com/artifacts/): open beta since
  2026-10-01, Workers Paid only, no SLA; unlimited repos, 1 GB/repo, 32 MB/file;
  $0.15 per 1,000 operations after 10,000/month, $0.50/GB-month after 1 GB.
  The binding manages repos and reads; writes need git push. `import()` takes
  public HTTPS remotes only. Local dev uses the remote service only.
- D1: 50,000 databases per account (raisable), 10 GB each, 30-day Time Travel,
  REST create / delete / query.
- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/): Worker
  Loader in open beta for paid Workers users.
- [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/):
  100 custom hostnames included, $0.10 each after, 50,000 max; apex proxying is
  Enterprise only. Domain Connect (GoDaddy, IONOS, Cloudflare) and Entri can
  remove DNS steps. Cloudflare's Registrar API (beta) registers to the
  platform's own account and contact.
- Abuse: [Cloudflare abuse obligations](https://developers.cloudflare.com/fundamentals/reference/report-abuse/abuse-report-obligations)
  (respond within 24 hours or risk suspension). URL Scanner returns a
  malicious verdict with a phishing check; Web Risk Lookup free to 100k/month,
  then $0.50 per 1,000; Guardio sells to AI platforms on quote; Public Suffix
  List private section needs 2+ years of registration, no SLA.

## Open questions

- Artifacts private import (no credentials parameter) — server-side copy is the
  plan; confirm against the live service.
- Whether WfP service bindings carry `props` (app identity) — Cloudflare's
  dynamic-dispatch docs (2026-09) describe `DISPATCHER.get(name, { props })`
  and passing a `ctx.exports` capability in props; built that way, unverified
  until the live check.
- URL Scanner limits and price for our use.
- How long sandbox images are retained (the code store makes this matter less).
