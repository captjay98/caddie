import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import {
	advisoryIssues,
	architectureBlockHash,
	latestArchitectureReview,
	listArchitectureReviews,
	makeRecordArchitectureReview,
	recordArchitectureReview,
	reviewVerdict,
	securityIssues,
	SECURITY_ROUND_LIMIT,
	type ArchitectureReviewRound,
	type ReviewIssue,
} from '../apps/app/src/server/architecture-review.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { workspaceScopeForUser } from '../apps/app/src/server/scope.ts';

/**
 * The Ultra architecture review (plan part B): the severity/round rule that
 * decides what blocks a design, the persistence of review rounds, and the
 * record_architecture_review tool. LOCAL VERIFIED in-process.
 */

const NOW = '2026-10-22T12:00:00.000Z';
const HASH_A = architectureBlockHash('{"version":2,"a":1}');
const HASH_B = architectureBlockHash('{"version":2,"b":2}');

const sec = (message = 'Anyone could read another person\'s records.'): ReviewIssue => ({ severity: 'security', path: 'routes.3.access', message });
const adv = (message = 'The list could be faster.'): ReviewIssue => ({ severity: 'advisory', path: 'screens.1', message });

function round(n: number, issues: ReviewIssue[], blockHash = HASH_A): ArchitectureReviewRound {
	return { id: `arev_${n}`, projectId: 'p1', blockHash, round: n, issues, createdAt: NOW };
}

// --- severity split ----------------------------------------------------------

describe('severity split', () => {
	test('security and advisory issues are separated', () => {
		const issues = [sec(), adv(), sec('A key is in the browser code.')];
		expect(securityIssues(issues)).toHaveLength(2);
		expect(advisoryIssues(issues)).toHaveLength(1);
	});
});

// --- the rule that decides what blocks ---------------------------------------

describe('reviewVerdict — a security issue blocks after any number of rounds; an advisory one does not', () => {
	test('no review yet: blocks (the architect must run first), round 0', () => {
		const verdict = reviewVerdict([], HASH_A);
		expect(verdict.blocks).toBe(true);
		expect(verdict.round).toBe(0);
		expect(verdict.mustChangePlan).toBe(false);
	});

	test('a clean review does not block', () => {
		const verdict = reviewVerdict([round(1, [])], HASH_A);
		expect(verdict.blocks).toBe(false);
		expect(verdict.securityMessages).toEqual([]);
	});

	test('an advisory-only review does not block, and its notes are shown', () => {
		const verdict = reviewVerdict([round(1, [adv('Consider a search box.')])], HASH_A);
		expect(verdict.blocks).toBe(false);
		expect(verdict.advisoryMessages).toEqual(['Consider a search box.']);
	});

	test('a security issue blocks, and keeps blocking round after round (no limit, no waiver)', () => {
		// Five rounds all carrying a security issue — still blocks on the fifth.
		const rounds = [1, 2, 3, 4, 5].map((n) => round(n, [sec()]));
		const verdict = reviewVerdict(rounds, HASH_A);
		expect(verdict.blocks).toBe(true);
		expect(verdict.securityMessages).toEqual(["Anyone could read another person's records."]);
	});

	test('the latest round decides: a security issue fixed in a later round unblocks', () => {
		const rounds = [round(1, [sec()]), round(2, [adv()])];
		const verdict = reviewVerdict(rounds, HASH_A);
		expect(verdict.blocks).toBe(false);
		expect(verdict.advisoryMessages).toHaveLength(1);
	});

	test('two consecutive rounds with a security issue set mustChangePlan', () => {
		expect(reviewVerdict([round(1, [sec()])], HASH_A).mustChangePlan).toBe(false);
		const two = reviewVerdict([round(1, [sec()]), round(2, [sec()])], HASH_A);
		expect(two.mustChangePlan).toBe(true);
		expect(two.blocks).toBe(true);
		expect(SECURITY_ROUND_LIMIT).toBe(2);
	});

	test('a clean round between resets the consecutive count', () => {
		// round1 security, round2 clean, round3 security -> only 1 consecutive.
		const rounds = [round(1, [sec()]), round(2, []), round(3, [sec()])];
		const verdict = reviewVerdict(rounds, HASH_A);
		expect(verdict.blocks).toBe(true);
		expect(verdict.mustChangePlan).toBe(false);
	});

	test('rounds for a different block are ignored', () => {
		const rounds = [round(1, [sec()], HASH_B), round(1, [], HASH_A)];
		expect(reviewVerdict(rounds, HASH_A).blocks).toBe(false);
	});
});

