import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
	readBuildResults,
	totalCampaignSpentMicros,
	REQUIRED_CONTRACT_CHECKS,
	lit,
	type D1Query,
} from '../scripts/brief-run/d1-reader.ts';
import { assertSelectOnly } from '../scripts/brief-run/d1-live.ts';
import { allMigrationPaths } from './fixtures/migrations.ts';
import { splitSqlStatements } from './fixtures/controls-harness.ts';

/**
 * LANE 8 STEP 3 — the read-only D1 reader, driven against a REAL SQLite
 * database built by applying EVERY committed migration in order (the
 * tests/memory-learns.test.ts pattern), with rows inserted exactly the way the
 * app writes them (the column lists are copied from the app's own INSERTs:
 * build-workflow.ts, build-features.ts, runs.ts recordVerification,
 * output-contract-receipts.ts, build-spend.ts). This is the fix the brief asks
 * for: the reader must query only tables that exist, and prove it against the
 * real schema — not against fakes that name build_steps / contract_checks,
 * which do not exist.
 */

const NOW = '2026-10-22T12:00:00.000Z';
const PROJECT = 'proj-1';
const RUN = 'run-1';
const PLAN = 'plan-rev-1';
const PAYER = 'build:run-1:t0';

/** Wrap a real bun:sqlite DB as the reader's read-only D1Query seam. */
function sqliteSeam(sqlite: Database): D1Query {
	return async (sql: string) => {
		// The live seam refuses anything that is not a single SELECT; the test
		// seam holds the reader to the SAME contract, so a reader statement that
		// would be refused live is refused here too.
		assertSelectOnly(sql);
		return sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
	};
}

/** A fresh DB with every migration applied and a `projects`/`user` row present. */
function freshDb(): Database {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys=ON');
	for (const path of allMigrationPaths())
		for (const s of splitSqlStatements(readFileSync(path, 'utf8'))) sqlite.exec(s);
	// A user, a workspace and the project the workflow belongs to (FK targets).
	// projects(id, workspaceId→workspaces, name, status default 'active', …):
	// 0001_product.sql. Insert exactly the NOT-NULL columns with valid values.
	sqlite
		.prepare('insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)')
		.run('owner', 'Owner', 'owner@example.com', NOW, NOW);
	sqlite.prepare('insert into workspaces (id,name,createdAt) values (?,?,?)').run('ws-1', 'Workspace', NOW);
	sqlite
		.prepare('insert into projects (id,workspaceId,name,status,createdAt,updatedAt) values (?,?,?,?,?,?)')
		.run(PROJECT, 'ws-1', 'Project 1', 'active', NOW, NOW);
	return sqlite;
}

// ─── the app's own INSERT column lists (copied verbatim from the app code) ───

function insertWorkflow(
	sqlite: Database,
	opts: { phase: string; detail?: string | null; previewId?: string | null; planId?: string | null; spendPayerId?: string | null },
): void {
	// build-workflow.ts line 279 (team-mode create) then the columns 0018/0040
	// add: planId, previewId, detail, spendPayerId are set as the workflow
	// advances. We set them directly to represent a finished build.
	sqlite
		.prepare(
			'insert into build_workflows (projectId,runId,conversationId,intakeKey,brief,phase,teamMode,bigApps,appFeatures,planId,previewId,detail,spendPayerId,updatedAt) ' +
				'values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
		)
		.run(
			PROJECT,
			RUN,
			'conv-1',
			'intake-1',
			'brief text',
			opts.phase,
			1,
			0,
			0,
			opts.planId ?? null,
			opts.previewId ?? null,
			opts.detail ?? null,
			opts.spendPayerId ?? null,
			NOW,
		);
}

function insertFeature(sqlite: Database, featureId: string, position: number, status: string): void {
	// build-features.ts line 107.
	sqlite
		.prepare(
			'insert into "build_features" ("projectId","runId","planId","featureId","position","title","doneWhen","status","attempts","updatedAt") values (?,?,?,?,?,?,?,?,0,?)',
		)
		.run(PROJECT, RUN, PLAN, featureId, position, `Feature ${position}`, '[]', status, NOW);
}

