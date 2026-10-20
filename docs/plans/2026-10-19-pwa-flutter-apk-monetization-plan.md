# Caddie Forge — PWA, Full-Stack Flutter (.apk) Builder & Monetization Plan

**Date:** 2026-10-19  
**Status:** APPROVED ROADMAP (Tracks 2, 3, and 4)  
**Repository:** `/Users/captjay98/projects/caddie-forge`

> **For the implementing agent:**  
> Follow `AGENTS.md` and `docs/flue-contracts.md` strictly. Keep evidence classifications exact (`LOCAL VERIFIED`, `LIVE VERIFIED`, `SIMULATED`, `DOCUMENTATION ONLY`, `BLOCKED`, `FAILED`). Do not enable any paywall on the hackathon judge path (`isJudgeAccount` users are always governed by `judge-limits.ts` and never hit billing walls during the Dec 1–15 judging window).

---

## Track 2: Turn `/app` (and Generated Web Apps) into a Proper PWA

### Goal
Make Caddie's `/app` workspace a native-feeling, installable Progressive Web App on iOS and Android (with OS Share Target support and safe asset caching), and make every `react-hono` app published by a user installable as a PWA out of the box.

### Step 2.1 — Web App Manifest (`/app/manifest.webmanifest`)
Create `apps/app/public/manifest.webmanifest` (ensuring `scripts/compose-assets.ts` places it at `/app/manifest.webmanifest` in the composed Worker assets tree):

- **Identity & Launch:**
  - `id`: `"/app/"`
  - `name`: `"Caddie"`
  - `short_name`: `"Caddie"`
  - `description`: `"Find hackathons, plan with cited rules, build in a sandbox, and ship working apps."`
  - `start_url`: `"/app/?pane=channel"`
  - `scope`: `"/app/"`
  - `display`: `"standalone"`
  - `orientation`: `"portrait-primary"`
  - `background_color`: `"#090b10"`
  - `theme_color`: `"#090b10"`
- **Icons:**
  - Generate and include `icon-192.png` (`192x192`), `icon-512.png` (`512x512`), `icon-maskable-512.png` (`512x512`, `"purpose": "maskable"`), and `apple-touch-icon.png` (`180x180`) from the Caddie mascot SVG.
- **Shortcuts:**
  - `"Ask Caddie"` → `"/app/?pane=channel"`
  - `"Brief"` → `"/app/?pane=brief"`
  - `"Discover"` → `"/app/discover"`
  - `"Projects"` → `"/app/projects"`
- **OS Share Target (`share_target`):**
  - Allow mobile users to share any hackathon URL from their mobile browser or X/Twitter directly into Caddie:
    - `action`: `"/app/"`
    - `method`: `"GET"`
    - `params`: `{ "title": "shared_title", "text": "shared_text", "url": "shared_url" }`
  - In `apps/app/src/client/workspace/Shell.tsx` (or `Composer.tsx`), when `shared_url` or `shared_text` is present in the URL query string on load, pre-fill the composer draft with the shared hackathon URL and strip the query params via `history.replaceState` so the user can send it with one tap.

### Step 2.2 — Standalone Viewport, Safe Areas & Dynamic `theme-color`
1. **`apps/app/index.html`:**
   - Update the viewport meta tag to `width=device-width, initial-scale=1, viewport-fit=cover`.
   - Add `<meta name="theme-color" content="#090b10" />`.
   - Add `<meta name="mobile-web-app-capable" content="yes" />` and `<meta name="apple-mobile-web-app-capable" content="yes" />`.
   - Add `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`.
   - Add `<link rel="manifest" href="/app/manifest.webmanifest" />` and `<link rel="apple-touch-icon" href="/app/apple-touch-icon.png" />`.
2. **`apps/app/src/client/theme.ts` & `apps/app/index.html`:**
   - When `applyTheme(mode, palette)` runs (and in the inline pre-paint script), update `<meta name="theme-color">` to match the active canvas color (`#090b10` in dark mode, `#f6f5f0` in light mode) so the mobile status bar blends into the app.
3. **`apps/app/src/client/workspace.css`:**
   - Add `padding-top: env(safe-area-inset-top)` to the mobile top bar / floating header so the iPhone notch / Dynamic Island never overlaps controls in standalone PWA mode.

