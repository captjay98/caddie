/**
 * The Ultra architecture review (plan part B — "Ultra review").
 *
 * An `architect` delegate on `nemotron-3-ultra` (MODEL_ROLES, providers.ts)
 * reads the design's approved `caddie-architecture` block and records what it
 * found through the `record_architecture_review` tool, which writes one
 * `architecture_reviews` row per round (migration 0040). Each issue carries a
 * severity:
 *
 *   security  — sign-in, ownership and privacy, key exposure, data loss. A
 *               security issue BLOCKS the design from approval until it is
 *               fixed. There is no round limit and no waiver; after TWO rounds
 *               that still carry a security issue, the coordinator must change
 *               the plan and send it back to plan review with a plain sentence.
 *   advisory  — shown in Design review, never blocks.
 *
 * This module is pure logic + persistence: the SHAPE of a review, the rule
 * that decides whether open security issues block (and whether the two-round
 * limit has been hit), and the host hook that stores a round. The Flue tool
 * definition (`makeRecordArchitectureReview`) is mounted on the architect
 * delegate in agents/specialists.ts; the gate in build-workflow.ts reads the
 * stored rounds through {@link latestArchitectureReview}.
 *
 * The review is read-only about the app: it never writes the design, only its
 * own findings. All of this is team-mode only — nothing here is reached with
 * teamMode=0.
 */

import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import type { D1Database } from './auth.ts';

/** The two severities a review issue can carry (part B). */
export const REVIEW_SEVERITIES = ['security', 'advisory'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** How many rounds of unresolved security issues force a plan change (part B). */
export const SECURITY_ROUND_LIMIT = 2;

/** One finding the architect recorded. `path` is a dotted path into the block. */
export interface ReviewIssue {
	severity: ReviewSeverity;
	/** A dotted path into the block, e.g. "routes.3.access"; '' for a whole-block finding. */
	path: string;
	/** A plain sentence a non-technical person reads in Design review. */
	message: string;
}

/** A stored review round (one `architecture_reviews` row, issues parsed). */
export interface ArchitectureReviewRound {
	id: string;
	projectId: string;
	/** The sha256 of the exact block reviewed; pins the review to one block. */
	blockHash: string;
	round: number;
	issues: ReviewIssue[];
	createdAt: string;
}

/** The sha256 a review round is pinned to — the same tag the design hash uses. */
export function architectureBlockHash(blockJson: string): string {
	return createHash('sha256').update(blockJson).digest('hex');
}

// --- the input the architect records -----------------------------------------

const ReviewIssueSchema = v.strictObject({
	severity: v.picklist(REVIEW_SEVERITIES, 'a severity must be security or advisory'),
	path: v.pipe(v.string(), v.maxLength(240)),
	message: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(600)),
});

const RecordReviewInput = v.pipe(
	v.strictObject({
		/** The sha256 of the exact block reviewed (the design revision's own block hash). */
		blockHash: v.pipe(v.string(), v.minLength(8)),
		/** Which review round this is (1-based); the host rejects a reused round. */
		round: v.pipe(v.number(), v.integer(), v.minValue(1)),
		/** Every finding, or an empty list when the block is clean. */
		issues: v.pipe(v.array(ReviewIssueSchema), v.maxLength(200)),
	}),
	v.readonly(),
);
export type RecordReviewInput = v.InferOutput<typeof RecordReviewInput>;

// --- the rule that decides whether the design may be approved ----------------

/** Only the security issues of a round. */
export function securityIssues(issues: ReviewIssue[]): ReviewIssue[] {
	return issues.filter((i) => i.severity === 'security');
}

/** Only the advisory issues of a round (shown, never blocking). */
export function advisoryIssues(issues: ReviewIssue[]): ReviewIssue[] {
	return issues.filter((i) => i.severity === 'advisory');
}

export interface ReviewVerdict {
	/** True when the design may NOT be approved: the latest review has open security issues. */
	blocks: boolean;
	/** The plain sentences of the latest round's security issues (the ones that block). */
	securityMessages: string[];
	/** The plain sentences of the latest round's advisory issues (shown, never block). */
	advisoryMessages: string[];
	/**
	 * True when security issues have persisted for SECURITY_ROUND_LIMIT rounds:
	 * the coordinator must change the plan and send it back to plan review
	 * instead of reviewing the same block again.
	 */
	mustChangePlan: boolean;
	/** The round number of the latest review, or 0 when none exists for this block. */
	round: number;
}

/**
 * Decide, from the review rounds recorded for the block whose hash is
 * `blockHash`, whether the design may be approved.
 *
 * The LATEST round for the block decides: its open security issues block, with
 * no round limit and no waiver. `mustChangePlan` turns true once at least
 * SECURITY_ROUND_LIMIT rounds for this block each carried a security issue —
 * re-reviewing the same block a third time is not the way out; a plan change
 * is. A block with no review yet blocks too (the architect must run first),
 * via `blocks: true` and `round: 0`, so the gate never approves an unreviewed
 * block in team mode.
 */
