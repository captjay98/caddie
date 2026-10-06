import { beforeEach, describe, expect, test } from 'bun:test';
import {
	catchScopeError,
	makeSchedulesUnitWorld,
	type UnitWorld,
} from './fixtures/schedules-harness.ts';
import { addClaim, type ClaimRecord } from '../apps/app/src/server/evidence/claims.ts';
import {
	captureSnapshot,
	registerSource,
} from '../apps/app/src/server/evidence/sources.ts';
import {
	compareClaimSets,
	cosmeticallyEqual,
	listSentinelResults,
	normalizeClaimText,
	runSentinelCheck,
	runSentinelCheckForSchedule,
	type ClaimDiff,
} from '../apps/app/src/server/sentinel.ts';

/**
 * P12 slice 2 — Sentinel (feature-ledger C12, IMPROVE): compares the claims
 * read off a source's previous snapshot against the claims of the current
 * snapshot, using the P10 evidence store.
 *
 * Layers and honesty classification:
 *   - compareClaimSets / normalizeClaimText / cosmeticallyEqual: pure
 *     functions, LOCAL VERIFIED as unit evidence.
 *   - runSentinelCheck / runSentinelCheckForSchedule over in-memory SQLite
 *     with the REAL 0001+0004+0007 DDL: LOCAL VERIFIED at the unit level
 *     (same wrap pattern as tests/evidence.test.ts).
 *
 * What is NOT here: the actual re-fetch/capture pass on a schedule tick is
 * P09/P17 wiring — a Sentinel check always compares EXISTING snapshots, so
 * no external call exists anywhere in this module.
 */

// --- pure diffing --------------------------------------------------------------------

function claim(overrides: Partial<ClaimRecord> & { id: string }): ClaimRecord {
	return {
		projectId: 'unit-proj-a',
		sourceId: 'src_rules',
		snapshotId: `snap_${overrides.id}`,
		claimType: 'deadline',
		value: '2026-09-10T00:00:00Z',
		quote: 'Entries close September 9, 2026 at 5:00 PM PT.',
		locator: 'rules#deadlines',
		extractionVersion: 'p10-evidence-v1',
		confidence: null,
		status: 'active',
		supersededBy: null,
		snapshotCapturedAt: '2026-10-01T00:00:00.000Z',
		createdAt: '2026-10-01T00:00:00.000Z',
		...overrides,
	};
}

