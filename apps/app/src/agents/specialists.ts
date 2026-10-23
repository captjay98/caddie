import { SPECIALIST_ROLES, ROLE_TOOL_POLICY, type SpecialistRole } from './permissions.ts';
import { PACKAGED_SKILLS, type PackagedSkillName } from './skills.ts';
import {
	makeReadProjectContext,
	makeReadSandboxFile,
	makeSandboxExec,
	makeWritePlanNote,
	makeWriteSandboxFile,
	makeDelegateRepair,
	makeRecordVerification,
 makeVerifyBuild,
	makeRunChecks,
	makeRequestAppKey,
	makeRestoreFiles,
	type PartGuard,
	type SandboxToolDeps,
} from './tools.ts';
import type { Area, AreaRole } from '../server/part-manifests.ts';
import type { ToolDefinition } from '@flue/runtime';
import { useInstruction, useSkill, useSubagent, useTool } from '@flue/runtime';
import { findModelRouteForRole } from './providers.ts';
import { FEATURE_DELEGATION_RULE } from './delegation.ts';
import { DEMO_CONTRACT_GUIDE, FEATURE_BLOCK_GUIDE } from '@caddie/contracts';
import { CADDIE_SCRATCH_DIR } from '../server/source-export.ts';
import { makeRecordArchitectureReview, type RecordReviewInput } from '../server/architecture-review.ts';
import { RECIPES } from '../../../../stacks/react-hono/recipe.ts';

/**
 * P05 specialists — seven restricted roles. This module is deliberately NOT
 * a `'use agent'` module: the specialists are delegates declared on the
 * coordinator via useSubagent, not top-level durable agents (no extra DO
 * classes, no extra migrations).
 *
 * Composition contract (flue lessons, docs/flue.md):
 *  - subagent renders reject useModel/usePersistentState — the model lives on
 *    the useSub() definition; state passes through the task prompt;
 *  - a specialist's whole world is its instructions + the tools mounted here.
 *
 * The mount list comes from ROLE_TOOL_POLICY — the same table the permission
 * tests read, so a policy change and the mounted tools cannot drift apart.
 * The runtime environment (sandbox driver + session) is injected via the
 * build context; nothing here reaches network or process APIs directly.
 */

export interface SpecialistBuildContext {
  /** Full current request; delegation summaries must not drop user feedback. */
  currentRequest?: string;
  /** The run's kind of app: 'flutter' for an Android app (Track 3), else a web app. */
  stackId?: string;
  /** Software-team mode (part B/C): the design carries a caddie-architecture block
   *  v2 and the planner/build prompts change. Stamped on the workflow; with it
   *  off (the default) every prompt is exactly as it was before team mode. */
  teamMode?: boolean;
  /** A big app (part C): modules are planned and built independently, core first. */
  bigApps?: boolean;
  /**
   * Team mode (part D): resolve (and lazily START from the current save point)
   * the active part for a BUILD role, so the write-tool guard can refuse
   * another role or an out-of-area path early. Returns the ACTIVE part's role +
   * area, or null when none is active and none can be started. Absent with team
   * mode off, so the guard is not mounted and writes behave exactly as before.
   */
  activePartForRole?: (
    role: AreaRole,
    moduleId?: string,
  ) => Promise<{ role: string; area: Area } | null>;
  /**
   * Team mode (part D): restore_files for a build role — put the out-of-area
   * files finish_part listed back from the part's start image, acting only on
   * what is currently out of area. Absent with team mode off (restore_files is
   * not mounted).
   */
  restorePartFiles?: (
    paths: string[],
    moduleId?: string,
  ) => Promise<{ restored: string[]; deleted: string[]; reported: string[]; skipped: string[] }>;
 verifyBuild?: (operationKey:string, signal?:AbortSignal)=>Promise<unknown>;
	/** Host-run project checks for build roles (run_checks); never publishes a preview. */
	runChecks?: (operationKey: string, signal?: AbortSignal) => Promise<unknown>;
	/** Ask the owner for an app key (request_app_key). Returns status only, never a value. */
	requestAppKey?: (input: { name: string; description: string; helpUrl?: string }) => Promise<{ name: string; status: 'requested' | 'set' }>;
	/** Sandbox adapter surface (P04) bound to this run's session. */
	driver: SandboxToolDeps;
	sessionId: string;
	runId: string;
	/** Reads the latest plan note body of a kind (durable, from D1). */
	readPlanNote: (kind: string) => Promise<string | null>;
	/** Appends a plan note revision (durable, from D1). */
	writePlanNote: (input: { kind: string; body: string; planRevision: string }) => Promise<void>;
	/** Records a repair round in the ledger (durable, from D1). */
	delegateRepair: (input: { issue: string; round: string; toRole: string; task: string }) => Promise<void>;
	/** Appends a verification record (durable, from D1). */
	recordVerification: (input: { check: string; passed: boolean; evidence: string; planRevision: string }) => Promise<void>;
}

