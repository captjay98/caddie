import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope } from './scope.ts';
import { ensureHomeProject, listProjectsForActor } from './projects.ts';
import { evaluateCandidateEligibility, listCandidates, parseEventDates, UNVERIFIED_OPEN_LABEL } from './discovery.ts';
import { matchCandidateByTitle } from './coordinator-context.ts';
import { getProfile } from './profiles.ts';
import type { EligibilityVerdict } from './eligibility.ts';
import { chooseContestDeadline, type DeadlineEvidence } from './contest-source-deadline.ts';

/**
 * The hackathon a project is for, for the project page header (2026-10-15
 * redesign). Read-only and derived at read time — no new column, so every
 * existing project gets it with no backfill:
 *
 *   1. the hackathon on the proposal the user STARTED this project from
 *      (title, link, track — exactly what the proposal card showed), else
 *   2. the project's own contestUrl (projects created for a contest).
 *
 * The stored event (the Home discovery catalogue, where Caddie found it) adds
 * the deadline and the CHECKED eligibility verdict — the same engine the
 * hackathon card and detail pane use. Honest gaps: no link → null (no chips);
 * a link Caddie never stored → title/link only, deadline null and verdict
 * 'unknown'; a summary with no parseable date → deadline null, never a guess.
 */
export interface ProjectHackathon {
	readonly title: string;
	readonly url: string | null;
	readonly track: string | null;
	/** ISO date (YYYY-MM-DD) of the submission deadline, or null when unknown. */
	readonly deadline: string | null;
	/** Exact time only when a current, matching rules claim supports it. */
	readonly deadlineUtc?: string;
	readonly deadlineClaimId?: string;
	readonly deadlineSourceUrl?: string;
	readonly deadlineOriginal?: string;
	/** Whole days from now until the deadline (0 on the day), null when unknown. */
	readonly daysLeft: number | null;
	readonly ended: boolean;
	readonly eligibility: EligibilityVerdict;
}

const DAY_MS = 86_400_000;

/** Origin + path without trailing slash, lowercased host — Devpost links differ only by "/". */
function sameEvent(a: string, b: string): boolean {
	try {
		const x = new URL(a);
		const y = new URL(b);
		const path = (u: URL) => u.pathname.replace(/\/+$/, '');
		return x.host.toLowerCase() === y.host.toLowerCase() && path(x) === path(y);
	} catch {
		return false;
	}
}

/** Date-only values cannot establish a closing hour or time zone. */
export function daysUntil(deadline: string, nowMs: number): { daysLeft: number; ended: boolean } {
	const end = Date.parse(`${deadline}T23:59:59Z`);
	if (!Number.isFinite(end)) return { daysLeft: 0, ended: false };
	const remaining = end - nowMs;
	// Until the date is over even at UTC-12, it may still be open somewhere.
	// This conservative bound is not an asserted closing time.
	const datePassedEverywhere = nowMs >= end + 12 * 60 * 60_000 + 1000;
	return { daysLeft: Math.max(0, Math.floor(remaining / DAY_MS)), ended: datePassedEverywhere };
}