describe('P12 Sentinel: claim diffing (pure)', () => {
	test('normalization collapses case and whitespace — and nothing else', () => {
		expect(normalizeClaimText('  Entries   CLOSE September 9 ')).toBe(
			normalizeClaimText('entries close september 9'),
		);
		expect(normalizeClaimText('entries close september 9')).not.toBe(
			normalizeClaimText('entries close september 10'),
		);
		expect(cosmeticallyEqual('A  B', 'a b')).toBe(true);
		expect(cosmeticallyEqual('A B', 'A C')).toBe(false);
	});

	test('unchanged | changed | removed | added across a synthetic snapshot pair', () => {
		const oldClaims = [
			claim({ id: 'old_keep', value: '2026-09-10T00:00:00Z', locator: 'rules#deadlines' }),
			claim({ id: 'old_change', value: 'team_of_four', claimType: 'eligibility', locator: 'rules#teams' }),
			claim({ id: 'old_gone', value: 'fee_waived', claimType: 'fee', locator: 'rules#fee' }),
		];
		const newClaims = [
			claim({ id: 'new_keep', value: '2026-09-10T00:00:00Z', locator: 'rules#deadlines', snapshotId: 'snap_new' }),
			claim({ id: 'new_change', value: 'team_of_five', claimType: 'eligibility', locator: 'rules#teams', snapshotId: 'snap_new' }),
			claim({ id: 'new_added', value: 'open_worldwide', claimType: 'eligibility', locator: 'rules#where', snapshotId: 'snap_new' }),
		];
		const diffs = compareClaimSets(oldClaims, newClaims);
		const byLocator = new Map(diffs.map((d) => [d.locator ?? '', d]));
		expect(byLocator.get('rules#deadlines')!.verdict).toBe('unchanged');
		expect(byLocator.get('rules#deadlines')!.oldClaimId).toBe('old_keep');
		expect(byLocator.get('rules#deadlines')!.newClaimId).toBe('new_keep');
		expect(byLocator.get('rules#teams')!.verdict).toBe('changed');
		expect(byLocator.get('rules#teams')!.oldValue).toBe('team_of_four');
		expect(byLocator.get('rules#teams')!.newValue).toBe('team_of_five');
		expect(byLocator.get('rules#fee')!.verdict).toBe('removed');
		expect(byLocator.get('rules#fee')!.oldClaimId).toBe('old_gone');
		expect(byLocator.get('rules#fee')!.newClaimId).toBeNull();
		expect(byLocator.get('rules#where')!.verdict).toBe('added');
	});

	test('cosmetic suppression: whitespace/case-only value or quote differences are UNCHANGED', () => {
		const diffs = compareClaimSets(
			[claim({ id: 'old_a', value: 'Team of  Four', quote: 'Teams of up to FOUR people.' })],
			[claim({ id: 'new_a', value: 'team of four', quote: 'teams of up to four people.', snapshotId: 'snap_new' })],
		);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]!.verdict).toBe('unchanged');
		// a materially different value is NOT suppressed
		const realChange = compareClaimSets(
			[claim({ id: 'o', value: 'team of four' })],
			[claim({ id: 'n', value: 'solo only', snapshotId: 'snap_new' })],
		);
		expect(realChange[0]!.verdict).toBe('changed');
	});

	test('claims re-extracted from the new snapshot pair by TYPE+LOCATOR, not by id (ids derive from the snapshot)', () => {
		// The deterministic P10 claim id embeds the snapshot id, so the same
		// reading on a new snapshot always has a NEW id — matching on ids would
		// report every re-read as remove+add noise.
		const diffs = compareClaimSets(
			[claim({ id: 'clm_old_snapshot_a', value: 'v', locator: 'L' })],
			[claim({ id: 'clm_new_snapshot_b', value: 'v', locator: 'L', snapshotId: 'snap_b' })],
		);
		expect(diffs[0]!.verdict).toBe('unchanged');
		expect(diffs[0]!.oldClaimId).toBe('clm_old_snapshot_a');
		expect(diffs[0]!.newClaimId).toBe('clm_new_snapshot_b');
	});

	test('locators are matched case/whitespace-insensitively too', () => {
		const diffs = compareClaimSets(
			[claim({ id: 'o', locator: 'Rules#Deadlines ' })],
			[claim({ id: 'n', locator: 'rules#deadlines', snapshotId: 'snap_new' })],
		);
		expect(diffs[0]!.verdict).toBe('unchanged');
	});
});

// --- service over the real evidence store ---------------------------------------------

interface SentinelWorld {
	world: UnitWorld;
	rulesSourceId: string;
	communitySourceId: string;
}

async function makeSentinelWorld(): Promise<SentinelWorld> {
	const world = makeSchedulesUnitWorld();
	const rules = await registerSource(world.db, world.aliceScope, {
		url: 'https://example.com/rules',
		kind: 'page',
		authority: 'binding_rules',
	});
	const community = await registerSource(world.db, world.aliceScope, {
		url: 'https://forum.example.com/thread',
		kind: 'page',
		authority: 'community',
	});
	return { world, rulesSourceId: rules.id, communitySourceId: community.id };
}

const RULES_V1 = `# Rules

Entries close September 9, 2026 at 5:00 PM PT.
Teams of up to four people.`;

/** v2 says the same things with cosmetic-only churn (case + spacing). */
const RULES_V2_COSMETIC = `# Rules

Entries close   SEPTEMBER 9, 2026 at 5:00 PM PT.
Teams of up to four  people.`;

const RULES_V3_CHANGED = `# Rules

Entries close October 1, 2026 at 5:00 PM PT.
Teams of up to four people.`;

/**
 * Capture `content` as the newest snapshot of the rules source and attach the
 * two standard claims to it. Quotes are passed explicitly because addClaim
 * verifies each quote occurs verbatim in the content (cosmetic variants of
 * the page carry cosmetic variants of the quotes). Returns the snapshot id.
 */