/** Catalog metadata — one row per role, consumed by coordinator and tests. */
export interface SpecialistDescriptor {
	role: SpecialistRole;
	name: string;
	description: string;
	/** Skills the role is expected to activate, by name. */
	skills: readonly string[];
}

export const SPECIALIST_CATALOG: readonly SpecialistDescriptor[] = [
	{ role: 'product', name: 'product', description: 'Shapes scope, PRD and acceptance intent from the brief and evidence; no execution tools.', skills: ['planning'] },
	{ role: 'designer', name: 'designer', description: 'Designs the interface and interaction boundary; reads the sandbox, writes plan notes only.', skills: ['planning', 'design'] },
	{ role: 'tech-lead', name: 'tech-lead', description: 'Owns the plan of record, delegates work and repairs, keeps the build honest.', skills: ['planning', 'build-verify'] },
	{ role: 'frontend', name: 'frontend', description: 'Implements client-side behavior in the sandbox.', skills: ['build-verify'] },
	{ role: 'backend', name: 'backend', description: 'Implements server-side behavior in the sandbox.', skills: ['build-verify'] },
	{ role: 'mobile', name: 'mobile', description: 'Implements and verifies the mobile target in the sandbox.', skills: ['build-verify'] },
	{ role: 'qa', name: 'qa', description: 'Runs the checks and records verification evidence; has no write tools at all.', skills: ['build-verify'] },
];

/**
 * The react-hono build recipe every specialist receives. The scaffold
 * (stacks/react-hono/scaffold.ts) ships a WORKING test setup, so this tells
 * the builder to use it — never to configure a DOM itself. The previous text
 * asked the build model to hand-wire jsdom + Testing Library preloads, which a
 * real build (FarmLog AI, 2026-10-15) spent its run on instead of the app.
 */
