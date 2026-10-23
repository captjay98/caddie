#!/usr/bin/env bun
/**
 * Campaign runner — plan `docs/plans/2026-10-22-software-team-mode.md` part I
 * (lane 8). It drives the REAL Caddie HTTP API on a local `bun run dev`
 * (127.0.0.1) as signed-in test accounts, starts a project from each brief,
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
	opts: { capMicros: number; buildLimitMicros: number },
): Promise<CapDecision> {
	const spent = await reader.totalSpentMicros();
	const wouldBe = spent + opts.buildLimitMicros;
	if (wouldBe > opts.capMicros) {
		const d = (n: number) => `$${(n / USD).toFixed(2)}`;
		throw new CampaignCapError(
			`campaign cap would be exceeded: spent ${d(spent)} + build limit ${d(
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
	const accountsPresent = Boolean(
		env.TEST_ACCOUNT_A_EMAIL && env.TEST_ACCOUNT_B_EMAIL && env.TEST_ACCOUNT_C_EMAIL,
	);
	const missing = [
		!authorized && 'CADDIE_LIVE_AUTHORIZED=1 (explicit authorization in the process env, never from .dev.vars)',
		!baseUrl && 'CADDIE_DEV_BASE_URL (the local `bun run dev` base, e.g. http://127.0.0.1:5173)',
		!accountsPresent && 'TEST_ACCOUNT_{A,B,C}_EMAIL (the signed-in test accounts A, B, C)',
	].filter(Boolean) as string[];
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `BLOCKED — the live campaign requires explicit authorization and local test credentials. Missing: ${missing.join('; ')}.`,
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
import { readBuildResults, type D1Query } from './brief-run/d1-reader.ts';
import type { BrowserCheck } from './brief-run/browser-check.ts';
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
	/** The signed-in account A session (and B for the browser check). */
	sessionA: AccountSession;
	sessionB: AccountSession;
	clock: Clock;
	/** Read-only D1 query against the local dev DB. */
	d1: D1Query;
	/** Read the newest project_proposals row for the Home project (step 3). */
	readProposal: ProposalReader;
	/** Send the brief to the Home coordinator over Flue's HTTP route (step 2). */
	coordinatorSend: CoordinatorSend;
	/** The browser check (A persists, B cannot see). */
	browserCheck: BrowserCheck;
	/** The ledger store (file-backed live; in-memory in tests). */
	ledgerStore: LedgerStore;
	/** The dev base, for the browser check's preview URL. */
	base: string;
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
}

/**
 * Run the campaign over the injected seams. For each brief:
 *   1. check the D5 cap against the ledger's spend-so-far PLUS this build's
 *      limit — refuse (and record) a build that would not fit;
 *   2. drive the brief to a terminal build outcome (driveBrief, step 2);
 *   3. read the build's results from D1 (step 3);
 *   4. if the build is ready, run the browser check (step 4);
 *   5. judge "complete" and append the run to the ledger (step 5).
 *
 * The cap is enforced from the LEDGER's own recorded spend, so a test proves it
 * across runs without any D1. NO build is ever started from a test: the drive
 * and D1 seams are fakes there.
 */