async function seedRulesClaims(
	w: SentinelWorld,
	content: string,
	values: { deadline: string; eligibility: string },
	quotes?: { deadline?: string; eligibility?: string },
): Promise<string> {
	// Ordering guard: snapshot identity orders by capturedAt, and two captures
	// can land in the same millisecond — the evidence.test.ts precedent.
	await Bun.sleep(5);
	const { snapshot } = await captureSnapshot(w.world.db, w.world.aliceScope, w.rulesSourceId, {
		content,
		mediaType: 'text/plain',
	});
	const deadlineQuote = quotes?.deadline ?? (content.includes('September 9')
		? 'Entries close September 9, 2026 at 5:00 PM PT.'
		: 'Entries close October 1, 2026 at 5:00 PM PT.');
	const eligibilityQuote = quotes?.eligibility ?? (content.includes('Solo entries only.')
		? 'Solo entries only.'
		: 'Teams of up to four people.');
	await addClaim(w.world.db, w.world.aliceScope, {
		snapshotId: snapshot.id,
		claimType: 'deadline',
		value: values.deadline,
		quote: deadlineQuote,
		locator: 'rules#deadlines',
		extractionVersion: 'p10-evidence-v1',
	});
	await addClaim(w.world.db, w.world.aliceScope, {
		snapshotId: snapshot.id,
		claimType: 'eligibility',
		value: values.eligibility,
		quote: eligibilityQuote,
		locator: 'rules#teams',
		extractionVersion: 'p10-evidence-v1',
	});
	return snapshot.id;
}

