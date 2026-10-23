/**
 * Lane 8, step 2 — start ONE brief through the REAL start flow and drive it to
 * a terminal build outcome, as a person would, over the documented routes.
 * Every request/response shape here is taken from the real code, NOT the plan:
 *
 *   apps/app/src/server/routes/projects.ts     GET /api/home-project
 *   apps/app/src/client/coordinator.ts         POST /api/projects/<id>/runs,
 *                                              then the Flue coordinator send
 *   apps/app/src/server/routes/runs.ts         conversationGuard (the Flue
 *                                              /agents/coordinator/<conv> route
 *                                              admits a {idempotencyKey,
 *                                              kind:'user', body} message)
 *   apps/app/src/server/routes/build-workflow.ts
 *       (~107) GET  /api/projects/<id>/workflow  → { workflow, plan, design, … }
 *       (~292) POST /proposals/<proposalId>/accept → creates the project+workflow
 *       (~234) POST /workflow/decision           { planId, decision:'approved' }
 *       (~255) POST /workflow/design-decision     { designId, decision:'approved' }
 *
 * The real start (there is NO `POST /api/projects` that makes a workflow, and
 * no `/experience/approve` or `/workflow/decision {intake}` route — the old
 * driver invented those):
 *   1. GET /api/home-project → the Home project (id + workspaceId).
 *   2. POST /api/projects/<homeId>/runs {modelRouteId, payerId} → a run with a
 *      conversationId; send the brief to the Home coordinator over Flue's HTTP
 *      route /agents/coordinator/<conversationId> with the body the browser
 *      sends: {idempotencyKey, kind:'user', body}.
 *   3. Wait for the coordinator's propose_project card. There is NO
 *      list-proposals route, so read the NEWEST project_proposals row for the
 *      Home project created after the send, from the local D1 (an injected
 *      ProposalReader seam). We read from D1 rather than the conversation
 *      transcript because the proposal row is the server-of-record the accept
 *      route authorises against — the transcript is a rendering of it — so a
 *      D1 read cannot drift from what accept will act on.
 *   4. POST /api/projects/<homeId>/proposals/<proposalId>/accept → creates the
 *      project and its workflow and starts planning. The response carries the
 *      new project's id.
 *   5. Poll GET /api/projects/<id>/workflow. At phase 'review' approve the plan
 *      (POST /workflow/decision {planId, decision:'approved'}); at
 *      'design-review' approve the design (POST /workflow/design-decision
 *      {designId, decision:'approved'}). A plan-gate refusal is recorded as the
 *      run's result with its sentence and NOT retried.
 *   6. Wait until ready, blocked or stopped (the build wait budget).
 *
 * Time is the injected Clock, so the poll loop runs instantly in a test. Every
 * HTTP hop goes through the injected session, and the proposal read and the
 * coordinator send are injected seams, so the whole thing is driven offline
 * with fakes. The runner adds NO server routes.
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

/** A plan/design revision as it appears in the /workflow snapshot. */
interface Revision {
	id: string;
}

/** The /workflow snapshot shape the driver reads (a subset of the real JSON). */
export interface WorkflowSnapshot {
	workflow: {
		projectId: string;
		runId: string;
		phase: WorkflowPhase;
		planId: string | null;
		previewId: string | null;
		detail: string | null;
	} | null;
	plan?: Revision | null;
	design?: Revision | null;
}

/** The newest project_proposals row for the Home project (step 3). */
export interface ProposalRow {
	id: string;
	status: 'proposed' | 'accepted' | 'dismissed';
	createdAt: string;
}

/**
 * Read the newest project_proposals row for the Home project created at/after
 * `sinceIso`. The live seam runs a SELECT over the local D1; a test fakes it.
 * Returns null while the coordinator has not proposed yet, so the driver polls.
 */
export type ProposalReader = (opts: { homeProjectId: string; sinceIso: string }) => Promise<ProposalRow | null>;

/**
 * Send the brief as a user message to the Home coordinator over Flue's HTTP
 * route, with the exact body the browser sends: {idempotencyKey, kind:'user',
 * body}. The live seam POSTs to /agents/coordinator/<conversationId>; a test
 * fakes it. Kept a seam (not an inline session.fetch) because the Flue route is
 * not under /api and the browser's client.send wraps it.
 */