export async function projectHackathon(db: D1Database, scope: Scope, nowMs = Date.now()): Promise<ProjectHackathon | null> {
	const verified = await assertProjectScope(db, scope);

	const proposal = (
		await db
			.prepare(
				'select "hackathonTitle","hackathonUrl","track","homeProjectId" from "project_proposals" where "projectId" = ? and "actorId" = ? and "status" = \'accepted\' order by "updatedAt" desc limit 1',
			)
			.bind(verified.projectId, verified.actorId)
			.all<Record<string, unknown>>()
	).results?.[0];
	const project = (
		await db.prepare('select "contestUrl" from "projects" where "id" = ?').bind(verified.projectId).all<Record<string, unknown>>()
	).results?.[0];

	const proposalTitle = typeof proposal?.['hackathonTitle'] === 'string' ? (proposal['hackathonTitle'] as string) : null;
	const proposalUrl = typeof proposal?.['hackathonUrl'] === 'string' ? (proposal['hackathonUrl'] as string) : null;
	const contestUrl = typeof project?.['contestUrl'] === 'string' && project['contestUrl'] ? (project['contestUrl'] as string) : null;
	const url = proposalUrl ?? contestUrl;
	if (!proposalTitle && !url) return null;

	// The catalogue lives on the user's Home project (where discovery ran).
	const homeProjectId =
		typeof proposal?.['homeProjectId'] === 'string'
			? (proposal['homeProjectId'] as string)
			: (await ensureHomeProject(db, verified.actorId)).id;
	const homeScope: Scope = { actorId: verified.actorId, workspaceId: verified.workspaceId, projectId: homeProjectId };
	let stored: Awaited<ReturnType<typeof listCandidates>> = [];
	let homeReadable = false;
	try {
		stored = await listCandidates(db, homeScope);
		homeReadable = true;
	} catch {
		stored = []; // Home in another workspace or not a member: show the link only.
	}
	const candidate =
		(url ? stored.find((c) => sameEvent(c.url, url)) : undefined) ??
		(proposalTitle ? matchCandidateByTitle(stored, proposalTitle) : null) ??
		null;

	const track = typeof proposal?.['track'] === 'string' ? (proposal['track'] as string) : null;
	if (!candidate) {
		return { title: proposalTitle ?? url!, url, track, deadline: null, daysLeft: null, ended: false, eligibility: 'unknown' };
	}

	const summary = candidate.summary.startsWith(UNVERIFIED_OPEN_LABEL)
		? candidate.summary.slice(UNVERIFIED_OPEN_LABEL.length)
		: candidate.summary;
	const deadline = parseEventDates(summary).deadline;
	let exact = null;
	let exactIsProjectClaim = false;
	if (deadline && url) {
		try {
			const projectIds = homeReadable && homeProjectId !== verified.projectId ? [verified.projectId, homeProjectId] : [verified.projectId];
			const result = await db.prepare(`select c.projectId,c.id,c.claimType,c.value,c.quote,c.status,c.snapshotId,
			s.latestSnapshotId,s.canonicalUrl as sourceUrl,s.authority,s.lastOutcome,s.observedAt,p.content
			from evidence_claims c join evidence_sources s on s.id=c.sourceId and s.projectId=c.projectId
			join evidence_snapshots p on p.id=c.snapshotId and p.projectId=c.projectId and p.sourceId=s.id
			where c.projectId in (${projectIds.map(() => '?').join(',')}) and c.claimType='requirement.submission_deadline' and c.status='active' limit 21`)
			.bind(...projectIds).all<DeadlineEvidence & { projectId: string }>();
			if ((result.results ?? []).length <= 20) exact = chooseContestDeadline(result.results ?? [], url, deadline, nowMs);
			exactIsProjectClaim = Boolean(exact && (result.results ?? []).some(row => row.id === exact!.claimId && row.projectId === verified.projectId));
		} catch (error) {
			if (!String(error).includes('no such table')) throw error;
		}
	}
	const remaining = deadline ? exact
		? { daysLeft: Math.max(0, Math.floor((Date.parse(exact.utc) - nowMs) / DAY_MS)), ended: Date.parse(exact.utc) <= nowMs }
		: daysUntil(deadline, nowMs) : null;
	const profile = await getProfile(db, verified.actorId);
	const evaluation = await evaluateCandidateEligibility(db, homeScope, candidate, { country: profile?.country ?? null });

	return {
		title: proposalTitle ?? candidate.title,
		url: url ?? candidate.url,
		track,
		deadline,
		...(exact ? { deadlineUtc: exact.utc, ...(exactIsProjectClaim ? { deadlineClaimId: exact.claimId } : {}), deadlineSourceUrl: exact.sourceUrl, deadlineOriginal: exact.original } : {}),
		daysLeft: remaining?.daysLeft ?? null,
		ended: remaining?.ended ?? false,
		eligibility: evaluation.verdict,
	};
}

/** A project card's hackathon line (plan 5.7): the title and, when known, the deadline. */
export interface ProjectHackathonLine {
	readonly title: string;
	/** ISO date (YYYY-MM-DD) of the submission deadline, or null when unknown. */
	readonly deadline: string | null;
	readonly daysLeft: number | null;
	readonly ended: boolean;
}

/**
 * The hackathon and its deadline for each of a person's own projects, for the
 * Projects list (plan 5.7): one read of their accepted proposals and one of
 * their Home discovery catalogue for every card, matched exactly as
 * projectHackathon matches (the started proposal first, then the project's
 * contestUrl). No eligibility check here (the project page has it). A project
 * with no hackathon is left out; projects the person is not a member of never
 * appear.
 */