describe('P12 Sentinel: checks over the P10 evidence store (real DDL, in-memory sqlite)', () => {
	let w: SentinelWorld;

	beforeEach(async () => {
		w = await makeSentinelWorld();
	});

	test('a cosmetic-only page change is UNCHANGED — severity none, zero changes, ids retained', async () => {
		await seedRulesClaims(w, RULES_V1, {
			deadline: '2026-09-10T00:00:00Z',
			eligibility: 'Team  of FOUR',
		});
		await seedRulesClaims(w, RULES_V2_COSMETIC, {
			deadline: '2026-09-10T00:00Z', // same instant, different spelling
			eligibility: 'team of four', // case/whitespace-only difference
		}, {
			deadline: 'Entries close   SEPTEMBER 9, 2026 at 5:00 PM PT.', // the page's own cosmetic wording
			eligibility: 'Teams of up to four  people.',
		});
		const { result, diffs } = await runSentinelCheck(w.world.db, w.world.aliceScope, w.rulesSourceId);
		expect(diffs.every((d) => d.verdict === 'unchanged')).toBe(true);
		expect(result.severity).toBe('none');
		expect(result.changedCount).toBe(0);
		// old AND new evidence ids are retained even on a no-change verdict
		for (const diff of diffs) {
			expect(diff.oldClaimId).toBeTruthy();
			expect(diff.newClaimId).toBeTruthy();
		}
		expect(result.previousSnapshotId).not.toBe(result.currentSnapshotId);
	});

	test('a real rule change is CHANGED and MATERIAL under a rules-tier source', async () => {
		await seedRulesClaims(w, RULES_V1, {
			deadline: '2026-09-10T00:00:00Z',
			eligibility: 'team_of_four',
		});
		const currentId = await seedRulesClaims(w, RULES_V3_CHANGED, {
			deadline: '2026-10-01T00:00:00Z',
			eligibility: 'team_of_four',
		});
		const { result, diffs } = await runSentinelCheck(w.world.db, w.world.aliceScope, w.rulesSourceId);
		const changed = diffs.find((d) => d.claimType === 'deadline');
		expect(changed!.verdict).toBe('changed');
		expect(changed!.oldValue).toBe('2026-09-10T00:00:00Z');
		expect(changed!.newValue).toBe('2026-10-01T00:00:00Z');
		expect(changed!.oldClaimId).toMatch(/^clm_/);
		expect(changed!.newClaimId).toMatch(/^clm_/);
		expect(result.severity).toBe('material');
		expect(result.changedCount).toBe(1);
		expect(result.currentSnapshotId).toBe(currentId);
	});

	test('the SAME change on a community source is only INFORMATIONAL (severity rides declared authority)', async () => {
		const s1 = await captureSnapshot(w.world.db, w.world.aliceScope, w.communitySourceId, {
			content: 'Thread: entries close September 9, 2026.',
			mediaType: 'text/plain',
		});
		await addClaim(w.world.db, w.world.aliceScope, {
			snapshotId: s1.snapshot.id,
			claimType: 'deadline',
			value: '2026-09-10T00:00:00Z',
			quote: 'entries close September 9, 2026.',
			locator: 'thread#op',
			extractionVersion: 'p10-evidence-v1',
		});
		await Bun.sleep(5); // capturedAt ordering guard
		const s2 = await captureSnapshot(w.world.db, w.world.aliceScope, w.communitySourceId, {
			content: 'Thread: entries close October 1, 2026.',
			mediaType: 'text/plain',
		});
		await addClaim(w.world.db, w.world.aliceScope, {
			snapshotId: s2.snapshot.id,
			claimType: 'deadline',
			value: '2026-10-01T00:00:00Z',
			quote: 'entries close October 1, 2026.',
			locator: 'thread#op',
			extractionVersion: 'p10-evidence-v1',
		});
		const { result, diffs } = await runSentinelCheck(w.world.db, w.world.aliceScope, w.communitySourceId);
		expect(diffs.find((d) => d.claimType === 'deadline')!.verdict).toBe('changed');
		expect(result.changedCount).toBeGreaterThan(0);
		expect(result.severity).toBe('informational');
	});

	test('removed and added claims are reported with their retained evidence', async () => {
		await seedRulesClaims(w, RULES_V1, {
			deadline: '2026-09-10T00:00:00Z',
			eligibility: 'team_of_four',
		});
		// The page reshapes the eligibility rule (deadline line untouched).
		const reshaped = await seedRulesClaims(
			w,
			RULES_V1.replace('Teams of up to four people.', 'Solo entries only.\nOpen to entrants worldwide.'),
			{ deadline: '2026-09-10T00:00:00Z', eligibility: 'solo_only' },
		);
		await addClaim(w.world.db, w.world.aliceScope, {
			snapshotId: reshaped,
			claimType: 'eligibility',
			value: 'open_worldwide',
			quote: 'Open to entrants worldwide.',
			locator: 'rules#where',
			extractionVersion: 'p10-evidence-v1',
		});
		const { result, diffs } = await runSentinelCheck(w.world.db, w.world.aliceScope, w.rulesSourceId);
		const byLocator = new Map(diffs.map((d) => [d.locator, d]));
		expect(byLocator.get('rules#teams')!.verdict).toBe('changed'); // team_of_four -> solo_only
		expect(byLocator.get('rules#where')!.verdict).toBe('added');
		expect(byLocator.get('rules#deadlines')!.verdict).toBe('unchanged');
		expect(result.changedCount).toBe(2);
		// every diff retains at least one evidence id; the added diff carries
		// only the NEW id, removed diffs would carry only the OLD one
		expect(byLocator.get('rules#where')!.oldClaimId).toBeNull();
		expect(byLocator.get('rules#where')!.newClaimId).toMatch(/^clm_/);
	});

	test('every run appends a sentinel_results row with explicit project/source ids — rows are never updated', async () => {
		await seedRulesClaims(w, RULES_V1, {
			deadline: '2026-09-10T00:00:00Z',
			eligibility: 'team_of_four',
		});
		const first = await runSentinelCheck(w.world.db, w.world.aliceScope, w.rulesSourceId, {
			scheduleId: 'sched_watchdog',
		});
		const second = await runSentinelCheck(w.world.db, w.world.aliceScope, w.rulesSourceId);
		expect(first.result.id).not.toBe(second.result.id);
		const rows = await listSentinelResults(w.world.db, w.world.aliceScope, w.rulesSourceId);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.projectId).toBe('unit-proj-a'); // the verified scope's project — never "active"
			expect(row.sourceId).toBe(w.rulesSourceId); // the explicitly addressed source
		}
		// one row names its schedule, the other ran without one
		expect(rows.map((r) => r.scheduleId).sort()).toEqual([null, 'sched_watchdog']);
		// the retained changes carry old/new evidence ids per diff
		// (listSentinelResults returns the ALREADY-PARSED diff list)
		const stored = rows[0]!.changes;
		expect(Array.isArray(stored)).toBe(true);
	});

	test('a source with a single snapshot compares against itself: unchanged, severity none (first observation)', async () => {
		await seedRulesClaims(w, RULES_V1, {
			deadline: '2026-09-10T00:00:00Z',
			eligibility: 'team_of_four',
		});
		const { result, diffs } = await runSentinelCheck(w.world.db, w.world.aliceScope, w.rulesSourceId);
		expect(result.severity).toBe('none');
		expect(diffs.every((d) => d.verdict === 'unchanged')).toBe(true);
		expect(result.previousSnapshotId).toBe(result.currentSnapshotId);
	});

	test('an explicit currentSnapshotId re-checks a pinned pair instead of the head', async () => {
		await seedRulesClaims(w, RULES_V1, {
			deadline: '2026-09-10T00:00:00Z',
			eligibility: 'team_of_four',
		});
		const newerSnapId = await seedRulesClaims(w, RULES_V3_CHANGED, {
			deadline: '2026-10-01T00:00:00Z',
			eligibility: 'team_of_four',
		});
		const headCheck = await runSentinelCheck(w.world.db, w.world.aliceScope, w.rulesSourceId);
		expect(headCheck.result.currentSnapshotId).toBe(newerSnapId);
		// pin the newest snapshot explicitly: same pair as the head check
		const pinned = await runSentinelCheck(w.world.db, w.world.aliceScope, w.rulesSourceId, {
			currentSnapshotId: newerSnapId,
		});
		expect(pinned.result.currentSnapshotId).toBe(newerSnapId);
		expect(pinned.diffs.find((d) => d.claimType === 'deadline')!.verdict).toBe('changed');
	});

	test('the check is project-scoped: bob cannot run it against alice\'s source (404) and never sees her rows', async () => {
		await seedRulesClaims(w, RULES_V1, {
			deadline: '2026-09-10T00:00:00Z',
			eligibility: 'team_of_four',
		});
		const cross = await catchScopeError(() =>
			runSentinelCheck(w.world.db, w.world.bobScope, w.rulesSourceId),
		);
		expect(cross).toMatchObject({ status: 404 });
		expect(await listSentinelResults(w.world.db, w.world.bobScope, w.rulesSourceId)).toEqual([]);
	});

	test('the system-level entry (cron tick, no session) uses EXPLICIT project/source ids only', async () => {
		await seedRulesClaims(w, RULES_V1, {
			deadline: '2026-09-10T00:00:00Z',
			eligibility: 'team_of_four',
		});
		const fired = await runSentinelCheckForSchedule(w.world.db, {
			projectId: 'unit-proj-a',
			sourceId: w.rulesSourceId,
			scheduleId: 'sched_explicit',
		});
		expect(fired.result.projectId).toBe('unit-proj-a');
		expect(fired.result.sourceId).toBe(w.rulesSourceId);
		expect(fired.result.scheduleId).toBe('sched_explicit');

		// a source that is not in the named project is a typed 404 — ids cannot
		// be mixed across projects, and there is no "active" fallback anywhere
		const mismatched = await catchScopeError(() =>
			runSentinelCheckForSchedule(w.world.db, {
				projectId: 'unit-proj-b',
				sourceId: w.rulesSourceId,
			}),
		);
		expect(mismatched).toMatchObject({ status: 404 });
	});

	test('a source with no snapshot cannot be checked (nothing to compare is a typed error, not a fake pass)', async () => {
		const source = await registerSource(w.world.db, w.world.aliceScope, {
			url: 'https://example.com/never-fetched',
			kind: 'page',
			authority: 'unknown',
		});
		const failure = await catchScopeError(() =>
			runSentinelCheck(w.world.db, w.world.aliceScope, source.id),
		);
		expect(failure).toMatchObject({ status: 400, code: 'no_snapshot' });
	});
});