export type CoordinatorSend = (opts: {
	conversationId: string;
	idempotencyKey: string;
	body: string;
}) => Promise<void>;

/** A terminal outcome for the build poll loop. */
export type BuildOutcome = 'ready' | 'blocked' | 'stopped' | 'timeout' | 'no-proposal' | 'plan-refused';

export interface DriveResult {
	/** The Home project the proposal was raised in. */
	homeProjectId: string;
	/** The project the accepted proposal created (null if none was accepted). */
	projectId: string;
	runId: string;
	outcome: BuildOutcome;
	previewId: string | null;
	detail: string | null;
	/** The proposal id accepted, if any. */
	proposalId: string | null;
	/** Each phase the driver observed, in order — the audit trail of the run. */
	phasesSeen: WorkflowPhase[];
}

export interface DriveOptions {
	/** The brief's prompt text — what the person types to the coordinator. */
	prompt: string;
	/** The brief id, used in the idempotency key. */
	briefId: string;
	/** team mode on/off for this run. */
	teamMode: boolean;
	/** The whole-build wait budget, ms (90 min small, 4 h big). */
	buildWaitMs: number;
	/** Gap between polls, ms. */
	pollEveryMs: number;
	/** The model route id the run is created with (coordinator.ts constant). */
	coordinatorModelRouteId: string;
	/** The payer id the run is created with (the signed-in account id). */
	payerId: string;
	/** How long to wait for the coordinator's propose_project card, ms. */
	proposalWaitMs: number;
	/** How long to wait for the plan and the design, ms (each). */
	planWaitMs: number;
	designWaitMs: number;
}

interface HomeProject {
	project?: { id?: string; workspaceId?: string } | null;
}

interface RunCreated {
	run?: { conversationId?: string; runId?: string } | null;
}

interface AcceptResult {
	project?: { id?: string } | null;
}

/** Fetch the workflow snapshot for a project. */
async function snapshot(session: AccountSession, projectId: string): Promise<WorkflowSnapshot> {
	return session.json<WorkflowSnapshot>(`/api/projects/${projectId}/workflow`);
}

function recordPhase(seen: WorkflowPhase[], snap: WorkflowSnapshot): void {
	const phase = snap.workflow?.phase;
	if (phase && seen[seen.length - 1] !== phase) seen.push(phase);
}

/**
 * Poll `/workflow` until `predicate(snap)` holds or the budget runs out.
 * Returns the last snapshot seen. Records every distinct phase into `seen`.
 */
async function pollWorkflowUntil(
	session: AccountSession,
	clock: Clock,
	projectId: string,
	budgetMs: number,
	pollEveryMs: number,
	seen: WorkflowPhase[],
	predicate: (snap: WorkflowSnapshot) => boolean,
): Promise<WorkflowSnapshot> {
	const deadline = clock.now() + budgetMs;
	let last = await snapshot(session, projectId);
	recordPhase(seen, last);
	while (clock.now() < deadline) {
		if (predicate(last)) return last;
		await clock.sleep(pollEveryMs);
		last = await snapshot(session, projectId);
		recordPhase(seen, last);
	}
	return last;
}

/**
 * Drive one brief to a terminal build outcome through the REAL start flow.
 * Pure orchestration over the injected session + clock + seams; it makes
 * exactly the documented calls and never fabricates a phase or a proposal.
 */
