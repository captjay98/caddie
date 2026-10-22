import type { ApprovalAction, DecisionCard, Scope } from '@caddie/contracts';
import { parsePlanFeatures } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope } from './scope.ts';
import { listClaims, surveyClaims } from './evidence/claims.ts';
import { listArtifacts } from './artifacts.ts';
import { listSchedules } from './schedules.ts';
import type { AccountBriefPayload, BriefSummary } from '@caddie/contracts';
import { listProjectsForActor } from './projects.ts';
import { listPlanDocRevisions } from './projects.ts';
import { listCandidates, computeFit } from './discovery.ts';
import { listPreviews } from './previews.ts';
import { listPackages, getReadiness, getPackage } from './submission.ts';
import { projectHackathon } from './project-hackathon.ts';
import { STOP_SENTINEL } from './project-experience.ts';

/** Format an ISO timestamp as a date a person reads, in the schedule's own
 *  timezone, e.g. "Monday, 6 October 2026 at 08:00". Returns the raw string
 *  unchanged when it is not a parseable timestamp, so a card never shows the
 *  word "Invalid Date". */
function readableDate(iso: string, timezone: string): string {
	const when = new Date(iso);
	if (Number.isNaN(when.getTime())) return iso;
	try {
		return new Intl.DateTimeFormat('en-GB', {
			weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
			hour: '2-digit', minute: '2-digit', timeZone: timezone,
		}).format(when);
	} catch {
		// An unknown timezone falls back to UTC rather than throwing.
		return new Intl.DateTimeFormat('en-GB', {
			weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
			hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
		}).format(when);
	}
}

/** Turn an internal check name ("feature-2:behavior-tests") into a plain-words
 *  sentence a non-technical owner understands. A string that already reads as
 *  prose (has a space, no "word:word" id) is returned as-is. */
function plainCheck(issue: string): string {
	const raw = issue.trim();
	if (raw.length > 0 && raw.includes(' ') && !/\b[a-z0-9-]+:[a-z0-9-]+\b/i.test(raw)) return raw;
	return 'A check did not pass yet. Caddie is adjusting the build and will run the checks again.';
}

/**
 * The repair card's "What needs fixing" panel (team-mode redo, step 2): a
 * FIXED, true expectation per check, keyed from run_rounds.issue of the form
 * "<featureId>:<check>". The sentence is the plain-English promise the check
 * makes — never the failed round's own detail (that is the card body). An
 * unknown check returns null, so the card shows no panel and keeps its plain
 * summary.
 */
const REPAIR_EXPECTATIONS: Record<string, string> = {
	'behavior-tests': "The app's own tests must all pass.",
	'browser-bundle': 'The app must build for the browser.',
	dependencies: "The app's parts must install cleanly.",
	'part-boundary': 'Each builder changes only its own part of the app.',
	'contract-create': 'Something you add must be saved.',
	'contract-read': 'Save something, restart the app, and it must still be there.',
	'contract-privacy-screen':
		"No one sees another person's records, and every screen shows what was saved.",
	'contract-test-mode': 'Test payments, emails, jobs and files must behave as the plan says.',
};

function repairExpectation(issue: string): string | null {
	// issue is "<featureId>:<check>"; the check is the part after the last ":".
	const check = issue.includes(':') ? issue.slice(issue.lastIndexOf(':') + 1).trim() : '';
	return REPAIR_EXPECTATIONS[check] ?? null;
}

/**
 * The deadline countdown parts for a card (lane 14 step 2), computed from a
 * real timestamp in its own timezone: whole days left (floored, never
 * negative), the date a person reads ("Friday, 23 October"), and the time of
 * day ("17:00"). Returns null when the timestamp cannot be parsed, so the card
 * keeps its summary instead of showing "Invalid Date". `nowIso` is passed in
 * so the count is deterministic in tests.
 */