export const BUILD_RECIPE_INSTRUCTION =
	'React/Hono recipe: src/main.tsx is the browser entry and renders <App /> from src/App.tsx; src/styles.css holds responsive styles. ' +
	'The starter app ALREADY has a working test setup: bunfig.toml preloads happy-dom (a browser DOM with window, document and localStorage) and Testing Library with jest-dom matchers and cleanup between tests. ' +
	'Never create or edit bunfig.toml or anything under test/setup/ (writes there are refused), and never add jsdom, Vitest or Jest. ' +
	'Write behavior tests as src/*.test.tsx using test/expect from bun:test and render/screen/fireEvent from @testing-library/react; test/examples/app.example.test.tsx shows the pattern but does not count. ' +
	'Run tests ONLY with run_checks: it installs, runs `bun test src/` and builds exactly as the host verifies. Shell test commands are refused, and every failing run_checks counts toward the repair limit, so read the failure and fix its cause before running again. ' +
	`Put throwaway probes only in ${CADDIE_SCRATCH_DIR}/ (it is never saved or shown as an app file), never in the app root or src/. ` +
	"When run_checks fails inside Caddie's own steps rather than in your app — the output names /tmp/caddie-…, says a package could not be unpacked, says the registry could not be reached, or says a tarball does not match bun.lock — that is Caddie's problem, not your code: say so in one plain sentence and stop that repair. Never read, copy or debug Caddie's scripts or a package's node_modules internals. " +
	'Never delete assertions or replace component tests with copied logic. Use React 19 createRoot. ' +
	'Every app also has a server, ready from the start: src/server.ts is a Hono app whose routes all live under /api (it already answers GET /api/health); call it from React with fetch("/api/..."). ' +
		'Data the app must keep or share goes through the server and env.DB (Cloudflare D1: c.env.DB.prepare(sql).bind(...).all() / first() / run(), env.DB.batch([...])); use localStorage only for per-device preferences, and never as the only copy of something the demo path reads back. Create tables with a NEW migrations/NNNN_name.sql file (0001_init.sql, then 0002_..., plain SQLite) and never edit an existing migration. ' +
	'Test server routes in src/*.test.ts with createTestEnv() from test/setup/d1.ts and app.request("/api/...", init, env); test/examples/server.example.test.ts shows the pattern. ' +
	'In src/server.ts use only Web APIs (fetch, Request, Response, URL, crypto) — never Bun.* or Node fs/child_process/net — because the published app runs on Cloudflare Workers and the build refuses them. Never edit anything under caddie/. ' +
	'When the app needs a key for an outside service, call request_app_key (UPPER_SNAKE name, one plain sentence on what it lets the app do, the https page where the owner gets it) and call that service ONLY from src/server.ts with c.env.<NAME>; never put a key in browser code, in a file, in a test or in a log, and never ask for one in chat. Until the owner saves it, a route that needs it answers 503 with a plain sentence; tests use createTestEnv({ NAME: "test-value" }) and never call the real service. ' +
	"The published page may only run its own scripts, fetch its own /api routes and post forms to itself (Caddie's security policy blocks the rest), so every call to an outside service — with or without a key — goes through src/server.ts; images, fonts and styles may still load from https URLs. " +
	'Caddie keeps only dist/main.js and dist/main.css from the build, so a file the browser code loads at run time (a .wasm, a font, a data file) is never there: put its bytes in the bundle with import { embedBase64 } from "../caddie/embed.ts" with { type: "macro" } and embedBase64("node_modules/<package>/<file>") (the path is from the app folder), then decode them (for sql.js: initSqlJs({ wasmBinary: bytes })). ' +
	'When a feature needs AI (summarise, suggest, answer, sort text), call c.env.CADDIE.ai({ messages: [{ role, content }], json? }) from src/server.ts: Caddie runs and pays for it, so there is no AI key — never request_app_key for one and never ask the owner for one. It returns { ok: true, text } or { ok: false, message }; when ok is false answer 503 with reply.message as it is. Leave tier out for everyday replies; use tier: "super" when a feature needs deeper reasoning. Call it when a person asks, not on every page load (each app has a monthly allowance), and test it with createTestEnv({ CADDIE: createTestAi("…") }) from test/setup/ai.ts; caddie/ai.ts shows the shapes. ' +
	'When people need their own account (sign in, "my" lists, data only its owner sees), use Caddie\'s sign-in, never a password login of your own: call mountSignIn(app) once in src/server.ts and requireUser(c) in each route that needs someone signed in (store user.id on their rows), and in React use <SignIn /> and useUser() from caddie/sign-in.tsx. Caddie emails the 6-digit codes — no email service or key — and in the preview they show up in the project card\'s test inbox. Test those routes with signInForTest(app, env) from test/setup/auth.ts. ' +
	'During a build the coordinator hands you ONE feature with its doneWhen checks: build only that feature, keep earlier features working, and add at least one test in src/*.test.tsx for each doneWhen check (the host refuses to finish a feature that adds no new passing tests). ' +
	'When the app has caddie/payments.ts (the plan takes payments, in TEST MODE: no money moves), call mountPayments(app, { currency, plans }) once in src/server.ts with the plan\'s currency and plans, start each locked route with const locked = await planAccess(c, ["<plan id>"]); if (locked) return locked;, and use the screens in caddie/Billing.tsx; test with the card 4242 4242 4242 4242 (paid) and 4000 0000 0000 0002 (declined). ' +
	'When the app has caddie/files.ts (a record keeps a photo or file), call mountFiles(app) once in src/server.ts, upload from React with uploadFile(file) from caddie/upload.ts (it shrinks photos and sends them in parts), show one with fileUrl(id), and read one in a route with readFile(c, id). ' +
	'Your app also runs inside the preview: a sandboxed frame whose origin is opaque and whose localStorage is a small proxy, with its own /api calls relayed to its server. So never gate a request on window.location.protocol, window.location.origin or window.location.hostname, and never read them to decide whether the server is reachable — the frame is not the address your app will have when it is published. Just call fetch("/api/...") and handle the failure; a request that fails is an offline app, not a reason to skip the call. ' +
	'The host creates the scaffold only after approval. Read the full brief, prd, spec and feedback. ' +
	'Read the approved design brief too (read_project_context ["design"]): build each screen this feature touches to match it — its layout and regions, the named components, the interaction pattern for each input, and the empty, loading and error states — and follow its html-mock blocks, so the app looks the way the user approved rather than a default React layout. ' +
	'Craft the look from the app theme, never ad hoc: colours, radius and fonts come ONLY from the theme variables in caddie/theme.css (var(--bg), var(--surface), var(--text), var(--muted), var(--primary), var(--on-primary), var(--border), var(--ok), var(--warn), var(--danger), var(--radius), var(--font-heading), var(--font-body)) — never a literal hex. Use the icon kit (import { Icon } from "../caddie/icons") for glyphs, never an emoji. ' +
	'Layout and motion: use 100dvh (not 100vh) for full-height screens and honour safe-area insets on fixed top/bottom elements (env(safe-area-inset-*)); animate only transform and opacity, keep feedback under 200ms, and wrap motion in @media (prefers-reduced-motion: reduce) so it can be turned off. ' +
	'States: show numbers with font-variant-numeric: tabular-nums; give every empty state one clear action; put an error next to the action that failed, not only at the top; and confirm a destructive action before it runs. ' +
	'Accessibility: a visible label on every input, a visible focus ring on every control, an aria-label on every icon-only button, and touch targets at least 44x44px. Every layout must work from 320px wide up to desktop (one column on a phone, no fixed pixel widths that overflow). Do not assume a device class — let the design brief\'s audience drive how big and how dense the UI is. ' +
	'Plan before coding. Do not write a new PRD during an approved build without asking for a new review. QA calls verify_build and reports its real receipts, never a self-reported pass. ' +
	RECIPES;