### Step 2.3 — Strict, Honesty-Safe Service Worker (`/app/sw.js`)
Create `apps/app/public/sw.js` and register it from `apps/app/src/client/main.tsx` (in production builds only):
- **Never cache `/api/*` or `/agents/*`:** All API calls, auth checks, and Flue agent streams must go straight to the network so the PWA never serves stale D1 state or fake offline replies.
- **Cache-First for hashed immutable assets:** Cache `/app/assets/*` and `.woff2` font files so cold launches on mobile take <150ms.
- **Network-First for `/app/*` navigation:** Fall back to the cached `/app/index.html` shell when the device is offline so the app renders its designed `StatePanel` (`offline` mood mascot in `states.tsx`) instead of a raw browser error page.

### Step 2.4 — Default PWA Support for Generated `react-hono` User Apps
In `stacks/react-hono/scaffold.ts`:
- Include `viewport-fit=cover` and `<meta name="mobile-web-app-capable" content="yes" />` in the template `index.html` (and `previewDocument` in `build-sandbox.ts`) so every web app published by a user on `<slug>.<apps-domain>` can also be added to a phone's Home Screen as a standalone web app.
- Run `bun scripts/refresh-scaffold-lock.ts` and verify with `--check`.

### Step 2.5 — Verification for Track 2
- Add `tests/pwa.test.ts` and a Playwright check verifying `/app/manifest.webmanifest` returns HTTP 200 with valid JSON, icons resolve, `viewport-fit=cover` is present, and `?shared_url=` pre-fills the composer draft without auto-sending.

---

## Track 3: Full-Stack Flutter + Downloadable `.apk` Builder (`stacks/flutter`)

### Goal
Enable Caddie to build, test, preview, and export real Android `.apk` applications paired with the proven Cloudflare Hono + D1 + `env.CADDIE.ai` + `caddie/auth.ts` backend, including a one-tap **"Install on this phone (.apk)"** button when viewed on Android and a **QR code** when viewed on desktop/iOS.

### Step 3.1 — Pre-Warmed Contree Sandbox Image (`tag:tt-flutter:1`)
1. Provision a Contree sandbox image (`CONTREE_FLUTTER_IMAGE`, default `'tag:tt-flutter:1'`) built on top of `tag:tt-base:1`:
   - Install Flutter 3.x stable, OpenJDK 17, and Android SDK (`platform-tools`, `platforms;android-35`, `build-tools;35.0.0`).
   - Pre-warm `~/.pub-cache` and `~/.gradle` by running `flutter pub get`, `flutter test`, `flutter build web`, and `flutter build apk --debug` once on `stacks/flutter/template` before snapshotting the image as `tag:tt-flutter:1`.
2. Add `CONTREE_FLUTTER_IMAGE?: string` to `BuildSandboxEnv` (`apps/app/src/server/build-sandbox.ts`) and `CoordinatorEnvironment` (`apps/app/src/server/coordinator-host.ts`).

### Step 3.2 — Full-Stack Hybrid Flutter Scaffold (`stacks/flutter/scaffold.ts`)
Create `stacks/flutter/scaffold.ts` (mirroring `stacks/react-hono/scaffold.ts`) so every `flutter` project workspace (`/workspace/<projectId>`) contains both the Flutter mobile client and the Cloudflare Hono + D1 backend:
- **Flutter client files:**
  - `pubspec.yaml` (Flutter SDK + `http`),
  - `analysis_options.yaml`,
  - `lib/main.dart` (reads `const String kApiBase = String.fromEnvironment('CADDIE_API_BASE', defaultValue: '');` so relative `/api/...` calls work in the web preview and full `https://<slug>.<apps-domain>/api/...` URLs work inside the compiled Android `.apk`),
  - `test/widget_test.dart` (injectable `http.Client` widget test harness).
- **Cloudflare Hono + D1 backend files (shared with `react-hono`):**
  - `src/server.ts` (`GET /api/health` + D1 routes),
  - `migrations/0001_init.sql` and `migrations/0000_caddie_auth.sql`,
  - `caddie/platform.ts`, `caddie/ai.ts`, `caddie/auth.ts`,
  - `test/setup/d1.ts`, `test/setup/caddie.ts`, `test/setup/ai.ts`, `test/setup/auth.ts`,
  - `test/examples/server.example.test.ts`.
- **Protected paths (`apps/app/src/agents/permissions.ts`):**
  - Keep `caddie/`, `test/setup/`, `test/examples/`, and `analysis_options.yaml` protected from agent edits.

