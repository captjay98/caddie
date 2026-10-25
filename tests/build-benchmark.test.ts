import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { estimateCost, planRun, spendGate, type BenchmarkTask } from '../scripts/benchmark-build.ts';

const tasks = JSON.parse(readFileSync(new URL('../docs/evidence/build-benchmark/tasks.json', import.meta.url), 'utf8')) as {
	families: string[];
	variants_per_family: number;
	work_kinds: string[];
	tasks: BenchmarkTask[];
};

// B08 — the benchmark scaffolding must never spend by accident, and the frozen
// task set must keep evaluator checks separate from agent-visible briefs.
describe('B08 — spend gate refuses by default', () => {
	test('no allowance → refused', () => {
		const d = spendGate({});
		expect(d.allowed).toBe(false);
	});
	test('allowSpend without a positive budget → refused', () => {
		expect(spendGate({ allowSpend: true }).allowed).toBe(false);
		expect(spendGate({ allowSpend: true, budgetUsd: 0 }).allowed).toBe(false);
		expect(spendGate({ allowSpend: true, budgetUsd: -5 }).allowed).toBe(false);
	});
	test('allowSpend + positive budget → allowed (gate only; still never executes)', () => {
		const d = spendGate({ allowSpend: true, budgetUsd: 10 });
		expect(d.allowed).toBe(true);
		expect(planRun(tasks.tasks, { allowSpend: true, budgetUsd: 10 }).willExecute).toBe(false);
	});
	test('dry-run cost estimate is pure and scales with repeats', () => {
		expect(estimateCost(tasks.tasks, { repeats: 3, estPerRunUsd: 2 }).runs).toBe(tasks.tasks.length * 3);
		expect(estimateCost(tasks.tasks, { repeats: 3, estPerRunUsd: 2 }).estUsd).toBe(tasks.tasks.length * 3 * 2);
	});
});

describe('B08 — the frozen task set is well-formed', () => {
	test('exactly 12 tasks: 3 variants × 4 families', () => {
		expect(tasks.families.length).toBe(4);
		expect(tasks.variants_per_family).toBe(3);
		expect(tasks.tasks.length).toBe(12);
	});
	test('every task covers one of build/change/recovery and all three appear', () => {
		const kinds = new Set(tasks.tasks.map((t) => t.work));
		expect(kinds).toEqual(new Set(['build', 'change', 'recovery']));
	});
	test('evaluator-owned acceptance checks are present and separate from the brief', () => {
		for (const t of tasks.tasks) {
			expect(typeof t.brief).toBe('string');
			expect(t.acceptance.owner).toBe('evaluator');
			expect(t.acceptance.checks.length).toBeGreaterThan(0);
			// the agent-visible brief must not embed the evaluator's checks verbatim
			for (const check of t.acceptance.checks) expect(t.brief.includes(check)).toBe(false);
		}
	});
});

import { runBenchmark, type RunOutcome } from '../scripts/benchmark-build.ts';

// B08 — the execution path exists but cannot spend without authorization + an
// injected executor, and never overspends the budget. A FAKE executor stands
// in for a model client; no live/paid call is made in these tests.
describe('B08 — runBenchmark is gated and budget-bounded', () => {
	const fake = (costPerRun: number) => async (task: { id: string }): Promise<RunOutcome> => ({ taskId: task.id, ok: true, costUsd: costPerRun, detail: 'fake' });

	test('refuses with no spend authorization (even with an executor)', async () => {
		const r = await runBenchmark(tasks.tasks, {}, fake(1));
		expect(r.stopped).toBe('refused');
		expect(r.executed.length).toBe(0);
		expect(r.spentUsd).toBe(0);
	});
	test('refuses when authorized but no executor is injected', async () => {
		const r = await runBenchmark(tasks.tasks, { allowSpend: true, budgetUsd: 100 });
		expect(r.stopped).toBe('refused');
		expect(r.spentUsd).toBe(0);
	});
	test('stops before overspending the budget', async () => {
		// budget $5, est $2/run → only 2 full runs fit before the 3rd is refused
		const r = await runBenchmark(tasks.tasks, { allowSpend: true, budgetUsd: 5, estPerRunUsd: 2, repeats: 1 }, fake(2));
		expect(r.stopped).toBe('budget-exhausted');
		expect(r.spentUsd).toBeLessThanOrEqual(5);
		expect(r.executed.length).toBe(2);
	});
	test('completes within budget using the injected (fake) executor', async () => {
		const r = await runBenchmark(tasks.tasks, { allowSpend: true, budgetUsd: 1000, estPerRunUsd: 1, repeats: 1 }, fake(1));
		expect(r.stopped).toBe('completed');
		expect(r.executed.length).toBe(tasks.tasks.length);
		expect(r.spentUsd).toBe(tasks.tasks.length);
	});
});


test('benchmark rejects non-finite budgets, repeats and costs, and withholds acceptance', async () => {
 expect(spendGate({allowSpend:true,budgetUsd:Infinity}).allowed).toBe(false);
 expect((await runBenchmark(tasks.tasks,{allowSpend:true,budgetUsd:1,repeats:NaN},async()=>{throw Error('must not call');})).stopped).toBe('refused');
 let calls=0;
 const over=await runBenchmark(tasks.tasks,{allowSpend:true,budgetUsd:1,repeats:1},async(task)=>{
  calls++;expect(Object.hasOwn(task,'acceptance')).toBe(false);
  return {taskId:task.id,ok:true,costUsd:2,detail:'over budget'};
 });
 expect(calls).toBe(1);expect(over.stopped).toBe('budget-exhausted');
 const unknown=await runBenchmark(tasks.tasks,{allowSpend:true,budgetUsd:1,repeats:1},async(task)=>({taskId:task.id,ok:true,costUsd:NaN,detail:'unknown'}));
 expect(unknown.stopped).toBe('refused');expect(unknown.executed.length).toBe(1);
});
