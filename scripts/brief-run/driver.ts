/**
 * Lane 8, step 2 — drive ONE brief end to end through the REAL API, as a person
 * would, as account A, over the documented routes
 * (apps/app/src/server/routes/build-workflow.ts) and the injected
 * `AccountSession`. The runner adds NO server routes.
 *
 * The flow mirrors the screens:
 *   1. start a project from the brief's text (POST /projects + the planning
 *      intake the chat screen sends);
 *   2. wait for the plan (poll /projects/:id/workflow until phase `review`),
 *      then approve it (POST /experience/approve);
 *   3. wait for the design and the architect review (phase `design-review`),
 *      then approve the design (POST /workflow/design-decision);
 *   4. poll the build until it is ready, blocked or stopped: up to the build's
 *      wait budget (90 min small/medium, 4 h big).
 *
 * Time is the injected `Clock`, so the poll loop runs instantly in a test.
 * Every HTTP hop goes through the injected session, so a fake transport drives
 * the whole thing offline. The exact request BODIES for the team-mode plan /
 * design decisions depend on lanes 1 and 2 (coordinator + architecture); they
 * are driven through the documented routes and classified UNVERIFIED until run
 * live.
 */
import type { AccountSession } from './dev-client.ts';
import type { Clock } from './clock.ts';

/** The workflow phases (apps/app/src/server/build-workflow.ts WorkflowPhase). */
export type WorkflowPhase =
	| 'planning'
	| 'review'
	| 'design'
	| 'design-review'
	| 'building'
	| 'blocked'
	| 'ready';

export interface WorkflowSnapshot {
	workflow: {
		projectId: string;
		runId: string;
		phase: WorkflowPhase;
		planId: string | null;
		previewId: string | null;
		detail: string | null;
	} | null;
}

/** A terminal outcome for the poll loop. */
export type BuildOutcome = 'ready' | 'blocked' | 'stopped' | 'timeout';

export interface DriveResult {
	projectId: string;
	runId: string;
	outcome: BuildOutcome;
	previewId: string | null;
	detail: string | null;
	/** Each phase the driver observed, in order — the audit trail of the run. */
	phasesSeen: WorkflowPhase[];
}

export interface DriveOptions {
	/** The brief's prompt text — what the person types. */
	prompt: string;
	/** The brief id, used in the project name. */
	briefId: string;
	/** team mode on/off for this run — stamped on the project at creation. */
	teamMode: boolean;
	/** The whole-build wait budget, ms (90 min small, 4 h big). */
	buildWaitMs: number;
	/** Gap between polls, ms. */
	pollEveryMs: number;
	/** The workspace the project is created in. */
	workspaceId: string;
}

const PLAN_WAIT_MS = 30 * 60 * 1000; // plan + design author within 30 min each
const DESIGN_WAIT_MS = 30 * 60 * 1000;

/** Fetch the workflow snapshot for a project. */
async function snapshot(session: AccountSession, projectId: string): Promise<WorkflowSnapshot> {
	return session.json<WorkflowSnapshot>(`/api/projects/${projectId}/workflow`);
}

/**
 * Poll `/workflow` until `predicate(phase)` holds or the budget runs out.
 * Returns the last snapshot seen. Records every distinct phase into `seen`.
 */
async function pollUntil(
	session: AccountSession,
	clock: Clock,
	projectId: string,
	budgetMs: number,
	pollEveryMs: number,
	seen: WorkflowPhase[],
	predicate: (phase: WorkflowPhase) => boolean,
): Promise<WorkflowSnapshot> {
	const deadline = clock.now() + budgetMs;
	let last = await snapshot(session, projectId);
	recordPhase(seen, last);
	while (clock.now() < deadline) {
		const phase = last.workflow?.phase;
		if (phase && predicate(phase)) return last;
		await clock.sleep(pollEveryMs);
		last = await snapshot(session, projectId);
		recordPhase(seen, last);
	}
	return last;
}

function recordPhase(seen: WorkflowPhase[], snap: WorkflowSnapshot): void {
	const phase = snap.workflow?.phase;
	if (phase && seen[seen.length - 1] !== phase) seen.push(phase);
}

/**
 * Create the project from the brief text and kick off planning. Uses the
 * documented POST /projects (projects.ts) then the planning intake the chat
 * screen sends. The intake route is owned by lanes 1/2; this drives the
 * documented shape and surfaces the real server's answer.
 */
async function startProject(session: AccountSession, opts: DriveOptions): Promise<string> {
	const created = await session.json<{ project?: { id: string }; id?: string }>(`/api/projects`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			workspaceId: opts.workspaceId,
			name: `campaign ${opts.briefId}`,
			description: opts.prompt.slice(0, 280),
			teamMode: opts.teamMode,
		}),
	});
	const projectId = created.project?.id ?? created.id;
	if (!projectId) throw new Error('create project returned no id');
	// The planning intake: the first chat message that is the brief's text.
	await session.fetch(`/api/projects/${projectId}/workflow/decision`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ intake: opts.prompt }),
	});
	return projectId;
}

/**
 * Drive one brief to a terminal build outcome. Pure orchestration over the
 * injected session + clock; it makes exactly the documented calls and never
 * fabricates a phase.
 */
export async function driveBrief(
	session: AccountSession,
	clock: Clock,
	opts: DriveOptions,
): Promise<DriveResult> {
	const seen: WorkflowPhase[] = [];
	const projectId = await startProject(session, opts);

	// 2. Wait for the plan (phase `review`, or `planning` with nothing pending),
	//    then approve it.
	const planReady = await pollUntil(session, clock, projectId, PLAN_WAIT_MS, opts.pollEveryMs, seen, (p) => p === 'review');
	if (planReady.workflow?.phase === 'review') {
		await session.fetch(`/api/projects/${projectId}/experience/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ planId: planReady.workflow.planId, decision: 'approved' }),
		});
	}

	// 3. Wait for the design + architect review (phase `design-review`), approve.
	const designReady = await pollUntil(
		session,
		clock,
		projectId,
		DESIGN_WAIT_MS,
		opts.pollEveryMs,
		seen,
		(p) => p === 'design-review',
	);
	if (designReady.workflow?.phase === 'design-review') {
		await session.fetch(`/api/projects/${projectId}/workflow/design-decision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ decision: 'approved' }),
		});
	}

	// 4. Poll the build until ready / blocked (or the budget runs out).
	const done = await pollUntil(
		session,
		clock,
		projectId,
		opts.buildWaitMs,
		opts.pollEveryMs,
		seen,
		(p) => p === 'ready' || p === 'blocked',
	);

	const phase = done.workflow?.phase;
	const outcome: BuildOutcome = phase === 'ready' ? 'ready' : phase === 'blocked' ? 'blocked' : 'timeout';
	return {
		projectId,
		runId: done.workflow?.runId ?? '',
		outcome,
		previewId: done.workflow?.previewId ?? null,
		detail: done.workflow?.detail ?? null,
		phasesSeen: seen,
	};
}
