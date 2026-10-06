import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { addClaim } from '../apps/app/src/server/evidence/claims.ts';
import { registerSource, captureSnapshot } from '../apps/app/src/server/evidence/sources.ts';
import {
	JUDGE_VERSION,
	assessCriterionEvidence,
	buildCoachingMaterials,
	extractRubric,
	matchesRequirement,
	recordScorecard,
	listScorecards,
	validateScoringResult,
	type CriterionEvidence,
	type Rubric,
} from '../apps/app/src/server/judge.ts';
import {
	computeRequirementsVersion,
} from '../apps/app/src/server/submission.ts';

/**
 * P13 slices 1+2 (unit) — judge coaching + submission package invariants,
 * over in-memory SQLite with the SAME DDL the workerd integration applies
 * (0001 product, 0004 evidence, 0005 runs, 0010 judge).
 *
 * Pinned invariants (packets.md P13 acceptance + feature-ledger C15/C16):
 *   - The rubric is extracted from REAL requirement evidence (P10 claims) —
 *     never a generic Design/Impact/Innovation/Presentation set. An empty
 *     evidence record yields an empty rubric (no universal video/repo/
 *     criteria assumptions travel).
 *   - Structured scoring is validated strictly: unknown criteria, missing
 *     criteria, out-of-range/non-numeric scores and empty notes are rejected.
 *   - Declared vs verified evidence is separated, and a scoring result can
 *     never upgrade its own access level (access comes from receipts).
 *   - Coaching is never an organizer prediction: no win probability anywhere,
 *     and the average carries an explicit not-a-prediction label.
 *   - Submission checklists derive ONLY from cited requirement claims;
 *     missing video/repo/license stays missing; reuse disclosure needs a
 *     human; exported packages record their hash + requirements version and
 *     a later rule change invalidates readiness.
 *
 * Honesty classification: pure functions and the service layer over
 * in-memory SQLite are LOCAL VERIFIED at the unit level; the workerd proofs
 * live in tests/submission.test.ts.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const MIGRATION_PATHS = [
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0001_product.sql'),
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0004_evidence.sql'),
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0005_runs.sql'),
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0010_judge.sql'),
];

// --- in-memory D1 (same wrap pattern as tests/evidence.test.ts) -----------------

function wrapSqliteAsD1(sqlite: Database): D1Database {
	return {
		prepare: (query: string) => {
			const stmt = sqlite.prepare(query);
			return {
				bind: (...values: unknown[]) => ({
					run: async () => stmt.run(...(values as never[])),
					all: async () => ({
						results: stmt.all(...(values as never[])) as unknown[],
						meta: {},
					}),
				}),
				run: async () => stmt.run(),
				all: async () => ({ results: stmt.all() as unknown[], meta: {} }),
			};
		},
		batch: async (statements: unknown[]) => {
			const out: unknown[] = [];
			for (const statement of statements as { run(): unknown }[]) {
				out.push(await statement.run());
			}
			return out;
		},
		exec: async (query: string) => sqlite.exec(query),
	} as unknown as D1Database;
}

interface UnitWorld {
	db: D1Database;
	sqlite: Database;
	aliceScope: Scope;
	bobScope: Scope;
}

function makeJudgeWorld(): UnitWorld {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	for (const path of MIGRATION_PATHS) sqlite.exec(readFileSync(path, 'utf8'));
	const iso = '2026-10-06T00:00:00.000Z';
	sqlite.exec(
		`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 values ('unit-alice','Unit Alice','unit-alice-p13@example.com',0,'${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 values ('unit-bob','Unit Bob','unit-bob-p13@example.com',0,'${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspaces" ("id","name","createdAt") values ('unit-ws-a','Alice WS','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
		 values ('unit-mem-a','unit-ws-a','unit-alice','owner','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspaces" ("id","name","createdAt") values ('unit-ws-b','Bob WS','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
		 values ('unit-mem-b','unit-ws-b','unit-bob','owner','${iso}')`,
	);
	sqlite.exec(
		`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
		 values ('unit-proj-a','unit-ws-a','Transit Planner','active','${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
		 values ('unit-proj-b','unit-ws-b','Bob Project','active','${iso}','${iso}')`,
	);
	return {
		sqlite,
		db: wrapSqliteAsD1(sqlite),
		aliceScope: { actorId: 'unit-alice', workspaceId: 'unit-ws-a', projectId: 'unit-proj-a' },
		bobScope: { actorId: 'unit-bob', workspaceId: 'unit-ws-b', projectId: 'unit-proj-b' },
	};
}

// --- evidence helpers (the P10 claims the rubric/checklist cite) --------------------

let evidenceCounter = 0;

async function addEvidenceClaim(
	world: UnitWorld,
	scope: Scope,
	claimType: string,
	value: string,
	quote: string,
	options: { authority?: string; locator?: string } = {},
): Promise<string> {
	evidenceCounter += 1;
	const source = await registerSource(world.db, scope, {
		url: `https://rules.example/p13-claim-${evidenceCounter}`,
		kind: 'page',
		authority: options.authority ?? 'binding_rules',
		displayName: `P13 source ${evidenceCounter}`,
	});
	const captured = await captureSnapshot(world.db, scope, source.id, {
		content: `p13 source ${evidenceCounter}: ${quote}`,
		mediaType: 'text/plain',
	});
	const claim = await addClaim(world.db, scope, {
		snapshotId: captured.snapshot.id,
		claimType,
		value,
		quote,
		locator: options.locator ?? null,
		extractionVersion: 'p13-unit-1',
	});
	return claim.id;
}

function insertVerification(
	world: UnitWorld,
	input: { check: string; passed: boolean; evidence: string; runId?: string },
): string {
	const id = `verif_${crypto.randomUUID()}`;
	world.sqlite
		.prepare(
			'insert into "run_verifications" ("id","runId","projectId","check","passed","evidence","planRevision","recordedBy","createdAt") values (?,?,?,?,?,?,?,?,?)',
		)
		.run(
			id,
			input.runId ?? 'run_unit',
			world.aliceScope.projectId,
			input.check,
			input.passed ? 1 : 0,
			input.evidence,
			'1',
			'unit-alice',
			'2026-10-06T01:00:00.000Z',
		);
	return id;
}

function insertRepairRound(
	world: UnitWorld,
	input: { issue: string; outcome: 'started' | 'succeeded' | 'failed'; detail?: string; round?: string },
): void {
	world.sqlite
		.prepare(
			'insert into "run_rounds" ("id","runId","projectId","issue","round","outcome","detail","createdAt") values (?,?,?,?,?,?,?,?)',
		)
		.run(
			`round_${crypto.randomUUID()}`,
			'run_unit',
			world.aliceScope.projectId,
			input.issue,
			input.round ?? 'repair_attempt',
			input.outcome,
			input.detail ?? null,
			'2026-10-06T00:30:00.000Z',
		);
}

function errorCode(error: unknown): string {
	return (error as { code?: string }).code ?? String(error);
}

// =========================================================================
// Slice 1 — judge: rubric extracted from real claims
// =========================================================================

describe('P13 rubric: extracted from real claims, never generic', () => {
	test('a project with no judging evidence yields an EMPTY rubric — no universal criteria', async () => {
		const world = makeJudgeWorld();
		const rubric = await extractRubric(world.db, world.aliceScope);
		expect(rubric.criteria).toHaveLength(0);
		expect(rubric.warnings.length).toBeGreaterThan(0);
		// The generic carryover set (Design/Impact/Innovation/Presentation) must
		// not appear out of nowhere — the rubric only ever quotes stored claims.
		const texts = rubric.criteria.map((c) => c.text.toLowerCase());
		expect(texts).not.toContain('design');
		expect(texts).not.toContain('impact');
	});

	test('criteria and weights come from real claims and cite them; hash is deterministic', async () => {
		const world = makeJudgeWorld();
		const c1 = await addEvidenceClaim(
			world,
			world.aliceScope,
			'judging.criterion',
			'Accessibility impact',
			'"Projects will be judged on accessibility impact"',
		);
		const c2 = await addEvidenceClaim(
			world,
			world.aliceScope,
			'judging.criterion',
			'Working demo',
			'"A working demo is judged for completeness"',
		);
		const w1 = await addEvidenceClaim(
			world,
			world.aliceScope,
			'judging.criterion.weight',
			'Accessibility impact=40',
			'"Accessibility impact counts for 40% of the total score"',
		);
		const rubric = await extractRubric(world.db, world.aliceScope);
		expect(rubric.criteria.map((c) => c.text).sort()).toEqual(['Accessibility impact', 'Working demo']);
		const accessibility = rubric.criteria.find((c) => c.text === 'Accessibility impact')!;
		expect(accessibility.weight).toBe(40);
		expect(accessibility.claimIds).toContain(c1);
		expect(accessibility.claimIds).toContain(w1);
		const demo = rubric.criteria.find((c) => c.text === 'Working demo')!;
		// No weight claimed -> weight stays null (never an equal-weight guess).
		expect(demo.weight).toBeNull();

		const again = await extractRubric(world.db, world.aliceScope);
		expect(again.hash).toBe(rubric.hash);
		expect(rubric.extractionVersion).toBe(JUDGE_VERSION);
		expect(rubric.hash.startsWith('sha256-')).toBe(true);
	});

	test('an unparseable weight claim is a named warning — the weight is never guessed', async () => {
		const world = makeJudgeWorld();
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion', 'Originality', '"judged on originality"');
		await addEvidenceClaim(
			world,
			world.aliceScope,
			'judging.criterion.weight',
			'Originality is worth a lot',
			'"originality is worth a lot to the judges"',
		);
		const rubric = await extractRubric(world.db, world.aliceScope);
		expect(rubric.criteria).toHaveLength(1);
		expect(rubric.criteria[0]!.weight).toBeNull();
		expect(rubric.warnings.some((w) => w.includes('Originality'))).toBe(true);
	});

	test('a superseded criterion reading is not the rubric; equal-authority conflicts stay unresolved', async () => {
		const world = makeJudgeWorld();
		// Newer binding-rules source restates the criterion — the older reading
		// is history, and the rubric quotes the CURRENT word.
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion', 'Old wording', '"criterion: old wording"');
		const current = await addEvidenceClaim(
			world,
			world.aliceScope,
			'judging.criterion',
			'Current wording',
			'"criterion: current wording"',
		);
		const rubric = await extractRubric(world.db, world.aliceScope);
		expect(rubric.criteria.map((c) => c.text)).toEqual(['Current wording']);
		expect(rubric.criteria[0]!.claimIds).toContain(current);

		// Equal-authority disagreement is retained, never auto-resolved.
		const world2 = makeJudgeWorld();
		await addEvidenceClaim(world2, world2.aliceScope, 'judging.criterion', 'Theme A', '"criterion: theme A"');
		await addEvidenceClaim(world2, world2.aliceScope, 'judging.criterion', 'Theme B', '"criterion: theme B"');
		const conflicted = await extractRubric(world2.db, world2.aliceScope);
		expect(conflicted.criteria).toHaveLength(0);
		expect(conflicted.conflicts).toHaveLength(1);
		expect(conflicted.conflicts[0]!.claimIds).toHaveLength(2);
	});

	test('the rubric is project-scoped: another project\'s claims never leak in', async () => {
		const world = makeJudgeWorld();
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion', 'Alice criterion', '"criterion: alice"');
		const rubric = await extractRubric(world.db, world.bobScope);
		expect(rubric.criteria).toHaveLength(0);
	});
});

// =========================================================================
// Slice 1 — judge: artifact evidence at declared/local/deployed/unknown
// =========================================================================

describe('P13 evidence access: declared vs verified is separated', () => {
	async function rubricWithCriterion(world: UnitWorld, text: string): Promise<Rubric> {
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion', text, `"criterion: ${text}"`);
		return extractRubric(world.db, world.aliceScope);
	}

	test('receipts verify locally, deployed-prefixed receipts verify deployed, claims stay declared', async () => {
		const world = makeJudgeWorld();
		const rubric = await rubricWithCriterion(world, 'Accessibility impact');
		insertVerification(world, {
			check: 'accessibility audit passes',
			passed: true,
			evidence: 'axe report clean on the local build',
		});
		insertVerification(world, {
			check: 'deployed: smoke test on live URL',
			passed: true,
			evidence: 'HTTP 200 and expected heading on the deployed preview',
		});
		await addEvidenceClaim(
			world,
			world.aliceScope,
			'evidence.delivered',
			'Accessibility review completed by the team',
			'"we completed an accessibility review"',
		);

		const assessment = await assessCriterionEvidence(world.db, world.aliceScope, rubric);
		expect(assessment).toHaveLength(1);
		const entry: CriterionEvidence = assessment[0]!;
		expect(entry.criterionText).toBe('Accessibility impact');
		// Declared vs verified NEVER mix: two separate lists.
		expect(entry.verified).toHaveLength(2);
		expect(entry.declared).toHaveLength(1);
		const levels = entry.verified.map((o) => o.level).sort();
		expect(levels).toEqual(['verified_deployed', 'verified_local']);
		expect(entry.declared[0]!.level).toBe('declared');
		// The strongest VERIFIED level wins the criterion's access — a declared
		// claim alone can never lift it above 'declared'.
		expect(entry.access).toBe('verified_deployed');
	});

	test('a criterion with only a declared claim reads access=declared; with nothing reads unknown', async () => {
		const world = makeJudgeWorld();
		const rubric = await rubricWithCriterion(world, 'Working demo');
		await addEvidenceClaim(
			world,
			world.aliceScope,
			'evidence.delivered',
			'Demo video recorded',
			'"the demo video was recorded"',
		);
		const world2 = makeJudgeWorld();
		const rubric2 = await rubricWithCriterion(world2, 'Working demo');

		const declaredOnly = await assessCriterionEvidence(world.db, world.aliceScope, rubric);
		expect(declaredOnly[0]!.access).toBe('declared');
		expect(declaredOnly[0]!.verified).toHaveLength(0);

		const unknown = await assessCriterionEvidence(world2.db, world2.aliceScope, rubric2);
		expect(unknown[0]!.access).toBe('unknown');
		expect(unknown[0]!.verified).toHaveLength(0);
		expect(unknown[0]!.declared).toHaveLength(0);
	});

	test('a failed receipt is not verification evidence', async () => {
		const world = makeJudgeWorld();
		const rubric = await rubricWithCriterion(world, 'Offline mode');
		insertVerification(world, { check: 'offline mode works', passed: false, evidence: 'test failed' });
		const assessment = await assessCriterionEvidence(world.db, world.aliceScope, rubric);
		expect(assessment[0]!.access).toBe('unknown');
	});

	test('matching is a deterministic token overlap, not a model call', () => {
		expect(matchesRequirement('axe report clean for accessibility on the local build', 'Accessibility impact')).toBe(true);
		expect(matchesRequirement('unrelated receipt about payment flow', 'Accessibility impact')).toBe(false);
		// Stopwords alone never match.
		expect(matchesRequirement('the and for with this that', 'The accessibility')).toBe(false);
	});
});

// =========================================================================
// Slice 1 — judge: structured scoring validation
// =========================================================================

describe('P13 scoring: strict structured validation, coaching never prediction', () => {
	async function preparedWorld(): Promise<{
		world: UnitWorld;
		rubric: Rubric;
		assessment: CriterionEvidence[];
	}> {
		const world = makeJudgeWorld();
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion', 'Accessibility impact', '"criterion: accessibility impact"');
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion.weight', 'Accessibility impact=40', '"accessibility impact is 40%"');
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion', 'Working demo', '"criterion: working demo"');
		insertVerification(world, { check: 'accessibility audit passes', passed: true, evidence: 'clean axe report' });
		await addEvidenceClaim(world, world.aliceScope, 'evidence.delivered', 'Demo video recorded', '"demo video recorded"');
		const rubric = await extractRubric(world.db, world.aliceScope);
		const assessment = await assessCriterionEvidence(world.db, world.aliceScope, rubric);
		return { world, rubric, assessment };
	}

	test('a well-formed result validates; access levels come from receipts, not from the result', async () => {
		const { rubric, assessment } = await preparedWorld();
		const scorecard = validateScoringResult(rubric, assessment, {
			criteria: [
				{
					criterion: 'Accessibility impact',
					score: 7,
					notes: 'Verified locally by the axe receipt; weights 40%.',
					access: 'verified_deployed', // LIE in the raw result — must be ignored
					evidenceRefIds: assessment[0]!.verified.map((o) => o.ref.id),
				},
				{ criterion: 'Working demo', score: 4, notes: 'Only a declared video claim — nothing verified.' },
			],
			topRisks: ['Demo is declared-only; record and attach a real demo.'],
		});
		expect(scorecard.criteria).toHaveLength(2);
		expect(scorecard.criteria[0]!.access).toBe('verified_local'); // from receipts
		expect(scorecard.criteria[1]!.access).toBe('declared'); // from claims
		expect(scorecard.criteria[0]!.evidenceRefIds.length).toBe(1);
		// Coaching average with an explicit not-a-prediction label.
		expect(scorecard.coachingAverage).toBe(5.5);
		expect(scorecard.averageLabel.toLowerCase()).toContain('not');
		expect(scorecard.averageLabel.toLowerCase()).toContain('prediction');
		expect(scorecard.scoringVersion).toBe(JUDGE_VERSION);
		// No win probability field exists anywhere in the scorecard.
		expect(JSON.stringify(scorecard).toLowerCase()).not.toContain('probability');
		expect(JSON.stringify(scorecard).toLowerCase()).not.toContain('"win');
	});

	test('malformed results are rejected: unknown criterion, missing criterion, bad scores, empty notes', async () => {
		const { rubric, assessment } = await preparedWorld();
		const valid = { criterion: 'Working demo', score: 5, notes: 'ok' };

		expect(errorCode(
			(() => {
				try {
					return validateScoringResult(rubric, assessment, {
						criteria: [valid, { criterion: 'Innovation', score: 5, notes: 'generic carryover criterion' }],
						topRisks: [],
					});
				} catch (e) {
					return e;
				}
			})(),
		)).toBe('invalid_scoring');

		for (const bad of [
			{ ...valid, score: 11 },
			{ ...valid, score: -1 },
			{ ...valid, score: Number.NaN },
			{ ...valid, score: '7' },
			{ ...valid, notes: '' },
			{ ...valid, notes: '   ' },
			{ criterion: 'Working demo' },
		]) {
			let code = '';
			try {
				validateScoringResult(rubric, assessment, { criteria: [bad, { criterion: 'Accessibility impact', score: 5, notes: 'ok' }], topRisks: [] });
			} catch (e) {
				code = errorCode(e);
			}
			expect(code).toBe('invalid_scoring');
		}

		// A criterion scored twice is malformed; a missing one is incomplete.
		let code = '';
		try {
			validateScoringResult(rubric, assessment, {
				criteria: [valid, { ...valid }],
				topRisks: [],
			});
		} catch (e) {
			code = errorCode(e);
		}
		expect(code).toBe('invalid_scoring');

		code = '';
		try {
			validateScoringResult(rubric, assessment, { criteria: [valid], topRisks: [] });
		} catch (e) {
			code = errorCode(e);
		}
		expect(code).toBe('invalid_scoring');

		// topRisks must be an array of non-empty strings; body must be an object.
		code = '';
		try {
			validateScoringResult(rubric, assessment, { criteria: [valid, { criterion: 'Accessibility impact', score: 5, notes: 'ok' }], topRisks: ['a', 3] });
		} catch (e) {
			code = errorCode(e);
		}
		expect(code).toBe('invalid_scoring');

		code = '';
		try {
			validateScoringResult(rubric, assessment, 'not an object');
		} catch (e) {
			code = errorCode(e);
		}
		expect(code).toBe('invalid_scoring');

		// Evidence refs must exist in the assessment — cited evidence cannot be
		// invented either.
		code = '';
		try {
			validateScoringResult(rubric, assessment, {
				criteria: [valid, { criterion: 'Accessibility impact', score: 5, notes: 'ok', evidenceRefIds: ['verif_does_not_exist'] }],
				topRisks: [],
			});
		} catch (e) {
			code = errorCode(e);
		}
		expect(code).toBe('invalid_scoring');
	});

	test('scorecards persist with their exact rubric snapshot and read back project-scoped', async () => {
		const { world, rubric, assessment } = await preparedWorld();
		const scorecard = validateScoringResult(rubric, assessment, {
			criteria: [
				{ criterion: 'Accessibility impact', score: 7, notes: 'verified locally' },
				{ criterion: 'Working demo', score: 4, notes: 'declared only' },
			],
			topRisks: ['attach a verified demo'],
		});
		const record = await recordScorecard(world.db, world.aliceScope, scorecard, rubric);
		expect(record.rubricHash).toBe(rubric.hash);
		expect(record.scoringVersion).toBe(JUDGE_VERSION);

		const aliceCards = await listScorecards(world.db, world.aliceScope);
		expect(aliceCards).toHaveLength(1);
		expect(aliceCards[0]!.id).toBe(record.id);
		// Bob's project sees nothing of alice's scorecards.
		const bobCards = await listScorecards(world.db, world.bobScope);
		expect(bobCards).toHaveLength(0);
	});
});

// =========================================================================
// Slice 1 — judge: demo script / friction log / pre-mortem from records
// =========================================================================

describe('P13 coaching materials: derived from actual records', () => {
	test('demo script steps come from demo.step claims ordered by locator; none -> honest note', async () => {
		const world = makeJudgeWorld();
		await addEvidenceClaim(world, world.aliceScope, 'demo.step', 'Show the trip planner', '"step: show the trip planner"', { locator: '2' });
		await addEvidenceClaim(world, world.aliceScope, 'demo.step', 'Open with the problem', '"step: open with the problem"', { locator: '1' });

		const materials = await buildCoachingMaterials(world.db, world.aliceScope);
		expect(materials.demoScript.steps.map((s) => s.text)).toEqual([
			'Open with the problem',
			'Show the trip planner',
		]);
		expect(materials.demoScript.steps.every((s) => s.claimId.startsWith('clm_'))).toBe(true);

		const empty = await buildCoachingMaterials(world.db, world.bobScope);
		expect(empty.demoScript.steps).toHaveLength(0);
		expect(empty.demoScript.note.length).toBeGreaterThan(0);
		expect(empty.demoScript.note.toLowerCase()).toContain('no');
	});

	test('friction log is the real repair_attempt receipts — not invented narrative', async () => {
		const world = makeJudgeWorld();
		insertRepairRound(world, { issue: 'D1 migration drift', outcome: 'failed', detail: 'constraint violation on retries' });
		insertRepairRound(world, { issue: 'D1 migration drift', outcome: 'succeeded', detail: 'fixed by idempotent batch' });
		insertRepairRound(world, { issue: 'flaky lint', outcome: 'succeeded', round: 'verification' }); // not friction

		const materials = await buildCoachingMaterials(world.db, world.aliceScope);
		expect(materials.frictionLog).toHaveLength(2);
		expect(materials.frictionLog.every((f) => f.issue === 'D1 migration drift')).toBe(true);
		expect(materials.frictionLog.map((f) => f.outcome).sort()).toEqual(['failed', 'succeeded']);
	});

	test('pre-mortem items cite their sources; disclaimer forbids prediction; no probability anywhere', async () => {
		const world = makeJudgeWorld();
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion', 'Working demo', '"criterion: working demo"');
		insertVerification(world, { check: 'deployed: health check', passed: false, evidence: '5xx on live URL' });
		insertRepairRound(world, { issue: 'race in scheduling', outcome: 'failed' });
		const materials = await buildCoachingMaterials(world.db, world.aliceScope);

		const risks = materials.preMortem.map((p) => p.risk);
		// A failed receipt is a named risk citing the receipt id.
		expect(risks.some((r) => r.includes('deployed: health check'))).toBe(true);
		// A criterion with no evidence at all is a named coaching gap.
		expect(risks.some((r) => r.includes('Working demo') && r.toLowerCase().includes('no evidence'))).toBe(true);
		expect(materials.preMortem.every((p) => p.refs.length > 0)).toBe(true);
		expect(materials.disclaimer.toLowerCase()).toContain('not');
		expect(JSON.stringify(materials).toLowerCase()).not.toContain('probability');
		expect(materials.coachingVersion).toBe(JUDGE_VERSION);
	});
});

// =========================================================================
// Slice 2 (unit half) — submission: requirements version derivation
// =========================================================================

describe('P13 requirements version: rule changes are detectable', () => {
	test('the requirements version changes when a submission rule is added or superseded', async () => {
		const world = makeJudgeWorld();
		await addEvidenceClaim(world, world.aliceScope, 'submission.video', 'https://contest.example/upload — video under 5 minutes', '"submit a video under 5 minutes"');
		const v1 = await computeRequirementsVersion(world.db, world.aliceScope);

		// An unrelated claim (not a submission rule) does not move the version.
		await addEvidenceClaim(world, world.aliceScope, 'judging.criterion', 'Accessibility impact', '"criterion: accessibility"');
		const v2 = await computeRequirementsVersion(world.db, world.aliceScope);
		expect(v2).toBe(v1);

		// A NEW submission rule does move it (later rule change invalidates
		// readiness).
		await addEvidenceClaim(world, world.aliceScope, 'submission.license', 'MIT required', '"must include an MIT license"');
		const v3 = await computeRequirementsVersion(world.db, world.aliceScope);
		expect(v3).not.toBe(v1);
		expect(v3.startsWith('reqver-')).toBe(true);

		// Another project's rules never influence this project's version.
		const bobV = await computeRequirementsVersion(world.db, world.bobScope);
		expect(bobV).not.toBe(v3);
	});
});

afterAll(() => {
	// no external resources in this suite
});
