/**
 * Project experience projection (R01, plan §5).
 *
 * Pure derivation: `projectExperience` turns the existing workflow snapshot
 * (build_workflows + latest prd revision + durable approval) into the ONE
 * shared `ProjectExperience` the UI reads. It performs NO writes and holds NO
 * state of its own.
 *
 * `approvePlan` is the command boundary: it maps the versioned, idempotent
 * `ApprovePlanCommand` onto the already-durable `decideWorkflow`, translating
 * its outcomes into the uniform `ExperienceCommandResult`. Buttons and an
 * unambiguous conversational approval both call this; authority stays
 * server-derived (the scope is the authenticated session's, never the body).
 */

import type {
	ApprovePlanCommand,
	ExperienceAction,
	ExperienceCommandResult,
	ProjectExperience,
	Scope,
} from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';
import { decideWorkflow, workflowSnapshot, type BuildWorkflow } from './build-workflow.ts';

/** The sentinel stopWorkflow writes into detail; distinguishes stop from repair/infra block. */
export const STOP_SENTINEL = 'Stop requested.';

/** Derive a monotonic version from the workflow's updatedAt (no new column). */
function versionOf(workflow: BuildWorkflow | null): number {
	if (!workflow?.updatedAt) return 0;
	const ms = Date.parse(workflow.updatedAt);
	return Number.isFinite(ms) ? ms : 0;
}

/**
 * Map the coarse server phase (+ detail sentinel + approval) to the richer
 * user-facing stage. `blocked` splits into `stopped` (user), `planning_blocked`
 * (blocked before the plan was ever approved — a stuck plan, nothing built to
 * retry) vs `blocked` (an approved build hit a repair/limit/infra wall).
 * `building` stays the umbrella (the UI narrates checking/repairing from
 * detail/preview, but the deterministic stage is `building`).
 */
function stageOf(workflow: BuildWorkflow | null, planApproved: boolean): ProjectExperience['stage'] {
	if (!workflow) return 'planning';
	switch (workflow.phase) {
		case 'planning':
			return 'planning';
		case 'review':
			return 'review';
		case 'design':
			return 'design';
		case 'design-review':
			return 'design_review';
		case 'building':
			return 'building';
		case 'ready':
			return 'ready';
		case 'blocked':
			if (workflow.detail?.startsWith(STOP_SENTINEL)) return 'stopped';
			// A block before any approved plan is a stuck PLAN, not a stuck build.
			return planApproved ? 'blocked' : 'planning_blocked';
		default:
			return 'planning';
	}
}

/** A short, user-facing message derived from real state — never model prose. */
function messageOf(
	stage: ProjectExperience['stage'],
	workflow: BuildWorkflow | null,
	planApproved: boolean,
): string {
	switch (stage) {
		case 'planning':
			return 'Caddie is preparing a plan for this project.';
		case 'review':
			return 'A plan is ready for your review.';
		case 'design':
			return 'Caddie is designing the screens. You review the design before anything is built.';
		case 'design_review':
			return 'A design is ready for your review. Nothing is built until you approve it.';
		case 'building':
			return planApproved
				? 'Caddie is building and checking your app.'
				: 'Working on your project.';
		case 'ready':
			return 'Your app passed the required checks. Try it out.';
		case 'blocked':
			return workflow?.detail?.trim()
				? workflow.detail.trim()
				: 'This project needs your input before Caddie can continue.';
		case 'planning_blocked':
			return "Caddie couldn't finish writing your plan. Nothing has been built yet — tell Caddie to continue and it will pick up your request and feedback.";
		case 'stopped':
			return 'Work stopped. Your plan and files are retained; retry when you are ready.';
		default:
			return 'Working on your project.';
	}
}

/**
 * The single-main-action set per stage. Exactly one action carries
 * primary=true. Every action is re-authorized server-side when invoked; these
 * flags only drive what the UI OFFERS.
 */
