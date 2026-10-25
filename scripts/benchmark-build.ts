/**
 * B08 build-benchmark local runner — UNPAID SCAFFOLDING.
 *
 * This stub plans runs and estimates cost. It makes NO paid or live model call.
 * A live pilot is refused unless BOTH an explicit `--allow-spend` flag AND a
 * positive `--budget-usd` ceiling are provided — and even then, the actual
 * execution path is intentionally not implemented here (it lands in a later,
 * separately-authorized change). The gate exists so the runner cannot spend by
 * accident or by a model deciding to "just try it".
 */

export interface BenchmarkTask {
	id: string;
	family: string;
	variant: number;
	work: string;
	brief: string;
	acceptance: { owner: string; checks: string[] };
}

export interface RunnerOptions {
	/** Must be explicitly true to permit any paid/live call. */
	allowSpend?: boolean;
	/** Per-run USD ceiling; must be > 0 alongside allowSpend. */
	budgetUsd?: number;
	/** Rough USD estimate per task run, for the dry-run cost estimate. */
	estPerRunUsd?: number;
	/** Formal-suite repeat count per task (protocol: >= 3). */
	repeats?: number;
}

export type SpendDecision =
	| { allowed: false; reason: string }
	| { allowed: true; budgetUsd: number };

/** Decide whether a live/paid run may proceed. Refuses by default. */
export function spendGate(opts: RunnerOptions): SpendDecision {
	if (!opts.allowSpend) return { allowed: false, reason: 'live run refused: pass --allow-spend to authorize paid calls' };
	if (!(typeof opts.budgetUsd === 'number' && opts.budgetUsd > 0))
		return { allowed: false, reason: 'live run refused: a positive --budget-usd ceiling is required with --allow-spend' };
	return { allowed: true, budgetUsd: opts.budgetUsd };
}

/** Dry-run cost estimate — pure, no calls. */
export function estimateCost(tasks: readonly BenchmarkTask[], opts: RunnerOptions = {}): { runs: number; estUsd: number } {
	const repeats = Math.max(1, opts.repeats ?? 3);
	const perRun = Math.max(0, opts.estPerRunUsd ?? 0);
	const runs = tasks.length * repeats;
	return { runs, estUsd: runs * perRun };
}

/** Plan a run set WITHOUT executing it. Always returns a plan; never calls out. */
export function planRun(tasks: readonly BenchmarkTask[], opts: RunnerOptions = {}): {
	spend: SpendDecision;
	estimate: { runs: number; estUsd: number };
	willExecute: false;
	note: string;
} {
	return {
		spend: spendGate(opts),
		estimate: estimateCost(tasks, opts),
		willExecute: false,
		note: 'DRY RUN ONLY: this scaffolding never executes a paid benchmark. Execution is a separately-authorized change.',
	};
}