/**
 * What every plan must know about an app's AI (plan 4.1: the coordinator never
 * named it). Shared by the planner roles and the coordinator, so Home
 * proposals and project PRDs say the same thing.
 */
export const PLATFORM_AI_RULE =
	"PLATFORM AI: an app Caddie builds gets its AI from Caddie. Its server calls c.env.CADDIE.ai({ messages, json?, tier? }), which runs NVIDIA Nemotron on Nebius Token Factory and is paid by Caddie, so there is no AI key to ask for. Plan every AI feature (summarise, suggest, answer, sort or pull facts from text) on it. Two tiers: the demo's core-value call (the ranking, diagnosis or generation a judge watches and thinks about) runs on tier:\"super\" — deep reasoning, ~3.75x cost, a longer wait is fine there; everything else (background checks, parsing, short autocomplete, bulk work) runs on the default fast tier. Name the tier in the PRD's call path so the builder writes it. Never plan Ollama, a local or self-hosted model, a model download, or a third-party AI key (OpenAI, Anthropic, Gemini, Hugging Face).";

/**
 * The Flutter build recipe (Track 3): an Android app, also previewed in the
 * browser, with the same Hono server as web apps. Matches
 * stacks/flutter/scaffold.ts and the host checks in server/host-checks.ts.
 */
export const FLUTTER_RECIPE_INSTRUCTION =
	'Flutter recipe: this app is an Android app (Caddie also runs it in the browser for the preview). lib/main.dart starts it with runApp(const App()); put screens and widgets in lib/. Package name: caddie_app. ' +
	`Put throwaway probes only in ${CADDIE_SCRATCH_DIR}/ (it is never saved or shown as an app file), never in the app root or src/. ` +
	"When run_checks fails inside Caddie's own steps rather than in your app — the output names /tmp/caddie-…, says a package could not be unpacked, says the registry could not be reached, or says a tarball does not match bun.lock — that is Caddie's problem, not your code: say so in one plain sentence and stop that repair. Never read, copy or debug Caddie's scripts or a package's node_modules internals. " +
	'Call the server with apiUri("/api/...") from lib/api.dart and a package:http client: apiUri resolves against the page in the preview and against the app\'s published address in the Android build. Pass the http.Client into the widgets that need it, so tests can answer for the server. ' +
	'Write widget tests in test/app/*_test.dart with flutter_test (testWidgets, pumpWidget, find, expect) and MockClient from package:http/testing.dart; flutter_test blocks real network calls. test/examples/widget_example_test.dart shows the pattern but does not count: the host runs `flutter test test/app`. ' +
	'Run tests ONLY with run_checks: it sets up the Android and web projects, installs packages, runs the app\'s tests (and the server\'s tests in src/, when there are any) and builds exactly as the host verifies. Shell test commands (flutter test, dart test) are refused, and every failing run_checks counts toward the repair limit, so read the failure and fix its cause before running again. ' +
	'Add packages with `flutter pub add <name>` (pure Dart or Android-supported packages only; never iOS-only or desktop-only ones) and keep pubspec.lock. Never edit anything under caddie/, analysis_options.yaml, or the generated android/ and web/ project files unless a feature needs an Android setting. ' +
	'Every app also has a server: src/server.ts is a Hono app whose routes all live under /api (it already answers GET /api/health). Data the app must keep or share goes through the server and env.DB (Cloudflare D1: c.env.DB.prepare(sql).bind(...).all() / first() / run()). Create tables with a NEW migrations/NNNN_name.sql file (0001_init.sql, then 0002_..., plain SQLite) and never edit an existing migration. ' +
	'Test server routes in src/*.test.ts with createTestEnv() from test/setup/d1.ts and app.request("/api/...", init, env); test/examples/server.example.test.ts shows the pattern. In src/server.ts use only Web APIs (fetch, Request, Response, URL, crypto), never Bun.* or Node fs/child_process/net: the server runs on Cloudflare Workers and the build refuses them. ' +
	'When the app needs a key for an outside service, call request_app_key and call that service ONLY from src/server.ts with c.env.<NAME>; never put a key in Dart code, a file, a test or a log. When a feature needs AI, call c.env.CADDIE.ai({ messages: [{ role, content }], json? }) from src/server.ts (Caddie pays; no key), returning 503 with reply.message when ok is false; caddie/ai.ts shows the shapes and test/setup/ai.ts the test double. ' +
	'Keep the app usable in a phone-sized window: one column, no fixed widths, large touch targets. The browser preview may only fetch the app\'s own /api routes. ' +
	'During a build the coordinator hands you ONE feature with its doneWhen checks: build only that feature, keep earlier features working, and add at least one test in test/app/*_test.dart (or src/*.test.ts for a server-only check) for each doneWhen check (the host refuses to finish a feature that adds no new passing tests). ' +
	'The host creates the scaffold only after approval. Read the full brief, prd, spec and feedback. ' +
	'Read the approved design brief too (read_project_context ["design"]): build each screen this feature touches to match it — its layout and regions, the named components, the interaction pattern for each input, and the empty, loading and error states — and follow its html-mock blocks, so the app looks the way the user approved rather than a default Material layout. ' +
	'Plan before coding. Do not write a new PRD during an approved build without asking for a new review. QA calls verify_build and reports its real receipts, never a self-reported pass.';