export async function projectHackathonsForActor(
	db: D1Database,
	actorId: string,
	nowMs = Date.now(),
): Promise<Record<string, ProjectHackathonLine>> {
	const projects = (await listProjectsForActor(db, actorId)).filter((project) => project.kind !== 'home');
	if (projects.length === 0) return {};
	const proposals = (
		await db
			.prepare(
				'select "projectId","hackathonTitle","hackathonUrl","homeProjectId" from "project_proposals" where "actorId" = ? and "status" = \'accepted\' and "projectId" is not null order by "updatedAt" desc',
			)
			.bind(actorId)
			.all<Record<string, unknown>>()
	).results ?? [];
	const latest = new Map<string, Record<string, unknown>>();
	for (const row of proposals) if (!latest.has(String(row['projectId']))) latest.set(String(row['projectId']), row);

	const linked = projects.flatMap((project) => {
		const proposal = latest.get(project.id);
		const title = typeof proposal?.['hackathonTitle'] === 'string' ? (proposal['hackathonTitle'] as string) : null;
		const url = (typeof proposal?.['hackathonUrl'] === 'string' ? (proposal['hackathonUrl'] as string) : null) ?? (project.contestUrl || null);
		return title || url ? [{ projectId: project.id, title, url, homeProjectId: proposal?.['homeProjectId'] }] : [];
	});
	if (linked.length === 0) return {};

	// The catalogue lives on the person's Home project (where discovery ran).
	const home = await ensureHomeProject(db, actorId);
	const homeProjectId = linked.map((item) => item.homeProjectId).find((id): id is string => typeof id === 'string') ?? home.id;
	let stored: Awaited<ReturnType<typeof listCandidates>> = [];
	let homeReadable = false;
	try {
		stored = await listCandidates(db, { actorId, workspaceId: home.workspaceId, projectId: homeProjectId });
		homeReadable = true;
	} catch {
		stored = []; // Home in another workspace or not a member: titles only.
	}
	// One bounded read for all authorized projects: never turn a large or
	// incomplete evidence set into a falsely certain deadline.
	const evidenceByProject = new Map<string, DeadlineEvidence[]>();
	if (linked.length <= 100) {
		try {
			const projectIds = [...linked.map(item => item.projectId), ...(homeReadable ? [homeProjectId] : [])];
			const placeholders = projectIds.map(() => '?').join(',');
			const evidence = await db.prepare(`select c.projectId,c.id,c.claimType,c.value,c.quote,c.status,c.snapshotId,
				s.latestSnapshotId,s.canonicalUrl as sourceUrl,s.authority,s.lastOutcome,s.observedAt,p.content
				from evidence_claims c join evidence_sources s on s.id=c.sourceId and s.projectId=c.projectId
				join evidence_snapshots p on p.id=c.snapshotId and p.projectId=c.projectId and p.sourceId=s.id
				where c.projectId in (${placeholders}) and c.claimType='requirement.submission_deadline' and c.status='active' limit 201`)
				.bind(...projectIds).all<DeadlineEvidence & { projectId: string }>();
			if ((evidence.results ?? []).length <= 200) for (const row of evidence.results ?? []) {
				const group = evidenceByProject.get(row.projectId) ?? [];
				group.push(row); evidenceByProject.set(row.projectId, group);
			}
		} catch (error) {
			if (!String(error).includes('no such table')) throw error;
		}
	}

	const lines: Record<string, ProjectHackathonLine> = {};
	for (const item of linked) {
		const candidate =
			(item.url ? stored.find((c) => sameEvent(c.url, item.url!)) : undefined) ??
			(item.title ? matchCandidateByTitle(stored, item.title) : null) ??
			null;
		if (!candidate) {
			lines[item.projectId] = { title: item.title ?? item.url!, deadline: null, daysLeft: null, ended: false };
			continue;
		}
		const summary = candidate.summary.startsWith(UNVERIFIED_OPEN_LABEL)
			? candidate.summary.slice(UNVERIFIED_OPEN_LABEL.length)
			: candidate.summary;
		const deadline = parseEventDates(summary).deadline;
		const evidence = [...(evidenceByProject.get(item.projectId) ?? []), ...(homeReadable ? evidenceByProject.get(homeProjectId) ?? [] : [])];
		const exact = deadline && item.url && evidence.length <= 20 ? chooseContestDeadline(evidence, item.url, deadline, nowMs) : null;
		const remaining = deadline ? exact
			? { daysLeft: Math.max(0, Math.floor((Date.parse(exact.utc) - nowMs) / DAY_MS)), ended: Date.parse(exact.utc) <= nowMs }
			: daysUntil(deadline, nowMs) : null;
		lines[item.projectId] = {
			title: item.title ?? candidate.title,
			deadline,
			daysLeft: remaining?.daysLeft ?? null,
			ended: remaining?.ended ?? false,
		};
	}
	return lines;
}
