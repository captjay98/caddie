import type { DecisionCard, ProjectExperience } from '@caddie/contracts';
import type { ProjectStepId, StepStatus } from './ProjectTabs.tsx';

/** Where a Projects-card action goes. */
export type ProjectCardTarget = 'chat' | 'project' | 'plan';

/** The Projects-list card, derived from the project's REAL workflow state. */
export interface ProjectCardState {
	readonly label: string;
	readonly tone: 'neutral' | 'action' | 'warn' | 'ok' | 'danger';
	/** True while Caddie is actively working (live dot). */
	readonly working: boolean;
	readonly detail: string;
	readonly action: { readonly label: string; readonly target: ProjectCardTarget };
}

/**
 * The Projects card from the shared ProjectExperience projection — the same
 * truth the project's Now panel reads — so the list can never say "No updates
 * yet" while Caddie is building. Returns null when the project has no workflow
 * (version 0); the caller then falls back to its Brief-card summary.
 */
export function projectCardFromExperience(experience: ProjectExperience): ProjectCardState | null {
	if (experience.version === 0) return null;
	switch (experience.stage) {
		case 'planning':
			return { label: 'Writing the plan', tone: 'action', working: true, detail: 'Caddie is drafting a plan for you to review. Nothing is built before you approve it.', action: { label: 'Continue with Caddie', target: 'chat' } };
		case 'review':
			return { label: 'Plan ready', tone: 'warn', working: false, detail: 'A plan is ready. Review it before anything is built.', action: { label: 'Review plan', target: 'plan' } };
		case 'building':
		case 'checking':
			return { label: 'Building', tone: 'action', working: true, detail: 'Caddie is building your app and running its checks.', action: { label: 'See progress', target: 'project' } };
		case 'repairing':
			return { label: 'Fixing a problem', tone: 'action', working: true, detail: 'A check failed and Caddie is trying a fix.', action: { label: 'See progress', target: 'project' } };
		case 'ready':
			return { label: 'Ready to try', tone: 'ok', working: false, detail: 'Passed the required checks. Try it and tell Caddie what to change.', action: { label: 'Try app', target: 'project' } };
		case 'blocked':
			return { label: 'Needs attention', tone: 'danger', working: false, detail: experience.message, action: { label: 'Review next step', target: 'project' } };
		case 'planning_blocked':
			return { label: 'Plan needs another pass', tone: 'warn', working: false, detail: 'Caddie didn’t finish the plan. Nothing was built — continue and it picks up your feedback.', action: { label: 'Continue the plan', target: 'project' } };
		case 'stopped':
			return { label: 'Paused', tone: 'neutral', working: false, detail: 'Work is paused. Your plan and files are kept.', action: { label: 'Resume', target: 'project' } };
	}
}

const PRIORITY = { 'needs-you': 0, blocked: 1, changed: 2, handled: 3 };

/** Brief cards report events, not a completed percentage of a build. */
export function projectStatus(cards: readonly DecisionCard[]) {
	const ordered = [...cards].sort((a, b) =>
		PRIORITY[a.status] - PRIORITY[b.status] || b.updatedAt.localeCompare(a.updatedAt));
	const next = ordered.find((card) => card.status !== 'handled') ?? null;
	const latest = next ?? ordered[0] ?? null;
	let label = 'No updates yet';
	if (latest) {
		if (latest.status === 'blocked') label = 'Needs attention';
		else if (latest.kind === 'approval' && latest.status === 'needs-you') label = 'Decision needed';
		else if (latest.status === 'changed') label = 'Changes to review';
		else if (latest.id.startsWith('brf_preview_')) label = 'Preview available';
		else if (latest.kind === 'deadline') label = 'Upcoming deadline';
		else label = 'Update available';
	}
	return {
		label,
		detail: latest?.summary ?? 'Tell Caddie what you would like to build or change.',
		next,
	};
}

/** The server workflow phase, as the pages read it from /workflow. */
export type WorkflowPhase = 'planning' | 'review' | 'building' | 'blocked' | 'ready';

/**
 * Plain-language status for the four project steps, derived ONLY from real
 * server state (the workflow phase, plus an optional Check readiness count).
 * A step is `done` (green ✓) only when its data genuinely says done; nothing
 * is invented, and an unknown phase leaves the later steps neutral.
 *
 * The mental model this encodes: Plan → Build → Check → Share. The phase moves
 * Plan and Build; Check and Share report their own readiness when the page
 * that owns them supplies it. Words are user-facing (copy.ts vocabulary), not
 * phase identifiers.
 */
export function workflowSteps(
	phase: WorkflowPhase | null,
	opts?: { personal?: boolean; checkReady?: { verified: number; total: number } | null },
): Partial<Record<ProjectStepId, StepStatus>> {
	const steps: Partial<Record<ProjectStepId, StepStatus>> = {};
	// Plan. `blocked` is ambiguous at the coarse-phase level (a stuck plan vs a
	// build that paused after approval), so it must NOT claim "Approved" — only
	// a genuinely post-approval phase (building/ready) earns the green check.
	if (phase === 'planning') steps.plan = { text: 'Caddie is drafting it', tone: 'neutral' };
	else if (phase === 'review') steps.plan = { text: 'Ready for you to review', tone: 'needs' };
	else if (phase === 'blocked') steps.plan = { text: 'Paused — check with Caddie', tone: 'needs' };
	else if (phase) steps.plan = { text: 'Approved', tone: 'done' };
	// Build
	if (phase === 'planning' || phase === 'review') steps.build = { text: 'After you approve', tone: 'neutral' };
	else if (phase === 'building') steps.build = { text: 'Caddie is building it', tone: 'neutral' };
	else if (phase === 'blocked') steps.build = { text: 'Needs your help', tone: 'needs' };
	else if (phase === 'ready') steps.build = { text: 'Ready to try', tone: 'done' };
	// Check
	const ready = opts?.checkReady;
	if (ready && ready.total > 0) {
		steps.check =
			ready.verified >= ready.total
				? { text: 'Everything is ready', tone: 'done' }
				: { text: `${ready.verified} of ${ready.total} ready`, tone: 'needs' };
	} else if (phase === 'ready') {
		steps.check = { text: 'Ready when you are', tone: 'neutral' };
	} else {
		steps.check = { text: opts?.personal ? 'After it’s built' : 'Before you submit', tone: 'neutral' };
	}
	// Share / Submit
	steps.submission = opts?.personal
		? { text: 'Optional', tone: 'neutral' }
		: { text: 'Hand in when ready', tone: 'neutral' };
	return steps;
}

/**
 * The step the WORK is on (distinct from the tab being viewed): Plan while
 * Caddie plans or waits for review, Build while building or blocked, Check
 * once the app is ready. Unknown phase (no workflow yet) → none highlighted.
 */
export function activeStep(phase: WorkflowPhase | null): ProjectStepId | null {
	if (phase === 'planning' || phase === 'review') return 'plan';
	if (phase === 'building' || phase === 'blocked') return 'build';
	if (phase === 'ready') return 'check';
	return null;
}