function insertVerification(sqlite: Database, check: string, passed: boolean, planRevision = PLAN): void {
	// runs.ts recordVerification line 232.
	sqlite
		.prepare(
			'insert into "run_verifications" ("id","runId","projectId","check","passed","evidence","planRevision","recordedBy","createdAt") values (?,?,?,?,?,?,?,?,?)',
		)
		.run(`ver-${check}-${passed ? 1 : 0}-${Math.random()}`, RUN, PROJECT, check, passed ? 1 : 0, 'evidence', planRevision, 'owner', NOW);
}

function insertReceipt(sqlite: Database, outputId: string, checks: Partial<Record<string, boolean>>): void {
	// output-contract-receipts.ts recordOutputContractReceipts.
	const full: Record<string, boolean> = {};
	for (const c of REQUIRED_CONTRACT_CHECKS) full[c] = checks[c] === true;
	sqlite
		.prepare('insert into "output_contract_receipts" ("id","projectId","outputId","checks","createdAt") values (?,?,?,?,?)')
		.run(`ocr-${outputId}`, PROJECT, outputId, JSON.stringify(full), NOW);
}

function insertRepairRound(sqlite: Database, issue: string, outcome: 'started' | 'succeeded' | 'failed'): void {
	// runs.ts line 178 (run_rounds).
	sqlite
		.prepare('insert or ignore into "run_rounds" ("id","runId","projectId","issue","round","outcome","detail","createdAt") values (?,?,?,?,?,?,?,?)')
		.run(`rr-${issue}-${outcome}-${Math.random()}`, RUN, PROJECT, issue, 'repair_attempt', outcome, null, NOW);
}

function insertSpend(sqlite: Database, limitMicros: number, reservations: Array<{ settled: number | null; reserved: number; status: string }>): void {
	// build-spend.ts lines 125, 248. The limit guard trigger fires on reserved
	// inserts, so insert the limit first and keep each reservation under it.
	sqlite
		.prepare('insert into "build_spend_limits" ("payerId","limitMicros","createdAt","updatedAt") values (?,?,?,?)')
		.run(PAYER, limitMicros, NOW, NOW);
	let i = 0;
	for (const r of reservations) {
		sqlite
			.prepare(
				'insert into "build_spend_reservations" ("turnId","payerId","conversationId","reservedMicros","settledMicros","status","createdAt","updatedAt") values (?,?,?,?,?,?,?,?)',
			)
			.run(`turn-${i++}`, PAYER, 'conv-1', r.reserved, r.settled, r.status, NOW, NOW);
	}
}

/** The host-check names a green build records at least one of. */
const GREEN_CHECKS = ['dependencies', 'behaviour-tests', 'browser-bundle', 'server-starts'];

/** Build a fully-green team-mode build in the DB. */
function seedGreenBuild(sqlite: Database): void {
	insertWorkflow(sqlite, { phase: 'ready', previewId: 'prev-1', planId: PLAN, spendPayerId: PAYER });
	insertFeature(sqlite, 'f1', 1, 'passed');
	insertFeature(sqlite, 'f2', 2, 'passed');
	insertFeature(sqlite, 'f3', 3, 'passed');
	for (const c of GREEN_CHECKS) insertVerification(sqlite, c, true);
	insertReceipt(sqlite, 'prev-1', { 'sign-in': true, 'second-person': true, restart: true });
	insertSpend(sqlite, 5_000_000, [{ settled: 4_200_000, reserved: 0, status: 'settled' }]);
}

