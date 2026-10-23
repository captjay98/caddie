#!/usr/bin/env bun
/**
 * Campaign runner — plan `docs/plans/2026-10-22-software-team-mode.md` part I
 * (lane 8). It drives the REAL Caddie HTTP API on a local `bun run dev`
 * (127.0.0.1) as the owner (the session saved by `--sign-in`), starts a
 * project from each brief,
 * accepts the proposal, approves the design, waits for the build, reads results
 * from the local D1, runs a Playwright browser check, judges "complete", and
 * scores section 10's go/no-go marks. It enforces the campaign cap (D5) before
 * every build.
 *
 * ── Honesty rules (copied from scripts/run-journey.ts) ──────────────────────
 *   - CADDIE_LIVE_AUTHORIZED=1 is read ONLY from the process env. Authorization
 *     is an explicit owner act and is NEVER read from .dev.vars.
 *   - Without the gate, the runner prints BLOCKED and exits NONZERO. It makes
 *     no network call and fabricates no run. (tests/brief-run.test.ts pins
 *     this, offline.)
 *   - Credential VALUES come from .dev.vars (gitignored) or the process env and
 *     are NEVER printed (presence-only disclosure).
 *   - A failed step is FAILED; nothing substitutes HTTP codes or logs for a
 *     passing contract check. "Complete" requires every gate green.
 *
 * ── What is UNVERIFIED locally (built behind the gate; see report) ──────────
 *   - The real build/plan/design agent loop needs the Flue DO runtime served by
 *     `bun run dev`; it is exercised only on the live path.
 *   - build_spend_reservations / build_spend_limits (plan section 4) arrive
 *     with the foundations lane. The cap is coded against those names and
 *     unit-tested here with a fake reader; the live reader is UNVERIFIED until
 *     foundations lands.
 *   - The exact design-approval / proposal-accept request bodies depend on the
 *     team-mode architecture block (lane 2) and the coordinator wiring (lane 1).
 *     They are driven through the documented routes and classified UNVERIFIED.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = join(import.meta.dir, '..');
export const BRIEFS_DIR = join(REPO, 'tests', 'briefs');

const USD = 1_000_000; // micro-dollars per dollar
export const DEFAULT_CAMPAIGN_CAP_MICROS = 150 * USD; // D5

// D4 build limits, in micros.
export const SMALL_BUILD_LIMIT_MICROS = 5 * USD; // owner/invited
export const SMALL_JUDGE_BUILD_LIMIT_MICROS = 2 * USD;
export const BIG_BUILD_LIMIT_MICROS = 40 * USD;

// Build wait budgets (plan part I).
export const SMALL_BUILD_WAIT_MS = 90 * 60 * 1000; // 90 minutes
export const BIG_BUILD_WAIT_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─────────────────────────────────────────────────────────────────────────────
// Briefs
// ─────────────────────────────────────────────────────────────────────────────

export type BriefSize = 'small' | 'medium' | 'big';

export interface Brief {
	id: string;
	name: string;
	size: BriefSize;
	source: string;
	theme: string;
	paired: boolean;
	/** 'off' | 'on' | 'both' — which team-mode settings this brief runs under. */
	teamMode: 'off' | 'on' | 'both';
	bigApp: boolean;
	admin: boolean;
	modules: string[];
	/** The person's own words — the prompt handed to Caddie. */
	prompt: string;
	/** The "Complete when" bullet list. */
	completeWhen: string[];
	file: string;
}

function metaValue(lines: string[], key: string): string | undefined {
	// Lines like "- key: value" in the brief's first metadata block.
	for (const line of lines) {
		const m = /^-\s+([A-Za-z]+):\s*(.*)$/.exec(line.trim());
		if (m && m[1].toLowerCase() === key.toLowerCase()) return m[2].trim();
	}
	return undefined;
}

/** Parse one brief markdown file into a Brief. */
export function parseBrief(text: string, file: string): Brief {
	const lines = text.split('\n');
	const titleLine = lines.find((l) => l.startsWith('# '));
	const name = titleLine ? titleLine.replace(/^#\s+/, '').trim() : file;

	const id = metaValue(lines, 'id') ?? file.replace(/\.md$/, '');
	const sizeRaw = (metaValue(lines, 'size') ?? 'small').toLowerCase();
	const size: BriefSize = sizeRaw === 'big' ? 'big' : sizeRaw === 'medium' ? 'medium' : 'small';
	const source = metaValue(lines, 'source') ?? '';
	const theme = metaValue(lines, 'theme') ?? '';
	const paired = (metaValue(lines, 'paired') ?? 'no').toLowerCase() === 'yes';
	const teamModeRaw = (metaValue(lines, 'teamMode') ?? 'off').toLowerCase();
	const teamMode: Brief['teamMode'] =
		teamModeRaw === 'both' ? 'both' : teamModeRaw === 'on' ? 'on' : 'off';
	const bigApp = (metaValue(lines, 'bigApp') ?? (size === 'big' ? 'yes' : 'no')).toLowerCase() === 'yes';
	const admin = (metaValue(lines, 'admin') ?? 'no').toLowerCase() === 'yes';
	const modulesRaw = metaValue(lines, 'modules') ?? '';
	const modules = modulesRaw
		? modulesRaw.split(';').map((s) => s.trim()).filter(Boolean)
		: [];

	// The prompt is the body under "What the person wants (their own words)".
	const prompt = sectionBody(lines, /what the person wants/i).trim();

	// The "Complete when" list: the bullet items under that heading.
	const completeBody = sectionBody(lines, /complete when/i);
	const completeWhen = completeBody
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith('- '))
		.map((l) => l.replace(/^-\s+/, '').trim())
		.filter(Boolean);

	if (!id) throw new Error(`${file}: missing id`);
	if (completeWhen.length === 0) throw new Error(`${file}: empty or missing "Complete when" list`);

	return {
		id,
		name,
		size,
		source,
		theme,
		paired,
		teamMode,
		bigApp,
		admin,
		modules,
		prompt,
		completeWhen,
		file,
	};
}

