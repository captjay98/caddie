import type { DecisionCard } from '@caddie/contracts';
import type { ProjectStepId, StepStatus } from './ProjectTabs.tsx';

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
	// Plan
	if (phase === 'planning') steps.plan = { text: 'Caddie is drafting it', tone: 'neutral' };
	else if (phase === 'review') steps.plan = { text: 'Ready for you to review', tone: 'needs' };
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