export function deadlineParts(
	iso: string,
	timezone: string,
	nowIso: string,
): { daysLeft: number; dateLabel: string; timeLabel: string } | null {
	const when = new Date(iso);
	const now = new Date(nowIso);
	if (Number.isNaN(when.getTime()) || Number.isNaN(now.getTime())) return null;
	const tz = (opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
		try {
			return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timezone });
		} catch {
			return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
		}
	};
	// Days left measured as whole calendar days between the two instants,
	// floored and clamped at zero — a passed deadline reads "0 days left".
	const daysLeft = Math.max(0, Math.floor((when.getTime() - now.getTime()) / 86_400_000));
	const dateLabel = tz({ weekday: 'long', day: 'numeric', month: 'long' }).format(when);
	const timeLabel = tz({ hour: '2-digit', minute: '2-digit', hour12: false }).format(when);
	return { daysLeft, dateLabel, timeLabel };
}

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
	status: string;
	decidedAt: string | null;
}

async function pendingApprovalCards(db: D1Database, scope: Scope, nowIso: string): Promise<DecisionCard[]> {
	const projectId = scope.projectId;
	const rows = await queryAll(
		db,
		`select "id", "action", "resourceId", "revisionHash", "createdAt", "expiresAt", "status", "decidedAt"
		   from "approvals"
		  where "projectId" = ? and (
            ("status" = 'pending' and "expiresAt" > ?) or "id" in (
                select "id" from "approvals" where "projectId" = ?
                and ("status" != 'pending' or "expiresAt" <= ?)
                order by coalesce("decidedAt", "createdAt") desc limit 24
            ))
          order by coalesce("decidedAt", "createdAt") desc`,
		projectId,
		nowIso,
        projectId,
        nowIso,
	);
 const cards = rows.map(row => approvalCard(row, projectId, nowIso));
 // Step 2/3: "What you're approving" — fill the plan's own feature list onto a
 // PENDING card whose plan body really carries a caddie-features block, plus a
 // fixed next-step line and a footer naming the app and plan revision. The
 // revisions are fetched once; a decided card and a plan with no list stay as
 // they were (the card then shows its summary).
 if (cards.some(card => card.status === 'needs-you')) {
  const [items, appName, revisionNumber] = await Promise.all([
   planItemsFor(db, scope).catch(error => {
    console.error('brief: plan-items read failed:', error);
    return new Map<string, { title: string; detail?: string }[]>();
   }),
   projectAppName(db, projectId),
   planRevisionNumbers(db, scope).catch(() => new Map<string, number>()),
  ]);
  for (const card of cards) {
   const resourceId = String((card as { _resourceId?: string })._resourceId ?? '');
   const list = items.get(resourceId);
   if (card.status === 'needs-you' && card.kind === 'approval') {
    if (list && list.length > 0) (card as { planItems?: unknown }).planItems = list;
    // A fixed, true next-step sentence for a design approval — never invented
    // advice, the same promise the approval makes.
    (card as { nextStep?: string }).nextStep = 'Approve this scope and I’ll prepare the design for your review.';
    if (appName) {
     const n = revisionNumber.get(resourceId);
     (card as { footer?: unknown }).footer = { appName, ...(n ? { version: `Plan v${n}` } : {}) };
    }
   }
   delete (card as { _resourceId?: string })._resourceId;
  }
 }
 return cards;
}

/** Map each plan-doc revision id to its real revision number, so an approval
 * card can show "Plan v<n>" from the record, never a guess. */
async function planRevisionNumbers(db: D1Database, scope: Scope): Promise<Map<string, number>> {
	const revisions = await listPlanDocRevisions(db, scope);
	const byId = new Map<string, number>();
	for (const revision of revisions) byId.set(revision.id, revision.revision);
	return byId;
}

/**
 * The plan's own feature list, keyed by the plan-doc revision id an approval
 * points at (its `resourceId`). Read from the real plan-doc body's
 * `caddie-features` block: each feature becomes a title plus its first
 * `doneWhen` check as the one-line detail. A plan with no block contributes
 * nothing, so the card keeps its summary — nothing is guessed.
 */