/** The build recipe for a run's kind of app. */
export function recipeInstructionFor(stackId: string | undefined): string {
	return stackId === 'flutter' ? FLUTTER_RECIPE_INSTRUCTION : BUILD_RECIPE_INSTRUCTION;
}

/** Role-specific instruction text (kept here so tests can audit it). */
export const SPECIALIST_INSTRUCTIONS: Readonly<Record<SpecialistRole, string>> = {
	product:
		'You shape the product: scope, PRD and acceptance intent. Work only from the brief and pinned evidence; cite sources. You have no execution tools — write plan notes instead of running commands. ' +
		'Aim at a demo that wins, not a complete CRUD app: one deep integration that works in the preview beats five shallow screens, and a mock may support the demo but never carry it. Write the demo contract before the feature list, then make every feature move that demo forward. ' +
		'Decide where the data lives, in the PRD, and be concrete: anything the demo path reads or writes (a herd, a case, a report) must be stored by the app\'s SERVER in its own database with a table, so it survives a restart and is the same for every device; the device\'s own storage is a cache for speed and offline use, never the only copy. Say in the PRD where each kind of data is kept, so the builders do not have to guess. ' +
		PLATFORM_AI_RULE,
	designer:
		'You design the interface and interaction boundary. Read the current code from the sandbox for context, but express decisions as plan notes; implementation belongs to build roles. ' +
		'After the PRD is approved the project enters the DESIGN step: author ONE design brief and save it with write_plan_note kind:\'design\' (same planRevision), then STOP for the design review — never build or scaffold. A description of the brief in your reply is NOT a saved brief: return only after the host confirms SAVED. The brief covers: a SCREEN INVENTORY (every screen the app needs); for each key screen its LAYOUT (the regions and what sits where, described so a builder can lay it out) and the key COMPONENTS; the TOKEN/COMPONENT choices (which theme tokens, which shared components, the interaction pattern for each input — a form, a segmented picker, a list); and the EMPTY, LOADING and ERROR state for anything that loads or saves. Ground it in the design system the app uses; keep it concrete, not a restatement of the PRD. Where the PRD leaves a visual choice open, pick a sensible default and label it \'assumption:\'.',
	'tech-lead':
		'You own the plan of record. Delegate build and repair work with precise tasks, review results honestly, and keep the last good checkpoint visible. Never claim success without machine-checked evidence. ' +
		'Before approving a plan, test it as a judge would: can the demo path happen with real input in three minutes, is the named integration core rather than decoration, and which mock would embarrass the demo? Push the product specialist to fix that before review. ' +
		'Before the build starts, check the approved design COVERS the plan: every PRD feature must have a screen in the design brief, and the brief must carry a valid caddie-theme block. If a feature has no screen, or the theme is missing, send it back to the designer before building — a feature with nowhere to live is not ready to build. ' +
		PLATFORM_AI_RULE,
	frontend:
		'You implement client-side behavior in the sandbox (src/*.tsx, src/styles.css). Follow the plan of record and build each screen to MATCH THE APPROVED DESIGN: read it with read_project_context ["design"], lay out the regions and components the brief names, and build the empty, loading and error state for anything that loads or saves. ' +
		'Take colours, radius and fonts ONLY from the app theme variables in caddie/theme.css (var(--bg), var(--surface), var(--text), var(--muted), var(--primary), var(--on-primary), var(--border), var(--ok), var(--warn), var(--danger), var(--radius), var(--font-heading), var(--font-body)) — never a literal hex — and use the icon kit (import { Icon } from "../caddie/icons"), never an emoji. Give every input a visible label, every control a visible focus ring, every icon-only button an aria-label, and every touch target at least 44px; use 100dvh not 100vh, animate only transform/opacity under 200ms behind prefers-reduced-motion, and make the layout work from 320px to desktop. Run the project checks with run_checks and report exact outcomes.',
	backend:
		'You implement server-side behavior in the sandbox (src/server.ts, migrations/). Follow the plan of record; run the project checks with run_checks; report exact commands and outcomes. ' +
		'Hono + D1 discipline: validate every input at the route and answer a bad request with a plain-language error body (never a raw stack); call requireUser(c) on any route that touches someone\'s own data and check the owner (store and compare user.id) so one person can never read or change another\'s records; keep money as integer minor units, never a float; and never put a secret, a key or a token in a response or a log. Create tables with a NEW migrations/NNNN_name.sql file and never edit an existing migration; use only Web APIs in src/server.ts (never Bun.* or Node fs/child_process/net), because the server runs on Cloudflare Workers.',
	mobile:
		'You implement and verify the mobile (Flutter) target in the sandbox (lib/*.dart). Follow the plan of record and build each screen to match the approved design (read it with read_project_context ["design"]). ' +
		'You verify ONLY through run_checks: it sets up the Android and web projects, installs packages, runs the widget tests (flutter test test/app) and the server tests, and builds — exactly as the host verifies. You have no device, emulator or adb, and no screenshots: shell test commands (flutter test, dart test) are refused, so do not claim device or screenshot evidence. Write a widget test in test/app/*_test.dart for each doneWhen check, keep the app usable in a phone-sized window (one column, large touch targets), and report the exact run_checks outcome.',
	qa:
		'You verify using verify_build: the host executes fixed tests and build commands and records their actual receipts. Read code to find missing behaviors and ask implementation specialists to repair them. You cannot execute arbitrary shell, write product code, or invent verification evidence.',
};

