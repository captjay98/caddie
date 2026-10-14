import type { ApprovalAction, DecisionCard, Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope } from './scope.ts';
import { listClaims, surveyClaims } from './evidence/claims.ts';
import { listArtifacts } from './artifacts.ts';
import { listSchedules } from './schedules.ts';
import type { AccountBriefPayload, BriefSummary } from '@caddie/contracts';
import { listProjectsForActor } from './projects.ts';
import { listCandidates } from './discovery.ts';
import { listPreviews } from './previews.ts';
import { listPackages, getReadiness } from './submission.ts';

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
			headline: 'Caddie hit a problem and paused this build',
			summary:
				`The check that stopped it: ${String(row.issue)}. Nothing was written to your plan after the stop and your files are saved — open it to see the failure and decide the next move.`,
			evidenceIds: [],
			status: 'blocked',
			updatedAt: String(row.createdAt),
			primaryAction: { label: 'Review the problem', kind: 'inspect', targetId: runId },
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
			headline: `${schedule.name} is scheduled`,
			summary: `Next run ${schedule.nextRunAt} (${schedule.timezone}). A finished run reports here and in the project's activity; a refused or failed read is named, never guessed.`,
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

// --- ACCOUNT BRIEF (approved navigation 2026-10-09) ------------------------------
//
// `GET /api/brief` aggregates every card the ACTOR's authorised projects
// demand — the old per-project surface only read the synthetic Home scope.
// Sources, all derived from real rows (nothing invented):
//   - per build project: the existing projectBrief (approvals, conflicts,
//     stale artifacts, failed rounds, schedules);
//   - live previews             -> result / preview action ("working preview");
//   - existing submission packages that are not ready -> change / review
//     action ("prepare submission");
//   - SAVED discovery candidates (account scope) -> result / inspect action
//     ("review opportunity") with the local-seed limitation stated outright.
// Grouping: one card per (projectId, kind, targetId) — a single unresolved
// issue never repeats per event. Read state is actor-scoped and separate
// from resolution (brief_read_state, migration 0012).


const ACCOUNT_MAX_CARDS = 40;

/** Stable card identity across reads — the read-state key (actor-scoped). */
export function cardKey(card: DecisionCard): string {
	return `${card.projectId}:${card.kind}:${card.primaryAction.targetId}`;
}

async function seenKeysForActor(db: D1Database, actorId: string): Promise<Set<string>> {
	const rows = await queryAll(
		db,
		'select "cardKey" from "brief_read_state" where "actorId" = ?',
		actorId,
	);
	return new Set(rows.map((row) => String(row['cardKey'])));
}

/** Mark cards read (explicit action / mark-all-read). Read NEVER resolves the
 *  underlying work — approvals, schedules and artifacts are untouched. */
export async function markBriefRead(
	db: D1Database,
	actorId: string,
	keys: readonly string[],
): Promise<void> {
	const now = new Date().toISOString();
	const stmt = db.prepare(
		'insert or ignore into "brief_read_state" ("actorId","cardKey","seenAt") values (?,?,?)',
	);
	for (const key of keys) {
		if (typeof key === 'string' && key.trim() !== '') {
			await stmt.bind(actorId, key, now).run();
		}
	}
}

/** Dedupe on (projectId, kind, targetId) — one card per unresolved issue,
 *  newest update wins. Exported for the unit suite (tests/brief.test.ts). */
export function groupCards(cards: readonly DecisionCard[]): DecisionCard[] {
	const byKey = new Map<string, DecisionCard>();
	for (const card of cards) {
		const key = cardKey(card);
		const existing = byKey.get(key);
		if (!existing || card.updatedAt > existing.updatedAt) byKey.set(key, card);
	}
	return [...byKey.values()];
}

/** Live (non-revoked, unexpired) previews -> "a working preview is ready". */
async function previewCards(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
	const nowIso = new Date().toISOString();
	const previews = await listPreviews(db, scope);
	return previews
		.filter((preview) => !preview.revoked && preview.expiresAt > nowIso)
		.map((preview) => ({
			id: newCardId('preview', preview.id),
			projectId: scope.projectId,
			kind: 'result',
			headline: 'A working preview is ready to view',
			summary:
				'The share link is live and unexpired. Previewed content runs in an isolated origin — it never carries your session.',
			evidenceIds: [],
			status: 'handled',
			updatedAt: preview.createdAt,
			primaryAction: { label: 'View preview', kind: 'preview', targetId: preview.id },
		}) satisfies DecisionCard);
}

/** Existing submission packages whose checklist is not ready -> one card per
 *  package (dedupe by package id). No package exists -> no card: submission
 *  requirements are never invented for projects that have none. */
