# Publishing setup (after G4)

This turns on the **Publish** button. Each published app gets its own address,
`<slug>.<apps-domain>`, and can be installed on a phone (Android: Chrome's menu
› Install app; iPhone: Share › Add to Home Screen).

**Status:** written from the code on 2026-10-19 and **not yet run against a real
Cloudflare account**. The publish service and both Workers are tested against a
local Cloudflare stub (SIMULATED). The stub does not check API token
permissions, so the first real publish (Smoke, step 2) is what proves the token.

**Before you start:** G4 is done (`caddie-app` is deployed and you can sign
in), and the account is on Workers Paid. Steps marked **[remote]** change your
Cloudflare account. Judge accounts can never publish, whatever is set here.

## Once

1. **Workers for Platforms:** turn it on in the dashboard (Workers & Pages ›
   Workers for Platforms). It is a paid add-on; see Cloudflare's pricing page.
2. **Apps domain:** a separate domain that you register just for apps, never a
   subdomain of Caddie's own. Each app gets a subdomain of it, so one app can
   never read Caddie's sign-in cookies.
   - Add it to the same Cloudflare account and note its **zone id** (the
     domain's Overview page).
   - **[remote] DNS:** add a proxied wildcard record so every subdomain reaches
     Cloudflare: type `AAAA`, name `*`, content `100::`, proxied. A Worker
     route alone serves nothing without a proxied record.
   - **Public Suffix List:** submit the domain at
     [publicsuffix.org](https://publicsuffix.org/submit/). Review takes weeks.
     Until it is listed, browsers treat all your apps as one site, so a page's
     own script could set a cookie that other apps receive. The dispatch Worker
     already strips `Domain=` from every cookie an app's server sets, but it
     cannot stop script-set cookies. Acceptable for the hackathon; required
     before you open publishing to the public.
3. **[remote] Dispatch namespace** (in `apps/app`):
   `bunx wrangler dispatch-namespace create caddie-apps`.
4. **[remote] Route records** (in `apps/app`):
   `bunx wrangler kv namespace create caddie-app-routes`. Note the id it prints.
5. **API token:** My Profile › API Tokens › Create Custom Token, limited to
   Caddie's account and the apps zone. What the publish adapter
   (`apps/app/src/server/adapters/cloudflare.ts`) calls, and the permission each needs:

   | Caddie does | Cloudflare API | Permission to pick |
   | :--- | :--- | :--- |
   | uploads each app and its files | `workers/dispatch/namespaces/…/scripts`, `workers/assets/upload` | Account › Workers Scripts › Edit |
   | writes the address → app records | `storage/kv/namespaces/…/values` | Account › Workers KV Storage › Edit |
   | creates and migrates each backend app's database | `d1/database`, `d1/database/…/query` | Account › D1 › Edit |
   | safety-scans each version before it goes live | `urlscanner/v2/scan`, `urlscanner/v2/result` | Account › URL Scanner › Edit |
   | owners' own domains | `zones/<apps zone>/custom_hostnames` | Zone (apps domain) › SSL and Certificates › Edit |

   The permission names were not checked against a live token builder; if one
   is named differently, pick the one that covers that API.
6. **Abuse inbox:** a mailbox you read daily, set as `ABUSE_INBOX`. New reports
   and automatic takedowns are emailed there (it needs `RESEND_API_KEY` and
   `RESEND_FROM`, already set in G4). Without it, reports are still stored and
   listed at `/operator/reports`, but nobody is told.

## Deploy the two Workers

Order matters: `caddie-app` first (G4), then the outbound Worker, then dispatch.
The dispatch Worker binds to `caddie-app`'s `PublishedAppPlatform` entrypoint
and to the outbound Worker by name.

`<CADDIE_HOST>` is Caddie's own address. While Caddie is on workers.dev
(`90c4c2a`), that is `caddie-app.<your-subdomain>.workers.dev`.

1. **Outbound Worker** (every `fetch()` a published app's server makes goes
   through the same egress policy as previews): in
   `workers/dispatch/outbound.wrangler.jsonc`, replace `<CADDIE_HOST>` and
   `<APPS_DOMAIN>`. **[remote]** From the repo root:
   `bunx wrangler deploy -c workers/dispatch/outbound.wrangler.jsonc`.
2. **Dispatch Worker** (serves every app address): in
   `workers/dispatch/wrangler.jsonc`, replace `<APPS_DOMAIN>` (the route, its
   `zone_name` and `vars`), `<DISPATCH_NAMESPACE>` (`caddie-apps`),
   `<ROUTES_KV_NAMESPACE_ID>` (step 4) and `<CADDIE_HOST>`. **[remote]**
   `bunx wrangler deploy -c workers/dispatch/wrangler.jsonc`.
3. Commit both config changes.

## Turn it on in Caddie (no rebuild)

**[remote]** `bunx wrangler secret put <NAME> --name caddie-app` for each:

| Name | Value |
| :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | the token from step 5 |
| `CLOUDFLARE_ACCOUNT_ID` | Caddie's account id |
| `CLOUDFLARE_DISPATCH_NAMESPACE` | `caddie-apps` |
| `CLOUDFLARE_ROUTES_KV_ID` | the id from step 4 |
| `CLOUDFLARE_APPS_ZONE_ID` | the apps zone id |
| `APPS_DOMAIN` | the apps domain, e.g. `caddieapps.com` |
| `ABUSE_INBOX` | step 6 |
| `WEB_RISK_API_KEY` (optional) | Google Web Risk key for the daily recheck of live apps |
| `APP_AI_MONTHLY_LIMIT_CENTS` (optional) | AI allowance per app in US cents, default 100 |

The five `CLOUDFLARE_*` values are all-or-nothing: with any one missing, the
publish panel says "Publishing isn't set up on this Caddie server yet" and
nothing is uploaded. `APP_SECRETS_KEYS` (G4) protects the keys an app asks for;
an app that needs keys cannot publish without it.

## Smoke

1. `curl -s https://check.<apps-domain>/__caddie/health` answers `{"ok":true}`,
   and `https://nothing-here.<apps-domain>/` shows "No app here".
2. Signed in as yourself, publish an app (the example app is fine). Its run
   log should show approval, database, migrations, upload, safety check, route
   and health. A failure names the step; an `UNAUTHORIZED` one means the token
   lacks a permission from step 5.
3. Open `https://<slug>.<apps-domain>/`: the app, with the small "Made with
   Caddie · Report" link. `curl -sI https://<slug>.<apps-domain>/manifest.webmanifest`
   answers 200.
4. **On a phone:** open the address and install it (Android: Chrome's menu ›
   Install app; iPhone: Share › Add to Home Screen). This is the first
   real-device test of plan step 2.4: note what you saw.
5. Unpublish it: the address now says the app isn't published right now. Publish
   again to bring it back.
6. Record the apps domain, the result of each step and the phone check in
   `docs/release-evidence.md`.

## Turning it off

- **One app:** take it down from `/operator/reports`. Its address answers 451
  with a link to Caddie, and only a review brings it back.
- **New publishes:** `bunx wrangler secret delete CLOUDFLARE_API_TOKEN --name caddie-app`.
  Apps already live keep working: the dispatch Worker reads their route records
  directly.
- **Every app at once:** remove the dispatch Worker's route in the dashboard
  (Workers › caddie-dispatch › Settings › Domains & Routes).
