import { describe, expect, test } from 'bun:test';
import { readBuildResults, totalCampaignSpentMicros, type D1Query } from '../scripts/brief-run/d1-reader.ts';
import { assertSelectOnly } from '../scripts/brief-run/d1-live.ts';

/**
 * LANE 8 STEP 3 — the read-only D1 reader, driven by a FAKE query seam. No
 * wrangler, no DB, no dev server is touched.
 */

/** Route a SELECT to canned rows by the table it names. */
function fakeD1(tables: Record<string, Array<Record<string, unknown>>>): { query: D1Query; seen: string[] } {
	const seen: string[] = [];
	const query: D1Query = async (sql) => {
		seen.push(sql);
		for (const [table, rows] of Object.entries(tables)) {
			if (new RegExp(`\\bfrom\\s+${table}\\b`, 'i').test(sql)) return rows;
		}
		return [];
	};
	return { query, seen };
}

const GREEN_BUILD = {
	build_workflows: [{ phase: 'ready', detail: null, spendPayerId: 'build:run1:t0' }],
	build_features: [{ total: 7, passed: 7 }],
	build_steps: [{ result: 'green' }],
	contract_checks: [{ total: 3, green: 3 }],
	build_spend_reservations: [{ settled: 4_200_000, reserved: 0 }],
	build_spend_limits: [{ limitMicros: 5_000_000 }],
};

describe('readBuildResults (step 3)', () => {
	test('a fully green build is every-gate-green with its real spend', async () => {
		const { query } = fakeD1(GREEN_BUILD);
		const r = await readBuildResults(query, { projectId: 'p1', runId: 'run1' });
		expect(r.phase).toBe('ready');
		expect(r.everyFeaturePassed).toBe(true);
		expect(r.verifyBuildGreen).toBe(true);
		expect(r.everyContractCheckGreen).toBe(true);
		expect(r.spentMicros).toBe(4_200_000);
		expect(r.limitMicros).toBe(5_000_000);
		expect(r.spendPayerId).toBe('build:run1:t0');
	});

	test('a feature short of total is NOT every-feature-passed', async () => {
		const { query } = fakeD1({ ...GREEN_BUILD, build_features: [{ total: 7, passed: 6 }] });
		const r = await readBuildResults(query, { projectId: 'p1', runId: 'run1' });
		expect(r.everyFeaturePassed).toBe(false);
	});

	test('verify_build not green is read as red', async () => {
		const { query } = fakeD1({ ...GREEN_BUILD, build_steps: [{ result: 'red' }] });
		const r = await readBuildResults(query, { projectId: 'p1', runId: 'run1' });
		expect(r.verifyBuildGreen).toBe(false);
	});

	test('a red contract check means not every contract check is green', async () => {
		const { query } = fakeD1({ ...GREEN_BUILD, contract_checks: [{ total: 3, green: 2 }] });
		const r = await readBuildResults(query, { projectId: 'p1', runId: 'run1' });
		expect(r.everyContractCheckGreen).toBe(false);
	});

	test('zero features is not "every feature passed" (vacuous truth is refused)', async () => {
		const { query } = fakeD1({ ...GREEN_BUILD, build_features: [{ total: 0, passed: 0 }] });
		const r = await readBuildResults(query, { projectId: 'p1', runId: 'run1' });
		expect(r.everyFeaturePassed).toBe(false);
	});

	test('the stop reason comes from the workflow phase + detail', async () => {
		const { query } = fakeD1({
			...GREEN_BUILD,
			build_workflows: [{ phase: 'blocked', detail: 'reached its spending limit', spendPayerId: 'build:run1:t0' }],
		});
		const r = await readBuildResults(query, { projectId: 'p1', runId: 'run1' });
		expect(r.phase).toBe('blocked');
		expect(r.detail).toContain('spending limit');
	});

	test('spend sums settled + reserved from the payer', async () => {
		const { query } = fakeD1({
			...GREEN_BUILD,
			build_spend_reservations: [{ settled: 3_000_000, reserved: 1_000_000 }],
		});
		const r = await readBuildResults(query, { projectId: 'p1', runId: 'run1' });
		expect(r.spentMicros).toBe(4_000_000);
	});

	test('with no payer on the workflow, no spend tables are read', async () => {
		const { query, seen } = fakeD1({
			...GREEN_BUILD,
			build_workflows: [{ phase: 'ready', detail: null, spendPayerId: null }],
		});
		const r = await readBuildResults(query, { projectId: 'p1', runId: 'run1' });
		expect(r.spentMicros).toBe(0);
		expect(r.spendPayerId).toBeNull();
		expect(seen.some((s) => /build_spend_reservations/.test(s))).toBe(false);
	});

	test('totalCampaignSpentMicros sums across all payers', async () => {
		const { query } = fakeD1({ build_spend_reservations: [{ settled: 25_000_000, reserved: 2_000_000 }] });
		expect(await totalCampaignSpentMicros(query)).toBe(27_000_000);
	});
});

describe('the live D1 seam is SELECT-only (step 3 safety)', () => {
	test('a plain SELECT is accepted', () => {
		expect(() => assertSelectOnly('select * from build_features where runId = \'r1\'')).not.toThrow();
	});

	test('writes and DDL are refused', () => {
		for (const bad of [
			'update build_features set status = \'passed\'',
			'delete from build_features',
			"insert into x values (1)",
			'drop table build_features',
			'select 1; drop table t',
			'pragma table_info(x)',
		]) {
			expect(() => assertSelectOnly(bad)).toThrow();
		}
	});
});