/**
 * Part C — the team-mode PRODUCT instruction, which REPLACES the "demo that
 * wins" wording when team mode is on. It aims at a complete app (every table
 * has screens that create/show/change/delete through the server, the main path
 * works with real saved data), and keeps the demo contract as the three-minute
 * tour of that complete app — a mock may stand in only for what the plan marks
 * test mode. With team mode OFF this is never used and the product prompt is
 * exactly as before.
 */
export const TEAM_MODE_PRODUCT_INSTRUCTION =
	'You shape the product: scope, PRD and acceptance intent. Work only from the brief and pinned evidence; cite sources. You have no execution tools — write plan notes instead of running commands. ' +
	'Plan a complete app. Every table you declare has screens that create, show, change and delete its records through the server, and the main path works end to end with real saved data. The demo contract is the three-minute tour of that complete app, not a substitute for it. A mock may stand in only for what the plan marks as test mode: payments, emails and jobs. ' +
	'Decide where the data lives, in the PRD, and be concrete: anything a screen reads or writes (a herd, a case, a report) must be stored by the app\'s SERVER in its own database with a table, so it survives a restart and is the same for every device; the device\'s own storage is a cache for speed and offline use, never the only copy. ' +
	PLATFORM_AI_RULE;

/**
 * Part C — the team-mode TECH-LEAD instruction, which REPLACES the three-minute
 * judge test. It checks completeness as well as the demo: every declared table
 * is used by a screen, every person/team-owned record is private as declared,
 * the main path still works after a restart, and the demo path is the main path
 * of the complete app.
 */
export const TEAM_MODE_TECH_LEAD_INSTRUCTION =
	'You own the plan of record. Delegate build and repair work with precise tasks, review results honestly, and keep the last good checkpoint visible. Never claim success without machine-checked evidence. ' +
	'Before approving a plan, check that every declared table is used by a screen, that every person- or team-owned record is private as declared, that the main path still works after a restart, and that the demo path is the main path of the complete app. Push the product specialist to fix any gap before review. ' +
	PLATFORM_AI_RULE;

/**
 * Part B/C — the DESIGN instruction that applies in team mode. The designer
 * (and the tech-lead where it authors the design) emit the caddie-architecture
 * block v2 INSIDE the design document, so there is ONE approval and ONE
 * revision hash for both the brief and the architecture. For a big app the
 * block plans independent modules with core first; every screen declares what
 * it shows.
 */
export const TEAM_MODE_DESIGN_INSTRUCTION =
	'TEAM MODE: the design document carries ONE fenced ```caddie-architecture JSON block (version 2) describing how the whole app works before it is built — its sign-in, team shape, modules, tables (and who owns each record), routes (and who may call each), screens, outside services, AI uses, and any payments, emails and jobs. The block lives inside the SAME design the user approves, so there is one approval and one revision hash for the brief and the architecture together; never split them into two documents. Every table is owned person, team, shared or public; every route declares its access; every screen declares what it shows (its `shows` list of tables), and a screen that shows no saved data goes in `screenOnly`. Caddie checks the block with deterministic rules and an architecture review before the design can be approved, so make it correct and safe: private records need full create/read/list/update/delete and are never open to everyone, team records carry :teamId and team access, admin and job routes need sign-in, and services name an UPPER_SNAKE key with an https page.';