export async function runCampaign(
	briefs: Brief[],
	seams: CampaignSeams,
	opts: CampaignOptions,
): Promise<{ ledger: Ledger; rows: CampaignRunRow[] }> {
	const rows: CampaignRunRow[] = [];
	let ledger: Ledger | null = seams.ledgerStore.read();
	const only = new Set(opts.onlyBriefIds ?? []);

	for (const brief of briefs) {
		if (only.size > 0 && !only.has(brief.id)) continue;
		const size = brief.size;
		const buildLimitMicros = size === 'big' ? BIG_BUILD_LIMIT_MICROS : SMALL_BUILD_LIMIT_MICROS;
		const spentBefore = ledger ? ledgerSpentMicros(ledger) : 0;

		// 1. Cap check against the ledger's own spend (D5). Refuse and record.
		let capAllowed = true;
		let capReason = 'allowed';
		try {
			const d = await reserveAgainstCap(
				{ totalSpentMicros: async () => spentBefore },
				{ capMicros: opts.capMicros, buildLimitMicros },
			);
			capReason = `allowed; ${(d.remainingMicros / USD).toFixed(2)} remaining`;
		} catch (error) {
			capAllowed = false;
			capReason = error instanceof Error ? error.message : String(error);
		}

		if (!capAllowed) {
			const record = ledgerRecord({ brief, opts, buildLimitMicros, spentBefore, capAllowed, capReason, result: null, stopReason: 'cap-refused', complete: { complete: false, reason: capReason }, buildSpentMicros: null });
			ledger = appendRun(seams.ledgerStore, opts.capMicros, record);
			rows.push({ briefId: brief.id, size, mode: opts.mode, capAllowed, complete: record.complete ? { complete: true, reason: record.completeReason } : { complete: false, reason: record.completeReason }, result: null, stopReason: 'cap-refused', buildSpentMicros: null });
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

		// 4. Browser check, only on a ready build with a preview.
		let browserPassed = false;
		if (drive.outcome === 'ready' && drive.previewId) {
			const check = await seams.browserCheck({
				base: seams.base,
				previewUrl: `${seams.base}/api/projects/${drive.projectId}/workflow/preview/${drive.previewId}`,
				cookieA: seams.sessionA.jar.header(),
				cookieB: seams.sessionB.jar.header(),
				recordMarker: `campaign-${brief.id}-${Date.now()}`,
				timeoutMs: 2 * 60 * 1000,
			});
			browserPassed = check.passed;
		}

		// 5. Judge "complete" from the real gates.
		const result: BriefRunResult = {
			briefId: brief.id,
			everyFeaturePassed: d1?.everyFeaturePassed ?? false,
			verifyBuildGreen: d1?.verifyBuildGreen ?? false,
			everyContractCheckGreen: d1?.everyContractCheckGreen ?? false,
			browserCheckPassed: browserPassed,
		};
		const complete = evaluateComplete(result);
		const stopReason = d1 ? `${d1.phase}${d1.detail ? `: ${d1.detail}` : ''}` : drive.outcome;
		const buildSpentMicros = d1?.spentMicros ?? null;

		const record = ledgerRecord({ brief, opts, buildLimitMicros, spentBefore, capAllowed, capReason, result, stopReason, complete, buildSpentMicros });
		ledger = appendRun(seams.ledgerStore, opts.capMicros, record);
		rows.push({ briefId: brief.id, size, mode: opts.mode, capAllowed, complete, result, stopReason, buildSpentMicros });
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
			`test accounts A/B/C present, model key ${redact(gated.env.NEBIUS_API_KEY)}. No secret values are printed.`,
	);

	// Build the REAL seams. These touch the network / wrangler / Chromium and
	// are only ever constructed here, behind the gate.
	const { DevClient } = await import('./brief-run/dev-client.ts');
	const { systemClock } = await import('./brief-run/clock.ts');
	const { wranglerD1Query } = await import('./brief-run/d1-live.ts');
	const { playwrightBrowserCheck } = await import('./brief-run/browser-check.ts');
	const { fileLedgerStore } = await import('./brief-run/ledger.ts');

	const client = new DevClient(base, (input, init) => fetch(input, init));
	const sessionA = await client.signIn({ label: 'A', sub: 'campaign-a', email: gated.env.TEST_ACCOUNT_A_EMAIL, name: 'Campaign A' });
	const sessionB = await client.signIn({ label: 'B', sub: 'campaign-b', email: gated.env.TEST_ACCOUNT_B_EMAIL, name: 'Campaign B' });

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
	const payerId = session.user?.id ?? gated.env.TEST_ACCOUNT_A_EMAIL;
	const readProposal: ProposalReader = (opts) => readNewestProposal(d1, opts);
	const coordinatorSend: CoordinatorSend = async ({ conversationId, idempotencyKey, body }) => {
		const res = await sessionA.fetch(`/agents/coordinator/${encodeURIComponent(conversationId)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ idempotencyKey, kind: 'user', body }),
		});
		if (!res.ok) throw new Error(`coordinator send → HTTP ${res.status}`);
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
			readProposal,
			coordinatorSend,
			browserCheck: playwrightBrowserCheck,
			ledgerStore: fileLedgerStore(join(BRIEFS_DIR, 'runs', `campaign-${mode}.json`)),
			base,
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