describe('readBuildResults (step 3) against the REAL schema', () => {
	let sqlite: Database;
	beforeEach(() => {
		sqlite = freshDb();
	});

	test('a fully green team-mode build is every-gate-green with its real spend', async () => {
		seedGreenBuild(sqlite);
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.phase).toBe('ready');
		expect(r.previewId).toBe('prev-1');
		expect(r.planId).toBe(PLAN);
		expect(r.everyFeaturePassed).toBe(true);
		expect(r.featuresTotal).toBe(3);
		expect(r.featuresPassed).toBe(3);
		expect(r.verifyBuildGreen).toBe(true);
		expect(r.verifyChecksTotal).toBe(GREEN_CHECKS.length);
		expect(r.verifyFailedChecks).toEqual([]);
		expect(r.everyContractCheckGreen).toBe(true);
		expect(r.contractReceiptsTotal).toBe(1);
		expect(r.contractReceiptsGreen).toBe(1);
		expect(r.spentMicros).toBe(4_200_000);
		expect(r.limitMicros).toBe(5_000_000);
		expect(r.spendPayerId).toBe(PAYER);
	});

	test('a feature short of total is NOT every-feature-passed', async () => {
		seedGreenBuild(sqlite);
		insertFeature(sqlite, 'f4', 4, 'failed');
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.featuresTotal).toBe(4);
		expect(r.featuresPassed).toBe(3);
		expect(r.everyFeaturePassed).toBe(false);
	});

	test('zero features is not "every feature passed" (vacuous truth is refused)', async () => {
		insertWorkflow(sqlite, { phase: 'ready', planId: PLAN });
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.featuresTotal).toBe(0);
		expect(r.everyFeaturePassed).toBe(false);
	});

	test('verify_build mirrors the app gate: the LATEST receipt per check decides', async () => {
		seedGreenBuild(sqlite);
		// A check failed, then a later re-run passed it: latest-per-check passes.
		insertVerification(sqlite, 'dependencies', false);
		insertVerification(sqlite, 'dependencies', true); // newer rowid wins
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.verifyBuildGreen).toBe(true);
		expect(r.verifyFailedChecks).toEqual([]);
	});

	test('an unresolved failing check means verify_build is red, and names the check', async () => {
		seedGreenBuild(sqlite);
		insertVerification(sqlite, 'server-starts', false); // newest for server-starts is a fail
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.verifyBuildGreen).toBe(false);
		expect(r.verifyFailedChecks).toContain('server-starts');
	});

	test('no verification receipts under the current plan revision is red (not vacuously green)', async () => {
		insertWorkflow(sqlite, { phase: 'building', planId: PLAN });
		insertFeature(sqlite, 'f1', 1, 'passed');
		// receipts exist, but only under an OLD plan revision.
		insertVerification(sqlite, 'dependencies', true, 'plan-rev-OLD');
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.verifyChecksTotal).toBe(0);
		expect(r.verifyBuildGreen).toBe(false);
	});

	test('a red contract receipt means not every contract check is green', async () => {
		seedGreenBuild(sqlite);
		insertReceipt(sqlite, 'prev-2', { 'sign-in': true, 'second-person': false, restart: true });
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.contractReceiptsTotal).toBe(2);
		expect(r.contractReceiptsGreen).toBe(1);
		expect(r.everyContractCheckGreen).toBe(false);
	});

	test('no contract receipts at all is not every-contract-green (team mode requires one)', async () => {
		insertWorkflow(sqlite, { phase: 'ready', planId: PLAN });
		insertFeature(sqlite, 'f1', 1, 'passed');
		for (const c of GREEN_CHECKS) insertVerification(sqlite, c, true);
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.contractReceiptsTotal).toBe(0);
		expect(r.everyContractCheckGreen).toBe(false);
	});

	test('the stop reason comes from the workflow phase + detail', async () => {
		insertWorkflow(sqlite, { phase: 'blocked', detail: 'reached its spending limit', planId: PLAN });
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.phase).toBe('blocked');
		expect(r.detail).toContain('spending limit');
	});

	test('repair rounds are counted from run_rounds', async () => {
		seedGreenBuild(sqlite);
		insertRepairRound(sqlite, 'f2', 'failed');
		insertRepairRound(sqlite, 'f2', 'succeeded');
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.repairRounds).toBe(2);
	});

	test('spend sums settled + reserved from the payer', async () => {
		insertWorkflow(sqlite, { phase: 'ready', planId: PLAN, spendPayerId: PAYER });
		insertSpend(sqlite, 5_000_000, [
			{ settled: 3_000_000, reserved: 0, status: 'settled' },
			{ settled: null, reserved: 1_000_000, status: 'reserved' },
		]);
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.spentMicros).toBe(4_000_000);
	});

	test('with no payer on the workflow, no spend is read', async () => {
		insertWorkflow(sqlite, { phase: 'ready', planId: PLAN, spendPayerId: null });
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.spentMicros).toBe(0);
		expect(r.spendPayerId).toBeNull();
	});

	test('totalCampaignSpentMicros sums reserved + settled across all payers', async () => {
		insertWorkflow(sqlite, { phase: 'ready', planId: PLAN, spendPayerId: PAYER });
		insertSpend(sqlite, 30_000_000, [
			{ settled: 25_000_000, reserved: 0, status: 'settled' },
			{ settled: null, reserved: 2_000_000, status: 'reserved' },
		]);
		expect(await totalCampaignSpentMicros(sqliteSeam(sqlite))).toBe(27_000_000);
	});

	// FINDING #6 (review 2026-10-23): a settled row KEEPS its original
	// reservedMicros estimate for audit (settle() only sets settledMicros +
	// status). The reader must count the settled cost for settled rows and the
	// reserved estimate only for still-open rows — never both. The fixtures
	// above hid this by giving every settled row reserved:0.
	test('a settled row counts its settled cost, NOT its retained estimate (per-build)', async () => {
		insertWorkflow(sqlite, { phase: 'ready', planId: PLAN, spendPayerId: PAYER });
		// Estimate 100_000 reserved, actual 2_000 settled; the row keeps both.
		insertSpend(sqlite, 5_000_000, [{ settled: 2_000, reserved: 100_000, status: 'settled' }]);
		const r = await readBuildResults(sqliteSeam(sqlite), { projectId: PROJECT, runId: RUN });
		expect(r.spentMicros).toBe(2_000); // not 102_000
	});

	test('the campaign total counts settled cost for settled rows, estimate for open rows', async () => {
		insertWorkflow(sqlite, { phase: 'ready', planId: PLAN, spendPayerId: PAYER });
		insertSpend(sqlite, 30_000_000, [
			// completed call: estimate 100_000, real 2_000 → counts 2_000
			{ settled: 2_000, reserved: 100_000, status: 'settled' },
			// still-open call: counts its 50_000 estimate (worst-case liability)
			{ settled: null, reserved: 50_000, status: 'reserved' },
		]);
		expect(await totalCampaignSpentMicros(sqliteSeam(sqlite))).toBe(52_000); // not 152_000
	});
});

