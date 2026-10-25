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
