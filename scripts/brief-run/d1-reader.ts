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
 * driven offline in tests with a fake that returns canned rows — AND against a
 * REAL SQLite database built by applying every migration in order (see
 * tests/brief-run-d1-reader.test.ts), with rows inserted the way the app
 * writes them. The real wrangler seam (`wranglerD1Query`) is built by the
 * runner only behind the live gate.
 *
 * The REAL tables it reads (checked against apps/app/migrations/*.sql; the
 * reader uses only tables that exist):
 *   - build_workflows (0018 + 0040)  → runId, planId, phase, detail,
 *                                       previewId, spendPayerId. phase is one
 *                                       of planning|review|building|blocked|
 *                                       ready. The table's primary key is
 *                                       projectId; one workflow per project.
 *   - build_features (0023)          → one row per feature of the approved
 *                                       plan for this runId; status is
 *                                       pending|building|passed|failed.
 *   - run_verifications (0005)       → the host QA receipts: one append-only
 *                                       row per check, `passed` an integer 0/1,
 *                                       `planRevision` the plan.id it ran
 *                                       under. "verify_build is green" mirrors
 *                                       the app's own completion gate
 *                                       (runs.ts evaluateCompletion): the
 *                                       LATEST row per check under the current
 *                                       plan revision must all have passed, and
 *                                       there must be at least one.
 *   - output_contract_receipts (0041) → team mode's per-output contract-check
 *                                       receipts; `checks` a JSON object over
 *                                       the required checks (sign-in,
 *                                       second-person, restart). A receipt is
 *                                       green when every required check is
 *                                       true. No receipt exists outside team
 *                                       mode.
 *   - run_rounds (0005)              → the repair/verification history; the
 *                                       repair rounds count is surfaced for the
 *                                       report.
 *   - build_spend_reservations /
 *     build_spend_limits (0040)      → the build payer's real spend (settled +
 *                                       reserved) and its limit.
 */

/** A read-only query seam: run a SELECT, get rows back as plain objects. */
export type D1Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/**
 * One quoted SQLite string literal for the few values we must inline (ids
 * only) into a statement handed to `wrangler d1 execute --local --command`.
 *
 * SQLite string literals escape a single quote by DOUBLING it (`''`); a
 * backslash is NOT special inside a SQLite string literal (unlike MySQL/C), so
 * it is passed through verbatim and must NOT be doubled — doubling it would
 * corrupt the value. A NUL byte cannot survive: the SQL is passed to wrangler
 * as one process argument (a C string, NUL-terminated) and SQLite itself
 * truncates a C string at the first NUL, so a value containing NUL would be
 * silently cut. We refuse it rather than inline a truncated value.
 */
export function lit(value: string): string {
	if (value.includes('\u0000')) {
		throw new Error('d1 lit(): a NUL byte cannot be inlined into a SQL literal (it would be silently truncated)');
	}
	return `'${value.replace(/'/g, "''")}'`;
}

export interface BuildResults {
	projectId: string;
	runId: string;
	/** The plan revision the current workflow is on (build_workflows.planId). */
	planId: string | null;
	/** The workflow phase as the stop reason: one of planning|review|building|blocked|ready. */
	phase: string;
	/** The workflow's human stop/blocker detail, if any. */
	detail: string | null;
	/** The published preview id, when the build produced one. */
	previewId: string | null;
	featuresTotal: number;
	featuresPassed: number;
	everyFeaturePassed: boolean;
	/** Checks whose LATEST receipt under the current plan revision passed. */
	verifyChecksTotal: number;
	verifyChecksPassed: number;
	/** The names of checks whose latest receipt failed (for the report). */
	verifyFailedChecks: string[];
	verifyBuildGreen: boolean;
	/** Team-mode contract receipts: one per output, each over the required checks. */
	contractReceiptsTotal: number;
	contractReceiptsGreen: number;
	everyContractCheckGreen: boolean;
	/** Repair rounds recorded for this build (run_rounds, round='repair_attempt'). */
	repairRounds: number;
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

function str(row: Record<string, unknown> | undefined, key: string): string | null {
	const v = row?.[key];
	return v == null ? null : String(v);
}

/** The three required team-mode contract checks (publish-safety.REQUIRED_TEAM_MODE_CHECKS). */
export const REQUIRED_CONTRACT_CHECKS = ['sign-in', 'second-person', 'restart'] as const;

/** A single receipt's `checks` JSON is green when every required check is true. */
function receiptIsGreen(checksJson: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(checksJson);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== 'object') return false;
	const obj = parsed as Record<string, unknown>;
	return REQUIRED_CONTRACT_CHECKS.every((check) => obj[check] === true);
}

/**
 * Read one build's results for a project + runId. Each read is its own SELECT
 * so a fake seam can answer them independently and a real failure names the
 * table that was missing. The aggregation (latest-receipt-per-check, parsing
 * contract-receipt JSON) is done HERE rather than in SQL, so the same logic
 * runs over the wrangler seam and over a real SQLite database in tests.
 */
export async function readBuildResults(
	query: D1Query,
	opts: { projectId: string; runId: string },
): Promise<BuildResults> {
	const { projectId, runId } = opts;

	// The workflow: one row per project (projectId is the primary key). We also
	// confirm it is this build's runId so a stale read of an older run is caught.
	const wf = (
		await query(
			`select runId, planId, phase, detail, previewId, spendPayerId ` +
				`from build_workflows where projectId = ${lit(projectId)} and runId = ${lit(runId)} limit 1`,
		)
	)[0];
	const planId = str(wf, 'planId');
	const phase = String(wf?.phase ?? 'unknown');
	const detail = str(wf, 'detail');
	const previewId = str(wf, 'previewId');
	const spendPayerId = str(wf, 'spendPayerId');

	// Features: total and passed for this build's runId.
	const feat = (
		await query(
			`select count(*) as total, sum(case when status = 'passed' then 1 else 0 end) as passed ` +
				`from build_features where projectId = ${lit(projectId)} and runId = ${lit(runId)}`,
		)
	)[0];
	const featuresTotal = num(feat, 'total');
	const featuresPassed = num(feat, 'passed');

	// verify_build: mirror the app's completion gate (runs.ts evaluateCompletion).
	// The host records append-only receipts in run_verifications, one row per
	// check (`dependencies`, the behaviour tests, the browser bundle,
	// `server-starts`, …). The build is verified when the LATEST row per check —
	// under the CURRENT plan revision — all passed, and there is at least one.
	// We read every receipt under the plan revision ordered newest-first and
	// reduce to the latest per check, exactly as the app does.
	const verifyRows = planId
		? await query(
				`select "check" as checkName, passed from run_verifications ` +
					`where runId = ${lit(runId)} and planRevision = ${lit(planId)} order by rowid desc`,
			)
		: [];
	const latestByCheck = new Map<string, boolean>();
	for (const row of verifyRows) {
		const checkName = String(row.checkName ?? '');
		if (checkName === '') continue;
		if (!latestByCheck.has(checkName)) latestByCheck.set(checkName, num(row, 'passed') === 1);
	}
	const verifyChecksTotal = latestByCheck.size;
	const verifyFailedChecks = [...latestByCheck.entries()].filter(([, passed]) => !passed).map(([c]) => c);
	const verifyChecksPassed = verifyChecksTotal - verifyFailedChecks.length;
	const verifyBuildGreen = verifyChecksTotal > 0 && verifyFailedChecks.length === 0;

	// Contract checks (team mode): one receipt per output in
	// output_contract_receipts, `checks` a JSON object over the required checks.
	// A receipt is green when every required check is true; the build's contract
	// checks are green when there is at least one receipt and all are green.
	const receiptRows = await query(
		`select "checks" as checksJson from output_contract_receipts where projectId = ${lit(projectId)}`,
	);
	const contractReceiptsTotal = receiptRows.length;
	const contractReceiptsGreen = receiptRows.filter((r) => receiptIsGreen(String(r.checksJson ?? ''))).length;
	const everyContractCheckGreen = contractReceiptsTotal > 0 && contractReceiptsGreen === contractReceiptsTotal;

	// Repair rounds for this build (run_rounds), for the report.
	const repair = (
		await query(
			`select count(*) as total from run_rounds ` +
				`where runId = ${lit(runId)} and round = 'repair_attempt'`,
		)
	)[0];
	const repairRounds = num(repair, 'total');

	// Spend from the build's payer: settled + reserved, and the payer's limit.
	let spentMicros = 0;
	let limitMicros: number | null = null;
	if (spendPayerId) {
		const spend = (
			await query(
				`select coalesce(sum(case when status = 'settled' then settledMicros ` +
					`when status = 'reserved' then reservedMicros else 0 end),0) as spent ` +
					`from build_spend_reservations where payerId = ${lit(spendPayerId)} and status in ('reserved','settled')`,
			)
		)[0];
		spentMicros = num(spend, 'spent');
		const limit = (
			await query(`select limitMicros from build_spend_limits where payerId = ${lit(spendPayerId)} limit 1`)
		)[0];
		limitMicros = limit?.limitMicros == null ? null : num(limit, 'limitMicros');
	}

	return {
		projectId,
		runId,
		planId,
		phase,
		detail,
		previewId,
		featuresTotal,
		featuresPassed,
		everyFeaturePassed: featuresTotal > 0 && featuresPassed === featuresTotal,
		verifyChecksTotal,
		verifyChecksPassed,
		verifyFailedChecks,
		verifyBuildGreen,
		contractReceiptsTotal,
		contractReceiptsGreen,
		everyContractCheckGreen,
		repairRounds,
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
			`select coalesce(sum(case when status = 'settled' then settledMicros ` +
				`when status = 'reserved' then reservedMicros else 0 end),0) as spent ` +
				`from build_spend_reservations where status in ('reserved','settled')`,
		)
	)[0];
	return num(row, 'spent');
}

/**
 * Read the NEWEST project_proposals row for a Home project created at/after
 * `sinceIso` (lane 8, step 3). There is no list-proposals route, so the driver
 * reads the server-of-record directly: the row the accept route authorises
 * against. Returns the newest matching row, or null while none exists yet.
 * Built over the same read-only D1 seam as the results reader.
 */
export async function readNewestProposal(
	query: D1Query,
	opts: { homeProjectId: string; sinceIso: string },
): Promise<{ id: string; status: 'proposed' | 'accepted' | 'dismissed'; createdAt: string } | null> {
	const row = (
		await query(
			`select "id", "status", "createdAt" from project_proposals ` +
				`where "homeProjectId" = ${lit(opts.homeProjectId)} and "createdAt" >= ${lit(opts.sinceIso)} ` +
				`order by "createdAt" desc limit 1`,
		)
	)[0];
	if (!row) return null;
	return {
		id: String(row.id),
		status: String(row.status) as 'proposed' | 'accepted' | 'dismissed',
		createdAt: String(row.createdAt),
	};
}