/** Text between a heading matching `re` and the next heading (any level). */
function sectionBody(lines: string[], re: RegExp): string {
	let start = -1;
	let headingLevel = 0;
	for (let i = 0; i < lines.length; i++) {
		const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
		if (h && re.test(h[2])) {
			start = i + 1;
			headingLevel = h[1].length;
			break;
		}
	}
	if (start < 0) return '';
	const out: string[] = [];
	for (let i = start; i < lines.length; i++) {
		const h = /^(#{1,6})\s+/.exec(lines[i]);
		if (h && h[1].length <= headingLevel) break;
		out.push(lines[i]);
	}
	return out.join('\n');
}

/** Load and parse every brief file in a directory, sorted by file name. */
export function loadBriefs(dir: string): Brief[] {
	const { readdirSync } = require('node:fs') as typeof import('node:fs');
	return readdirSync(dir)
		.filter((f) => f.endsWith('.md'))
		.sort()
		.map((f) => parseBrief(readFileSync(join(dir, f), 'utf8'), f));
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign cap (D5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads total campaign spend so far, in micros. The live implementation sums
 * build_spend_reservations (settled + reserved) against build_spend_limits per
 * plan section 4; those tables arrive with the foundations lane, so the runner
 * codes against the names and the cap is unit-tested with a fake reader.
 */
export interface SpendReader {
	totalSpentMicros(): Promise<number>;
}

export class CampaignCapError extends Error {
	constructor(
		message: string,
		readonly spentMicros: number,
		readonly buildLimitMicros: number,
		readonly capMicros: number,
	) {
		super(message);
		this.name = 'CampaignCapError';
	}
}

export interface CapDecision {
	allowed: true;
	remainingMicros: number;
}

/**
 * The campaign-wide cap check (D5): refuse to start a build unless what has been
 * spent so far PLUS this build's limit fits under the cap. The direction is
 * conservative — the build's full limit, not its expected cost, must fit.
 */
export async function reserveAgainstCap(
	reader: SpendReader,
	opts: { capMicros: number; buildLimitMicros: number; outstandingLiabilityMicros?: number },
): Promise<CapDecision> {
	const spent = await reader.totalSpentMicros();
	// FINDING #7 (review 2026-10-23): a build that TIMED OUT is not proven
	// terminated — its coordinator can still spend up to the rest of its build
	// limit after driveBrief returned. That unspent allowance is real liability
	// the spend tables do not yet show, so the cap must count it alongside what
	// is already spent. Without this, build A ($40 limit) timing out after $1
	// lets build B ($40) in on a $50 cap while A can still spend $39 → $79.
	const outstanding = Math.max(0, opts.outstandingLiabilityMicros ?? 0);
	const wouldBe = spent + outstanding + opts.buildLimitMicros;
	if (wouldBe > opts.capMicros) {
		const d = (n: number) => `$${(n / USD).toFixed(2)}`;
		const liabilityNote = outstanding > 0 ? ` + outstanding liability ${d(outstanding)}` : '';
		throw new CampaignCapError(
			`campaign cap would be exceeded: spent ${d(spent)}${liabilityNote} + build limit ${d(
				opts.buildLimitMicros,
			)} = ${d(wouldBe)} > cap ${d(opts.capMicros)}`,
			spent,
			opts.buildLimitMicros,
			opts.capMicros,
		);
	}
	return { allowed: true, remainingMicros: opts.capMicros - wouldBe };
}

// ─────────────────────────────────────────────────────────────────────────────
// "Complete" rule (plan part I)
// ─────────────────────────────────────────────────────────────────────────────

export interface BriefRunResult {
	briefId: string;
	everyFeaturePassed: boolean;
	verifyBuildGreen: boolean;
	everyContractCheckGreen: boolean;
	browserCheckPassed: boolean;
}

export interface CompleteVerdict {
	complete: boolean;
	reason: string;
}

/**
 * "Complete" (plan part I): every feature passed; verify_build is green; every
 * contract check is green; the browser check passes. Anything short is not
 * complete, and the reason names the first failed gate.
 */
export function evaluateComplete(r: BriefRunResult): CompleteVerdict {
	if (!r.everyFeaturePassed) return { complete: false, reason: 'not every feature passed' };
	if (!r.verifyBuildGreen) return { complete: false, reason: 'verify_build is not green' };
	if (!r.everyContractCheckGreen) return { complete: false, reason: 'a contract check is not green' };
	if (!r.browserCheckPassed) return { complete: false, reason: 'the browser check did not pass' };
	return { complete: true, reason: 'every feature passed; verify_build, contract checks and browser check are green' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 go/no-go marks (a tie at zero fails)
// ─────────────────────────────────────────────────────────────────────────────

export const section10Marks = {
	teamMode: {
		minComplete: 8, // ≥ 8 of 12 team-mode briefs
		total: 12,
		minPaired: 4, // ≥ 4 of 5 paired briefs in team mode
		pairedTotal: 5,
		ownerMinComplete: 6, // else owner if ≥ 6 of 12
	},
	bigApps: {
		ownerMinFraction: 0.75, // ≥ 75% modules merged → owner
		onFraction: 1, // 100% → on for judges
	},
} as const;

export type SwitchValue = 'off' | 'owner' | 'on';
export interface SwitchVerdict {
	value: SwitchValue;
	reason: string;
}

export interface TeamModeInputs {
	fullGateGreen: boolean;
	teamModeComplete: number;
	teamModeTotal: number;
	pairedCompleteTeam: number;
	pairedCompleteBaseline: number;
	pairedTotal: number;
	farmLogComplete: boolean;
	herdVoiceComplete: boolean;
	limitOverruns: number;
	unreceiptedClaims: number;
	withinCap: boolean;
}

export interface BigAppsInputs {
	modulesMerged: number;
	modulesTotal: number;
	everyCheckGreen: boolean;
	browserCheckPassed: boolean;
}

export function scoreSwitch(switchName: 'team_mode', inputs: TeamModeInputs): SwitchVerdict;
export function scoreSwitch(switchName: 'big_apps', inputs: BigAppsInputs): SwitchVerdict;
export function scoreSwitch(
	switchName: 'team_mode' | 'big_apps',
	inputs: TeamModeInputs | BigAppsInputs,
): SwitchVerdict {
	if (switchName === 'team_mode') return scoreTeamMode(inputs as TeamModeInputs);
	return scoreBigApps(inputs as BigAppsInputs);
}

function scoreTeamMode(i: TeamModeInputs): SwitchVerdict {
	const m = section10Marks.teamMode;

	// The absolute marks are applied FIRST. A tie at zero (team completes as
	// many as the baseline because both are zero) fails, because the absolute
	// thresholds below are not met.
	const tieAtZero = i.pairedCompleteTeam === 0 && i.pairedCompleteBaseline === 0;

	const onOk =
		i.fullGateGreen &&
		i.teamModeComplete >= m.minComplete &&
		i.pairedCompleteTeam >= m.minPaired &&
		i.pairedCompleteTeam >= i.pairedCompleteBaseline &&
		i.farmLogComplete &&
		i.herdVoiceComplete &&
		i.limitOverruns === 0 &&
		i.unreceiptedClaims === 0 &&
		i.withinCap &&
		!tieAtZero;

	if (onOk) {
		return { value: 'on', reason: `all absolute marks met (${i.teamModeComplete}/${i.teamModeTotal} complete)` };
	}

	if (tieAtZero && i.teamModeComplete < m.ownerMinComplete) {
		return {
			value: 'off',
			reason: 'a tie at zero fails: team mode completed 0 of the paired briefs and the absolute marks are not met',
		};
	}

	if (i.teamModeComplete >= m.ownerMinComplete) {
		return { value: 'owner', reason: `${i.teamModeComplete}/${i.teamModeTotal} complete → owner (not enough for on)` };
	}

	return { value: 'off', reason: `only ${i.teamModeComplete}/${i.teamModeTotal} complete → off` };
}

function scoreBigApps(i: BigAppsInputs): SwitchVerdict {
	const m = section10Marks.bigApps;
	const fraction = i.modulesTotal > 0 ? i.modulesMerged / i.modulesTotal : 0;
	const checksOk = i.everyCheckGreen && i.browserCheckPassed;

	if (checksOk && fraction >= m.onFraction) {
		return { value: 'on', reason: '100% of modules merged, every check green → on for judges' };
	}
	if (checksOk && fraction >= m.ownerMinFraction) {
		return { value: 'owner', reason: `${i.modulesMerged}/${i.modulesTotal} modules merged (≥75%) → owner` };
	}
	return { value: 'off', reason: `only ${i.modulesMerged}/${i.modulesTotal} modules merged → off` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate (honesty)
// ─────────────────────────────────────────────────────────────────────────────

export type GateResult =
	| { ok: true; env: Record<string, string> }
	| { ok: false; reason: string };

/**
 * The live gate. CADDIE_LIVE_AUTHORIZED MUST be '1' in the PROCESS env — it is
 * never read from .dev.vars. Credentials may come from .dev.vars or the env.
 * `env` is injectable for the offline test; the real call passes the merged
 * process-env + .dev.vars map, but takes the authorization flag from
 * process.env only.
 */
export function gate(env: Record<string, string | undefined>): GateResult {
	const authorized = env.CADDIE_LIVE_AUTHORIZED === '1';
	const baseUrl = env.CADDIE_DEV_BASE_URL;
	// No test accounts: the live run uses the owner's saved sign-in (--sign-in),
	// and the browser check's two users are users of the built app.
	const missing = [
		!authorized && 'CADDIE_LIVE_AUTHORIZED=1 (explicit authorization in the process env, never from .dev.vars)',
		!baseUrl && 'CADDIE_DEV_BASE_URL (the local `bun run dev` base, e.g. http://localhost:5176, the pinned dev port where Google sign-in works)',
	].filter(Boolean) as string[];
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `BLOCKED — the live campaign requires explicit authorization and the local base URL. Missing: ${missing.join('; ')}.`,
		};
	}
	return { ok: true, env: env as Record<string, string> };
}

/**
 * The gate for `--sign-in` (item 1): it opens a visible browser for the owner,
 * so it needs authorization and the local base URL, but NOT the A/B/C test
 * accounts — only the owner's own Caddie account is used. Same honesty rule:
 * CADDIE_LIVE_AUTHORIZED is read from the process env only.
 */
export function signInGate(env: Record<string, string | undefined>): GateResult {
	const authorized = env.CADDIE_LIVE_AUTHORIZED === '1';
	const baseUrl = env.CADDIE_DEV_BASE_URL;
	const missing = [
		!authorized && 'CADDIE_LIVE_AUTHORIZED=1 (explicit authorization in the process env, never from .dev.vars)',
		!baseUrl && 'CADDIE_DEV_BASE_URL (the local `bun run dev` base, e.g. http://localhost:5176, the pinned dev port where Google sign-in works)',
	].filter(Boolean) as string[];
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `BLOCKED — --sign-in requires explicit authorization and the local base URL. Missing: ${missing.join('; ')}.`,
		};
	}
	return { ok: true, env: env as Record<string, string> };
}

// ─────────────────────────────────────────────────────────────────────────────
// .dev.vars loading (values never printed)
// ─────────────────────────────────────────────────────────────────────────────

const DEV_VARS_CANDIDATES = [
	join(REPO, '.dev.vars'),
	join(REPO, '..', '.dev.vars'),
	join(REPO, '..', '..', '.dev.vars'),
];

function loadDevVars(): Record<string, string> {
	const values: Record<string, string> = {};
	const path = DEV_VARS_CANDIDATES.find((c) => existsSync(c));
	if (!path) return values;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq <= 0) continue;
		values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return values;
}

function redact(value: string | undefined): string {
	return value ? 'present' : 'absent';
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign orchestration (steps 1-6 composed; injectable, so it is tested with
// fakes and NEVER runs live or starts a paid build from a test)
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountSession } from './brief-run/dev-client.ts';
import type { Clock } from './brief-run/clock.ts';
import { driveBrief, type ProposalReader, type CoordinatorSend } from './brief-run/driver.ts';
import { readBuildResults, totalCampaignSpentMicros, type D1Query } from './brief-run/d1-reader.ts';
import type { BrowserCheck, BrowserCheckResult } from './brief-run/browser-check.ts';
import { pickRecordTargetFromDesign } from './brief-run/app-users.ts';
import {
	appendRun,
	ledgerSpentMicros,
	type Ledger,
	type LedgerRunRecord,
	type LedgerStore,
} from './brief-run/ledger.ts';
import { isTeamMode, type RunMode } from './brief-run/mode.ts';

/** The seams the campaign is driven over — every one injectable for tests. */
export interface CampaignSeams {
	/** The OWNER's Caddie session (item 1): drives the start flow and reads the
	 * test inbox for the two app-user sign-ins (item 2). */
	sessionA: AccountSession;
	/** Kept for the start flow's symmetry; the browser check no longer uses a
	 * second Caddie account (item 2 uses two APP users, both from the owner). */
	sessionB: AccountSession;
	clock: Clock;
	/** Read-only D1 query against the local dev DB. */
	d1: D1Query;
	/** Item 3: total campaign spend so far from the REAL spend tables
	 * (build_spend_reservations across all payers, through the d1-reader seam).
	 * The cap is enforced from THIS, not the ledger; the ledger is a cross-check.
	 * Injectable so a test proves the cap from the real-tables figure. */
	spendReader: SpendReader;
	/** Read the newest project_proposals row for the Home project (step 3). */
	readProposal: ProposalReader;
	/** Send the brief to the Home coordinator over Flue's HTTP route (step 2). */
	coordinatorSend: CoordinatorSend;
	/** Read the approved design DOCUMENT markdown for a project (item 2), so the
	 * browser check can pick the person-owned record from its architecture block. */
	readDesignDoc: (projectId: string) => Promise<string>;
	/** The browser check with two APP users (A persists + screen renders, B can't see). */
	browserCheck: BrowserCheck;
	/** The ledger store (file-backed live; in-memory in tests). */
	ledgerStore: LedgerStore;
	/** The dev base, for the browser check's preview URL. */
	base: string;
	/** The owner's Caddie-session cookie header (item 1), for the test-inbox read. */
	ownerCookie: string;
	/** The owner's saved Playwright storageState file (item 1), so each app user
	 * opens the preview page as the owner with its own fresh app-cookie jar. */
	ownerStoragePath: string;
	workspaceId: string;
	/** The signed-in account A id, used as the run's payer (step 2). */
	payerId: string;
	/** The coordinator model route id (coordinator.ts COORDINATOR_MODEL_ROUTE). */
	coordinatorModelRouteId: string;
}

export interface CampaignOptions {
	mode: RunMode;
	capMicros: number;
	pollEveryMs: number;
	/** Only drive these brief ids (the smoke run drives one). Empty = all. */
	onlyBriefIds?: string[];
}

export interface CampaignRunRow {
	briefId: string;
	size: BriefSize;
	mode: RunMode;
	capAllowed: boolean;
	complete: CompleteVerdict;
	result: BriefRunResult | null;
	stopReason: string | null;
	buildSpentMicros: number | null;
	/** Item 3: the real-tables spend-so-far the cap was enforced against. */
	realSpentBeforeMicros: number;
	/** Item 3: the ledger's own spend figure (the cross-check). */
	ledgerSpentBeforeMicros: number;
	/** Item 3: set when the real-tables figure and the ledger figure differ. */
	spendCrossCheckNote: string | null;
}

/**
 * Run the campaign over the injected seams. For each brief:
 *   1. check the D5 cap against the REAL spend tables' total-so-far PLUS this
 *      build's limit (item 3) — refuse (and record) a build that would not fit.
 *      The ledger's own figure is computed too, as a CROSS-CHECK that is
 *      reported only when the two differ;
 *   2. drive the brief to a terminal build outcome (driveBrief, step 2);
 *   3. read the build's results from D1 (step 3);
 *   4. if the build is ready, run the two-app-user browser check (step 4);
 *   5. judge "complete" and append the run to the ledger (step 5).
 *
 * The cap is enforced from the REAL spend tables (seams.spendReader), so a
 * crashed campaign that never wrote a ledger row is still held under the cap by
 * what the build payers actually reserved/settled. NO build is ever started
 * from a test: the drive and D1 seams are fakes there.
 */
export async function runCampaign(
	briefs: Brief[],
	seams: CampaignSeams,
	opts: CampaignOptions,
): Promise<{ ledger: Ledger; rows: CampaignRunRow[] }> {
	const rows: CampaignRunRow[] = [];
	let ledger: Ledger | null = seams.ledgerStore.read();
	const only = new Set(opts.onlyBriefIds ?? []);
	// FINDING #7: unspent allowance of builds that timed out and were not proven
	// terminated. Carried into every later admission so the cap cannot be
	// overshot by a background build that is still able to spend.
	let outstandingLiabilityMicros = 0;

	for (const brief of briefs) {
		if (only.size > 0 && !only.has(brief.id)) continue;
		const size = brief.size;
		const buildLimitMicros = size === 'big' ? BIG_BUILD_LIMIT_MICROS : SMALL_BUILD_LIMIT_MICROS;

		// 1. Cap check against the REAL spend tables (item 3, D5). The ledger's
		//    own figure is computed as a CROSS-CHECK only, reported when it
		//    diverges from the real tables (e.g. a build that spent but never
		//    wrote a ledger row, or vice versa).
		const realSpentBefore = await seams.spendReader.totalSpentMicros();
		const ledgerSpentBefore = ledger ? ledgerSpentMicros(ledger) : 0;
		const spendCrossCheckNote =
			realSpentBefore !== ledgerSpentBefore
				? `spend cross-check differs: real tables ${(realSpentBefore / USD).toFixed(2)} vs ledger ${(ledgerSpentBefore / USD).toFixed(2)} (the cap used the real tables)`
				: null;

		let capAllowed = true;
		let capReason = 'allowed';
		try {
			const d = await reserveAgainstCap(
				{ totalSpentMicros: async () => realSpentBefore },
				{ capMicros: opts.capMicros, buildLimitMicros, outstandingLiabilityMicros },
			);
			capReason = `allowed; ${(d.remainingMicros / USD).toFixed(2)} remaining${
				outstandingLiabilityMicros > 0 ? ` (after $${(outstandingLiabilityMicros / USD).toFixed(2)} outstanding from timed-out builds)` : ''
			}`;
		} catch (error) {
			capAllowed = false;
			capReason = error instanceof Error ? error.message : String(error);
		}

		if (!capAllowed) {
			const record = ledgerRecord({ brief, opts, buildLimitMicros, spentBefore: realSpentBefore, capAllowed, capReason, result: null, stopReason: 'cap-refused', complete: { complete: false, reason: capReason }, buildSpentMicros: null });
			ledger = appendRun(seams.ledgerStore, opts.capMicros, record);
			rows.push({ briefId: brief.id, size, mode: opts.mode, capAllowed, complete: { complete: false, reason: record.completeReason }, result: null, stopReason: 'cap-refused', buildSpentMicros: null, realSpentBeforeMicros: realSpentBefore, ledgerSpentBeforeMicros: ledgerSpentBefore, spendCrossCheckNote });
			continue;
		}

		// 2. Drive the brief to a terminal outcome through the real start flow.
		const drive = await driveBrief(
			seams.sessionA,
			seams.clock,
			{
				prompt: brief.prompt,
				briefId: brief.id,
				teamMode: isTeamMode(opts.mode),
				buildWaitMs: size === 'big' ? BIG_BUILD_WAIT_MS : SMALL_BUILD_WAIT_MS,
				pollEveryMs: opts.pollEveryMs,
				coordinatorModelRouteId: seams.coordinatorModelRouteId,
				payerId: seams.payerId,
				proposalWaitMs: 30 * 60 * 1000,
				planWaitMs: 30 * 60 * 1000,
				designWaitMs: 30 * 60 * 1000,
			},
			{ readProposal: seams.readProposal, coordinatorSend: seams.coordinatorSend },
		);

		// 3. Read the results from D1.
		const d1 = drive.runId ? await readBuildResults(seams.d1, { projectId: drive.projectId, runId: drive.runId }) : null;

		// 4. Browser check with two APP users, only on a ready build with a
		//    preview. The record is chosen from the approved design's
		//    architecture block (the first person-owned table with a create
		//    route and a screen). An app with no such table is "not applicable"
		//    — recorded, never counted as passed.
		let browserPassed = false;
		let browserVerdict: BrowserCheckResult['verdict'] | 'skipped' = 'skipped';
		let browserReason = 'build not ready';
		if (drive.outcome === 'ready' && drive.previewId) {
			// A real browser can time out or crash: that is this build's failed
			// check, recorded with its reason, never the end of the campaign.
			try {
				const designDoc = await seams.readDesignDoc(drive.projectId);
				const choice = pickRecordTargetFromDesign(designDoc);
				const check = await seams.browserCheck({
					base: seams.base,
					previewPageUrl: `${seams.base}/app/preview?${new URLSearchParams({ project: drive.projectId, preview: drive.previewId, source: 'workflow' }).toString()}`,
					ownerStoragePath: seams.ownerStoragePath,
					ownerCookie: seams.ownerCookie,
					projectId: drive.projectId,
					target: choice.applicable ? choice.target : null,
					markerA: `campaign-${brief.id}-a-${Date.now()}`,
					markerB: `campaign-${brief.id}-b-${Date.now()}`,
					timeoutMs: 2 * 60 * 1000,
				});
				browserPassed = check.verdict === 'pass';
				browserVerdict = check.verdict;
				browserReason = check.reason;
			} catch (error) {
				browserPassed = false;
				browserVerdict = 'fail';
				browserReason = `the browser check could not finish: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		void browserVerdict;

		// 5. Judge "complete" from the real gates.
		const result: BriefRunResult = {
			briefId: brief.id,
			everyFeaturePassed: d1?.everyFeaturePassed ?? false,
			verifyBuildGreen: d1?.verifyBuildGreen ?? false,
			everyContractCheckGreen: d1?.everyContractCheckGreen ?? false,
			browserCheckPassed: browserPassed,
		};
		const complete = evaluateComplete(result);
		const browserNote = drive.outcome === 'ready' && drive.previewId ? `; browser ${browserVerdict}: ${browserReason}` : '';
		const stopReason = (d1 ? `${d1.phase}${d1.detail ? `: ${d1.detail}` : ''}` : drive.outcome) + browserNote + (spendCrossCheckNote ? `; ${spendCrossCheckNote}` : '');
		const buildSpentMicros = d1?.spentMicros ?? null;

		// FINDING #7: a timed-out build is not proven stopped. Its unspent
		// allowance (limit minus what it has spent so far) stays claimable by its
		// still-running coordinator, so carry it as outstanding liability into
		// every later admission. ready/blocked are terminal — no carry.
		if (drive.outcome === 'timeout') {
			outstandingLiabilityMicros += Math.max(0, buildLimitMicros - (buildSpentMicros ?? 0));
		}

		const record = ledgerRecord({ brief, opts, buildLimitMicros, spentBefore: realSpentBefore, capAllowed, capReason, result, stopReason, complete, buildSpentMicros });
		ledger = appendRun(seams.ledgerStore, opts.capMicros, record);
		rows.push({ briefId: brief.id, size, mode: opts.mode, capAllowed, complete, result, stopReason, buildSpentMicros, realSpentBeforeMicros: realSpentBefore, ledgerSpentBeforeMicros: ledgerSpentBefore, spendCrossCheckNote });
	}

	return { ledger: ledger ?? { campaign: 'team-mode-monday', cap_micros: opts.capMicros, runs: [] }, rows };
}

function ledgerRecord(args: {
	brief: Brief;
	opts: CampaignOptions;
	buildLimitMicros: number;
	spentBefore: number;
	capAllowed: boolean;
	capReason: string;
	result: BriefRunResult | null;
	stopReason: string | null;
	complete: CompleteVerdict;
	buildSpentMicros: number | null;
}): LedgerRunRecord {
	return {
		at: new Date().toISOString(),
		briefId: args.brief.id,
		size: args.brief.size,
		mode: args.opts.mode,
		buildLimitMicros: args.buildLimitMicros,
		capMicros: args.opts.capMicros,
		spentBeforeMicros: args.spentBefore,
		capAllowed: args.capAllowed,
		capReason: args.capReason,
		buildSpentMicros: args.buildSpentMicros,
		complete: args.complete.complete,
		completeReason: args.complete.reason,
		stopReason: args.stopReason,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// main — wires the REAL seams behind the gate. Never reached from a test.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Item 1 — `--sign-in`. Open a visible Chromium at `${base}/app/`, wait (up to
 * 10 minutes) for the owner to sign in, and save the browser storage state to
 * tests/briefs/runs/.auth/owner.json. Never reached from a test; the flow seam
 * (playwrightSignInPage) is the only thing that launches a browser.
 */
async function runOwnerSignIn(env: Record<string, string | undefined>): Promise<number> {
	const gated = signInGate(env);
	if (!gated.ok) {
		console.error(`brief-run: ${gated.reason}`);
		return 1;
	}
	const base = gated.env.CADDIE_DEV_BASE_URL;
	const { assertLocalBase } = await import('./brief-run/dev-client.ts');
	const { runSignInFlow, playwrightSignInPage } = await import('./brief-run/sign-in.ts');
	const { saveStorageState, ownerAuthPath } = await import('./brief-run/auth-store.ts');
	const { systemClock } = await import('./brief-run/clock.ts');
	const authPath = ownerAuthPath(join(BRIEFS_DIR, 'runs'));

	console.error(`brief-run --sign-in: opening a visible browser at ${base}/app/. Sign in as the owner; I'll save your session when /api/home-project answers (up to 10 minutes).`);
	try {
		assertLocalBase(base); // refuse a non-local base before opening a browser
		const { state, waitedMs } = await runSignInFlow(playwrightSignInPage, systemClock, { baseUrl: base });
		saveStorageState(authPath, state);
		console.error(`brief-run --sign-in: saved the owner's session to ${authPath} after ${Math.round(waitedMs / 1000)}s. Later runs will load their cookies from it.`);
		return 0;
	} catch (error) {
		console.error(`brief-run --sign-in: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

async function main(): Promise<number> {
	// Authorization is taken from the PROCESS env ONLY; credentials may come
	// from .dev.vars. The merged map is used for credentials; the flag is read
	// from process.env so a .dev.vars value can never open the gate.
	const devVars = loadDevVars();
	const env: Record<string, string | undefined> = {
		...devVars,
		...process.env,
		CADDIE_LIVE_AUTHORIZED: process.env.CADDIE_LIVE_AUTHORIZED,
	};

	// Item 1: `--sign-in` opens a visible browser for the owner and saves the
	// cookies every later run uses. It has its own lighter gate (no A/B/C
	// accounts) and does NOT run the campaign.
	if (process.argv.slice(2).includes('--sign-in')) {
		return runOwnerSignIn(env);
	}

	const gated = gate(env);
	if (!gated.ok) {
		console.error(`brief-run: ${gated.reason}`);
		return 1;
	}

	// Resolve the run mode (step 6) and the cap (D5).
	const { resolveRunMode } = await import('./brief-run/mode.ts');
	const mode = resolveRunMode({ argv: process.argv.slice(2), teamModeEnv: process.env.TEAM_MODE });
	const capMicros = process.env.CADDIE_CAMPAIGN_CAP_MICROS
		? Number(process.env.CADDIE_CAMPAIGN_CAP_MICROS)
		: DEFAULT_CAMPAIGN_CAP_MICROS;

	const base = gated.env.CADDIE_DEV_BASE_URL;
	console.error(
		`brief-run: gate open — base ${base}, mode ${mode}, ` +
			`signing in with the owner's saved session, model key ${redact(gated.env.NEBIUS_API_KEY)}. No secret values are printed.`,
	);

	// Build the REAL seams. These touch the network / wrangler / Chromium and
	// are only ever constructed here, behind the gate.
	const { DevClient } = await import('./brief-run/dev-client.ts');
	const { systemClock } = await import('./brief-run/clock.ts');
	const { wranglerD1Query } = await import('./brief-run/d1-live.ts');
	const { playwrightBrowserCheck } = await import('./brief-run/browser-check.ts');
	const { fileLedgerStore } = await import('./brief-run/ledger.ts');

	const client = new DevClient(base, (input, init) => fetch(input, init));

	// Item 1: load the OWNER's saved sign-in (never the stub provider, which
	// cannot sign in against the owner's real Google sign-in). A missing file or
	// a 401 stops the run with one plain sentence telling the owner to run
	// `--sign-in`. Only the owner's one Caddie account is used; both the API
	// seams and the browser check carry its cookies.
	const { requireOwnerSignIn, ownerAuthPath } = await import('./brief-run/auth-store.ts');
	const { SignInRequiredError } = await import('./brief-run/auth-store.ts');
	const authPath = ownerAuthPath(join(BRIEFS_DIR, 'runs'));
	let ownerCookieHeader: string;
	try {
		const owner = await requireOwnerSignIn({
			path: authPath,
			baseUrl: base,
			probe: async (cookieHeader) => {
				const res = await client.sessionFromCookieHeader({ label: 'A', sub: 'owner', email: 'owner', name: 'Owner' }, cookieHeader).fetch('/api/home-project');
				return res.status;
			},
		});
		ownerCookieHeader = owner.cookieHeader;
	} catch (error) {
		if (error instanceof SignInRequiredError) {
			console.error(`brief-run: ${error.message}`);
			return 1;
		}
		throw error;
	}
	// A is the owner's session; B is the same owner session (the two browser-app
	// users in item 2 are both driven from the owner's one Caddie session).
	const sessionA = client.sessionFromCookieHeader({ label: 'A', sub: 'owner', email: 'owner', name: 'Owner' }, ownerCookieHeader);
	const sessionB = client.sessionFromCookieHeader({ label: 'B', sub: 'owner', email: 'owner', name: 'Owner' }, ownerCookieHeader);

	// The workspace the fresh account lands in. The home-project route returns
	// it; a missing workspace is a live-only gap and surfaces as a thrown error.
	const home = (await sessionA.json<{ project?: { id?: string; workspaceId?: string } }>(`/api/home-project`).catch(() => ({}))) as { project?: { id?: string; workspaceId?: string } };
	const workspaceId = home.project?.workspaceId ?? '';

	// Step 2/3 seams. The payer is account A's own id; the coordinator model
	// route mirrors coordinator.ts COORDINATOR_MODEL_ROUTE. readProposal reads
	// the server-of-record (project_proposals) over the same read-only D1 seam;
	// coordinatorSend POSTs the browser's body to the Flue coordinator route.
	const { readNewestProposal } = await import('./brief-run/d1-reader.ts');
	const d1 = wranglerD1Query(REPO);
	const session = (await sessionA.json<{ user?: { id?: string } }>(`/api/auth/get-session`).catch(() => ({}) as { user?: { id?: string } }));
	const payerId = session.user?.id;
	if (!payerId) {
		console.error('brief-run: Caddie did not say who is signed in. Run `bun scripts/brief-run.ts --sign-in` again, then rerun.');
		return 1;
	}
	const readProposal: ProposalReader = (opts) => readNewestProposal(d1, opts);
	const coordinatorSend: CoordinatorSend = async ({ conversationId, idempotencyKey, body }) => {
		const res = await sessionA.fetch(`/agents/coordinator/${encodeURIComponent(conversationId)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ idempotencyKey, kind: 'user', body }),
		});
		if (!res.ok) throw new Error(`coordinator send → HTTP ${res.status}`);
	};

	// Item 2: read the design markdown for a project, so the browser check can
	// pick the person-owned record from its architecture block. GET /workflow
	// returns the latest design revision as `design` (a plan_doc_revisions row);
	// its `body` carries the caddie-architecture block.
	const readDesignDoc = async (projectId: string): Promise<string> => {
		const snap = await sessionA.json<{ design?: { body?: string } | null }>(`/api/projects/${projectId}/workflow`);
		return snap.design?.body ?? '';
	};

	const briefs = loadBriefs(BRIEFS_DIR);
	console.error(`brief-run: ${briefs.length} briefs loaded (${briefs.filter((b) => b.size === 'big').length} big).`);

	const { ledger, rows } = await runCampaign(
		briefs,
		{
			sessionA,
			sessionB,
			clock: systemClock,
			d1,
			spendReader: { totalSpentMicros: () => totalCampaignSpentMicros(d1) },
			readProposal,
			coordinatorSend,
			readDesignDoc,
			browserCheck: playwrightBrowserCheck,
			ledgerStore: fileLedgerStore(join(BRIEFS_DIR, 'runs', `campaign-${mode}.json`)),
			base,
			ownerCookie: ownerCookieHeader,
			ownerStoragePath: authPath,
			workspaceId,
			payerId,
			coordinatorModelRouteId: 'nemotron-3.5-super-vl',
		},
		{ mode, capMicros, pollEveryMs: 30_000, onlyBriefIds: process.env.CADDIE_ONLY_BRIEF ? [process.env.CADDIE_ONLY_BRIEF] : [] },
	);

	console.error('\n=== summary (judged by section 10) ===');
	console.error('brief                         size    mode      complete  stop');
	for (const r of rows) {
		console.error(
			`${r.briefId.padEnd(28)}  ${r.size.padEnd(6)}  ${r.mode.padEnd(8)}  ${r.complete.complete ? 'YES' : 'no '}      ${r.stopReason ?? ''}`,
		);
	}
	console.error(`\nledger: ${ledger.runs.length} run(s) recorded; ${(ledgerSpentMicros(ledger) / USD).toFixed(2)} spent of ${(capMicros / USD).toFixed(2)} cap.`);

	const anyComplete = rows.some((r) => r.complete.complete);
	// Exit nonzero while nothing is complete — never report a fabricated pass.
	return anyComplete ? 0 : 1;
}

if (import.meta.main) {
	process.exit(await main());
}