export async function driveBrief(
	session: AccountSession,
	clock: Clock,
	opts: DriveOptions,
	seams: { readProposal: ProposalReader; coordinatorSend: CoordinatorSend },
): Promise<DriveResult> {
	const seen: WorkflowPhase[] = [];

	// 1. The Home project.
	const home = await session.json<HomeProject>(`/api/home-project`);
	const homeProjectId = home.project?.id;
	if (!homeProjectId) throw new Error('GET /api/home-project returned no project id');

	// 2. Create a run, then send the brief to the Home coordinator over Flue.
	const sinceIso = new Date(clock.now()).toISOString();
	const created = await session.json<RunCreated>(`/api/projects/${homeProjectId}/runs`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ modelRouteId: opts.coordinatorModelRouteId, payerId: opts.payerId }),
	});
	const conversationId = created.run?.conversationId;
	if (!conversationId) throw new Error('POST /runs returned no conversationId');
	await seams.coordinatorSend({
		conversationId,
		idempotencyKey: `campaign-${opts.briefId}-${clock.now()}`,
		body: opts.prompt,
	});

	// 3. Wait for the coordinator's propose_project card (the newest proposal
	//    row created after the send). No list route exists; poll D1.
	let proposal: ProposalRow | null = null;
	const proposalDeadline = clock.now() + opts.proposalWaitMs;
	while (clock.now() < proposalDeadline) {
		proposal = await seams.readProposal({ homeProjectId, sinceIso });
		if (proposal) break;
		await clock.sleep(opts.pollEveryMs);
	}
	if (!proposal) {
		return { homeProjectId, projectId: '', runId: '', outcome: 'no-proposal', previewId: null, detail: 'the coordinator did not propose a project within the wait budget', proposalId: null, phasesSeen: seen };
	}

	// 4. Accept the proposal → creates the project and its workflow.
	const accepted = await session.json<AcceptResult>(
		`/api/projects/${homeProjectId}/proposals/${proposal.id}/accept`,
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
	);
	const projectId = accepted.project?.id;
	if (!projectId) throw new Error('POST /proposals/:id/accept returned no project id');

	// 5. Approve the plan at 'review', the design at 'design-review'.
	const planReady = await pollWorkflowUntil(
		session,
		clock,
		projectId,
		opts.planWaitMs,
		opts.pollEveryMs,
		seen,
		(s) => s.workflow?.phase === 'review' || s.workflow?.phase === 'blocked',
	);
	// A plan-gate refusal lands the workflow in 'blocked' with its sentence: the
	// brief says it is recorded as the run's result and NOT retried.
	if (planReady.workflow?.phase === 'blocked') {
		return terminal(projectId, homeProjectId, proposal.id, planReady, seen, 'plan-refused');
	}
	if (planReady.workflow?.phase === 'review') {
		const planId = planReady.plan?.id ?? planReady.workflow.planId;
		await session.fetch(`/api/projects/${projectId}/workflow/decision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ planId, decision: 'approved' }),
		});
	}

	const designReady = await pollWorkflowUntil(
		session,
		clock,
		projectId,
		opts.designWaitMs,
		opts.pollEveryMs,
		seen,
		(s) => s.workflow?.phase === 'design-review' || s.workflow?.phase === 'blocked',
	);
	if (designReady.workflow?.phase === 'blocked') {
		return terminal(projectId, homeProjectId, proposal.id, designReady, seen, 'plan-refused');
	}
	if (designReady.workflow?.phase === 'design-review') {
		const designId = designReady.design?.id;
		if (!designId) throw new Error('design-review with no design revision id in the snapshot');
		await session.fetch(`/api/projects/${projectId}/workflow/design-decision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ designId, decision: 'approved' }),
		});
	}

	// 6. Poll the build until ready / blocked (or the budget runs out).
	const done = await pollWorkflowUntil(
		session,
		clock,
		projectId,
		opts.buildWaitMs,
		opts.pollEveryMs,
		seen,
		(s) => s.workflow?.phase === 'ready' || s.workflow?.phase === 'blocked',
	);
	const phase = done.workflow?.phase;
	const outcome: BuildOutcome = phase === 'ready' ? 'ready' : phase === 'blocked' ? 'blocked' : 'timeout';
	return terminal(projectId, homeProjectId, proposal.id, done, seen, outcome);
}

function terminal(
	projectId: string,
	homeProjectId: string,
	proposalId: string,
	snap: WorkflowSnapshot,
	seen: WorkflowPhase[],
	outcome: BuildOutcome,
): DriveResult {
	return {
		homeProjectId,
		projectId,
		runId: snap.workflow?.runId ?? '',
		outcome,
		previewId: snap.workflow?.previewId ?? null,
		detail: snap.workflow?.detail ?? null,
		proposalId,
		phasesSeen: seen,
	};
}
