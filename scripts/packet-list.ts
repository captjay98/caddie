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
		tests: [],
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
		tests: ['tests/github.integration.test.ts', 'tests/github-repos.integration.test.ts'],
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
		tests: ['tests/deploy-preflight.test.ts', 'tests/live-receipts.test.ts'],
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
		tests: ['tests/attachments.test.ts', 'tests/brief-lifecycle.test.ts', 'tests/brief.test.ts', 'tests/decision-card-status.test.ts'],
		browser: ['tests/browser/brief.spec.ts', 'tests/browser/conversation.spec.ts'],
		live: [],
	},
	U05: {
		tests: ['tests/project-card.test.ts', 'tests/project-proposals.test.ts'],
		browser: ['tests/browser/discovery.spec.ts', 'tests/browser/discovery-journey.spec.ts', 'tests/browser/projects-v2.spec.ts', 'tests/browser/project-proposal.spec.ts'],
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
	B05: { tests: ['tests/conversation-scope.test.ts'], browser: ['tests/browser/conversation.spec.ts'], live: [] },
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
		],
		browser: [],
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
			'tests/build-activity.test.ts',
			'tests/build-timeline.test.ts',
			'tests/sandbox-durability.test.ts',
			'tests/single-recipe.test.ts',
			'tests/plan-features.test.ts',
			'tests/workflow-dispatch.test.ts',
			'tests/stopped-turn.test.ts',
			// Owner review item 3: the one install step every install path uses.
			'tests/verified-install.test.ts',
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
	// --- Verification net (S01) ----------------------------------------------
	NET: { tests: ['tests/packet-completeness.test.ts'], browser: [], live: [] },
};

/** Every known packet id, in the order the table declares them. */
export const PACKET_KEYS: readonly string[] = Object.keys(PACKET_MAP);