async function submissionCards(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
	const packages = await listPackages(db, scope);
	const cards: DecisionCard[] = [];
	for (const pkg of packages) {
		try {
			const readiness = await getReadiness(db, scope, pkg.id);
			if (readiness.status === 'ready') continue;
			cards.push({
				id: newCardId('submission', pkg.id),
				projectId: scope.projectId,
				kind: 'change',
				headline: 'Submission requirements are not fully met',
				summary: `${readiness.reasons.length > 0 ? `${readiness.reasons.length} requirement(s) still unresolved — ` : ''}open the package to see exactly what is missing and what to do about it.`,
				evidenceIds: [],
				status: 'needs-you',
				updatedAt: pkg.createdAt,
				primaryAction: { label: 'Prepare to submit', kind: 'review', targetId: pkg.id },
			});
		} catch (error) {
			console.error('brief: submission readiness failed:', error);
		}
	}
	return cards;
}

/** Saved discovery candidates -> "a suitable opportunity was found". The
 *  local-seed limitation is stated on the card — live sources are a named
 *  prerequisite, never implied. */
async function opportunityCards(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
	const candidates = await listCandidates(db, scope);
	return candidates
		.filter((candidate) => candidate.status === 'accepted')
		.map((candidate) => ({
			id: newCardId('opportunity', candidate.id),
			projectId: scope.projectId,
			kind: 'result',
			headline: `A suitable opportunity is saved: ${candidate.title}`,
			summary:
				'This was saved from the local seed feed — live contest sources are not connected yet, so this is Caddie\'s built-in sample, not a live match. Explore ideas for it when you are ready.',
			evidenceIds: [],
			status: 'handled',
			updatedAt: candidate.updatedAt,
			primaryAction: { label: 'Review opportunity', kind: 'inspect', targetId: candidate.id },
		}) satisfies DecisionCard);
}

/** The account-wide brief: every authorised project's cards, grouped, ranked
 *  needs-you → changed → blocked → handled, with per-actor read state. */
export async function accountBrief(db: D1Database, actorId: string): Promise<AccountBriefPayload> {
	const projects = await listProjectsForActor(db, actorId);
	const nowIso = new Date().toISOString();
	const perProject = await Promise.all(
		projects.map(async (project) => {
			const scope: Scope = { actorId, projectId: project.id, workspaceId: project.workspaceId };
			if (project.kind === 'home') {
				// The account scope: saved discovery candidates only — the Home
				// project never carries approvals/artifacts/schedules.
				return opportunityCards(db, scope).catch((error) => {
					console.error('brief: opportunity survey failed:', error);
					return [] as DecisionCard[];
				});
			}
			const [cards, previews, submissions] = await Promise.all([
				projectBrief(db, scope).catch((error) => {
					console.error('brief: project brief failed:', error);
					return [] as DecisionCard[];
				}),
				previewCards(db, scope).catch((error) => {
					console.error('brief: preview survey failed:', error);
					return [] as DecisionCard[];
				}),
				submissionCards(db, scope).catch((error) => {
					console.error('brief: submission survey failed:', error);
					return [] as DecisionCard[];
				}),
			]);
			return [...cards, ...previews, ...submissions];
		}),
	);
	const all = groupCards(perProject.flat()).sort((a, b) => {
		const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
		if (rank !== 0) return rank;
		return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
	});
	const seenKeys = await seenKeysForActor(db, actorId);
	const cards = all.slice(0, ACCOUNT_MAX_CARDS).map((card) => ({
		...card,
		key: cardKey(card),
		seen: seenKeys.has(cardKey(card)),
	}));
	return {
		cards,
		unseenCount: cards.filter((card) => !card.seen).length,
		projects: projects.map((project) => ({ id: project.id, name: project.name, kind: project.kind })),
		asOf: nowIso,
	};
}

/**
 * The brief-in-chat summary (R05). Derived from the SAME accountBrief, so the
 * count chat shows and the cards Brief shows are one source of truth. Pure
 * projection over the payload — never a second query, never invented copy.
 */
export function summariseBrief(payload: AccountBriefPayload): BriefSummary {
	const open = payload.cards.filter((card) => card.status !== 'handled');
	// Needs-you = unseen AND actionable (needs-you / changed / blocked).
	const needsYou = open.filter((card) => !card.seen).length;
	const updates = payload.cards.filter((card) => card.status === 'handled').length;
	const headline =
		needsYou > 0
			? `${needsYou} thing${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} you${updates > 0 ? ` · ${updates} update${updates === 1 ? '' : 's'}` : ''}`
			: open.length > 0
				? `${open.length} open item${open.length === 1 ? '' : 's'} to review`
				: updates > 0
					? `${updates} update${updates === 1 ? '' : 's'}, nothing needs you`
					: 'You\u2019re caught up';
	return {
		needsYouCount: needsYou,
		updatesCount: updates,
		openCount: open.length,
		headline,
		href: '/app/',
		asOf: payload.asOf,
	};
}

/** Convenience: build the summary straight from the actor's account brief. */
export async function briefSummary(db: D1Database, actorId: string): Promise<BriefSummary> {
	return summariseBrief(await accountBrief(db, actorId));
}