### Step 3.3 — Stack-Aware Host Feature Loop (`coordinator-host.ts` & `build-timeline.ts`)
1. **Parse Flutter Test Counts (`apps/app/src/server/build-timeline.ts`):**
   - Extend `parseTestCounts(output: string)` to parse `flutter test` output (e.g., `+4: All tests passed!` or `+3 -1: Some tests failed.`) in addition to `bun test`'s `N pass` / `N fail` output, summing Dart widget tests and Bun server tests so `finish_feature` enforces the exact same `passing > baseline` progression gate.
   - Extend `isShellTestCommand` (`apps/app/src/agents/permissions.ts`) to also block raw `flutter test` shell invocations so specialists must use `run_checks`.
2. **Stack-Aware `runHostChecks` (`apps/app/src/server/coordinator-host.ts`):**
   - Look up `run.stackId` (`'react-hono'` or `'flutter'`).
   - When `run.stackId === 'flutter'`:
     - Boot the sandbox session from `env.CONTREE_FLUTTER_IMAGE ?? 'tag:tt-flutter:1'`.
     - `dependencies`: run `runVerifiedInstall` (for the Hono server packages) + `flutter pub get --offline` (falling back to `flutter pub get`).
     - `behavior-tests`: run `flutter test` + `bun test src/`.
     - `browser-bundle` (during `run_checks` / `finish_feature`): run `flutter build web --release` + build `dist/server.js`.
     - On `verify_build` (after all features pass and `checkServerStarts` passes on `dist/server.js` in `Worker Loader`):
       1. Build the **in-browser preview** from `build/web/` so `InteractivePreview.tsx` renders the Flutter app immediately inside a phone bezel, connected to the project's `Worker Loader` + `PreviewDatabase` D1 isolate.
       2. Build the **Android `.apk`** via `flutter build apk --release --dart-define=CADDIE_API_BASE=<published-or-preview-url>`.
       3. Read `build/app/outputs/flutter-apk/app-release.apk` from the sandbox, verify it starts with ZIP magic bytes (`PK\x03\x04`) and is `> 1 MB`, compute its `sha256` and byte size, and store the `.apk` binary in the content store linked to `workflow_outputs`.

### Step 3.4 — `.apk` Download Endpoint, Android One-Tap Install & Desktop QR Code
1. **Database & Storage (`workflow_outputs` migration):**
   - Add nullable `apkHash TEXT` and `apkBytes INTEGER` columns to `workflow_outputs` (append-only migration).
2. **Download Route (`GET /api/projects/:projectId/apk` in `apps/app/src/server/routes/build-workflow.ts`):**
   - Verify project scope (or valid preview token so a user scanning the QR code on their phone can download their own `.apk` via a short-lived signed download token `?token=...`).
   - Stream the `.apk` bytes with:
     - `Content-Type: application/vnd.android.package-archive`
     - `Content-Disposition: attachment; filename="<project-slug>-v<seq>.apk"`
     - `X-Content-Type-Options: nosniff`
3. **Device-Aware Project Card UI (`apps/app/src/client/conversation/ProjectWorkflow.tsx` & `NowPanel.tsx`):**
   - When the current build output has an `.apk` (`apkBytes > 0`):
     - **On Android (`/\bAndroid\b/i.test(navigator.userAgent)`):** Show a primary button **`Install on this phone (.apk)`** that downloads `/api/projects/:id/apk` and triggers Android's native Package Installer sheet.
     - **On Desktop / iOS:** Show **`Download Android .apk (<size> MB)`** plus a toggleable **"Scan to install on Android"** panel rendering a pure-SVG QR code of the signed `.apk` download URL.
   - When the user later clicks **Publish** to put their backend live at `https://<slug>.<apps-domain>`, pass `CADDIE_API_BASE=https://<slug>.<apps-domain>` so the `.apk` talks to the live published Cloudflare D1 + `env.CADDIE.ai` backend.

---

## Track 4: Monetization & The `$9 Hackathon Pass` (Deadline-Aware)

### Goal
Implement Caddie's hybrid monetization system targeting both **hackathon builders** (`$9 Hackathon Pass` bound to a contest's real deadline + 60-day judging hosting) and **solo founders** (`$19/mo Builder Pro` & `$49/mo Founder`), while keeping billing **off (`BILLING_ENABLED=0`)** for hackathon judges during Dec 1–15.

### Step 4.1 — Pricing & Entitlement Tiers (`packages/contracts/src/billing.ts`)
Define the four product tiers:

1. **`free` ($0):**
   - Unlimited hackathon discovery & rules reading.
   - 1 active project (PRD + Design Mocks + 1 sandbox build in preview mode).
   - No live app publishing or `.apk` export.
2. **`hackathon_pass` ($9 one-time per hackathon project):**
   - Bound to **one specific project** (`projectId`) and its linked hackathon (`candidateId` or contest URL).
   - **Automatic Deadline Resolution:**
     - Reads the project's pinned `deadline.submission` claim (`apps/app/src/server/evidence/deadlines.ts`).
     - If no deadline is pinned yet when the user selects a contest URL, triggers `tavilyExtract` + `rules-reading.ts` to extract the deadline.
     - Sets `buildWindowEndsAt = clamp(submissionDeadline + 72 hours, now + 14 days, now + 60 days)`.
     - Sets `hostingEndsAt = buildWindowEndsAt + 60 days` (so the published web app, D1 database, `env.CADDIE.ai`, and `.apk` backend stay live throughout the entire contest judging period).
   - **Included Project Quotas:**
     - Up to **10 full sandbox builds** (Web PWA or Flutter `.apk`) for that project.
     - 1 live published app (`<slug>.<apps-domain>`) + `$2.00` in-app AI allowance (`env.CADDIE.ai`).
     - Daily **Sentinel** rule-change monitoring + **Judge** rubric scorecard coaching.
3. **`pro` ($19 / month — Builder Pro):**
   - **15 full sandbox builds / month** across any projects (Web PWA or Flutter `.apk`).
   - **3 live published apps** + `$3.00 / month` in-app AI allowance.
   - Unlimited Sentinel monitoring, Judge coaching, and GitHub PR sync.
4. **`launch` ($49 / month — Founder / Scale):**
   - **40 full sandbox builds / month** + priority model routing.
   - **10 live published apps** + custom domain support + `$10.00 / month` in-app AI allowance.

### Step 4.2 — Database Schema & Entitlement Gate (`apps/app/src/server/entitlements.ts`)
1. Append-only migration `account_entitlements` and `project_passes`:
   - `account_entitlements`: `userId`, `tier` (`'free' | 'pro' | 'launch'`), `providerCustomerId`, `providerSubscriptionId`, `currentPeriodEnd`, `buildsUsedThisPeriod`, `updatedAt`.
   - `project_passes`: `id`, `projectId`, `userId`, `contestUrl`, `submissionDeadline`, `buildWindowEndsAt`, `hostingEndsAt`, `buildsAllowed` (default 10), `buildsUsed`, `createdAt`.
2. **Enforcement Rules (`apps/app/src/server/entitlements.ts`):**
   - **Rule 1 (Hackathon Judges Exempt):** If `await isJudgeAccount(db, userId)` is true, or `env.BILLING_ENABLED !== '1'`, skip all billing checks (`judge-limits.ts` governs judges; local/dev and the Dec 1–15 judging demo never hit a paywall).
   - **Rule 2 (Project Pass vs. Account Subscription):** When starting a build (`decideDesign` / `retryWorkflow`), publishing an app (`publishApp`), or downloading an `.apk`, allow if **either** the project has an active `project_passes` row (`now < buildWindowEndsAt` and `buildsUsed < buildsAllowed`) **or** the user's `account_entitlements` tier (`pro` / `launch`) has remaining monthly builds.
   - **Rule 3 (Post-Deadline Judging Hosting):** Cron sweep checks `hostingEndsAt` on `project_passes`; a Hackathon Pass app stays live for the full 60-day judging window after `buildWindowEndsAt`, then pauses cleanly (keeping all D1 data and code versions intact so the user can upgrade to `pro` anytime without losing data).

### Step 4.3 — Checkout & Webhook Adapter (`apps/app/src/server/routes/billing.ts`)
- Add a clean `BillingProvider` port supporting **Stripe** (and/or **Paystack / LemonSqueezy**):
  - `POST /api/billing/checkout` (creates a checkout session for either a `$9 Hackathon Pass` on `projectId` or a `$19 Pro` / `$49 Launch` subscription).
  - `POST /api/billing/webhook` (verifies the provider HMAC signature, records the external operation receipt idempotently, and activates the `project_passes` or `account_entitlements` row).
- Surface the user's current plan, active Hackathon Passes (with their resolved submission deadline and 60-day judging hosting expiry date), and remaining build count in **Settings › Spending**.