async function planItemsFor(db: D1Database, scope: Scope): Promise<Map<string, { title: string; detail?: string }[]>> {
	const revisions = await listPlanDocRevisions(db, scope);
	const byResource = new Map<string, { title: string; detail?: string }[]>();
	for (const revision of revisions) {
		const parsed = parsePlanFeatures(revision.body);
		if (!parsed.ok) continue;
		byResource.set(
			revision.id,
			parsed.features.map((feature) => ({
				title: feature.title,
				...(feature.doneWhen[0] ? { detail: feature.doneWhen[0] } : {}),
			})),
		);
	}
	return byResource;
}
function approvalCard(row: Record<string, unknown>, projectId: string, nowIso: string): DecisionCard {
		const approval = row as unknown as ApprovalRow;
		const copy = APPROVAL_COPY[approval.action];
		const pending = approval.status === 'pending' && approval.expiresAt > nowIso;
            const outcome = approval.status === 'pending' ? 'expired' : approval.status;
		return {
			id: newCardId('approval', approval.id),
			projectId: String(row.projectId ?? projectId),
			kind: 'approval',
			headline: pending ? copy.title : `${copy.label.replace(/^Review /, '')} — ${outcome}`,
			summary: pending ? `Approving this authorises ${copy.authorises}` : `Decision ${outcome}. Open the record to read the exact revision it concerned. This does not authorise a new action.`,
			evidenceIds: [],
			status: pending ? 'needs-you' : 'handled',
			updatedAt: pending ? approval.createdAt : approval.decidedAt ?? (outcome === 'expired' ? approval.expiresAt : approval.createdAt),
			primaryAction: { label: pending ? copy.label : 'View decision', kind: 'review', targetId: approval.id },
			// Carried off-contract so pendingApprovalCards can match the plan-doc
			// revision; stripped before the card is returned.
			_resourceId: approval.resourceId,
		} as DecisionCard & { _resourceId: string };
}

export interface ApprovalHistoryPage { cards: DecisionCard[]; next: { at: string; id: string } | null }
/** Keyset pagination of durable decisions, independently of the recent feed.
 * Only membership-verified projects participate; all SQL values are bound. */
