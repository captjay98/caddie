/**
 * Lane 8, step 3 — read a finished build's results from the dev server's LOCAL
 * D1, READ-ONLY.
 *
 * The dev D1 is the miniflare SQLite the vite dev server persists; this reader
 * reaches it exactly the way `scripts/migrate-local.ts` reaches it — through
 * the dev server's OWN bundled wrangler, `d1 execute --local --persist-to
 * <apps/app/.wrangler/state>`. Every statement here is a SELECT; the reader
 * NEVER writes.
 *
 * All SQL goes through an injected `D1Query` seam, so the whole reader is
 * driven offline in tests with a fake that returns canned rows — no wrangler,
 * no DB, no dev server. The real seam (`wranglerD1Query`) is built by the
 * runner only behind the live gate.
 *
 * What it reads (plan part I + section 4 table names, published first):
 *   - features passed            → the build's feature rows for its runId;
 *   - verify_build               → the verify step's result;
 *   - every contract receipt     → the per-module contract-check rows;
 *   - spend from the build payer  → build_spend_reservations summed for the
 *                                   workflow's spendPayerId, against
 *                                   build_spend_limits;
 *   - the stop reason            → the workflow phase/detail.
 */

/** A read-only query seam: run a SELECT, get rows back as plain objects. */
export type D1Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** One quoted string literal for the few values we must inline (ids only). */
function lit(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export interface BuildResults {
	projectId: string;
	runId: string;
	/** The workflow phase as the stop reason: ready | blocked | stopped-equivalent. */
	phase: string;
	/** The workflow's human stop/blocker detail, if any. */
	detail: string | null;
	featuresTotal: number;
	featuresPassed: number;
	everyFeaturePassed: boolean;
	verifyBuildGreen: boolean;
	contractChecksTotal: number;
	contractChecksGreen: number;
	everyContractCheckGreen: boolean;
	/** The build payer id carried on the workflow, or null if none opened. */
	spendPayerId: string | null;
	/** Settled + reserved micros for this build's payer. */
	spentMicros: number;
	/** The payer's own limit, in micros. */
	limitMicros: number | null;
}

function num(row: Record<string, unknown> | undefined, key: string): number {
	const v = row?.[key];
	return typeof v === 'number' ? v : Number(v ?? 0) || 0;
}

/**
 * Read one build's results for a project + runId. Each read is its own SELECT
 * so a fake seam can answer them independently and a real failure names the
 * table that was missing.
 */
export async function readBuildResults(
	query: D1Query,
	opts: { projectId: string; runId: string },
): Promise<BuildResults> {
	const { projectId, runId } = opts;

	const wf = (
		await query(
			`select phase, detail, spendPayerId from build_workflows where projectId = ${lit(
				projectId,
			)} and runId = ${lit(runId)} limit 1`,
		)
	)[0];
	const phase = String(wf?.phase ?? 'unknown');
	const detail = wf?.detail == null ? null : String(wf.detail);
	const spendPayerId = wf?.spendPayerId == null ? null : String(wf.spendPayerId);

	// Features: total and passed for this build's runId.
	const feat = (
		await query(
			`select count(*) as total, sum(case when status = 'passed' then 1 else 0 end) as passed ` +
				`from build_features where projectId = ${lit(projectId)} and runId = ${lit(runId)}`,
		)
	)[0];
	const featuresTotal = num(feat, 'total');
	const featuresPassed = num(feat, 'passed');

	// verify_build: the verify step's result row for this build.
	const verify = (
		await query(
			`select result from build_steps where projectId = ${lit(projectId)} and runId = ${lit(
				runId,
			)} and step = 'verify_build' order by rowid desc limit 1`,
		)
	)[0];
	const verifyBuildGreen = String(verify?.result ?? '') === 'green';

	// Contract checks: one row per merged module (or the single app check).
	const contracts = (
		await query(
			`select count(*) as total, sum(case when result = 'green' then 1 else 0 end) as green ` +
				`from contract_checks where projectId = ${lit(projectId)} and runId = ${lit(runId)}`,
		)
	)[0];
	const contractChecksTotal = num(contracts, 'total');
	const contractChecksGreen = num(contracts, 'green');

	// Spend from the build's payer: settled + reserved, and the payer's limit.
	let spentMicros = 0;
	let limitMicros: number | null = null;
	if (spendPayerId) {
		const spend = (
			await query(
				`select coalesce(sum(settledMicros),0) as settled, coalesce(sum(reservedMicros),0) as reserved ` +
					`from build_spend_reservations where payerId = ${lit(spendPayerId)} and status in ('reserved','settled')`,
			)
		)[0];
		spentMicros = num(spend, 'settled') + num(spend, 'reserved');
		const limit = (
			await query(`select limitMicros from build_spend_limits where payerId = ${lit(spendPayerId)} limit 1`)
		)[0];
		limitMicros = limit?.limitMicros == null ? null : num(limit, 'limitMicros');
	}

	return {
		projectId,
		runId,
		phase,
		detail,
		featuresTotal,
		featuresPassed,
		everyFeaturePassed: featuresTotal > 0 && featuresPassed === featuresTotal,
		verifyBuildGreen,
		contractChecksTotal,
		contractChecksGreen,
		everyContractCheckGreen: contractChecksTotal > 0 && contractChecksGreen === contractChecksTotal,
		spendPayerId,
		spentMicros,
		limitMicros,
	};
}

/**
 * Sum total campaign spend so far across ALL build payers (D5 cap input). The
 * campaign cap check in scripts/brief-run.ts takes a `SpendReader`; this wraps
 * the D1 seam as one.
 */
export async function totalCampaignSpentMicros(query: D1Query): Promise<number> {
	const row = (
		await query(
			`select coalesce(sum(settledMicros),0) as settled, coalesce(sum(reservedMicros),0) as reserved ` +
				`from build_spend_reservations where status in ('reserved','settled')`,
		)
	)[0];
	return num(row, 'settled') + num(row, 'reserved');
}