export function reviewVerdict(rounds: ArchitectureReviewRound[], blockHash: string): ReviewVerdict {
	const forBlock = rounds.filter((r) => r.blockHash === blockHash).sort((a, b) => a.round - b.round);
	if (forBlock.length === 0) {
		return { blocks: true, securityMessages: [], advisoryMessages: [], mustChangePlan: false, round: 0 };
	}
	const latest = forBlock[forBlock.length - 1]!;
	const security = securityIssues(latest.issues);
	// How many rounds in a row (up to and including the latest) carried a
	// security issue — the two-round limit counts consecutive failing rounds.
	let consecutiveSecurity = 0;
	for (let i = forBlock.length - 1; i >= 0; i--) {
		if (securityIssues(forBlock[i]!.issues).length > 0) consecutiveSecurity += 1;
		else break;
	}
	return {
		blocks: security.length > 0,
		securityMessages: security.map((i) => i.message),
		advisoryMessages: advisoryIssues(latest.issues).map((i) => i.message),
		mustChangePlan: consecutiveSecurity >= SECURITY_ROUND_LIMIT,
		round: latest.round,
	};
}

// --- persistence -------------------------------------------------------------

function roundFromRow(row: Record<string, unknown>): ArchitectureReviewRound {
	let issues: ReviewIssue[] = [];
	try {
		const parsed = JSON.parse(String(row.issues ?? '[]')) as unknown;
		if (Array.isArray(parsed)) issues = parsed as ReviewIssue[];
	} catch {
		issues = [];
	}
	return {
		id: String(row.id),
		projectId: String(row.projectId),
		blockHash: String(row.blockHash),
		round: Number(row.round),
		issues,
		createdAt: String(row.createdAt),
	};
}

/** Every review round recorded for a project, oldest first. */
export async function listArchitectureReviews(db: D1Database, projectId: string): Promise<ArchitectureReviewRound[]> {
	const result = await db
		.prepare('select * from "architecture_reviews" where "projectId" = ? order by "round" asc')
		.bind(projectId)
		.all<Record<string, unknown>>();
	return (result.results ?? []).map(roundFromRow);
}

/** The newest review round recorded for one block of a project, or null. */
export async function latestArchitectureReview(
	db: D1Database,
	projectId: string,
	blockHash: string,
): Promise<ArchitectureReviewRound | null> {
	const rounds = (await listArchitectureReviews(db, projectId)).filter((r) => r.blockHash === blockHash);
	return rounds.length ? rounds[rounds.length - 1]! : null;
}

/**
 * Append one review round. Idempotent on (projectId, blockHash, round) through
 * the migration's unique index: a replayed tool delivery writes the same row
 * once. The round number is the architect's own 1-based counter; a reused
 * (block, round) with different issues is a bug and surfaces as the insert
 * conflict rather than silently overwriting a recorded finding.
 */
export async function recordArchitectureReview(
	db: D1Database,
	projectId: string,
	input: RecordReviewInput,
	now: string = new Date().toISOString(),
): Promise<ArchitectureReviewRound> {
	const parsed = v.parse(RecordReviewInput, input);
	const id = `arev_${crypto.randomUUID()}`;
	await db
		.prepare(
			'insert into "architecture_reviews" ("id","projectId","blockHash","round","issues","createdAt") values (?,?,?,?,?,?) ' +
				'on conflict ("projectId","blockHash","round") do nothing',
		)
		.bind(id, projectId, parsed.blockHash, parsed.round, JSON.stringify(parsed.issues), now)
		.run();
	const stored = await db
		.prepare('select * from "architecture_reviews" where "projectId" = ? and "blockHash" = ? and "round" = ?')
		.bind(projectId, parsed.blockHash, parsed.round)
		.all<Record<string, unknown>>();
	return roundFromRow(stored.results![0]!);
}

// --- the tool the architect delegate mounts ----------------------------------

/**
 * `record_architecture_review`: the architect's ONE write. Read-only about the
 * app otherwise — it has no sandbox or write tools. The host closure performs
 * the real, project-scoped insert; the model never supplies a verdict, only
 * findings with severities, and {@link reviewVerdict} decides what blocks.
 */
export function makeRecordArchitectureReview(deps: {
	record: (input: RecordReviewInput) => Promise<{ round: number; security: number; advisory: number }>;
}) {
	return defineTool({
		name: 'record_architecture_review',
		description:
			"Record this round's architecture-review findings on the design's caddie-architecture block. Give blockHash (the exact block you reviewed), the 1-based round, and every issue with its severity: 'security' for sign-in, ownership/privacy, key exposure or data loss (these BLOCK the design until fixed, with no waiver), 'advisory' for everything else (shown to the user, never blocks). Record an empty issue list when the block is clean. You review only; you never approve or change the design.",
		input: RecordReviewInput,
		run: async (ctx) => {
			const result = await deps.record(ctx.data);
			const line =
				result.security > 0
					? `Recorded review round ${result.round}: ${result.security} security issue(s) that block the design until fixed, and ${result.advisory} advisory. The design cannot be approved while a security issue is open.`
					: `Recorded review round ${result.round}: no security issues; ${result.advisory} advisory note(s) shown to the user.`;
			return { output: line };
		},
	});
}
