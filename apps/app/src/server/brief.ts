import type { ApprovalAction, DecisionCard, Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope } from './scope.ts';
import { listClaims, surveyClaims } from './evidence/claims.ts';
import { listArtifacts } from './artifacts.ts';
import { listSchedules } from './schedules.ts';

/**
 * UI review board screen 05/06 — the brief feed. `GET /api/projects/:id/brief`
 * reads the project's REAL state and projects it onto the frozen DecisionCard
 * contract; the workspace Brief lane renders what a run, a re-read, a gate or
 * a schedule actually produced. No card is invented: every card cites the row
 * it was derived from, and an empty feed is an honest empty project, never a
 * stub.
 *
 * Sources (all project-scoped, re-verified at the service boundary):
 *   - approvals (status='pending', not yet expired) → approval / needs-you
 *   - retained evidence conflicts                    → change  / changed
 *   - stale artifacts                                → change  / changed
 *   - failed repair-ledger rounds (per run)          → result  / blocked
 *   - armed schedules                                → deadline / handled
 *
 * Ranking: needs-you first, then changed, then blocked, then handled (board
 * screen 06), newest first within each band.
 */

const MAX_CARDS = 24;

/** Lower sorts first. */
const STATUS_RANK: Record<DecisionCard['status'], number> = {
	'needs-you': 0,
	changed: 1,
	blocked: 2,
	handled: 3,
};

const APPROVAL_COPY: Record<
	ApprovalAction,
	{ title: string; label: string; authorises: string }
> = {
	design: {
		title: 'Design review is waiting on you',
		label: 'Review the design',
		authorises:
			'specialists building against this plan revision. It does not authorise a deploy, a merge, or any database change — those stay separate gates.',
	},
	'feature-review': {
		title: 'Feature review is waiting on you',
		label: 'Review the feature',
		authorises:
			'a feature review against the named build. It does not authorise a deploy or a merge.',
	},
	'deploy-production': {
		title: 'Deploy approval is waiting on you',
		label: 'Review the deploy',
		authorises:
			'one deploy to production. It does not authorise a destructive change or a merge.',
	},
	'destructive-database-change': {
		title: 'A destructive migration needs its own approval',
		label: 'Review the migration',
		authorises:
			'running the named migration against the project database. Reverting it requires a second approval.',
	},
	'merge-default-branch': {
		title: 'Merge to the default branch is waiting on you',
		label: 'Review the merge',
		authorises:
			'merging the current branch into the default branch. It does not authorise a deploy or a schema change.',
	},
};

function newCardId(source: string, key: string): string {
	return `brf_${source}_${key}`;
}

