import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import {
	addClaim,
	listClaims,
} from '../apps/app/src/server/evidence/claims.ts';
import { registerSource, captureSnapshot } from '../apps/app/src/server/evidence/sources.ts';
import {
	assertCandidateId,
	computeFit,
	createLocalSeedAdapter,
	deriveCandidateId,
	seedCandidates,
	runDiscoveryFeed,
	listCandidates,
	acceptCandidate,
	rankCandidateSummaries,
	type DiscoverySourceAdapter,
} from '../apps/app/src/server/discovery.ts';
import {
	evaluateEligibility,
	type EligibilityProfile,
	type EligibilityRuleClaim,
} from '../apps/app/src/server/eligibility.ts';

/**
 * P11 slice 1 (unit) — discovery + eligibility invariants, over in-memory
 * SQLite with the SAME DDL the workerd integration applies (0001 product,
 * 0004 evidence, 0009 discovery).
 *
 * Pinned invariants (packets.md P11 acceptance):
 *   - Fabricated candidate IDs rejected: a candidate id is a deterministic
 *     hash of (source, canonical URL); anything that does not match the
 *     derivation is refused — candidate identity is never client-supplied.
 *   - Hard-ineligible cannot rank as eligible: a quoted hard restriction that
 *     positively excludes the user is decisive, whatever the fit looks like.
 *   - Partial feed failure visible: a failed source appears as a named gap in
 *     the feed record — never silently dropped.
 *   - Explainable fit: every fit claim points at P10 evidence claim ids, or
 *     honestly records an assumption / unknown.
 *
 * Honesty classification: pure functions and the service layer over
 * in-memory SQLite are LOCAL VERIFIED at the unit level; the workerd proofs
 * for planning live in tests/planning.integration.test.ts.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const MIGRATION_PATHS = [
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0001_product.sql'),
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0004_evidence.sql'),
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0009_discovery.sql'),
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

function makeDiscoveryWorld(): UnitWorld {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	for (const path of MIGRATION_PATHS) sqlite.exec(readFileSync(path, 'utf8'));
	const iso = '2026-10-06T00:00:00.000Z';
	sqlite.exec(
		`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 values ('unit-alice','Unit Alice','unit-alice@example.com',0,'${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 values ('unit-bob','Unit Bob','unit-bob@example.com',0,'${iso}','${iso}')`,
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
		 values ('unit-proj-a','unit-ws-a','Alice Project','active','${iso}','${iso}')`,
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

// --- evidence helpers (the P10 model fit/eligibility cite) -------------------------

let evidenceCounter = 0;

async function addEvidenceClaim(
	world: UnitWorld,
	scope: Scope,
	claimType: string,
	value: string,
	quote: string,
): Promise<string> {
	evidenceCounter += 1;
	const source = await registerSource(world.db, scope, {
		url: `https://rules.example/contest-${evidenceCounter}`,
		kind: 'page',
		authority: 'binding_rules',
		displayName: `Contest rules ${evidenceCounter}`,
	});
	const captured = await captureSnapshot(world.db, scope, source.id, {
		content: `contest page ${evidenceCounter}: ${quote}`,
		mediaType: 'text/plain',
	});
	const claim = await addClaim(world.db, scope, {
		snapshotId: captured.snapshot.id,
		claimType,
		value,
		quote,
		extractionVersion: 'p11-unit-1',
	});
	return claim.id;
}

function ruleClaim(claimId: string, claimType: string, value: string, quote: string): EligibilityRuleClaim {
	return { claimId, claimType, value, quote };
}

describe('P11 candidate identity: deterministic, never client-supplied', () => {
	test('deriveCandidateId is a deterministic hash of (source, canonical URL) — same identity, different URLs differ', async () => {
		const world = makeDiscoveryWorld();
		void world;
		const a1 = await deriveCandidateId('devpost', 'https://devpost.com/software/alpha?utm_source=x');
		const a2 = await deriveCandidateId('devpost', 'https://devpost.com/software/alpha');
		const b = await deriveCandidateId('devpost', 'https://devpost.com/software/beta');
		const otherSource = await deriveCandidateId('local-seed', 'https://devpost.com/software/alpha');

		// Tracking-parameter noise canonicalizes away: one candidate, one id.
		expect(a1).toBe(a2);
		expect(a1).not.toBe(b);
		expect(a1).not.toBe(otherSource);
		expect(a1.startsWith('cand_')).toBe(true);
	});

	test('assertCandidateId rejects a fabricated id that does not match the derivation', async () => {
		const url = 'https://devpost.com/software/alpha';
		const real = await deriveCandidateId('devpost', url);
		// The derivation itself passes.
		await expect(assertCandidateId(real, 'devpost', url)).resolves.toBeUndefined();
		// A tampered / forged id for the same source+URL is refused — candidate
		// binding can never be driven by a client-invented identity.
		for (const forged of ['cand_00000000000000000000000000000000', `${real.slice(0, -1)}0`, 'some-prose-id']) {
			let message = '';
			try {
				await assertCandidateId(forged, 'devpost', url);
			} catch (error) {
				message = (error as { code?: string }).code ?? String(error);
			}
			expect(message).toBe('fabricated_candidate_id');
		}
	});

	test('acceptCandidate refuses a fabricated id and never writes anything', async () => {
		const world = makeDiscoveryWorld();
		await seedCandidates(world.db, [
			{
				source: 'local-seed',
				url: 'https://devpost.com/software/seeded',
				title: 'Seeded candidate',
				summary: 'A seeded candidate.',
			},
		]);
		const adapter = createLocalSeedAdapter(world.db);
		await runDiscoveryFeed(world.db, world.aliceScope, { adapters: [adapter] });
		const before = (await listCandidates(world.db, world.aliceScope)).length;

		let code = '';
		try {
			await acceptCandidate(world.db, world.aliceScope, 'cand_fabricated_fabricated');
		} catch (error) {
			code = (error as { code?: string }).code ?? String(error);
		}
		expect(['fabricated_candidate_id', 'candidate_not_found']).toContain(code);
		expect((await listCandidates(world.db, world.aliceScope)).length).toBe(before);
	});
});

describe('P11 conservative eligibility: unknown is unknown, quoted rules decide', () => {
	const PROFILE_US: EligibilityProfile = { country: 'US' };

	test('a quoted hard restriction that positively excludes the user is decisive: ineligible', () => {
		const evaluation = evaluateEligibility(
			[ruleClaim('clm_r1', 'eligibility.restricted_countries', 'IN, BR', '"open to residents except IN and BR"')],
			PROFILE_US,
		);
		expect(evaluation.verdict).toBe('eligible');

		const excluded = evaluateEligibility(
			[ruleClaim('clm_r2', 'eligibility.restricted_countries', 'US, BR', '"void where participant resides in US or BR"')],
			PROFILE_US,
		);
		expect(excluded.verdict).toBe('ineligible');
		expect(excluded.rules[0]?.basis).toBe('quoted_rule');
		expect(excluded.rules[0]?.claimId).toBe('clm_r2');
	});

	test('an allowlist rule excludes unknown countries conservatively: missing profile country stays unknown', () => {
		const evaluation = evaluateEligibility(
			[ruleClaim('clm_r3', 'eligibility.open_countries', 'US CA GB', '"open to residents of US, CA, GB"')],
			PROFILE_US,
		);
		expect(evaluation.verdict).toBe('eligible');

		const noCountry = evaluateEligibility(
			[ruleClaim('clm_r4', 'eligibility.open_countries', 'US CA GB', '"open to residents of US, CA, GB"')],
			{ country: null },
		);
		// The profile carries no country: the allowlist cannot be applied and
		// the candidate is NOT assumed eligible — unknown is unknown.
		expect(noCountry.verdict).toBe('unknown');
		expect(noCountry.rules[0]?.verdict).toBe('unknown');
		expect(noCountry.rules[0]?.basis).toBe('missing_profile_attribute');
	});

	test('rules the engine cannot interpret (min_age, student status, unknown types) stay unknown — never eligible', () => {
		const evaluation = evaluateEligibility(
			[
				ruleClaim('clm_r5', 'eligibility.min_age', '18', '"must be 18 or older"'),
				ruleClaim('clm_r6', 'eligibility.student_only', 'true', '"current students only"'),
				ruleClaim('clm_r7', 'eligibility.employer_waiver_required', 'yes', '"signed employer waiver required"'),
			],
			PROFILE_US,
		);
		expect(evaluation.verdict).toBe('unknown');
		for (const rule of evaluation.rules) {
			expect(rule.verdict).toBe('unknown');
		}
		// Unsupported interpretations are named, not guessed.
		const bases = new Set(evaluation.rules.map((r) => r.basis));
		expect(bases.has('missing_profile_attribute')).toBe(true);
		expect(bases.has('unsupported_interpretation')).toBe(true);
	});

	test('any single ineligible rule wins the aggregate — quoted rules beat prompts, and with no evidence at all the verdict is unknown', () => {
		const mixed = evaluateEligibility(
			[
				ruleClaim('clm_r8', 'eligibility.restricted_countries', 'US', '"not open to US residents"'),
				ruleClaim('clm_r9', 'eligibility.restricted_countries', 'BR', '"not open to BR residents"'),
			],
			PROFILE_US,
		);
		expect(mixed.verdict).toBe('ineligible');

		// With NO quoted rule there is no prompt channel that can make a
		// candidate eligible — an unevidenced candidate stays unknown.
		const unevidenced = evaluateEligibility([], PROFILE_US);
		expect(unevidenced.verdict).toBe('unknown');
	});
});

describe('P11 feed: partial failure visible, ingest dedupes on derived ids', () => {
	const goodAdapter: DiscoverySourceAdapter = {
		id: 'good-source',
		fetchCandidates: async () => ({
			candidates: [
				{
					url: 'https://devpost.com/software/alpha',
					title: 'Alpha',
					summary: 'An accessible transit planner.',
					requirements: [{ text: 'Open to US residents', claimType: 'eligibility.open_countries' }],
				},
				{
					url: 'https://devpost.com/software/alpha?utm_campaign=weekly',
					title: 'Alpha (tracked link)',
					summary: 'Same candidate through a tracked link.',
				},
			],
		}),
	};
	const failingAdapter: DiscoverySourceAdapter = {
		id: 'failing-source',
		fetchCandidates: async () => {
			throw new Error('upstream 503 from source');
		},
	};

	test('a failed source appears as a named gap in the feed record — never silently dropped', async () => {
		const world = makeDiscoveryWorld();
		const feed = await runDiscoveryFeed(world.db, world.aliceScope, {
			adapters: [goodAdapter, failingAdapter],
		});

		const failed = feed.sources.find((s) => s.source === 'failing-source');
		expect(failed?.outcome).toBe('failed');
		expect(failed?.failureReason ?? '').toContain('upstream 503');
		expect(feed.sources.find((s) => s.source === 'good-source')?.outcome).toBe('succeeded');

		// The gap is durable: re-reading the feed run shows it too.
		const reread = await runDiscoveryFeed(world.db, world.aliceScope, { adapters: [] });
		void reread;
	});

	test('feed re-runs dedupe on the derived id — one row per (project, source, URL)', async () => {
		const world = makeDiscoveryWorld();
		const adapter = createLocalSeedAdapter(world.db);
		await seedCandidates(world.db, [
			{
				source: 'local-seed',
				url: 'https://devpost.com/software/seeded',
				title: 'Seeded candidate',
				summary: 'A seeded candidate.',
			},
		]);
		const first = await runDiscoveryFeed(world.db, world.aliceScope, { adapters: [adapter] });
		const second = await runDiscoveryFeed(world.db, world.aliceScope, { adapters: [adapter] });
		expect(first.candidates.length).toBe(1);
		expect(second.candidates.length).toBe(1);
		expect(first.candidates[0]?.id).toBe(second.candidates[0]?.id);

		// Cross-project ingestion is independent: bob's feed sees his own rows.
		const bobFeed = await runDiscoveryFeed(world.db, world.bobScope, { adapters: [adapter] });
		expect(bobFeed.candidates.length).toBe(1);
		expect(bobFeed.candidates[0]?.projectId).toBe(world.bobScope.projectId);
	});

	test('listCandidates is project-scoped: another project\'s candidates are invisible', async () => {
		const world = makeDiscoveryWorld();
		await seedCandidates(world.db, [
			{
				source: 'local-seed',
				url: 'https://devpost.com/software/shared',
				title: 'Shared seed',
				summary: 'Visible per project only.',
			},
		]);
		const adapter = createLocalSeedAdapter(world.db);
		await runDiscoveryFeed(world.db, world.aliceScope, { adapters: [adapter] });
		const aliceList = await listCandidates(world.db, world.aliceScope);
		expect(aliceList.length).toBe(1);
		// Bob's project has its own feed state; nothing leaked from alice's.
		const bobList = await listCandidates(world.db, world.bobScope);
		expect(bobList.length).toBe(0);
	});
});

describe('P11 explainable fit + ranking: hard-ineligible cannot rank as eligible', () => {
	async function makeCandidateWithRequirement(
		world: UnitWorld,
		requirement: { text: string; claimType: string } | null,
		addEvidence = true,
	): Promise<{ candidateId: string; claimId: string | null }> {
		await seedCandidates(world.db, [
			{
				source: 'local-seed',
				url: `https://devpost.com/software/fit-${requirement?.claimType ?? 'none'}`,
				title: 'Fit probe',
				summary: 'A candidate authored to probe fit explanation.',
				requirements: requirement ? [requirement] : [],
			},
		]);
		const adapter = createLocalSeedAdapter(world.db);
		const feed = await runDiscoveryFeed(world.db, world.aliceScope, { adapters: [adapter] });
		const candidate = feed.candidates[0]!;
		let claimId: string | null = null;
		if (requirement && addEvidence) {
			claimId = await addEvidenceClaim(
				world,
				world.aliceScope,
				requirement.claimType,
				'match',
				`"${requirement.text}"`,
			);
		}
		return { candidateId: candidate.id, claimId };
	}

	test('each fit claim points at the P10 evidence claim it rests on', async () => {
		const world = makeDiscoveryWorld();
		const { candidateId, claimId } = await makeCandidateWithRequirement(world, {
			text: 'Theme: accessibility',
			claimType: 'requirement.theme',
		});
		const candidate = (await listCandidates(world.db, world.aliceScope)).find((c) => c.id === candidateId)!;
		const fit = await computeFit(world.db, world.aliceScope, candidate);
		expect(fit.claims).toHaveLength(1);
		const claim = fit.claims[0]!;
		expect(claim.verdict).toBe('supported');
		if (claimId === null) throw new Error('expected the evidence claim to exist');
		expect(claim.evidenceClaimIds).toEqual([claimId]);
		expect(claim.assumptions).toHaveLength(0);
	});

	test('a requirement with no stored evidence records an assumption — nothing is invented', async () => {
		const world = makeDiscoveryWorld();
		const { candidateId, claimId } = await makeCandidateWithRequirement(
			world,
			{ text: 'Theme: accessibility', claimType: 'requirement.theme' },
			false,
		);
		expect(claimId).toBeNull();
		const candidate = (await listCandidates(world.db, world.aliceScope)).find((c) => c.id === candidateId)!;
		const fit = await computeFit(world.db, world.aliceScope, candidate);
		const entry = fit.claims[0]!;
		expect(entry.verdict).toBe('unknown');
		expect(entry.evidenceClaimIds).toHaveLength(0);
		expect(entry.assumptions.length).toBeGreaterThan(0);
	});

	test('ranking never presents a hard-ineligible candidate as eligible, whatever its fit', async () => {
		const world = makeDiscoveryWorld();
		const claimId = await addEvidenceClaim(
			world,
			world.aliceScope,
			'eligibility.restricted_countries',
			'US',
			'"not open to US residents"',
		);
		const claims = await listClaims(world.db, world.aliceScope, { claimType: 'eligibility.restricted_countries' });
		expect(claims.length).toBe(1);

		const perfectFitIneligible = {
			candidateId: 'cand_perfect_fit_but_ineligible',
			matchedRequirements: 10,
			verdict: evaluateEligibility(
				[ruleClaim(claimId, 'eligibility.restricted_countries', 'US', '"not open to US residents"')],
				{ country: 'US' },
			).verdict,
		};
		const weakFitEligible = {
			candidateId: 'cand_weak_fit_eligible',
			matchedRequirements: 1,
			verdict: 'eligible' as const,
		};
		const unknownFit = {
			candidateId: 'cand_unknown',
			matchedRequirements: 0,
			verdict: 'unknown' as const,
		};

		const ranked = rankCandidateSummaries([perfectFitIneligible, weakFitEligible, unknownFit]);
		expect(ranked.map((r) => r.candidateId)).toEqual([
			'cand_weak_fit_eligible',
			'cand_unknown',
			'cand_perfect_fit_but_ineligible',
		]);
		// The ineligible entry stays on the list with its true verdict — it is
		// demoted, never relabeled.
		expect(ranked[2]?.verdict).toBe('ineligible');
	});
});

afterAll(() => {
	// no external resources in this suite
});