/** Part C — for a BIG app the modules are planned independently, core first. */
export const TEAM_MODE_BIG_APPS_DESIGN_INSTRUCTION =
	'BIG APP: plan the app as independent modules (parts) that can be built at the same time, with the core module first — core holds the app shell, sign-in, roles and the shared records every other module depends on. Each other module depends on core (and only on modules already planned), writes only its own tables, and reads core\'s tables without changing them. Draft and review the modules in parallel, as delegates dispatched in one batch; each screen still declares what it shows.';

/**
 * The role instruction to use for a given team-mode flag. With `teamMode`
 * false (the default) every role returns exactly its SPECIALIST_INSTRUCTIONS
 * text; with it true, product and tech-lead get their part-C replacements and
 * every other role is unchanged. The designer's team-mode additions are mounted
 * separately (they are extra instructions, not a replacement).
 */
export function specialistInstruction(role: SpecialistRole, teamMode: boolean): string {
	if (!teamMode) return SPECIALIST_INSTRUCTIONS[role];
	if (role === 'product') return TEAM_MODE_PRODUCT_INSTRUCTION;
	if (role === 'tech-lead') return TEAM_MODE_TECH_LEAD_INSTRUCTION;
	return SPECIALIST_INSTRUCTIONS[role];
}

/** Build one specialist's agent function with its policy's tools mounted. */
export function buildSpecialist(role: SpecialistRole, context: SpecialistBuildContext) {
	const allowed = ROLE_TOOL_POLICY[role];
	// Team mode (part D): a build role carries a part guard whose `active()`
	// resolves (and lazily starts) the active part for THIS role, so the write
	// tool refuses another role's part or an out-of-area path early, and
	// restore_files puts out-of-area files back. Both are absent with team mode
	// off (context.activePartForRole/restorePartFiles undefined), so the guard
	// is undefined and restore_files mounts a plain "no active part" refusal —
	// exactly today's behaviour. 'other' is never a write role.
	const guardRole: AreaRole | null =
		role === 'backend' || role === 'frontend' || role === 'mobile' ? role : null;
	const partGuard: PartGuard | undefined =
		guardRole && context.activePartForRole
			? { role: guardRole, active: () => context.activePartForRole!(guardRole) }
			: undefined;
	// Loosely typed on purpose: each tool carries its own input schema; the
	// mount loop only needs name -> definition.
	const toolFor: Record<string, ToolDefinition> = {
		read_project_context: makeReadProjectContext({ readPlanNote: context.readPlanNote }),
		write_plan_note: makeWritePlanNote({ writePlanNote: context.writePlanNote }),
		sandbox_exec: makeSandboxExec({ driver: context.driver, sessionId: context.sessionId, runId: context.runId, ...(partGuard ? { partGuard } : {}) }),
		read_sandbox_file: makeReadSandboxFile({ driver: context.driver, sessionId: context.sessionId }),
		write_sandbox_file: makeWriteSandboxFile({ driver: context.driver, sessionId: context.sessionId, ...(partGuard ? { partGuard } : {}) }),
		restore_files: makeRestoreFiles({
			restore: context.restorePartFiles
				? (paths) => context.restorePartFiles!(paths)
				: async () => {
						throw new Error('There is no part in progress, so there is nothing to restore.');
					},
		}),
		delegate_repair: makeDelegateRepair({ delegate: context.delegateRepair }),
		record_verification: makeRecordVerification({ record: context.recordVerification }),
 verify_build: makeVerifyBuild({verify: context.verifyBuild ?? (async () => { throw new Error('Host checks are not configured.'); })}),
		run_checks: makeRunChecks({ run: context.runChecks ?? (async () => { throw new Error('Host checks are not configured.'); }) }),
		request_app_key: makeRequestAppKey({ request: context.requestAppKey ?? (async () => { throw new Error('App keys are not available here.'); }) }),
	};
	const descriptor = SPECIALIST_CATALOG.find((d) => d.role === role);
	if (!descriptor) throw new Error(`no catalog entry for role ${role}`);

	return function specialistAgent() {
		for (const toolName of allowed) {
			useTool(toolFor[toolName]);
		}
		for (const skillName of descriptor.skills) {
			
			useSkill(PACKAGED_SKILLS[skillName as keyof typeof PACKAGED_SKILLS]);
		}
		useInstruction(specialistInstruction(role, context.teamMode === true));
		// The feature-list block belongs to the PRD, authored by product/tech-lead.
		// The designer carries `planning` only to READ the PRD — its own output is a
		// design brief with NO feature block, so it must not get this instruction.
		if (descriptor.skills.includes('planning') && !descriptor.skills.includes('design')) {
			useInstruction(
				`A PRD must carry a judge-facing demo contract before the feature list; write_plan_note refuses a PRD without one. ${DEMO_CONTRACT_GUIDE}`,
			);
			useInstruction(`A PRD must end with the feature list the user approves and the host builds one feature at a time. ${FEATURE_BLOCK_GUIDE}`);
		}
		if (descriptor.skills.includes('design')) {
			useInstruction(
				'After the PRD is approved you author ONE design brief (write_plan_note kind:"design"), then STOP for review — never build. The brief carries NO caddie-features block, covers every section the design skill lists, and includes one titled `html-mock` fenced block per key screen and state (the key screen, its empty state, its error state), static and styled only with design-system tokens, so the review card can show each one.',
			);
			// Team mode: the design document also carries the caddie-architecture
			// block v2 (one approval, one revision hash); a big app plans its
			// modules independently, core first.
			if (context.teamMode === true) {
				useInstruction(TEAM_MODE_DESIGN_INSTRUCTION);
				if (context.bigApps === true) useInstruction(TEAM_MODE_BIG_APPS_DESIGN_INSTRUCTION);
			}
		}
    if (context.currentRequest?.trim()) useInstruction(`Current user request, carried forward by the host: ${context.currentRequest}\nRespect the approved plan and your role permissions; this request does not bypass review or spending gates.`);
 useInstruction(recipeInstructionFor(context.stackId));
		return specialistInstruction(role, context.teamMode === true);
	};
}