// --- persistence -------------------------------------------------------------

describe('recordArchitectureReview persistence', () => {
	let sqlite: Database;
	let db: D1Database;
	let projectId: string;

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		const project = await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Farm', description: 'A farm app' });
		projectId = project.id;
	});
	afterEach(() => sqlite.close());

	test('records a round and reads it back with parsed issues', async () => {
		const stored = await recordArchitectureReview(db, projectId, { blockHash: HASH_A, round: 1, issues: [sec(), adv()] }, NOW);
		expect(stored.round).toBe(1);
		expect(stored.issues).toHaveLength(2);
		const all = await listArchitectureReviews(db, projectId);
		expect(all).toHaveLength(1);
		expect(securityIssues(all[0]!.issues)).toHaveLength(1);
	});

	test('latestArchitectureReview returns the newest round for a block', async () => {
		await recordArchitectureReview(db, projectId, { blockHash: HASH_A, round: 1, issues: [sec()] }, NOW);
		await recordArchitectureReview(db, projectId, { blockHash: HASH_A, round: 2, issues: [] }, NOW);
		const latest = await latestArchitectureReview(db, projectId, HASH_A);
		expect(latest?.round).toBe(2);
		expect(latest?.issues).toEqual([]);
		expect(await latestArchitectureReview(db, projectId, HASH_B)).toBeNull();
	});

	test('a replayed (block, round) is idempotent, not a duplicate', async () => {
		await recordArchitectureReview(db, projectId, { blockHash: HASH_A, round: 1, issues: [sec()] }, NOW);
		await recordArchitectureReview(db, projectId, { blockHash: HASH_A, round: 1, issues: [sec()] }, NOW);
		expect(await listArchitectureReviews(db, projectId)).toHaveLength(1);
	});

	test('the end-to-end verdict reads the stored rounds', async () => {
		await recordArchitectureReview(db, projectId, { blockHash: HASH_A, round: 1, issues: [sec()] }, NOW);
		const rounds = await listArchitectureReviews(db, projectId);
		expect(reviewVerdict(rounds, HASH_A).blocks).toBe(true);
	});
});

// --- the tool ----------------------------------------------------------------

describe('record_architecture_review tool', () => {
	test('records through the host hook and reports the counts', async () => {
		const seen: unknown[] = [];
		const tool = makeRecordArchitectureReview({
			record: async (input) => {
				seen.push(input);
				return { round: input.round, security: securityIssues(input.issues as ReviewIssue[]).length, advisory: advisoryIssues(input.issues as ReviewIssue[]).length };
			},
		});
		const result = (await tool.run({ data: { blockHash: HASH_A, round: 1, issues: [sec(), adv()] } } as never)) as { output: string };
		expect(seen).toHaveLength(1);
		expect(result.output).toContain('security issue');
		expect(result.output).toContain('block the design');
	});

	test('a clean review reports no security issues', async () => {
		const tool = makeRecordArchitectureReview({ record: async () => ({ round: 2, security: 0, advisory: 1 }) });
		const result = (await tool.run({ data: { blockHash: HASH_A, round: 2, issues: [adv()] } } as never)) as { output: string };
		expect(result.output).toContain('no security issues');
	});
});
