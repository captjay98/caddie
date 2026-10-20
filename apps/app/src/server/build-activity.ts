/**
 * Build activity — the app-owned record of what the build host actually did
 * in the sandbox, and the read the build-progress view polls.
 *
 * WRITE side (`recordBuildActivity`): called by the build host
 * (coordinator-host.ts) at the sandbox boundary for the scaffold upload, every
 * file write, every command and every host check. It records paths, command
 * lines, exit codes, parsed test counts, sizes and timing — never file
 * contents. Observability first: a failed insert is logged and swallowed, so
 * recording can never break or slow a build, and no authorization or
 * completion decision ever reads this table. Two BOUNDS do read it (the
 * per-build action budget and the repeated-action stop in coordinator-host.ts,
 * plus the stall watchdog's last-progress time): they read row counts,
 * subjects and timestamps only, so a dropped insert can only make a bound
 * more lenient, never refuse or stop a build wrongly.
 *
 * READ side (`buildActivity`): the existing step + run_rounds projection plus
 * the derived `timeline` (server/build-timeline.ts). Everything is derived
 * from recorded rows and the workflow snapshot; nothing is estimated.
 *
 * Why the app records this itself: Flue returns only a specialist's FINAL
 * answer to the parent conversation, so the browser's transcript cannot show
 * which files were written or which commands ran.
 */

import type { BuildFeatureView, Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope } from './scope.ts';
import { reconcileStalledBuild, workflowSnapshot } from './build-workflow.ts';
import { featureViewsFor } from './build-features.ts';
import { roundDetailText } from './round-detail.ts';
import {
	buildTimeline,
	isTestCommand,
	parseTestCounts,
	type ActivityKind,
	type ActivityOutcome,
	type ActivityRow,
	type BuildTimeline,
} from './build-timeline.ts';

/** A single deterministic step in the Plan → Build → Check → Preview arc. */
export interface BuildStep {
	readonly key: 'scaffold' | 'implement' | 'check' | 'preview';
	readonly label: string;
	/** done = finished, active = happening now, pending = not started. */
	readonly state: 'done' | 'active' | 'pending';
}

/** One real entry from the run_rounds ledger, worded for a person. */
export interface BuildRound {
	readonly issue: string;
	readonly round: string;
	readonly outcome: string;
	readonly detail: string | null;
	readonly at: string;
}

export interface BuildActivity {
	readonly projectId: string;
	/** Mirrors the workflow phase so the UI need not re-fetch it. */
	readonly phase: 'planning' | 'review' | 'building' | 'blocked' | 'ready';
	/** True only while the workflow is actually building. */
	readonly building: boolean;
	readonly steps: readonly BuildStep[];
	/** The real repair/verification history for this run, oldest first. */
	readonly rounds: readonly BuildRound[];
	/** How many distinct verification issues have at least one failed repair. */
	readonly openIssues: number;
	/** The detailed, derived timeline (stages, timing, files, commands, tests). */
	readonly timeline: BuildTimeline;
	/** The plan's features and where each stands (pending before the build starts). */
	readonly features: readonly BuildFeatureView[];
}

// --- write side --------------------------------------------------------------------

export interface BuildActivityInput {
	readonly projectId: string;
	readonly runId: string;
	readonly kind: ActivityKind;
	/** The acting specialist role when known; the host does not know it today. */
	readonly role?: string | null;
	/** File path, command line or check name. Never file contents. */
	readonly subject: string;
	readonly outcome: ActivityOutcome;
	readonly exitCode?: number | null;
	/** Command output, used ONLY to parse test counts; it is not stored. */
	readonly output?: string;
	readonly bytes?: number | null;
	readonly startedAt: string;
	readonly finishedAt: string;
	/**
	 * Replay-stable identity (e.g. the sandbox operation key). When the Durable
	 * Object recovers and re-runs a tool, the same key records one row, not two.
	 */
	readonly key?: string;
}

const SUBJECT_LIMIT = 500;

