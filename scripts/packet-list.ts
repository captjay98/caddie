#!/usr/bin/env bun
/**
 * The packet table (S01) — the ONE place a test file is assigned to a packet.
 *
 * `verify-packet.ts`, `release-check.ts` and CI all read this module, so a test
 * file can no longer be silently left out of every packet: an unassigned file
 * never runs, and `tests/packet-completeness.test.ts` (packet NET) fails until
 * it is assigned. No literal packet list may live anywhere else.
 *
 * Categories:
 *   tests   — bun-test-runner unit/integration/workerd specs (`bun test <file>`)
 *   browser — Playwright specs (`bunx playwright test <file>`), composed build
 *   live    — bun-test-runner specs gated on CADDIE_LIVE_AUTHORIZED=1
 *
 * A file MAY appear in more than one packet: a few specs are the evidence for
 * two different packets (for example `tests/browser/workspace.spec.ts` covers
 * both P06 and U01, and `tests/p15bcd-local.test.ts` is the local half of
 * P15b, P15c and P15d). Completeness is "in at least one packet", not "exactly
 * one" — deduplicating those mappings would silently drop coverage.
 */

export type PacketCategory = 'tests' | 'browser' | 'live';

export const PACKET_MAP: Record<string, Record<PacketCategory, string[]>> = {
	P00: {
		tests: ['tests/contracts.test.ts', 'tests/routing.test.ts'],
		browser: [],
		live: [],
	},
	P01: {
		tests: ['tests/auth.integration.test.ts'],
		browser: ['tests/browser/auth.spec.ts'],
		live: [],
	},
	P02: {
		tests: ['tests/project-isolation.integration.test.ts'],
		browser: [],
		live: [],
	},
	P03: {
		tests: ['tests/controls.integration.test.ts', 'tests/budget-races.integration.test.ts'],
		browser: [],
		live: [],
	},
	P04: {
		tests: ['tests/sandbox.contract.test.ts'],
		browser: [],
		live: ['tests/live/sandbox.spec.ts'],
	},
	P05: {
		tests: [
			'tests/agent-permissions.test.ts',
			'tests/ai-behavior.test.ts',
			'tests/coordinator-followups.test.ts',
			'tests/home-chat-tools.test.ts',
			'tests/providers.test.ts',
		],
		browser: [],
		live: ['tests/live/flue-lifecycle.spec.ts', 'tests/live/hackathon-followup-routing.spec.ts'],
	},
	P06: {
		tests: ['tests/send-failure.test.ts'],
		browser: ['tests/browser/workspace.spec.ts', 'tests/browser/conversation.spec.ts'],
		live: [],
	},
	P07: {
		tests: ['tests/preview-access.integration.test.ts'],
		browser: ['tests/browser/artifacts.spec.ts'],
		live: ['tests/live/preview.spec.ts'],
	},
	P08: {
		// `tests/live/github.spec.ts` is NOT mapped: a real one needs a
		// registered GitHub App (owner-gated). It is named in
		// docs/release-evidence.md as an intentional hole, so nothing here
		// pretends to be live-verifiable.
		tests: ['tests/github.integration.test.ts', 'tests/github-repos.integration.test.ts', 'tests/github-connect.test.ts', 'tests/github-return.test.ts'],
		browser: [],
		live: [],
	},
	P09: {
		tests: ['tests/p09-local.test.ts'],
		browser: ['tests/browser/forge-journey.spec.ts'],
		live: ['tests/live/forge-react-hono.spec.ts'],
	},
	P10: {
		tests: ['tests/evidence.test.ts', 'tests/evidence.integration.test.ts'],
		browser: [],
		live: [],
	},
	P11: {
		tests: [
			'tests/discovery.test.ts',
			'tests/discovery-prizes.test.ts',
			'tests/detail-facts.test.ts',
			'tests/generated-app-policy.test.ts',
			'tests/planning.integration.test.ts',
			'tests/candidate-digest.test.ts',
			'tests/candidate-inspection.test.ts',
			'tests/coordinator-context.test.ts',
			'tests/devpost-source.test.ts',
			'tests/discover-quality.test.ts',
			'tests/discovery-sanitize.test.ts',
			'tests/hackathon-card-builder.test.ts',
			'tests/hackathon-card.test.ts',
			'tests/research.test.ts',
			'tests/rules-reading.test.ts',
			'tests/tavily-discovery-adapter.test.ts',
			'tests/tavily.test.ts',
		],
		browser: ['tests/browser/discovery.spec.ts'],
		live: [],
	},
	P12: {
		tests: ['tests/schedules.integration.test.ts', 'tests/sentinel.test.ts'],
		browser: [],
		live: ['tests/live/notifications.spec.ts'],
	},
	P13: {
		tests: ['tests/judge.test.ts', 'tests/submission.test.ts'],
		browser: ['tests/browser/submission.spec.ts'],
		live: [],
	},
	P14: {
		tests: [
			'tests/memory.integration.test.ts',
			'tests/memory-learns.test.ts',
			'tests/stated-preference.test.ts',
			'tests/search-isolation.test.ts',
			'tests/capture-tools.test.ts',
			'tests/interest-picker.test.ts',
			'tests/onboarding.test.ts',
			'tests/profile-enrichment.test.ts',
			'tests/profile-preferences.test.ts',
		],
		browser: ['tests/browser/settings.spec.ts', 'tests/browser/onboarding-profile.spec.ts'],
		live: [],
	},
	P15a: {
		tests: ['tests/p15a-local.test.ts'],
		browser: [],
		live: ['tests/live/stacks/tanstack-start.spec.ts'],
	},
	P15b: {
		// One local file covers the local half of all three toolchain stacks.
		tests: ['tests/p15bcd-local.test.ts'],
		browser: [],
		live: ['tests/live/stacks/laravel-inertia.spec.ts'],
	},
	P15c: {
		tests: ['tests/p15bcd-local.test.ts'],
		browser: [],
		live: ['tests/live/stacks/fastapi-react.spec.ts'],
	},
	P15d: {
		tests: ['tests/p15bcd-local.test.ts'],
		browser: [],
		live: ['tests/live/stacks/flutter.spec.ts'],
	},
	P16: {
		tests: [],
		browser: ['tests/browser/landing.spec.ts'],
		live: [],
	},
	P17: {
		// The one-command deploy orchestrator (roadmap item 1) is driven by a
		// fake runner — no remote call — and proves the deploy safety contract.
		tests: ['tests/deploy-preflight.test.ts', 'tests/live-receipts.test.ts', 'tests/deploy-script.test.ts'],
		browser: ['tests/browser/release.spec.ts'],
		live: ['tests/live/release.spec.ts'],
	},
	// --- Caddie v2 redesign (docs/design/2026-10-10-v2/PACKETS.md) -------------
	U01: {
		tests: ['tests/theme-picker.test.ts', 'tests/theme-state.test.ts', 'tests/theme-tokens.test.ts'],
		browser: ['tests/browser/workspace.spec.ts', 'tests/browser/shell-v2.spec.ts', 'tests/browser/theme-picker.spec.ts'],
		live: [],
	},
	U02: {
		tests: ['tests/image-attachments.test.ts', 'tests/multimodal-contract.test.ts', 'tests/voice-input.test.ts'],
		browser: ['tests/browser/conversation.spec.ts', 'tests/browser/shell-v2.spec.ts'],
		live: [],
	},
	U03: {
		tests: ['tests/project-header.test.ts', 'tests/project-steps.test.ts'],
		browser: ['tests/browser/shell-v2.spec.ts', 'tests/browser/states.spec.ts'],
		live: [],
	},
	U04: {
		tests: ['tests/attachments.test.ts', 'tests/brief-lifecycle.test.ts', 'tests/brief.test.ts', 'tests/decision-card-status.test.ts',
			// Packet of the 2026-10-20 UI foundation: the shared workflow query
			// every workflow card/phase/brief view now reads through.
			'tests/workflow-query.test.ts', 'tests/card-design.test.ts'],
		browser: ['tests/browser/brief.spec.ts', 'tests/browser/conversation.spec.ts'],
		live: [],
	},
	U05: {
		tests: ['tests/project-card.test.ts', 'tests/project-proposals.test.ts'],
		browser: ['tests/browser/focused-project-chat.spec.ts', 'tests/browser/discovery.spec.ts', 'tests/browser/discovery-journey.spec.ts', 'tests/browser/projects-v2.spec.ts', 'tests/browser/project-proposal.spec.ts'],
		live: [],
	},
	U06: {
		tests: [
			'tests/join-progress.test.ts',
			'tests/now-panel.test.ts',
			'tests/project-experience-route.test.ts',
			'tests/project-experience.test.ts',
			'tests/project-hackathon.test.ts',
			'tests/project-status.test.ts',
			'tests/overview-app.test.ts',
		],
		browser: ['tests/browser/artifacts.spec.ts', 'tests/browser/project-v2.spec.ts'],
		live: [],
	},
	U07: {
		tests: [],
		browser: ['tests/browser/submission.spec.ts', 'tests/browser/check-v2.spec.ts'],
		live: [],
	},
	U08: {
		tests: ['tests/cron-words.test.ts', 'tests/settings-model.test.ts'],
		browser: ['tests/browser/settings.spec.ts', 'tests/browser/project-settings.spec.ts'],
		live: [],
	},
	U09: {
		tests: [],
		browser: ['tests/browser/auth.spec.ts', 'tests/browser/search.spec.ts', 'tests/browser/onboarding-v2.spec.ts'],
		live: [],
	},
	U10: {
		tests: [],
		browser: ['tests/browser/landing.spec.ts'],
		live: [],
	},
	B01: { tests: ['tests/discovery-saved.integration.test.ts'], browser: [], live: [] },
	B02: { tests: ['tests/search-isolation.test.ts'], browser: [], live: [] },
	B03: { tests: ['tests/stack-notify.integration.test.ts'], browser: [], live: [] },
	B04: { tests: ['tests/plan-decisions.integration.test.ts'], browser: [], live: [] },
	B05: { tests: ['tests/conversation-scope.test.ts', 'tests/answer-parts.test.ts'], browser: ['tests/browser/conversation.spec.ts'], live: [] },
	B06: { tests: ['tests/approval-card.test.ts'], browser: [], live: [] },
	// --- App surface waves (0028–0032): publish, keys, versions, apps in-app --
	PUBLISH: {
		tests: [
			'tests/publish.test.ts',
			'tests/dispatch-worker.test.ts',
			'tests/published-entry.test.ts',
			'tests/cloudflare-app-host.contract.test.ts',
			'tests/outbound-policy.test.ts',
			'tests/web-risk.test.ts',
			'tests/report-page.test.ts',
			'tests/operator.test.ts',
			'tests/published-page.test.ts',
			'tests/app-icons.test.ts',
		],
		browser: ['tests/browser/app-install.spec.ts'],
		live: [],
	},
	KEYS: {
		tests: ['tests/secret-box.test.ts', 'tests/app-secrets.test.ts', 'tests/app-keys-routes.test.ts'],
		browser: [],
		live: [],
	},
	VERSIONS: {
		tests: [
			'tests/code-versions.test.ts',
			'tests/code-store-artifacts.test.ts',
			'tests/versions.test.ts',
			'tests/repo-start.test.ts',
			'tests/import-preview.test.ts',
			'tests/github-source.test.ts',
			'tests/source-export.test.ts',
		],
		browser: [],
		live: [],
	},
	APPS: {
		tests: [
			'tests/app-ai.test.ts',
			'tests/app-sign-in.test.ts',
			'tests/preview-runtime.test.ts',
			'tests/preview-runtime.integration.test.ts',
		],
		browser: ['tests/browser/interactive-preview.spec.ts'],
		live: [],
	},
	BUILD: {
		tests: [
			'tests/build-workflow.test.ts',
			'tests/demo-contract.test.ts',
			'tests/build-activity.test.ts',
			'tests/build-timeline.test.ts',
			'tests/sandbox-durability.test.ts',
			'tests/single-recipe.test.ts',
			'tests/plan-features.test.ts',
			'tests/workflow-dispatch.test.ts',
			'tests/stopped-turn.test.ts',
			// Owner review item 3: the one install step every install path uses.
			'tests/verified-install.test.ts',
			// Found 2026-10-19: no stored build file may exceed D1's 2 MB value limit.
			'tests/content-store-limit.test.ts',
		],
		browser: ['tests/browser/project-workflow.spec.ts'],
		live: [],
	},
	// --- Submission build (docs/plans/2026-10-18-submission-build-plan.md) ----
	// S06 judge access: the access-code way in for hackathon judges (0033).
	// Deliberately NOT P13, which is Caddie's own judge-*scorecard* surface for
	// a project's submission — the two share a word and nothing else. The
	// end-to-end half (a real cookie from a real worker) lands in
	// `tests/auth.integration.test.ts`, so it runs under P01 as well.
	JUDGE_ACCESS: { tests: ['tests/judge-access.test.ts', 'tests/judge-example.test.ts'], browser: ['tests/browser/judge-access.spec.ts'], live: [] },
	// S07 judge limits (D4): 3 projects, 3 build starts, 300 Caddie messages and
	// 20 live discovery lookups per rolling 24 hours, for judge accounts only
	// (0034; 0035 adds the discovery kind). Each quota is also settable to 0,
	// which means none.
	JUDGE_LIMITS: { tests: ['tests/judge-limits.test.ts'], browser: [], live: [] },
	// --- Installable app (docs/plans/2026-10-19-pwa-flutter-apk-monetization-plan.md, Track 2)
	// Manifest, icons, share target, service worker, safe areas. Real devices
	// (an Android or iOS install) are not reachable from here.
	PWA: { tests: ['tests/pwa.test.ts'], browser: ['tests/browser/pwa.spec.ts'], live: [] },
	// --- Flutter apps + Android APK (same plan, Track 3) ---------------------
	// The scaffold's real behaviour needs a Flutter SDK, so it is proven by
	// `bun scripts/refresh-flutter-scaffold-lock.ts --check` (local) and the
	// sandbox runs; these unit tests pin what can be checked without one.
	FLUTTER: { tests: ['tests/flutter-scaffold.test.ts', 'tests/flutter-apps-switch.test.ts', 'tests/flutter-build-loop.test.ts', 'tests/flutter-preview.test.ts', 'tests/large-content.test.ts', 'tests/android-app.test.ts'], browser: [], live: [] },
	// --- Software-team mode (docs/plans/2026-10-22-software-team-mode.md) ----
	// Foundations (switches, migration 0040), part B's block, rules and
	// generated schema, the S4 restart spike and the campaign runner (offline).
	// Each lane adds its tests here when the lead merges it.
	TEAM_MODE: {
		tests: [
			'tests/team-mode-migration.test.ts',
			'tests/team-mode-foundations.test.ts',
			'tests/architecture-block.test.ts',
			'tests/architecture-review.test.ts',
			'tests/architecture-summary.test.ts',
			'tests/architecture-gate-binding.test.ts',
			'tests/team-mode-prompts.test.ts',
			'tests/contract-restart-spike.test.ts',
			'tests/brief-run.test.ts',
			// Lane 5 (parts D + F): part boundaries, the start/finish/restore
			// steps and the S2 spike; the Try-again-from-save-point handler; the
			// real snapshot ports over the driver; the Try-again card button.
			'tests/part-boundaries.test.ts',
			'tests/try-again.test.ts',
			// Lane 7 (part H): the submission texts match the code and records.
			'tests/submission-texts.test.ts',
			// Part E (contract checks) + part G (publish safety), lane 4.
			'tests/publish-safety.test.ts',
			'tests/host-checks-contract.test.ts',
			'tests/contract-checks.test.ts',
			// Part A (spending limit), lane 3: the S1 spike, the money logic and
			// the instrument wiring.
			'tests/spend-instrument-spike.test.ts',
			'tests/build-spend.test.ts',
			'tests/spend-instrument.test.ts',
			// Lane 5 follow-up: the real snapshot reads and the Try-again card.
			'tests/part-snapshot.test.ts',
			'tests/try-again-card.test.ts',
			// Lane tm/wiring: coordinator-host connects the merged pieces — the
			// part boundary over the real driver, the contract-check repair
			// round, and the per-output publish receipt gating.
			'tests/team-mode-wiring.test.ts',
			// Lane 14 (part U): the Brief cards — the deadline countdown, the
			// plan approval list, the opportunity fit split and the ready card's
			// preview checks, each field filled from a real record or absent.
			'tests/brief.test.ts',
			// Lane 14 redo: each card's fields from real records (build feed,
			// repair body + expectation, deadline, fit, footers).
			'tests/brief-card-redo.test.ts',
			// Lane 12 (part P): the ModuleBuilder agent + parallel-module
			// orchestration — the D12 slot caps, dependency order, at-least-once
			// harmlessness, module feature scope, a stopped module not stopping
			// the rest, and the build's shared spend limit (resolveTurnPayer).
			'tests/module-builder.test.ts',
			// S3 spike: two ModuleBuilders build one feature each on their own
			// copies at the same time (overlap proven), each with its own save
			// point and one onModuleFinished hook call. Local, scripted, no cost.
			'tests/module-builder-s3.test.ts',
			// Lane 13 (parts Q + R): joining the parts — the per-build integration
			// lock (migration 0043), copying only a module's folders with a stray
			// report, failure→module routing, the repair round and partial result;
			// and room for big apps — a 1,500-file version round trip and the
			// chunked preview/server bundle over 2 MB.
			'tests/team-mode-join.test.ts',
			// Lane 12 follow-up (gaps 1, 2, 4): a module opens its OWN copy from
			// its start save point and never the project pointer; a module-scope
			// stop stops only that module while the build stays building; and two
			// REAL ModuleBuilder agents build in parallel through the Flue node
			// runtime on scripted providers, each with its own save point and one
			// hook. Local, scripted, no cost.
			'tests/module-copy-isolation.test.ts',
			'tests/module-builder-agents.test.ts',
			// Lane 11 (part M + the K starter types): the app AI accepts photos
			// (host side, app-ai.ts) and the react-hono starter's generated types
			// and test stand-in carry the photo and email shapes.
			'tests/app-ai-starter.test.ts',
			// Lane 9 (part J): generated payments files (migration, routes,
			// Billing screens) — the D10 test cards, the 402 plan_required
			// lifecycle, cancel-keeps-until-renewal and the no-full-card-number
			// invariant, run against the real routes in a materialised app.
			'tests/payments-files.test.ts',
			// Lane 9 (part L): generated photo/file uploads — chunked at 700 KB,
			// a 5 MB byte-identical roundtrip (sha256), wrong-sha256/oversize/type
			// refusal, the 100 MB app cap, B-privacy, and the browser shrink/split
			// helpers.
			'tests/files-files.test.ts',
			// Lane 9 (part O starter files): the recipe kit — caddie/charts.tsx
			// (SVG bar/line/donut, no new library, screen-reader table) and
			// caddie/poll.ts (usePolling, pausing while the tab is hidden).
			'tests/kit-files.test.ts',
			// Lane 8 (part I): the campaign runner's LIVE path, all offline —
			// the host-guarded dev client + two-account sign-in and the
			// end-to-end brief driver (dev-client, driver); the read-only D1
			// results reader + SELECT-only live seam (d1-reader); the browser
			// check's persistence/isolation judgement (browser-check); the
			// campaign ledger (ledger); --mode team|baseline (mode); and the
			// whole runCampaign orchestration composed over fakes (campaign).
			'tests/brief-run-dev-client.test.ts',
			'tests/brief-run-driver.test.ts',
			'tests/brief-run-d1-reader.test.ts',
			'tests/brief-run-browser-check.test.ts',
			'tests/brief-run-ledger.test.ts',
			'tests/brief-run-mode.test.ts',
			'tests/brief-run-campaign.test.ts',
			// Lead wiring for J and L: the generated payments/upload files reach
			// apps that declare them (app features only), stay protected, the
			// builders are told how to mount them, and the plan gate refuses
			// test-mode features the project can't run (emails/jobs until lane 10).
			'tests/app-feature-files.test.ts',
			// Lane 6 (screens, section 7): the pure projectors that turn the
			// architecture block + review + module board + stop into the plain
			// shapes the Design review and build-progress screens read.
			'tests/design-overview.test.ts',
			// Lane 10 (parts K + N): emails from apps stored to the test inbox
			// (never sent, the limits, bad-address refusal, cross-project
			// isolation); the test-inbox route returning codes + emails together;
			// and Run-now job signatures (the host signer matches the generated
			// access check, stale/forged calls refused) with the run records.
			'tests/app-email.test.ts',
			'tests/test-inbox.test.ts',
			'tests/app-job.test.ts',
		],
		browser: [
			'tests/browser/brief.spec.ts',
			// Lane 6 (screens, section 7): screen 1 — "How your app works" (small
			// and big app, modules, payments/emails, the architect findings), and
			// screen 2 — build progress (small server/screens parts, big parts
			// board, the spending-limit stop, and the Try-again button).
			'tests/browser/design-review-team.spec.ts',
			'tests/browser/build-progress-team.spec.ts',
			// Lane 10 (screen 3): the test inbox with a code and an email marked
			// "Not sent — test mode", and the jobs list with Run now and a run.
			'tests/browser/screen3-team.spec.ts',
		],
		live: [],
	},
	// --- Verification net (S01) ----------------------------------------------
	NET: { tests: ['tests/packet-completeness.test.ts'], browser: [], live: [] },
};

/** Every known packet id, in the order the table declares them. */
export const PACKET_KEYS: readonly string[] = Object.keys(PACKET_MAP);