export async function approvalHistory(db: D1Database, actorId: string, before?: { at: string; id: string }): Promise<ApprovalHistoryPage> {
 const projects = await listProjectsForActor(db, actorId);
 if (!projects.length) return { cards: [], next: null };
 const nowIso = new Date().toISOString();
 const at = `coalesce(decidedAt, case when status = 'pending' then expiresAt else createdAt end)`;
 const args: unknown[] = [...projects.map(p => p.id), nowIso];
 if (before) args.push(before.at, before.at, before.id);
 const found = await queryAll(db, `select *, ${at} as historyAt from approvals where projectId in (${projects.map(() => '?').join(',')}) and (status != 'pending' or expiresAt <= ?) ${before ? `and (${at} < ? or (${at} = ? and id < ?))` : ''} order by historyAt desc, id desc limit 41`, ...args);
 const page = found.slice(0, 40);
 const last = page.at(-1);
 return { cards: page.map(row => approvalCard(row, String(row.projectId), nowIso)), next: found.length > 40 && last ? { at: String(last.historyAt), id: String(last.id) } : null };
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
	// A project with a build: the build's own record says whether it stopped.
	// A failed repair round is part of a working build (the builder repairs
	// and goes on), so the card shows only while Caddie has the build paused,
	// never for the person's own stop, and only for this build's run.
	const build = (await queryAll(db, `select "runId", "phase", "detail" from "build_workflows" where "projectId" = ?`, projectId))[0];
	if (build && (build.phase !== 'blocked' || String(build.detail ?? '').startsWith(STOP_SENTINEL))) return [];
	// Latest failed round per run — the repair ledger's honest failure rows.
	const rows = await queryAll(
		db,
		`select "runId", "issue", "createdAt"
		   from "run_rounds"
		  where "projectId" = ? and "outcome" = 'failed'${build ? ` and "runId" = ?` : ''}
		  order by "createdAt" desc`,
		...(build ? [projectId, String(build.runId)] : [projectId]),
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

async function scheduleCards(db: D1Database, scope: Scope, nowIso: string): Promise<DecisionCard[]> {
	const schedules = await listSchedules(db, scope);
	return schedules
		.filter((schedule) => !schedule.paused)
		.map((schedule) => {
			// A SCHEDULE is not a hackathon deadline: it says plainly when it
			// next runs, with NO days-left countdown and NO Deadline badge (lane
			// 14 step 6). The `schedule` field drives that wording; the card
			// carries no `deadline` block, so statusLabel reads "Scheduled".
			const nextRunLabel = `${readableDate(schedule.nextRunAt, schedule.timezone)} (${schedule.timezone})`;
			return {
				id: newCardId('schedule', schedule.id),
				projectId: scope.projectId,
				kind: 'deadline',
				headline: `${schedule.name} is scheduled`,
				summary: `A finished run reports here and in the project's activity; a refused or failed read is named, never guessed.`,
				evidenceIds: [],
				status: 'handled',
				updatedAt: schedule.updatedAt,
				primaryAction: { label: 'Open the schedule', kind: 'review', targetId: schedule.id },
				schedule: { name: schedule.name, nextRunLabel },
			} satisfies DecisionCard;
		});
}

/**
 * The hackathon deadline card (lane 14 step 6): the REAL hackathon deadline
 * the project card already shows (projectHackathon — the accepted proposal's
 * event, or the project's contestUrl, with the deadline parsed from the stored
 * listing), never a schedule's nextRunAt. It carries the days-left countdown,
 * the deadline in the reader's own locale ("Your time → …"), and the
 * submission steps from the project's real submission package checklist. No
 * hackathon, or no parseable deadline → no card (the project simply has none).
 */
async function hackathonDeadlineCard(db: D1Database, scope: Scope, nowIso: string): Promise<DecisionCard[]> {
	const hackathon = await projectHackathon(db, scope, Date.parse(nowIso) || Date.now());
	if (!hackathon || !hackathon.deadline) return [];
	// The deadline instant is the END of the deadline day (projectHackathon
	// stores a YYYY-MM-DD). Render the countdown + date/time in UTC (the stored
	// deadline has no timezone) and a reader-locale "Your time →" line.
	const deadlineIso = `${hackathon.deadline}T23:59:59Z`;
	const parts = deadlineParts(deadlineIso, 'UTC', nowIso);
	if (!parts) return [];
	const when = new Date(deadlineIso);
	// The reader's own local time (TheCard "Your time →" line), from the host
	// locale/timezone — deterministic enough for display, never a claim.
	let localTimeLabel: string | undefined;
	try {
		localTimeLabel = new Intl.DateTimeFormat('en-US', {
			weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
		}).format(when);
	} catch {
		localTimeLabel = undefined;
	}
	// The submission steps from the real checklist of the project's submission
	// package, when one exists. A 'verified' item is done; everything else is
	// still to do. No package → no steps (the countdown stands alone).
	let steps: { title: string; detail?: string; done: boolean }[] | undefined;
	try {
		const packages = await listPackages(db, scope);
		if (packages[0]) {
			const pkg = await getPackage(db, scope, packages[0].id);
			const items = pkg.checklist
				.filter((item) => item.requirementText.trim() !== '')
				.map((item) => ({ title: item.requirementText, done: item.status === 'verified' }));
			if (items.length > 0) steps = items;
		}
	} catch (error) {
		console.error('brief: deadline submission steps failed:', error);
	}
	return [{
		id: newCardId('hackathon-deadline', scope.projectId),
		projectId: scope.projectId,
		kind: 'deadline',
		headline: 'Leave time to tell the story',
		summary: 'The app is one part of the submission. Your demo and project write-up still need a final pass.',
		evidenceIds: [],
		status: hackathon.ended ? 'handled' : 'needs-you',
		updatedAt: nowIso,
		primaryAction: { label: 'Review submission', kind: 'review', targetId: scope.projectId },
		deadline: {
			...parts,
			source: hackathon.title,
			...(localTimeLabel ? { localTimeLabel } : {}),
			...(steps ? { steps } : {}),
		},
		...(hackathon.title ? { footer: { appName: hackathon.title, version: 'Submission' } } : {}),
	} satisfies DecisionCard];
}

/** The project's brief: every live decision the project's own state demands. */
/** Current build state is shared by chat and Brief; repair rounds alone never
 * claim the build is stopped. The workflow is the authority for completion. */
async function workflowCards(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
 const [workflow] = await queryAll(db, 'select * from build_workflows where projectId = ?', scope.projectId);
 if (!workflow) return [];
 const phase = String(workflow.phase);
 if (!['building', 'blocked', 'ready'].includes(phase)) return [];
 const runId = String(workflow.runId);
 const [round] = phase === 'building' ? await queryAll(db, 'select outcome, issue, detail from run_rounds where projectId = ? and runId = ? order by createdAt desc, id desc limit 1', scope.projectId, runId) : [];
 const repairing = phase === 'building' && round?.outcome === 'failed';
 const ready = phase === 'ready' && typeof workflow.previewId === 'string';
 const building = phase === 'building' && !repairing;
 const targetId = ready ? String(workflow.previewId) : runId;
 // Step 5: on a READY card, the preview checks — how many features passed and
 // their names, read from the real build_features rows for this run. Absent
 // (so the card keeps its summary) when no rows have passed yet.
 const readyChecks = ready ? await checksForRun(db, scope.projectId, runId) : null;
 // Step 4: on a REPAIR card, how many of this run's checks have passed so far,
 // so the panel can say "N checks passed · 1 being repaired".
 const repairChecks = repairing ? await repairChecksForRun(db, scope.projectId, runId) : null;
 const checks = readyChecks ?? repairChecks;
 // Step 3: on a live BUILD card, the feature feed — each feature's real state
 // (Built / Building / Waiting) from build_features, the feature now building,
 // and how many are built. Absent when the run has no feature rows.
 const build = building ? await buildFeedForRun(db, scope.projectId, runId) : null;
 // The repair "Check attempt N" footer: N is one past the real failed-repair
 // round count for this run (attempt 1 is the first pass). Queried only for a
 // repairing card.
 let checkAttempt = 2;
 if (repairing) {
	const [c] = await queryAll(db, `select count(*) as n from run_rounds where projectId = ? and runId = ? and outcome = 'failed'`, scope.projectId, runId);
	checkAttempt = Number(c?.n ?? 1) + 1;
 }
 const appName = await projectAppName(db, scope.projectId);
 const footer = appName
	? { appName, ...(ready && readyChecks?.version ? { version: `Version ${readyChecks.version}` } : repairing ? { version: `Check attempt ${checkAttempt}` } : {}) }
	: null;
 // Step 2: the repair "What needs fixing" panel is a FIXED expectation keyed
 // from the failed check (run_rounds.issue). When the check is known, the card
 // body is the round's own plain sentence (run_rounds.detail) plus a fixed
 // true line, and the panel carries the expectation — two DISTINCT texts. An
 // unknown check keeps the plain summary and shows no panel.
 const repairIssue = repairing ? String(round?.issue ?? '') : '';
 const repairExp = repairing ? repairExpectation(repairIssue) : null;
 const repairDetail = repairing ? String(round?.detail ?? '').trim() : '';
 const repairBody = repairExp && repairDetail !== ''
	? `${repairDetail} I found it before handing the preview to you.`
	: repairExp
		? 'I found it before handing the preview to you.'
		: null;
 return [{
  id: newCardId(`workflow_${ready ? 'preview' : repairing ? 'repair' : phase === 'blocked' ? 'blocked' : 'build'}`, targetId),
  projectId: scope.projectId, runId, kind: 'result',
  headline: ready ? 'Your app is ready to try' : repairing ? 'One check needs another pass' : phase === 'blocked' ? 'Your build needs attention' : 'Your app is taking shape',
  summary: ready ? 'Open the checked app preview. Your plan and build remain available.' : repairing ? (repairBody ?? plainCheck(repairIssue)) : String(workflow.detail ?? (phase === 'blocked' ? 'The build stopped. Your plan and saved files are retained.' : 'Caddie is implementing your approved plan and running the checks.')),
  evidenceIds: [], status: ready ? 'handled' : phase === 'blocked' ? 'blocked' : 'changed', updatedAt: String(workflow.updatedAt),
  primaryAction: { label: ready ? 'Try the app' : 'View activity', kind: ready ? 'preview' : 'inspect', targetId },
  ...(checks ? { checks } : {}),
  ...(build ? { build } : {}),
  ...(repairExp ? { repair: { expectation: repairExp } } : {}),
  ...(footer ? { footer } : {}),
 }];
}

/** The project's app name for a card footer (mockup `cc-bottom` left). The
 * project's own name is the app's name here; absent when the project row is
 * gone, so the footer falls back to the subject label. */
async function projectAppName(db: D1Database, projectId: string): Promise<string | null> {
	try {
		const [row] = await queryAll(db, 'select "name" from "projects" where "id" = ?', projectId);
		const name = row?.name;
		return typeof name === 'string' && name.trim() !== '' ? name : null;
	} catch {
		return null;
	}
}

/**
 * The live-build feature feed (lane 14 step 3), from the real build_features
 * rows for this run: each feature mapped to Built (passed) / Building (building)
 * / Waiting (pending or failed-awaiting-retry), the feature currently building,
 * and the built count. Returns null when the run has no feature rows, so the
 * build card keeps its plain summary — nothing is invented.
 */
async function buildFeedForRun(
	db: D1Database,
	projectId: string,
	runId: string,
): Promise<{ current?: string; features: { title: string; state: 'built' | 'building' | 'waiting' }[]; builtCount: number; lastUpdatedAt?: string } | null> {
	let rows: Record<string, unknown>[];
	try {
		rows = await queryAll(
			db,
			`select "title", "status", "updatedAt" from "build_features" where "projectId" = ? and "runId" = ? order by "position" asc`,
			projectId,
			runId,
		);
	} catch (error) {
		if (String(error).includes('no such table')) return null;
		throw error;
	}
	const features = rows
		.map((row) => ({ title: String(row.title), raw: String(row.status) }))
		.filter((row) => row.title.trim() !== '')
		.map((row) => ({
			title: row.title,
			state: (row.raw === 'passed' ? 'built' : row.raw === 'building' ? 'building' : 'waiting') as 'built' | 'building' | 'waiting',
		}));
	if (features.length === 0) return null;
	const current = features.find((feature) => feature.state === 'building')?.title;
	const builtCount = features.filter((feature) => feature.state === 'built').length;
	// The newest feature-row update stands in for "last update".
	const lastUpdatedAt = rows
		.map((row) => (row.updatedAt == null ? '' : String(row.updatedAt)))
		.reduce((latest, at) => (at > latest ? at : latest), '');
	return { ...(current ? { current } : {}), features, builtCount, ...(lastUpdatedAt ? { lastUpdatedAt } : {}) };
}

/** The repair card's "N checks passed" count (lane 14 step 4): how many of this
 * run's features have passed, so the repair panel can say "N checks passed · 1
 * being repaired". Null when the run has no passed features. */
async function repairChecksForRun(db: D1Database, projectId: string, runId: string): Promise<{ passed: number; items: string[] } | null> {
	const feed = await buildFeedForRun(db, projectId, runId);
	if (!feed) return null;
	const items = feed.features.filter((feature) => feature.state === 'built').map((feature) => feature.title);
	if (items.length === 0) return null;
	return { passed: items.length, items };
}

/**
 * The preview checks behind a ready card (lane 14 step 5), from the real
 * build_features rows for this run: how many features passed, and their names
 * (the features a person recognises, never an internal check id). Returns null
 * when no feature has passed, so the ready card keeps its summary. The feature
 * table may not exist on an older project — a missing table is treated as "no
 * checks", never an error.
 */
async function checksForRun(
	db: D1Database,
	projectId: string,
	runId: string,
): Promise<{ passed: number; items: string[]; version?: string } | null> {
	let rows: Record<string, unknown>[];
	try {
		rows = await queryAll(
			db,
			`select "title" from "build_features" where "projectId" = ? and "runId" = ? and "status" = 'passed' order by "position" asc`,
			projectId,
			runId,
		);
	} catch (error) {
		if (String(error).includes('no such table')) return null;
		throw error;
	}
	const items = rows.map((row) => String(row.title)).filter((title) => title.trim() !== '');
	if (items.length === 0) return null;
	return { passed: items.length, items };
}

export async function projectBrief(db: D1Database, scope: Scope): Promise<DecisionCard[]> {
	const verified = await assertProjectScope(db, scope);
	const nowIso = new Date().toISOString();
	const [approvals, conflicts, staleArtifacts, failedRuns, schedules, workflow, hackathonDeadline] = await Promise.all([
		pendingApprovalCards(db, verified, nowIso),
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
		scheduleCards(db, verified, nowIso).catch((error) => {
			console.error('brief: schedule listing failed:', error);
			return [] as DecisionCard[];
		}),
        workflowCards(db, verified),
		hackathonDeadlineCard(db, verified, nowIso).catch((error) => {
			console.error('brief: hackathon deadline read failed:', error);
			return [] as DecisionCard[];
		}),
	]);
	const all = [...approvals, ...conflicts, ...staleArtifacts, ...failedRuns, ...schedules, ...workflow, ...hackathonDeadline];
	const sorted = all.sort((a, b) => {
			const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
			if (rank !== 0) return rank;
			return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
        });
    // Outstanding work must never vanish behind a feed limit. Earlier is a
    // recent-history window; original decisions remain durable in approvals.
    return [...sorted.filter(card => card.status !== 'handled'), ...sorted.filter(card => card.status === 'handled').slice(0, MAX_CARDS)];
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
	const accepted = candidates.filter((candidate) => candidate.status === 'accepted');
	return Promise.all(accepted.map(async (candidate) => {
			// A sample from the built-in seed feed vs a real listing read from a
			// live source (Devpost). Worded from the candidate's own source so the
			// card never over- or under-claims where it came from.
			const live = candidate.source !== 'local-seed' && candidate.source !== 'catalog';
			const summary = live
				? 'Read from a live contest listing. Explore ideas for it when you are ready.'
				: "A sample from Caddie's built-in feed, not a real contest yet. Explore ideas for it when you are ready.";
			// Step 7: the fit split, from the SAME fit evaluator the discovery
			// route uses (computeFit). "Why it fits" = the requirements the
			// evidence actually SUPPORTS (plain words from the record); "Before
			// you commit" = the requirements in conflict or unknown (what still
			// needs confirming). A candidate with no requirements, or a fit read
			// that fails, falls back to the requirement texts as cautions —
			// nothing positive is ever invented.
			let reasons: string[] = [];
			let cautions: string[] = candidate.requirements.map((req) => req.text).filter((text) => text.trim() !== '');
			try {
				const fit = await computeFit(db, scope, candidate);
				reasons = fit.claims.filter((claim) => claim.verdict === 'supported').map((claim) => claim.statement);
				cautions = fit.claims.filter((claim) => claim.verdict !== 'supported').map((claim) => claim.requirement);
			} catch (error) {
				console.error('brief: opportunity fit read failed:', error);
			}
			const footer = { appName: candidate.title };
			return {
				id: newCardId('opportunity', candidate.id),
				projectId: scope.projectId,
				kind: 'result',
				headline: `A suitable opportunity is saved: ${candidate.title}`,
				summary,
				evidenceIds: [],
				status: 'handled',
				updatedAt: candidate.updatedAt,
				primaryAction: { label: 'Review opportunity', kind: 'inspect', targetId: candidate.id },
				...(reasons.length > 0 || cautions.length > 0 ? { fit: { reasons, cautions } } : {}),
				footer,
			} satisfies DecisionCard;
		}));
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
	const visible = [...all.filter(card => card.status !== 'handled'), ...all.filter(card => card.status === 'handled').slice(0, ACCOUNT_MAX_CARDS)];
	const cards = visible.map((card) => ({
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