/** Record one real sandbox action. Never throws. */
export async function recordBuildActivity(db: D1Database, input: BuildActivityInput): Promise<void> {
	try {
		const counts =
			input.kind === 'command' && input.output !== undefined && isTestCommand(input.subject)
				? parseTestCounts(input.output)
				: input.kind === 'check' && input.output !== undefined
					? parseTestCounts(input.output)
					: null;
		const started = Date.parse(input.startedAt);
		const finished = Date.parse(input.finishedAt);
		const durationMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
		const id = input.key ? `act:${input.runId}:${input.key}` : `act_${globalThis.crypto.randomUUID()}`;
		await db
			.prepare(
				`insert or ignore into "build_activity"
				 ("id","projectId","runId","kind","role","subject","outcome","exitCode","testsPassed","testsFailed","bytes","startedAt","finishedAt","durationMs")
				 values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.bind(
				id,
				input.projectId,
				input.runId,
				input.kind,
				input.role ?? null,
				input.subject.slice(0, SUBJECT_LIMIT),
				input.outcome,
				input.exitCode ?? null,
				counts?.passed ?? null,
				counts?.failed ?? null,
				input.bytes ?? null,
				input.startedAt,
				input.finishedAt,
				durationMs,
			)
			.run();
	} catch (error) {
		// Observability must never break the build it observes.
		console.warn('build activity not recorded', error instanceof Error ? error.message : error);
	}
}

// --- read side ---------------------------------------------------------------------

const STEP_LABELS: Record<BuildStep['key'], string> = {
	scaffold: 'Set up the app from the recipe',
	implement: 'Build the features in the plan',
	check: 'Run the checks',
	preview: 'Capture the working preview',
};

/**
 * Derive the ordered steps from the phase + whether any verification/repair
 * rounds have been recorded yet. Deterministic and conservative: a step is
 * only `done` when the phase or a recorded round proves it, never guessed.
 */
function stepsFor(phase: BuildActivity['phase'], sawCheckActivity: boolean): BuildStep[] {
	const step = (key: BuildStep['key'], state: BuildStep['state']): BuildStep => ({
		key,
		label: STEP_LABELS[key],
		state,
	});
	if (phase === 'ready') {
		return [step('scaffold', 'done'), step('implement', 'done'), step('check', 'done'), step('preview', 'done')];
	}
	if (phase === 'blocked') {
		return [step('scaffold', 'done'), step('implement', 'done'), step('check', 'active'), step('preview', 'pending')];
	}
	if (phase === 'building') {
		return sawCheckActivity
			? [step('scaffold', 'done'), step('implement', 'done'), step('check', 'active'), step('preview', 'pending')]
			: [step('scaffold', 'done'), step('implement', 'active'), step('check', 'pending'), step('preview', 'pending')];
	}
	return [step('scaffold', 'pending'), step('implement', 'pending'), step('check', 'pending'), step('preview', 'pending')];
}

/** Activity rows for a run, oldest first. Missing table (old local DB) → none. */
async function activityRows(db: D1Database, runId: string): Promise<ActivityRow[]> {
	try {
		const result = await db
			.prepare(
				`select "kind","role","subject","outcome","exitCode","testsPassed","testsFailed","bytes","startedAt","finishedAt","durationMs"
				 from "build_activity" where "runId" = ? order by "startedAt" asc, "id" asc limit 2000`,
			)
			.bind(runId)
			.all();
		return ((result.results ?? []) as Record<string, unknown>[]).map((row) => ({
			kind: String(row['kind']) as ActivityKind,
			role: row['role'] == null ? null : String(row['role']),
			subject: String(row['subject']),
			outcome: String(row['outcome']) as ActivityOutcome,
			exitCode: row['exitCode'] == null ? null : Number(row['exitCode']),
			testsPassed: row['testsPassed'] == null ? null : Number(row['testsPassed']),
			testsFailed: row['testsFailed'] == null ? null : Number(row['testsFailed']),
			bytes: row['bytes'] == null ? null : Number(row['bytes']),
			startedAt: String(row['startedAt']),
			finishedAt: String(row['finishedAt']),
			durationMs: Number(row['durationMs'] ?? 0),
		}));
	} catch (error) {
		if (String(error).includes('no such table')) return [];
		throw error;
	}
}

export async function buildActivity(db: D1Database, scope: Scope, nowMs: number = Date.now()): Promise<BuildActivity> {
	await assertProjectScope(db, scope);
	// The progress card polls this read, so a stalled build is stopped here
	// (honestly, retryably) instead of reading "working" forever.
	await reconcileStalledBuild(db, scope.projectId, nowMs);
	const { workflow, plan } = await workflowSnapshot(db, scope);
	const phase = (workflow?.phase ?? 'planning') as BuildActivity['phase'];

	const roundRows = workflow
		? ((
				await db
					.prepare(
						'select "issue","round","outcome","detail","createdAt" from "run_rounds" where "runId" = ? order by "createdAt" asc, "id" asc',
					)
					.bind(workflow.runId)
					.all()
			).results as Record<string, unknown>[])
		: [];

	const rounds: BuildRound[] = roundRows.map((row) => ({
		issue: String(row['issue']),
		round: String(row['round']),
		outcome: String(row['outcome']),
		detail: roundDetailText(row['detail'] == null ? null : String(row['detail'])),
		at: String(row['createdAt']),
	}));

	const sawCheckActivity = rounds.some((r) => r.round === 'repair_attempt' || r.round === 'verification');
	const openIssues = new Set(
		rounds.filter((r) => r.round === 'repair_attempt' && r.outcome === 'failed').map((r) => r.issue),
	).size;

	const rows = workflow ? await activityRows(db, workflow.runId) : [];
	const timeline = buildTimeline({
		phase,
		rows,
		planBody: plan?.body ?? null,
		blockedDetail: workflow?.detail ?? null,
		nowMs,
	});

	return {
		projectId: scope.projectId,
		phase,
		building: phase === 'building',
		steps: stepsFor(phase, sawCheckActivity),
		rounds,
		openIssues,
		timeline,
		features: await featureViewsFor(db, scope.projectId, phase, plan ?? null),
	};
}
