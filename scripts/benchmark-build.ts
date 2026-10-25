/**
 * B08 build-benchmark local runner.
 *
 * `planRun`/`estimateCost` are dry-run only and make NO call. `runBenchmark`
 * CAN execute, but only when BOTH an explicit `--allow-spend` + a positive
 * `--budget-usd` ceiling pass the spend gate AND the caller injects a task
 * executor — the runner never embeds a model client, so it cannot spend by
 * accident or because a model "just tried it". It enforces the budget before
 * each run and stops rather than overspend. Wiring a real executor (and the
 * credentials it needs) is a deliberate, separately-authorized step.
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
	if (!(typeof opts.budgetUsd === 'number' && Number.isFinite(opts.budgetUsd) && opts.budgetUsd > 0))
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
		note: 'DRY RUN ONLY: planRun never executes a paid benchmark.',
	};
}

/** The result of one attempted task run. */
export interface RunOutcome {
	taskId: string;
	ok: boolean;
	costUsd: number;
	detail: string;
}

/** A task executor. The runner NEVER embeds a model client; the caller injects
 * one, so a run cannot happen without a deliberately-wired, authorized path.
 * The executor returns the real measured cost of the run. */
export type TaskExecutor = (task: Omit<BenchmarkTask, 'acceptance'>, budgetRemainingUsd: number) => Promise<RunOutcome>;

export interface RunReport {
	executed: RunOutcome[];
	spentUsd: number;
	stopped: 'completed' | 'budget-exhausted' | 'refused';
	reason?: string;
}

/**
 * Execute the benchmark — ONLY when authorized. Refuses (executes nothing)
 * unless spendGate passes AND an executor is injected. Enforces the budget
 * BEFORE each run: when the remaining budget would not cover the per-run
 * estimate, it stops rather than overspend. The runner itself makes no network
 * or model call — all live work is the injected executor's, which the caller
 * wires only under explicit authorization.
 */
export async function runBenchmark(
	tasks: readonly BenchmarkTask[],
	opts: RunnerOptions,
	executor?: TaskExecutor,
): Promise<RunReport> {
	const gate = spendGate(opts);
	if (!gate.allowed) return { executed: [], spentUsd: 0, stopped: 'refused', reason: gate.reason };
	if (!executor) return { executed: [], spentUsd: 0, stopped: 'refused', reason: 'no executor injected: the runner never embeds a model client' };
	const perRun = opts.estPerRunUsd ?? 0;
  const repeats = opts.repeats ?? 3;
  if (!Number.isFinite(perRun) || perRun < 0 || !Number.isSafeInteger(repeats) || repeats < 1)
    return { executed: [], spentUsd: 0, stopped: 'refused', reason: 'invalid estimate or repeat count' };
	const executed: RunOutcome[] = [];
	let spent = 0;
	for (let r = 0; r < repeats; r++) {
		for (const task of tasks) {
			const remaining = gate.budgetUsd - spent;
			// Stop BEFORE a run that could breach the ceiling — never overspend.
			if (remaining < perRun || remaining <= 0)
				return { executed, spentUsd: spent, stopped: 'budget-exhausted', reason: `stopped before ${task.id}: $${remaining.toFixed(2)} left, est $${perRun.toFixed(2)}/run` };
			const { acceptance: _hostOnlyAcceptance, ...executionTask } = task;
      const outcome = await executor(executionTask, remaining);
			executed.push(outcome);
      if (!Number.isFinite(outcome.costUsd) || outcome.costUsd < 0)
        return { executed, spentUsd: spent, stopped: 'refused', reason: 'executor returned unknown or invalid spend; no further runs admitted' };
      spent += outcome.costUsd;
      if (outcome.costUsd > remaining)
        return { executed, spentUsd: spent, stopped: 'budget-exhausted', reason: 'executor exceeded its allowance; no further runs admitted' };
		}
	}
	return { executed, spentUsd: spent, stopped: 'completed' };
}