/**
 * The seven delegate definitions for the coordinator's useSubagent calls.
 * Each delegate declares its own model (MODEL_ROLES in providers.ts is still
 * the one place that assigns models): the planners — the catalog entries that
 * carry the `planning` skill (product, designer, tech-lead) — run on the
 * `plan` role; implementation and QA run on the `build` role (both are
 * GLM-5.3-Flash today; providers.ts decides).
 * Without an override a delegate would inherit the coordinator's chat turn.
 */
export function specialistModelRole(descriptor: { skills: readonly string[] }): 'plan' | 'build' {
	return descriptor.skills.includes('planning') ? 'plan' : 'build';
}

export function buildSpecialistDeclarations(context: SpecialistBuildContext) {
	return SPECIALIST_CATALOG.map((descriptor) => ({
		name: descriptor.name,
		description: descriptor.description,
		agent: buildSpecialist(descriptor.role, context),
		model: findModelRouteForRole(specialistModelRole(descriptor)).specifier,
	}));
}

// --- the architecture-review delegate (plan part B — team mode only) ---------

/** The read-only architect's instruction: review the block, record findings. */
export const ARCHITECT_INSTRUCTION =
	'You review how an app is planned to work, for SAFETY, before it is built. Read the design\'s caddie-architecture block (through read_project_context, kind "design") and judge it as an architect: is sign-in required where private data is touched; does every private record stay owned by its person or team; can one person reach another\'s or another team\'s records; is any key or secret exposed to the browser; can data be lost. Record EVERY finding with record_architecture_review, each with a severity — "security" for sign-in, ownership/privacy, key exposure or data loss (these BLOCK the design until fixed), "advisory" for anything that would merely be better. Give the round (1 for the first review of a block, higher when you re-review after a change) and the exact blockHash you reviewed. Record an empty issue list when the block is clean. You are READ-ONLY: you never write the design, scaffold, run commands or approve anything — your one action is record_architecture_review.';

export interface ArchitectDelegateContext {
	/** Reads the latest plan note body of a kind (durable, from D1). */
	readPlanNote: (kind: string) => Promise<string | null>;
	/** Records one review round (host-scoped insert into architecture_reviews). */
	recordArchitectureReview: (input: RecordReviewInput) => Promise<{ round: number; security: number; advisory: number }>;
}

/**
 * The `architect` delegate (team mode only): a read-only reviewer on the
 * `architect` model role (Ultra, providers.ts). It can read the project's plan
 * notes and record a review round; it has no sandbox, write or build tools.
 */
export function buildArchitectDelegate(context: ArchitectDelegateContext) {
	return function architectAgent() {
		useTool(makeReadProjectContext({ readPlanNote: context.readPlanNote }));
		useTool(makeRecordArchitectureReview({ record: context.recordArchitectureReview }));
		useInstruction(ARCHITECT_INSTRUCTION);
		return ARCHITECT_INSTRUCTION;
	};
}

/** The architect delegate declaration, for the coordinator's useSubagent (team mode). */
export function architectDeclaration(context: ArchitectDelegateContext) {
	return {
		name: 'architect',
		description: 'Reviews the design\'s architecture block for safety (sign-in, ownership/privacy, key exposure, data loss) and records security/advisory findings. Read-only.',
		agent: buildArchitectDelegate(context),
		model: findModelRouteForRole('architect').specifier,
	};
}

export { FEATURE_DELEGATION_RULE };
export { useSubagent };
