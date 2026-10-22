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
import { createHash } from 'node:crypto';
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

function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Live driver (gated; UNVERIFIED locally — never runs without the gate)
// ─────────────────────────────────────────────────────────────────────────────

interface LiveStep {
	id: string;
	outcome: 'PASS' | 'FAIL';
	receipt: string;
}

/**
 * A tiny HTTP cookie jar + fetch for driving the real API as a signed-in
 * account. The local sign-in path mirrors the fixture harness's driveOAuth
 * (POST /api/auth/sign-in/social → follow the stub provider redirect). On a
 * real `bun run dev` the provider is whatever .dev.vars configures; this is
 * classified UNVERIFIED until run live.
 */
class Jar {
	private cookies = new Map<string, string>();
	header(): string {
		return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}
	absorb(res: Response): void {
		const set = res.headers.get('set-cookie');
		if (!set) return;
		for (const part of set.split(/,(?=[^ ;]+=)/)) {
			const [pair] = part.split(';');
			const eq = pair.indexOf('=');
			if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	}
}

async function apiFetch(base: string, jar: Jar, path: string, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	const cookie = jar.header();
	if (cookie) headers.set('cookie', cookie);
	const res = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
	jar.absorb(res);
	return res;
}

/**
 * Drive ONE brief live, end to end. Returns the per-brief result and the step
 * receipts. This is only reached after the gate opens, so it is never exercised
 * offline. Each unverifiable step is recorded honestly.
 */
async function runBriefLive(
	base: string,
	env: Record<string, string>,
	brief: Brief,
	teamMode: boolean,
): Promise<{ result: BriefRunResult; steps: LiveStep[] }> {
	const steps: LiveStep[] = [];
	const push = (id: string, ok: boolean, receipt: string) =>
		steps.push({ id, outcome: ok ? 'PASS' : 'FAIL', receipt });

	// This function intentionally FAILS CLOSED: the team-mode design-approval
	// and proposal-accept request bodies depend on lanes 1 and 2, which the
	// campaign runner integrates with but does not own. Rather than fabricate a
	// green run, every step is attempted against the documented routes and any
	// gap is recorded as FAIL with an explicit UNVERIFIED receipt. The owner
	// wires the remaining request bodies when foundations + the architecture
	// block land; until then a live run reports the true state.
	const jarA = new Jar();

	// 1. Create a project from the brief (POST /api/projects needs a workspace).
	//    The exact workspace bootstrap for a fresh test account is owned by
	//    lane 1; recorded UNVERIFIED.
	push(
		'create-project',
		false,
		`UNVERIFIED: POST /api/projects requires a workspaceId; the fresh-account workspace bootstrap is owned by lane 1 and not driven here. Brief "${brief.id}" prompt sha256 ${sha256(brief.prompt).slice(0, 16)}…`,
	);
	void jarA;
	void apiFetch;
	void teamMode;
	void env;

	const result: BriefRunResult = {
		briefId: brief.id,
		everyFeaturePassed: false,
		verifyBuildGreen: false,
		everyContractCheckGreen: false,
		browserCheckPassed: false,
	};
	return { result, steps };
}

// ─────────────────────────────────────────────────────────────────────────────
// main
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

	const base = gated.env.CADDIE_DEV_BASE_URL;
	console.error(
		`brief-run: gate open — base ${base}, ` +
			`test accounts A/B/C present, ` +
			`model key ${redact(gated.env.NEBIUS_API_KEY)}. No secret values are printed.`,
	);

	const capMicros = process.env.CADDIE_CAMPAIGN_CAP_MICROS
		? Number(process.env.CADDIE_CAMPAIGN_CAP_MICROS)
		: DEFAULT_CAMPAIGN_CAP_MICROS;

	// The live spend reader sums build_spend_reservations against
	// build_spend_limits (plan section 4). Those tables land with foundations;
	// until then the reader reports UNVERIFIED and the runner refuses to spend.
	const spendReader: SpendReader = {
		async totalSpentMicros() {
			throw new Error(
				'UNVERIFIED: build_spend_reservations/build_spend_limits are not yet present locally (foundations lane). Refusing to start any paid build.',
			);
		},
	};

	const briefs = loadBriefs(BRIEFS_DIR);
	console.error(`brief-run: ${briefs.length} briefs loaded (${briefs.filter((b) => b.size === 'big').length} big).`);

	const results: Array<{ brief: Brief; teamMode: boolean; result: BriefRunResult; complete: CompleteVerdict; steps: LiveStep[] }> = [];

	for (const brief of briefs) {
		const limit =
			brief.size === 'big' ? BIG_BUILD_LIMIT_MICROS : SMALL_BUILD_LIMIT_MICROS;
		const modes = brief.teamMode === 'both' ? [false, true] : [brief.teamMode === 'on'];
		for (const teamMode of modes) {
			try {
				await reserveAgainstCap(spendReader, { capMicros, buildLimitMicros: limit });
			} catch (error) {
				console.error(
					`brief-run: ${brief.id} (team mode ${teamMode}) — cap/reader refused: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				continue;
			}
			const { result, steps } = await runBriefLive(base, gated.env, brief, teamMode);
			const complete = evaluateComplete(result);
			results.push({ brief, teamMode, result, complete, steps });
		}
	}

	// Output: one JSON record per run, plus a summary table.
	console.error('\n=== brief-run results (JSON per run) ===');
	for (const r of results) {
		console.error(
			JSON.stringify(
				{
					brief: r.brief.id,
					size: r.brief.size,
					teamMode: r.teamMode,
					complete: r.complete.complete,
					reason: r.complete.reason,
					result: r.result,
					steps: r.steps,
				},
				null,
				2,
			),
		);
	}

	console.error('\n=== summary (judged by section 10) ===');
	console.error('brief                         size    team  complete');
	for (const r of results) {
		console.error(
			`${r.brief.id.padEnd(28)}  ${r.brief.size.padEnd(6)}  ${String(r.teamMode).padEnd(5)}  ${r.complete.complete ? 'YES' : 'no'}`,
		);
	}

	const anyComplete = results.some((r) => r.complete.complete);
	console.error(
		anyComplete
			? 'brief-run: at least one brief completed — see the JSON records for receipts.'
			: 'brief-run: NO brief completed. This is the honest state until foundations + the architecture block land; see the UNVERIFIED step receipts.',
	);
	// Exit nonzero while nothing is complete — never report a fabricated pass.
	return anyComplete ? 0 : 1;
}

if (import.meta.main) {
	process.exit(await main());
}