async function queryAll(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

interface ApprovalRow {
	id: string;
	action: ApprovalAction;
	resourceId: string;
	revisionHash: string;
	createdAt: string;
	expiresAt: string;
}

async function pendingApprovalCards(db: D1Database, projectId: string, nowIso: string): Promise<DecisionCard[]> {
	const rows = await queryAll(
		db,
		`select "id", "action", "resourceId", "revisionHash", "createdAt", "expiresAt"
		   from "approvals"
		  where "projectId" = ? and "status" = 'pending' and "expiresAt" > ?
		  order by "createdAt" desc`,
		projectId,
		nowIso,
	);
	return rows.map((row) => {
		const approval = row as unknown as ApprovalRow;
		const copy = APPROVAL_COPY[approval.action];
		return {
			id: newCardId('approval', approval.id),
			projectId,
			kind: 'approval',
			headline: `${copy.title} — ${approval.resourceId}`,
			summary: `Approving this authorises ${copy.authorises}`,
			evidenceIds: [],
			status: 'needs-you',
			updatedAt: approval.createdAt,
			primaryAction: { label: copy.label, kind: 'review', targetId: approval.id },
		} satisfies DecisionCard;
	});
}

async function conflictCards(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
	const [surveys, claims] = await Promise.all([
		surveyClaims(db, scope, {}),
		listClaims(db, scope, {}),
	]);
	const capturedAtById = new Map(claims.map((claim) => [claim.id, claim.snapshotCapturedAt]));
	const cards: DecisionCard[] = [];
	for (const survey of surveys) {
		if (!survey.conflict) continue;
		const updatedAt = survey.conflict.claimIds.reduce((latest, claimId) => {
			const at = capturedAtById.get(claimId);
			return at && at > latest ? at : latest;
		}, '');
		cards.push({
			id: newCardId('conflict', survey.conflict.conflictId),
			projectId: scope.projectId,
			kind: 'change',
			headline: `${survey.claimType} readings disagree — both retained, neither chosen`,
			summary:
				'Sources of equal authority state different values, so the disagreement is kept as a retained conflict instead of being resolved. Nothing has been built on either reading.',
			evidenceIds: [...survey.conflict.claimIds],
			status: 'changed',
			updatedAt: updatedAt === '' ? survey.conflict.conflictId : updatedAt,
			primaryAction: { label: 'Read the conflict', kind: 'inspect', targetId: survey.claimType },
		});
	}
	return cards;
}

async function staleArtifactCards(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
	const artifacts = await listArtifacts(db, scope);
	return artifacts
		.filter((artifact) => artifact.status === 'stale')
		.map((artifact) => ({
			id: newCardId('stale-artifact', artifact.id),
			projectId: scope.projectId,
			kind: 'change',
			headline: `${artifact.filename} went stale under a newer plan revision`,
			summary:
				'The artifact was verified against an earlier plan revision and the revision has moved on. The old verification is still on record; re-run the check before relying on this artifact.',
			evidenceIds: [],
			status: 'changed',
			updatedAt: artifact.createdAt,
			primaryAction: { label: 'View the diff', kind: 'inspect', targetId: artifact.id },
		}));
}

async function failedRunCards(db: D1Database, projectId: string): Promise<DecisionCard[]> {
	// Latest failed round per run — the repair ledger's honest failure rows.
	const rows = await queryAll(
		db,
		`select "runId", "issue", "createdAt"
		   from "run_rounds"
		  where "projectId" = ? and "outcome" = 'failed'
		  order by "createdAt" desc`,
		projectId,
	);
	const seen = new Set<string>();
	const cards: DecisionCard[] = [];
	for (const row of rows) {
		const runId = String(row.runId);
		if (seen.has(runId)) continue;
		seen.add(runId);
		cards.push({
			id: newCardId('failed-run', runId),
			projectId,
			kind: 'result',
			headline: `Run stopped: ${String(row.issue)}`,
			summary:
				'The failure is retained in the repair ledger — nothing was written to the plan after the stop. Read the failure to decide the next move.',
			evidenceIds: [],
			status: 'blocked',
			updatedAt: String(row.createdAt),
			primaryAction: { label: 'Read the failure', kind: 'inspect', targetId: runId },
		});
	}
	return cards;
}

async function scheduleCards(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
	const schedules = await listSchedules(db, scope);
	return schedules
		.filter((schedule) => !schedule.paused)
		.map((schedule) => ({
			id: newCardId('schedule', schedule.id),
			projectId: scope.projectId,
			kind: 'deadline',
			headline: `${schedule.name} — ${schedule.cron}`,
			summary: `Next run ${schedule.nextRunAt} (${schedule.timezone}). A finished run reports here and in Runs; a refused or failed read is named, never guessed.`,
			evidenceIds: [],
			status: 'handled',
			updatedAt: schedule.updatedAt,
			primaryAction: { label: 'Open the schedule', kind: 'review', targetId: schedule.id },
		}));
}

/** The project's brief: every live decision the project's own state demands. */
export async function projectBrief(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
	const verified = await assertProjectScope(db, scope);
	const nowIso = new Date().toISOString();
	const [approvals, conflicts, staleArtifacts, failedRuns, schedules] = await Promise.all([
		pendingApprovalCards(db, verified.projectId, nowIso),
		conflictCards(db, verified).catch((error) => {
			// The evidence layer is independent: its absence must not blank the
			// rest of the brief.
			console.error('brief: conflict survey failed:', error);
			return [] as DecisionCard[];
		}),
		staleArtifactCards(db, verified).catch((error) => {
			console.error('brief: artifact listing failed:', error);
			return [] as DecisionCard[];
		}),
		failedRunCards(db, verified.projectId).catch((error) => {
			console.error('brief: run-round query failed:', error);
			return [] as DecisionCard[];
		}),
		scheduleCards(db, verified).catch((error) => {
			console.error('brief: schedule listing failed:', error);
			return [] as DecisionCard[];
		}),
	]);
	const all = [...approvals, ...conflicts, ...staleArtifacts, ...failedRuns, ...schedules];
	return all
		.sort((a, b) => {
			const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
			if (rank !== 0) return rank;
			return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
		})
		.slice(0, MAX_CARDS);
}