describe('the live D1 seam is SELECT-only (step 3 safety)', () => {
	test('a plain SELECT is accepted', () => {
		expect(() => assertSelectOnly("select * from build_features where runId = 'r1'")).not.toThrow();
	});

	test('writes and DDL are refused', () => {
		for (const bad of [
			"update build_features set status = 'passed'",
			'delete from build_features',
			'insert into x values (1)',
			'drop table build_features',
			'select 1; drop table t',
			'pragma table_info(x)',
		]) {
			expect(() => assertSelectOnly(bad)).toThrow();
		}
	});
});

describe('the lit() SQL-literal escaper (step 3 / item 6 safety)', () => {
	/** Run `select <literal> as v` through real SQLite and read the value back. */
	function roundTrip(value: string): unknown {
		const sqlite = new Database(':memory:');
		const row = sqlite.prepare(`select ${lit(value)} as v`).get() as { v: unknown };
		return row.v;
	}

	test('a single quote is doubled, so the literal round-trips exactly', () => {
		expect(lit("O'Brien")).toBe("'O''Brien'");
		expect(roundTrip("O'Brien")).toBe("O'Brien");
		expect(roundTrip("it's a 'quoted' value")).toBe("it's a 'quoted' value");
		// A trailing quote and a lone quote both survive.
		expect(roundTrip("ends with '")).toBe("ends with '");
		expect(roundTrip("'")).toBe("'");
	});

	test('a backslash is NOT special in SQLite and is passed through verbatim', () => {
		// Doubling a backslash (MySQL/C habit) would corrupt the value; SQLite
		// treats it literally, so lit() must not touch it.
		expect(lit('C:\\path\\to')).toBe("'C:\\path\\to'");
		expect(roundTrip('C:\\path\\to')).toBe('C:\\path\\to');
		expect(roundTrip("a\\'b")).toBe("a\\'b");
		expect(roundTrip('\\')).toBe('\\');
	});

	test('a NUL byte is refused rather than silently truncated', () => {
		// The SQL is handed to wrangler as a NUL-terminated process arg, and
		// SQLite truncates a C string at NUL — so inlining a NUL would silently
		// cut the value. lit() refuses instead.
		expect(() => lit('before\u0000after')).toThrow(/NUL/);
		expect(() => lit('\u0000')).toThrow(/NUL/);
	});

	test('an ordinary id is quoted without alteration', () => {
		expect(lit('proj-1')).toBe("'proj-1'");
		expect(roundTrip('run_abc-123')).toBe('run_abc-123');
	});
});
