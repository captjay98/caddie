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
		/**
		 * Ignored: Caddie numbers the rounds itself (recordArchitectureReview).
		 * Still accepted so a model that sends one isn't refused.
		 */
		round: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
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
 * Decide, from the rounds of the project's CURRENT design cycle (see
 * {@link listArchitectureReviews}), whether the design whose block hash is
 * `blockHash` may be approved.
 *
 * The LATEST round for this exact block decides whether it blocks: its open
 * security issues block, with no round limit and no waiver, and a block with no
 * review yet blocks too (the architect must run first), via `round: 0`.
 *
 * `mustChangePlan` counts consecutive rounds with a security issue across the
 * whole cycle, newest first, whichever block each round reviewed. A normal loop
 * revises the block between reviews, so a per-block count would never reach the
 * limit; two rounds in a row that still find safety problems mean the plan, not
 * the block, has to change. A clean round resets the count.
 */
export function reviewVerdict(rounds: ArchitectureReviewRound[], blockHash: string): ReviewVerdict {
	const ordered = [...rounds].sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
	let consecutiveSecurity = 0;
	for (let i = ordered.length - 1; i >= 0; i--) {
		if (securityIssues(ordered[i]!.issues).length > 0) consecutiveSecurity += 1;
		else break;
	}
	const mustChangePlan = consecutiveSecurity >= SECURITY_ROUND_LIMIT;
	const forBlock = ordered.filter((r) => r.blockHash === blockHash);
	if (forBlock.length === 0) {
		return { blocks: true, securityMessages: [], advisoryMessages: [], mustChangePlan, round: 0 };
	}
	const latest = forBlock[forBlock.length - 1]!;
	const security = securityIssues(latest.issues);
	return {
		blocks: security.length > 0,
		securityMessages: security.map((i) => i.message),
		advisoryMessages: advisoryIssues(latest.issues).map((i) => i.message),
		mustChangePlan,
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

/**
 * When the project's current design cycle started: the newest plan (PRD)
 * revision. Writing a new plan sends the build back to plan review
 * (workflowSnapshot), so reviews of earlier designs no longer count. After a
 * design is approved no review happens until a new plan, which starts the next
 * cycle. '' when there is no plan yet (every round counts).
 */
async function designCycleStart(db: D1Database, projectId: string): Promise<string> {
	const result = await db
		.prepare(`select max("createdAt") as "startedAt" from "plan_doc_revisions" where "projectId" = ? and "kind" = 'prd'`)
		.bind(projectId)
		.all<{ startedAt: string | null }>();
	return result.results?.[0]?.startedAt ?? '';
}

/** Every review round of the project's CURRENT design cycle, oldest first. */
export async function listArchitectureReviews(db: D1Database, projectId: string): Promise<ArchitectureReviewRound[]> {
	const since = await designCycleStart(db, projectId);
	const result = await db
		.prepare('select * from "architecture_reviews" where "projectId" = ? and "createdAt" >= ? order by "round" asc, "createdAt" asc')
		.bind(projectId, since)
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
 * Append one review round. Caddie numbers it (the next number for the
 * project; any round the model sent is ignored), so rounds keep their order
 * across block revisions. A replay of the same review (the cycle's latest round
 * already has this block and exactly these findings) returns that round instead
 * of adding one, so a retried tool delivery can't push a design to "change the
 * plan".
 */
export async function recordArchitectureReview(
	db: D1Database,
	projectId: string,
	input: RecordReviewInput,
	now: string = new Date().toISOString(),
): Promise<ArchitectureReviewRound> {
	const parsed = v.parse(RecordReviewInput, input);
	const issuesJson = JSON.stringify(parsed.issues);
	const latest = (await listArchitectureReviews(db, projectId)).at(-1);
	if (latest && latest.blockHash === parsed.blockHash && JSON.stringify(latest.issues) === issuesJson) return latest;
	const top = await db
		.prepare('select max("round") as "top" from "architecture_reviews" where "projectId" = ?')
		.bind(projectId)
		.all<{ top: number | null }>();
	const round = Number(top.results?.[0]?.top ?? 0) + 1;
	const id = `arev_${crypto.randomUUID()}`;
	await db
		.prepare(
			'insert into "architecture_reviews" ("id","projectId","blockHash","round","issues","createdAt") values (?,?,?,?,?,?) ' +
				'on conflict ("projectId","blockHash","round") do nothing',
		)
		.bind(id, projectId, parsed.blockHash, round, issuesJson, now)
		.run();
	const stored = await db
		.prepare('select * from "architecture_reviews" where "projectId" = ? and "blockHash" = ? and "round" = ?')
		.bind(projectId, parsed.blockHash, round)
		.all<Record<string, unknown>>();
	return roundFromRow(stored.results![0]!);
}

/**
 * What the architect hears back after recording a round: its number, the
 * counts, and whether the plan must change (two rounds in a row in this cycle
 * still found safety problems). The host closure returns this to the tool.
 */
export async function reviewOutcome(
	db: D1Database,
	projectId: string,
	stored: ArchitectureReviewRound,
): Promise<{ round: number; security: number; advisory: number; mustChangePlan: boolean }> {
	const verdict = reviewVerdict(await listArchitectureReviews(db, projectId), stored.blockHash);
	return {
		round: stored.round,
		security: securityIssues(stored.issues).length,
		advisory: advisoryIssues(stored.issues).length,
		mustChangePlan: verdict.mustChangePlan,
	};
}

// --- the tool the architect delegate mounts ----------------------------------

/**
 * `record_architecture_review`: the architect's ONE write. Read-only about the
 * app otherwise — it has no sandbox or write tools. The host closure performs
 * the real, project-scoped insert; the model never supplies a verdict, only
 * findings with severities, and {@link reviewVerdict} decides what blocks.
 */
export function makeRecordArchitectureReview(deps: {
	record: (input: RecordReviewInput) => Promise<{ round: number; security: number; advisory: number; mustChangePlan?: boolean }>;
}) {
	return defineTool({
		name: 'record_architecture_review',
		description:
			"Record this review's findings on the design's caddie-architecture block. Give blockHash (the exact block you reviewed) and every issue with its severity: 'security' for sign-in, ownership/privacy, key exposure or data loss (these BLOCK the design until fixed, with no waiver), 'advisory' for everything else (shown to the user, never blocks). Record an empty issue list when the block is clean. Caddie numbers the rounds. You review only; you never approve or change the design.",
		input: RecordReviewInput,
		run: async (ctx) => {
			const result = await deps.record(ctx.data);
			const base =
				result.security > 0
					? `Recorded review round ${result.round}: ${result.security} security issue(s) that block the design until fixed, and ${result.advisory} advisory. The design cannot be approved while a security issue is open.`
					: `Recorded review round ${result.round}: no security issues; ${result.advisory} advisory note(s) shown to the user.`;
			const line = result.mustChangePlan
				? `${base} Two reviews in a row have found safety problems, so the plan must change: say so in your answer. The coordinator should not revise this design again; it should write a new plan revision that removes the cause, which sends the build back to plan review.`
				: base;
			return { output: line };
		},
	});
}