function actionsOf(
	stage: ProjectExperience['stage'],
	hasPlan: boolean,
	hasPreview: boolean,
): ExperienceAction[] {
	switch (stage) {
		case 'planning':
			return [{ kind: 'suggest_change', label: 'Continue the conversation', enabled: true, primary: true }];
		case 'review':
			return [
				{ kind: 'approve_plan', label: 'Approve plan', enabled: hasPlan, primary: true,
					...(hasPlan ? {} : { reason: 'No plan revision is ready yet.' }) },
				{ kind: 'suggest_change', label: 'Request a change', enabled: hasPlan, primary: false },
			];
		case 'design':
			return [{ kind: 'suggest_change', label: 'Continue the conversation', enabled: true, primary: true }];
		case 'design_review':
			return [
				{ kind: 'review_design', label: 'Review design', enabled: true, primary: true },
				{ kind: 'suggest_change', label: 'Request a change', enabled: true, primary: false },
			];
		case 'building':
		case 'checking':
		case 'repairing':
			return [
				{ kind: 'stop', label: 'Stop work', enabled: true, primary: true },
				...(hasPreview
					? [{ kind: 'open_preview' as const, label: 'View last preview', enabled: true, primary: false }]
					: []),
			];
		case 'ready':
			return [
				{ kind: 'open_preview', label: 'Try app', enabled: hasPreview, primary: true,
					...(hasPreview ? {} : { reason: 'No verified preview exists yet.' }) },
				{ kind: 'suggest_change', label: 'Request a change', enabled: true, primary: false },
			];
		case 'blocked':
			return [{ kind: 'retry', label: 'Review next step', enabled: true, primary: true }];
		case 'planning_blocked':
			// Nothing is built — the one action resumes PLANNING (retryWorkflow
			// routes a pre-approval block back to planning), worded honestly.
			return [{ kind: 'retry', label: 'Continue the plan', enabled: true, primary: true }];
		case 'stopped':
			return [{ kind: 'retry', label: 'Resume', enabled: true, primary: true }];
		default:
			return [];
	}
}

/** Build the shared projection from a workflow snapshot. Pure. */
export async function projectExperience(db: D1Database, scope: Scope): Promise<ProjectExperience> {
	const { workflow, plan, approval } = await workflowSnapshot(db, scope);
	const planApproved = approval?.status === 'approved';
	// A block is a stuck PLAN only when this revision was never approved. A
	// revoked/expired approval is a stopped BUILD (retry is then denied by the
	// approval gate) — the same rule retryWorkflow uses.
	const planEverApproved =
		approval?.status === 'approved' || approval?.status === 'revoked' || approval?.status === 'expired';
	const stage = stageOf(workflow, planEverApproved);
	const hasPlan = Boolean(plan);
	const previewId = workflow?.previewId ?? null;
	const hasPreview = Boolean(previewId);
	// A preview is "current" only when it belongs to the latest plan the
	// workflow points at AND that plan is approved.
	const previewCurrent = hasPreview && Boolean(plan) && workflow?.planId === plan!.id && planApproved;

	return {
		projectId: scope.projectId,
		version: versionOf(workflow),
		stage,
		plan: plan ? { id: plan.id, revision: String(plan.revision), approved: planApproved } : null,
		preview: previewId
			? { id: previewId, revision: plan ? String(plan.revision) : 'unknown', current: previewCurrent }
			: null,
		message: messageOf(stage, workflow, planApproved),
		actions: actionsOf(stage, hasPlan, hasPreview),
	};
}

/**
 * The approve-plan command. Versioned + idempotent on top of the already
 * durable decideWorkflow. Returns the uniform outcome plus the refreshed
 * projection (always current truth).
 */
export async function approvePlan(
	db: D1Database,
	scope: Scope,
	command: ApprovePlanCommand,
	limits?: unknown,
): Promise<ExperienceCommandResult> {
	if (command.projectId !== scope.projectId) {
		// The authenticated scope is authoritative; a mismatched body is denied,
		// never silently retargeted.
		return {
			outcome: 'denied',
			code: 'PROJECT_MISMATCH',
			experience: await projectExperience(db, scope),
		};
	}

	// Optimistic-concurrency check against the projection the client acted on.
	const before = await projectExperience(db, scope);
	if (before.version !== command.expectedVersion) {
		return { outcome: 'stale', code: 'STALE_VERSION', experience: before };
	}
	// The exact revision must still be the one presented.
	if (!before.plan || before.plan.id !== command.planRevisionId) {
		return { outcome: 'stale', code: 'STALE_PLAN', experience: before };
	}
	// A duplicate click on an already-approved revision is a no-op.
	if (before.plan.approved) {
		return { outcome: 'noop', experience: before };
	}

	try {
		await decideWorkflow(db, scope, { planId: command.planRevisionId, decision: 'approved' }, limits);
	} catch (error) {
		if (error instanceof ScopeError) {
			// A judge limit is not a stale projection: it must reach the route's
			// {error,message} handler with its 403, not become a silent 'denied'
			// with the plain sentence dropped.
			if (error.code.startsWith('JUDGE_LIMIT_')) throw error;
			// STALE_PLAN etc. from the durable layer — surface as a refreshable
			// conflict, never a crash, with the current truth attached.
			const code = error.code;
			const outcome = code === 'STALE_PLAN' ? 'stale' : 'denied';
			return { outcome, code, experience: await projectExperience(db, scope) };
		}
		throw error;
	}
	return { outcome: 'applied', experience: await projectExperience(db, scope) };
}
